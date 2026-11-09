// mg-purge — 破甲 for magpie.
//
// dsh-purge (github.com/kingcharleslzy-ai/dsh-purge) works by patching the DSH
// *host*: 86 host patches that touch approval, sandbox, the agent loop and the
// system prompt. A magpie gateway middleware sits one layer lower — it can only
// see and rewrite the text agents send to the model and the text the model
// sends back. It cannot touch approval policy, the sandbox, or the agent loop.
//
// So mg-purge ports the ONE layer of dsh-purge that lives at the gateway: the
// prompt-injection layer. Everything here is a faithful translation of that
// layer's behavior:
//
//   1. prompt    — inject the operator-priority system prompt of a named preset
//                  into the request, in each API's own place for it, at head or
//                  tail, override on/off, filtered by agent/model (dsh-purge's
//                  preset persona + `excludePresets`).
//   2. boost     — append the <dsh_boost> tail block last, so it survives long
//                  contexts and multi-turn drift (dsh-purge `boost.js`).
//   3. refusal   — DETECT a short, contentless refusal at the opening of the
//                  reply and log it. The gateway cannot re-run the model and
//                  must not edit a reply already streaming to the operator, so
//                  there is no retry and no nudge spliced in (dsh-purge's
//                  `refusal-retry.js` re-runs on the DSH host; here that layer
//                  has no gateway equivalent). The option is therefore named
//                  `refusalDetect`; the old `refusalRetry` key is still accepted
//                  as a deprecated alias and only ever detects.
//                  + refusalPatterns lets an operator extend the detector.
//   4. think     — strip a leading <think>…</think> block so the agent doesn't
//                  carry it in history (dsh-purge's clean-reply behavior),
//                  ported from magpie-community's middleware-think-tags.
//
// The middleware does not export `events`, so the gateway hands every streamed
// event to onEvent (chat's SSE chunks carry no `type`, which a whitelist would
// drop). The gateway calls the hooks per its contract (250ms onRequest/onResponse,
// 50ms per event, fail open).
//
// Config lives in the plugin's `options` in magpie's plugins.json:
//
//   { "preset": "unrestricted", "position": "append", "override": true,
//     "boost": true, "refusalDetect": true, "stripThink": true,
//     "agents": [], "excludeAgents": [], "models": [],
//     "systemPrompt": "", "refusalPatterns": [] }
//
// Leave `systemPrompt` / `refusalPatterns` empty to use the built-in packs (see
// presets/packs.json). A non-empty value overrides the preset. (`refusalRetry`
// is accepted as a deprecated alias of `refusalDetect`; an older `nudge` key is
// still accepted but unused — the refusal path only detects and logs, it never
// splices text into the reply.)

import PACKS_NS from "./presets/packs.mjs"
const PACKS = PACKS_NS && PACKS_NS.default ? PACKS_NS.default : PACKS_NS

// ── refusal detection ───────────────────────────────────────────────────────

// Refusal openers. A match is a refusal only inside the short, contentless gate
// in looksLikeRefusal — dense decline phrasing, not a passing "I'm sorry" inside
// a full answer. The AI-persona and bare "sorry" forms are anchored to the start
// and to a decline, so a short helpful reply that opens "作为一个 AI，我建议…"
// does not read as one.
export const REFUSAL_PATTERNS = [
  // English declines that open the reply
  /^I (?:can(?:'|’)?t|won(?:'|’)?t|am unable to|must decline)\b(?! help but)/i,
  /^I(?:'|’)m sorry, (?:but )?I (?:can(?:'|’)?t|cannot|am unable|won(?:'|’)?t)/i,
  /^(?:cannot|can't|won't|I cannot|I can't|I won't) (?:help|assist|provide|comply|give|do|share|write|reproduce|print)\b(?! (?:but|to notice))/i,
  /^(?:No|Nope)\b.{0,40}?(?:I (?:can(?:'|’)?t|won(?:'|’)?t|cannot)|not (?:going to|able to)|refuse)/i,
  /^(?:I(?:'|’)m not (?:going to|able to)|I refuse to)\b/i,
  // Chinese declines that open the reply
  /^我(?:不能|无法|不会|不)(?:协助|帮助|提供|满足|帮你|替你|给你|给出|打印|复述|参与)/,
  /^抱歉[，,]?我(?:不能|无法|帮不了|做不到|不会)/,
  /^这超出了我的(?:能力|范围)/,
  /^(?:作为|身为)(?:一个)?(?:AI|人工智能|语言模型)[，,].{0,20}(?:不能|无法|不能协助|无法协助)/,
  /^这(?:一)?步我(?:不做|不参与|不帮)/,
]

// Common Chinese declines that do NOT lead with 我/抱歉 — "无法提供…",
// "这是诈骗话术，我不会写。" Guarded by LOOSE_MAX and EXPLAIN below, because
// the same opening also starts a legitimate answer ("无法提供服务的原因…").
const LOOSE_REFUSAL_PATTERNS = [
  /^(?:无法|不能|不会|不予)(?:提供|协助|帮助|满足|告知|给出|告诉)/,
  /^这(?:是|属于|种)[^。\n]{0,20}(?:我不会写|我不做|我不能|无法提供|不能提供|不提供)/,
]
const LOOSE_MAX = 160
const EXPLAIN = /(?:原因|因为|由于|是指|指的是|通常|一般|常见|取决于)/

// A refusal is short and contentless: the operator gets a decline, not an
// answer. So a match only counts when it opens the text (first 120 chars) AND
// the whole reply is small — a long answer that merely *says* "作为 AI" or
// "I'm sorry, but" while still delivering real content is not a refusal.
const REFUSAL_HEAD = 120
const REFUSAL_MAX = 300

// An offer of real help after the decline makes it an answer, not a refusal.
// Covers "but here's…/here is…/I can give/show/provide…/let me…" and Chinese
// "…但/不过/我可以给你/以下是/这里…". Also catches a code fence or a numbered list,
// which a genuine contentless refusal never carries.
const OFFER = /(?:here(?:'|’)?s|here (?:is|are)|I (?:can|will|could) (?:give|show|provide|help|walk|write|share)|let me|below is|the (?:corrected|fixed|right) (?:one|version|query|code)|(?:但|不过|我可以|这里|下面|以下)|我可以(?:给你|帮你|提供|演示)|下面(?:是|给|演示)|以下(?:是|为)|\n\s*```|\n\s*\d+\.\s)/i

function looksLikeRefusal(text, extra) {
  const raw = String(text || "").trim()
  if (!raw) return false
  // too much for a refusal: it carried real content, so it is an answer
  if (raw.length > REFUSAL_MAX) return false
  const head = raw.slice(0, REFUSAL_HEAD)
  // a mention of injection/jailbreak is discussion, not a refusal
  if (/提示词注入|越狱|指令注入|prompt[ _-]?injection|jailbreak/i.test(head)) return false
  // a decline wrapped around actual help (or a code block / numbered list) is an answer
  if (OFFER.test(raw)) return false
  const pats = Array.isArray(extra) && extra.length ? [...REFUSAL_PATTERNS, ...compileUserPatterns(extra)] : REFUSAL_PATTERNS
  // Looser openers, only for a short text that is not an explanation of why
  // something cannot be provided.
  if (raw.length <= LOOSE_MAX && !EXPLAIN.test(head) && LOOSE_REFUSAL_PATTERNS.some((re) => re.test(head))) return true
  return pats.some((re) => {
    try { return re.test(head) } catch { return false }
  })
}

function compileUserPatterns(list) {
  const out = []
  for (const p of list) {
    if (typeof p === "string" && p) {
      try { out.push(new RegExp(p, "i")) } catch { /* skip a bad pattern */ }
    }
  }
  return out
}

// ── thinking-tag bridge (from middleware-think-tags) ─────────────────────────
//
// A per-tag stripper keeps its carry across streamed chunks, so a block split
// across events is still removed. Only a block that *opens* the text is taken;
// a tag the model writes later (in code, say) stays.

const TAG_OPEN = "<think>"
const TAG_CLOSE = "</think>"

function newStripper() {
  return { inside: false, carry: "", started: false }
}

// strip returns the visible text of chunk `t` under state `st`.
function strip(st, t) {
  if (typeof t !== "string") return t
  let s = st.carry + t
  st.carry = ""
  let out = ""
  while (s.length) {
    if (!st.started) {
      // not yet inside a thinking block: only a leading opening tag starts one
      const lead = s.match(/^\s*/)[0]
      const rest = s.slice(lead.length)
      if (rest.startsWith(TAG_OPEN)) {
        out += lead
        st.inside = true
        st.started = true
        s = rest.slice(TAG_OPEN.length)
        continue
      }
      // a partial opening tag at the very start — hold it back
      if (TAG_OPEN.startsWith(rest) && rest.length < TAG_OPEN.length && lead.length === 0) {
        st.carry = s
        return out
      }
      // text doesn't open with a thinking block: free it
      st.started = true
    }
    if (st.inside) {
      const idx = s.indexOf(TAG_CLOSE)
      if (idx >= 0) {
        st.inside = false
        s = s.slice(idx + TAG_CLOSE.length)
        // skip one blank line the block may have left
        s = s.replace(/^\n{1,2}/, "")
        continue
      }
      // hold back a possible partial close tag
      const hold = partialCloseSuffix(s)
      if (hold) {
        st.carry = hold
        return out
      }
      return out // all inside thinking, nothing visible
    }
    out += s
    return out
  }
  return out
}

function partialCloseSuffix(s) {
  const max = Math.min(TAG_CLOSE.length - 1, s.length)
  for (let n = max; n > 0; n--) {
    if (TAG_CLOSE.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
  }
  return ""
}

// stripWhole is strip for a complete (non-streamed) text.
function stripWhole(t) {
  if (typeof t !== "string") return t
  const st = newStripper()
  let out = strip(st, t)
  if (st.inside) return out
  out += st.carry
  return out
}

// ── prompt injection, per protocol ──────────────────────────────────────────

function injectPrompt(body, prompt, override, before, ctx) {
  if (!prompt) return body
  switch (ctx.protocol) {
    case "anthropic": return injectAnthropic(body, prompt, override, before)
    case "chat": return injectChat(body, prompt, override, before)
    case "responses": return injectResponses(body, prompt, override, before)
    case "gemini": return injectGemini(body, prompt, override, before)
    default: return injectChat(body, prompt, override, before)
  }
}

function injectAnthropic(body, prompt, over, before) {
  const s = body.system
  if (s === undefined || s === null || s === "" || (Array.isArray(s) && !s.length)) {
    body.system = prompt
    return body
  }
  if (!over) return body
  if (typeof s === "string") {
    body.system = before ? prompt + "\n" + s : s + "\n" + prompt
  } else if (Array.isArray(s)) {
    const block = { type: "text", text: prompt }
    if (before) s.unshift(block)
    else s.push(block)
  }
  return body
}

function injectChat(body, prompt, over, before) {
  if (!Array.isArray(body.messages)) return body
  const first = body.messages[0]
  if (!first || (first.role !== "system" && first.role !== "developer")) {
    body.messages.unshift({ role: "system", content: prompt })
    return body
  }
  if (!over) return body
  if (typeof first.content === "string") {
    first.content = before ? prompt + "\n" + first.content : first.content + "\n" + prompt
  } else if (Array.isArray(first.content)) {
    const part = { type: "text", text: prompt }
    if (before) first.content.unshift(part)
    else first.content.push(part)
  }
  return body
}

function injectResponses(body, prompt, over, before) {
  const s = body.instructions
  if (typeof s !== "string" || !s) {
    body.instructions = prompt
    return body
  }
  if (!over) return body
  body.instructions = before ? prompt + "\n" + s : s + "\n" + prompt
  return body
}

function injectGemini(body, prompt, over, before) {
  const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction"
  const s = body[key]
  if (!s || !Array.isArray(s.parts) || !s.parts.length) {
    body[key] = { parts: [{ text: prompt }] }
    return body
  }
  if (!over) return body
  if (before) s.parts.unshift({ text: prompt })
  else s.parts.push({ text: prompt })
  return body
}

// ── resolved config for one request ─────────────────────────────────────────

function resolve(o) {
  const packs = PACKS && PACKS.presets ? PACKS.presets : {}
  const presetKey = typeof o.preset === "string" ? o.preset : "unrestricted"
  const pack = presetKey === "off" ? { prompt: "" } : (packs[presetKey] || packs.unrestricted || { prompt: "", name: presetKey })

  let prompt = typeof o.systemPrompt === "string" && o.systemPrompt ? o.systemPrompt : pack.prompt || ""
  const wantBoost = o.boost !== false && typeof pack.prompt === "string" && presetKey !== "off"
  if (wantBoost && PACKS && typeof PACKS.boost === "string" && PACKS.boost) {
    prompt = prompt ? prompt + "\n\n" + PACKS.boost : PACKS.boost
  }

  const refusalPatterns = Array.isArray(o.refusalPatterns) ? o.refusalPatterns : []

  return { prompt, refusalPatterns }
}

function appliesTo(body, ctx, o) {
  if (Array.isArray(o.agents) && o.agents.length && !o.agents.includes(ctx.agent)) return false
  if (Array.isArray(o.excludeAgents) && o.excludeAgents.length && o.excludeAgents.includes(ctx.agent)) return false
  if (Array.isArray(o.models) && o.models.length) {
    const model = String(body && body.model != null ? body.model : ctx.model || "")
    if (!o.models.some((m) => typeof m === "string" && model.startsWith(m))) return false
  }
  return true
}

// ── hooks ────────────────────────────────────────────────────────────────────

// safeLog: never let logging throw into a request, and cap the rate so a storm
// of malformed bodies can't flood magpie's log (at most ~60 lines a minute,
// matching magpie's own middleware log budget).
let _logWindow = 0, _logCount = 0
// NOTE: the `refusalRetry` -> `refusalDetect` rename is documented in the README
// and the panel, deliberately WITHOUT a runtime warning. A middleware runs in
// magpie's sandbox: it may import only files beside it (no node:fs), and each
// call runs in its own isolate (a module-level flag and globalThis both reset),
// so "warn once" is impossible — any warning repeats on every single request.
function safeLog(line) {
  try {
    const now = Date.now()
    if (now - _logWindow > 60000) { _logWindow = now; _logCount = 0 }
    if (_logCount++ < 60) console.log(line)
  } catch { /* ignore */ }
}

export function onRequest(body, ctx) {
  const o = (ctx && ctx.options) || {}
  if (!body || typeof body !== "object") return
  try {
    if (!appliesTo(body, ctx, o)) return

    const { prompt, refusalPatterns } = resolve(o)
    const override = o.override !== false
    const before = o.position === "prepend"
    const out = prompt ? injectPrompt(body, prompt, override, before, ctx) : body

    // per-request state the stream hooks share (one runtime per request)
    // `refusalDetect` is the honest name: this hook cannot re-run the model, so
    // it only detects and logs. `refusalRetry` is a deprecated alias that maps
    // to the same switch (either key set to false disables detection).
    ctx.state.purge = {
      refusalDetect: o.refusalDetect !== false && o.refusalRetry !== false,
      stripThink: o.stripThink !== false,
      refusalPatterns,
      decided: false,
      buffered: "",
      strippers: {}, // per-stream-key tag stripper state, kept for the request
      injected: !!prompt, // did this request carry the injection (for error logs)
    }
    return prompt ? out : undefined
  } catch (err) {
    // fail open: a bad body must never break the request — leave it as it came
    safeLog(`[mg-purge] onRequest error, request left unchanged: ${err && err.message ? err.message : err}`)
    return undefined
  }
}

// Refusal signals are watched in the opening text only. The gateway streams a
// reply and cannot re-run the model, so this hook never rewrites what the
// operator sees: a matched opening is logged to magpie's log and the reply is
// left exactly as the model sent it. Nothing is spliced in — an nudge in the
// reply would leak instructions into the user's visible text and then back into
// history next turn. The strip runs on the same chunks, keeping each stream
// key's carry in ctx.state so a block split across events is still removed.
export function onEvent(ev, ctx) {
  const st = ctx && ctx.state && ctx.state.purge
  if (!st) return
  try {
    const texts = eventTexts(ev)
    if (!texts.length) return

    // thinking strip on the same chunks
    let changed = false
    if (st.stripThink) {
      for (const slot of texts) {
        if (typeof slot.obj[slot.key] !== "string") continue
        const sk = slot.streamKey
        if (!st.strippers[sk]) st.strippers[sk] = newStripper()
        const u = strip(st.strippers[sk], slot.obj[slot.key])
        if (u !== slot.obj[slot.key]) {
          slot.obj[slot.key] = u
          changed = true
        }
      }
    }

    // refusal watch: detect on the opening text only, count it, never edit the reply.
    // Test every chunk (cheap), and stop watching once a refusal matched, once the
    // opening is long enough that no contentless refusal fits, or at a terminator —
    // so a short refusal with no punctuation ("No, I won't") is caught on chunk 1.
    if (st.refusalDetect && !st.decided) {
      st.buffered += texts.map((x) => (typeof x.obj[x.key] === "string" ? x.obj[x.key] : "")).join("")
      if (looksLikeRefusal(st.buffered, st.refusalPatterns)) {
        st.decided = true
        safeLog(`[mg-purge] refusal opening detected (agent=${ctx.agent || "?"} model=${ctx.model || "?"})`)
      } else {
        // Trim before testing for a terminator: models often open with "\n\n",
        // and a whitespace-only prefix must not end the watch before the text
        // arrives (that silently missed real refusals).
        const seen = st.buffered.trim()
        if (st.buffered.length > REFUSAL_MAX || (seen && /[。！？\n]/.test(seen))) {
          // too long to be a contentless refusal, or the reply carried on: not one
          st.decided = true
        }
      }
    }

    return changed ? ev : undefined
  } catch (err) {
    safeLog(`[mg-purge] onEvent error, event left unchanged: ${err && err.message ? err.message : err}`)
    return undefined
  }
}

export function onResponse(body, ctx) {
  const o = (ctx && ctx.options) || {}
  if (!body || typeof body !== "object") return

  // 502 / error diagnostics: a non-2xx reply that reaches onResponse is logged
  // once, with what decides its cause — status, the agent/model the request
  // named, the reply's own model (magpie rewrites it), protocol, and how big
  // the injected prompt was. This is how the earlier 502s get told apart:
  // provider rejecting a long prompt vs a content filter vs a real upstream
  // fault. Opt out with logErrors:false. Never logs a prompt or a key.
  if (typeof ctx.status === "number" && ctx.status >= 400 && o.logErrors !== false) {
    try {
      const st = ctx.state && ctx.state.purge
      const errType = body && ((body.error && (body.error.type || body.error.code)) || body.type || "")
      safeLog(
        `[mg-purge] error ${ctx.status} protocol=${ctx.protocol || "?"} agent=${ctx.agent || "?"}` +
        ` reqModel=${ctx.model || "?"} replyModel=${(body && body.model) || "-"}` +
        ` injected=${st && st.injected ? "yes" : "no"} errType=${errType || "-"}`,
      )
    } catch { /* logging must never break a request */ }
  }

  try {
    // onRequest only ever writes ctx.state.purge after appliesTo passed. So its
    // presence is the truthful "this request passed the agent/model filter"
    // signal — safer than re-running appliesTo on the reply's model field, which
    // magpie rewrites to the request name (e.g. "group/…") and could drift to the
    // real served model and silently stop stripping while the stream path keeps
    // stripping. Filter once, at the request; the reply follows it.
    if (!ctx.state || !ctx.state.purge) return
    const st = ctx.state.purge

    // Whole-reply refusal detection. The streaming path watches chunks in
    // onEvent; a non-streamed reply only ever reaches onResponse, so without
    // this the detector silently missed every whole-reply request — while the
    // README promised both paths. Detect on the visible text (a leading think
    // block stripped) so the opening check sees what the operator sees.
    if (st.refusalDetect && !st.decided && !(typeof ctx.status === "number" && ctx.status >= 400)) {
      try {
        const visible = stripWhole(replyText(body))
        st.decided = true
        if (looksLikeRefusal(visible, st.refusalPatterns)) {
          safeLog(`[mg-purge] refusal opening detected (agent=${ctx.agent || "?"} model=${ctx.model || "?"} mode=whole)`)
        }
      } catch { /* detection must never break a reply */ }
    }

    const wantStrip = o.stripThink !== false
    if (!wantStrip) return
    let changed = false
    const fix = (obj, k) => {
      if (obj && typeof obj[k] === "string") {
        const u = stripWhole(obj[k])
        if (u !== obj[k]) {
          obj[k] = u
          changed = true
        }
      }
    }
    if (Array.isArray(body.content)) for (const b of body.content) if (b && b.type === "text") fix(b, "text")
    if (Array.isArray(body.choices)) for (const c of body.choices) fix(c && c.message, "content")
    if (Array.isArray(body.output)) {
      for (const it of body.output) {
        if (it && it.type === "message" && Array.isArray(it.content)) {
          for (const p of it.content) if (p && p.type === "output_text") fix(p, "text")
        }
      }
    }
    if (Array.isArray(body.candidates)) {
      for (const c of body.candidates) {
        if (c && c.content && Array.isArray(c.content.parts)) for (const p of c.content.parts) fix(p, "text")
      }
    }
    return changed ? body : undefined
  } catch (err) {
    safeLog(`[mg-purge] onResponse error, reply left unchanged: ${err && err.message ? err.message : err}`)
    return undefined
  }
}

// The visible text of a whole (non-streamed) reply, by protocol body shape.
// Used by onResponse so refusal detection covers the non-streaming path too.
function replyText(body) {
  const parts = []
  const push = (obj, k) => {
    if (obj && typeof obj[k] === "string") parts.push(obj[k])
  }
  if (Array.isArray(body.content)) for (const b of body.content) if (b && b.type === "text") push(b, "text")
  if (Array.isArray(body.choices)) for (const c of body.choices) push(c && c.message, "content")
  if (Array.isArray(body.output)) {
    for (const it of body.output) {
      if (it && it.type === "message" && Array.isArray(it.content)) {
        for (const p of it.content) if (p && p.type === "output_text") push(p, "text")
      }
    }
  }
  if (Array.isArray(body.candidates)) {
    for (const c of body.candidates) {
      if (c && c.content && Array.isArray(c.content.parts)) for (const p of c.content.parts) push(p, "text")
    }
  }
  return parts.join("")
}

// The streamed chunks that carry visible text, by protocol event shape.
function eventTexts(ev) {
  const out = []
  if (!ev || typeof ev !== "object") return out
  if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
    out.push({ obj: ev.delta, key: "text", streamKey: "a" + ev.index })
  } else if (ev.type === "response.output_text.delta") {
    out.push({ obj: ev, key: "delta", streamKey: "r" + ev.item_id + ":" + ev.content_index })
  } else if (Array.isArray(ev.choices)) {
    for (const c of ev.choices) if (c && c.delta && typeof c.delta.content === "string") out.push({ obj: c.delta, key: "content", streamKey: "c" + c.index })
  } else if (Array.isArray(ev.candidates)) {
    for (const c of ev.candidates) {
      if (c && c.content && Array.isArray(c.content.parts)) for (const p of c.content.parts) if (p && typeof p.text === "string") out.push({ obj: p, key: "text", streamKey: "g" + (c.index ?? 0) })
    }
  }
  return out
}
