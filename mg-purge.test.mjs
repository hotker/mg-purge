// bun test entry, matching magpie-community's pattern (scripts/middleware.mjs
// exposes check(dir, mod)). Falls back to nothing under plain Node — use
// `node --test run-cases.mjs` there.
import * as mod from "./mg-purge.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)
