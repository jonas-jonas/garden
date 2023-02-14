/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Server } from "http"

import chalk from "chalk"
import Koa from "koa"
import mount = require("koa-mount")
import serve = require("koa-static")
import Router = require("koa-router")
import websockify from "koa-websocket"
import bodyParser = require("koa-bodyparser")
import getPort = require("get-port")
import { omit } from "lodash"

import { Garden } from "../garden"
import { prepareCommands, parseRequest, CommandMap } from "./commands"
import { gardenEnv } from "../constants"
import { Log } from "../logger/log-entry"
import { Command, CommandResult } from "../commands/base"
import { toGardenError, GardenError } from "../exceptions"
import { EventName, Events, EventBus, GardenEventListener } from "../events"
import { uuidv4, ValueOf } from "../util/util"
import { AnalyticsHandler } from "../analytics/analytics"
import { joi } from "../config/common"
import { randomString } from "../util/string"
import { authTokenHeader } from "../cloud/api"
import { ApiEventBatch } from "../cloud/buffered-event-stream"
import { LogLevel } from "../logger/logger"
import { clientRequestNames, ClientRequestType, ClientRouter } from "./client-router"
import { EventEmitter } from "eventemitter3"
import { ServeCommand } from "../commands/serve"
import { getBuiltinCommands } from "../commands/commands"

// Note: This is different from the `garden serve` default port.
// We may no longer embed servers in watch processes from 0.13 onwards.
export const defaultWatchServerPort = 9777
const notReadyMessage = "Waiting for Garden instance to initialize"

interface WebsocketCloseEvent {
  code: number
  message: string
}

interface WebsocketCloseEvents {
  notReady: WebsocketCloseEvent
  unauthorized: WebsocketCloseEvent
}

// Using the websocket closed private range (4000-4999) for the closed codes
// and adding normal HTTP status codes. So something that would be a 503 HTTP code translates to 4503.
// See also: https://www.iana.org/assignments/websocket/websocket.xhtml
const websocketCloseEvents: WebsocketCloseEvents = {
  notReady: {
    code: 4503,
    message: "Not ready",
  },
  unauthorized: {
    code: 4401,
    message: "Unauthorized",
  },
}

interface GardenServerParams {
  log: Log
  command: ServeCommand
  port?: number
}

/**
 * Start an HTTP server that exposes commands and events for the given Garden instance.
 *
 * Please look at the tests for usage examples.
 *
 * NOTES:
 * If `port` is not specified, the default is used or a random free port is chosen if default is not available.
 * This is done so that a process can always create its own server, but we won't need that functionality once we
 * run a shared service across commands.
 */
export async function startServer(params: GardenServerParams) {
  // Start HTTP API server.
  // allow overriding automatic port picking
  if (!params.port) {
    params.port = gardenEnv.GARDEN_SERVER_PORT || undefined
  }
  const server = new GardenServer(params)
  await server.start()
  return server
}

export class GardenServer extends EventEmitter {
  private log: Log
  private debugLog: Log
  private server: Server
  private garden: Garden | undefined
  private commands: CommandMap
  private serveCommand: ServeCommand
  private clientRouter: ClientRouter | undefined
  private app: websockify.App
  private analytics?: AnalyticsHandler
  private incomingEvents: EventBus
  private statusLog: Log
  private serversUpdatedListener: GardenEventListener<"serversUpdated">
  private activePersistentRequests: { [requestId: string]: { command: Command; connectionId: string } }

  public port: number | undefined
  public readonly authKey: string

  constructor({ log, command, port }: GardenServerParams) {
    super()
    this.log = log
    this.debugLog = this.log.makeNewLogContext({ level: LogLevel.debug, fixLevel: true })
    this.commands = prepareCommands(getBuiltinCommands()) // This gets updated when .setGarden() is called
    this.serveCommand = command
    this.clientRouter = undefined
    this.port = port
    this.authKey = randomString(24)
    this.incomingEvents = new EventBus()
    this.activePersistentRequests = {}

    this.serversUpdatedListener = ({ servers }) => {
      // Update status log line with new `garden serve` server, if any
      for (const { host, command: commandName, serverAuthKey } of servers) {
        if (commandName === "serve") {
          this.showUrl(`${host}?key=${serverAuthKey}`)
          return
        }
      }

      // No other active explicit server processes, show own URL instead
      this.showUrl(this.getUrl())
    }
  }

  async start() {
    if (this.server) {
      return
    }

    this.app = await this.createApp()

    const hostname = gardenEnv.GARDEN_SERVER_HOSTNAME || "localhost"

    if (this.port) {
      this.server = this.app.listen(this.port, hostname)
    } else {
      do {
        try {
          this.port = await getPort({ port: defaultWatchServerPort })
          this.server = this.app.listen(this.port, hostname)
        } catch {}
      } while (!this.server)
    }

    // TODO: pipe every event
    this.server.on("close", () => {
      this.emit("close")
    })

    this.log.info("")
    this.statusLog = this.log.makeNewLogContext({})
  }

  getBaseUrl() {
    return `http://localhost:${this.port}`
  }

  getUrl() {
    return `${this.getBaseUrl()}?key=${this.authKey}`
  }

  showUrl(url?: string) {
    this.statusLog.info({
      emoji: "sunflower",
      msg: chalk.cyan("Garden server running at ") + chalk.blueBright(url || this.getUrl()),
    })
  }

  async close() {
    return this.server.close()
  }

  async setGarden(garden: Garden) {
    if (this.garden) {
      this.garden.events.removeListener("serversUpdated", this.serversUpdatedListener)
    }

    this.garden = garden
    this.garden.log = this.debugLog
    this.clientRouter = new ClientRouter(this.garden, this.log)

    this.commands = prepareCommands(await this.serveCommand.getCommands(garden))

    // Serve artifacts as static assets
    this.app.use(mount("/artifacts", serve(garden.artifactsPath)))

    // Listen for new servers
    garden.events.on("serversUpdated", this.serversUpdatedListener)

    delete this.analytics
  }

  private async createApp() {
    // prepare request-command map
    const app = websockify(new Koa())
    const http = new Router()

    http.use((ctx, next) => {
      const authToken = ctx.header[authTokenHeader] || ctx.query.key

      if (authToken !== this.authKey) {
        ctx.throw(401, `Unauthorized request`)
        return
      }
      return next()
    })

    /**
     * HTTP API endpoint (POST /api)
     *
     * We don't expose a different route per command, but rather accept a JSON object via POST on /api
     * with a `command` key. The API wouldn't be RESTful in any meaningful sense anyway, and this
     * means we can keep a consistent format across mechanisms.
     */
    http.post("/api", async (ctx) => {
      if (!this.garden) {
        return this.notReady(ctx)
      }

      if (!this.analytics) {
        try {
          this.analytics = await AnalyticsHandler.init(this.garden, this.debugLog)
        } catch (err) {
          throw err
        }
      }

      this.analytics.trackApi("POST", ctx.originalUrl, { ...ctx.request.body })

      const { command, log, args, opts } = parseRequest(ctx, this.debugLog, this.commands, ctx.request.body)

      const prepareParams = {
        log,
        headerLog: log,
        footerLog: log,
        args,
        opts,
      }

      const persistent = command.isPersistent(prepareParams)

      if (persistent) {
        ctx.throw(400, "Attempted to run persistent command (e.g. a watch/follow command). Aborting.")
      }

      await command.prepare(prepareParams)

      const result = await command.action({
        garden: this.garden,
        log,
        headerLog: log,
        footerLog: log,
        args,
        opts,
      })

      ctx.status = 200
      ctx.response.body = result
    })

    // TODO-G2: remove this once it has another place
    /**
     * Resolves the URL for the given provider dashboard page, and redirects to it.
     */
    http.get("/dashboardPages/:pluginName/:pageName", async (ctx) => {
      if (!this.garden) {
        return this.notReady(ctx)
      }

      const { pluginName, pageName } = ctx.params

      const actions = await this.garden.getActionRouter()
      const plugin = await this.garden.getPlugin(pluginName)
      const page = plugin.dashboardPages.find((p) => p.name === pageName)

      if (!page) {
        return ctx.throw(400, `Could not find page ${pageName} from provider ${pluginName}`)
      }

      const { url } = await actions.provider.getDashboardPage({ log: this.log, page, pluginName })
      ctx.redirect(url)
    })

    /**
     * Events endpoint, for ingesting events from other Garden processes, and piping to any open websocket connections.
     * Requires a valid auth token header, matching `this.authKey`.
     *
     * The API matches that of the Garden Cloud /events endpoint.
     */
    http.post("/events", async (ctx) => {
      // TODO: validate the input
      const batch = ctx.request.body as ApiEventBatch
      this.debugLog.debug(`Received ${batch.events.length} events from session ${batch.sessionId}`)

      // Pipe the events to the incoming stream, which websocket listeners will then receive
      batch.events.forEach((e) => this.incomingEvents.emit(e.name, e.payload))

      ctx.status = 200
    })

    app.use(bodyParser())

    app.use(http.routes())
    app.use(http.allowedMethods())

    app.on("error", (err, ctx) => {
      this.debugLog.info(`API server request failed with status ${ctx.status}: ${err.message}`)
    })

    this.addWebsocketEndpoint(app)

    return app
  }

  private notReady(ctx: Router.IRouterContext | Koa.ParameterizedContext) {
    ctx.status = 503
    ctx.response.body = notReadyMessage
  }

  /**
   * Add the /ws endpoint to the Koa app. Every event emitted to the event bus is forwarded to open
   * Websocket connections, and clients can send commands over the socket and receive results on the
   * same connection.
   */
  private addWebsocketEndpoint(app: websockify.App) {
    // TODO: split this method up
    const wsRouter = new Router()

    wsRouter.get("/ws", async (ctx) => {
      // The typing for koa-router isn't working currently
      const websocket: Koa.Context["websocket"] = ctx["websocket"]

      if (!this.garden) {
        this.log.debug("Server not ready.")
        const wsNotReadyEvent = websocketCloseEvents.notReady
        websocket.close(wsNotReadyEvent.code, wsNotReadyEvent.message)
        return
      }

      const connectionId = uuidv4()

      // Helper to make JSON messages, make them type-safe, and to log errors.
      const send: SendWrapper = (type, payload) => {
        const event = { type, ...(<object>payload) }
        this.log.debug(`Send ${type} event: ${JSON.stringify(event)}`)
        websocket.send(JSON.stringify(event), (err?: Error) => {
          if (err) {
            this.debugLog.debug({ error: toGardenError(err) })
          }
        })
      }

      // TODO: Only allow auth key authentication
      if (ctx.query.sessionId !== `${this.garden.sessionId}` && ctx.query.key !== `${this.authKey}`) {
        send("error", { message: `401 Unauthorized` })
        const wsUnauthorizedEvent = websocketCloseEvents.unauthorized
        websocket.close(wsUnauthorizedEvent.code, wsUnauthorizedEvent.message)
        return
      }

      send("event", { name: "serverReady", payload: {} })

      // Set up heartbeat to detect dead connections
      let isAlive = true
      let heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          this.log.debug(`Connection ${connectionId} timed out.`)
          websocket.terminate()
        }

        isAlive = false
        websocket.ping(() => {})
      }, 1000)

      websocket.on("pong", () => {
        isAlive = true
      })

      // Pipe everything from the event bus to the socket, as well as from the /events endpoint.
      const eventListener = (name: EventName, payload: any) => send("event", { name, payload })
      this.garden.events.onAny(eventListener)
      this.incomingEvents.onAny(eventListener)

      const cleanup = () => {
        this.log.debug(`Connection ${connectionId} terminated, cleaning up.`)
        clearInterval(heartbeatInterval)

        this.garden && this.garden.events.offAny(eventListener)
        this.incomingEvents.offAny(eventListener)

        for (const [id, req] of Object.entries(this.activePersistentRequests)) {
          if (connectionId === req.connectionId) {
            req.command.terminate()
            delete this.activePersistentRequests[id]
          }
        }
      }

      // Make sure we clean up listeners when connections end.
      websocket.on("close", cleanup)

      // Respond to commands.
      websocket.on("message", (msg: string | Buffer) => {
        this.handleWsMessage({ msg, ctx, send, connectionId })
      })
    })

    app.ws.use(<Koa.Middleware<any>>wsRouter.routes())
    app.ws.use(<Koa.Middleware<any>>wsRouter.allowedMethods())
  }

  private handleWsMessage({
    msg,
    ctx,
    send,
    connectionId,
  }: {
    msg: string | Buffer
    ctx: Koa.ParameterizedContext
    send: SendWrapper
    connectionId: string
  }) {
    let request: any

    this.log.debug("Got request: " + msg)

    try {
      request = JSON.parse(msg.toString())
    } catch {
      return send("error", { message: "Could not parse message as JSON" })
    }

    const requestId: string = request.id
    const requestType: string = request.type

    try {
      joi.attempt(requestId, joi.string().uuid().required())
    } catch {
      return send("error", { message: "Message should contain an `id` field with a UUID value", requestId })
    }

    try {
      joi.attempt(request.type, joi.string().required())
    } catch {
      return send("error", { message: "Message should contain a type field" })
    }

    if (requestType === "command") {
      // Start a command
      // IMPORTANT: We need to grab the Garden instance reference here, since it may be replaced upon
      // in-process reload (e.g. via the reload command in `garden dev`)
      const garden = this.garden

      if (!garden) {
        return send("error", { requestId, message: notReadyMessage })
      }

      try {
        const { command, log, args, opts } = parseRequest(
          ctx,
          this.debugLog,
          this.commands,
          omit(request, ["id", "type"])
        )

        const prepareParams = {
          log,
          headerLog: log,
          footerLog: log,
          args,
          opts,
        }

        const persistent = command.isPersistent(prepareParams)

        command
          .prepare(prepareParams)
          .then(() => {
            if (persistent) {
              send("commandStart", {
                requestId,
                args,
                opts,
              })
              this.activePersistentRequests[requestId] = { command, connectionId }

              command.subscribe((data: any) => {
                send("commandOutput", {
                  requestId,
                  command: command.getFullName(),
                  data,
                })
              })
            }

            // TODO: validate result schema
            return command.action({
              garden,
              log,
              headerLog: log,
              footerLog: log,
              args,
              opts,
            })
          })
          .then((result) => {
            send("commandResult", {
              requestId,
              result: result.result,
              errors: result.errors,
            })
            delete this.activePersistentRequests[requestId]
          })
          .catch((err) => {
            send("error", { message: err.message, requestId })
            delete this.activePersistentRequests[requestId]
          })
      } catch (err) {
        return send("error", { message: err.message, requestId })
      }
    } else if (requestType === "commandStatus") {
      const r = this.activePersistentRequests[requestId]
      const status = r ? "active" : "not found"
      send("commandStatus", {
        requestId,
        status,
      })
    } else if (requestType === "abortCommand") {
      const req = this.activePersistentRequests[requestId]
      req && req.command.terminate()
      delete this.activePersistentRequests[requestId]
    } else if (clientRequestNames.find((e) => e === requestType)) {
      // TODO-G2: get rid of ClientRouter entirely
      this.clientRouter?.dispatch(<ClientRequestType>requestType, request).catch(() => {})
    } else {
      return send("error", {
        requestId,
        message: `Unsupported request type: ${requestType}`,
      })
    }
  }
}

interface ServerWebsocketMessages {
  commandOutput: {
    requestId: string
    command: string
    data: string
  }
  commandResult: {
    requestId: string
    result: CommandResult<any>
    errors?: GardenError[]
  }
  commandStatus: {
    requestId: string
    status: "active" | "not found"
  }
  commandStart: {
    requestId: string
    args: object
    opts: object
  }
  error: {
    requestId?: string
    message: string
  }
  event: {
    name: EventName
    payload: ValueOf<Events>
  }
}

type ServerWebsocketMessageType = keyof ServerWebsocketMessages

export type ServerWebsocketMessage = ServerWebsocketMessages[ServerWebsocketMessageType] & {
  type: ServerWebsocketMessageType
}

type SendWrapper<T extends ServerWebsocketMessageType = ServerWebsocketMessageType> = (
  type: T,
  payload: ServerWebsocketMessages[T]
) => void
