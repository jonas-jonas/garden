/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Log } from "../logger/log-entry"
import { StringMap } from "../config/common"
import { CloudApi, isGotError } from "./api"
import { BaseResponse } from "@garden-io/platform-api-types"
import { deline } from "../util/string"
import { getCloudDistributionName } from "../util/util"

export interface GetSecretsParams {
  log: Log
  projectId: string
  environmentName: string
  cloudApi: CloudApi
}

export async function getSecrets({ log, projectId, environmentName, cloudApi }: GetSecretsParams): Promise<StringMap> {
  let secrets: StringMap = {}
  const distroName = getCloudDistributionName(cloudApi.domain)

  try {
    const res = await cloudApi.get<BaseResponse>(`/secrets/projectUid/${projectId}/env/${environmentName}`)
    secrets = res.data
  } catch (err) {
    if (isGotError(err, 404)) {
      log.debug(`No secrets were received from ${distroName}.`)
      log.debug("")
      log.debug(deline`
        Either the environment ${environmentName} does not exist in ${distroName}, or no project
        with the id in your project configuration exists in ${distroName}.
      `)
      log.debug("")
      log.debug(deline`
        Please visit ${cloudApi.domain} to review the environments and projects currently
        in the system.
      `)
    } else {
      throw err
    }
  }

  const emptyKeys = Object.keys(secrets).filter((key) => !secrets[key])
  if (emptyKeys.length > 0) {
    const prefix =
      emptyKeys.length === 1
        ? "The following secret key has an empty value"
        : "The following secret keys have empty values"
    log.error(`${prefix}: ${emptyKeys.sort().join(", ")}`)
  }
  return secrets
}
