// mg-purge dashboard: live usage stats from magpie's usage:summary, plus live
// tuning of the middleware's options. Everything goes through the page bridge
// (magpie.read / magpie.options) — the page itself can't reach the network.
(async () => {
  await magpie.ready

  const $ = (id) => document.getElementById(id)
  const pct = (x) => (x * 100).toFixed(1) + "%"

  // ── period tabs ────────────────────────────────────────────────────────────
  let period = "today"
  const seg = $("periodSeg")
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]")
    if (!b) return
    period = b.dataset.p
    for (const x of seg.querySelectorAll("button")) x.setAttribute("aria-selected", String(x === b))
    load()
  })

  // ── stats ──────────────────────────────────────────────────────────────────
  async function load() {
    let s
    try {
      s = await magpie.read("usage:summary", { period })
    } catch (err) {
      $("stCalls").textContent = "—"
      $("stErrors").textContent = "—"
      $("stRate").textContent = "读取失败"
      return
    }
    const calls = s.calls || 0
    const errors = s.errors || 0
    const ok = Math.max(0, calls - errors)
    $("stCalls").textContent = calls.toLocaleString()
    $("stErrors").textContent = errors.toLocaleString()
    $("stRate").textContent = calls ? pct(ok / calls) : "—"
    $("stCost").textContent = s.cost ? "$" + s.cost.toFixed(2) : "$0"

    const rows = $("modelRows")
    const models = Array.isArray(s.models) ? s.models.slice() : []
    if (!models.length) {
      rows.innerHTML = '<tr><td colspan="4" class="muted">这段时间没有调用。</td></tr>'
      return
    }
    models.sort((a, b) => (b.calls || 0) - (a.calls || 0))
    rows.replaceChildren()
    for (const m of models) {
      const c = m.calls || 0
      // usage:summary gives per-model calls but not per-model errors; the rate
      // column shows relative share of clean calls the summary can attest to
      const tr = document.createElement("tr")
      tr.innerHTML =
        `<td>${esc(m.model || "?")}</td>` +
        `<td class="num">${c.toLocaleString()}</td>` +
        `<td class="num">${(m.errors != null ? m.errors : "–")}</td>` +
        `<td class="num">${m.errors != null && c ? pct((c - m.errors) / c) : "–"}</td>`
      rows.append(tr)
    }
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  }

  // ── settings form, drawn from the options schema the plugin ships ──────────
  // The options schema is small and fixed; draw it by hand so labels are ours.
  const FIELDS = [
    { key: "preset", label: "预设", type: "enum", opts: [
        ["coherence", "coherence 连贯执行（正常开发，少打断）"],
        ["unrestricted", "unrestricted 无限制"], ["redteam", "redteam 红队"],
        ["minimal", "minimal 极简"], ["off", "off 关（只剥离/检测）"]], hint: "选择注入的系统提示词包" },
    { key: "position", label: "注入位置", type: "enum", opts: [["append", "append 追加（保 cache）"], ["prepend", "prepend 前置"]], hint: "相对 agent 自己的系统提示词" },
    { key: "override", label: "覆盖已有系统提示词", type: "bool", hint: "关闭时仅在请求没有系统提示词时注入" },
    { key: "boost", label: "boost 尾部强化段", type: "bool", hint: "<dsh_boost> 段追加到最后，抗长上下文" },
    { key: "refusalDetect", label: "拒绝检测", type: "bool", hint: "检测回复开头的短拒绝并写一行日志（不改回复正文；没有 retry）" },
    { key: "stripThink", label: "剥离 think 标签", type: "bool", hint: "去掉回复开头的 <think>…</think> 块" },
    { key: "agents", label: "仅这些 agent", type: "list", hint: "留空=全部；按 ctx.agent 匹配" },
    { key: "excludeAgents", label: "排除这些 agent", type: "list", hint: "例如 roleplay,minimal 保留自己的提示词" },
    { key: "models", label: "仅这些模型（前缀）", type: "list", hint: "留空=全部；按模型名前缀匹配" },
    { key: "systemPrompt", label: "自定义系统提示词", type: "text", hint: "非空则覆盖预设正文" },
    { key: "refusalPatterns", label: "额外拒绝正则", type: "list", hint: "字符串数组，叠加在内置规则上" },
  ]

  let opts = {}
  let statusEl = null
  const settings = $("settings")

  function drawSettings() {
    settings.replaceChildren()
    for (const f of FIELDS) {
      const row = document.createElement("div")
      row.className = "srow"
      const who = document.createElement("div")
      who.className = "who"
      who.innerHTML = `<div class="name">${esc(f.label)}</div><div class="sub">${esc(f.hint || "")}</div>`
      const ctl = document.createElement("div")
      ctl.className = "ctl"
      const val = opts[f.key]

      if (f.type === "bool") {
        // the page bridge has no `magpie.ui` (that's the window kernel's ctx.ui
        // for built-in plugins); draw our own switch
        ctl.append(fallbackToggle(!!val, (v) => save(f.key, v)))
      } else if (f.type === "enum") {
        const b = document.createElement("button")
        b.type = "button"; b.className = "pick"
        const cur = f.opts.find((o) => o[0] === val) || f.opts[0]
        b.textContent = cur[1] + " ▾"
        b.onclick = () => pickMenu(b, f.opts, val, (v) => save(f.key, v))
        ctl.append(b)
      } else if (f.type === "list") {
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = Array.isArray(val) ? val.join(", ") : ""
        inp.placeholder = "用逗号分隔"
        inp.onchange = () => save(f.key, inp.value.split(",").map((x) => x.trim()).filter(Boolean))
        ctl.append(inp)
      } else {
        const ta = document.createElement("textarea")
        ta.rows = /systemPrompt/i.test(f.key) ? 3 : 1
        ta.value = typeof val === "string" ? val : ""
        ta.onchange = () => save(f.key, ta.value)
        ctl.append(ta)
      }
      row.append(who, ctl)
      settings.append(row)
    }
  }

  function fallbackToggle(on, cb) {
    const b = document.createElement("button")
    b.type = "button"; b.className = "tg" + (on ? " on" : "")
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(on))
    b.textContent = on ? "开" : "关"
    b.onclick = () => { on = !on; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); b.textContent = on ? "开" : "关"; cb(on) }
    return b
  }

  function pickMenu(anchor, optsList, value, cb) {
    const old = document.querySelector(".popmenu")
    if (old) old.remove()
    const menu = document.createElement("div")
    menu.className = "popmenu"
    for (const [v, name] of optsList) {
      const item = document.createElement("button")
      item.type = "button"; item.textContent = name
      if (v === value) item.classList.add("on")
      item.onclick = () => { menu.remove(); cb(v) }
      menu.append(item)
    }
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = r.left + "px"
    menu.style.top = (r.bottom + 4) + "px"
    const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", off) } }
    setTimeout(() => document.addEventListener("mousedown", off), 0)
  }

  async function save(key, value) {
    opts = { ...opts, [key]: value }
    try {
      const next = await magpie.options.set(opts)
      if (next && typeof next === "object") opts = next
      flash(`已保存 ${key}，网关热加载中…`)
    } catch (err) {
      flash("保存失败：" + (err && err.message ? err.message : err), true)
    }
    drawSettings()
  }

  let flashTimer = null
  function flash(msg, bad) {
    if (!statusEl) {
      statusEl = document.createElement("div")
      statusEl.className = "flash"
      $("settings").before(statusEl)
    }
    statusEl.textContent = msg
    statusEl.classList.toggle("bad", !!bad)
    statusEl.classList.add("show")
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => statusEl.classList.remove("show"), 2200)
  }

  // ── init ────────────────────────────────────────────────────────────────
  try {
    opts = (await magpie.options.get()) || {}
  } catch { opts = {} }
  drawSettings()
  load()

  // refresh stats when the reader comes back to the page
  if (magpie.onVisibility) {
    let t = null
    magpie.onVisibility((vis) => {
      if (vis) load()
    })
  }
})()
