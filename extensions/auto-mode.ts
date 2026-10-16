/**
 * pi-auto-mode
 *
 * /auto [on|off] or shift+tab toggles auto mode. While on, an `ask` that reaches the
 * permission system's authorizer chain is resolved here instead of by the human:
 *   1. ask matched by an explicit rule in the user's policy -> deny, classifier never runs
 *   2. ask from the default fallthrough                     -> local OpenAI-compatible classifier
 *   3. classifier unsure / error / timeout                  -> defer (human dialog)
 * `deny` rules are enforced by the permission system before the chain and never reach here.
 *
 * Requires @gotgenes/pi-permission-system >= 40 and `"authorizerChain": ["auto-mode"]`
 * in its config (bin/setup.sh does both).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { classify, type ClassifierConfig } from "./classifier.js"

const SERVICES_KEY = Symbol.for("@gotgenes/pi-permission-system:session-services")
const LINK_NAME = "auto-mode"

type Verdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" }

interface AskDetails {
  toolName?: string
  command?: string
  path?: string
  target?: string
  toolInputPreview?: string
}

interface Query {
  checkPermission(surface: string, value?: string): { state: string; matchedPattern?: string }
}

interface Log {
  review(event: string, details?: Record<string, unknown>): void
}

type Config = Required<Omit<ClassifierConfig, "rubricExtra">> & {
  rubricExtra: string
  maxConsecutiveDenials: number
  maxUserMessages: number
}

function loadConfig(cwd: string): Config {
  let out: Config = {
    baseUrl: "http://localhost:8001/v1",
    apiKey: "1234",
    model: "gemma-4-26B-A4B-it-qat-nvfp4",
    timeoutMs: 20000,
    rubricExtra: "",
    maxConsecutiveDenials: 3,
    maxUserMessages: 5,
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent")
  for (const p of [
    join(agentDir, "extensions/pi-auto-mode/config.json"),
    join(cwd, ".pi/extensions/pi-auto-mode/config.json"),
  ]) {
    if (!existsSync(p)) continue
    try {
      out = { ...out, ...JSON.parse(readFileSync(p, "utf-8")) }
    } catch {}
  }
  return out
}

function userMessages(ctx: ExtensionContext, max: number): string[] {
  const out: string[] = []
  for (const e of ctx.sessionManager.getBranch() as any[]) {
    if (e.type !== "message" || e.message?.role !== "user") continue
    const c = e.message.content
    const text =
      typeof c === "string"
        ? c
        : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    if (text.trim()) out.push(text.trim().slice(0, 1500))
  }
  return out.slice(-max)
}

/** An `ask` caused by an explicit rule in the policy is a stance, not a gap. */
function explicitAsk(query: Query, d: AskDetails): string | undefined {
  const probes: [string, string | undefined][] = [[d.toolName ?? "", d.command ?? d.path ?? d.target]]
  if (d.toolName === "bash" && d.command) probes.unshift(["bash", d.command])
  if (d.path) probes.push(["external_directory", d.path], ["path", d.path])
  for (const [surface, value] of probes) {
    if (!surface) continue
    try {
      const r = query.checkPermission(surface, value)
      if (r.state === "ask" && r.matchedPattern && r.matchedPattern !== "*") {
        return `${surface} rule '${r.matchedPattern}'`
      }
    } catch {}
  }
  return undefined
}

export default function (pi: ExtensionAPI) {
  let enabled = false
  let consecutiveDenials = 0
  let ctxRef: ExtensionContext | undefined
  const disposers = new Map<string, () => void>() // sessionId -> unregister

  const setStatus = (ctx: ExtensionContext) => ctx.ui?.setStatus("auto-mode", enabled ? "auto" : undefined)

  function toggle(ctx: ExtensionContext, next?: boolean) {
    enabled = next ?? !enabled
    consecutiveDenials = 0
    setStatus(ctx)
    ctx.ui?.notify(`auto mode ${enabled ? "ON" : "OFF"} (classifier: ${loadConfig(ctx.cwd).model})`, "info")
  }

  async function authorize(d: AskDetails, query: Query, log: Log): Promise<Verdict> {
    const ctx = ctxRef
    if (!enabled || !ctx) return { kind: "defer" }

    const stance = explicitAsk(query, d)
    if (stance) {
      log.review("auto_mode_stance_denied", { rule: stance })
      return { kind: "deny", reason: `Blocked by auto mode: matches ${stance}. Ask the user.` }
    }

    const cfg = loadConfig(ctx.cwd)
    const summary = d.command ?? d.path ?? d.target ?? d.toolInputPreview ?? "(no detail)"
    let verdict
    try {
      verdict = await classify(cfg, {
        userMessages: userMessages(ctx, cfg.maxUserMessages),
        toolName: d.toolName ?? "unknown",
        summary,
        cwd: ctx.cwd,
      })
    } catch (e: any) {
      verdict = { decision: "escalate" as const, reason: `classifier error: ${e?.name ?? e}` }
    }
    log.review("auto_mode_verdict", { decision: verdict.decision, reason: verdict.reason, model: cfg.model })

    if (verdict.decision === "allow") {
      consecutiveDenials = 0
      return { kind: "allow" }
    }
    if (verdict.decision === "deny") {
      consecutiveDenials++
      if (consecutiveDenials >= cfg.maxConsecutiveDenials) {
        consecutiveDenials = 0
        ctx.ui?.notify(`auto mode: ${cfg.maxConsecutiveDenials} denials in a row, asking you`, "warning")
        return { kind: "defer" }
      }
      return { kind: "deny", reason: `Blocked by auto mode: ${verdict.reason}` }
    }
    return { kind: "defer" }
  }

  // The service is published per session node; `permissions:ready` may fire more than once.
  pi.events.on("permissions:ready", (data: any) => {
    const sessionId = data?.sessionId as string | undefined
    if (!sessionId || disposers.has(sessionId)) return
    const services = (globalThis as Record<symbol, unknown>)[SERVICES_KEY] as Map<string, any> | undefined
    const service = services?.get(sessionId)
    if (!service?.registerAuthorizer) return
    try {
      disposers.set(sessionId, service.registerAuthorizer(LINK_NAME, authorize))
    } catch {}
  })

  pi.registerCommand("auto", {
    description: "Auto mode: /auto [on|off]",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase()
      toggle(ctx, a === "on" ? true : a === "off" ? false : undefined)
    },
  })

  // Same key as Claude Code's mode cycle. Pi's thinking-level cycle is rebound to alt+t
  // in ~/.pi/agent/keybindings.json so this shortcut is free.
  pi.registerShortcut("shift+tab", {
    description: "Toggle auto mode",
    handler: (ctx) => toggle(ctx),
  })

  pi.on("session_start", (_e, ctx) => {
    ctxRef = ctx
    enabled = false
    setStatus(ctx)
  })
  pi.on("session_shutdown", () => {
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {}
    }
    disposers.clear()
  })
}
