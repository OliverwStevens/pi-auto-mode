# pi-auto-mode

Auto mode for the [pi](https://pi.dev) coding agent, similar to Claude Code's auto mode. A local LLM classifier approves or blocks permission prompts so you are not interrupted for routine actions.

## How it works

When auto mode is on, each permission `ask` from `@gotgenes/pi-permission-system` is resolved in this order:

1. `deny` rules and `path` deny rules block first. Auto mode never overrides them.
2. An `ask` caused by an **explicit rule** in your policy (for example `git push *: ask`) is denied without calling the classifier. The agent sees `Blocked by auto mode: ...`.
3. Any other `ask` goes to a classifier model on an OpenAI-compatible endpoint (oMLX, Ollama, LM Studio, vLLM). It sees your recent requests and the proposed call, and answers allow, deny or escalate.
4. Escalate, error or timeout falls back to the normal human dialog. Three denials in a row also fall back to the dialog.

Toggle with `shift+tab` or `/auto [on|off]`. The footer shows `auto` while on. Auto mode starts off each session.

## Install

Requires pi and an OpenAI-compatible model server.

```bash
git clone https://github.com/OliverwStevens/pi-auto-mode
cd pi-auto-mode
./bin/setup.sh [classifier-model-id]
```

`setup.sh`:
- installs `@gotgenes/pi-permission-system` and this package,
- applies a small patch that lets an extension answer an `ask` (`bin/apply-patch.sh`),
- rebinds pi's thinking-level cycle from `shift+tab` to `alt+t`,
- writes `~/.pi/agent/extensions/pi-auto-mode/config.json` if missing.

Then run `/reload` in pi.

Re-run `bin/apply-patch.sh` after any update of `@gotgenes/pi-permission-system`. It is idempotent and keeps a `.orig` backup.

## Config

`~/.pi/agent/extensions/pi-auto-mode/config.json` (project override: `<cwd>/.pi/extensions/pi-auto-mode/config.json`):

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

- The classifier is an LLM. Treat it as a convenience, not a security boundary. Keep hard limits in `deny` rules.
- Tool output is never shown to the classifier, which limits prompt injection.
- Prompts forwarded from subagents do not go through auto mode yet.
- The patch edits a file inside `node_modules`. Ask the permission-system author for an official hook if you depend on this long term.

## License

MIT
