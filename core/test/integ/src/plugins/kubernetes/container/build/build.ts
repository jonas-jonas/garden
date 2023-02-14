/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expectError, grouped } from "../../../../../../helpers"
import { Garden } from "../../../../../../../src/garden"
import { ConfigGraph } from "../../../../../../../src/graph/config-graph"
import {
  k8sBuildContainer,
  k8sGetContainerBuildStatus,
} from "../../../../../../../src/plugins/kubernetes/container/build/build"
import { PluginContext } from "../../../../../../../src/plugin-context"
import { KubernetesProvider } from "../../../../../../../src/plugins/kubernetes/config"
import { expect } from "chai"
import { getContainerTestGarden } from "../container"
import { containerHelpers } from "../../../../../../../src/plugins/container/helpers"
import { k8sPublishContainerBuild } from "../../../../../../../src/plugins/kubernetes/container/publish"
import { Log } from "../../../../../../../src/logger/log-entry"
import { cloneDeep } from "lodash"
import { ContainerBuildAction } from "../../../../../../../src/plugins/container/config"

describe("kubernetes build flow", () => {
  let garden: Garden
  let log: Log
  let graph: ConfigGraph
  let provider: KubernetesProvider
  let ctx: PluginContext
  let currentEnv: string

  const builtImages: { [key: string]: any } = {}

  after(async () => {
    if (garden) {
      await garden.close()
    }
  })

  const init = async (environmentName: string) => {
    currentEnv = environmentName
    garden = await getContainerTestGarden(environmentName)
    log = garden.log
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
    provider = <KubernetesProvider>await garden.resolveProvider(garden.log, "local-kubernetes")
    ctx = await garden.getPluginContext({ provider, templateContext: undefined, events: undefined })
  }

  async function resolveBuildImageAction(buildActionName: string) {
    const buildAction = cloneDeep(graph.getBuild(buildActionName))
    const key = `${currentEnv}.${buildAction.name}.${buildAction.versionString()}`

    if (!!builtImages[key]) {
      return builtImages[key]
    }

    await garden.buildStaging.syncFromSrc(buildAction, garden.log)

    const resolvedBuildAction = await garden.resolveAction<ContainerBuildAction>({
      action: buildAction,
      log: garden.log,
      graph,
    })

    await k8sBuildContainer({
      ctx,
      log,
      action: resolvedBuildAction,
    })

    builtImages[key] = true

    return resolvedBuildAction
  }

  context("local mode", () => {
    before(async () => {
      await init("local")
    })

    it("should build a simple container", async () => {
      await resolveBuildImageAction("simple-service")
    })
  })

  grouped("remote-only").context("local-remote-registry mode", () => {
    before(async () => {
      await init("local-remote-registry")
    })

    it("should push to configured deploymentRegistry if specified", async () => {
      const action = await resolveBuildImageAction("remote-registry-test")

      const remoteId = action._outputs["deployment-image-id"]
      // This throws if the image doesn't exist
      await containerHelpers.dockerCli({
        cwd: action.getBuildPath(),
        args: ["manifest", "inspect", remoteId],
        log,
        ctx,
      })
    })

    it("should get the build status from the deploymentRegistry", async () => {
      const action = await resolveBuildImageAction("remote-registry-test")

      const remoteId = action._outputs["deployment-image-id"]

      await containerHelpers.dockerCli({
        cwd: action.getBuildPath(),
        args: ["rmi", remoteId],
        log,
        ctx,
      })
      builtImages[`${currentEnv}.${action.name}.${action.versionString()}`] = false

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action,
      })

      expect(status.state).to.equal("ready")
    })

    context("publish handler", () => {
      it("should publish the built image", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:" + action.versionString())
      })

      it("should set custom tag if specified", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
          tag: "foo",
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:foo")
      })
    })
  })

  grouped("kaniko", "remote-only").context("kaniko-project-namespace mode", () => {
    before(async () => {
      await init("kaniko-project-namespace")
    })

    it("should build a simple container", async () => {
      await resolveBuildImageAction("simple-service")
    })

    it("should get the build status from the registry", async () => {
      const action = await resolveBuildImageAction("simple-service")

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action,
      })

      expect(status.state).to.equal("ready")
    })
  })

  grouped("kaniko", "remote-only").context("kaniko", () => {
    before(async () => {
      await init("kaniko-remote-registry")
    })

    it("should build and push to configured deploymentRegistry", async () => {
      await resolveBuildImageAction("remote-registry-test")
    })

    it("should get the build status from the registry", async () => {
      const action = await resolveBuildImageAction("remote-registry-test")

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action,
      })

      expect(status.state).to.equal("ready")
    })

    it("should return ready=false status when image doesn't exist in registry", async () => {
      const action = cloneDeep(graph.getBuild("remote-registry-test"))
      await garden.buildStaging.syncFromSrc(action, garden.log)

      action.getFullVersion().versionString = "v-0000000000"

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
      })

      expect(status.state).to.equal("not-ready")
    })

    grouped("remote-only").it("should support pulling from private registries", async () => {
      await resolveBuildImageAction("private-base")
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const action = graph.getBuild("inaccessible-base")
      await garden.buildStaging.syncFromSrc(action, garden.log)

      await expectError(
        async () =>
          k8sBuildContainer({
            ctx,
            log,
            action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
          }),
        (err) => {
          expect(err.message).to.include("UNAUTHORIZED")
        }
      )
    })

    context("publish handler", () => {
      it("should publish the built image", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:" + action.versionString())
      })

      it("should set custom tag if specified", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
          tag: "foo",
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:foo")
      })
    })
  })

  grouped("kaniko", "image-override", "remote-only").context("kaniko - image - override mode", () => {
    before(async () => {
      await init("kaniko-image-override")
    })

    it("should push to configured deploymentRegistry if specified", async () => {
      await resolveBuildImageAction("remote-registry-test")
    })
  })

  // TODO: Reenable these tests e.g. for Minikube?
  grouped("cluster-buildkit", "remote-only").context("cluster-buildkit mode", () => {
    before(async () => {
      await init("cluster-buildkit")
    })

    it("should build and push a simple container", async () => {
      await resolveBuildImageAction("simple-service")
    })

    it("should get the build status from the registry", async () => {
      const action = await resolveBuildImageAction("simple-service")

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action,
      })

      expect(status.state).to.equal("ready")
    })

    it("should support pulling from private registries", async () => {
      await resolveBuildImageAction("private-base")
    })

    it("should return ready=false status when image doesn't exist in registry", async () => {
      const action = graph.getBuild("simple-service")
      await garden.buildStaging.syncFromSrc(action, garden.log)

      action.getConfig().spec.image = "skee-ba-dee-skoop"

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
      })

      expect(status.state).to.equal("not-ready")
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const action = graph.getBuild("inaccessible-base")
      await garden.buildStaging.syncFromSrc(action, garden.log)

      await expectError(
        async () =>
          k8sBuildContainer({
            ctx,
            log,
            action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
          }),
        (err) => {
          expect(err.message).to.include("authorization failed")
        }
      )
    })

    context("publish handler", () => {
      it("should publish the built image", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:" + action.versionString())
      })

      it("should set custom tag if specified", async () => {
        const action = await resolveBuildImageAction("remote-registry-test")

        const result = await k8sPublishContainerBuild({
          ctx,
          action,
          log,
          tag: "foo",
        })

        expect(result.detail?.message).to.eql("Published gardendev/remote-registry-test:foo")
      })
    })
  })

  // TODO: Reenable these tests e.g. for Minikube?
  grouped("cluster-buildkit", "remote-only").context("cluster-buildkit-rootless mode", () => {
    before(async () => {
      await init("cluster-buildkit-rootless")
    })

    it("should build a simple container", async () => {
      await resolveBuildImageAction("simple-service")
    })

    it("should get the build status from the registry", async () => {
      const action = await resolveBuildImageAction("simple-service")

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action,
      })

      expect(status.state).to.equal("ready")
    })

    grouped("remote-only").it("should support pulling from private registries", async () => {
      await resolveBuildImageAction("private-base")
    })

    it("should return ready=false status when image doesn't exist in registry", async () => {
      const action = graph.getBuild("simple-service")
      await garden.buildStaging.syncFromSrc(action, garden.log)

      action.getConfig().spec.image = "skee-ba-dee-skoop"

      const status = await k8sGetContainerBuildStatus({
        ctx,
        log,
        action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
      })

      expect(status.state).to.equal("not-ready")
    })

    it("should throw if attempting to pull from private registry without access", async () => {
      const action = graph.getBuild("inaccessible-base")
      await garden.buildStaging.syncFromSrc(action, garden.log)

      await expectError(
        async () =>
          k8sBuildContainer({
            ctx,
            log,
            action: await garden.resolveAction<ContainerBuildAction>({ action, log: garden.log, graph }),
          }),
        (err) => {
          expect(err.message).to.include("authorization failed")
        }
      )
    })
  })
})
