/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import td from "testdouble"

import { PluginContext } from "../../../../../src/plugin-context"
import {
  gardenPlugin,
  ContainerProvider,
  convertContainerModule,
  configureContainerModule,
} from "../../../../../src/plugins/container/container"
import { expectError, getDataDir, makeTestGarden, TestGarden } from "../../../../helpers"
import { Log } from "../../../../../src/logger/log-entry"
import { ConfigGraph } from "../../../../../src/graph/config-graph"
import { GardenModule, moduleFromConfig } from "../../../../../src/types/module"
import { expect } from "chai"
import {
  ContainerBuildActionSpec,
  ContainerModule,
  ContainerModuleConfig,
  defaultContainerResources,
  defaultDeploymentStrategy,
  defaultDockerfileName,
} from "../../../../../src/plugins/container/moduleConfig"
import { ExecBuildConfig } from "../../../../../src/plugins/exec/config"
import { DEFAULT_BUILD_TIMEOUT } from "../../../../../src/plugins/container/helpers"
import { DEFAULT_API_VERSION } from "../../../../../src/constants"
import { resolve } from "path"
// import { DEFAULT_API_VERSION } from "../../../../../src/constants"
// import { ContainerModuleConfig, defaultContainerResources } from "../../../../../src/plugins/container/moduleConfig"
// import { DEFAULT_BUILD_TIMEOUT } from "../../../../../src/plugins/container/helpers"

describe("plugins.container", () => {
  const projectRoot = getDataDir("test-project-container")
  const modulePath = resolve(projectRoot, "module-a")

  const defaultCpu = defaultContainerResources.cpu
  const defaultMemory = defaultContainerResources.memory

  const baseConfig: ContainerModuleConfig = {
    allowPublish: false,
    build: {
      dependencies: [],
    },
    disabled: false,
    apiVersion: DEFAULT_API_VERSION,
    name: "test",
    path: modulePath,
    type: "container",

    spec: {
      build: {
        timeout: DEFAULT_BUILD_TIMEOUT,
      },
      buildArgs: {},
      extraFlags: [],
      services: [],
      tasks: [],
      tests: [],
    },

    serviceConfigs: [],
    taskConfigs: [],
    testConfigs: [],
  }

  let garden: TestGarden
  let ctx: PluginContext
  let log: Log
  let containerProvider: ContainerProvider
  let graph: ConfigGraph

  beforeEach(async () => {
    garden = await makeTestGarden(projectRoot, { plugins: [gardenPlugin()] })
    log = garden.log
    containerProvider = await garden.resolveProvider(garden.log, "container")
    ctx = await garden.getPluginContext({ provider: containerProvider, templateContext: undefined, events: undefined })
    graph = await garden.getConfigGraph({ log, emit: false })
    td.replace(garden.buildStaging, "syncDependencyProducts", () => null)
  })

  it("TODO-G2", () => {
    throw "TODO-G2 (all tests need updating)"
  })

  describe("convertContainerModule", () => {
    const getModuleConvertBaseParams = (module: GardenModule) => ({
      baseFields: {
        copyFrom: [],
        disabled: false,
        internal: {
          basePath: "module-a",
        },
      },
      convertBuildDependency: () => "buildDep",
      convertRuntimeDependencies: () => ["runtimeDep"],
      convertTestName: () => "testName",
      ctx,
      dummyBuild: undefined,
      log,
      module,
      prepareRuntimeDependencies: () => ["preopRuntimeDep"],
      services: [],
      tasks: [],
      tests: [],
    })
    it("creates a Build action if there is a Dockerfile detected", async () => {
      const module = graph.getModule("module-a")
      const result = await convertContainerModule(getModuleConvertBaseParams(module))
      const build = result.group.actions.find((a) => a.kind === "Build")!
      expect(build).to.exist
      expect(build.type).to.be.eql("container")
    })

    it("creates a Build action if there is a Dockerfile explicitly configured", async () => {
      const module = graph.getModule("module-a") as ContainerModule
      module._config.spec.dockerfile = "Dockerfile"
      const result = await convertContainerModule(getModuleConvertBaseParams(module))
      const build = result.group.actions.find((a) => a.kind === "Build")!
      expect(build).to.exist
      expect(build.type).to.be.eql("container")
    })

    it("returns the dummy Build action if no Dockerfile and an exec Build is needed", async () => {
      const module = graph.getModule("module-a") as ContainerModule
      module.version.files.pop() // remove automatically picked up Dockerfile
      const dummyBuild: ExecBuildConfig = {
        internal: {
          basePath: ".",
        },
        kind: "Build",
        name: "dummyBuild",
        spec: {
          env: {},
        },
        type: "exec",
      }
      const result = await convertContainerModule({ ...getModuleConvertBaseParams(module), dummyBuild })
      const build = result.group.actions.find((a) => a.kind === "Build")!
      expect(build).to.exist
      expect(build.type).to.be.eql("exec")
      expect(build.name).to.be.eql("dummyBuild")
    })

    it("sets spec.localId from module image field", async () => {
      const module = graph.getModule("module-a") as ContainerModule
      module.spec.image = "customImage"
      const result = await convertContainerModule(getModuleConvertBaseParams(module))
      const build = result.group.actions.find((a) => a.kind === "Build")!
      expect(build).to.exist
      expect(build.type).to.be.eql("container")
      expect((<ContainerBuildActionSpec>build.spec).localId).to.be.eql("customImage")
    })
  })

  describe("version calculations", () => {
    async function getTestModule(moduleConfig: ContainerModuleConfig) {
      return moduleFromConfig({ garden, log, config: moduleConfig, buildDependencies: [], forceVersion: true })
    }

    it("has same build version if nothing is changed", async () => {
      const baseModule = await getTestModule(baseConfig)
      const baseModule2 = await getTestModule(baseConfig)

      expect(baseModule.version.versionString).to.equal(baseModule2.version.versionString)
    })

    it("has different build version if buildArgs are added", async () => {
      const baseModule = await getTestModule(baseConfig)
      const changedBuild = await getTestModule({
        ...baseConfig,
        spec: {
          ...baseConfig.spec,
          buildArgs: { foo: "bar" },
        },
      })
      expect(baseModule.version.versionString).to.not.equal(changedBuild.version.versionString)
    })

    it("has different build version if a targetImage is set", async () => {
      const baseModule = await getTestModule(baseConfig)
      const changedBuild = await getTestModule({
        ...baseConfig,
        spec: {
          ...baseConfig.spec,
          build: {
            ...baseConfig.spec.build,
            targetImage: "foo",
          },
        },
      })
      expect(baseModule.version.versionString).to.not.equal(changedBuild.version.versionString)
    })

    it("has different build version if extraFlags are added", async () => {
      const baseModule = await getTestModule(baseConfig)
      const changedBuild = await getTestModule({
        ...baseConfig,
        spec: {
          ...baseConfig.spec,
          extraFlags: ["foo"],
        },
      })
      expect(baseModule.version.versionString).to.not.equal(changedBuild.version.versionString)
    })

    it("has different build version if dockerfile is changed", async () => {
      const baseModule = await getTestModule(baseConfig)
      const changedBuild = await getTestModule({
        ...baseConfig,
        spec: {
          ...baseConfig.spec,
          dockerfile: "foo.Dockerfile",
        },
      })
      expect(baseModule.version.versionString).to.not.equal(changedBuild.version.versionString)
    })
  })

  //   describe("convert", () => {
  //     // TODO-G2: adapt from exec convert tests
  //     it("TODO", () => {
  //       throw "TODO"
  //     })
  //   })

  describe("configureContainerModule", () => {
    const containerModuleConfig: ContainerModuleConfig = {
      allowPublish: false,
      build: {
        dependencies: [],
      },
      disabled: false,
      apiVersion: DEFAULT_API_VERSION,
      name: "module-a",
      path: modulePath,
      type: "container",

      spec: {
        build: {
          timeout: DEFAULT_BUILD_TIMEOUT,
        },
        buildArgs: {},
        extraFlags: [],
        services: [
          {
            name: "service-a",
            annotations: {},
            args: ["echo"],
            dependencies: [],
            daemon: false,
            disabled: false,
            ingresses: [
              {
                annotations: {},
                path: "/",
                port: "http",
              },
            ],
            env: {
              SOME_ENV_VAR: "value",
            },
            healthCheck: {
              httpGet: {
                path: "/health",
                port: "http",
              },
              livenessTimeoutSeconds: 10,
              readinessTimeoutSeconds: 10,
            },
            limits: {
              cpu: 123,
              memory: 456,
            },
            cpu: defaultCpu,
            memory: defaultMemory,
            ports: [
              {
                name: "http",
                protocol: "TCP",
                containerPort: 8080,
                servicePort: 8080,
              },
            ],
            replicas: 1,
            volumes: [],
            deploymentStrategy: defaultDeploymentStrategy,
          },
        ],
        tasks: [
          {
            name: "task-a",
            args: ["echo", "OK"],
            artifacts: [],
            cacheResult: true,
            dependencies: [],
            disabled: false,
            env: {
              TASK_ENV_VAR: "value",
            },
            cpu: defaultCpu,
            memory: defaultMemory,
            timeout: null,
            volumes: [],
          },
        ],
        tests: [
          {
            name: "unit",
            args: ["echo", "OK"],
            artifacts: [],
            dependencies: [],
            disabled: false,
            env: {
              TEST_ENV_VAR: "value",
            },
            cpu: defaultCpu,
            memory: defaultMemory,
            timeout: null,
            volumes: [],
          },
        ],
      },

      serviceConfigs: [],
      taskConfigs: [],
      testConfigs: [],
    }

    it("should validate and parse a container module", async () => {
      const result = await configureContainerModule({ ctx, moduleConfig: containerModuleConfig, log })

      expect(result).to.eql({
        moduleConfig: {
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          apiVersion: DEFAULT_API_VERSION,
          name: "module-a",
          include: [defaultDockerfileName],
          path: modulePath,
          type: "container",
          spec: {
            build: {
              timeout: DEFAULT_BUILD_TIMEOUT,
            },
            buildArgs: {},
            extraFlags: [],
            services: [
              {
                name: "service-a",
                annotations: {},
                args: ["echo"],
                dependencies: [],
                disabled: false,
                daemon: false,
                ingresses: [
                  {
                    annotations: {},
                    path: "/",
                    port: "http",
                  },
                ],
                env: {
                  SOME_ENV_VAR: "value",
                },
                healthCheck: {
                  httpGet: { path: "/health", port: "http" },
                  readinessTimeoutSeconds: 10,
                  livenessTimeoutSeconds: 10,
                },
                limits: {
                  cpu: 123,
                  memory: 456,
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                ports: [{ name: "http", protocol: "TCP", containerPort: 8080, servicePort: 8080 }],
                replicas: 1,
                volumes: [],
                deploymentStrategy: defaultDeploymentStrategy,
              },
            ],
            tasks: [
              {
                name: "task-a",
                args: ["echo", "OK"],
                artifacts: [],
                cacheResult: true,
                dependencies: [],
                disabled: false,
                env: {
                  TASK_ENV_VAR: "value",
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                timeout: null,
                volumes: [],
              },
            ],
            tests: [
              {
                name: "unit",
                args: ["echo", "OK"],
                artifacts: [],
                dependencies: [],
                disabled: false,
                env: {
                  TEST_ENV_VAR: "value",
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                timeout: null,
                volumes: [],
              },
            ],
          },
          buildConfig: {
            buildArgs: {},
            dockerfile: undefined,
            extraFlags: [],
            targetImage: undefined,
          },
          serviceConfigs: [
            {
              name: "service-a",
              dependencies: [],
              disabled: false,

              spec: {
                name: "service-a",
                annotations: {},
                args: ["echo"],
                dependencies: [],
                disabled: false,
                daemon: false,
                ingresses: [
                  {
                    annotations: {},
                    path: "/",
                    port: "http",
                  },
                ],
                env: {
                  SOME_ENV_VAR: "value",
                },
                healthCheck: {
                  httpGet: { path: "/health", port: "http" },
                  readinessTimeoutSeconds: 10,
                  livenessTimeoutSeconds: 10,
                },
                limits: {
                  cpu: 123,
                  memory: 456,
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                ports: [{ name: "http", protocol: "TCP", containerPort: 8080, servicePort: 8080 }],
                replicas: 1,
                volumes: [],
                deploymentStrategy: defaultDeploymentStrategy,
              },
            },
          ],
          taskConfigs: [
            {
              cacheResult: true,
              dependencies: [],
              disabled: false,
              name: "task-a",
              spec: {
                args: ["echo", "OK"],
                artifacts: [],
                cacheResult: true,
                dependencies: [],
                disabled: false,
                env: {
                  TASK_ENV_VAR: "value",
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                name: "task-a",
                timeout: null,
                volumes: [],
              },
              timeout: null,
            },
          ],
          testConfigs: [
            {
              name: "unit",
              dependencies: [],
              disabled: false,
              spec: {
                name: "unit",
                args: ["echo", "OK"],
                artifacts: [],
                dependencies: [],
                disabled: false,
                env: {
                  TEST_ENV_VAR: "value",
                },
                cpu: defaultCpu,
                memory: defaultMemory,
                timeout: null,
                volumes: [],
              },
              timeout: null,
            },
          ],
        },
      })
    })

    it("should add service volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "container",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {},
              limits: {
                cpu: 123,
                memory: 456,
              },
              cpu: defaultCpu,
              memory: defaultMemory,
              ports: [],
              replicas: 1,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
              deploymentStrategy: defaultDeploymentStrategy,
            },
          ],
          tasks: [],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configureContainerModule({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.serviceConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should add task volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "container",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [],
          tasks: [
            {
              name: "task-a",
              args: [],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configureContainerModule({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.taskConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should add test volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "container",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [],
          tasks: [],
          tests: [
            {
              name: "test-a",
              args: [],
              artifacts: [],
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
            },
          ],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configureContainerModule({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.testConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should fail with invalid port in ingress spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "test",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [
                {
                  annotations: {},
                  path: "/",
                  port: "bla",
                },
              ],
              cpu: defaultCpu,
              memory: defaultMemory,
              env: {},
              ports: [],
              replicas: 1,
              volumes: [],
              deploymentStrategy: defaultDeploymentStrategy,
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [],
            },
          ],
          tests: [
            {
              name: "unit",
              args: ["echo", "OK"],
              artifacts: [],
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [],
            },
          ],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configureContainerModule({ ctx, moduleConfig, log }), "configuration")
    })

    it("should fail with invalid port in httpGet healthcheck spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "test",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {
                httpGet: {
                  path: "/",
                  port: "bla",
                },
              },
              cpu: defaultCpu,
              memory: defaultMemory,
              ports: [],
              replicas: 1,
              volumes: [],
              deploymentStrategy: defaultDeploymentStrategy,
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configureContainerModule({ ctx, moduleConfig, log }), "configuration")
    })

    it("should fail with invalid port in tcpPort healthcheck spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: DEFAULT_API_VERSION,
        name: "module-a",
        path: modulePath,
        type: "test",

        spec: {
          build: {
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {
                tcpPort: "bla",
              },
              cpu: defaultCpu,
              memory: defaultMemory,
              ports: [],
              replicas: 1,
              volumes: [],
              deploymentStrategy: defaultDeploymentStrategy,
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              cpu: defaultCpu,
              memory: defaultMemory,
              timeout: null,
              volumes: [],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configureContainerModule({ ctx, moduleConfig, log }), "configuration")
    })
  })
})

//   describe("publishModule", () => {
//     it("should not publish image if module doesn't container a Dockerfile", async () => {
//       const config = cloneDeep(baseConfig)
//       config.spec.image = "some/image"
//       const module = td.object(await getTestModule(config))

//       td.replace(helpers, "hasDockerfile", () => false)

//       const result = await publishModule({ ctx, log, module })
//       expect(result).to.eql({ published: false })
//     })

//     it("should publish image if module contains a Dockerfile", async () => {
//       const config = cloneDeep(baseConfig)
//       config.spec.image = "some/image:1.1"
//       const module = td.object(await getTestModule(config))

//       td.replace(helpers, "hasDockerfile", () => true)
//       td.replace(helpers, "getPublicImageId", () => "some/image:12345")

//       module.outputs["local-image-id"] = "some/image:12345"

//       td.replace(helpers, "dockerCli", async ({ cwd, args, ctx: _ctx }) => {
//         expect(cwd).to.equal(module.buildPath)
//         expect(args).to.eql(["push", "some/image:12345"])
//         expect(_ctx).to.exist
//         return { all: "log" }
//       })

//       const result = await publishModule({ ctx, log, module })
//       expect(result).to.eql({ message: "Published some/image:12345", published: true })
//     })

//     it("should tag image if remote id differs from local id", async () => {
//       const config = cloneDeep(baseConfig)
//       config.spec.image = "some/image:1.1"
//       const module = td.object(await getTestModule(config))

//       td.replace(helpers, "hasDockerfile", () => true)
//       td.replace(helpers, "getPublicImageId", () => "some/image:1.1")

//       module.outputs["local-image-id"] = "some/image:12345"

//       const dockerCli = td.replace(helpers, "dockerCli")

//       const result = await publishModule({ ctx, log, module })
//       expect(result).to.eql({ message: "Published some/image:1.1", published: true })

//       td.verify(
//         dockerCli({
//           cwd: module.buildPath,
//           args: ["tag", "some/image:12345", "some/image:1.1"],
//           log: td.matchers.anything(),
//           ctx: td.matchers.anything(),
//         })
//       )

//       td.verify(
//         dockerCli({
//           cwd: module.buildPath,
//           args: ["push", "some/image:1.1"],
//           log: td.matchers.anything(),
//           ctx: td.matchers.anything(),
//         })
//       )
//     })

//     it("should use specified tag if provided", async () => {
//       const config = cloneDeep(baseConfig)
//       config.spec.image = "some/image:1.1"
//       const module = td.object(await getTestModule(config))

//       td.replace(helpers, "hasDockerfile", () => true)

//       module.outputs["local-image-id"] = "some/image:12345"

//       const dockerCli = td.replace(helpers, "dockerCli")

//       const result = await publishModule({ ctx, log, module, tag: "custom-tag" })
//       expect(result).to.eql({ message: "Published some/image:custom-tag", published: true })

//       td.verify(
//         dockerCli({
//           cwd: module.buildPath,
//           args: ["tag", "some/image:12345", "some/image:custom-tag"],
//           log: td.matchers.anything(),
//           ctx: td.matchers.anything(),
//         })
//       )

//       td.verify(
//         dockerCli({
//           cwd: module.buildPath,
//           args: ["push", "some/image:custom-tag"],
//           log: td.matchers.anything(),
//           ctx: td.matchers.anything(),
//         })
//       )
//     })
//   })

//   describe("checkDockerServerVersion", () => {
//     it("should return if server version is equal to the minimum version", async () => {
//       helpers.checkDockerServerVersion(minDockerVersion)
//     })

//     it("should return if server version is greater than the minimum version", async () => {
//       const version = {
//         client: "99.99",
//         server: "99.99",
//       }

//       helpers.checkDockerServerVersion(version)
//     })

//     it("should throw if server is not reachable (version is undefined)", async () => {
//       const version = {
//         client: minDockerVersion.client,
//         server: undefined,
//       }

//       await expectError(
//         () => helpers.checkDockerServerVersion(version),
//         (err) => {
//           expect(err.message).to.equal("Docker server is not running or cannot be reached.")
//         }
//       )
//     })

//     it("should throw if server version is too old", async () => {
//       const version = {
//         client: minDockerVersion.client,
//         server: "17.06",
//       }

//       await expectError(
//         () => helpers.checkDockerServerVersion(version),
//         (err) => {
//           expect(err.message).to.equal("Docker server needs to be version 17.07.0 or newer (got 17.06)")
//         }
//       )
//     })
//   })

//   describe("getDockerBuildFlags", () => {
//     it("should include extraFlags", async () => {
//       td.replace(helpers, "hasDockerfile", () => true)

//       const buildAction = await getTestBuildAction({
//         allowPublish: false,
//         build: {
//           dependencies: [],
//         },
//         disabled: false,
//         apiVersion: DEFAULT_API_VERSION,
//         name: "module-a",
//         path: modulePath,
//         type: "container",

//         spec: {
//           build: {
//             dependencies: [],
//             timeout: DEFAULT_BUILD_TIMEOUT,
//           },
//           buildArgs: {},
//           extraFlags: ["--cache-from", "some-image:latest"],
//           services: [],
//           tasks: [],
//           tests: [],
//         },

//         serviceConfigs: [],
//         taskConfigs: [],
//         testConfigs: [],
//       })
//       const resolvedBuild = await garden.resolveAction({ action: buildAction, log })

//       const args = getDockerBuildFlags(resolvedBuild)

//       expect(args.slice(-2)).to.eql(["--cache-from", "some-image:latest"])
//     })

//     it("should set GARDEN_MODULE_VERSION", async () => {
//       td.replace(helpers, "hasDockerfile", () => true)

//       const buildAction = await getTestBuildAction({
//         allowPublish: false,
//         build: {
//           dependencies: [],
//         },
//         disabled: false,
//         apiVersion: DEFAULT_API_VERSION,
//         name: "module-a",
//         path: modulePath,
//         type: "container",

//         spec: {
//           build: {
//             dependencies: [],
//             timeout: DEFAULT_BUILD_TIMEOUT,
//           },
//           buildArgs: {},
//           extraFlags: [],
//           services: [],
//           tasks: [],
//           tests: [],
//         },

//         serviceConfigs: [],
//         taskConfigs: [],
//         testConfigs: [],
//       })

//       const resolvedBuild = await garden.resolveAction({ action: buildAction, log })

//       const args = getDockerBuildFlags(resolvedBuild)

//       expect(args.slice(0, 2)).to.eql(["--build-arg", `GARDEN_MODULE_VERSION=${buildAction.versionString()}`])
//     })
//   })
// })
