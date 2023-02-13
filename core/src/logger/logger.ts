/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { LogEntry, LogEntryMetadata, LogEntryNew, LogEntryParams } from "./log-entry"
import { Writer } from "./writers/base"
import { CommandError, GardenError, InternalError, ParameterError } from "../exceptions"
import { BasicTerminalWriter } from "./writers/basic-terminal-writer"
import { JsonTerminalWriter } from "./writers/json-terminal-writer"
import { EventBus } from "../events"
import { formatLogEntryForEventStream } from "../cloud/buffered-event-stream"
import { gardenEnv } from "../constants"
import { deepFilter, getEnumKeys, safeDumpYaml } from "../util/util"
import { isArray, isEmpty, isPlainObject, mapValues, range } from "lodash"
import { isPrimitive } from "../config/common"
import { InkTerminalWriter } from "./writers/ink-terminal-writer"

export type LoggerType = "quiet" | "basic" | "fancy" | "json" | "ink"
export const LOGGER_TYPES = new Set<LoggerType>(["quiet", "basic", "fancy", "json", "ink"])

export enum LogLevel {
  error = 0,
  warn = 1,
  info = 2,
  verbose = 3,
  debug = 4,
  silly = 5,
}

const getLogLevelNames = () => getEnumKeys(LogLevel)
const getNumericLogLevels = () => range(getLogLevelNames().length)
// Allow string or numeric log levels as CLI choices
export const getLogLevelChoices = () => [...getLogLevelNames(), ...getNumericLogLevels().map(String)]
export function parseLogLevel(level: string): LogLevel {
  let lvl: LogLevel
  const parsed = parseInt(level, 10)
  // Level is numeric
  if (parsed || parsed === 0) {
    lvl = parsed
    // Level is a string
  } else {
    lvl = LogLevel[level]
  }
  if (!getNumericLogLevels().includes(lvl)) {
    throw new InternalError(
      `Unexpected log level, expected one of ${getLogLevelChoices().join(", ")}, got ${level}`,
      {}
    )
  }
  return lvl
}

// Recursively filters out internal fields, including keys starting with _ and some specific fields found on Modules.
export function withoutInternalFields(object: any): any {
  return deepFilter(object, (_val, key: string | number) => {
    if (typeof key === "string") {
      return (
        !key.startsWith("_") &&
        // FIXME: this a little hacky and should be removable in 0.14 at the latest.
        // The buildDependencies map on Module objects explodes outputs, as well as the dependencyVersions field on
        // version objects.
        key !== "dependencyVersions" &&
        key !== "dependencyResults" &&
        key !== "buildDependencies"
      )
    }
    return true
  })
}

export function formatGardenErrorWithDetail(error: GardenError) {
  const { detail, message, stack } = error
  let out = stack || message || ""

  // We sanitize and recursively filter out internal fields (i.e. having names starting with _).
  const filteredDetail = withoutInternalFields(sanitizeValue(detail))

  if (!isEmpty(filteredDetail)) {
    try {
      const yamlDetail = safeDumpYaml(filteredDetail, { skipInvalid: true, noRefs: true })
      out += `\n\nError Details:\n\n${yamlDetail}`
    } catch (err) {
      out += `\n\nUnable to render error details:\n${err.message}`
    }
  }
  return out
}

/**
 * Strips undefined values, internal objects and circular references from an object.
 */
export function sanitizeValue(value: any, _parents?: WeakSet<any>): any {
  if (!_parents) {
    _parents = new WeakSet()
  } else if (_parents.has(value)) {
    // console.log("CIRCULAR")
    return "[Circular]"
  }

  if (value === null || value === undefined) {
    return value
  } else if (Buffer.isBuffer(value)) {
    return "<Buffer>"
  } else if (value instanceof Logger) {
    return "<Logger>"
  } else if (value instanceof LogEntry) {
    return "<LogEntry>"
    // This is hacky but fairly reliably identifies a Joi schema object
  } else if (value.$_root) {
    // TODO: Identify the schema
    return "<JoiSchema>"
  } else if (value.isGarden) {
    return "<Garden>"
  } else if (isArray(value)) {
    _parents.add(value)
    const out = value.map((v) => sanitizeValue(v, _parents))
    _parents.delete(value)
    return out
  } else if (isPlainObject(value)) {
    _parents.add(value)
    const out = mapValues(value, (v) => sanitizeValue(v, _parents))
    _parents.delete(value)
    return out
  } else if (!isPrimitive(value) && value.constructor) {
    // Looks to be a class instance
    if (value.toSanitizedValue) {
      // Special allowance for internal objects
      return value.toSanitizedValue()
    } else {
      // Any other class. Convert to plain object and sanitize attributes.
      _parents.add(value)
      const out = mapValues({ ...value }, (v) => sanitizeValue(v, _parents))
      _parents.delete(value)
      return out
    }
  } else {
    return value
  }
}

export const logLevelMap = {
  [LogLevel.error]: "error",
  [LogLevel.warn]: "warn",
  [LogLevel.info]: "info",
  [LogLevel.verbose]: "verbose",
  [LogLevel.debug]: "debug",
  [LogLevel.silly]: "silly",
}

const eventLogLevel = LogLevel.debug

export function getWriterInstance(loggerType: LoggerType, level: LogLevel) {
  switch (loggerType) {
    case "basic":
      return new BasicTerminalWriter({ level })
    case "fancy":
      return new BasicTerminalWriter({ level })
    //   return new FancyTerminalWriter({ level })
    case "json":
      return new JsonTerminalWriter({ level })
    case "ink":
      return new InkTerminalWriter({ level })
    case "quiet":
      return undefined
  }
}

export interface LoggerConfigBase {
  level: LogLevel
  storeEntries?: boolean
  showTimestamps?: boolean
  useEmoji?: boolean
}

export interface LoggerConfig extends LoggerConfigBase {
  type: LoggerType
  storeEntries: boolean
}

export interface LoggerConstructor extends LoggerConfigBase {
  writers: Writer[]
  storeEntries: boolean
}

export interface CreateLogEntryParams extends LogEntryParams {
  level: LogLevel
}

export interface PlaceholderOpts {
  level?: number
  childEntriesInheritLevel?: boolean
  indent?: number
  metadata?: LogEntryMetadata
}

export interface LogNode {
  silly(params: string | LogEntryParams): void
  debug(params: string | LogEntryParams): void
  verbose(params: string | LogEntryParams): void
  info(params: string | LogEntryParams): void
  warn(params: string | LogEntryParams): void
  error(params: string | LogEntryParams): void
}

function resolveParams(level: LogLevel, params: string | LogEntryParams): CreateLogEntryParams {
  if (typeof params === "string") {
    return { msg: params, level }
  }
  return { ...params, level }
}

// TODO @eysi: Rename.
export class Logger {
  public events: EventBus
  public useEmoji: boolean
  public showTimestamps: boolean
  public level: LogLevel
  public children: LogEntryNew[]
  /**
   * Whether or not the log entries are stored in-memory on the logger instance.
   * Defaults to false except when the FancyWriter is used, in which case storing the entries
   * is required. Otherwise useful for testing.
   */
  public storeEntries: boolean

  private writers: Writer[]
  private static instance?: Logger

  static getInstance() {
    if (!Logger.instance) {
      throw new InternalError("Logger not initialized", {})
    }
    return Logger.instance
  }

  /**
   * Initializes the logger as a singleton from config. Also ensures that the logger settings make sense
   * in the context of environment variables and writer types.
   */
  static initialize(config: LoggerConfig): Logger {
    if (Logger.instance) {
      return Logger.instance
    }

    let instance: Logger

    // The GARDEN_LOG_LEVEL env variable takes precedence over the config param
    if (gardenEnv.GARDEN_LOG_LEVEL) {
      try {
        config.level = parseLogLevel(gardenEnv.GARDEN_LOG_LEVEL)
      } catch (err) {
        throw new CommandError(`Invalid log level set for GARDEN_LOG_LEVEL: ${err.message}`, {})
      }
    }

    // GARDEN_LOGGER_TYPE env variable takes precedence over the config param
    if (gardenEnv.GARDEN_LOGGER_TYPE) {
      const loggerTypeFromEnv = <LoggerType>gardenEnv.GARDEN_LOGGER_TYPE

      if (!LOGGER_TYPES.has(loggerTypeFromEnv)) {
        throw new ParameterError(`Invalid logger type specified: ${loggerTypeFromEnv}`, {
          loggerType: gardenEnv.GARDEN_LOGGER_TYPE,
          availableTypes: LOGGER_TYPES,
        })
      }

      config.type = loggerTypeFromEnv
    }

    // The fancy logger doesn't play well with high log levels and/or timestamps
    // so we enforce that the type is set to basic.
    if (config.type === "fancy" && (config.level > LogLevel.info || config.showTimestamps)) {
      config.type = "basic"
    }

    const writer = getWriterInstance(config.type, config.level)

    instance = new Logger({ ...config, storeEntries: config.storeEntries, writers: writer ? [writer] : [] })

    // TODO: @eysi
    const log = instance.placeholder()

    if (gardenEnv.GARDEN_LOG_LEVEL) {
      log.debug(`Setting log level to ${gardenEnv.GARDEN_LOG_LEVEL} (from GARDEN_LOG_LEVEL)`)
    }
    if (gardenEnv.GARDEN_LOGGER_TYPE) {
      log.debug(`Setting logger type to ${gardenEnv.GARDEN_LOGGER_TYPE} (from GARDEN_LOGGER_TYPE)`)
    }

    Logger.instance = instance
    return instance
  }

  /**
   * Clears the singleton instance. Use this if you need to re-initialise the global logger singleton.
   */
  static clearInstance() {
    Logger.instance = undefined
  }

  constructor(config: LoggerConstructor) {
    this.level = config.level
    this.children = []
    this.writers = config.writers || []
    this.useEmoji = config.useEmoji === false ? false : true
    this.showTimestamps = !!config.showTimestamps
    this.events = new EventBus()
    this.storeEntries = config.storeEntries
  }

  addWriter(writer: Writer) {
    this.writers.push(writer)
  }

  getWriters() {
    return this.writers
  }

  onGraphChange(entry: LogEntryNew) {
    if (this.storeEntries) {
      this.children.push(entry)
    }
    if (entry.level <= eventLogLevel) {
      this.events.emit("logEntry", formatLogEntryForEventStream(entry))
    }
    for (const writer of this.writers) {
      if (entry.level <= writer.level) {
        writer.onGraphChange(entry, this)
      }
    }
  }

  // TODO @eysi: Rename
  placeholder({
    level = LogLevel.info,
    indent,
    metadata,
  }: {
    level?: LogLevel
    indent?: number
    metadata?: LogEntryMetadata
  } = {}) {
    return new LogEntry({
      level,
      indent,
      metadata,
      root: this,
    })
  }

  getLogEntries(): LogEntryNew[] {
    if (!this.storeEntries) {
      throw new InternalError(`Cannot get entries when storeEntries=false`, {})
    }
    return this.children.filter((entry) => !entry.fromStdStream)
  }

  filterBySection(section: string): LogEntryNew[] {
    if (!this.storeEntries) {
      throw new InternalError(`Cannot filter entries when storeEntries=false`, {})
    }
    return this.children.filter((entry) => entry.section === section)
  }

  findById(id: string): LogEntryNew | void {
    if (!this.storeEntries) {
      throw new InternalError(`Cannot find entry when storeEntries=false`, {})
    }
    return this.children.find((entry) => entry.id === id)
  }

  stop(): void {
    this.writers.forEach((writer) => writer.stop())
  }

  cleanup(): void {
    this.writers.forEach((writer) => writer.cleanup())
  }
}

/**
 * Dummy Logger instance, just swallows log entries and prints nothing.
 */
export class VoidLogger extends Logger {
  constructor() {
    super({ writers: [], level: LogLevel.error, storeEntries: false })
  }
}

export function getLogger() {
  return Logger.getInstance()
}
