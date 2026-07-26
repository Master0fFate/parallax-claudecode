import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, watch, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HorizonStore } from "../src/horizon.js"
import { MutationIntentQueue } from "../src/mutation-queue.js"
import { SessionStore } from "../src/state.js"
import { TestWorkspace, horizonPlan } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
function workspace(label: string): TestWorkspace {
  const value = new TestWorkspace(label)
  workspaces.push(value)
  return value
}
afterEach(() => { while (workspaces.length) workspaces.pop()!.cleanup() })

function runWorker(root: string, sessionId: string, count: number, fixture = "session-worker.mjs"): Promise<void> {
  const script = join(process.cwd(), "tests", "fixtures", fixture)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, sessionId, String(count)], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)))
  })
}

function runClaimWorker(root: string, sessionId: string, output: string): Promise<void> {
  const script = join(process.cwd(), "tests", "fixtures", "mutation-claim-worker.mjs")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, sessionId, output], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`claim worker exited ${code}: ${stderr}`)))
  })
}

interface CoordinatedChild { process: ChildProcess; ready: Promise<void>; attempting: Promise<void>; done: Promise<void> }
function runHorizonChildWorker(root: string, sessionId: string, childRunId: string, output: string, holding: string, release: string): CoordinatedChild {
  const script = join(process.cwd(), "tests", "fixtures", "horizon-child-worker.mjs")
  const child = spawn(process.execPath, [script, root, sessionId, "f1", childRunId, output, holding, release], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
  let readyResolve!: () => void; let attemptingResolve!: () => void
  const ready = new Promise<void>((resolve) => { readyResolve = resolve })
  const attempting = new Promise<void>((resolve) => { attemptingResolve = resolve })
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message) {
      if (message.type === "ready") readyResolve()
      if (message.type === "attempting") attemptingResolve()
    }
  })
  const done = new Promise<void>((resolve, reject) => {
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Horizon child worker exited ${code}: ${stderr}`)))
  })
  return { process: child, ready, attempting, done }
}

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { watcher.close(); reject(new Error(`Timed out waiting for ${path}`)) }, 10_000)
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return
      clearTimeout(timeout); watcher.close(); resolve()
    })
    watcher.on("error", (error) => { clearTimeout(timeout); reject(error) })
  })
}

describe.sequential("atomic state concurrency and corrupt recovery", () => {
  it("serializes updates from independent Node processes without losing writes", async () => {
    const root = workspace("multiprocess").root
    const store = new SessionStore(root)
    store.initialize("shared", root)

    await Promise.all(Array.from({ length: 6 }, () => runWorker(root, "shared", 12)))

    expect(store.read("shared")!.friction.trials).toBe(72)
    expect(readdirSync(store.root).filter((name) => name.endsWith(".lock"))).toEqual([])
    expect(readdirSync(dirname(store.pathFor("shared"))).some((name) => name.endsWith(".tmp"))).toBe(false)
  }, 20_000)

  it("permits exactly one verifier claim across independent Node processes", async () => {
    const root = workspace("mutation-claim").root
    const queue = new MutationIntentQueue(root, "shared-claim")
    queue.record({ toolUseId: "shared", tool: "Write", fingerprint: "a".repeat(64), targets: ["shared.ts"] })
    const outputs = [join(root, "claim-a.json"), join(root, "claim-b.json")]

    await Promise.all(outputs.map((output) => runClaimWorker(root, "shared-claim", output)))

    const statuses = outputs.map((output) => JSON.parse(readFileSync(output, "utf8")).status).sort()
    expect(statuses).toEqual(["busy", "claimed"])
    expect(queue.read().active?.intents.map((intent) => intent.toolUseId)).toEqual(["shared"])
  }, 20_000)

  it("reclaims an abandoned stale lock and preserves valid state", () => {
    const root = workspace("stale-lock").root
    const store = new SessionStore(root)
    store.initialize("stale", root)
    const lock = join(store.root, "stale.lock")
    mkdirSync(lock)
    const old = new Date(Date.now() - 31_000)
    utimesSync(lock, old, old)

    store.update("stale", (state) => {
      state!.friction.trials = 9
      return state!
    })

    expect(store.read("stale")!.friction.trials).toBe(9)
    expect(() => statSync(lock)).toThrow()
  })

  it("race-safely reclaims one stale lock under multiprocess contention", async () => {
    const root = workspace("stale-lock-race").root
    const store = new SessionStore(root)
    store.initialize("raced", root)
    const lock = join(store.root, "raced.lock")
    mkdirSync(lock)
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "abandoned", acquiredAt: new Date(0).toISOString() }))
    const old = new Date(Date.now() - 31_000)
    utimesSync(lock, old, old)

    await Promise.all(Array.from({ length: 6 }, () => runWorker(root, "raced", 10)))

    expect(store.read("raced")!.friction.trials).toBe(60)
    expect(readdirSync(store.root).filter((name) => name.includes(".lock"))).toEqual([])
  }, 20_000)

  it("fails closed on corrupt JSON and supports explicit remove-and-reinitialize recovery", () => {
    const root = workspace("corrupt-json").root
    const store = new SessionStore(root)
    store.initialize("corrupt", root)
    writeFileSync(store.pathFor("corrupt"), "{ definitely-not-json")

    expect(() => store.read("corrupt")).toThrow(SyntaxError)
    expect(() => store.initialize("corrupt", root)).toThrow(SyntaxError)
    expect(readdirSync(dirname(store.pathFor("corrupt"))).some((name) => name.endsWith(".tmp"))).toBe(false)

    store.remove("corrupt")
    expect(store.initialize("corrupt", root).friction.retriesLeft).toBe(3)
  })

  it("serializes Horizon decision appends across independent processes", async () => {
    const root = workspace("horizon-multiprocess").root
    const store = new HorizonStore(root)
    store.initSession("shared-horizon", "Concurrent decisions")
    await Promise.all(Array.from({ length: 5 }, () => runWorker(root, "shared-horizon", 10, "horizon-worker.mjs")))
    expect(store.readDecisions("shared-horizon")).toHaveLength(50)
    expect(readdirSync(join(root, ".locks"))).toEqual([])
  }, 20_000)

  it("permits exactly one active Horizon child under barrier-coordinated multiprocess overlap", async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const root = workspace(`horizon-child-contention-${iteration}`).root
      const store = new HorizonStore(root)
      const sessionId = `contention-${iteration}`
      store.initSession(sessionId, "Child contention"); store.writePlan(sessionId, horizonPlan(sessionId))
      const barrier = join(root, "contention-barrier"); mkdirSync(barrier)
      const holding = join(barrier, "holding"); const release = join(barrier, "release")
      const outputs = Array.from({ length: 6 }, (_, index) => join(root, `result-${index}.json`))
      const children = outputs.map((output, index) => runHorizonChildWorker(root, sessionId, `worker-${index}`, output, holding, release))
      await Promise.all(children.map((child) => child.ready))
      children.forEach((child) => child.process.send?.("start"))
      await Promise.all([waitForFile(holding), ...children.map((child) => child.attempting)])
      expect(outputs.some(existsSync)).toBe(false)
      writeFileSync(release, "release")
      await Promise.all(children.map((child) => child.done))
      const results = outputs.map((output) => JSON.parse(readFileSync(output, "utf8")) as { status: string; childRunId?: string })
      expect(results.filter((result) => result.status === "acquired")).toHaveLength(1)
      expect(results.filter((result) => result.status === "blocked")).toHaveLength(5)
      const active = store.readActiveChild(sessionId)!
      expect(results.find((result) => result.status === "acquired")?.childRunId).toBe(active.childRunId)
      expect(store.readState(sessionId)!.activeSubAgents).toEqual([active.childRunId])
      const plan = store.readPlan(sessionId)!
      expect(plan.milestones[0]!.features[0]!).toMatchObject({ status: "in_progress", attempts: 1, subAgentSessionId: active.childRunId, evidence: { worker: { childRunId: active.childRunId } } })
      const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8")) as { sessions: Record<string, { status: string }> }
      expect(index.sessions[sessionId]?.status).toBe(plan.status)
      expect(existsSync(join(root, "sessions", sessionId, "transition.json"))).toBe(false)
    }
  }, 30_000)

  it("backs up a legacy OpenCode Horizon store before schema migration", () => {
    const parent = workspace("legacy-horizon").root
    const root = join(parent, "horizon")
    const plan = horizonPlan("legacy")
    const state = {
      sessionId: "legacy", currentPhase: "research", activeSubAgents: [], currentMilestoneId: null,
      currentFeatureId: null, lastCheckpoint: new Date().toISOString(), pausedAt: null, pauseReason: null,
    }
    mkdirSync(join(root, "sessions", "legacy"), { recursive: true })
    const legacyPlan = { ...plan } as Partial<typeof plan>
    delete legacyPlan.schemaVersion
    writeFileSync(join(root, "sessions", "legacy", "plan.json"), JSON.stringify(legacyPlan))
    writeFileSync(join(root, "sessions", "legacy", "state.json"), JSON.stringify(state))
    writeFileSync(join(root, "sessions", "legacy", "decisions.jsonl"), "")
    writeFileSync(join(root, "index.json"), JSON.stringify({ sessions: { legacy: { goal: plan.goal, createdAt: plan.createdAt, status: plan.status, autonomyLevel: plan.autonomyLevel } } }))

    const store = new HorizonStore(root)
    expect(store.readState("legacy")!.schemaVersion).toBe("1.0")
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8")).schemaVersion).toBe("1.0")
    const backups = readdirSync(parent).filter((name) => name.startsWith("horizon-opencode-backup-"))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(parent, backups[0]!, "index.json"), "utf8")).schemaVersion).toBeUndefined()
  })

  it("upgrades pre-approval Horizon milestones without blocking startup", () => {
    const root = workspace("pre-approval-horizon").root
    const store = new HorizonStore(root)
    store.initSession("legacy-approval", "Legacy approval defaults")
    store.writePlan("legacy-approval", horizonPlan("legacy-approval"))

    const planPath = join(root, "sessions", "legacy-approval", "plan.json")
    const legacy = JSON.parse(readFileSync(planPath, "utf8")) as ReturnType<typeof horizonPlan>
    delete (legacy.milestones[0] as Partial<(typeof legacy.milestones)[number]>).order
    delete (legacy.milestones[0] as Partial<(typeof legacy.milestones)[number]>).requiresApproval
    delete (legacy.milestones[0]!.features[0] as Partial<(typeof legacy.milestones)[number]["features"][number]>).order
    delete (legacy.milestones[0]!.features[0] as Partial<(typeof legacy.milestones)[number]["features"][number]>).evidence
    writeFileSync(planPath, JSON.stringify(legacy))

    const migrated = new HorizonStore(root).readPlan("legacy-approval")!
    expect(migrated.milestones[0]).toMatchObject({ order: 1, requiresApproval: false })
    expect(migrated.milestones[0]!.features[0]).toMatchObject({ order: 1 })
    expect(migrated.milestones[0]!.features[0]!.evidence).toBeDefined()
  })

  it("rolls back a corrupt legacy migration after backing up every original artifact", () => {
    const parent = workspace("corrupt-legacy-horizon").root
    const root = join(parent, "horizon")
    const plan = horizonPlan("legacy-corrupt")
    const state = {
      sessionId: "legacy-corrupt", currentPhase: "research", activeSubAgents: [], currentMilestoneId: null,
      currentFeatureId: null, lastCheckpoint: new Date().toISOString(), pausedAt: null, pauseReason: null,
    }
    mkdirSync(join(root, "sessions", "legacy-corrupt"), { recursive: true })
    const legacyPlan = { ...plan } as Partial<typeof plan>
    delete legacyPlan.schemaVersion
    const originalPlan = JSON.stringify(legacyPlan)
    const originalIndex = JSON.stringify({ sessions: { "legacy-corrupt": { goal: plan.goal, createdAt: plan.createdAt, status: plan.status, autonomyLevel: plan.autonomyLevel } } })
    writeFileSync(join(root, "sessions", "legacy-corrupt", "plan.json"), originalPlan)
    writeFileSync(join(root, "sessions", "legacy-corrupt", "state.json"), JSON.stringify(state))
    writeFileSync(join(root, "sessions", "legacy-corrupt", "decisions.jsonl"), "{ corrupt decision\n")
    writeFileSync(join(root, "index.json"), originalIndex)

    expect(() => new HorizonStore(root)).toThrow(/migration rolled back.*invalid decision/i)
    expect(readFileSync(join(root, "sessions", "legacy-corrupt", "plan.json"), "utf8")).toBe(originalPlan)
    expect(readFileSync(join(root, "index.json"), "utf8")).toBe(originalIndex)
    expect(existsSync(join(root, ".claudecode-migrated"))).toBe(false)
    expect(readdirSync(parent).filter((name) => name.startsWith("horizon-opencode-backup-"))).toHaveLength(1)
  })

  it("cleans its lock when an updater throws and remains usable", () => {
    const root = workspace("throwing-update").root
    const store = new SessionStore(root)
    store.initialize("thrower", root)
    expect(() => store.update("thrower", () => { throw new Error("fixture failure") })).toThrow("fixture failure")
    expect(readdirSync(store.root).filter((name) => name.endsWith(".lock"))).toEqual([])
    store.update("thrower", (state) => state!)
  })
})
