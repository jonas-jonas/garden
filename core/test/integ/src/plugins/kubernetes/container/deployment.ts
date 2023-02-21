/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { Garden } from "../../../../../../src/garden"
import { ConfigGraph } from "../../../../../../src/graph/config-graph"
import { KubeApi } from "../../../../../../src/plugins/kubernetes/api"
import {
  createContainerManifests,
  createWorkloadManifest,
} from "../../../../../../src/plugins/kubernetes/container/deployment"
import { KubernetesPluginContext, KubernetesProvider } from "../../../../../../src/plugins/kubernetes/config"
import { V1ConfigMap, V1Secret } from "@kubernetes/client-node"
import { KubernetesResource, KubernetesWorkload } from "../../../../../../src/plugins/kubernetes/types"
import { cloneDeep, keyBy } from "lodash"
import { getContainerTestGarden } from "./container"
import { DeployTask } from "../../../../../../src/tasks/deploy"
import { getServiceStatuses } from "../../../../../../src/tasks/helpers"
import { expectError, grouped } from "../../../../../helpers"
import { kilobytesToString, millicpuToString } from "../../../../../../src/plugins/kubernetes/util"
import { getDeployedImageId, getResourceRequirements } from "../../../../../../src/plugins/kubernetes/container/util"
import { isConfiguredForSyncMode } from "../../../../../../src/plugins/kubernetes/status/status"
import { ContainerDeployAction } from "../../../../../../src/plugins/container/moduleConfig"
import { apply } from "../../../../../../src/plugins/kubernetes/kubectl"
import { getAppNamespace } from "../../../../../../src/plugins/kubernetes/namespace"
import { gardenAnnotationKey } from "../../../../../../src/util/string"
import {
  k8sReverseProxyImageName,
  k8sSyncUtilImageName,
  PROXY_CONTAINER_SSH_TUNNEL_PORT,
  PROXY_CONTAINER_SSH_TUNNEL_PORT_NAME,
  PROXY_CONTAINER_USER_NAME,
} from "../../../../../../src/plugins/kubernetes/constants"
import {
  LocalModeEnv,
  LocalModeProcessRegistry,
  ProxySshKeystore,
} from "../../../../../../src/plugins/kubernetes/local-mode"
import stripAnsi = require("strip-ansi")
import { executeAction } from "../../../../../../src/graph/actions"

describe("kubernetes container deployment handlers", () => {
  let garden: Garden
  let graph: ConfigGraph
  let ctx: KubernetesPluginContext
  let provider: KubernetesProvider
  let api: KubeApi

  async function resolveDeployAction(name: string) {
    return await garden.resolveAction<ContainerDeployAction>({ action: graph.getDeploy(name), log: garden.log, graph })
  }

  beforeEach(async () => {
    graph = await garden.getConfigGraph({ log: garden.log, emit: false })
  })

  after(async () => {
    if (garden) {
      await garden.close()
    }
  })

  const init = async (environmentName: string) => {
    garden = await getContainerTestGarden(environmentName)
    provider = <KubernetesProvider>await garden.resolveProvider(garden.log, "local-kubernetes")
    ctx = <KubernetesPluginContext>(
      await garden.getPluginContext({ provider, templateContext: undefined, events: undefined })
    )
    api = await KubeApi.factory(garden.log, ctx, provider)
  }

  describe("createContainerManifests", () => {
    before(async () => {
      await init("local")
    })

    afterEach(async () => {
      LocalModeProcessRegistry.getInstance().shutdown()
      ProxySshKeystore.getInstance(garden.log).shutdown(garden.log)
    })

    function expectSshContainerPort(workload: KubernetesWorkload) {
      const appContainerSpec = workload.spec.template?.spec?.containers.find((c) => c.name === "local-mode")
      const workloadSshPort = appContainerSpec!.ports!.find((p) => p.name === PROXY_CONTAINER_SSH_TUNNEL_PORT_NAME)
      expect(workloadSshPort!.containerPort).to.eql(PROXY_CONTAINER_SSH_TUNNEL_PORT)
    }

    function expectEmptyContainerArgs(workload: KubernetesWorkload) {
      const appContainerSpec = workload.spec.template?.spec?.containers.find((c) => c.name === "local-mode")
      expect(appContainerSpec!.args).to.eql([])
    }

    function expectProxyContainerImage(workload: KubernetesWorkload) {
      const appContainerSpec = workload.spec.template?.spec?.containers.find((c) => c.name === "local-mode")
      expect(appContainerSpec!.image).to.eql(k8sReverseProxyImageName)
    }

    function expectContainerEnvVars(workload: KubernetesWorkload) {
      const appContainerSpec = workload.spec.template?.spec?.containers.find((c) => c.name === "local-mode")
      const env = appContainerSpec!.env!

      const httpPort = appContainerSpec!.ports!.find((p) => p.name === "http")!.containerPort.toString()
      const appPortEnvVar = env.find((v) => v.name === LocalModeEnv.GARDEN_REMOTE_CONTAINER_PORTS)!.value
      expect(appPortEnvVar).to.eql(httpPort)

      const proxyUserEnvVar = env.find((v) => v.name === LocalModeEnv.GARDEN_PROXY_CONTAINER_USER_NAME)!.value
      expect(proxyUserEnvVar).to.eql(PROXY_CONTAINER_USER_NAME)

      const publicKeyEnvVar = env.find((v) => v.name === LocalModeEnv.GARDEN_PROXY_CONTAINER_PUBLIC_KEY)!.value
      expect(!!publicKeyEnvVar).to.be.true
    }

    function expectNoProbes(workload: KubernetesWorkload) {
      const appContainerSpec = workload.spec.template?.spec?.containers.find((c) => c.name === "local-mode")
      expect(appContainerSpec!.livenessProbe).to.be.undefined
      expect(appContainerSpec!.readinessProbe).to.be.undefined
    }

    context("with localMode only", () => {
      it("Workflow should have ssh container port when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: false,
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectSshContainerPort(workload)
      })

      it("Workflow should have empty container args when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: false,
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectEmptyContainerArgs(workload)
      })

      it("Workflow should have extra env vars for proxy container when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: false,
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectContainerEnvVars(workload)
      })

      it("Workflow should not have liveness and readiness probes when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: false,
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectNoProbes(workload)
      })
    })

    context("localMode always takes precedence over syncMode", () => {
      it("Workflow should have ssh container port when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: true, // <----
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectSshContainerPort(workload)
      })

      it("Workflow should have proxy container image and empty container args when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: true, // <----
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectProxyContainerImage(workload)
        expectEmptyContainerArgs(workload)
      })

      it("Workflow should have extra env vars for proxy container when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: true, // <----
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectContainerEnvVars(workload)
      })

      it("Workflow should not have liveness and readiness probes when in local mode", async () => {
        const action = await resolveDeployAction("local-mode")

        const { workload } = await createContainerManifests({
          ctx,
          api,
          action,
          log: garden.log,
          imageId: getDeployedImageId(action, provider),
          enableSyncMode: true, // <----
          enableLocalMode: true, // <----
          blueGreen: false,
        })

        expectNoProbes(workload)
      })
    })
  })

  describe("createWorkloadManifest", () => {
    before(async () => {
      await init("local")
    })

    it("should create a basic Deployment resource", async () => {
      const action = await resolveDeployAction("simple-service")
      const namespace = provider.config.namespace!.name!

      const imageId = getDeployedImageId(action, provider)

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId,
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      const spec = action.getSpec()

      expect(resource).to.eql({
        kind: "Deployment",
        apiVersion: "apps/v1",
        metadata: {
          name: "simple-service",
          annotations: { "garden.io/configured.replicas": "1" },
          namespace,
          labels: { module: "simple-service", service: "simple-service" },
        },
        spec: {
          selector: { matchLabels: { service: "simple-service" } },
          template: {
            metadata: {
              annotations: {},
              labels: { module: "simple-service", service: "simple-service" },
            },
            spec: {
              containers: [
                {
                  name: "simple-service",
                  image: imageId,
                  command: ["sh", "-c", "echo Server running... && nc -l -p 8080"],
                  env: [
                    { name: "GARDEN_VERSION", value: action.getFullVersion().versionString },
                    { name: "GARDEN_MODULE_VERSION", value: "v-acd6a1dac7" },
                    { name: "POD_HOST_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
                    { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
                    { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
                    { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                    { name: "POD_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
                    { name: "POD_SERVICE_ACCOUNT", valueFrom: { fieldRef: { fieldPath: "spec.serviceAccountName" } } },
                    { name: "POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
                  ],
                  ports: [{ name: "http", protocol: "TCP", containerPort: 8080 }],
                  resources: getResourceRequirements({ cpu: spec.cpu, memory: spec.memory }),
                  imagePullPolicy: "IfNotPresent",
                  securityContext: { allowPrivilegeEscalation: false },
                },
              ],
              restartPolicy: "Always",
              terminationGracePeriodSeconds: 5,
              dnsPolicy: "ClusterFirst",
            },
          },
          replicas: 1,
          strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1, maxSurge: 1 } },
          revisionHistoryLimit: 3,
        },
      })
    })

    it("should attach service annotations to Pod template", async () => {
      const action = await resolveDeployAction("simple-service")
      const namespace = provider.config.namespace!.name!

      action.getSpec().annotations = { "annotation.key": "someValue" }

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(resource.spec.template?.metadata?.annotations).to.eql(action.getSpec().annotations)
    })

    it("should override max resources with limits if limits are specified", async () => {
      const action = await resolveDeployAction("simple-service")
      const namespace = provider.config.namespace!.name!

      const limits = {
        cpu: 123,
        memory: 321,
      }

      action.getSpec().limits = limits

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(resource.spec.template?.spec?.containers[0].resources?.limits).to.eql({
        cpu: millicpuToString(limits.cpu),
        memory: kilobytesToString(limits.memory * 1024),
      })
    })

    it("should apply security context fields if specified", async () => {
      const action = await resolveDeployAction("simple-service")
      const namespace = provider.config.namespace!.name!
      action.getSpec().privileged = true
      action.getSpec().addCapabilities = ["SYS_TIME"]
      action.getSpec().dropCapabilities = ["NET_ADMIN"]

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(resource.spec.template?.spec?.containers[0].securityContext).to.eql({
        allowPrivilegeEscalation: true,
        privileged: true,
        capabilities: {
          add: ["SYS_TIME"],
          drop: ["NET_ADMIN"],
        },
      })
    })

    it("should configure the service for sync with sync mode enabled", async () => {
      const action = await resolveDeployAction("sync-mode")
      await executeAction({ garden, graph, log: garden.log, action })
      const namespace = provider.config.namespace!.name!

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: true, // <----
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(isConfiguredForSyncMode(resource)).to.eq(true)

      const initContainer = resource.spec.template?.spec?.initContainers![0]
      expect(initContainer).to.exist
      expect(initContainer!.name).to.eq("garden-dev-init")
      expect(initContainer!.volumeMounts).to.exist
      expect(initContainer!.volumeMounts![0]).to.eql({ name: "garden", mountPath: "/.garden" })

      expect(resource.spec.template?.spec?.initContainers).to.eql([
        {
          name: "garden-dev-init",
          image: k8sSyncUtilImageName,
          command: ["/bin/sh", "-c", "cp /usr/local/bin/mutagen-agent /.garden/mutagen-agent"],
          imagePullPolicy: "IfNotPresent",
          volumeMounts: [
            {
              name: "garden",
              mountPath: "/.garden",
            },
          ],
        },
      ])

      const appContainerSpec = resource.spec.template?.spec?.containers.find((c) => c.name === "sync-mode")
      expect(appContainerSpec!.volumeMounts).to.exist
      expect(appContainerSpec!.volumeMounts![0]!.name).to.eq("garden")
    })

    it("should configure the service for sync with sync mode enabled", async () => {
      const action = await resolveDeployAction("sync-mode")
      await executeAction({ garden, graph, log: garden.log, action })
      const namespace = provider.config.namespace!.name!

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: true, // <----
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      const appContainerSpec = resource.spec.template?.spec?.containers.find((c) => c.name === "sync-mode")
      expect(appContainerSpec!.livenessProbe).to.eql({
        initialDelaySeconds: 90,
        periodSeconds: 10,
        timeoutSeconds: 3,
        successThreshold: 1,
        failureThreshold: 30,
        exec: {
          command: ["echo", "ok"],
        },
      })
    })

    it("should name the Deployment with a version suffix and set a version label if blueGreen=true", async () => {
      const action = await resolveDeployAction("simple-service")
      const namespace = provider.config.namespace!.name!

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: true,
      })

      const version = action.versionString()

      expect(resource.metadata.name).to.equal("simple-service-" + version)
      expect(resource.metadata.labels).to.eql({
        "module": "simple-service",
        "service": "simple-service",
        "garden.io/version": version,
      })
      expect(resource.spec.selector.matchLabels).to.eql({ "service": "simple-service", "garden.io/version": version })
    })

    it("should copy and reference imagePullSecrets with docker basic auth", async () => {
      const action = await resolveDeployAction("simple-service")
      const secretName = "test-docker-auth"

      const authSecret: KubernetesResource<V1Secret> = {
        apiVersion: "v1",
        kind: "Secret",
        type: "kubernetes.io/dockerconfigjson",
        metadata: {
          name: secretName,
          namespace: "default",
        },
        stringData: {
          ".dockerconfigjson": JSON.stringify({ auths: {} }),
        },
      }
      await api.upsert({ kind: "Secret", namespace: "default", obj: authSecret, log: garden.log })

      const namespace = provider.config.namespace!.name!
      const _provider = cloneDeep(provider)
      _provider.config.imagePullSecrets = [{ name: secretName, namespace: "default" }]

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider: _provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      const copiedSecret = await api.core.readNamespacedSecret(secretName, namespace)
      expect(copiedSecret).to.exist
      expect(resource.spec.template?.spec?.imagePullSecrets).to.eql([{ name: secretName }])
    })

    it("should copy and reference imagePullSecrets with docker credential helper", async () => {
      const action = await resolveDeployAction("simple-service")
      const secretName = "test-cred-helper-auth"

      const authSecret: KubernetesResource<V1Secret> = {
        apiVersion: "v1",
        kind: "Secret",
        type: "kubernetes.io/dockerconfigjson",
        metadata: {
          name: secretName,
          namespace: "default",
        },
        stringData: {
          ".dockerconfigjson": JSON.stringify({ credHelpers: {} }),
        },
      }
      await api.upsert({ kind: "Secret", namespace: "default", obj: authSecret, log: garden.log })

      const namespace = provider.config.namespace!.name!
      const _provider = cloneDeep(provider)
      _provider.config.imagePullSecrets = [{ name: secretName, namespace: "default" }]

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider: _provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      const copiedSecret = await api.core.readNamespacedSecret(secretName, namespace)
      expect(copiedSecret).to.exist
      expect(resource.spec.template?.spec?.imagePullSecrets).to.eql([{ name: secretName }])
    })

    it("should correctly mount a referenced PVC module", async () => {
      const action = await resolveDeployAction("volume-reference")
      const namespace = provider.config.namespace!.name!

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(resource.spec.template?.spec?.volumes).to.eql([
        { name: "test", persistentVolumeClaim: { claimName: "volume-module" } },
      ])
      expect(resource.spec.template?.spec?.containers[0].volumeMounts).to.eql([{ name: "test", mountPath: "/volume" }])
    })

    it("should correctly mount a referenced ConfigMap module", async () => {
      const action = await resolveDeployAction("configmap-reference")
      const namespace = provider.config.namespace!.name!

      const resource = await createWorkloadManifest({
        ctx,
        api,
        provider,
        action,
        imageId: getDeployedImageId(action, provider),
        namespace,
        enableSyncMode: false,
        enableLocalMode: false,
        log: garden.log,
        production: false,
        blueGreen: false,
      })

      expect(resource.spec.template?.spec?.volumes).to.eql([
        {
          name: "test",
          configMap: {
            name: {
              kind: "Deploy",
              name: "configmap-module",
            },
          },
        },
      ])
      expect(resource.spec.template?.spec?.containers[0].volumeMounts).to.eql([{ name: "test", mountPath: "/config" }])
    })

    it("should throw if incompatible module is specified as a volume module", async () => {
      const action = await resolveDeployAction("volume-reference")
      const namespace = provider.config.namespace!.name!

      action.getSpec().volumes = [
        { name: "test", containerPath: "TODO-G2", action: { name: "simple-service", kind: "Deploy" } },
      ]

      await expectError(
        () =>
          createWorkloadManifest({
            ctx,
            api,
            provider,
            action,
            imageId: getDeployedImageId(action, provider),
            namespace,
            enableSyncMode: false,
            enableLocalMode: false,
            log: garden.log,
            production: false,
            blueGreen: false,
          }),
        (err) =>
          expect(stripAnsi(err.message)).to.equal(
            "Container module volume-reference specifies a unsupported module simple-service for volume mount test. Only `persistentvolumeclaim` and `configmap` modules are supported at this time."
          )
      )
    })
  })

  describe("deployContainerService", () => {
    context("local mode", () => {
      before(async () => {
        await init("local")
      })

      it("should deploy a simple service", async () => {
        const action = await resolveDeployAction("simple-service")

        const deployTask = new DeployTask({
          garden,
          graph,
          log: garden.log,
          action,
          force: true,
          forceBuild: false,

          syncModeDeployNames: [],

          localModeDeployNames: [],
        })

        const results = await garden.processTasks({ tasks: [deployTask], log: garden.log, throwOnError: true })
        const statuses = getServiceStatuses(results.results)
        const status = statuses[action.name]
        const resources = keyBy(status.detail?.detail["remoteResources"], "kind")
        expect(resources.Deployment.metadata.annotations["garden.io/version"]).to.equal(`${action.versionString()}`)
        expect(resources.Deployment.spec.template.spec.containers[0].image).to.equal(
          `${action.name}:${action.getBuildAction()?.versionString()}`
        )
        expect(status.detail?.namespaceStatuses).to.eql([
          {
            pluginName: "local-kubernetes",
            namespaceName: "container-default",
            state: "ready",
          },
        ])
      })

      it("should prune previously applied resources when deploying", async () => {
        const log = garden.log
        const action = await resolveDeployAction("simple-service")
        const namespace = await getAppNamespace(ctx, log, provider)

        const mapToNotPruneKey = "should-not-be-pruned"
        const mapToPruneKey = "should-be-pruned"

        const labels = { [gardenAnnotationKey("service")]: action.name }

        // This `ConfigMap` is created through `kubectl apply` below, which will add the
        // "kubectl.kubernetes.io/last-applied-configuration" annotation. We don't prune resources that lack this
        // annotation.
        const configMapToPrune: KubernetesResource<V1ConfigMap> = {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: mapToPruneKey,
            annotations: { ...labels },
            labels: { ...labels },
          },
          data: {},
        }

        await apply({ log, ctx, api, provider, manifests: [configMapToPrune], namespace })

        // Here, we create via the k8s API (not `kubetl apply`), so that unlike `configMapToPrune`, it won't acquire
        // the "last applied" annotation. This means that it should *not* be pruned when we deploy the service, even
        // though it has the service's label.
        await api.core.createNamespacedConfigMap(namespace, {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: mapToNotPruneKey,
            annotations: { ...labels },
            labels: { ...labels },
          },
          data: {},
        })

        const deployTask = new DeployTask({
          garden,
          graph,
          log,
          action,
          force: true,
          forceBuild: false,

          syncModeDeployNames: [],
          localModeDeployNames: [],
        })

        await garden.processTasks({ tasks: [deployTask], log: garden.log, throwOnError: true })

        // We expect this `ConfigMap` to still exist.
        await api.core.readNamespacedConfigMap(mapToNotPruneKey, namespace)

        // ...and we expect this `ConfigMap` to have been deleted.
        await expectError(
          () => api.core.readNamespacedConfigMap(mapToPruneKey, namespace),
          (err) => {
            expect(stripAnsi(err.message)).to.match(
              /Got error from Kubernetes API \(readNamespacedConfigMap\) - configmaps "should-be-pruned" not found/
            )
          }
        )

        await api.core.deleteNamespacedConfigMap(mapToNotPruneKey, namespace)
      })

      it("should ignore empty env vars in status check comparison", async () => {
        const action = await resolveDeployAction("simple-service")
        action.getSpec().env = {
          FOO: "banana",
          BAR: "",
          BAZ: null,
        }

        const deployTask = new DeployTask({
          garden,
          graph,
          log: garden.log,
          action,
          force: true,
          forceBuild: false,

          syncModeDeployNames: [],
          localModeDeployNames: [],
        })

        const results = await garden.processTasks({ tasks: [deployTask], log: garden.log, throwOnError: true })
        const statuses = getServiceStatuses(results.results)
        const status = statuses[action.name]
        expect(status.state).to.eql("ready")
      })

      it("should deploy a service referencing a volume module", async () => {
        const action = await resolveDeployAction("volume-reference")

        const deployTask = new DeployTask({
          garden,
          graph,
          log: garden.log,
          action,
          force: true,
          forceBuild: false,

          syncModeDeployNames: [],
          localModeDeployNames: [],
        })

        const results = await garden.processTasks({ tasks: [deployTask], log: garden.log, throwOnError: true })
        const statuses = getServiceStatuses(results.results)
        const status = statuses[action.name]
        const resources = keyBy(status.detail?.detail["remoteResources"], "kind")

        expect(status.state === "ready")
        expect(resources.Deployment.spec.template.spec.volumes).to.eql([
          { name: "test", persistentVolumeClaim: { claimName: "volume-module" } },
        ])
        expect(resources.Deployment.spec.template.spec.containers[0].volumeMounts).to.eql([
          { name: "test", mountPath: "/volume" },
        ])
      })
    })

    grouped("kaniko", "remote-only").context("kaniko", () => {
      before(async () => {
        await init("kaniko")
      })

      it("should deploy a simple service", async () => {
        const action = await resolveDeployAction("remote-registry-test")

        const deployTask = new DeployTask({
          garden,
          graph,
          log: garden.log,
          action,
          force: true,
          forceBuild: false,

          syncModeDeployNames: [],
          localModeDeployNames: [],
        })

        const results = await garden.processTasks({ tasks: [deployTask], log: garden.log, throwOnError: true })
        const statuses = getServiceStatuses(results.results)
        const status = statuses[action.name]
        const resources = keyBy(status.detail?.detail["remoteResources"], "kind")
        expect(resources.Deployment.spec.template.spec.containers[0].image).to.equal(
          `index.docker.io/gardendev/${action.name}:${action.versionString()}`
        )
      })
    })
  })
})
