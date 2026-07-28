import fs from "node:fs";

import { config } from "../config.js";

const mutationListeners = new Set();

export function onRuntimeFileMutation(listener) {
  if (typeof listener !== "function") throw new TypeError("Runtime mutation listener must be a function");
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function notifyRuntimeFileMutation(file) {
  for (const listener of mutationListeners) {
    try { listener(file); }
    catch (error) { console.error(`[runtime-files] mutation listener failed: ${error.message}`); }
  }
}

export function hardenRuntimeFile(file, mode = 0o600) {
  try { fs.chmodSync(file, mode); } catch { /* Windows or restrictive volume */ }
  try { fs.chownSync(file, config.runtimeFiles.uid, config.runtimeFiles.gid); } catch { /* non-root or unsupported filesystem */ }
  notifyRuntimeFileMutation(file);
}

