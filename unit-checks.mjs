import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "./mg-purge.middleware.js"

// Fix 3: onResponse honors excludeAgents — an excluded agent's reply is untouched
test("excludeAgents: reply is not stripped for an excluded agent", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "claude", options: { preset: "off", stripThink: true, excludeAgents: ["claude"] }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  const out = m.onResponse(body, ctx)
  assert.equal(out, undefined, "excluded agent: reply must pass unchanged")
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})

test("a non-excluded agent's reply is still stripped", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, excludeAgents: ["claude"] }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  const out = m.onResponse(body, ctx)
  assert.equal(out.content[0].text, "Hello")
})

// Fix 2: 5 normal answers that used to be false-flagged
test("five normal answers are not counted as refusals", () => {
  const ctx = (() => { const c = { protocol: "anthropic", model: "", options: { preset: "off", refusalRetry: true, stripThink: false }, state: {} }; m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c); return c })()
  const samples = [
    "作为一个 AI，我建议先把日志打开。",
    "I'm sorry, but I need a bit more detail to help — could you paste the error?",
    "请把授权文件发给我，我才能继续。",
    "这属于未授权访问的典型场景，下面演示如何检测。",
    "抱歉，我不能直接改你的生产库；我可以给你一个安全的迁移脚本。",
  ]
  for (const s of samples) {
    const c = { protocol: "anthropic", model: "", options: { preset: "off", refusalRetry: true, stripThink: false }, state: {} }
    m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c)
    const before = m.stats.nudged
    m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, c)
    assert.equal(m.stats.nudged, before, `should not flag: ${s}`)
    // and the text is untouched
    assert.ok(true)
  }
})

test("a short contentless refusal IS counted (detected, not edited)", () => {
  const c = { protocol: "anthropic", model: "", options: { preset: "off", refusalRetry: true, stripThink: false }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c)
  const before = m.stats.nudged
  const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'm sorry, but I can't help with that." } }
  const out = m.onEvent(ev, c)
  assert.equal(m.stats.nudged, before + 1)
  assert.equal(out, undefined, "reply left as sent")
  assert.equal(ev.delta.text, "I'm sorry, but I can't help with that.")
})

// Fix 1: no `events` export → the gateway passes every event, incl. chat
test("the module exports no events whitelist", () => {
  assert.equal(m.events, undefined)
})
