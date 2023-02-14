/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import tmp from "tmp-promise"
import { expect } from "chai"
import { Garden } from "../../../../src"
import { colors, LogsCommand } from "../../../../src/commands/logs"
import { ProjectConfig } from "../../../../src/config/project"
import { GardenPlugin } from "../../../../src/plugin/plugin"
import { TestGarden } from "../../../../src/util/testing"
import {
  createProjectConfig,
  customizedTestPlugin,
  expectError,
  makeTempDir,
  withDefaultGlobalOpts,
} from "../../../helpers"
import { DEFAULT_API_VERSION } from "../../../../src/constants"
import { formatForTerminal } from "../../../../src/logger/renderers"
import chalk from "chalk"
import { LogEntry, LogEntryNew } from "../../../../src/logger/log-entry"
import { LogLevel } from "../../../../src/logger/logger"
import { DeployLogEntry } from "../../../../src/types/service"
import { execDeployActionSchema } from "../../../../src/plugins/exec/config"
import { GetDeployLogs } from "../../../../src/plugin/handlers/Deploy/get-logs"
import { BaseActionConfig } from "../../../../src/actions/types"

// TODO-G2: rename test cases to match the new graph model semantics

function makeCommandParams({
  garden,
  args = { services: undefined },
  opts = {},
}: {
  garden: Garden
  args?: any
  opts?: any
}) {
  const log = garden.log
  return {
    garden,
    log,
    headerLog: log,
    footerLog: log,
    args,
    opts: withDefaultGlobalOpts({
      ...opts,
    }),
  }
}

const makeDeployAction = (basePath: string, name: string): BaseActionConfig => ({
  apiVersion: DEFAULT_API_VERSION,
  kind: "Deploy",
  name,
  type: "test",
  disabled: false,
  internal: {
    basePath,
  },
  spec: {
    deployCommand: ["echo", "ok"],
  },
})

async function makeGarden(tmpDir: tmp.DirectoryResult, plugin: GardenPlugin) {
  const config: ProjectConfig = createProjectConfig({
    path: tmpDir.path,
    providers: [{ name: "test" }],
  })

  const garden = await TestGarden.factory(tmpDir.path, { config, plugins: [plugin] })
  garden.setActionConfigs([], [makeDeployAction(tmpDir.path, "test-service-a")])
  return garden
}

// Returns all entries that match the logMsg as string, sorted by service name.
function getLogOutput(garden: TestGarden, msg: string, extraFilter: (e: LogEntryNew) => boolean = () => true) {
  const entries = garden.log
    .getChildEntries()
    .filter(extraFilter)
    .filter((e) => e.msg?.includes(msg))!
  return entries.map((e) => formatForTerminal(e, "basic").trim())
}

describe("LogsCommand", () => {
  let tmpDir: tmp.DirectoryResult
  const timestamp = new Date()
  const msgColor = chalk.bgRedBright
  const logMsg = "Yes, this is log"
  const logMsgWithColor = msgColor(logMsg)
  const color = chalk[colors[0]]

  type GetDeployLogsParams = GetDeployLogs["_paramsType"]

  const defaultLogsHandler = async ({ stream }: GetDeployLogsParams) => {
    void stream.write({
      tags: { container: "my-container" },
      name: "test-service-a",
      msg: logMsgWithColor,
      timestamp,
    })
    return {}
  }

  const makeTestPlugin = (logsHandler = defaultLogsHandler) => {
    return customizedTestPlugin({
      name: "test",
      createActionTypes: {
        Deploy: [
          {
            name: "test",
            docs: "Test Deploy action",
            schema: execDeployActionSchema(),
            handlers: {
              getLogs: logsHandler,
            },
          },
        ],
      },
    })
  }

  before(async () => {
    tmpDir = await makeTempDir({ git: true, initialCommit: false })
  })

  after(async () => {
    await tmpDir.cleanup()
  })

  context("follow=false", () => {
    it("should return service logs", async () => {
      const garden = await makeGarden(tmpDir, makeTestPlugin())
      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden }))
      expect(res).to.eql({
        result: [
          {
            tags: { container: "my-container" },
            name: "test-service-a",
            msg: logMsgWithColor,
            timestamp,
          },
        ],
      })
    })
    it("should sort entries by timestamp", async () => {
      const getServiceLogsHandler = async (params: GetDeployLogsParams) => {
        void params.stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "3",
          timestamp: new Date("2021-05-13T20:03:00.000Z"),
        })
        void params.stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "4",
          timestamp: new Date("2021-05-13T20:04:00.000Z"),
        })
        void params.stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "2",
          timestamp: new Date("2021-05-13T20:02:00.000Z"),
        })
        void params.stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "1",
          timestamp: new Date("2021-05-13T20:01:00.000Z"),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))

      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden }))

      expect(res).to.eql({
        result: [
          {
            tags: { container: "my-container" },
            name: "test-service-a",
            msg: "1",
            timestamp: new Date("2021-05-13T20:01:00.000Z"),
          },
          {
            tags: { container: "my-container" },
            name: "test-service-a",
            msg: "2",
            timestamp: new Date("2021-05-13T20:02:00.000Z"),
          },
          {
            tags: { container: "my-container" },
            name: "test-service-a",
            msg: "3",
            timestamp: new Date("2021-05-13T20:03:00.000Z"),
          },
          {
            tags: { container: "my-container" },
            name: "test-service-a",
            timestamp: new Date("2021-05-13T20:04:00.000Z"),
            msg: "4",
          },
        ],
      })
    })
    it("should skip empty entries", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        // Empty message and invalid date
        void stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "",
          timestamp: new Date(""),
        })
        // Empty message and empty date
        void stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: "",
          timestamp: undefined,
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))

      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden }))

      expect(res).to.eql({ result: [] })
    })
    it("should render the service name by default", async () => {
      const garden = await makeGarden(tmpDir, makeTestPlugin())
      const command = new LogsCommand()
      await command.action(makeCommandParams({ garden }))

      const out = getLogOutput(garden, logMsg)

      expect(out[0]).to.eql(`${color.bold("test-service-a")} → ${msgColor("Yes, this is log")}`)
    })
    it("should optionally skip rendering the service name", async () => {
      const garden = await makeGarden(tmpDir, makeTestPlugin())
      const command = new LogsCommand()
      await command.action(makeCommandParams({ garden, opts: { "hide-name": true } }))

      const out = getLogOutput(garden, logMsg)

      expect(out[0]).to.eql(msgColor("Yes, this is log"))
    })
    it("should optionally show timestamps", async () => {
      const garden = await makeGarden(tmpDir, makeTestPlugin())
      const command = new LogsCommand()
      await command.action(makeCommandParams({ garden, opts: { timestamps: true } }))

      const out = getLogOutput(garden, logMsg)

      expect(out[0]).to.eql(
        `${color.bold("test-service-a")} → ${chalk.gray(timestamp.toISOString())} → ${msgColor("Yes, this is log")}`
      )
    })
    it("should render entries with no ansi color white", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "my-container" },
          name: "test-service-a",
          msg: logMsg, // No color
          timestamp: undefined,
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      const command = new LogsCommand()
      await command.action(makeCommandParams({ garden }))

      const out = getLogOutput(garden, logMsg)

      expect(out[0]).to.eql(`${color.bold("test-service-a")} → ${chalk.white("Yes, this is log")}`)
    })
    context("mutliple services", () => {
      it("should align content for visible entries", async () => {
        const getServiceLogsHandler = async ({ action, stream }: GetDeployLogsParams) => {
          if (action.name === "a-short") {
            void stream.write({
              tags: { container: "short" },
              name: "a-short",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:01:00.000Z"), // <--- 1
            })
            void stream.write({
              tags: { container: "short" },
              name: "a-short",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:03:00.000Z"), // <--- 3
            })
            void stream.write({
              tags: { container: "short" },
              name: "a-short",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:06:00.000Z"), // <--- 6
            })
          } else if (action.name === "b-not-short") {
            void stream.write({
              tags: { container: "not-short" },
              name: "b-not-short",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:02:00.000Z"), // <--- 2
            })
          } else if (action.name === "c-by-far-the-longest-of-the-bunch") {
            void stream.write({
              tags: { container: "by-far-the-longest-of-the-bunch" },
              name: "c-by-far-the-longest-of-the-bunch",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:04:00.000Z"), // <--- 4
              level: LogLevel.verbose,
            })
          } else if (action.name === "d-very-very-long") {
            void stream.write({
              tags: { container: "very-very-long" },
              name: "d-very-very-long",
              msg: logMsgWithColor,
              timestamp: new Date("2021-05-13T20:05:00.000Z"), // <--- 5
            })
          }
          return {}
        }
        const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))

        garden.setActionConfigs(
          [],
          [
            makeDeployAction(tmpDir.path, "a-short"),
            makeDeployAction(tmpDir.path, "b-not-short"),
            makeDeployAction(tmpDir.path, "c-by-far-the-longest-of-the-bunch"),
            makeDeployAction(tmpDir.path, "d-very-very-long"),
          ]
        )

        // Entries are color coded by their alphabetical order
        const colA = chalk[colors[0]]
        const colB = chalk[colors[1]]
        const colD = chalk[colors[3]]
        const dc = msgColor
        const command = new LogsCommand()
        await command.action(makeCommandParams({ garden, opts: { "show-tags": true } }))

        const out = getLogOutput(garden, logMsg, (entry) => entry.level === LogLevel.info)

        expect(out[0]).to.eql(`${colA.bold("a-short")} → ${chalk.gray("[container=short] ")}${dc(logMsg)}`)
        expect(out[1]).to.eql(`${colB.bold("b-not-short")} → ${chalk.gray("[container=not-short] ")}${dc(logMsg)}`)
        expect(out[2]).to.eql(`${colA.bold("a-short    ")} → ${chalk.gray("[container=short] ")}${dc(logMsg)}`)
        expect(out[3]).to.eql(
          `${colD.bold("d-very-very-long")} → ${chalk.gray("[container=very-very-long] ")}${dc(logMsg)}`
        )
        expect(out[4]).to.eql(`${colA.bold("a-short         ")} → ${chalk.gray("[container=short] ")}${dc(logMsg)}`)
      })
    })
    it("should assign the same color to each service, regardless of which service logs are streamed", async () => {
      const getServiceLogsHandler = async ({ action, stream }: GetDeployLogsParams) => {
        if (action.name === "test-service-a") {
          void stream.write({
            tags: { container: "my-container" },
            name: "test-service-a",
            msg: logMsgWithColor,
            timestamp: new Date("2021-05-13T20:00:00.000Z"),
          })
        } else {
          void stream.write({
            tags: { container: "my-container" },
            name: "test-service-b",
            msg: logMsgWithColor,
            timestamp: new Date("2021-05-13T20:01:00.000Z"),
          })
        }
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs(
        [],
        [makeDeployAction(tmpDir.path, "test-service-a"), makeDeployAction(tmpDir.path, "test-service-b")]
      )

      const command = new LogsCommand()
      // Only get logs for test-service-b.
      await command.action(makeCommandParams({ garden, args: { names: ["test-service-b"] } }))

      const out = getLogOutput(garden, logMsg)
      const color2 = chalk[colors[1]]

      // Assert that the service gets the "second" color, even though its the only one we're fetching logs for.
      expect(out[0]).to.eql(`${color2.bold("test-service-b")} → ${msgColor("Yes, this is log")}`)
    })

    const actionConfigsForTags = (): BaseActionConfig[] => [
      makeDeployAction(tmpDir.path, "api"),
      makeDeployAction(tmpDir.path, "frontend"),
    ]

    it("should optionally print tags with --show-tags", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api" },
          name: "api",
          msg: logMsgWithColor,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      await command.action(makeCommandParams({ garden, opts: { "show-tags": true } }))
      const out = getLogOutput(garden, logMsg)

      expect(out[0]).to.eql(`${color.bold("api")} → ${chalk.gray("[container=api] ")}${msgColor("Yes, this is log")}`)
    })

    // These tests use tags as emitted by `container`/`kubernetes`/`helm` services, which use the `container` tag.
    const filterByTag = (entries: DeployLogEntry[], tag: string): DeployLogEntry[] => {
      return entries.filter((e: DeployLogEntry) => e.tags!["container"] === tag)
    }

    it("should apply a basic --tag filter", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden, opts: { tag: ["container=api"] } }))

      expect(filterByTag(res.result!, "api").length).to.eql(2)
      expect(filterByTag(res.result!, "frontend").length).to.eql(0)
    })

    it("should throw when passed an invalid --tag filter", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api-main" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      await expectError(() => command.action(makeCommandParams({ garden, opts: { tag: ["*-main"] } })), {
        contains: "Unable to parse the given --tag flags. Format should be key=value.",
      })
    })

    it("should AND together tag filters in a given --tag option instance", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api", myTag: "1" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "api", myTag: "2" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend", myTag: "1" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden, opts: { tag: ["container=api,myTag=1"] } }))

      const matching = filterByTag(res.result!, "api")
      expect(matching.length).to.eql(2) // The same log line is emitted for each service in this test setup (here: 2)
      expect(matching[0].tags).to.eql({ container: "api", myTag: "1" })
      expect(matching[1].tags).to.eql({ container: "api", myTag: "1" })
    })

    it("should OR together tag filters from all provided --tag option instances", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api", myTag: "1" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "api", myTag: "2" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend", myTag: "1" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend", myTag: "2" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      const res = await command.action(
        makeCommandParams({ garden, opts: { tag: ["container=api,myTag=1", "container=frontend"] } })
      )

      const apiMatching = filterByTag(res.result!, "api")
      const frontendMatching = filterByTag(res.result!, "frontend")
      expect(apiMatching.length).to.eql(2) // The same log line is emitted for each service in this test setup (here: 2)
      expect(apiMatching[0].tags).to.eql({ container: "api", myTag: "1" })
      expect(apiMatching[1].tags).to.eql({ container: "api", myTag: "1" })
      expect(frontendMatching.length).to.eql(4)
      expect(frontendMatching[0].tags).to.eql({ container: "frontend", myTag: "1" })
      expect(frontendMatching[1].tags).to.eql({ container: "frontend", myTag: "2" })
    })

    it("should apply a wildcard --tag filter", async () => {
      const getServiceLogsHandler = async ({ stream }: GetDeployLogsParams) => {
        void stream.write({
          tags: { container: "api-main" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "api-sidecar" },
          name: "api",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend-main" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        void stream.write({
          tags: { container: "frontend-sidecar" },
          name: "frontend",
          msg: logMsg,
          timestamp: new Date(),
        })
        return {}
      }
      const garden = await makeGarden(tmpDir, makeTestPlugin(getServiceLogsHandler))
      garden.setActionConfigs([], actionConfigsForTags())

      const command = new LogsCommand()
      const res = await command.action(makeCommandParams({ garden, opts: { tag: ["container=*-main"] } }))

      expect(filterByTag(res.result!, "api-main").length).to.eql(2)
      expect(filterByTag(res.result!, "frontend-main").length).to.eql(2)
      expect(filterByTag(res.result!, "api-sidecar").length).to.eql(0)
      expect(filterByTag(res.result!, "frontend-sidecar").length).to.eql(0)
    })
  })
})
