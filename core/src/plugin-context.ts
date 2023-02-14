/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Garden } from "./garden"
import { projectNameSchema, projectSourcesSchema, environmentNameSchema, SourceConfig } from "./config/project"
import { Provider, providerSchema, GenericProviderConfig } from "./config/provider"
import { deline } from "./util/string"
import { joi, joiVariables, joiStringMap, DeepPrimitiveMap } from "./config/common"
import { PluginTool } from "./util/ext-tools"
import { ConfigContext, ContextResolveOpts } from "./config/template-contexts/base"
import { resolveTemplateStrings } from "./template-string/template-string"
import { Log } from "./logger/log-entry"
import { logEntrySchema } from "./plugin/base"
import { EventEmitter } from "eventemitter3"

type WrappedFromGarden = Pick<
  Garden,
  | "projectName"
  | "projectRoot"
  | "gardenDirPath"
  | "workingCopyId"
  | "cloudApi"
  // TODO: remove this from the interface
  | "environmentName"
  | "production"
  | "sessionId"
>

export interface CommandInfo {
  name: string
  args: DeepPrimitiveMap
  opts: DeepPrimitiveMap
}

type ResolveTemplateStringsOpts = Omit<ContextResolveOpts, "stack">

export interface PluginContext<C extends GenericProviderConfig = GenericProviderConfig> extends WrappedFromGarden {
  command: CommandInfo
  log: Log
  events: PluginEventBroker
  projectSources: SourceConfig[]
  provider: Provider<C>
  resolveTemplateStrings: <T>(o: T, opts?: ResolveTemplateStringsOpts) => T
  tools: { [key: string]: PluginTool }
}

// NOTE: this is used more for documentation than validation, outside of internal testing
// TODO: validate the output from createPluginContext against this schema (in tests)
export const pluginContextSchema = () =>
  joi
    .object()
    .options({ presence: "required" })
    .keys({
      command: joi
        .object()
        .optional()
        .keys({
          name: joi.string().required().description("The command name currently being executed."),
          args: joiVariables().required().description("The positional arguments passed to the command."),
          opts: joiVariables().required().description("The optional flags passed to the command."),
        })
        .description("Information about the command being executed, if applicable."),
      environmentName: environmentNameSchema(),
      events: joi.any().description("An event emitter, used for communication during handler execution."),
      gardenDirPath: joi.string().description(deline`
        The absolute path of the project's Garden dir. This is the directory the contains builds, logs and
        other meta data. A custom path can be set when initialising the Garden class. Defaults to \`.garden\`.
      `),
      log: logEntrySchema(),
      production: joi
        .boolean()
        .default(false)
        .description("Indicate if the current environment is a production environment.")
        .example(true),
      projectName: projectNameSchema(),
      projectRoot: joi.string().description("The absolute path of the project root."),
      projectSources: projectSourcesSchema(),
      provider: providerSchema().description("The provider being used for this context.").id("ctxProviderSchema"),
      resolveTemplateStrings: joi
        .function()
        .description(
          "Helper function to resolve template strings, given the same templating context as was used to render the configuration before calling the handler. Accepts any data type, and returns the same data type back with all template strings resolved."
        ),
      sessionId: joi.string().description("The unique ID of the currently active session."),
      tools: joiStringMap(joi.object()),
      workingCopyId: joi.string().description("A unique ID assigned to the current project working copy."),
      cloudApi: joi.any().optional(),
    })

export type PluginEventLogContext = {
  /** entity that created the log message, e.g. tool that generated it */
  origin: string

  /**
   * LogEntry placeholder to be used to stream the logs to the CLI
   * It's recommended to pass a verbose placeholder created like this: `log.placeholder({ level: LogLevel.verbose })`
   *
   * @todo 0.13 consider removing this once we have the append-only logger (#3254)
   */
  log: Log
}

export type PluginEventLogMessage = PluginEventLogContext & {
  /**
   * Number of milliseconds since the epoch OR a date string.
   *
   * We need to allow both numberic and string types for backwards compatibility
   * with Garden Cloud.
   *
   * Garden Cloud supports numeric date strings for log streaming as of v1.360.
   * We can change this to just 'number' once all Cloud instances are up to date.
   *
   * TODO: Change to type 'number'.
   */
  timestamp: number | string

  /** log message */
  data: Buffer
}

// Define your emitter's types like that:
// Key: Event name; Value: Listener function signature
type PluginEvents = {
  abort: (reason?: string) => void
  log: (msg: PluginEventLogMessage) => void
}

type PluginEventType = keyof PluginEvents

export class PluginEventBroker extends EventEmitter<PluginEvents, PluginEventType> {}

export async function createPluginContext({
  garden,
  provider,
  command,
  templateContext,
  events,
}: {
  garden: Garden
  provider: Provider
  command: CommandInfo
  templateContext: ConfigContext
  events: PluginEventBroker | undefined
}): Promise<PluginContext> {
  return {
    command,
    events: events || new PluginEventBroker(),
    environmentName: garden.environmentName,
    gardenDirPath: garden.gardenDirPath,
    log: garden.log,
    projectName: garden.projectName,
    projectRoot: garden.projectRoot,
    projectSources: garden.getProjectSources(),
    provider,
    production: garden.production,
    resolveTemplateStrings: <T>(o: T, opts?: ResolveTemplateStringsOpts) => {
      return resolveTemplateStrings(o, templateContext, opts || {})
    },
    sessionId: garden.sessionId,
    tools: await garden.getTools(),
    workingCopyId: garden.workingCopyId,
    cloudApi: garden.cloudApi,
  }
}
