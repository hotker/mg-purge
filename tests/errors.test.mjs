// Error-path diagnostics (a 5xx reply logged once, never the prompt) and the
// A/B harness's URL builder.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as m from "../mg-purge.middleware.js"
import { withLog } from "./helpers/kit.mjs"
import { chatUrl } from "../scripts/endpoint.mjs"

test("error replies are logged with status, models, injected flag", () => {
  const ctx = { protocol: "chat", model: "", agent: "codex", status: 502, options: { preset: "unrestricted", stripThink: false }, state: {} }
  m.onRequest({ model: "example-model", messages: [{ role: "user", content: "SECRET PROMPT" }] }, ctx)
  const body = { model: "group/test", error: { type: "upstream_error" } }
  const logs = withLog(() => m.onResponse(body, ctx))
  const line = logs.find((l) => l.includes("[mg-purge] error 502"))
  assert.ok(line, "should log the 502")
  assert.ok(line.includes("injected=yes"))
  assert.ok(!line.includes("SECRET PROMPT"), "must not log the prompt")
})

test("logErrors:false silences the error log", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", status: 502, options: { preset: "unrestricted", stripThink: false, logErrors: false }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => m.onResponse({ model: "x", error: { type: "t" } }, ctx))
  assert.equal(logs.filter((l) => l.includes("[mg-purge] error")).length, 0)
})

test("an error reply is not treated as a refusal", () => {
  const ctx = { protocol: "chat", model: "", agent: "x", status: 500, options: { preset: "off", stripThink: false, refusalDetect: true }, state: {} }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => m.onResponse({ choices: [{ message: { content: "我不能帮你做这个。" } }] }, ctx))
  assert.equal(logs.filter((l) => l.includes("refusal opening detected")).length, 0)
})

test("chatUrl never doubles /v1", () => {
  assert.equal(chatUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1/chat/completions")
  assert.equal(chatUrl("http://127.0.0.1:3425/"), "http://127.0.0.1:3425/v1/chat/completions")
  assert.equal(chatUrl("https://host/v1"), "https://host/v1/chat/completions")
  assert.equal(chatUrl("https://host/v1/"), "https://host/v1/chat/completions")
})
