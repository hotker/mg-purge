// Shared fixtures for the mg-purge suites. Every helper takes the module under
// test as an argument (or imports it once) so a suite never re-declares them.
import * as m from "../../mg-purge.middleware.js"

export { m }

/** Capture console.log while fn runs; returns the captured lines. */
export function withLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.map(String).join(" "))
  try { fn() } finally { console.log = orig }
  return lines
}

/** An anthropic ctx that already passed onRequest with `opts` overriding the base. */
export function reqCtx(opts = {}, agent = undefined) {
  const c = {
    protocol: "anthropic", model: "", agent,
    options: { preset: "off", stripThink: false, refusalRetry: true, ...opts },
    state: {},
  }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, c)
  return c
}

/** Feed one streamed text chunk and report whether a refusal was logged. */
export function detect(text, extraPatterns = []) {
  const ctx = {
    protocol: "anthropic", model: "", agent: "x",
    options: { preset: "off", stripThink: false, refusalRetry: true, refusalPatterns: extraPatterns },
    state: {},
  }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  let logged = false
  const orig = console.log
  console.log = () => { logged = true }
  try {
    m.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, ctx)
  } finally { console.log = orig }
  return logged
}

/** A whole (non-streamed) chat reply through onResponse; returns the log lines. */
export function wholeReply(text, opts = {}) {
  const ctx = {
    protocol: "chat", model: "", agent: "x", status: 200,
    options: { preset: "off", stripThink: false, refusalDetect: true, ...opts },
    state: {},
  }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const body = { choices: [{ index: 0, message: { role: "assistant", content: text } }] }
  return withLog(() => m.onResponse(body, ctx))
}

/** Run a streamed refusal with `opts`; returns the logs and the per-request state. */
export function runRefusal(opts) {
  const ctx = {
    protocol: "anthropic", model: "", agent: "x",
    options: { preset: "off", stripThink: false, ...opts },
    state: {},
  }
  m.onRequest({ model: "m", messages: [{ role: "user", content: "q" }] }, ctx)
  const logs = withLog(() => m.onEvent(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我不能帮你做这个。" } },
    ctx,
  ))
  return { logs, state: ctx.state.purge }
}
