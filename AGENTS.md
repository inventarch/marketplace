# Work boundaries

This is the public InventArch marketplace (`inventarch/marketplace`, catalogue name `inventarch`), cut on 2026-10-30 with fresh history (decision `public-catalogue-cut`). Anyone can read every byte here: a method that must stay proprietary does not belong in this repository. Read README.md, docs/decisions.md and docs/roadmap.md first. Every decision has a `@decision` record in `.ia/src/decisions.ia` and a row in docs/decisions.md; every Markdown document is a record's `source` or sits under a spec's `covers` path; follow-up work is a `@task` in `.ia/src/work.ia`. `tools/validate.py` refuses a decision or document without its record.

It owns one plugin and three kits:

- `plugins/ia`: the core, plugin `ia` (decision `public-plugin-ia`). The Work, Knowledge and Delivery lanes (`ia:work`, `ia:knowledge`, `ia:delivery`, the only model-invocable skills), which call the IA door's `ia_session`, `ia_catalogue` and `ia_method` (the plugin's MCP server `ia`, `.mcp.json`, decision `public-door-mcp`; `.mcp.json` also carries the InventArch account connector `inventarch`, decision `public-account-connector`) and fall back to the resolver over `ia position` with `.ia/bindings.json` and per-task pins; the user-invoked `ia:init`, `ia:doctor` and `ia:delegate` (decision `public-delegate`); the reader, checker and worker profiles; the kit lookup (its `config/kits`, then `<IA home>/kits/<kit>/<version>/`), kit dependencies (`public-kit-dependencies`) and the user kit verbs in `scripts/kit.mjs`; the SessionStart bootstrap (with the account offer, the governance probe and the pin after a compaction); and `scripts/handlers.mjs`, which runs the handlers installed kits declare (`handlers.json`, and `onwrite.json` as tool post handlers; decisions `public-core-hooks`, `public-kit-handlers`).
- `kits/ia-method`, `kits/ia-kb`, `kits/ia-authoring`: the public kit sources, bundled into the core's `config/kits` by `tools/bundle-kits.mjs` (decision `public-default-kits`). Kit names follow `public-kit-naming`.

A Git install copies a plugin's whole folder, `tests/` included. `tools/validate.py` admits only skills, agents, references, templates, examples, scripts, config, tests and top-level Markdown in a plugin, refuses hooks (apart from the core's pinned set), `.mcp.json` (apart from the core's pinned pair, the IA door and the account connector), commands, settings, `bin/` and `hooks`, `mcpServers` or `permissionMode` in skill or agent frontmatter, and scans `tests/` for sensitive bytes too (decision `public-plugin-components`).

## Plugin rules

- A plugin's entry skills are model-invocable: `ia`'s are its three lanes (`ENTRY_SKILLS` in `tools/validate.py`); any other plugin has one router named after it. At most four model-invocable skills per plugin; the rest set `disable-model-invocation: true` and are reached by path. Every description says what and when.
- Agents need `model`, a "Use this agent when…" description and a `tools` allowlist (never a denylist).
- Target exactly `@inventarch/cli` 3.5.0 and `inventarch/language` 3.2.0 (`sources.lock.json`, decision `public-cli-3-5-0`). Never use the `ia` on PATH; use the core's `scripts/ia.mjs` or `npx -y -p @inventarch/cli@3.5.0 -- ia`. IA refuses `ia init` inside its home `~/.ia`.
- No machine paths, credentials, tenant corpus, people's names or other organisations' material in any file.
- Manifests: the Claude manifest carries `displayName`; the Codex manifest is the Claude one without it, plus `skills` and Codex's `interface` block (`public-codex-manifest-interface`). Every plugin ships a `CODEX.md`, and every skill opens with the `**Codex:**` bridge line to it. Every manifest and kit says `Apache-2.0` (`public-apache-license`).
- Every change that ships adds a release note (`node tools/release.mjs note --plugin <name> --bump <patch|minor|major|none> --title … --summary …`, which writes `releases/pending/<id>.json`; decision `public-release-notes`). Never bump a plugin's version, `sources.lock.json` `pluginVersion` or its CHANGELOG by hand: the release pull request, which only an operator starts (`.github/workflows/release-pr.yml`), folds the notes into them and records `releases/changesets/<plugin>-<version>.json`; merging it tags `<plugin>-v<version>` (`.github/workflows/release.yml`). See [releases/README.md](releases/README.md).
- `main` takes changes only through a pull request that merges with a merge commit, after the Gates and Native verified checks pass on Ubuntu and every review thread is resolved (decision `public-main-rulesets`, `.github/rulesets/`).

## Kit rules

- Edit `kits/<kit>`, never the bundled copy; see [kits/README.md](kits/README.md).
- A release is two commits: a sources commit, then a stamp commit that sets `.ia/release.json` `source.commit` to it, packs with the pinned CLI and records the release (`node tools/kit.mjs pack <kit>`, then `node tools/kit.mjs bundle --write`, `node tools/kit.mjs index --write` and `node tools/kit.mjs package --write`, raising the package version in `packages/public-kits/package.json`). Merge a pull request that records a release with a merge commit; a squash or a rebase rewrites the pinned commit, and `tools/consistency.py` refuses a `source.commit` that is not an ancestor of HEAD.
- `releases.json` is a format 2 index and `releases/<version>.json` is immutable once published (decision `public-releases-format-2`).

## Gates

`npm ci` at the root installs the gates' tools and, through lefthook's postinstall, this repository's Git hooks (decision `public-local-gates`). `LEFTHOOK=0` skips them for one command; CI still runs the same checks.

```
python tools/validate.py
python tools/selection.py            # review the diff, then: python tools/selection.py --write
node tools/bundle-kits.mjs --check
node tools/kit.mjs index --check
node tools/kit.mjs package --check   # packages/public-kits/package.json is the bundled kits' claim (docs/public-kits-package.md)
python tools/consistency.py          # --base <ref> adds version bumps or release notes and the published-release guard
node tools/release.mjs check         # every pending release note and changeset is well formed
npm run lint
node tools/check-language.mjs        # every bundled kit and .ia/src restored and validated by the pinned CLI
python -m unittest discover -s tests -v
node --test "tests/*.test.mjs" "plugins/*/tests/*.test.mjs"
claude plugin validate --strict plugins/ia && claude plugin validate --strict .
node tools/smoke-codex.mjs --codex <codex executable> --report <file>   # after a manifest, skill or CODEX.md change
```

CI (`.github/workflows/gates.yml`) runs the first eleven on Ubuntu for every pull request into `main`, and on Ubuntu, Windows and macOS for every push to `main` (`public-ci-matrix`), plus the native qualification shards (`tools/run-native-tests.mjs`, with `IA_CORE_TEST_CLI` set). The two host gates stay local.

Validation and tests never create remotes, push, publish, install, invite or change access. Those are separate, operator-authorized steps. Publishing `@inventarch/public-kits` is one: only an operator dispatches `.github/workflows/publish-public-kits.yml` (decision `public-kits-package`). Starting the release pull request is another: only an operator dispatches `.github/workflows/release-pr.yml`, and only an operator merges what it opens.
