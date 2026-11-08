# Host support

| Host | What it loads | Hooks | Qualified |
|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json`; the core's skills, agents, scripts and bundled kits, and the IA door as the plugin's MCP server `ia` (`.mcp.json`; tools `mcp__plugin_ia_ia__<tool>`, decision `public-door-mcp`) and the InventArch account connector `inventarch` (same file; the host runs the OAuth sign-in; tools `mcp__plugin_ia_inventarch__<tool>`, decision `public-account-connector`) | The read-only SessionStart bootstrap (`startup\|resume\|compact`) and `scripts/handlers.mjs` for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop, which runs the handlers installed kits declare; all pinned by `tools/validate.py` (decisions `public-core-hooks`, `public-kit-handlers`) | Not yet (task `qualify-claude-code`) |
| Codex | `.agents/plugins/marketplace.json`; the core's skills and its `CODEX.md`. The door comes from the plugin itself (its Codex manifest names `./.codex-mcp.json`, decision `public-door-codex`) or from the repository's committed `.codex/config.toml` entry (README, "Bootstrap a repository for every host") | None yet: the Codex manifest keeps the hooks off with `"hooks": {"hooks": {}}` (task `codex-door-and-handlers`, handlers half) | Smoke at 1.4.0 (docs/smoke/codex-ia-1.4.0.json; at 1.2.0, docs/smoke/codex-ia-1.2.0.json, it also listed the door's tools through Codex's `mcpServerStatus/list`): plugin install and skills; no model turn (task `qualify-codex`, `node tools/smoke-codex.mjs --codex <codex executable> --report <file>`) |
| GitHub Copilot | No plugin. The repository's committed door entry (`.vscode/mcp.json` in VS Code, or the repository's Copilot MCP configuration for the coding agent) and its instruction block (`.github/copilot-instructions.md` or `AGENTS.md`) | None: Copilot runs no hooks, so there is no bootstrap, account offer, governance probe or kit handler; the instruction block says to call `ia_session` first | Not yet |

Codex ignores `disable-model-invocation`, so it lists every skill; every skill therefore opens with the bridge line to `CODEX.md` (decision `public-codex-manifest-interface`). Without hooks, a Codex session gets no bootstrap, account offer, governance probe or kit handlers: `CODEX.md` tells the agent to run `scripts/bootstrap.mjs` itself.

## The IA door

The door is one MCP server, `@inventarch/mcp-door`, started with `npx -y @inventarch/mcp-door@3.5.0` (on native Windows, where `npx` is a `.cmd` shim, through `cmd /c`; this plugin's own entry runs `node scripts/door.mjs`, which does that for you). Its tools take structured input only. The lanes call three of them: `ia_session` once per session (the workspace, the installed kits, the three lanes and the current task pin, in at most 2,500 characters), `ia_catalogue {lane}` (the lane's keys with one-line descriptions, each `bound` or `installed`) and `ia_method {key}` (the packet, with the method pinned to the task). It finds kits in the folder `IA_KITS_DIR` names, which this plugin sets to its bundled kits, and in `<IA home>/kits`.

- **Claude Code with this plugin:** the plugin ships the door (`plugins/ia/.mcp.json`), so nothing else is needed. Agents and permission rules name its tools `mcp__plugin_ia_ia__<tool>`; a bare server key never matches a plugin's server.
- **Any host, with or without the plugin:** the repository commits the door entry and the instruction block (README, "Bootstrap a repository for every host"). This is the only way in for GitHub Copilot, in VS Code and in the coding agent, which runs no plugin and no hooks; a cloud session keeps only what the repository commits, and never delegates.
- **No fallback:** the 3.5.0 door serves `ia_session`, `ia_catalogue` and `ia_method`, and the lanes use only the door (task `drop-door-fallback`, done). A committed entry that pins an older door does not serve them: pin `@inventarch/mcp-door@3.5.0` or later.

In Claude Code the InventArch account is the core's bundled remote MCP server `inventarch` (`https://api.inventarch.dev/mcp`, public client `claude-code`); the host runs the OAuth sign-in, and nothing in this catalogue stores a token. Codex does not get the bundled connector yet (task `codex-account-connector`): its users add the remote server themselves.

## Kit trust and process hygiene

The core's hooks and its checker run kit code in three places: `handlers.json` scripts (`scripts/handlers.mjs`), `onwrite.json` commands (`scripts/on-write.mjs`, also run by `handlers.mjs post`) and `checks.json` commands (`scripts/check.mjs`). The same rule decides all three (decision `public-kit-trust`, `scripts/lib/trust.mjs`).

**Trust.** A kit runs code only when both hold:

- its publisher is on `plugins/ia/config/trusted-publishers.json`, which ships as `{"format": 1, "publishers": ["inventarch"]}`. The publisher is the kit id's namespace (`inventarch/ia-governance-kit` is published by `inventarch`); a `publisher` field in `.ia/release.json`, when a kit has one, must name the same publisher or the kit is untrusted;
- its bytes are its recorded release: the sources digest (`.ia/`, the declared assets and the sidecars, `lib/kit.mjs` `sourcesDigest`) equals the `sources` of the latest row in its `releases.json`, and `.ia/release.json` names that version. A kit with no recorded release is untrusted. A handler's `run` script must also be a declared asset, so that digest covers it.

`node scripts/kit.mjs check` shows `runsCode` for every kit, and `untrusted` with the reason when it does not.

**What an untrusted kit gets.** Its records and sidecars are still read, and a handler entry's `context` text, which is data, is still delivered as `additionalContext` with no process started. Its `run` entries and `onwrite.json` commands are skipped, and its checks are refused with `IA-CORE-KIT-UNTRUSTED`. At session start the answer names each such kit once, with why ("its publisher acme is not on this plugin's trusted list", "its bytes are not its recorded release 0.9.0"). A `pre` handler of a kit whose publisher is not on the list never runs, so it never blocks, even in a governed repository; there the bootstrap's governance notice says when the only governance kit installed may not run. In a governed repository a trusted `pre` handler that crashes, times out, exits with another code or answers past the output cap refuses the call (fail closed).

**An altered gate fails closed.** In a governed repository, a kit whose id names a trusted publisher (`inventarch/…`) and that declares a tool `pre` handler the trust check refuses (its bytes are not its recorded release, its handler script is not a declared asset, or the script is not a file inside the kit) refuses every pre-tool call, whatever the handler's tool match, and runs nothing (`scripts/lib/handlers.mjs` `alteredGates`). The reason names the kit and the fix:

```text
inventarch/ia-governance-kit: its pre-tool gate may not run, because its bytes are not its recorded release 0.9.0 (the sources digest differs), so every tool call in this governed repository is refused (fail closed). To fix it, reinstall its recorded release with `node "<ia plugin>/scripts/kit.mjs" add --from <its release folder or archive> --apply`, or remove .ia/governance.json to stop governing this repository.
```

The session-start governance notice says the same. A drifted governance kit therefore never leaves a governed repository silently ungoverned. A kit from a publisher that is not on the list still never blocks, so installing one never stops anyone's work, and an ungoverned repository applies no block of any kind. The check reads what is installed: a kit whose `handlers.json` was removed, or no longer parses, declares no gate, so this catches drift, not a deliberate removal (signed releases close that, task `signed-kit-releases`).

A handler entry is `{ run?, context?, ... }` with at least one of the two:

```json
{ "format": 1,
  "session": [ { "context": "Read docs/style.md before editing prose." } ],
  "tool": [ { "run": "scripts/handlers/pre-tool.mjs", "phase": "pre", "match": "Write|Edit|Bash" } ] }
```

**Why nothing extends the list.** No setting, environment variable or file in the IA home adds a publisher in this release. Everything such an approval could be written to sits in the person's own profile, where an agent with a shell can write too, so it could approve itself. A publisher joins the list only in a plugin release.

**What trust does not do.** The publisher is a claim the kit makes, not a signature: whoever can write into `<IA home>/kits` can install a kit that names itself `inventarch/<name>-kit`, and the digest is compared with the release record the kit itself carries. Trust stops other publishers' kits from running code and stops a recorded release whose files changed afterwards; it does not stop a deliberate impersonation. The sources digest also covers a kit's declared entry scripts, not every module they import. Signed releases close both, at the execution-binding release.

**Hygiene, not a sandbox.** Every child the three runners start (`scripts/lib/hygiene.mjs`):

- gets an allowlisted environment, not the runner's whole one: the command path and the OS (`PATH` and its Windows spellings, `PATHEXT`, `SystemRoot`, `windir`, `ComSpec`, `PSModulePath`); the person's folders (`HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, the `ProgramFiles` family, `XDG_CONFIG_HOME`, `TEMP`, `TMP`, `TMPDIR`, the user and machine names, `SHELL`); `LANG`, `LANGUAGE`, `TZ` and `LC_*`; git's configuration lookup (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`, through which hosts trust a sandboxed checkout); the host's `CLAUDE_PID` and `CLAUDE_PROJECT_DIR`; and `IA_*`, InventArch's own namespace, which carries the contract's `IA_KIT_ROOT`, `IA_WORKSPACE_ROOT` and `IA_HOME` and the kit settings a person sets. A name that looks like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `API_KEY`, `PRIVATE_KEY`) never passes, even under `IA_`, and `NODE_OPTIONS` and `NODE_PATH` never pass, so nothing preloads into a child. A check that needs a credential, such as a host's API key, cannot get it through the checker: run that command yourself.
- has its whole process tree killed on its deadline: on POSIX the child leads its own process group and the group gets `SIGKILL`, also as soon as the child exits; on Windows `taskkill /T /F /PID`. A hook that runs out of budget kills what it started before it exits, and a governed gate still running then refuses the call.
- keeps at most 256 KiB of stdout and 256 KiB of stderr from a handler or on-write command; the rest is dropped. A check keeps its full output as execution evidence (up to 64 MiB a stream, `lib/check-output.mjs`), since a test suite's log is longer than that.

It is not a sandbox. A trusted kit's code runs as the person, with their files, their network and their other processes within reach; Node's permission model does not change that, because it leaves the network open, lets child processes run unconfined and lets a debugger attach to another Node process. A POSIX descendant that starts its own session leaves the process group, and on Windows a descendant still running after its parent has exited is not reached by `taskkill /T` (a job object needs native code).

**What the ia-governance kit needs.** Measured on 2026-10-31 by running its handlers for every event in a governed repository with an environment probe: its scripts read `IA_HOME`, `IA_GOVERNANCE_STATE_DIR`, `IA_COORDINATION_HOME` and `CLAUDE_PID` (when a session starts after `/clear`) by name, and hand the environment on to `git`, which needs `PATH` and the home and git configuration names above. Its other settings (`IA_CORE_ROOT`, `IA_GOV_*`, `IA_CODEX_BIN`, `IA_DELIVERY_*`) are `IA_*` too, and it refuses to run with `NODE_OPTIONS` or `NODE_PATH` set in some paths. With the allowlist its pre-tool gate still refuses a write with no ledger bound and a forged ledger write, and allows a read (`plugins/ia/tests/trust.test.mjs`, with `IA_CORE_TEST_GOVERNANCE_KIT` set to its folder).
