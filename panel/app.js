// mg-purge's panel in magpie's Usage page: today's success rate at a glance.
(async () => {
  await magpie.ready
  const $ = (id) => document.getElementById(id)
  let enabled = true
  try {
    const o = await magpie.options.get()
    enabled = !o || o.preset !== "off"
  } catch { enabled = true }

  const dot = $("dot")
  dot.classList.toggle("on", enabled)
  $("preset").textContent = enabled ? "运行中" : "已关闭注入"

  let s
  try {
    s = await magpie.read("usage:summary", { period: "today" })
  } catch (err) {
    $("rate").textContent = "读取失败"
    $("foot").textContent = String(err && err.message ? err.message : err)
    return
  }
  const calls = s.calls || 0
  const errors = s.errors || 0
  const ok = Math.max(0, calls - errors)
  const rate = calls ? ok / calls : 1
  $("calls").textContent = `${calls.toLocaleString()} 次调用`
  $("rate").textContent = calls ? (rate * 100).toFixed(1) + "%" : "—"
  const fill = $("barFill")
  fill.style.width = (rate * 100).toFixed(1) + "%"
  fill.classList.toggle("low", rate < 0.9)
  $("foot").textContent = `全网关（usage 汇总）· 成功 ${ok.toLocaleString()} / 错误 ${errors.toLocaleString()} · 调用成功率 = 成功 / 总调用`

  if (magpie.onTheme) {
    magpie.onTheme(() => {})
  }

  // export the same diagnostics the full page exports: options + usage snapshot.
  // The frame is sandboxed (allow-scripts, connect-src 'none'), so an
  // <a download> is silently blocked — show the JSON in a textarea to copy.
  const eb = $("exportBtn")
  if (eb) eb.onclick = async () => {
    eb.disabled = true
    try {
      const o = await magpie.options.get().catch(() => ({}))
      const snap = { plugin: "mg-purge", options: o, usage: {}, exportedAt: new Date().toISOString() }
      for (const p of ["today", "7d", "30d"]) {
        try { snap.usage[p] = await magpie.read("usage:summary", { period: p }) } catch (e) { snap.usage[p] = { error: String(e && e.message ? e.message : e) } }
      }
      const text = JSON.stringify(snap, null, 2)
      let box = $("exportBox")
      if (!box) {
        box = document.createElement("div"); box.id = "exportBox"; box.className = "exportbox"
        const head = document.createElement("div"); head.className = "ebhead"
        const note = document.createElement("span"); note.id = "ebnote"; note.className = "muted"
        const sel = document.createElement("button"); sel.type = "button"; sel.className = "tb"; sel.textContent = "全选"
        const cp = document.createElement("button"); cp.type = "button"; cp.className = "tb"; cp.textContent = "复制"
        const ta = document.createElement("textarea"); ta.id = "ebText"; ta.readOnly = true; ta.spellcheck = false
        head.append(note, sel, cp)
        box.append(head, ta)
        document.querySelector(".panel").append(box)
        sel.onclick = () => { ta.focus(); ta.select() }
        cp.onclick = async () => {
          let ok = false
          try { if (navigator.clipboard) { await navigator.clipboard.writeText(ta.value); ok = true } } catch { }
          if (!ok) { try { ta.focus(); ta.select(); ok = document.execCommand && document.execCommand("copy") } catch { } }
          note.textContent = ok ? "已复制到剪贴板。" : "复制被拒，请手动全选复制。"
        }
      }
      const ta = $("ebText"); ta.value = text; box.hidden = false
      let copied = false
      try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); copied = true } } catch { }
      $("ebnote").textContent = copied ? "已复制到剪贴板。" : "已显示，请点「全选」后手动复制。"
    } finally { eb.disabled = false }
  }
})()
