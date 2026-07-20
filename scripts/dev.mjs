#!/usr/bin/env node
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
if (!existsSync(join(root, "dist", "hook.js")) || !existsSync(join(root, "dist", "mcp.js"))) {
  console.error("[parallax] dist is missing; run npm run build")
  process.exit(1)
}

const executable = process.platform === "win32" ? "claude.exe" : "claude"
const result = spawnSync(executable, ["--plugin-dir", root, ...process.argv.slice(2)], {
  cwd: process.env.INIT_CWD || process.cwd(),
  stdio: "inherit",
})
if (result.error?.code === "ENOENT") console.error("[parallax] Claude Code executable not found on PATH")
process.exit(result.status ?? 1)
