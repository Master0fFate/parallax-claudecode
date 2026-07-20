import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { detectProject, HorizonStore, SessionStore, sessionStorageKey } from "../src/index.js"
import { TestWorkspace, horizonPlan } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
function workspace(label: string): TestWorkspace {
  const value = new TestWorkspace(label)
  workspaces.push(value)
  return value
}
afterEach(() => { while (workspaces.length) workspaces.pop()!.cleanup() })

describe("path handling and security boundaries", () => {
  it("maps hostile session IDs to stable contained storage keys", () => {
    const root = workspace("unsafe-id").root
    const store = new SessionStore(root)
    const hostile = "../../outside/\\absolute\0session"
    const first = store.pathFor(hostile)
    const second = store.pathFor(hostile)

    expect(first).toBe(second)
    expect(sessionStorageKey(hostile)).toMatch(/^session-[a-f0-9]{32}$/)
    expect(relative(store.root, first)).not.toMatch(/^\.\.(?:[\\/]|$)/)
    expect(dirname(first)).not.toContain("..")
    store.initialize(hostile, root)
    expect(store.read(hostile)!.sessionId).toBe(hostile)
  })

  it.each(["../escape", "..", ".", "a/b", "a\\b", "", "UPPER space"])(
    "rejects unsafe Horizon session ID %j before filesystem access",
    (id) => {
      const store = new HorizonStore(workspace("horizon-boundary").root)
      expect(() => store.initSession(id, "goal")).toThrow(/Invalid session ID/)
    },
  )

  it("rejects traversal in skill and trace names", () => {
    const root = workspace("artifact-boundary").root
    const store = new HorizonStore(root)
    store.initSession("safe-session", "goal")
    store.writePlan("safe-session", horizonPlan("safe-session"))

    expect(() => store.createSkill("safe-session", "../skill", "description", "body")).toThrow(/Invalid skill name/)
    expect(() => store.createSkill("safe-session", "MixedCase", "description", "body")).toThrow(/lowercase kebab-case/)
    expect(() => store.saveTrace("safe-session", "../../trace", {})).toThrow(/Invalid trace ID/)
    expect(() => store.saveTrace("../session", "trace", {})).toThrow(/Invalid session ID/)
  })

  it("normalizes a relative detection start and stops at a repository boundary", () => {
    const root = workspace("relative-detect").root
    mkdirSync(join(root, ".git"), { recursive: true })
    mkdirSync(join(root, "nested", "deeper"), { recursive: true })
    writeFileSync(join(root, "package.json"), "{}")
    const from = relative(process.cwd(), join(root, "nested", "deeper"))
    const detected = detectProject(from)

    expect(isAbsolute(detected.root)).toBe(true)
    expect(detected.root).toBe(resolve(root))

    const isolated = join(root, "isolated")
    mkdirSync(join(isolated, ".git"), { recursive: true })
    mkdirSync(join(isolated, "child"))
    expect(detectProject(join(isolated, "child"))).toMatchObject({ type: null, root: join(isolated, "child") })
  })

  it("does not overwrite foreign-session state even when the file is manually planted", () => {
    const root = workspace("foreign-state").root
    const store = new SessionStore(root)
    const a = store.initialize("session-a", root)
    mkdirSync(dirname(store.pathFor("session-b")), { recursive: true })
    writeFileSync(store.pathFor("session-b"), JSON.stringify(a))

    expect(() => store.read("session-b")).toThrow(/different session/)
    expect(JSON.parse(readFileSync(store.pathFor("session-b"), "utf8")).sessionId).toBe("session-a")
  })
})
