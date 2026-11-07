# Releases

[![ia plugin](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Finventarch%2Fmarketplace%2Fmain%2Fplugins%2Fia%2F.claude-plugin%2Fplugin.json&query=%24.version&label=ia%20plugin)](../plugins/ia/CHANGELOG.md) [![Gates](https://github.com/inventarch/marketplace/actions/workflows/gates.yml/badge.svg?branch=main)](https://github.com/inventarch/marketplace/actions/workflows/gates.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../LICENSE)

> This folder holds the reviewed inputs to plugin releases: release notes waiting for the next version, and one changeset for each released version. The release tool writes nearly all of it. A contributor usually adds only a release note.

## What is here

| Path | Holds | Written by |
| --- | --- | --- |
| `pending/<id>.json` | Release notes not yet part of a version: a bump (`patch`, `minor`, `major` or `none`), a title, a summary and the plugins they describe. The folder exists only while notes are pending | `node tools/release.mjs note`, committed with your pull request |
| `changesets/<plugin>-<version>.json` | The notes one release consumed, with the plugin, its previous version and the bump | `node tools/release.mjs version --write` on the release branch; never edited after its merge |

A note looks like this:

```json
{
  "format": "inventarch-marketplace.release-note.v1",
  "bump": "minor",
  "title": "Ship the upkeep agent prototype",
  "summary": "What someone who installs the plugin sees change.",
  "plugins": ["ia"]
}
```

Kit releases are recorded beside each kit (`kits/<kit>/releases.json` and `releases/<version>.json`), and the `@inventarch/public-kits` package version is raised with the kit release that changes it; see [kits/README.md](../kits/README.md#release-a-kit).

## The release flow

1. **Pull request.** A change to a file a plugin ships adds a release note. Changes outside the shipped files, such as tooling, workflows, tests and repository docs, need none.
2. **Release pull request.** An operator runs the [Release pull request](../.github/workflows/release-pr.yml) workflow from `main`. It runs `node tools/release.mjs version --write`, which takes the highest bump among each plugin's pending notes, raises the version in both manifests and in `sources.lock.json`, adds the `CHANGELOG.md` entry, records the changeset and removes the notes it consumed. It then records the export selection and opens a draft pull request from `release/next` (or updates the existing pull request without changing its readiness), and dispatches [Gates](../.github/workflows/gates.yml) on it. Review its changelog text like any other change. Fix wording in the notes on `main` and run the workflow again; it replaces `release/next`.
3. **Tag.** Merging that pull request, with a merge commit, adds the changeset to `main`, which starts the [Release](../.github/workflows/release.yml) workflow for that exact commit. It waits for Gates to pass on `main` there, then tags `<plugin>-v<version>` (for example `ia-v1.2.0`) and creates the GitHub release from the changeset. The tags ruleset keeps a tag from moving or being deleted.

Claude Code and Codex install the catalogue from `main`, so users get a merged release when they next update the plugin. Publishing `@inventarch/public-kits` to npm stays a separate step that only an operator dispatches ([docs/public-kits-package.md](../docs/public-kits-package.md)).

## Rules for an ordinary pull request

- Do not edit a plugin's version, `sources.lock.json` `pluginVersion`, `CHANGELOG.md` or `changesets/` by hand.
- Add a note when you change a shipped file: `node tools/release.mjs note --plugin <name> --bump patch|minor|major|none --title "…" --summary "…"`. Pass `--id` to name the file yourself. A `none` note satisfies the check but never starts a release; when a release happens, it is folded in with the others.
- A note already pending on `main` accounts for the change that added it, not for yours. Add your own, or extend that note's summary in your pull request.
- Put IA words in backticks. Release notes are published where a bare `@word` mentions a GitHub account, so the tool refuses one in a title or summary.

## Checks

| Command | When | What it does |
| --- | --- | --- |
| `node tools/release.mjs check` | CI and the Git hooks, on every pull request and push | Refuses a malformed note or changeset: unknown keys, an unknown plugin, an unknown bump, an empty title or summary, or a bare `@word` |
| `python tools/consistency.py --base origin/main` | CI and the pre-push hook | Refuses a plugin whose shipped bytes changed since the base unless its version rose or a note new or changed since the base names it |
| `node tools/release.mjs version` | Any time as a dry run; `--write` by the release workflow | Prints the next version of each plugin with pending notes, and with `--write` applies it |
| `node tools/release.mjs list` / `show <tag>` | The release workflow | Lists the tag of every changeset, and prints one changeset as release notes |

## What the checks do not establish

The tooling establishes that every shipped change has a note and that the versions agree, not that the notes are accurate. A reviewer judges the prose in the release pull request.
