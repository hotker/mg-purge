// think-tag stripping: whole replies and streams, across all four protocols,
// including a tag split across two chunks.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"

test("onResponse strips a leading think block (anthropic)", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx).content[0].text, "Hello")
})

test("onResponse strips a leading think block (chat)", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { choices: [{ index: 0, message: { role: "assistant", content: "<think>hm</think>Hi" } }] }
  assert.equal(m.onResponse(body, ctx).choices[0].message.content, "Hi")
})

test("a think tag that is not at the start is kept", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { content: [{ type: "text", text: "Use <think>like this</think> inline." }] }
  assert.equal(m.onResponse(body, ctx), undefined, "left untouched")
  assert.equal(body.content[0].text, "Use <think>like this</think> inline.")
})

test("streamed chat events (no type field) still get think stripped", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true, refusalDetect: false }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  let text = ""
  for (const chunk of ["<thi", "nk>x</think>\nHello", " world"]) {
    const ev = { choices: [{ index: 0, delta: { content: chunk } }] }
    text += (m.onEvent(ev, ctx) || ev).choices[0].delta.content
  }
  assert.equal(text, "Hello world")
})

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

test("stripThink:false leaves the think block in place", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "x", options: { preset: "off", stripThink: false }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(m.onResponse(body, ctx), undefined)
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})
