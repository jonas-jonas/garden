/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { omit } from "lodash"
import { ActionState } from "../actions/types"
import { PluginEventBroker } from "../plugin-context"
import { ServiceState } from "../types/service"
import { renderOutputStream, uuidv4 } from "../util/util"
import { BaseRouterParams, createActionRouter } from "./base"

export const deployRouter = (baseParams: BaseRouterParams) =>
  createActionRouter("Deploy", baseParams, {
    deploy: async (params) => {
      const { router, action, garden } = params

      const actionUid = uuidv4()
      params.events = params.events || new PluginEventBroker()

      const actionName = action.name
      const serviceName = actionName
      const actionVersion = action.versionString()
      const moduleVersion = action.moduleVersion().versionString
      const serviceVersion = actionVersion
      const moduleName = action.moduleName()

      params.events.on("log", ({ timestamp, data, origin, log }) => {
        // stream logs to CLI
        log.info(renderOutputStream(data.toString(), origin))
        // stream logs to Garden Cloud
        // TODO: consider sending origin as well
        garden.events.emit("log", {
          timestamp,
          actionUid,
          entity: {
            type: "deploy",
            key: `${serviceName}`,
            moduleName,
          },
          data: data.toString(),
        })
      })

      const deployStartedAt = new Date()

      garden.events.emit("serviceStatus", {
        actionName,
        actionVersion,
        serviceName,
        moduleName,
        moduleVersion,
        serviceVersion,
        actionUid,
        status: { state: "deploying", deployStartedAt },
      })

      const result = await router.callHandler({ params, handlerType: "deploy" })

      // TODO-G2: only validate if state is ready?
      await router.validateActionOutputs(action, "runtime", result.outputs)

      garden.events.emit("serviceStatus", {
        actionName,
        actionVersion,
        serviceName,
        moduleName,
        moduleVersion,
        serviceVersion,
        actionUid,
        status: {
          ...omit(result.detail, "detail"),
          deployStartedAt,
          deployCompletedAt: new Date(),
        },
      })

      router.emitNamespaceEvents(result.detail?.namespaceStatuses)

      return result
    },

    delete: async (params) => {
      const { action, router, handlers } = params

      const log = params.log.makeNewLogContextWithMessage({
        section: action.key(),
        msg: "Deleting...",
      })

      const status = await handlers.getStatus({ ...params, devMode: false, localMode: false })

      if (status.detail?.state === "missing") {
        log.setSuccess({
          section: action.key(),
          msg: "Not found",
        })
        return status
      }

      const result = await router.callHandler({
        params: { ...params, log },
        handlerType: "delete",
        defaultHandler: async (p) => {
          const msg = `No delete handler available for ${p.action.kind} action type ${p.action.type}`
          p.log.setError(msg)
          return {
            state: "not-ready" as ActionState,
            detail: { state: "missing" as ServiceState, detail: {} },
            outputs: {},
          }
        },
      })

      router.emitNamespaceEvents(result.detail?.namespaceStatuses)

      log.setSuccess({
        msg: chalk.green(`Done (took ${log.getDuration(1)} sec)`),
        append: true,
      })

      return result
    },

    exec: async (params) => {
      const result = await params.router.callHandler({ params, handlerType: "exec" })
      return result
    },

    getLogs: async (params) => {
      const { action, log } = params

      const result = await params.router.callHandler({
        params,
        handlerType: "getLogs",
        defaultHandler: async () => {
          log.warn({
            section: action.key(),
            msg: chalk.yellow(`No handler for log retrieval available for action type ${action.type}`),
          })
          return {}
        },
      })
      return result
    },

    getStatus: async (params) => {
      const { garden, router, action } = params

      const result = await router.callHandler({ params, handlerType: "getStatus" })

      const actionName = action.name
      const actionVersion = action.versionString()

      garden.events.emit("serviceStatus", {
        actionName,
        actionVersion,
        serviceName: actionName,
        moduleVersion: action.moduleVersion().versionString,
        moduleName: action.moduleName(),
        serviceVersion: actionVersion,
        status: omit(result.detail, "detail"),
      })

      router.emitNamespaceEvents(result.detail?.namespaceStatuses)

      // TODO-G2: only validate if state is not missing?
      await router.validateActionOutputs(action, "runtime", result.outputs)

      return result
    },

    getPortForward: async (params) => {
      return params.router.callHandler({ params, handlerType: "getPortForward" })
    },

    stopPortForward: async (params) => {
      return params.router.callHandler({ params, handlerType: "stopPortForward" })
    },
  })
