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
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, models: ["deepseek"] }, state: {} }
  m.onRequest({ model: "deepseek-chat", messages: [{ role: "user", content: "x" }] }, ctx)
  assert.ok(ctx.state.purge, "request passed the model filter")
  const body = { model: "group/jarivs", content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx).content[0].text, "Hello")
})

// ...and a reply with no state.purge (request never passed) is left whole
test("onResponse leaves a reply whole when the request didn't pass onRequest", () => {
  const ctx = { protocol: "anthropic", model: "", options: { preset: "off", stripThink: true, models: ["deepseek"] }, state: {} }
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
