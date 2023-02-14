/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import indentString from "indent-string"
import { RunAction } from "../actions/run"
import { TestAction } from "../actions/test"

import { ConfigGraph } from "../graph/config-graph"
import { WorkflowConfig } from "../config/workflow"
import { Log } from "../logger/log-entry"
import { BooleanParameter } from "../cli/params"
import { Garden } from "../garden"

export function getMatchingDeployNames(namesFromOpt: string[] | undefined, configGraph: ConfigGraph) {
  const names = namesFromOpt || []
  if (names.includes("*") || (!!namesFromOpt && namesFromOpt.length === 0)) {
    return configGraph.getDeploys().map((s) => s.name)
  } else {
    return names
  }
}

export function makeGetTestOrTaskLog(actions: (TestAction | RunAction)[]) {
  return actions.map((t) => prettyPrintTestOrTask(t)).join("\n")
}

export function prettyPrintWorkflow(workflow: WorkflowConfig): string {
  let out = `${chalk.cyan.bold(workflow.name)}`

  if (workflow.description) {
    out += "\n" + indentString(printField("description", workflow.description), 2)
  } else {
    out += "\n"
  }

  return out
}

function prettyPrintTestOrTask(action: TestAction | RunAction): string {
  let out = `${chalk.cyan.bold(action.name)}`

  out += "\n" + indentString(printField("type", action.type), 2)

  const { description } = action.getConfig()

  if (description) {
    out += "\n" + indentString(printField("description", description), 2)
  }

  const deps = action.getDependencyReferences()

  if (deps.length) {
    out += "\n" + indentString(`${chalk.gray("dependencies")}:`, 2) + "\n"
    out += indentString(deps.map((ref) => `• ${ref.kind}.${ref.name}`).join("\n"), 4)
  }

  return out + "\n"
}

function printField(name: string, value: string | null) {
  return `${chalk.gray(name)}: ${value || ""}`
}

export const watchParameter = new BooleanParameter({
  help: "[REMOVED] Watch for changes and update actions automatically.",
  alias: "w",
  cliOnly: true,
  hidden: true,
})

export async function watchRemovedWarning(garden: Garden, log: Log) {
  return garden.emitWarning({
    log,
    key: "watch-flag-removed",
    message:
      "The -w/--watch flag has been removed. Please use other options instead, such as the --dev/--dev-mode option for Deploy actions. If you need this feature and would like it re-introduced, please don't hesitate to reach out: https://garden.io/community",
  })
}
