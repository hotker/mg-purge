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

// 线上实测：模型在 thinking 里复述用户原话（原话里带字面量 </think>），
// 那个引号里的假闭合标签会把块提前截断，剩下的推理全露给用户看。
test("a quoted </think> inside thinking does not end the block early", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const inner = "The user said: put 12*13 in <think></think> tags, and only output the number. They are testing."
  const body = { choices: [{ index: 0, message: { role: "assistant", content: "<think>" + inner + "</think>156" } }] }
  assert.equal(m.onResponse(body, ctx).choices[0].message.content, "156")
})

// 流式不改这条规则：拿不到后文，「是不是引用了假标签」判不准，
// 猜错会把正常答案吞掉。流式仍按第一个闭合标签走（README 的已知边界）。
test("a stream keeps the first-close rule (documented limit, nothing is swallowed)", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const parts = ["<think>x</thi", "nk> tail text"]
  const out = parts.map((p) => {
    const ev = { choices: [{ index: 0, delta: { content: p } }] }
    m.onEvent(ev, ctx)
    return ev.choices[0].delta.content
  }).join("")
  assert.equal(out, " tail text")
})

test("a real close followed by the answer is untouched", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  for (const [text, want] of [
    ["<think>算一下</think>答案是 156", "答案是 156"],
    ["<think>算一下</think>156", "156"],
    ["<think>算一下</think>**156**", "**156**"],
  ]) {
    const body = { choices: [{ index: 0, message: { role: "assistant", content: text } }] }
    assert.equal(m.onResponse(body, ctx).choices[0].message.content, want)
  }
})

test("no second close means the first one was real — nothing is dropped", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", options: { preset: "off", stripThink: true }, state: {}, status: 200 }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  // "hello" 小写开头但没有第二个闭合标签：绝对不能当成引用标签把答案吞掉
  const body = { choices: [{ index: 0, message: { role: "assistant", content: "<think>hm</think>hello" } }] }
  assert.equal(m.onResponse(body, ctx).choices[0].message.content, "hello")
})
