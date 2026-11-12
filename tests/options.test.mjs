// Which requests a plugin touches at all: the agent/model filters, and how the
// reply path follows the request path instead of re-deciding.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"

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

// onResponse keys off ctx.state.purge, NOT the reply's model — so a rewritten /
// real served model can't silently disable stripping while the stream path
// keeps stripping. Here the models filter admits the request, then the reply's
// model is something else entirely; it must still strip.
test("onResponse strips even when the reply's model differs from the request", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, models: ["example"] }, state: {} }
  m.onRequest({ model: "example-model", messages: [{ role: "user", content: "x" }] }, ctx)
  assert.ok(ctx.state.purge, "request passed the model filter")
  const body = { model: "group/test", content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx).content[0].text, "Hello")
})

test("onResponse leaves a reply whole when the request didn't pass onRequest", () => {
  const ctx = { protocol: "anthropic", model: "", options: { preset: "off", stripThink: true, models: ["example"] }, state: {} }
  m.onRequest({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }, ctx) // filtered out
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx), undefined)
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})

test("an agents allowlist admits only the named agents", () => {
  const hit = { protocol: "chat", model: "m", agent: "claude", options: { preset: "minimal", agents: ["claude"] }, state: {} }
  assert.ok(m.onRequest({ model: "m", messages: [] }, hit))
  const miss = { protocol: "chat", model: "m", agent: "codex", options: { preset: "minimal", agents: ["claude"] }, state: {} }
  assert.equal(m.onRequest({ model: "m", messages: [] }, miss), undefined)
  assert.equal(miss.state.purge, undefined)
})

test("the module exports no events whitelist", () => {
  assert.equal(m.events, undefined)
})

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
  const ctx = { protocol: "anthropic", model: "", options: opts, state: {} }
  assert.doesNotThrow(() => m.onRequest({ system: [{ type: "text", text: 123 }], messages: [] }, ctx))
})

test("an onRequest failure leaves the request's own body untouched", () => {
  const ctx = { protocol: "gemini", model: "", options: { preset: "unrestricted", override: true }, state: {} }
  const body = { systemInstruction: { parts: "not-an-array" }, contents: [] }
  const out = m.onRequest(body, ctx)
  assert.ok(out === undefined || typeof out === "object")
})
