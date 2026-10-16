/**
 * pi-auto-mode
 *
 * /auto [on|off|status]. When on, permission `ask`s are resolved here instead of
 * by the human:
 *   1. ask matched by an explicit rule in the user's policy  -> hard deny (no classifier)
 *   2. ask from the default fallthrough                      -> local oMLX classifier
 *   3. classifier escalate / error / timeout                 -> human dialog (fail closed)
 * `deny` rules are enforced by pi-permission-system and never reach this code.
 *
 * Needs the askResolver hook in @gotgenes/pi-permission-system (see patch/apply-patch.sh).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { classify, type ClassifierConfig } from "./classifier.js"

const RESOLVER_KEY = Symbol.for("pi-permission-system.askResolver")

interface AutoConfig extends Partial<ClassifierConfig> {
  maxConsecutiveDenials?: number
  maxUserMessages?: number
}

interface AskDetails {
  toolName?: string
  command?: string
  path?: string
  target?: string
  toolInputPreview?: string
}

type Decision = {
  approved: boolean
  state: "approved" | "denied" | "denied_with_reason"
  denialReason?: string
  autoApproved?: true
}

function loadConfig(cwd: string): Required<AutoConfig> {
  const defaults: Required<AutoConfig> = {
    baseUrl: "http://localhost:8001/v1",
    apiKey: "1234",
    model: "gemma-4-26B-A4B-it-qat-nvfp4",
    timeoutMs: 20000,
    rubricExtra: "",
    maxConsecutiveDenials: 3,
    maxUserMessages: 5,
  }
  const paths = [
    join(homedir(), ".pi/agent/extensions/pi-auto-mode/config.json"),
    join(cwd, ".pi/extensions/pi-auto-mode/config.json"),
  ]
  let out = defaults
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      out = { ...out, ...JSON.parse(readFileSync(p, "utf-8")) }
    } catch {}
  }
  return out
}

function getService(): any {
  // pi-permission-system publishes its service under a module-private symbol; find it by description.
  const g = globalThis as Record<symbol, unknown>
  for (const s of Object.getOwnPropertySymbols(g)) {
    const v: any = g[s]
    if (v && typeof v.checkPermission === "function" && typeof v.getToolPermission === "function") return v
  }
  return undefined
}

function userMessages(ctx: ExtensionContext, max: number): string[] {
  const out: string[] = []
  for (const e of ctx.sessionManager.getBranch() as any[]) {
    if (e.type !== "message" || e.message?.role !== "user") continue
    const c = e.message.content
    const text = typeof c === "string" ? c : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    if (text.trim()) out.push(text.trim().slice(0, 1500))
  }
  return out.slice(-max)
}

export default function (pi: ExtensionAPI) {
  let enabled = false
  let consecutiveDenials = 0

  const setStatus = (ctx: ExtensionContext) =>
    ctx.ui?.setStatus("auto-mode", enabled ? "auto" : undefined)

  /** Explicit rule in the user's policy that says `ask` -> a stance, not a gap. */
  function explicitAsk(d: AskDetails): string | undefined {
    const svc = getService()
    if (!svc) return undefined
    const probes: [string, string | undefined][] = [
      [d.toolName ?? "", d.command ?? d.path ?? d.target],
    ]
    if (d.toolName === "bash" && d.command) probes.unshift(["bash", d.command])
    if (d.path) probes.push(["external_directory", d.path], ["path", d.path])
    for (const [surface, value] of probes) {
      if (!surface) continue
      try {
        const r = svc.checkPermission(surface, value)
        if (r.state === "ask" && r.matchedPattern && r.matchedPattern !== "*") {
          return `${surface} rule '${r.matchedPattern}'`
        }
      } catch {}
    }
    return undefined
  }

  async function resolve(ctx: ExtensionContext, d: AskDetails): Promise<Decision | undefined> {
    if (!enabled) return undefined

    const stance = explicitAsk(d)
    if (stance) {
      return deny(`Blocked by auto mode: matches ${stance}. Ask the user.`)
    }

    const cfg = loadConfig(ctx.cwd)
    const summary = d.command ?? d.path ?? d.target ?? d.toolInputPreview ?? "(no detail)"
    let verdict
    try {
      verdict = await classify(
        cfg as ClassifierConfig,
        { userMessages: userMessages(ctx, cfg.maxUserMessages), toolName: d.toolName ?? "unknown", summary, cwd: ctx.cwd },
      )
    } catch (e: any) {
      verdict = { decision: "escalate" as const, reason: `classifier error: ${e?.name ?? e}` }
    }

    if (verdict.decision === "allow") {
      consecutiveDenials = 0
      return { approved: true, state: "approved", autoApproved: true }
    }
    if (verdict.decision === "deny") {
      consecutiveDenials++
      if (consecutiveDenials >= cfg.maxConsecutiveDenials) {
        consecutiveDenials = 0
        ctx.ui?.notify(`auto mode: ${cfg.maxConsecutiveDenials} denials in a row, asking you`, "warning")
        return undefined
      }
      return deny(`Blocked by auto mode: ${verdict.reason}`)
    }
    return undefined // escalate: human dialog
  }

  function deny(reason: string): Decision {
    return { approved: false, state: "denied_with_reason", denialReason: reason }
  }

  ;(globalThis as Record<symbol, unknown>)[RESOLVER_KEY] = resolve

  pi.registerCommand("auto", {
    description: "Auto mode: /auto [on|off|status]",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase()
      if (a === "on" || a === "off") enabled = a === "on"
      else if (a === "" ) enabled = !enabled
      consecutiveDenials = 0
      setStatus(ctx)
      const cfg = loadConfig(ctx.cwd)
      ctx.ui?.notify(`auto mode ${enabled ? "ON" : "OFF"} (classifier: ${cfg.model})`, "info")
    },
  })

  // Same key as Claude Code's mode cycle. Pi's thinking-level cycle is rebound to alt+t in
  // ~/.pi/agent/keybindings.json so this shortcut is free.
  pi.registerShortcut("shift+tab", {
    description: "Toggle auto mode",
    handler: (ctx) => {
      enabled = !enabled
      consecutiveDenials = 0
      setStatus(ctx)
      ctx.ui?.notify(`auto mode ${enabled ? "ON" : "OFF"}`, "info")
    },
  })

  pi.on("session_start", (_e, ctx) => {
    enabled = false
    setStatus(ctx)
  })
  pi.on("session_shutdown", () => {
    if ((globalThis as Record<symbol, unknown>)[RESOLVER_KEY] === resolve)
      delete (globalThis as Record<symbol, unknown>)[RESOLVER_KEY]
  })
}
