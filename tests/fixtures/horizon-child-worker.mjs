import { existsSync, writeFileSync } from "node:fs"
import { HorizonStore } from "../../dist/horizon.js"

const [root, sessionId, featureId, childRunId, output, holding, release] = process.argv.slice(2)
const send = (message) => new Promise((resolve, reject) => process.send?.(message, (error) => error ? reject(error) : resolve()))

await send({ type: "ready", childRunId })
await new Promise((resolve) => process.once("message", (message) => message === "start" && resolve()))
await send({ type: "attempting", childRunId })
try {
  const store = new HorizonStore(root, { faultInjector: (stage, operation) => {
    if (stage !== "journal-written" || operation !== "begin-worker") return
    writeFileSync(holding, childRunId)
    const waiter = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(release)) Atomics.wait(waiter, 0, 0, 20)
  } })
  store.beginWorker(sessionId, featureId, childRunId)
  writeFileSync(output, JSON.stringify({ status: "acquired", childRunId }))
} catch (error) {
  writeFileSync(output, JSON.stringify({ status: "blocked", message: error instanceof Error ? error.message : String(error) }))
}
