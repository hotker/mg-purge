import { test } from "node:test"
import assert from "node:assert/strict"
import * as mod from "./mg-purge.middleware.js"
import { cases, run } from "./test-harness.mjs"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const dir = dirname(fileURLToPath(import.meta.url))
for (const c of cases(dir)) {
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
      const sub = c.expect_request_contains
      for (const [k, needles] of Object.entries(sub)) {
        for (const needle of needles) assert.ok(String(got.request[k] ?? "").includes(needle), `${k} missing ${needle}`)
      }
    }
    if (c.expect_events_contains) {
      for (let i = 0; i < c.expect_events_contains.length; i++) {
        const ev = got.events[i]
        const needles = c.expect_events_contains[i]
        const text = JSON.stringify(ev)
        for (const needle of needles) assert.ok(text.includes(needle), `event ${i} missing ${needle}`)
      }
    }
    if (c.events && !c.expect_events_contains) assert.deepEqual(got.events, c.expect_events ?? c.events.map((e) => e.data))
    if (c.response) assert.deepEqual(got.response, c.expect_response ?? c.response)
  })
}
