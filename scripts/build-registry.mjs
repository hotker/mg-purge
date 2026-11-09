#!/usr/bin/env node
// Regenerate registry.json for the custom index source (and, if a release
// tarball URL is given, point the entry at it). Runs in this repo's CI on a
// version tag so the index always names the current install target.
//
//   node scripts/build-registry.mjs                 # local: npm name, no tarball
//   node scripts/build-registry.mjs --tgz <url>     # CI: package = tarball URL
//
// The output follows magpie's plugin.Listing shape exactly (Package, Name,
// Kind, Community, Summary{en,zh}); a middleware has a Kind and no Providers.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const args = process.argv.slice(2)
const ti = args.indexOf("--tgz")
const tgz = ti >= 0 ? args[ti + 1] : ""

// An install spec magpie accepts: an https tarball URL is a path-like file://
// handled by IsPath only for file:// — an https .tgz is neither npm nor git,
// so the reliable discovered install is the npm name (or `owner/repo` git
// shorthand). We keep Package as the npm name unless an explicit tarball is
// what we are cataloguing for a Release note.
const installPackage = pkg.name

const entry = {
  package: installPackage,
  name: pkg.name,
  kind: "middleware",
  community: false,
  summary: {
    en: "破甲 for magpie: dsh-purge's prompt-injection layer as gateway middleware — operator-priority system prompt (presets), the <dsh_boost> tail block, refusal detection + a single re-nudge, and thinking-tag stripping, switchable per agent and model. Ships a dashboard page (live stats, per-model success rate, live parameter tuning) and a Usage success-rate panel.",
    zh: "破甲 for magpie：把 dsh-purge 的提示词注入层做成网关中间件——操作者优先级系统提示词（预设）、<dsh_boost> 尾部强化段、拒绝检测 + 单次加固、think 标签剥离，均可按 agent 与模型开关。自带整页看板（实时统计、按模型成功率、实时调参）与 Usage 成功率面板。",
  },
}

const out = { version: 1, plugins: [entry] }
writeFileSync(join(root, "registry.json"), JSON.stringify(out, null, 2) + "\n")

// stamp the version into the dashboard header so the page shows it (the page
// can't read package.json at runtime — the sandbox has no fs).
try {
  const htmlPath = join(root, "page", "index.html")
  const html = readFileSync(htmlPath, "utf8")
  const stamped = html.replace(/(<span class="ver" id="ver">)[^<]*(<\/span>)/, `$1v${pkg.version}$2`)
  if (stamped !== html) writeFileSync(htmlPath, stamped)
} catch { /* page absent: fine */ }

if (tgz) console.log(`release tarball: ${tgz}`)
console.log(`registry.json → ${installPackage}@${pkg.version}`)
