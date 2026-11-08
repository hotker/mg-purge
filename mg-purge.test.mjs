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
