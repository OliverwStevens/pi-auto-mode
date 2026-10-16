#!/usr/bin/env bash
# One-shot setup for pi-auto-mode. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${1:-}"

command -v pi >/dev/null || { echo "pi not found. Install pi first."; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found."; exit 1; }

echo "==> installing @gotgenes/pi-permission-system (>= 40)"
pi install npm:@gotgenes/pi-permission-system@latest

echo "==> installing pi-auto-mode from $HERE"
pi install "$HERE"

echo "==> freeing shift+tab (thinking cycle -> alt+t)"
mkdir -p "$AGENT_DIR"
python3 - "$AGENT_DIR/keybindings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault("app.thinking.cycle", ["alt+t"])
json.dump(d, open(p, "w"), indent=2)
PY

echo "==> adding auto-mode to authorizerChain"
PERM="$AGENT_DIR/extensions/pi-permission-system/config.json"
mkdir -p "$(dirname "$PERM")"
python3 - "$PERM" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except json.JSONDecodeError:
    sys.exit(f"{p} is not plain JSON (comments?). Add \"authorizerChain\": [\"auto-mode\"] by hand.")
chain = d.setdefault("authorizerChain", [])
if "auto-mode" not in chain:
    chain.append("auto-mode")
json.dump(d, open(p, "w"), indent=2)
PY

CFG="$AGENT_DIR/extensions/pi-auto-mode/config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cp "$HERE/examples/config.json" "$CFG"
  if [ -n "$MODEL" ]; then
    python3 - "$CFG" "$MODEL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["model"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  fi
  echo "==> wrote $CFG (edit baseUrl/model/apiKey for your OpenAI-compatible endpoint)"
fi

echo "Done. In pi: /reload, then shift+tab or /auto on."
