/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { BaseActionTaskParams, ActionTaskProcessParams, ActionTaskStatusParams, ExecuteActionTask } from "../tasks/base"
import { Profile } from "../util/profiling"
import { BuildAction } from "../actions/build"
import pluralize from "pluralize"
import { BuildStatus } from "../plugin/handlers/Build/get-status"
import { executeAction } from "../actions/helpers"

export interface BuildTaskParams extends BaseActionTaskParams<BuildAction> {
  force: boolean
}

@Profile()
export class BuildTask extends ExecuteActionTask<BuildAction, BuildStatus> {
  type = "build"
  concurrencyLimit = 5

  getDescription() {
    return this.action.longDescription()
  }

  async getStatus({ dependencyResults }: ActionTaskStatusParams<BuildAction>) {
    const router = await this.garden.getActionRouter()
    const action = this.getResolvedAction(this.action, dependencyResults)
    const status = await router.build.getStatus({ log: this.log, graph: this.graph, action })
    return { ...status, executedAction: executeAction(action, { status }) }
  }

  async process({ dependencyResults }: ActionTaskProcessParams<BuildAction, BuildStatus>) {
    const router = await this.garden.getActionRouter()
    const action = this.getResolvedAction(this.action, dependencyResults)

    if (action.isDisabled()) {
      this.log.info(
        `${action.longDescription()} is disabled, but is being executed because another action depends on it.`
      )
    }

    let log = this.log
      .makeNewLogContext({
        section: this.getName(),
      })
      .info(`Building version ${this.version}...`)

    const files = action.getFullVersion().files

    if (files.length > 0) {
      log.verbose(`Syncing module sources (${pluralize("file", files.length, true)})...`)
    }

    await this.garden.buildStaging.syncFromSrc(action, log || this.log)

    log.setSuccess(chalk.green(`Done (took ${log.getDuration(1)} sec)`))

    await this.garden.buildStaging.syncDependencyProducts(action, log)

    try {
      const result = await router.build.build({
        graph: this.graph,
        action,
        log,
      })
      log.setSuccess(chalk.green(`Done (took ${log.getDuration(1)} sec)`))

      return { ...result, executedAction: executeAction(action, { status: result }) }
    } catch (err) {
      log.setError()
      throw err
    }
  }
}
