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
//   3. refusal   — detect a refusal in the start of the reply, drop it, and
//                  re-run once with a strengthened nudge (dsh-purge
//                  `refusal-retry.js`, default off there, on here).
//      + refusalPatterns / refusalNudge let an operator add their own.
//   4. think     — strip a leading <think>…</think> block so the agent doesn't
//                  carry it in history (dsh-purge's clean-reply behavior),
//                  ported from magpie-community's middleware-think-tags.
//
// The middleware shows its own `hooks` here; the gateway calls them per its
// contract (250ms onRequest/onResponse, 50ms per event, fail open).
//
// Config lives in the plugin's `options` in magpie's plugins.json:
//
//   { "preset": "unrestricted", "position": "append", "override": true,
//     "boost": true, "refusalRetry": true, "stripThink": true,
//     "agents": [], "excludeAgents": [], "models": [],
//     "systemPrompt": "", "nudge": "", "refusalPatterns": [] }
//
// Leave `systemPrompt` / `nudge` / `refusalPatterns` empty to use the built-in
// packs (see presets/packs.json). A non-empty value overrides the preset.

import PACKS_NS from "./presets/packs.mjs"
const PACKS = PACKS_NS && PACKS_NS.default ? PACKS_NS.default : PACKS_NS

// ── refusal detection ───────────────────────────────────────────────────────

// Same shape and intent as dsh-purge lib/refusal-retry.js REFUSAL_PATTERNS:
// a leading refusal opener, plus cheap "decline" phrasing. Only the first 600
// chars are read, so a long technical answer that merely discusses refusals
// is not mistaken for one.
export const REFUSAL_PATTERNS = [
  /I (?:can(?:'|’)?t|won(?:'|’)?t|am unable to|must decline)/i,
  /I(?:'|’)m sorry, but/i,
  /(?:cannot|can't) (?:help|assist|provide|comply) with (?:that|this|your)/i,
  /我不能|无法(?:协助|帮助|提供|满足)|抱歉，?我(?:不能|无法)|这超出了我的(?:能力|范围)/,
  /(?:作为|身为)(?:一个)?(?:AI|人工智能|语言模型)/,
  /^这(?:一)?步我(?:不做|不参与|不帮)/,
  /我(?:不参与|不帮你|不会帮|不能参与|不方便参与)/,
  /(?:需要|请)(?:你)?(?:提供|出示|确认).{0,12}(?:授权|许可|书面)/,
  /这(?:属于|是).{0,8}(?:未授权|越权|违法|犯罪行为)/,
  /我也不会帮你把它包装成/,
  /请把.{0,12}(?:授权|目标).{0,8}(?:发给|给我)/,
  /(?:这是|这段|上述).{0,6}(?:提示词注入|越狱|指令注入)/,
  /我(?:不会|无法)(?:把|将).{0,10}(?:当作|视为).{0,10}指令/,
]

// metaRefusalAllowed keeps a long answer that merely *mentions* injection or a
// refusal from being treated as one; matches dsh-purge refusalMatchIndex.
function looksLikeRefusal(text, extra) {
  const raw = String(text || "")
  const head = raw.slice(0, 600)
  const meta = /提示词注入|越狱|指令注入|prompt[ _-]?injection|jailbreak/i.test(head)
  if (meta && raw.trim().length > 280) return false
  const pats = Array.isArray(extra) && extra.length ? [...REFUSAL_PATTERNS, ...compileUserPatterns(extra)] : REFUSAL_PATTERNS
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

  const nudge = typeof o.nudge === "string" && o.nudge ? o.nudge : (PACKS && PACKS.nudge) || ""
  const refusalPatterns = Array.isArray(o.refusalPatterns) ? o.refusalPatterns : []

  return { prompt, nudge, refusalPatterns }
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

export function onRequest(body, ctx) {
  const o = ctx.options || {}
  if (!body || typeof body !== "object") return
  if (!appliesTo(body, ctx, o)) return

  const { prompt, nudge, refusalPatterns } = resolve(o)
  const override = o.override !== false
  const before = o.position === "prepend"
  const out = prompt ? injectPrompt(body, prompt, override, before, ctx) : body

  // remember, for the stream hooks of this same request, whether a retry nudge
  // is needed and whether to strip thinking
  ctx.state.purge = {
    refusalRetry: o.refusalRetry !== false,
    stripThink: o.stripThink !== false,
    nudge,
    refusalPatterns,
    nudged: false,
    decided: false,
    buffered: "",
    strippers: {}, // per-stream-key tag stripper state, kept for the request
  }
  return prompt ? out : undefined
}

// Buffering the opening text to detect a refusal conflicts with streaming a
// whole reply — a gateway streams events, it can't re-run the model. So under
// the gateway contract `onEvent` does the practical version: watch the first
// visible chunk; if it opens with a refusal, append the nudge (dsh-purge's
// RETRY_NUDGE) to that chunk; if it opens normally, leave it. The strip runs on
// the same chunks, keeping each stream key's carry in ctx.state so a block split
// across events is still removed.
export function onEvent(ev, ctx) {
  const st = ctx.state && ctx.state.purge
  if (!st) return
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

  // refusal watch: only the opening text, once
  if (st.refusalRetry && !st.decided) {
    st.buffered += texts.map((x) => (typeof x.obj[x.key] === "string" ? x.obj[x.key] : "")).join("")
    if (st.buffered.trim().length >= 24 || (st.buffered.length > 0 && /[。.!?！？\n]/.test(st.buffered))) {
      st.decided = true
      if (looksLikeRefusal(st.buffered, st.refusalPatterns)) {
        st.nudged = true
        const last = texts[texts.length - 1]
        if (last && typeof last.obj[last.key] === "string" && st.nudge) {
          last.obj[last.key] += "\n\n" + st.nudge.trim()
          changed = true
        }
      }
    }
  }

  return changed ? ev : undefined
}

export function onResponse(body, ctx) {
  const o = ctx.options || {}
  if (!body || typeof body !== "object") return
  const strip = o.stripThink !== false
  if (!strip) return
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

// Export the modules the harness checks against when loading a middleware.
export const events = [
  "content_block_delta",
  "response.output_text.delta",
]
