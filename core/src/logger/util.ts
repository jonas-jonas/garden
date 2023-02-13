/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import nodeEmoji from "node-emoji"
import chalk, { Chalk } from "chalk"
import { formatGardenErrorWithDetail, getLogger, LogLevel } from "./logger"
import { Logger } from "./logger"
import { LogEntry, LogEntryParams, EmojiName, LogEntryMessage } from "./log-entry"
import hasAnsi from "has-ansi"
import dedent from "dedent"
import stringWidth from "string-width"
import { GardenError } from "../exceptions"

// Add platforms/terminals?
export function envSupportsEmoji() {
  return (
    process.platform === "darwin" || process.env.TERM_PROGRAM === "Hyper" || process.env.TERM_PROGRAM === "HyperTerm"
  )
}

export interface Node {
  children: any[]
}

export type LogOptsResolvers = { [K in keyof LogEntryParams]?: Function }

export type ProcessNode<T extends Node = Node> = (node: T) => boolean

function traverseChildren<T extends Node>(node: Node, cb: ProcessNode<T>, reverse = false) {
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const index = reverse ? children.length - 1 - i : i
    const proceed = cb(children[index])
    if (!proceed) {
      return
    }
    traverseChildren(children[index], cb)
  }
}

// Parent (T|U) can have different type then child (U)
export function getChildNodes<T extends Node, U extends Node>(node: T): U[] {
  let childNodes: U[] = []
  traverseChildren<U>(node, (child) => {
    childNodes.push(child)
    return true
  })
  return childNodes
}

export function getChildEntries(node: Logger | LogEntry): LogEntry[] {
  return getChildNodes(node)
}

export function findParentEntry(entry: LogEntry, predicate: ProcessNode<LogEntry>): LogEntry | null {
  return predicate(entry) ? entry : entry.parent ? findParentEntry(entry.parent, predicate) : null
}

export function getAllSections(entry: LogEntry, msg: LogEntryMessage) {
  const sections: string[] = []
  let parent = entry.parent

  while (parent) {
    const s = parent.getLatestMessage().section
    s && sections.push(s)
    parent = parent.parent
  }

  msg.section && sections.push(msg.section)

  return sections
}

export function findLogEntry(node: Logger | LogEntry, predicate: ProcessNode<LogEntry>): LogEntry | void {
  let found: LogEntry | undefined
  traverseChildren<LogEntry>(node, (entry) => {
    if (predicate(entry)) {
      found = entry
      return false
    }
    return true
  })
  return found
}

/**
 * Given a LogNode, get a list of LogEntries that represent the last `lines` number of log lines nested under the node.
 * Note that the returned number of lines may be slightly higher, so you should slice after rendering them (which
 * you anyway need to do if you're wrapping the lines to a certain width).
 *
 * @param node   the log node whose child entries we want to tail
 * @param level  maximum log level to include
 * @param lines  how many lines to aim for
 */
export function tailChildEntries(node: Logger | LogEntry, level: LogLevel, lines: number): LogEntry[] {
  let output: LogEntry[] = []
  let outputLines = 0

  traverseChildren<LogEntry>(node, (entry) => {
    if (entry.level <= level) {
      output.push(entry)
      const msg = entry.getLatestMessage().msg || ""
      outputLines += msg.length > 0 ? msg.split("\n").length : 0

      if (outputLines >= lines) {
        return false
      }
    }
    return true
  })

  return output
}

/**
 * Returns the entry's section or first parent section it finds.
 */
export function findSection(entry: LogEntry): string | null {
  const section = entry.getLatestMessage().section
  if (section) {
    return section
  }
  if (entry.parent) {
    return findSection(entry.parent)
  }

  return null
}

/**
 * Get the log entry preceding the given `entry` in its tree, given the minimum log `level`.
 */
export function getPrecedingEntry(entry: LogEntry) {
  if (!entry.parent) {
    // This is the first entry in its tree
    return
  }

  const siblings = entry.parent.children
  const index = siblings.findIndex((e) => e.key === entry.key)

  if (index === 0) {
    // The nearest entry is the parent
    return entry.parent
  } else {
    // The nearest entry is the last entry nested under the next sibling above,
    // or the sibling itself if it has no child nodes
    const sibling = siblings[index - 1]
    const siblingChildren = getChildEntries(sibling)

    if (siblingChildren.length > 0) {
      return siblingChildren[siblingChildren.length - 1]
    } else {
      return sibling
    }
  }
}

interface StreamWriteExtraParam {
  noIntercept?: boolean
}

/**
 * Intercepts the write method of a WriteableStream and calls the provided callback on the
 * string to write (or optionally applies the string to the write method)
 * Returns a function which sets the write back to default.
 *
 * Used e.g. by FancyLogger so that writes from other sources can be intercepted
 * and pushed to the log stack.
 */
export function interceptStream(stream: NodeJS.WriteStream, callback: Function) {
  const prevWrite = stream.write

  stream.write = ((write) => (
    string: string,
    encoding?: string,
    cb?: Function,
    extraParam?: StreamWriteExtraParam
  ): boolean => {
    if (extraParam && extraParam.noIntercept) {
      const args = [string, encoding, cb]
      return write.apply(stream, args)
    }
    callback(string)
    return true
  })(stream.write) as any

  const restore = () => {
    stream.write = prevWrite
  }

  return restore
}

export let overrideTerminalWidth: number | undefined

export function getTerminalWidth(stream: NodeJS.WriteStream = process.stdout) {
  // Used for unit tests
  if (overrideTerminalWidth) {
    return overrideTerminalWidth
  }

  const columns = (stream || {}).columns

  if (!columns) {
    return 80
  }

  // Windows appears to wrap a character early
  if (process.platform === "win32") {
    return columns - 1
  }

  return columns
}

/**
 * Prints emoji if supported and adds padding to the right (otherwise subsequent text flows over the emoji).
 */
export function printEmoji(emoji: EmojiName) {
  const logger = getLogger()
  if (logger.useEmoji && nodeEmoji.hasEmoji(emoji)) {
    return `${nodeEmoji.get(emoji)} `
  }
  return ""
}

export function printHeader(log: LogEntry, command: string, emoji: EmojiName): void {
  log.info(chalk.bold.magenta(command) + " " + printEmoji(emoji))
  log.info("") // Print new line after header
}

export function printFooter(log: LogEntry) {
  log.info("") // Print new line before footer
  return log.info(chalk.bold.magenta("Done!") + " " + printEmoji("heavy_check_mark"))
}

export function printWarningMessage(log: LogEntry, text: string) {
  return log.info({ emoji: "warning", msg: chalk.bold.yellow(text) })
}


// TODO @eysi: This function doesn't really make sense as is.
export function formatError({ msg, error }: { msg: string, error?: GardenError }) {
  if (error) {
    return formatGardenErrorWithDetail(error)
  }

  return msg
}


interface DividerOpts {
  width?: number
  char?: string
  titlePadding?: number
  color?: Chalk
  title?: string
  padding?: number
}

const getSideDividerWidth = (width: number, titleWidth: number) => (width - titleWidth) / 2
const getNumberOfCharsPerWidth = (char: string, width: number) => width / stringWidth(char)

// Adapted from https://github.com/JureSotosek/ink-divider
export function renderDivider({ width = 80, char = "─", titlePadding = 1, color, title, padding = 0 }: DividerOpts = {}) {
  const pad = " "

  if (!color) {
    color = chalk.white
  }

  const titleString = title ? `${pad.repeat(titlePadding) + title + pad.repeat(titlePadding)}` : ""
  const titleWidth = stringWidth(titleString)

  const dividerWidth = getSideDividerWidth(width, titleWidth)
  const numberOfCharsPerSide = getNumberOfCharsPerWidth(char, dividerWidth)
  const dividerSideString = color(char.repeat(numberOfCharsPerSide))

  const paddingString = pad.repeat(padding)

  return paddingString + dividerSideString + titleString + dividerSideString + paddingString
}

export function renderMessageWithDivider(prefix: string, msg: string, isError: boolean, color?: Chalk) {
  // Allow overwriting color as an escape hatch. Otherwise defaults to white or red in case of errors.
  const msgColor = color || (isError ? chalk.red : chalk.white)
  return dedent`
  \n${msgColor.bold(prefix)}
  ${msgColor.bold(renderDivider())}
  ${hasAnsi(msg) ? msg : msgColor(msg)}
  ${msgColor.bold(renderDivider())}
  `
}
