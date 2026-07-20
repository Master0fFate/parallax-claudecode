import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, parse, resolve } from "node:path"
import type { ProjectDetection, ProjectType, VerifyCommand } from "./types.js"

function exists(root: string, name: string): boolean {
  return existsSync(join(root, name))
}

function markerType(root: string): { type: Exclude<ProjectType, null>; markers: string[] } | null {
  if (exists(root, "Cargo.toml")) return { type: "cargo", markers: ["Cargo.toml"] }
  if (exists(root, "go.mod")) return { type: "go", markers: ["go.mod"] }
  if (exists(root, "package.json")) {
    const markers = ["package.json"]
    if (exists(root, "tsconfig.json")) markers.push("tsconfig.json")
    return { type: "node", markers }
  }
  const python = ["pyproject.toml", "requirements.txt", "setup.py"].filter((name) => exists(root, name))
  if (python.length > 0) return { type: "python", markers: python }
  let hasSolution = false
  try {
    hasSolution = readdirSync(root).some((name) => name.endsWith(".sln"))
  } catch {
    // Inaccessible directories are simply not candidates.
  }
  if (exists(root, "Directory.Build.props") || hasSolution) {
    return { type: "dotnet", markers: exists(root, "Directory.Build.props") ? ["Directory.Build.props"] : ["*.sln"] }
  }
  return null
}

/** Detects the nearest supported project without reading process-global cwd. */
export function detectProject(cwd: string = process.cwd()): ProjectDetection {
  const start = resolve(cwd)
  let candidate = start
  const filesystemRoot = parse(candidate).root
  while (true) {
    const detected = markerType(candidate)
    if (detected) {
      return {
        ...detected,
        root: candidate,
        packageManager: detected.type === "node" ? detectPackageManager(candidate) : null,
      }
    }
    if (candidate === filesystemRoot || exists(candidate, ".git")) break
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return { type: null, root: start, markers: [], packageManager: null }
}

function detectPackageManager(root: string): ProjectDetection["packageManager"] {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm"
  if (exists(root, "yarn.lock")) return "yarn"
  if (exists(root, "bun.lock") || exists(root, "bun.lockb")) return "bun"
  return "npm"
}

function packageCommand(runner: NonNullable<ProjectDetection["packageManager"]>, script: string): VerifyCommand {
  const args = runner === "yarn" ? [script] : ["run", script]
  return { command: runner, args, label: `${runner} ${args.join(" ")}` }
}

export function getVerifyCommands(project: ProjectDetection): VerifyCommand[] {
  switch (project.type) {
    case "cargo":
      return [{ command: "cargo", args: ["check", "--all-targets", "--all-features", "--color=never"], label: "cargo check" }]
    case "go":
      return [{ command: "go", args: ["test", "./..."], label: "go test" }]
    case "python":
      return [{
        command: process.platform === "win32" ? "python" : "python3",
        args: ["-m", "compileall", "-q", "-x", String.raw`(^|[\\/])(\.venv|venv|node_modules|\.git)([\\/]|$)`, "."],
        label: "python compileall",
      }]
    case "dotnet":
      return [{ command: "dotnet", args: ["test", "--nologo"], label: "dotnet test" }]
    case "node": {
      let scripts: Record<string, string> = {}
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(project.root, "package.json"), "utf8"))
        if (parsed && typeof parsed === "object" && "scripts" in parsed && parsed.scripts && typeof parsed.scripts === "object") {
          scripts = Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        }
      } catch {
        return []
      }
      const runner = project.packageManager ?? "npm"
      if (scripts.check) return [packageCommand(runner, "check")]
      const commands = ["typecheck", "test", "lint"]
        .filter((script) => scripts[script] && !(script === "test" && /no test specified/i.test(scripts[script] ?? "")))
        .map((script) => packageCommand(runner, script))
      if (commands.length === 0 && scripts.build) commands.push(packageCommand(runner, "build"))
      return commands
    }
    default:
      return []
  }
}

/** Compatibility helper returning the first command as a display string. */
export function getVerifyCommand(cwd: string = process.cwd()): string | null {
  const command = getVerifyCommands(detectProject(cwd))[0]
  return command ? [command.command, ...command.args].join(" ") : null
}
