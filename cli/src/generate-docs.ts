/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { generateDocs } from "@garden-io/core/build/src/docs/generate"
import { resolve } from "path"
import { LogWriter, LogLevel } from "@garden-io/core/build/src/logger/logger"
import { GARDEN_CLI_ROOT } from "@garden-io/core/build/src/constants"
import { getBundledPlugins } from "./cli"
import { getSupportedPlugins } from "@garden-io/core/build/src/plugins/plugins"

require("source-map-support").install()

// make sure logger is initialized
try {
  LogWriter.initialize({
    level: LogLevel.info,
    type: "quiet",
    storeEntries: false,
    // level: LogLevel.debug,
    // writers: [new BasicTerminalWriter()],
  })
} catch (_) {}

const plugins = [...getBundledPlugins(), ...getSupportedPlugins()]

generateDocs(resolve(GARDEN_CLI_ROOT, "..", "docs"), plugins)
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("Done!")
    process.exit(0)
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
