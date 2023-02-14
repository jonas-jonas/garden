/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { V1PodSpec } from "@kubernetes/client-node"
import { skopeoDaemonContainerName, dockerAuthSecretKey, k8sUtilImageName } from "../../constants"
import { KubeApi } from "../../api"
import { Log } from "../../../../logger/log-entry"
import { KubernetesProvider, KubernetesPluginContext, DEFAULT_KANIKO_IMAGE } from "../../config"
import { BuildError, ConfigurationError } from "../../../../exceptions"
import { PodRunner } from "../../run"
import { ensureNamespace, getNamespaceStatus, getSystemNamespace } from "../../namespace"
import { prepareSecrets } from "../../secrets"
import { dedent } from "../../../../util/string"
import { RunResult } from "../../../../plugin/base"
import { PluginContext } from "../../../../plugin-context"
import { KubernetesPod } from "../../types"
import {
  BuildStatusHandler,
  skopeoBuildStatus,
  BuildHandler,
  utilRsyncPort,
  syncToBuildSync,
  ensureBuilderSecret,
  commonSyncArgs,
  builderToleration,
  ensureUtilDeployment,
  utilDeploymentName,
} from "./common"
import { differenceBy, isEmpty } from "lodash"
import chalk from "chalk"
import { LogLevel } from "../../../../logger/logger"
import { getDockerBuildFlags } from "../../../container/build"
import { k8sGetContainerBuildActionOutputs } from "../handlers"
import { stringifyResources } from "../util"
import { makePodName } from "../../util"
import { defaultDockerfileName, ContainerBuildAction } from "../../../container/config"

export const DEFAULT_KANIKO_FLAGS = ["--cache=true"]

const sharedVolumeName = "comms"
const sharedMountPath = "/.garden"
const contextPath = sharedMountPath + "/context"

export const getKanikoBuildStatus: BuildStatusHandler = async (params) => {
  const { ctx, action, log } = params
  const k8sCtx = ctx as KubernetesPluginContext
  const provider = k8sCtx.provider

  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx, provider })).namespaceName

  await ensureUtilDeployment({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  return skopeoBuildStatus({
    namespace,
    deploymentName: utilDeploymentName,
    containerName: skopeoDaemonContainerName,
    log,
    api,
    ctx,
    provider,
    action,
  })
}

export const kanikoBuild: BuildHandler = async (params) => {
  const { ctx, action, log } = params
  const provider = <KubernetesProvider>ctx.provider
  const api = await KubeApi.factory(log, ctx, provider)

  const projectNamespace = (await getNamespaceStatus({ log, ctx, provider })).namespaceName

  const spec = action.getSpec()
  const outputs = k8sGetContainerBuildActionOutputs({ provider, action })

  const localId = outputs.localImageId
  const deploymentImageId = outputs.deploymentImageId
  const dockerfile = spec.dockerfile || defaultDockerfileName

  let { authSecret } = await ensureUtilDeployment({
    ctx,
    provider,
    log,
    api,
    namespace: projectNamespace,
  })

  await syncToBuildSync({
    ...params,
    ctx: ctx as KubernetesPluginContext,
    api,
    namespace: projectNamespace,
    deploymentName: utilDeploymentName,
  })

  log.info(`Building image ${localId}...`)

  // Use the project namespace by default
  let kanikoNamespace = provider.config.kaniko?.namespace || projectNamespace

  if (!kanikoNamespace) {
    kanikoNamespace = await getSystemNamespace(ctx, provider, log)
  }

  if (kanikoNamespace !== projectNamespace) {
    // Make sure the Kaniko Pod namespace has the auth secret ready
    const secretRes = await ensureBuilderSecret({
      provider,
      log: log.makeNewLogContext({}),
      api,
      namespace: kanikoNamespace,
    })

    authSecret = secretRes.authSecret
  }

  await ensureNamespace(api, { name: kanikoNamespace }, log)

  // Execute the build
  const args = [
    "--context",
    "dir://" + contextPath,
    "--dockerfile",
    dockerfile,
    "--destination",
    deploymentImageId,
    ...getKanikoFlags(spec.extraFlags, provider.config.kaniko?.extraFlags),
  ]

  if (provider.config.deploymentRegistry?.insecure === true) {
    // The in-cluster registry is not exposed, so we don't configure TLS on it.
    args.push("--insecure")
  }

  args.push(...getDockerBuildFlags(action))

  const buildRes = await runKaniko({
    ctx,
    provider,
    log,
    kanikoNamespace,
    utilNamespace: projectNamespace,
    authSecretName: authSecret.metadata.name,
    action,
    args,
  })

  const buildLog = buildRes.log

  if (kanikoBuildFailed(buildRes)) {
    throw new BuildError(`Failed building ${chalk.bold(action.name)}:\n\n${buildLog}`, { buildLog })
  }

  log.silly(buildLog)

  return {
    state: "ready",
    outputs,
    detail: {
      buildLog,
      fetched: false,
      fresh: true,
      outputs,
    },
  }
}

export const getKanikoFlags = (flags?: string[], topLevelFlags?: string[]): string[] => {
  if (!flags && !topLevelFlags) {
    return DEFAULT_KANIKO_FLAGS
  }
  const flagToKey = (flag: string) => {
    const found = flag.match(/--([a-zA-Z]*)/)
    if (found === null) {
      throw new ConfigurationError(`Invalid format for a kaniko flag`, { flag })
    }
    return found[0]
  }
  const defaultsToKeep = differenceBy(DEFAULT_KANIKO_FLAGS, flags || topLevelFlags || [], flagToKey)
  const topLevelToKeep = differenceBy(topLevelFlags || [], flags || [], flagToKey)
  return [...(flags || []), ...topLevelToKeep, ...defaultsToKeep]
}

export function kanikoBuildFailed(buildRes: RunResult) {
  return (
    !buildRes.success &&
    !(
      buildRes.log.includes("error pushing image: ") &&
      buildRes.log.includes("cannot be overwritten because the repository is immutable.")
    )
  )
}

interface RunKanikoParams {
  ctx: PluginContext
  provider: KubernetesProvider
  kanikoNamespace: string
  utilNamespace: string
  authSecretName: string
  log: Log
  action: ContainerBuildAction
  args: string[]
}

export function getKanikoBuilderPodManifest({
  provider,
  kanikoNamespace,
  authSecretName,
  syncArgs,
  imagePullSecrets,
  sourceUrl,
  podName,
  commandStr,
}: {
  provider: KubernetesProvider
  kanikoNamespace: string
  authSecretName: string
  syncArgs: string[]
  imagePullSecrets: {
    name: string
  }[]
  sourceUrl: string
  podName: string
  commandStr: string
}) {
  const kanikoImage = provider.config.kaniko?.image || DEFAULT_KANIKO_IMAGE
  const kanikoTolerations = [...(provider.config.kaniko?.tolerations || []), builderToleration]

  const spec: V1PodSpec = {
    shareProcessNamespace: true,
    volumes: [
      // Mount the docker auth secret, so Kaniko can pull from private registries.
      {
        name: authSecretName,
        secret: {
          secretName: authSecretName,
          items: [{ key: dockerAuthSecretKey, path: "config.json" }],
        },
      },
      // Mount a volume to communicate between the containers in the Pod.
      {
        name: sharedVolumeName,
        emptyDir: {},
      },
    ],
    imagePullSecrets,
    // Start by rsyncing the build context from the util deployment
    initContainers: [
      {
        name: "init",
        image: k8sUtilImageName,
        command: [
          "/bin/sh",
          "-c",
          dedent`
            echo "Copying from ${sourceUrl} to ${contextPath}"
            mkdir -p ${contextPath}
            n=0
            until [ "$n" -ge 30 ]
            do
              rsync ${syncArgs.join(" ")} && break
              n=$((n+1))
              sleep 1
            done
            echo "Done!"
          `,
        ],
        imagePullPolicy: "IfNotPresent",
        volumeMounts: [
          {
            name: sharedVolumeName,
            mountPath: sharedMountPath,
          },
        ],
      },
    ],
    containers: [
      {
        name: "kaniko",
        image: kanikoImage,
        command: ["sh", "-c", commandStr],
        volumeMounts: [
          {
            name: authSecretName,
            mountPath: "/kaniko/.docker",
            readOnly: true,
          },
          {
            name: sharedVolumeName,
            mountPath: sharedMountPath,
          },
        ],
        resources: stringifyResources(provider.config.resources.builder),
      },
    ],
    tolerations: kanikoTolerations,
  }

  const pod: KubernetesPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: kanikoNamespace,
      annotations: provider.config.kaniko?.annotations,
    },
    spec,
  }

  return pod
}

async function runKaniko({
  ctx,
  provider,
  kanikoNamespace,
  utilNamespace,
  authSecretName,
  log,
  action,
  args,
}: RunKanikoParams): Promise<RunResult> {
  const api = await KubeApi.factory(log, ctx, provider)

  const podName = makePodName("kaniko", action.name)

  // Escape the args so that we can safely interpolate them into the kaniko command
  const argsStr = args.map((arg) => JSON.stringify(arg)).join(" ")

  let commandStr = dedent`
    /kaniko/executor ${argsStr};
    export exitcode=$?;
    touch ${sharedMountPath}/done;
    exit $exitcode;
  `

  const utilHostname = `${utilDeploymentName}.${utilNamespace}.svc.cluster.local`
  const sourceUrl = `rsync://${utilHostname}:${utilRsyncPort}/volume/${ctx.workingCopyId}/${action.name}/`
  const imagePullSecrets = await prepareSecrets({
    api,
    namespace: kanikoNamespace,
    secrets: provider.config.imagePullSecrets,
    log,
  })

  const syncArgs = [...commonSyncArgs, sourceUrl, contextPath]

  const pod = getKanikoBuilderPodManifest({
    provider,
    podName,
    sourceUrl,
    syncArgs,
    imagePullSecrets,
    commandStr,
    kanikoNamespace,
    authSecretName,
  })

  // Set the configured nodeSelector, if any
  if (!isEmpty(provider.config.kaniko?.nodeSelector)) {
    pod.spec.nodeSelector = provider.config.kaniko?.nodeSelector
  }

  const logEventContext = {
    origin: "kaniko",
    log: log.makeNewLogContext({ level: LogLevel.verbose }),
  }

  const runner = new PodRunner({
    ctx,
    logEventContext,
    api,
    pod,
    provider,
    namespace: kanikoNamespace,
  })

  const timeoutSec = action.getConfig("timeout")

  const result = await runner.runAndWait({
    log,
    remove: true,
    events: ctx.events,
    timeoutSec,
    tty: false,
  })

  return result
}
