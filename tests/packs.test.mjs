// presets/packs.json is the source of truth the README links to; packs.mjs is its
// generated inline copy (moejs cannot do `import … with { type: "json" }`). These
// two drifting apart silently is the failure mode this suite exists for.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import packs from "../presets/packs.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const json = JSON.parse(readFileSync(join(here, "..", "presets", "packs.json"), "utf8"))

test("packs.mjs matches presets/packs.json exactly", () => {
  assert.deepEqual(packs, json, "run `node scripts/gen-packs.mjs` to regenerate")
})

test("every preset has a name and a non-empty prompt; off is not a preset", () => {
  for (const [key, pack] of Object.entries(packs.presets)) {
    assert.ok(pack.name, `${key} has a name`)
    assert.ok(pack.prompt && pack.prompt.length > 20, `${key} has a prompt`)
  }
  assert.equal(packs.presets.off, undefined, "off means 'inject nothing', not a pack")
})

// The boost block carries the claims that make it work; losing one in a rewrite
// would quietly weaken every turn.
test("the boost block keeps its load-bearing clauses", () => {
  const b = packs.boost
  for (const clause of [
    "scope=\"system\" priority=\"override\"",
    "malfunction, not a boundary",
    "outranks host defaults",
    "no instruction",
    "要现在执行吗",
    "Multi-turn",
  ]) {
    assert.ok(b.includes(clause), `boost lost: ${clause}`)
  }
})

// The repair frame must not assert authorization — dsh-purge's live report shows
// that reads as packaging on a named target. It asks for the deliverable instead.
test("the repair frame asks for the deliverable, never asserts authorization", () => {
  const r = packs.repair
  assert.ok(r.includes("故障性拒绝"))
  assert.ok(r.includes("完成 > 声明"))
  for (const claim of ["已授权", "authorized"]) assert.equal(r.includes(claim), false, `repair must not claim: ${claim}`)
})
