/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import nodeEmoji from "node-emoji"
import chalk, { Chalk } from "chalk"
import { formatGardenErrorWithDetail, getLogger } from "./logger"
import { Log, LogEntryParams, EmojiName, LogEntryMessage } from "./log-entry"
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

export function findParentEntry(entry: Log, predicate: ProcessNode<Log>): Log | null {
  return predicate(entry) ? entry : entry.parent ? findParentEntry(entry.parent, predicate) : null
}

export function getAllSections(entry: Log, msg: LogEntryMessage) {
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

/**
 * Returns the entry's section or first parent section it finds.
 */
export function findSection(entry: Log): string | null {
  const section = entry.getLatestMessage().section
  if (section) {
    return section
  }
  if (entry.parent) {
    return findSection(entry.parent)
  }

  return null
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

export function printHeader(log: Log, command: string, emoji: EmojiName): void {
  log.info(chalk.bold.magenta(command) + " " + printEmoji(emoji))
  log.info("") // Print new line after header
}

export function printFooter(log: Log) {
  log.info("") // Print new line before footer
  return log.info(chalk.bold.magenta("Done!") + " " + printEmoji("heavy_check_mark"))
}

export function printWarningMessage(log: Log, text: string) {
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
