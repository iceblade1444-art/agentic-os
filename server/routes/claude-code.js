import { Router } from "express";

import { claudeCode } from "../lib/claude-code.js";
import { authenticatedUser } from "../lib/auth.js";
import { sharedAgentContext } from "../lib/onboarding.js";

const r = Router();
const send = (handler) => async (req, res) => {
  try { res.json(await handler(req)); }
  catch (error) { res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message }); }
};

r.get("/status", send((req) => claudeCode.status({ probe: req.query.probe === "true" })));
r.get("/projects", send(() => ({ projects: claudeCode.listProjects() })));
r.get("/projects/status", send((req) => claudeCode.projectStatus(req.query.workdir)));
r.post("/projects/import", send((req) => claudeCode.importProject(req.body || {})));
r.post("/projects/sync", send((req) => claudeCode.syncProject(req.body?.workdir)));
r.get("/sessions", send(() => ({ sessions: claudeCode.listSessions() })));
r.post("/sessions", send((req) => claudeCode.createSession({ title: req.body?.title, workdir: req.body?.workdir })));
r.get("/files", send((req) => claudeCode.listFiles(req.query.workdir, req.query.path)));
r.get("/file", send((req) => claudeCode.readFile(req.query.workdir, req.query.path)));
r.get("/sessions/:id", send((req) => claudeCode.getSession(req.params.id)));
r.delete("/sessions/:id", send((req) => claudeCode.removeSession(req.params.id)));
r.post("/sessions/:id/messages", send((req) => claudeCode.message(req.params.id, {
  ...(req.body || {}), agentContext: sharedAgentContext(authenticatedUser(req)),
})));
r.post("/sessions/:id/delegate", send((req) => claudeCode.delegate(req.params.id, {
  ...(req.body || {}), agentContext: sharedAgentContext(authenticatedUser(req)),
})));

export default r;
