# inventarch/ia-kb-kit

A KB method as an IA kit, and the default method of the ia plugin's Knowledge lane (`ia:knowledge`): where a spec, PRD, policy or decision lives (the organisation KB or a source repository), where a user's workspaces are saved, how a `@spec` anchor is bound to one exact body, and how a KB's documents, decisions and checks are kept current. The core delivers it through `ia position`, so an agent follows the kit's records instead of a hand-read skill tree.

Guidance only: it installs reusable expertise, not an organisation's corpus or access grants; it grants no authority and installs no hook. Its four declared checks run through the core's checker runner, including a task's own workspace-relative locator manifest and the workspace's decision lifecycle (see Gates as checks). Language base `inventarch/language ^3.2.0`. Licensed Apache-2.0.

Version 0.9.4 re-cuts 0.9.0, the first public release, on @inventarch/cli 3.8.0. Organisation-wide custody of knowledge across many repositories (cross-repository references kept centrally, reconciliation, participant and vocabulary upkeep) is available with an InventArch subscription; this kit covers a single KB or source repository.

## Layout

```text
.ia/release.json                 the release descriptor (id, version, distribution, language, assets)
.ia/distributions.lock.json      the pinned language base
.ia/src/workspace.ia             the kit's workspace, participant and mandate
.ia/src/systems/ia-kb/           the one system
  system.ia                      @system ia-kb and its steward
  records/capabilities.ia        kb-knowledge (the entry), one capability per stage, kb-retrieve, kb-review and kb-gates
  records/playbooks.ia           one playbook per stage, plus kb-retrieval (librarian) and kb-review (reviewer)
  records/conventions.ia         placement, workspace location, binding, lifecycle, role briefs, host adaptation, IA reads, evidence reporting
  records/laws.ia                the blocking rules
  records/roles.ia               the librarian, reviewer, curator and gate-runner agents, mandates and profiles
  records/compliance.ia          the ia-kb contract, the coverage check, the four declared checks and the cases
  records/distribution.ia        the release root
assets/                          the three references: placement, document binding, lifecycle
assets/examples/split-body/      the worked example: README, anchor.ia, locators.json, model-api.md
scripts/check-decisions.mjs      the decision lifecycle checker; it runs from the kit folder
scripts/check-locators.mjs       the locator checker; it runs from the kit folder
checks.json                      the fixed argv of the four runnable checks, for the core's checker runner
delivery.json                    the capabilities the resolver delivers whole: every one that has a playbook
bindings.json                    the bindings the kit recommends (bind.mjs recommend)
releases.json, releases/         the recorded releases: archive, manifest, sources digest, CLI, record names
```

The example's `anchor.ia` sits under `assets/`, outside `.ia/src`, so it is never one of the kit's records. `locators.json` pins the exact bytes of `model-api.md` (sha256 `fab3edf9…`), and the kit test checks that the body still hashes to the pinned digest.

## Stages

| Stage | Capability and playbook | Conventions | Activity |
| --- | --- | --- | --- |
| Route, and anything without its own stage | `kb-knowledge` (all four phases: orient, plan, act, learn) | every one, by stage | `knowledge.*` |
| Where a document lives, where a workspace is saved | `kb-place-content` | `kb-placement`, `kb-workspace-location` | `place` |
| Bind a `@spec` anchor to one exact body, local or in another repository | `kb-bind-document` | `kb-document-binding` | `bind` |
| Add or revise documents with their `@spec` records, decisions and navigation | `kb-maintain-document` | `kb-document-binding`, `kb-lifecycle` | `maintain` |
| Check admission, coverage, the decision lifecycle and navigation | `kb-check` | `kb-ia-reads`, `kb-evidence-reporting` | `check` |
| Migrate a legacy knowledge workspace to the three-record starter | `kb-migrate` | `kb-ia-reads`, `kb-workspace-location` | `migrate` |
| Retrieve bounded context with attribution | `kb-retrieve` (playbook `kb-retrieval`) | `kb-role-briefs` | `find`, `explain` |
| Review a KB change independently | `kb-review` | `kb-role-briefs`, `kb-lifecycle` | `review` |

`kb-gates` has no playbook: it is the gate runner's capability, composing the four declared checks.

### Where workspaces live

`@convention kb-workspace-location` sets the default: a user's workspaces live in `~/Documents/ia/<name>` (for example `~/Documents/ia/studio`, `~/Documents/ia/music`, `~/Documents/ia/design`), and the user can point a workspace anywhere else. `~/.ia` is the IA home only (config, state, the location registry and installed kits) and never holds a workspace: the CLI refuses a workspace inside its home. A knowledge repository holds one `.ia/src`, at its root: a personal or single-team KB declares one `@workspace` there, and an organisation store declares one `@workspace` per department, each declaring its scope folders, plus an organisation `@workspace` that also declares the repository root (`". @authored"`). A `workspaces/<name>/` folder is only for a workspace released or adopted on its own. The `kb-place-content` plan cell applies it where placement is decided.

## Roles

| Agent | Profile | Mandate | Capabilities | Runs as |
| --- | --- | --- | --- | --- |
| `kb-librarian` | `kb-librarian-profile` (25 steps) | `ia-kb-reader-mandate` (Observation, Verification) | `kb-retrieve` | reader |
| `kb-reviewer` | `kb-reviewer-profile` (30 steps) | `ia-kb-reader-mandate` | `kb-review` | reader |
| `kb-gate-runner` | `kb-gate-runner-profile` | `ia-kb-checker-mandate` (Observation, Verification, Execution) | `kb-gates` (its checks are the four gates) | checker |
| `kb-curator` | `kb-curator-profile` (40 steps) | `ia-kb-worker-mandate` (all moves, own worktree, assigned paths) | `kb-maintain-document`, `kb-bind-document` | worker |

The core's registered agents stay `reader`, `checker` and `worker`; the host runs a profile as one of them with the packet, whose `role.brief` is the profile's text and whose `references` carry the profile's mandate (`when: role`). The writer boundaries, the single-writer rule, the not-evaluated rule and the reviewer's independence are in the profiles' text (so `role.brief` carries them), in `@convention kb-role-briefs`, and in the five laws, which `references` lists (`when: always`) wherever the kit's tests resolve it: in a repository that installed the kit, at the workspace seat and at a `@spec` seat. `kb-check` itself is composed by no profile: the agent running the stage is its role, and it delegates the declared gates to the gate runner.

## Recommended bindings

The core ships no bindings. A repository that keeps its knowledge the KB way binds the kit in its `.ia/bindings.json`. The repository's lock must install the kit first: a key bound to a kit the lock does not install is refused with `IA-CORE-KIT-NOT-INSTALLED`. From the repository, `kit.mjs bind inventarch/ia-kb-kit --install --apply` installs the kit and writes the same keys; the lines below bind them one by one once the kit is installed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set 'knowledge.*' inventarch/ia-kb-kit kb-knowledge
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.find inventarch/ia-kb-kit kb-retrieve
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.explain inventarch/ia-kb-kit kb-retrieve
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.maintain inventarch/ia-kb-kit kb-maintain-document
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.place inventarch/ia-kb-kit kb-place-content
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.bind inventarch/ia-kb-kit kb-bind-document
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.check inventarch/ia-kb-kit kb-check
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.migrate inventarch/ia-kb-kit kb-migrate
node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set knowledge.review inventarch/ia-kb-kit kb-review
```

`delivery.json` declares every capability that has a playbook whole, so each key delivers all sixteen cells of its playbook, phases in order, read by identity (`source: "playbook"`), whatever `ia position` picks at the scope key or the seat. The kit's opt-in tests first see an uninstalled kit refused with `IA-CORE-KIT-NOT-INSTALLED`, then resolve every key, after `kit.mjs adopt`, in an IA workspace holding a `@spec`, both at the workspace seat and with `--seat` at that `@spec`, and each time get:

| Key | Capability | Instructions | `role.profile` (mandate, `when: role`) | `evidence.required` |
| --- | --- | --- | --- | --- |
| `knowledge.*` (`packet`, `reconcile` and any activity without its own key) | `kb-knowledge` | 16 cells of `kb-knowledge`: the stage table with each stage's activity, the Delivery hand-off, the roles, the locator command, IA reads and the MCP door, the guards, reporting and the lifecycle | none | none |
| `knowledge.find`, `knowledge.explain` | `kb-retrieve` | 16 cells of `kb-retrieval` | `kb-librarian-profile` (`ia-kb-reader-mandate`) | none |
| `knowledge.maintain` | `kb-maintain-document` | 16 cells of `kb-maintain-document` | `kb-curator-profile` (`ia-kb-worker-mandate`) | `kb-check-validate`, `kb-check-decisions` |
| `knowledge.place` | `kb-place-content` | 16 cells of `kb-place-content` | none | none |
| `knowledge.bind` | `kb-bind-document` | 16 cells of `kb-bind-document` | `kb-curator-profile` (`ia-kb-worker-mandate`) | none |
| `knowledge.check` | `kb-check` | 16 cells of `kb-check` | none (the agent running the stage) | `kb-check-validate`, `kb-check-decisions` |
| `knowledge.migrate` | `kb-migrate` | 16 cells of `kb-migrate` | none | `kb-check-validate` |
| `knowledge.review` | `kb-review` | 16 cells of `kb-review` | `kb-reviewer-profile` (`ia-kb-reader-mandate`) | none |

Every packet lists the five laws in `references` (`when: always`). Where a capability composes `kb-check-validate`, `missing` holds the core's `enforcement` entry: run the check only through `scripts/check.mjs`. Pass `--seat <the document's @spec identity>` for document work in a repository that installed the kit.

`find`, `explain` and `maintain` are the core Knowledge entry point's own activities, and `packet` and `reconcile`, which have no key of their own, resolve to the `kb-knowledge` procedure. `place`, `bind`, `check`, `migrate` and `review` are activities the entry's table does not list: the resolver accepts any `knowledge.<activity>` key and gives it the entry's default scope key (context / orient), and the router's cells name the activity of each stage, so an agent resolves the stage it chose. Without the exact keys, `knowledge.*` alone still works: every activity resolves to the router.

## Gates as checks

Language 3.2.0 admits a `@check` only when it names a built-in evaluator, so all four runnable checks `runs COMP-CHECK` (IA evaluates only the declaration) and carry their exact command as `check.scope`; `checks.json` gives the core's checker runner (`scripts/check.mjs`) the same command as a fixed argv, and the runner executes nothing else. `kb-gates` composes all four and is the gate runner's capability; `kb-check-validate` is also composed by the stages whose claims rest on validation (`kb-check`, `kb-maintain-document`, `kb-migrate`), and `kb-check-decisions` by the two whose claims rest on the decisions (`kb-check`, `kb-maintain-document`), so each is their `evidence.required`. No stage composes `kb-check-locators`.

- `kb-check-validate`: `ia validate --json` in the workspace under check (`${IA}`, the CLI the runner resolves). Exit 0 when the workspace admits, 3 when validation refuses it. The findings still need reading: zero errors with not-evaluated requirements is admission, not a compliance pass.
- `kb-check-decisions`: `node ${KIT}/scripts/check-decisions.mjs ${IA}` in the workspace under check. IA's decision schema leaves a decision's decider, choice and rationale optional; a KB accepts a decision only when a made one names them and keeps them once superseded. Through the CLI the runner resolves (the trailing `ia` of the scope), the checker runs `ia validate` and judges nothing in a workspace IA does not admit, because `ia records` answers one too but leaves out the decisions validation refuses. It then reads the workspace's admitted records with `ia records` and reports each of the workspace's own decisions that is made without a non-empty one of the three (`decision-made-needs-acceptance`), superseded without them (`decision-superseded-needs-acceptance`), or superseded with no `@decision` superseding it, by the successor's `supersedes` or its own `superseded-by`, in the same file or another (`decision-superseded-needs-successor`). Open, withdrawn and adopted decisions are not checked, and the exact accepted revision (`decision.effective-revision`) is not required yet. Exit 0 with no finding, 3 with one (the checker exits 1); a workspace IA does not admit, or records the checker cannot read, exit it 2, never a pass. `kb-check-validate` reports the admission findings themselves.
- `kb-check-locators`: `node ${KIT}/scripts/check-locators.mjs ${KIT}/assets/examples/split-body/locators.json`. It proves on the host that the checker runs from the kit folder and that the worked example passes it (metadata only); it says nothing about a task's manifest. Byte verification with `--checkout` is a direct invocation of the script; do not claim body verification from a metadata-only check.
- `kb-check-task-locators`: `node ${KIT}/scripts/check-locators.mjs ${ARG:manifest}` in the workspace. Invoke `node <ia plugin root>/scripts/check.mjs kb-check-task-locators --root <workspace> --kit inventarch/ia-kb-kit --manifest docs/locators.json`. The manifest must be a regular workspace-relative file through real directories; absolute, traversing, linked and missing paths refuse before execution. No task manifest means this check is not run; the example cannot substitute for it. A bad manifest exits 3; an invalid argument exits 2. Successful output still says metadata-only, zero network requests, no body disclosure and native graph closure not evaluated.

The one evaluated check is `ia-kb-coverage` (`COMP-COVERAGE`) over the contract's ten requirements and twenty cases; the kit's tests evaluate the requirements.

## Validate and pack

Copy `.ia/`, `assets/` and `scripts/` to a scratch folder outside `~/.ia` (the CLI refuses a workspace there), then with the pinned CLI:

```sh
ia restore --apply --yes --root <copy>      # offline: the CLI carries the pinned language base
ia validate --root <copy> --json            # expects status admitted, zero errors
ia pack --descriptor .ia/release.json --force --root <copy> --json
```

`plugins/ia/tests/kit-kb.test.mjs` runs the structural checks, the locator checker, the decision checker and the core's runner without a CLI (the decision checker reads a stand-in's records) and, with `IA_CORE_TEST_CLI=<path to @inventarch/cli dist/main.js>`, the restore and validate above, the unknown-evaluator refusal, `kb-check-validate` and `kb-check-decisions` through the runner, the refusal of a bound kit the lock does not install and the delivery of every recommended binding (adopted, at the workspace seat and a `@spec` seat), and a repack that must equal the recorded release. `plugins/ia/tests/kit-kb-ingestion.test.mjs` adopts the kit into a fresh workspace with the repository's pinned CLI and checks a task's own locator manifest through the runner. The recorded release's `sources` digest covers `.ia/`, the assets, `checks.json` and `delivery.json`, so any edit needs a repack, and a recorded release is never rewritten once published, so changed records need a new version in `.ia/release.json`.

`source.commit` records the source baseline used for this version. The archive and sources digests pin the candidate bytes; they do not assert that the candidate is published.
