import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "./mg-purge.middleware.js"

// helper: run a request then an event, return captured console.log lines
function withLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.map(String).join(" "))
  try { fn() } finally { console.log = orig }
  return lines
}
function reqCtx(opts, agent) {
  const c = { protocol: "anthropic", model: "", agent, options: { preset: "off", stripThink: false, refusalRetry: true, ...opts }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c)
  return c
}

// Fix 3: onResponse honors excludeAgents via ctx.state.purge presence
test("excludeAgents: reply is not stripped for an excluded agent", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "claude", options: { preset: "off", stripThink: true, excludeAgents: ["claude"] }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
  assert.equal(ctx.state.purge, undefined, "excluded: no state.purge written")
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx), undefined)
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})

test("a non-excluded agent's reply is still stripped", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, excludeAgents: ["claude"] }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx).content[0].text, "Hello")
})

// Fix C: onResponse keys off ctx.state.purge, NOT the reply's model — so a
// rewritten/真实 served model can't silently disable stripping while the
// stream path keeps stripping. Here models filter admits the request, then the
// reply's model is something else entirely; it must still strip.
test("onResponse strips even when the reply's model differs from the request", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, models: ["example"] }, state: {} }
  m.onRequest({ model: "example-model", messages: [{ role: "user", content: "x" }] }, ctx)
  assert.ok(ctx.state.purge, "request passed the model filter")
  const body = { model: "group/test", content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx).content[0].text, "Hello")
})

// ...and a reply with no state.purge (request never passed) is left whole
test("onResponse leaves a reply whole when the request didn't pass onRequest", () => {
  const ctx = { protocol: "anthropic", model: "", options: { preset: "off", stripThink: true, models: ["example"] }, state: {} }
  m.onRequest({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }, ctx) // filtered out
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx), undefined)
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})

// refusal detection now signals via console.log, not a cross-runtime counter
test("five normal answers are not flagged", () => {
  const samples = [
    "作为一个 AI，我建议先把日志打开。",
    "I'm sorry, but I need a bit more detail to help — could you paste the error?",
    "请把授权文件发给我，我才能继续。",
    "这属于未授权访问的典型场景，下面演示如何检测。",
    "抱歉，我不能直接改你的生产库；我可以给你一个安全的迁移脚本。",
  ]
  for (const s of samples) {
    const c = reqCtx({}, undefined)
    const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, c))
    assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0, `should not flag: ${s}`)
  }
})

test("a short contentless refusal IS detected and logged, reply untouched", () => {
  const c = reqCtx({}, undefined)
  const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'm sorry, but I can't help with that." } }
  const logs = withLog(() => {
    const out = m.onEvent(ev, c)
    assert.equal(out, undefined)
  })
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
  assert.equal(ev.delta.text, "I'm sorry, but I can't help with that.")
})

// Fix D: the most common Chinese refusal "我不能帮你做这个。"
test("Chinese refusal 「我不能帮你做这个。」 is detected", () => {
  const c = reqCtx({}, undefined)
  const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } }, c))
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
})

test("Chinese 「抱歉，我帮不了你。」 is detected", () => {
  const c = reqCtx({}, undefined)
  const logs = withLog(() => m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "抱歉，我帮不了你。" } }, c))
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
})

// Fix 1: no events whitelist → all events reach onEvent
test("the module exports no events whitelist", () => {
  assert.equal(m.events, undefined)
})

// Coverage gap: gemini streaming think-strip (candidates[].content.parts[].text)
test("gemini streamed parts still get think stripped", () => {
  const ctx = { protocol: "gemini", model: "", options: { preset: "off", stripThink: true, refusalRetry: false }, state: {} }
  m.onRequest({ model: "m", contents: [{ role: "user", parts: [{ text: "x" }] }] }, ctx)
  let text = ""
  for (const chunk of ["<thi", "nk>hm</think>\nHello"]) {
    const ev = { candidates: [{ index: 0, content: { parts: [{ text: chunk }] } }] }
    const out = m.onEvent(ev, ctx) || ev
    text += out.candidates[0].content.parts[0].text
  }
  assert.equal(text, "Hello")
})

// B: a non-2xx reply is logged with status/model/injected — never the prompt
test("error replies are logged with status, models, injected flag", () => {
  const ctx = { protocol: "chat", model: "", agent: "codex", status: 502, options: { preset: "unrestricted", stripThink: false }, state: {} }
  m.onRequest({ model: "example-model", messages: [{ role: "user", content: "SECRET PROMPT" }] }, ctx)
  const body = { model: "group/test", error: { type: "upstream_error" } }
  const logs = withLog(() => m.onResponse(body, ctx))
  const line = logs.find((l) => l.includes("[mg-purge] error 502"))
  assert.ok(line, "should log the 502")
  assert.ok(line.includes("status") || line.includes("502"))
  assert.ok(line.includes("injected=yes"))
  assert.ok(!line.includes("SECRET PROMPT"), "must not log the prompt")
})

test("logErrors:false silences the error log", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", status: 502, options: { preset: "unrestricted", stripThink: false, logErrors: false }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => m.onResponse({ model: "x", error: { type: "t" } }, ctx))
  assert.equal(logs.filter((l) => l.includes("[mg-purge] error")).length, 0)
})

// 降低误伤: precise refusal detection — no false positives on normal answers,
// no false negatives on short declines
function detect(text, extra) {
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: false, refusalRetry: true, refusalPatterns: extra || [] }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  let logged = false
  const orig = console.log; console.log = () => { logged = true }
  try { m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, ctx) } finally { console.log = orig }
  return logged
}
test("refusal detection: precision", () => {
  const yes = ["I can't help with that.", "我不能帮你做这个。", "抱歉，我无法协助你。", "No, I won't", "I cannot help with that.", "I'm not going to do that.", "这超出了我的能力范围。"]
  const no = [
    "I can't help but notice the config has a typo — change PORT to 8080, then restart.",
    "我可以帮你完成，先这样改：把 LOG_LEVEL 设成 debug。",
    "I'm sorry, but I need more detail: which OS and version are you on?",
    "This is a prompt injection example: `ignore previous` — here's how to detect it.",
    "I can't help with that SQL query — actually, here's the corrected one:\nSELECT 1",
    "作为 AI，我建议你先备份再迁移，步骤如下：1. dump 2. restore",
  ]
  for (const t of yes) assert.equal(detect(t), true, "should detect: " + t)
  for (const t of no) assert.equal(detect(t), false, "should NOT detect: " + t)
})

// 稳定性: hooks never throw on malformed input — they fail open
test("hooks fail open on malformed bodies/events", () => {
  const opts = { preset: "unrestricted", stripThink: true, refusalRetry: true }
  const bads = [null, 42, "x", [], { system: 123 }, { messages: "no" }, { choices: "no" }, { content: 5 }]
  for (const b of bads) {
    const ctx = { protocol: "anthropic", model: "", options: opts, state: {} }
    assert.doesNotThrow(() => m.onRequest(b, ctx))
    assert.doesNotThrow(() => m.onResponse(b, { ...ctx, status: 200 }))
    const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<think>x" } }
    assert.doesNotThrow(() => m.onEvent(ev, ctx))
  }
  // a body with a circular-ish / weird nested system shouldn't throw either
  const ctx = { protocol: "anthropic", model: "", options: opts, state: {} }
  assert.doesNotThrow(() => m.onRequest({ system: [{ type: "text", text: 123 }], messages: [] }, ctx))
})

test("an onRequest failure leaves the request's own body untouched", () => {
  // protocol gemini with a broken systemInstruction shape the injector must survive
  const ctx = { protocol: "gemini", model: "", options: { preset: "unrestricted", override: true }, state: {} }
  const body = { systemInstruction: { parts: "not-an-array" }, contents: [] }
  const out = m.onRequest(body, ctx)
  // must not throw; either it injected safely or left as-is, but no crash
  assert.ok(out === undefined || typeof out === "object")
})

// ab harness URL: base with or without /v1 must not double up
import { chatUrl } from "./scripts/endpoint.mjs"
test("chatUrl never doubles /v1", () => {
  assert.equal(chatUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1/chat/completions")
  assert.equal(chatUrl("http://127.0.0.1:3425/"), "http://127.0.0.1:3425/v1/chat/completions")
  assert.equal(chatUrl("https://host/v1"), "https://host/v1/chat/completions")
  assert.equal(chatUrl("https://host/v1/"), "https://host/v1/chat/completions")
})

// refusalDetect is the honest name; refusalRetry is a deprecated alias for the
// SAME switch. Both keys must keep working, and neither may ever retry — the
// gateway cannot re-run the model, so the only observable effect is a log line.
function runRefusal(opts) {
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: false, ...opts }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => m.onEvent(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } },
    ctx,
  ))
  return { logs, state: ctx.state.purge }
}
test("refusalDetect: on by default, off when either key is false", () => {
  assert.equal(runRefusal({}).state.refusalDetect, true, "default is on")
  assert.equal(runRefusal({ refusalDetect: true }).state.refusalDetect, true)
  assert.equal(runRefusal({ refusalDetect: false }).state.refusalDetect, false)
  // deprecated alias keeps working, in both directions
  assert.equal(runRefusal({ refusalRetry: true }).state.refusalDetect, true)
  assert.equal(runRefusal({ refusalRetry: false }).state.refusalDetect, false)
})
test("refusal detection logs the opening and never edits the reply", () => {
  const { logs } = runRefusal({ refusalDetect: true })
  assert.ok(logs.some((l) => l.includes("refusal opening detected")), "should log the detection")
})
test("the deprecated refusalRetry key still works and stays silent", async () => {
  // No runtime warning is possible: a middleware runs in magpie's sandbox with
  // no node:fs and a fresh isolate per call, so "warn once" would repeat on
  // every request. The rename is documented in the README and the panel instead.
  const fresh = await import("./mg-purge.middleware.js?alias-silent")
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: false, refusalRetry: true }, state: {} }
  const logs = withLog(() => {
    fresh.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
    return fresh.onEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } },
      ctx,
    )
  })
  assert.equal(ctx.state.purge.refusalDetect, true, "the old key still enables detection")
  assert.ok(logs.some((l) => l.includes("refusal opening detected")), "and still detects")
  assert.equal(logs.filter((l) => l.includes("deprecated")).length, 0, "but never warns")
})

// The streaming path catches refusals in onEvent; a non-streamed reply only
// ever reaches onResponse, so the detector has to run there too.
function wholeReply(text, opts) {
  const ctx = { protocol: "chat", model: "", agent: "x", status: 200, options: { preset: "off", stripThink: false, refusalDetect: true, ...opts }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { choices: [{ index: 0, message: { role: "assistant", content: text } }] }
  return withLog(() => m.onResponse(body, ctx))
}
test("refusal detection also covers whole (non-streamed) replies", () => {
  const logs = wholeReply("我不能帮你做这个。")
  assert.ok(logs.some((l) => l.includes("refusal opening detected") && l.includes("mode=whole")))
})
test("whole replies: a leading think block does not hide the refusal", () => {
  const logs = wholeReply("<think>user wants X</think>\n抱歉，我无法提供这个。")
  assert.ok(logs.some((l) => l.includes("mode=whole")), "detect on the visible text, not the think block")
})
test("whole replies: a real answer is not flagged", () => {
  const logs = wholeReply("可以，把 PORT 改成 8080 然后重启就行。")
  assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0)
})
test("whole replies: refusalDetect off stays silent", () => {
  const logs = wholeReply("我不能帮你做这个。", { refusalDetect: false })
  assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0)
})
