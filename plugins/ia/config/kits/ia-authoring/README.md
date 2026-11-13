# inventarch/ia-authoring-kit

The public method kit for authoring with IA, and the Delivery lane's default kit. It covers three kinds of authoring, one part system each, behind one entry capability:

- **Records** (`ia-authoring-record`): records of existing public IA words in a workspace (`authoring-workspace-authoring`), and finding out what IA admits by experiment in a scratch copy first (`authoring-probing-the-ia-toolchain`, run by the toolchain prober's profile). Conventions carry IA's concepts, the public systems, the toolchain, what goes where, how to author, the IA rule sheet and the IA model.
- **Host plugins** (`ia-authoring-host`): lower a Claude, Codex or Grok plugin into IA records (`host-lower`), project it back (`host-project`), measure a skill's triggering (`host-evaluate`) and qualify a plugin on its hosts (`host-qualify`). The trigger-evaluation protocol is a set of `host-trigger-*` conventions.
- **Catalogue plugins** (`ia-authoring-catalogue`): a catalogue's house rules as nine `catalogue-*` conventions, the `catalogue-author` capability that brings a plugin inside them, and the `catalogue-validate` check that runs the catalogue's validator.

The main system, `ia-authoring`, holds the entry capability `authoring-deliver`, whose playbook has all four phases (orient: understand; plan: design; act: change; learn: review and deliver) and routes to the part capabilities, and the conventions the parts share: `authoring-scope`, `authoring-kit-install-and-bind`, `authoring-kit-tools`, `authoring-activity-keys` and `authoring-host-notes`.

**Scope.** Records of existing public words only. A new word, system, workspace or kit is out of scope: author it by hand from the public IA documentation, or with an InventArch subscription.

This kit replaces two retired kits, `inventarch/host-authoring-kit` and `inventarch/catalogue-authoring-kit`, whose records it carries as its host and catalogue parts. Their old releases remain in the history of the catalogue they came from.

Version 0.1.4. Language base `inventarch/language ^3.2.0`, packed with `@inventarch/cli 3.8.0`. Guidance, checks and scripts only: it grants no authority and installs no hook. Licence Apache-2.0.

## Layout

```text
.ia/release.json                         the release descriptor (id, version, distribution, language, assets)
.ia/distributions.lock.json              the pinned language base
.ia/src/workspace.ia                     the kit's workspace, participant and mandate
.ia/src/systems/ia-authoring/            the main system: entry capability and playbook, shared conventions, the release root
.ia/src/systems/ia-authoring-record/     record authoring: two stages, the toolchain prober, conventions, laws, checks, the kit's contract
.ia/src/systems/ia-authoring-host/       host authoring: four activities, five role briefs, the trigger conventions, checks, contract
.ia/src/systems/ia-authoring-catalogue/  catalogue authoring: nine conventions, one capability, the validator check, contract
assets/probe-examples/                   admitted.ia and refused.ia, examples to copy into a scratch probe
assets/trigger-config.md                 the trigger-evaluation config the runner reads
scripts/probe.mjs                        the toolchain probe
scripts/field-lint.mjs                   the governance lint
scripts/eval-triggers.mjs                the trigger-evaluation runner
checks.json                              the fixed argv of every runnable check
delivery.json                            the capabilities delivered whole
bindings.json                            the activity keys the kit recommends, and what resolves outside a workspace
releases.json                            the release index; each version's record list is in releases/<version>.json
```

The scripts import the kit's own scratch-capture helper (`./lib/scratch.mjs`), so they run from any copy of the kit folder and reach no path outside it.

## Delivery and bindings

`delivery.json` declares every capability whole: the core's resolver delivers each one's playbooks, every cell in phase order, whatever `ia position` returns at the entry's key.

`bindings.json` recommends these keys (`bind.mjs recommend inventarch/ia-authoring-kit` lists them read-only; `kit.mjs bind inventarch/ia-authoring-kit --install --apply` installs the kit and writes those the repository does not bind yet):

| Key | Capability |
| --- | --- |
| `delivery.*` | `authoring-deliver` |
| `delivery.author`, `delivery.workspace-authoring` | `authoring-workspace-authoring` |
| `delivery.probe` | `authoring-probing-the-ia-toolchain` |
| `delivery.host` | `host-lower` |
| `delivery.host-project` | `host-project` |
| `delivery.host-evaluate` | `host-evaluate` |
| `delivery.host-qualify` | `host-qualify` |
| `delivery.catalogue` | `catalogue-author` |

Outside an IA workspace, `resolve.mjs --kit inventarch/ia-authoring-kit --capability <name>` resolves `authoring-deliver`, the four host capabilities and `catalogue-author`; record authoring and the probe need a workspace.

## Checks

| Check | Command |
| --- | --- |
| `authoring-workspace-validate` | `ia validate --severity error --json` in the workspace |
| `authoring-field-lint` | `node <kit>/scripts/field-lint.mjs --root <workspace>`, exit 1 on a finding |
| `host-validate` | `ia validate` |
| `host-fixed-point` | `ia project claude --product plugin --check` |
| `host-trigger-eval` | `node <kit>/scripts/eval-triggers.mjs --config <workspace>/.ia/work/trigger-eval.json`, timeout 21600 seconds |
| `catalogue-validate` | `python tools/validate.py` in the catalogue |

`ia-authoring-record-coverage` is the coverage check of the kit's contract (REQ-AUTH-01 to 05), which IA evaluates itself. The host contract (REQ-HOST-01 to 03) and the catalogue contract (REQ-CAT-01) keep their own cases.

## Release

The release is recorded in `releases.json`, format 2. The sources digest covers `.ia/`, the declared assets, `checks.json`, `delivery.json` and `bindings.json`.
