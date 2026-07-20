import { HorizonStore } from "../../dist/horizon.js"

const [root, sessionId, countText] = process.argv.slice(2)
const store = new HorizonStore(root)
for (let index = 0; index < Number(countText); index += 1) {
  store.appendDecision(sessionId, {
    timestamp: new Date().toISOString(),
    feature: `worker-${process.pid}`,
    ambiguity: `concurrent decision ${index}`,
    researchResult: "fixture",
    decision: `decision-${process.pid}-${index}`,
    rationale: "multiprocess lock test",
    confidence: "high",
  })
}
