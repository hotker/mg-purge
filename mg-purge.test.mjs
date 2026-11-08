// bun test entry — self-contained: no dependency on magpie-community's
// scripts/middleware.mjs, so `bun test` works when the plugin is installed
// standalone into magpie. Uses the bundled Node harness (test-harness.mjs),
// same call order the gateway uses. Under plain Node run `node --test run-cases.mjs`.
import { test } from "bun:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as mod from "./mg-purge.middleware.js"
import { run } from "./test-harness.mjs"

const dir = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))

for (const c of cases) {
  test(c.name, async () => {
    const got = await run(mod, c)
    if (c.reject) {
      assert.equal(got.reject?.status, c.reject.status)
      if (c.reject.message) assert.ok(String(got.reject?.message ?? "").includes(c.reject.message))
    } else {
      assert.equal(got.reject, undefined)
      if (c.request && !c.expect_request_contains) assert.deepEqual(got.request, c.expect_request ?? c.request)
    }
    if (c.expect_request_contains) {
      for (const [k, needles] of Object.entries(c.expect_request_contains))
        for (const n of needles) assert.ok(String(got.request[k] ?? "").includes(n), `${k} missing ${n}`)
    }
    if (c.events && !c.expect_events_contains) assert.deepEqual(got.events, c.expect_events ?? c.events.map((e) => e.data))
    if (c.expect_events_contains) {
      for (let i = 0; i < c.expect_events_contains.length; i++) {
        const text = JSON.stringify(got.events[i])
        for (const n of c.expect_events_contains[i]) assert.ok(text.includes(n), `event ${i} missing ${n}`)
      }
    }
    if (c.response) assert.deepEqual(got.response, c.expect_response ?? c.response)
  })
}

// ── regressions also run here so `bun test` counts them (bun can't run the
//    node:test file unit-checks.test.mjs; that file is what `node --test` uses) ──
function withLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.map(String).join(" "))
  try { fn() } finally { console.log = orig }
  return lines
}
function reqCtx(opts, agent) {
  const c = { protocol: "anthropic", model: "", agent, options: { preset: "off", stripThink: false, refusalRetry: true, ...opts }, state: {} }
  mod.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c)
  return c
}

test("excludeAgents: reply not stripped for an excluded agent", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "claude", options: { preset: "off", stripThink: true, excludeAgents: ["claude"] }, state: {} }
  mod.onRequest({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx)
  const body = { content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(mod.onResponse(body, ctx), undefined)
  assert.equal(body.content[0].text, "<think>hm</think>Hello")
})

test("onResponse strips when the reply's model differs from the request", () => {
  const ctx = { protocol: "anthropic", model: "", agent: "codex", options: { preset: "off", stripThink: true, models: ["deepseek"] }, state: {} }
  mod.onRequest({ model: "deepseek-chat", messages: [{ role: "user", content: "x" }] }, ctx)
  const body = { model: "group/jarivs", content: [{ type: "text", text: "<think>hm</think>Hello" }] }
  assert.equal(mod.onResponse(body, ctx).content[0].text, "Hello")
})

test("Chinese refusal 「我不能帮你做这个。」 is detected", () => {
  const c = reqCtx({}, undefined)
  const logs = withLog(() => mod.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } }, c))
  assert.ok(logs.some((l) => l.includes("refusal opening detected")))
})

test("gemini streamed parts get think stripped", () => {
  const ctx = { protocol: "gemini", model: "", options: { preset: "off", stripThink: true, refusalRetry: false }, state: {} }
  mod.onRequest({ model: "m", contents: [{ role: "user", parts: [{ text: "x" }] }] }, ctx)
  let text = ""
  for (const chunk of ["<thi", "nk>hm</think>\nHello"]) {
    const ev = { candidates: [{ index: 0, content: { parts: [{ text: chunk }] } }] }
    text += (mod.onEvent(ev, ctx) || ev).candidates[0].content.parts[0].text
  }
  assert.equal(text, "Hello")
})

test("the module exports no events whitelist", () => {
  assert.equal(mod.events, undefined)
})

test("error replies are logged with status, models, injected flag (no prompt)", () => {
  const ctx = { protocol: "chat", model: "", agent: "codex", status: 502, options: { preset: "unrestricted", stripThink: false }, state: {} }
  mod.onRequest({ model: "deepseek-chat", messages: [{ role: "user", content: "SECRET" }] }, ctx)
  const logs = withLog(() => mod.onResponse({ model: "group/jarivs", error: { type: "upstream_error" } }, ctx))
  const line = logs.find((l) => l.includes("[mg-purge] error 502"))
  assert.ok(line && line.includes("injected=yes"))
  assert.ok(!line.includes("SECRET"))
})
