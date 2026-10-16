#!/usr/bin/env bash
# Adds an askResolver hook to @gotgenes/pi-permission-system. Idempotent; keeps a .orig backup.
set -euo pipefail
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
F="${1:-$AGENT_DIR/npm/node_modules/@gotgenes/pi-permission-system/src/permission-prompter.ts}"
[ -f "$F" ] || { echo "not found: $F (install @gotgenes/pi-permission-system first)"; exit 1; }
grep -q "pi-permission-system.askResolver" "$F" && { echo "already patched"; exit 0; }
cp "$F" "$F.orig"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
anchor = '    this.writeReviewEntry("permission_request.waiting", details);\n'
hook = '''    // pi-auto-mode hook: an extension may resolve the ask before the human is prompted.
    const askResolver = (globalThis as Record<symbol, unknown>)[
      Symbol.for("pi-permission-system.askResolver")
    ] as
      | ((c: ExtensionContext, d: PromptPermissionDetails) => Promise<PermissionPromptDecision | undefined>)
      | undefined;
    if (askResolver) {
      try {
        const resolved = await askResolver(ctx, details);
        if (resolved) {
          this.writeReviewEntry(
            resolved.approved ? "permission_request.auto_approved" : "permission_request.denied",
            { ...details, resolution: resolved.state, denialReason: resolved.denialReason },
          );
          return resolved;
        }
      } catch {
        // fail closed to the human dialog
      }
    }

'''
assert anchor in s
open(p, "w").write(s.replace(anchor, hook + anchor, 1))
PY
echo "patched $F"
