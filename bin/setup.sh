#!/usr/bin/env bash
# One-shot setup for pi-auto-mode. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${1:-}"

command -v pi >/dev/null || { echo "pi not found. Install pi first."; exit 1; }

echo "==> installing @gotgenes/pi-permission-system"
pi install npm:@gotgenes/pi-permission-system

echo "==> installing pi-auto-mode from $HERE"
pi install "$HERE"

echo "==> patching permission system (askResolver hook)"
bash "$HERE/bin/apply-patch.sh"

echo "==> freeing shift+tab (thinking cycle -> alt+t)"
mkdir -p "$AGENT_DIR"
python3 - "$AGENT_DIR/keybindings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault("app.thinking.cycle", ["alt+t"])
json.dump(d, open(p, "w"), indent=2)
PY

CFG="$AGENT_DIR/extensions/pi-auto-mode/config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cp "$HERE/examples/config.json" "$CFG"
  [ -n "$MODEL" ] && python3 - "$CFG" "$MODEL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["model"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
  echo "==> wrote $CFG (edit baseUrl/model/apiKey to match your OpenAI-compatible endpoint)"
fi

echo "Done. In pi: /reload, then shift+tab or /auto on."
