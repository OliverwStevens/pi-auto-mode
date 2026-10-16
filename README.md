# pi-auto-mode

Auto mode for the [pi](https://pi.dev) coding agent, similar to Claude Code's auto mode. A local LLM classifier approves or blocks permission prompts so you are not interrupted for routine actions.

## How it works

`pi-auto-mode` registers an authorizer-chain link (`auto-mode`) with `@gotgenes/pi-permission-system`. When auto mode is on, each permission `ask` reaching that chain is resolved in this order:

1. `deny` rules and `path` deny rules block first. Auto mode never overrides them.
2. An `ask` caused by an **explicit rule** in your policy (for example `git push *: ask`) is denied without calling the classifier. The agent sees `Blocked by auto mode: ...`.
3. Any other `ask` goes to a classifier model on an OpenAI-compatible endpoint (oMLX, Ollama, LM Studio, vLLM). It sees your recent requests and the proposed call, and answers allow, deny or escalate.
4. Escalate, error or timeout defers to the normal human dialog. After `maxConsecutiveDenials` denials (allows do not reset the count) auto mode asks you once and resets.

Toggle with `shift+tab` or `/auto [on|off]`. The footer shows `auto` while on. Auto mode starts off each session.

## Install

Requires pi, python3, and an OpenAI-compatible model server. Needs `@gotgenes/pi-permission-system` **>= 40**; `setup.sh` installs the latest.

```bash
git clone https://github.com/OliverwStevens/pi-auto-mode
cd pi-auto-mode
./bin/setup.sh [classifier-model-id]
```

`setup.sh`:
- installs `@gotgenes/pi-permission-system` and this package,
- adds `"auto-mode"` to `authorizerChain` in the permission-system config (a link decides nothing until named there),
- rebinds pi's thinking-level cycle from `shift+tab` to `alt+t`,
- writes `~/.pi/agent/extensions/pi-auto-mode/config.json` if missing.

Then run `/reload` in pi.

No patching is involved. Auto mode calls the permission system's `registerAuthorizer`, but finds it through the `Symbol.for("@gotgenes/pi-permission-system:session-services")` global, which is an internal. If that changes, toggling auto mode shows a warning that the link is missing instead of failing silently. State (on/off, denial count) is per process, not per session.

## Config

`~/.pi/agent/extensions/pi-auto-mode/config.json`. A project file `<cwd>/.pi/extensions/pi-auto-mode/config.json` may only set `timeoutMs` and `maxUserMessages`; other keys are ignored with a warning, so a cloned repo cannot redirect the classifier or rewrite its rubric. Invalid values are ignored with a warning.

| key | default | meaning |
| --- | --- | --- |
| `baseUrl` | `http://localhost:8001/v1` | OpenAI-compatible endpoint |
| `apiKey` | `1234` | bearer token |
| `model` | `gemma-4-26B-A4B-it-qat-nvfp4` | classifier model id |
| `timeoutMs` | `20000` | classifier timeout |
| `maxConsecutiveDenials` | `3` | denials before asking the human |
| `maxUserMessages` | `5` | recent user messages shown to the classifier |
| `rubricExtra` | `""` | extra rules appended to the classifier prompt |

## Safety notes

- `baseUrl` is sent your recent messages and every proposed command. Use a local endpoint unless you trust the remote.
- The proposed call is fenced and truncated to 4000 chars in the prompt, and the rubric escalates scripts whose contents it cannot see.
- The classifier is an LLM. Treat it as a convenience, not a security boundary. Keep hard limits in `deny` rules.
- Tool output is never shown to the classifier, which limits prompt injection.
- The permission system caps a link's `allow` on `path` and `external_directory` asks: those still reach you as a dialog. Put allows for outside-project paths in your policy.
- A subagent's ask is reviewed one hop up by the session you watch, so auto mode covers subagents too.
- The permission config must live at `~/.pi/agent/extensions/pi-permission-system/config.json` (global) or `<cwd>/.pi/extensions/pi-permission-system/config.json`.

## License

MIT

## Development

`npm test` (Node >= 22.6) runs the verdict-parser tests.
