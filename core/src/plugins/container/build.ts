/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { containerHelpers } from "./helpers"
import { ConfigurationError } from "../../exceptions"
import { LogLevel } from "../../logger/logger"
import { PrimitiveMap } from "../../config/common"
import split2 from "split2"
import { BuildActionHandler } from "../../plugin/action-types"
import { ContainerBuildAction, ContainerBuildOutputs, defaultDockerfileName } from "./config"
import { joinWithPosix } from "../../util/fs"
import { Resolved } from "../../actions/types"

export const getContainerBuildStatus: BuildActionHandler<"getStatus", ContainerBuildAction> = async ({
  ctx,
  action,
  log,
}) => {
  const outputs = action.getOutputs()
  const identifier = await containerHelpers.imageExistsLocally(outputs.localImageId, log, ctx)

  if (identifier) {
    log.debug({
      section: action.key(),
      msg: `Image ${identifier} already exists`,
      symbol: "info",
    })
  }

  const state = !!identifier ? "ready" : "not-ready"

  return { state, detail: {}, outputs }
}

export const buildContainer: BuildActionHandler<"build", ContainerBuildAction> = async ({ ctx, action, log }) => {
  containerHelpers.checkDockerServerVersion(await containerHelpers.getDockerVersion())

  const buildPath = action.getBuildPath()
  const spec = action.getSpec()
  const hasDockerfile = await containerHelpers.actionHasDockerfile(action)

  // make sure we can build the thing
  if (!hasDockerfile) {
    throw new ConfigurationError(
      `Dockerfile not found at ${spec.dockerfile || defaultDockerfileName} for build ${action.name}.
      Please make sure the file exists, and is not excluded by include/exclude fields or .gardenignore files.`,
      { spec }
    )
  }

  const outputs = action.getOutputs()

  const identifier = outputs.localImageId

  // build doesn't exist, so we create it
  log.info(`Building ${identifier}...`)

  const dockerfilePath = joinWithPosix(action.getBuildPath(), spec.dockerfile)

  const cmdOpts = ["build", "-t", identifier, ...getDockerBuildFlags(action), "--file", dockerfilePath]

  const logEventContext = {
    origin: "docker build",
    log: log.makeNewLogContext({ level: LogLevel.verbose }),
  }

  const outputStream = split2()
  outputStream.on("error", () => {})
  outputStream.on("data", (line: Buffer) => {
    ctx.events.emit("log", { timestamp: new Date().getTime(), data: line, ...logEventContext })
  })
  const timeout = action.getConfig("timeout")
  const res = await containerHelpers.dockerCli({
    cwd: action.getBuildPath(),
    args: [...cmdOpts, buildPath],
    log,
    stdout: outputStream,
    stderr: outputStream,
    timeout,
    ctx,
  })

  return {
    state: "ready",
    outputs,
    detail: { fresh: true, buildLog: res.all || "", outputs, details: { identifier } },
  }
}

export function getContainerBuildActionOutputs(action: Resolved<ContainerBuildAction>): ContainerBuildOutputs {
  const buildName = action.name
  const localId = action.getSpec("localId")
  const version = action.getFullVersion()

  const localImageName = containerHelpers.getLocalImageName(buildName, localId)
  const localImageId = containerHelpers.getLocalImageId(buildName, localId, version)

  // Note: The deployment image name/ID outputs are overridden by the kubernetes provider, these defaults are
  // generally not used.
  const deploymentImageName = containerHelpers.getDeploymentImageName(buildName, localId, undefined)
  const deploymentImageId = containerHelpers.getBuildDeploymentImageId(buildName, localId, version, undefined)

  return {
    localImageName,
    localImageId,
    deploymentImageName,
    deploymentImageId,
    "local-image-name": localImageName,
    "local-image-id": localImageId,
    "deployment-image-name": deploymentImageName,
    "deployment-image-id": deploymentImageId,
  }
}

export function getDockerBuildFlags(action: Resolved<ContainerBuildAction>) {
  const args: string[] = []

  const { targetStage, extraFlags, buildArgs } = action.getSpec()

  for (const arg of getDockerBuildArgs(action.versionString(), buildArgs)) {
    args.push("--build-arg", arg)
  }

  if (targetStage) {
    args.push("--target", targetStage)
  }

  args.push(...(extraFlags || []))

  return args
}

export function getDockerBuildArgs(version: string, specBuildArgs: PrimitiveMap) {
  const buildArgs: PrimitiveMap = {
    GARDEN_MODULE_VERSION: version,
    GARDEN_BUILD_VERSION: version,
    ...specBuildArgs,
  }

  return Object.entries(buildArgs).map(([key, value]) => {
    // 0 is falsy
    if (value || value === 0) {
      return `${key}=${value}`
    } else {
      // If the value of a build-arg is null, Docker pulls it from
      // the environment: https://docs.docker.com/engine/reference/commandline/build/
      return key
    }
  })
}
