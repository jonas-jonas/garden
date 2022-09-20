/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { dedent } from "../../../util/string"
import { actionParamsSchema, PluginActionParamsBase } from "../../../plugin/base"
import { joi } from "../../../config/common"
import { BaseAction } from "../../../actions/base"
import { Resolved } from "../../../actions/types"
import { ActionTypeHandlerSpec } from "./base"

interface ValidateActionParams<T extends BaseAction> extends PluginActionParamsBase {
  action: T
}

// TODO-G2: allow returning an error instead of throwing
interface ValidateActionResult {}

export class ValidateAction<T extends BaseAction = BaseAction> extends ActionTypeHandlerSpec<
  any,
  ValidateActionParams<Resolved<T>>,
  ValidateActionResult
> {
  description = dedent`
    Validate the given fully resolved action.

    This does not need to perform structural schema validation (the framework does that automatically), but should in turn perform semantic validation to make sure the configuration is sane.

    This handler is called frequently, so it should generally return quickly and avoid doing any network calls or expensive computation.
  `
  paramsSchema = () => actionParamsSchema()

  resultSchema = () => joi.object().keys({})
}