import fs from "node:fs";

import { config } from "../config.js";

export function hardenRuntimeFile(file, mode = 0o600) {
  try { fs.chmodSync(file, mode); } catch { /* Windows or restrictive volume */ }
  try { fs.chownSync(file, config.runtimeFiles.uid, config.runtimeFiles.gid); } catch { /* non-root or unsupported filesystem */ }
}

