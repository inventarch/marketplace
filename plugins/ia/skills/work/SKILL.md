---
name: work
description: Use when asked to coordinate, start, resume, plan or close a task, what is next, to record a decision, order dependencies, delegate a step, report progress, plan a milestone, work on records of an IA word, or judge how far to build on a draft spec. Resolves the method the repository binds and follows only its packet; says what is unconfigured instead of inventing a method.
---

**Codex:** read [the Codex host instructions](../../CODEX.md) first.

# Work

The entry point for coordinating a task. It carries no method: the packet does. The full protocol, refusals and diagnostics are in the `ia:init` skill (`${CLAUDE_PLUGIN_ROOT}/skills/init/SKILL.md`); this skill states the entry.

## 1. Resolve before acting

Through the IA door this plugin ships (its MCP server `ia`; Claude Code lists its tools as `mcp__plugin_ia_ia__<tool>`). The door takes structured input only: never pass the person's words to it except as `subject`.

1. **Once per session**, call `ia_session`. Its briefing names the workspace, the installed kits, the three lanes and the current task pin, if any.
2. Call `ia_catalogue {lane: "work"}`, adding `word` or `phase` when the person named one. It lists the lane's keys with one-line descriptions, each `bound` or `installed`. Choose the key that matches the person's words; the table below is this lane's own vocabulary, and a bound kit may offer more (`work.brainstorm` reads `ia-work:brainstorm`).
3. Call `ia_method {key}`, adding `task` for a coordination task and `subject` for what the packet is for. It returns the packet and pins the method to the task. If the session lost the packet (a compaction, a new session on the same task), call `ia_method` again with the same key and task: the pin keeps the same method.

The key for each request, as `work.<activity>` (the `ia_method` key):

| The person wants to | Activity | Scope key |
| --- | --- | --- |
| start, resume or shape a task | `task` | governance / plan |
| record or take a decision | `decision` | governance / plan |
| order what depends on what | `dependencies` | sequence / plan |
| hand a step to someone or an agent | `delegation` | execution / act |
| say where things stand | `progress` | context / orient |
| close, hand off, learn | `completion` | learning / learn |
| work on records of one IA word (a milestone, a plan, a hook, a contract...) | the word, such as `milestone` | governance / plan |

The Work lane's entry capability is a whole procedure: when the repository binds `work.*` to a capability its kit declares whole (the public `ia-method` kit's `method-operate` is one), the packet carries every cell, orient, plan, act and learn in order, whatever the activity. A per-word key (`work.milestone`, bound by `ia-method` to `milestone-method`) carries the cell of the phase its scope key names; `--phase` selects another. A bound kit may name activities of its own beyond this table: its README lists them, and `kit.mjs list` shows the keys each kit offers.

Pass `--seat` with the task's or plan's record identity; the seat's laws and mandates reach the packet only when the bound kit is installed in the repository (`envelope.kitInstalled`). Otherwise `--seat` sets only `scope.seat`, and the packet says so: read the rule by its identity instead (`node "${CLAUDE_PLUGIN_ROOT}/scripts/ia.mjs" read <rule identity> --root <envelope.kitRoot>`). Pass `--project` and `--task` for a coordination task: the resolve is then pinned to the task, and `binding.revision` names the pin every run of it shares.

## 2. The ceiling gate, when the method has one

Run this only when the packet's `references` include `governance-system/governance/law/method-provisional-foundation-ceiling`, its `closure.kit` is `inventarch/ia-method-kit`, or the repository binds `inventarch/ia-method-kit` for any `work` key (`node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" show`); otherwise skip to the next section. Then, in an IA workspace with work records, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ceiling.mjs" --task <task identity>` before you start a task (`[--plan <plan>]` without `--task` lists every task's layer). Exit 0: clear, or the first layer (design, prototype and tests on a branch; no merge or release until ratified). Exit 1: beyond the ceiling; stop and ask the person for the ratification the task waits on, which the report names. Exit 2: unknown or refused; pass `--plan`, or run the command the message names, and never treat it as clear.

## 3. Follow only the packet

Read it as the `ia:init` skill says: `instructions` are the cells to carry out in order; `references` with `when: always` are rules that hold throughout; `role.brief` is the role you take, and it grants no authority; `requestedOperations` against `effectiveOperations` and every `missing` entry go in your report; cite records by identity and digest, and the packet by its `digest`. A result is proposed until a check run through `${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs` or a command you ran verifies it, and accepted only when the person says so.

## 4. Refusals

- `IA-CORE-NO-METHOD`: no method is bound for `work.<activity>`. Say so, and when the refusal names kits that recommend the key, offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" bind <kit> --install` (it previews; `--install --apply` once the person agrees, which installs the kit through `@inventarch/public-kits` when the lock does not and needs npm and the registry). Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" list`, let the person choose, and offer `kit.mjs bind <kit> --key work.<activity> --capability <capability> [--profile <profile>]`. The public default is `kit.mjs bind inventarch/ia-method-kit --install --apply`. Do not coordinate by a method from memory.
- `IA-CORE-KIT-NOT-INSTALLED`: the key is bound to a kit the repository's lock does not install, so nothing ran. Say so and offer the command the refusal names: `kit.mjs bind <kit> --install --apply` for a kit the public-kits package carries (it runs `ia install --package @inventarch/public-kits@<version> --apply --yes`), `kit.mjs add <kit> --apply` for any other; either needs the person's agreement first, and the package route needs npm and the registry. Then resolve again.
- `IA-CORE-CONFLICT`: several methods are bound; ask the person which, then `bind.mjs precedence <kit...>`.
- `IA-CORE-NO-WORKSPACE`: not an IA workspace; say so and continue. A capability its kit resolves outside a workspace (the kit's `unbound` list in `kit.mjs list`; any capability of a kit that lists none) still resolves with `--kit <kit> --capability <name>` (the `ia:init` skill, section 3).
- Anything else: the `ia:init` skill's table.

## 5. Lanes

A repository with `.ia/governance.json` is governed: governed work needs a kit that declares governance handlers, the `ia-governance` kit, available with an InventArch account (`ia kit add`). Until one is installed the session start says so; tell the person before changing anything, and never treat the repository as ungoverned. Meetings, spec probes and audits, and other subscription methods arrive as kits once an account is connected (`kit.mjs list` shows what is installed). Delegation to an agent uses this plugin's `reader`, `worker` and `checker` briefs with the packet. Handing a step to another model's command line is the person's `/ia:delegate`, off by default: never start one yourself.
