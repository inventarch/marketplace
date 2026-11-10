# IA method kit

`inventarch/ia-method-kit`: the IA methodology for agents, carried as a kit of IA records rather than as plugin prose. The `inventarch` core carries it and delivers it through its Work and Knowledge entry points. Read the method through the IA CLI and apply what it delivers: never restate it from memory, and treat the records as the source (the counts and names below are an index the kit may outgrow).

## What the kit holds

One system, `ia-method`, released under the Apache-2.0 licence. It mints no words and grants no authority: every record uses a public IA word, and the workspace's mandates decide what an agent may change.

| Part | Records |
| --- | --- |
| How to think | 8 principles: `method-capability-is-the-unit`, `method-locate-before-inventing`, `method-same-pattern-every-layer`, `method-levels-of-knowledge`, `method-claims-within-evidence` (blocking), `method-lineage-accountable`, `method-ask-while-continuing`, `method-one-account` |
| How to deliver | 4 conventions: `method-capture-before-delivery`, `method-handoff-packet`, `method-reconcile-on-change`, `method-improvement-lifecycle` |
| The loop | the `method-operate` capability, composing the `method-operate` and `method-provisional-foundation` playbooks |
| The ceiling | the blocking law `method-provisional-foundation-ceiling`, the `ia-method` contract with its check and cases |
| Per word | one `<word>-method` capability and playbook for each of the 30 public record words, and `method-vocabulary` over the 14 taxonomy words |
| Release | the `ia-method-distribution` distribution |

Every playbook has the four phases, orient, plan, act and learn, each with its primary primitive and an Attention, Inference, Decision and Learning cell. `--phase` selects the cell; a whole-procedure delivery carries all sixteen in order.

## The loop

`method-operate` is the whole procedure behind the Work entry point (`delivery.json` declares it whole), so a request with no more specific binding gets all four phases:

- **orient**: state the intent as shape, phase, seat and word to `ia position`, ground in the owning sources, find what exists before inventing, and re-seat with `ia position --seat` when a word belongs to another system;
- **plan**: capture the scope and impact at the smallest useful depth, order the smallest coherent change through the owners of its words, and stay under the ceiling;
- **act**: change records only through `ia preview`, then `ia author` with the digest it returned, then `ia validate`;
- **learn**: run the checks and report them verbatim, have someone other than the author review, reconcile, leave the seven-part handoff packet, and propose improvements to their owners.

## The ceiling

Work that rests on a spec that is not accepted, or on a decision with no choice, goes one layer deep: design, prototype and tests on a branch. Nothing is built on that layer, nothing that depends on it is authored beyond its work records, and nothing is merged or released until the foundation is ratified. The law `method-provisional-foundation-ceiling` says so, and the `method-provisional-foundation` playbook says how to work under it. `ia next` blocks a task that requires an open decision, but not one that only cites a draft spec, and it does not count layers; the core's `scripts/ceiling.mjs` reports both, and fails closed (unknown, exit 2) when it cannot read a record. In an IA workspace, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ceiling.mjs" [--plan <plan>]` to see each task's layer, and `--task <task>` before starting one: exit 1 means beyond the ceiling (stop and ask for the ratification it waits on), exit 2 means unknown or refused (pass `--plan`, or run the command the message names; never treat it as clear).

## Per-word capabilities

Each public record word has one capability, `<word>-method`, composing one playbook of the same name whose subject word is that word (the names are record names, not words). Its cells say how to orient on records of the word (`ia position --word <word>`, `ia read`, `ia vocabulary <word> --schema`), plan them through the word's owning system (re-seating with `ia position --seat` when that is another system), change them (`ia preview`, then `ia author` with the returned digest, then `ia validate`) and learn from the result.

| Owning system | Words |
| --- | --- |
| `work-system` | task, plan, milestone, decision, spec |
| `governance-system` | principle, law, convention (read and apply); playbook |
| `agent-system` | agent; mandate (read and apply) |
| `agent-composition-system` | capability, agent-profile, execution-binding, harness, voice |
| `compliance-system` | contract, case; check (read and apply) |
| `learning-system` | observation, improvement |
| `session-system` | run |
| `authoring-system` | operation, authoring-guide |
| `hook-authoring-system` | hook |
| `template-system` | template |
| floor | schema, system (used, not authored) |
| `workspace-system` | workspace; distribution (installed, not authored) |

- **Governance words** (law, convention, principle, mandate, check) are read and apply only: their capabilities have the `read` effect, and their cells find the rules at the seat, turn them into constraints on the plan, apply them at every step and report how the work stood against them. Enforcing them (gates, recorded evidence, verifiers) is not part of this kit.
- **Systems, workspaces, distributions and kits** are used, installed and read here; authoring new ones is outside this kit. Do it by hand from the public IA documentation, or with an InventArch subscription.
- **The taxonomy words** (artifact-set, axis, cardinality, category, dimension, intent-shape, kind, lane, move, phase, placement, predicate, primitive, value-type) name the language itself rather than records people author. One capability, `method-vocabulary`, reads them through `ia vocabulary` and `ia position --word`.

The other record words' capabilities have the effects `read` and `local-write`.

## Bindings

The core ships no bindings. A repository that works by the IA methodology binds the kit in its `.ia/bindings.json`, and its lock must install the kit first (see "Reach the kit"); the kit's `bindings.json` recommends:

| Key | Capability |
| --- | --- |
| `work.*` | `method-operate` |
| `work.<word>`, for each of the 30 record words | `<word>-method` |
| `knowledge.vocabulary` | `method-vocabulary` |

An exact `work.<word>` key wins over `work.*`, so `resolve.mjs --entry work --activity milestone` delivers the `milestone-method` cells and any other Work activity delivers `method-operate`. The activity names are binding keys, not words. From the repository, show what the kit recommends, then install the kit and write the new keys once the person agrees (`kit.mjs bind` installs the kit with `--install` and previews without `--apply`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" recommend inventarch/ia-method-kit
node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" bind ia-method --install --apply
```

`kit.mjs bind` writes only keys the repository does not bind otherwise, and without `--install` it refuses, naming the install command, when the lock does not install the kit. To bind one key by hand: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set 'work.*' inventarch/ia-method-kit method-operate`.

Probing a design's open questions with the person, and an independent assessment before calling it complete, are available with an InventArch subscription; this kit's `method-provisional-foundation` playbook and the ceiling remain public.

## Reach the kit

Run IA through `node "${CLAUDE_PLUGIN_ROOT}/scripts/ia.mjs" <command> ...` (written `ia.mjs` below). It runs `IA_CLI_PATH` when set, else the repository's pinned `@inventarch/cli`, else the pinned version through npx; never an `ia` on PATH.

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" list` lists the kits the core carries, with the keys each recommends.
- A key the repository binds runs only a kit its own `.ia/distributions.lock.json` installs (a `packages` row or a package entry counts). When the kit is not installed, the core's resolver and checks refuse, naming the install command (the IA door does too), and the session start names the kit; the packet's `envelope.kitRoot` names the kit's folder once it runs. Add `--root <envelope.kitRoot>` only to reads of the kit's own records; that root admits none of the repository's seats.
- When it is installed, `ia position` in the repository delivers the kit's rules and cells together with the repository's own records.

The two blocking rules, the law `method-provisional-foundation-ceiling` and the principle `method-claims-within-evidence`, arrive in every packet's `rules`. Honour the rules first, then do what the cells say, then follow the pointers. A cell's `address` is its full locator, for example `ia.mjs read governance-system/definition/procedure/method-operate#orient/Attention`; `ia.mjs inspect <identity> --json` returns every section of a record, including a rule's `requires`.

Record identities: principles `governance-system/governance/principle/<name>`, the law `governance-system/governance/law/<name>`, conventions `governance-system/governance/convention/<name>`, playbooks `governance-system/definition/procedure/<name>`, capabilities `agent-composition-system/definition/capability/<name>`, the contract `compliance-system/contract/signature/ia-method`.

## Adopt the kit

The preferred route is `node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" bind ia-method --install --apply`, which installs the public kits through the public kits package and writes the recommended keys; it needs npm and the registry, and a kit that package does not carry is installed with `kit.mjs add`. Adoption is the vendored route: it installs `inventarch/ia-method-kit` into a repository's IA workspace, so `ia position` there delivers the kit's rules and cells with the repository's own records, and the repository's work can cite them. Ask the person first: it writes files they commit. The repository must be an IA workspace (`.ia/src`; otherwise `ia init` first, which is the person's call), and its pinned `@inventarch/cli` must be the version the release names.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" adopt ia-method <repository> --dry-run
node "${CLAUDE_PLUGIN_ROOT}/scripts/kit.mjs" adopt ia-method <repository>
```

`--dry-run` lists what would be written. The real run checks that the archive hashes to the recorded release, copies it and the language base it pins into `vendor/ia/`, and runs `ia install`, which pins it in `.ia/distributions.lock.json`. Commit `vendor/ia/` and `.ia/distributions.lock.json`; `.ia/distributions/` is restored locally (`ia restore`), never committed. `ia validate` should still pass afterwards.

## Maintain the kit

A change to any record here is a new kit release: bump `version` in `.ia/release.json`, record the release from the catalogue root, and run `node --test plugins/ia/tests/kit-method.test.mjs`; with `IA_CORE_TEST_CLI=<@inventarch/cli dist/main.js>` it also restores and validates the kit and repacks it against the recorded digest. A recorded release is never rewritten once published: adopted repositories pin its archive digest.
