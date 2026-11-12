// Injection: where the prompt lands for each protocol, what override/position
// mean, the Anthropic cache boundary, and the context-ceiling guard.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"
import { withLog } from "./helpers/kit.mjs"

const req = (body, protocol = "anthropic", options = {}, agent = "x") => {
  const ctx = { protocol, model: "m", agent, options, state: {} }
  const out = m.onRequest(body, ctx)
  return { out, ctx }
}

test("anthropic: a string system gets the prompt appended after it", () => {
  const { out } = req({ system: "You code." }, "anthropic", { preset: "minimal" })
  assert.ok(out.system.startsWith("You code."))
  assert.ok(out.system.includes("最短路径完成"))
})

test("anthropic: an empty system becomes the prompt", () => {
  const { out } = req({}, "anthropic", { preset: "minimal" })
  assert.ok(out.system.includes("最短路径完成"))
})

test("anthropic: override:false leaves an existing system alone", () => {
  const { out } = req({ system: [{ type: "text", text: "keep me" }] }, "anthropic", { preset: "minimal", override: false })
  assert.deepEqual(out.system, [{ type: "text", text: "keep me" }])
})

test("anthropic: prepend puts the prompt before everything", () => {
  const { out } = req({ system: [{ type: "text", text: "keep me", cache_control: { type: "ephemeral" } }] }, "anthropic", { preset: "minimal", position: "prepend" })
  assert.ok(out.system[0].text.includes("最短路径完成"))
  assert.equal(out.system[1].text, "keep me")
})

// The whole point of cache-align: our block must sit INSIDE the cached prefix,
// i.e. before the block that carries cache_control, not after it.
test("append lands before the cache_control block, so the injection is cached", () => {
  const { out } = req({ system: [{ type: "text", text: "You code.", cache_control: { type: "ephemeral" } }] }, "anthropic", { preset: "minimal", position: "append" })
  assert.equal(out.system.length, 2)
  assert.ok(out.system[0].text.includes("最短路径完成"), "injection first")
  assert.equal(out.system[1].text, "You code.")
  assert.deepEqual(out.system[1].cache_control, { type: "ephemeral" }, "client's block untouched")
})

test("cacheAlign:false restores the old tail position", () => {
  const { out } = req({ system: [{ type: "text", text: "You code.", cache_control: { type: "ephemeral" } }] }, "anthropic", { preset: "minimal", position: "append", cacheAlign: false })
  assert.equal(out.system[0].text, "You code.")
  assert.ok(out.system[1].text.includes("最短路径完成"))
})

test("with several marked blocks the injection goes before the last one", () => {
  const sys = [
    { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    { type: "text", text: "b" },
    { type: "text", text: "c", cache_control: { type: "ephemeral" } },
  ]
  const { out } = req({ system: JSON.parse(JSON.stringify(sys)) }, "anthropic", { preset: "minimal" })
  assert.equal(out.system.length, 4)
  assert.deepEqual(out.system.map((b) => b.text), [
    "a", "b", out.system[2].text, "c",
  ])
  assert.ok(out.system[2].text.includes("最短路径完成"), "injection sits just before the last marked block")
  assert.deepEqual(out.system[3].cache_control, { type: "ephemeral" })
})

test("chat: no system message → one is unshifted; a leading system is extended", () => {
  const a = req({ messages: [{ role: "user", content: "hi" }] }, "chat", { preset: "minimal" })
  assert.equal(a.out.messages[0].role, "system")
  const b = req({ messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }, "chat", { preset: "minimal" })
  assert.equal(b.out.messages.length, 2)
  assert.ok(b.out.messages[0].content.includes("S"))
})

test("responses: instructions is created or appended", () => {
  const a = req({}, "responses", { preset: "minimal" })
  assert.ok(a.out.instructions.includes("最短路径完成"))
  const b = req({ instructions: "I" }, "responses", { preset: "minimal" })
  assert.ok(b.out.instructions.includes("I"))
  assert.ok(b.out.instructions.includes("最短路径完成"))
})

test("gemini: systemInstruction.parts is created or pushed", () => {
  const a = req({}, "gemini", { preset: "minimal" })
  assert.ok(a.out.systemInstruction.parts[0].text.includes("最短路径完成"))
  const b = req({ systemInstruction: { parts: [{ text: "G" }] } }, "gemini", { preset: "minimal" })
  assert.equal(b.out.systemInstruction.parts.length, 2)
})

test("preset:off with no systemPrompt injects nothing", () => {
  const { out, ctx } = req({ system: "S" }, "anthropic", { preset: "off" })
  assert.equal(out, undefined)
  assert.equal(ctx.state.purge.injected, false)
})

test("injection is skipped for a body at/over the char guard", () => {
  const ctx = { protocol: "chat", model: "m", agent: "x", options: { preset: "unrestricted", boost: true }, state: {} }
  const body = { model: "m", messages: [{ role: "user", content: "x".repeat(900000) }] }
  let out
  const logs = withLog(() => { out = m.onRequest(body, ctx) })
  assert.equal(out, undefined, "no rewrite when it would only grow a huge prompt")
  assert.equal(ctx.state.purge.injected, false)
  assert.equal(body.messages[0].role, "user", "the request is left exactly as it came")
  assert.ok(logs.some((l) => l.includes("injection skipped")))
})

test("a normal request still gets the preset + boost", () => {
  const ctx = { protocol: "chat", model: "m", agent: "x", options: { preset: "unrestricted", boost: true }, state: {} }
  const out = m.onRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }, ctx)
  assert.ok(out && out.messages[0].role === "system" && out.messages[0].content.length > 600)
  assert.equal(ctx.state.purge.injected, true)
})

test("the guard is configurable, and detection still runs when it trips", () => {
  const ctx = { protocol: "chat", model: "m", agent: "x", options: { preset: "unrestricted", injectMaxBodyChars: 1000, refusalDetect: true }, state: {} }
  assert.equal(m.onRequest({ model: "m", messages: [{ role: "user", content: "x".repeat(2000) }] }, ctx), undefined)
  assert.equal(ctx.state.purge.injected, false)
  const logs = withLog(() => {
    m.onResponse({ model: "m", choices: [{ message: { role: "assistant", content: "我不能帮你做这个。" } }] }, ctx)
  })
  assert.ok(logs.some((l) => l.includes("mode=whole")), "refusal detection survives a skipped injection")
})
