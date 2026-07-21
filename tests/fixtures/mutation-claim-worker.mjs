import { writeFileSync } from "node:fs"
import { MutationIntentQueue } from "../../dist/mutation-queue.js"

const [root, sessionId, output] = process.argv.slice(2)
if (!root || !sessionId || !output) throw new Error("worker requires root, session ID, and output path")
const fingerprint = "a".repeat(64)
const result = new MutationIntentQueue(root, sessionId).observe([
  { toolUseId: "shared", tool: "Write", fingerprint, outcome: "success", detail: "completed" },
])
writeFileSync(output, JSON.stringify({ status: result.status }))
