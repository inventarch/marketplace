# Contributing to the InventArch marketplace

Thank you for considering a contribution. This document explains how the repository is organised, what a change must satisfy before it merges, and the terms that apply to what you contribute.

## Before you start

- For a bug, a question or a proposal, open an issue first using the templates. Small, obvious fixes can go straight to a pull request.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
- Everything here is public, and anyone can read every byte. A method that must stay proprietary does not belong in this repository, and no file may carry a machine path, a credential, a tenant's material or another organisation's material.
- A problem in the `ia` CLI, the language or `@inventarch/mcp-door` belongs in [inventarch/ia](https://github.com/inventarch/ia).

## Prerequisites

Python 3.11 or later and Node.js `>=22.22.0 <23`. Run this once in each checkout:

```sh
npm ci
```

It installs Biome, lefthook and the pinned `@inventarch/cli` 3.8.0, and lefthook installs this repository's Git hooks, which run the gates before each commit and push. `LEFTHOOK=0` skips them for one command; CI still runs them. Never use an `ia` on your `PATH` for this repository: the gates use the pinned one.

To run the `ia` plugin's lanes in this repository, also install its three kits once per checkout (and again after a kit release):

```sh
npm run kits:install
```

It runs `plugins/ia/scripts/kit.mjs add` for `ia-method`, `ia-kb` and `ia-authoring`, which needs the CLI `npm ci` installed. It writes `.ia/distributions.lock.json`, `.ia/distributions/` and `vendor/ia/`, all ignored by Git. The IA door runs a kit this repository binds only when that lock installs it (decision `public-cli-3-6-0-own-lock`). It is not the maintainers' `npm run kit` (`tools/kit.mjs`).

## How the repository is organised

- [AGENTS.md](AGENTS.md) holds the working rules: what may ship, the plugin rules, the kit rules and the gates. Read it before changing anything.
- Every decision has a `@decision` record in [.ia/src/decisions.ia](.ia/src/decisions.ia) and a row in [docs/decisions.md](docs/decisions.md); follow-up work is a `@task` in [.ia/src/work.ia](.ia/src/work.ia), listed in [docs/roadmap.md](docs/roadmap.md). Add the record and the row in the same change. `tools/validate.py` refuses a decision without both.
- Every Markdown document is a record's `source` or sits under a spec's `covers` path in [.ia/src/workspace.ia](.ia/src/workspace.ia). `tools/validate.py` refuses a document without one.
- `plugins/ia` is the core plugin. What a plugin may contain, and how to add or change one, is in [docs/adding-plugins.md](docs/adding-plugins.md).
- `kits/<kit>` holds each public kit's sources. Edit those, never the copy bundled into `plugins/ia/config/kits`; [kits/README.md](kits/README.md) covers the kit folder and the release steps.
- `export-selection.json` records the hash of every file the catalogue ships. After a change to a shipped file, run `python tools/selection.py`, review its diff, then `python tools/selection.py --write`.

## Gates

CI runs these on Ubuntu for every pull request into `main`, and on Ubuntu, Windows and macOS for every push to `main`:

```sh
python tools/validate.py
python tools/selection.py --check
node tools/bundle-kits.mjs --check
node tools/kit.mjs index --check
node tools/kit.mjs package --check
python tools/consistency.py --base origin/main
node tools/release.mjs check
npm run lint
node tools/check-language.mjs
python -m unittest discover -s tests -v
node --test "tests/*.test.mjs" "plugins/*/tests/*.test.mjs"
```

`npm test` runs the three test suites. A change to a manifest, a skill or a `CODEX.md` also needs the two host gates, which stay local: `claude plugin validate --strict plugins/ia && claude plugin validate --strict .`, and `node tools/smoke-codex.mjs --codex <codex executable> --report <file>`, whose report is committed under `docs/smoke/`.

## Release notes

A pull request never edits a plugin's version, `CHANGELOG.md`, `sources.lock.json` `pluginVersion` or `releases/changesets/` by hand. The release pull request writes them; see [releases/README.md](releases/README.md).

- If your change touches a file the `ia` plugin ships (anything under `plugins/ia/` except its `tests/`), add a release note:

  ```sh
  node tools/release.mjs note --plugin ia --bump patch|minor|major --title "…" --summary "…"
  ```

  It writes `releases/pending/<id>.json`. Write the summary for the people who install the plugin. Use `--bump none` for a shipped change they cannot observe; it satisfies the check but never starts a release.
- `python tools/consistency.py --base origin/main` refuses a shipped change with no new note naming its plugin, and `node tools/release.mjs check` refuses a malformed note.
- Put IA words in backticks. A bare `@word` mentions a GitHub account wherever the notes are published, so `release.mjs` refuses one.
- A kit release is its own two-commit flow (a sources commit, then a stamp commit), described in [kits/README.md](kits/README.md#release-a-kit). It also changes shipped files, so it adds a note too.

## Pull requests

1. Branch from `main` and keep the change focused on one concern.
2. Run the gates that cover what you changed, and `npm test` before requesting review when the change is more than documentation.
3. Fill in the pull request template. Name the checks you ran and the platform you ran them on. A claim that something passes must be backed by a run you did.
4. The `main` ruleset in [.github/rulesets/main.json](.github/rulesets/main.json) requires the **Gates (ubuntu-latest)** and **Native verified (ubuntu-latest)** checks from [Gates](.github/workflows/gates.yml) to pass on a branch that is up to date with `main`, every review thread to be resolved, and a code owner's review ([.github/rulesets/main-review.json](.github/rulesets/main-review.json)).
5. Pull requests merge with a merge commit only. A kit release pins its sources commit, and a squash or a rebase would rewrite it.
6. Match the existing commit style: a short type prefix and summary, for example `fix(ia): refuse a kit folder that holds a link`.

Pull requests from forks run the public workflow without any secret.

## Licence of contributions

This repository is licensed under [Apache-2.0](LICENSE). Under section 5 of that licence, any contribution you intentionally submit for inclusion is licensed under Apache-2.0, without additional terms, unless you explicitly state otherwise. There is currently no separate contributor licence agreement or developer certificate of origin. Section 6 of the licence grants no trademark permission; the InventArch name and marks remain with their owner.

Keep [NOTICE](NOTICE) intact, and add third-party attribution where you introduce third-party material.
