// A Node-only stand-in for magpie-community's scripts/middleware.mjs, so the
// cases run without Bun. Same call order the gateway uses.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/** The spec cases live next to this harness's parent: tests/cases.json */
export function cases() {
  return JSON.parse(readFileSync(join(here, "..", "cases.json"), "utf8"))
}

export async function run(mod, c) {
  const m = mod.default ?? mod
  let rejected
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
    options: c.options ?? {}, state: {},
    reject(status, message) { rejected ??= { status, message } },
  }
  const copy = (v) => JSON.parse(JSON.stringify(v))
  const out = {}
  if (c.request) {
    const r = m.onRequest ? await m.onRequest(copy(c.request), ctx) : undefined
    if (rejected) out.reject = rejected
    else out.request = r === undefined ? c.request : copy(r)
  }
  if (c.events) {
    out.events = []
    for (const e of c.events) {
      const wants = !m.events || (e.event && m.events.includes(e.event))
      if (typeof e.data !== "object" || !m.onEvent || !wants) {
        out.events.push(e.data)
        continue
      }
      const r = await m.onEvent(copy(e.data), ctx)
      if (r === null) continue
      out.events.push(r === undefined ? e.data : copy(r))
    }
  }
  if (c.response) {
    ctx.status = c.status ?? 200
    const r = m.onResponse ? await m.onResponse(copy(c.response), ctx) : undefined
    out.response = r === undefined ? c.response : copy(r)
  }
  return out
}
