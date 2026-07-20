import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ParallaxMcpServer } from "../src/mcp.js"

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-mcp-test-"))
  roots.push(root)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const expectedTools = [
  "parallax_verify", "parallax_analyze", "parallax_checkin", "parallax_plan", "parallax_build", "parallax_debug", "parallax_horizon",
  "parallax_hyperplan", "parallax_trace_export", "parallax_trace_pr_comment", "parallax_trace_view", "parallax_health",
  "horizon_init_session", "horizon_write_plan", "horizon_read_plan", "horizon_update_feature", "horizon_update_milestone",
  "horizon_write_state", "horizon_read_state", "horizon_append_decision", "horizon_read_decisions", "horizon_write_research",
  "horizon_read_research", "horizon_create_skill", "horizon_list_skills", "horizon_save_trace", "horizon_list_sessions",
  "horizon_session_status", "horizon_evaluate_subagent", "horizon_config",
]

describe("bundled MCP server", () => {
  it("negotiates MCP and advertises the complete native tool surface", async () => {
    const server = new ParallaxMcpServer({ projectRoot: temporary(), horizonRoot: temporary() })
    const initialized = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(initialized).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "parallax-claudecode" } } })
    const names = server.listTools().map((tool) => tool.name)
    expect(names).toEqual(expectedTools)
  })

  it("uses the sole Claude session but rejects ambiguous omission actionably", async () => {
    const root = temporary()
    const server = new ParallaxMcpServer({ projectRoot: root, horizonRoot: temporary() })
    server.sessions.initialize("claude-one", root)
    const fallback = await server.callTool("parallax_health")
    expect(fallback.isError).not.toBe(true)
    expect(fallback.content[0]!.text).toContain("claude-one")

    server.sessions.initialize("claude-two", root)
    const ambiguous = await server.callTool("parallax_health")
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.content[0]!.text).toContain("sessionId is required")
    expect(ambiguous.content[0]!.text).toContain("claude-one, claude-two")

    const explicit = await server.callTool("parallax_build", { sessionId: "claude-two" })
    expect(explicit.isError).not.toBe(true)
    expect(server.sessions.read("claude-two")!.mode).toBe("build")
  })

  it("uses safe single-Horizon-session fallback and rejects Horizon ambiguity", async () => {
    const server = new ParallaxMcpServer({ projectRoot: temporary(), horizonRoot: temporary() })
    await server.callTool("horizon_init_session", { sessionId: "h-one", goal: "First" })
    const fallback = await server.callTool("horizon_read_plan")
    expect(fallback.isError).not.toBe(true)
    expect(fallback.content[0]!.text).toContain("Plan for h-one")

    await server.callTool("horizon_init_session", { sessionId: "h-two", goal: "Second" })
    const ambiguous = await server.callTool("horizon_read_plan")
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.content[0]!.text).toContain("h-one, h-two")
    const explicit = await server.callTool("horizon_read_plan", { sessionId: "h-two" })
    expect(explicit.isError).not.toBe(true)
  })

  it("resolves plugin-cache MCP launches through CLAUDE_PROJECT_DIR", () => {
    const project = temporary()
    const previous = process.env.CLAUDE_PROJECT_DIR
    process.env.CLAUDE_PROJECT_DIR = project
    try {
      const server = new ParallaxMcpServer({ horizonRoot: temporary() })
      const canonicalProject = realpathSync(project)
      expect(server.projectRoot).toBe(canonicalProject)
      expect(server.sessions.root).toContain(canonicalProject)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR
      else process.env.CLAUDE_PROJECT_DIR = previous
    }
  })

  it("surfaces corrupt implicit sessions and rejects persisted cwd redirection", async () => {
    const root = temporary()
    const outside = temporary()
    const server = new ParallaxMcpServer({ projectRoot: root, horizonRoot: temporary() })
    server.sessions.initialize("poisoned", root)
    const path = server.sessions.pathFor("poisoned")
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    state.cwd = outside
    writeFileSync(path, JSON.stringify(state))

    const implicit = await server.callTool("parallax_health")
    expect(implicit.isError).toBe(true)
    expect(implicit.content[0]!.text).toContain("Corrupt implicit Parallax session")
    expect(implicit.content[0]!.text).toContain("canonical store root")
    const verify = await server.callTool("parallax_verify", { sessionId: "poisoned" })
    expect(verify.isError).toBe(true)
    expect(verify.content[0]!.text).toContain("canonical store root")
  })

  it("returns MCP tool errors as tool results without breaking JSON-RPC", async () => {
    const server = new ParallaxMcpServer({ projectRoot: temporary(), horizonRoot: temporary() })
    const response = await server.handleRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "parallax_health", arguments: {} } })
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: true } })
    expect(JSON.stringify(response)).toContain("No Parallax sessions")
  })
})
