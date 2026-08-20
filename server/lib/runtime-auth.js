// The Python runtime on port 8765 answered every caller on the Compose network
// without asking who they were, and some of its routes reach approvals and the
// Hermes CLI. This is the same shared-secret shape already used for the speech
// container: one token, set by deploy.sh, known only to the Node API and the
// runtime.
//
// The secret is a parameter with the real default so a test can prove both
// branches without depending on whether the developer's .env happens to define
// it — reading it from a module constant is exactly how an earlier version of
// the speech header test came to pass only on machines with no .env.
import { config } from "../config.js";

export function runtimeInternalHeaders(extra = {}, token = config.agentosRuntimeToken) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// Surfaced on the health payload so an operator can see that the hop is
// authenticated without the token itself ever reaching a response.
export function runtimeAuthConfigured(token = config.agentosRuntimeToken) {
  return !!token;
}
