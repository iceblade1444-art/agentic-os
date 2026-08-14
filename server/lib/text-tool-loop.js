// A tool loop over a text-only chat channel.
//
// The Gemini proxy on the MILA backend is text-in, text-out — no native
// function calling. Both Telegram assistants (the internal one and the
// customer bot) run tools the same way instead: the model answers with exactly
// one TOOL_CALL line, the caller-supplied executor runs it, the result goes
// back as a TOOL_RESULT message, and the loop continues until prose comes out.
//
// The executor is where all authority lives. This module never decides what a
// tool may do — it only guarantees the conversation shape: every call gets a
// result, every failure is visible to the model, and a runaway loop ends.

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export const TOOL_PROTOCOL_LINES = [
  "Function calling is not available on this channel. To use one of your tools, reply with EXACTLY one line and nothing else:",
  'TOOL_CALL {"name":"tool_name","args":{}}',
  "The system will execute it and send you the result as a message starting with TOOL_RESULT. Then answer the person in plain prose.",
  "Never write TOOL_RESULT yourself, never claim an action happened without a TOOL_RESULT proving it, and never put a TOOL_CALL and prose in the same reply.",
];

export async function runTextToolLoop({ chat, cfg, label, systemPrompt, messages, execute, maxSteps = 4, fallback }) {
  const exchange = [...messages];
  for (let step = 0; step <= maxSteps; step += 1) {
    const result = await chat(cfg, label, { messages: exchange, systemPrompt });
    const reply = clean(result?.text, 8000);
    const call = reply.match(/^\s*TOOL_CALL\s*(\{[\s\S]*\})\s*$/);
    if (!call) return { text: reply, exchange };

    exchange.push({ role: "assistant", content: reply });
    let outcome;
    try {
      const parsed = JSON.parse(call[1]);
      outcome = await execute(clean(parsed?.name, 60), parsed.args || {});
    } catch (error) {
      // The model has to see the failure, or it will report the action as done.
      outcome = { ok: false, error: clean(error.message, 300) };
    }
    exchange.push({ role: "user", content: `TOOL_RESULT ${clean(JSON.stringify(outcome), 4000)}` });
  }
  return { text: clean(fallback, 500) || "Too many tool rounds.", exchange };
}
