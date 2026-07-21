#!/usr/bin/env node
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { formatDoctorMarkdown, runDoctor } from "../dist/doctor.js"

const args = process.argv.slice(2)
if (args.some((arg) => !["--json", "--help", "-h"].includes(arg))) {
  console.error("Usage: parallax-claudecode-doctor [--json]")
  process.exit(2)
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: parallax-claudecode-doctor [--json]")
  process.exit(0)
}
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
try {
  const report = runDoctor({ packageRoot, projectRoot: process.cwd() })
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorMarkdown(report))
  process.exitCode = report.healthy ? 0 : 1
} catch {
  const failure = { schemaVersion: 1, healthy: false, error: "Doctor could not complete because a runtime artifact or filesystem response was malformed." }
  console.error(args.includes("--json") ? JSON.stringify(failure) : "[parallax] doctor failed safely; reinstall the package and retry")
  process.exitCode = 1
}
