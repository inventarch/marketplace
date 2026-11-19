---
name: delegate
description: Hand one packet-driven step to another model's CLI (codex, claude or gemini), one level deep with a timeout. Use only when the person asks; off by default.
disable-model-invocation: true
---

**Antigravity:** read [the Antigravity host instructions](../../rules/AGENTS.md) first.

# Delegate

Cross-model delegation is **off by default**. The person turns it on with `"delegation": true` in `~/.ia/config.json` (or `IA_DELEGATION=1` for one session); until then `delegate.mjs` refuses with `IA-CORE-DELEGATION-OFF`, and you say so instead of looking for another way. Never turn it on yourself. It is never available on a cloud agent that cannot run a local command.

1. **Have a packet.** The step must already be resolved: the packet `ia_method` returned or `resolve.mjs` printed. Write it to a file, and write the step to hand over to another file, in the person's words and no wider than the packet's scope.
2. **Preview.** Run

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.mjs" --to <codex|claude|gemini> --packet <packet file> --brief <brief file> [--root <repository>] [--timeout <seconds>]
   ```

   It prints the command it would run: `codex exec`, `claude -p` or `gemini --approval-mode plan --policy <ephemeral policy.toml> --allowed-mcp-server-names ia -p`, given the IA door as its MCP server (`--mcp-config` for `claude -p`, `-c mcp_servers.ia.*` for `codex exec`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and a user-tier `--policy` TOML denying `exit_plan_mode`, `enter_plan_mode`, `write_file`, `replace` and `run_shell_command` while allowing `mcp_ia_*` for `gemini`), the brief and the packet inline on stdin, `IA_DELEGATION_DEPTH` one higher, and a timeout (default 900 seconds, at most 3,600). Show the person that command, the packet's `digest` and the timeout.
3. **Run only on their word.** Add `--run`. The result carries the exit status, whether it timed out, and the tails of its output.
4. **Report and check.** The delegate's result is proposed. Report what it says it changed and ran, then verify through this plugin's `checker` (`scripts/check.mjs`) before anyone calls it done.

**One level deep.** Inside a delegated run `IA_DELEGATION_DEPTH` is 1 or more, and `delegate.mjs` refuses with `IA-CORE-DELEGATION-DEPTH`: a delegate does the step itself or hands it back. If the other CLI is not on `PATH`, pass `--bin <path>` to the one the person names; never install one.
