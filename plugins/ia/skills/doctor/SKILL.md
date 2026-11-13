---
name: doctor
description: Report and explain the InventArch state of this environment and workspace. Use when asked what is wrong with IA here, or why a resolve, kit or hook refuses.
disable-model-invocation: true
---

**Codex:** read [the Codex host instructions](../../CODEX.md) first.

# Doctor

Report, explain and offer; never repair on your own.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ia.mjs" doctor --json` and explain each row that is not ok. A row's remedy is a command: offer to run it, and never run a remedy that changes files without the person's confirmation. `ia doctor` never repairs anything itself.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" check` and `kit.mjs list`, and say for each kit whether its latest release agrees with its sources, where it was found (this plugin, or `<IA home>/kits/`), and which binding keys it offers. A bound key reads as `ia-<lane>:<activity>` (the key re-spelled, whichever kit supplies it; `<lane>.*` reads `ia-<lane>`).
3. Inside an IA workspace, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" show` and `kit.mjs upgrade` (a preview): say which lane keys are bound, which are not, and which installed kits are behind their latest release. A key bound to a kit the lock does not install is `IA-CORE-KIT-NOT-INSTALLED`: offer the command the refusal names (`kit.mjs bind <kit> --install --apply`, which installs the kit through `@inventarch/public-kits` and needs npm and the registry, or `kit.mjs add <kit> --apply`). For the other findings offer `kit.mjs upgrade --apply` or `kit.mjs repin --project <p> --task <t>`. Preview each first.
4. Say what the session start reported: the account offer (and how it is turned off: `"accountOffer": false` in `~/.ia/config.json`, or `IA_NO_ACCOUNT_OFFER=1`) and, in a repository with `.ia/governance.json`, whether an installed kit declares governance handlers (`kit.mjs list`; the `ia-governance` kit does, added with `ia kit add`). Say whether the IA door is connected: the `ia_session`, `ia_catalogue` and `ia_method` tools are listed, or the lanes fall back to `resolve.mjs`.
5. If `claude plugin list` shows two plugins named `ia`, the one `ia host claude --user` rendered into `~/.ia/claude/marketplace` is registered under the same catalogue name: offer `claude plugin marketplace remove inventarch` and then adding this catalogue again (README, "Coexisting with the CLI-rendered plugin").
6. Never search the drive, parent directories or other repositories for `.ia` trees or IA tooling. If the IA CLI is missing, say so and name the install: `npm install --save-dev --save-exact @inventarch/cli@3.8.0`, or `IA_CLI_PATH`.
