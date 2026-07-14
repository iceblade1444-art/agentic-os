import { store } from "../store.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { agentIcon, esc, toast, qs, initials } from "../ui.js";

/* ---------- minimal markdown ---------- */
function mdToHtml(src) {
  let out = esc(src);
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.split(/\n{2,}/).map((p) => (p.startsWith("<pre>") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)).join("");
  return out;
}

/* ---------- LLM connectivity ---------- */
async function callLLM(messages, onToken) {
  const cfg = store.state.settings.llm;
  // Backend present and no client key set → use the server-side LLM proxy (holds keys, no CORS).
  if (api.on && !cfg.apiKey) {
    try { return await streamOpenAI({ baseUrl: "/api/llm", apiKey: "backend", model: cfg.model || "gpt-4o-mini" }, messages, onToken); }
    catch (err) { console.error(err); toast("error", "Backend LLM error", (err.message || "") + " — using demo response."); await mockStream(messages, onToken, true); return; }
  }
  if (!cfg.apiKey) { await mockStream(messages, onToken); return; }
  try {
    if (cfg.provider === "anthropic") return await streamAnthropic(cfg, messages, onToken);
    return await streamOpenAI(cfg, messages, onToken);
  } catch (err) {
    console.error(err);
    toast("error", "LLM request failed", "Falling back to demo response. Check Settings / CORS.");
    await mockStream(messages, onToken, true);
  }
}
async function streamOpenAI(cfg, messages, onToken) {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  await readSSE(res, (json) => { const t = json.choices?.[0]?.delta?.content; if (t) onToken(t); });
}
async function streamAnthropic(cfg, messages, onToken) {
  const sys = messages.find((m) => m.role === "system")?.content;
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: 1024, system: sys, stream: true, messages: messages.filter((m) => m.role !== "system") }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  await readSSE(res, (json) => { if (json.type === "content_block_delta" && json.delta?.text) onToken(json.delta.text); });
}
async function readSSE(res, onJson) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim(); if (data === "[DONE]") return;
      try { onJson(JSON.parse(data)); } catch (e) {}
    }
  }
}
async function mockStream(messages, onToken, isFallback) {
  const last = messages[messages.length - 1]?.content || "";
  const reply = isFallback
    ? "I'm running in **demo mode** because the live LLM call didn't go through (often browser CORS on direct provider calls — route through your own backend proxy).\n\nMeanwhile, here's a canned answer so the UI stays fully interactive."
    : `Here's how I'd approach “${last.slice(0, 60)}”:\n\n1. Clarify the goal and constraints\n2. Break it into tool-callable steps\n3. Execute with guardrails + evals\n\n\`\`\`python\nagent = Agent(name="Assistant", tools=[search_web])\nresult = agent.run(${JSON.stringify(last.slice(0, 40))})\n\`\`\`\n\n_Tip: add your API key in **Settings → Model** to get live responses._`;
  for (const ch of reply.match(/.{1,3}/gs) || []) { onToken(ch); await new Promise((r) => setTimeout(r, 12)); }
}

/* ---------- Page ---------- */
export default {
  title: "Chat",
  render() {
    const s = store.state;
    const session = s.chat.sessions.find((x) => x.id === s.chat.activeSession) || s.chat.sessions[0];
    const agent = s.agents.find((a) => a.id === session.agentId) || s.agents[0];
    const clientKey = !!s.settings.llm.apiKey;
    const serverLLM = api.on && api.serverHasLLM();
    const connected = clientKey || serverLLM;
    const label = clientKey ? "Connected · " + esc(s.settings.llm.model) : serverLLM ? "Connected · via backend" : api.on ? "Backend on · set an LLM key in .env or Settings" : "Demo mode · add API key in Settings";
    return `
    <div class="page-head" style="margin-bottom:12px">
      <div class="row gap-3">
        ${agentIcon(agent, 40)}
        <div class="stack"><span class="text-lg fw-700">${esc(agent.name)}</span><span class="row gap-2 text-sm muted"><span class="status-dot" style="background:${connected ? "var(--success)" : "var(--warning)"}"></span>${label}</span></div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-secondary sm" id="newChat">${icon("plus")}New chat</button>
      <a class="btn btn-ghost sm" href="#/settings">${icon("settings")}</a>
    </div>

    <div class="card chat pad-lg">
      <div class="chat-scroll" id="chatScroll">
        ${session.messages.map((m) => msgHTML(m, agent)).join("")}
      </div>
      <div class="chat-input mt-4">
        <button class="icon-btn" title="Attach">${icon("attach")}</button>
        <textarea id="chatInput" rows="1" placeholder="Message ${esc(agent.name)}…"></textarea>
        <button class="icon-btn" title="Mention">${icon("at")}</button>
        <button class="btn btn-primary" id="chatSend">${icon("send")}</button>
      </div>
    </div>`;
  },

  mount(root) {
    const scroll = root.querySelector("#chatScroll");
    const input = root.querySelector("#chatInput");
    const send = root.querySelector("#chatSend");
    const s = store.state;
    const session = s.chat.sessions.find((x) => x.id === s.chat.activeSession) || s.chat.sessions[0];
    const agent = s.agents.find((a) => a.id === session.agentId) || s.agents[0];
    const scrollDown = () => (scroll.scrollTop = scroll.scrollHeight);
    scrollDown();

    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    send.onclick = submit;
    root.querySelector("#newChat").onclick = () => {
      store.set((st) => {
        const id = store.uid("ses");
        st.chat.sessions.unshift({ id, title: "New chat", agentId: agent.id, messages: [] });
        st.chat.activeSession = id;
      });
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };

    async function submit() {
      const text = input.value.trim(); if (!text) return;
      input.value = ""; input.style.height = "auto"; send.classList.add("disabled");
      session.messages.push({ role: "user", content: text });
      scroll.insertAdjacentHTML("beforeend", msgHTML({ role: "user", content: text }, agent));
      scrollDown();

      const bubble = document.createElement("div");
      bubble.className = "msg assistant";
      bubble.innerHTML = `${agentIcon(agent, 34)}<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
      scroll.appendChild(bubble); scrollDown();
      const body = bubble.querySelector(".bubble");

      const sys = { role: "system", content: agent.instructions || "You are a helpful assistant." };
      const history = session.messages.map((m) => ({ role: m.role, content: m.content }));
      let acc = "";
      await callLLM([sys, ...history], (tok) => { acc += tok; body.innerHTML = mdToHtml(acc); scrollDown(); });
      session.messages.push({ role: "assistant", content: acc });
      if (session.title === "New chat") session.title = text.slice(0, 40);
      store.persist();
      send.classList.remove("disabled"); input.focus();
    }
  },
};

function msgHTML(m, agent) {
  if (m.role === "user") {
    const p = store.state.profile;
    return `<div class="msg user"><div class="avatar" style="width:34px;height:34px">${p.avatar ? `<img src="${p.avatar}"/>` : initials(p.name)}</div><div class="bubble">${mdToHtml(m.content)}</div></div>`;
  }
  return `<div class="msg assistant">${agentIcon(agent || store.state.agents[0], 34)}<div class="bubble">${mdToHtml(m.content)}</div></div>`;
}
