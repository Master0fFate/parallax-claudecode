import { SessionStore } from "../../dist/state.js"

const [root, sessionId, countText] = process.argv.slice(2)
if (!root || !sessionId || !countText) throw new Error("worker requires root, session ID, and count")
const store = new SessionStore(root)
for (let index = 0; index < Number(countText); index += 1) {
  store.update(sessionId, (state) => {
    if (!state) throw new Error("session disappeared")
    state.friction.trials += 1
    return state
  })
}
