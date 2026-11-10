# 🧰 Kits

[![Gates](https://github.com/inventarch/marketplace/actions/workflows/gates.yml/badge.svg?branch=main)](https://github.com/inventarch/marketplace/actions/workflows/gates.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../LICENSE)

This folder is the source of truth for every kit the core carries: `ia-method` (Work), `ia-kb` (Knowledge) and `ia-authoring` (Delivery). Names follow one pattern (folder `ia-<name>`, id `inventarch/ia-<name>-kit`, systems `ia-<name>` and `ia-<name>-<part>`); see the [README](../README.md#kit-names).

## A kit folder

| File | What it holds |
|---|---|
| `.ia/release.json` | The kit's id, version, licence, language dependency, declared assets and the commit its sources were packed from (`source.commit`). |
| `.ia/src/` | The records. |
| `.ia/distributions.lock.json` | The language base the kit pins. |
| `releases.json` | The release index, format 2: `{ format: 2, kit, latest, releases: [ { version, archive, manifest, sources, language, cli, file, source? } ] }`. |
| `releases/<version>.json` | One release's record names: `{ format: 2, kit, version, archive, records, offers? }`. Immutable once published. |
| `checks.json`, `delivery.json`, `bindings.json`, `onwrite.json`, `handlers.json` | Optional sidecars: the fixed argv of each runnable check, the capabilities delivered whole, the bindings the kit recommends, the on-write checks, and the hook handlers. |

## Where each kit is bundled

`bundle.json` maps each kit to the plugin folder that carries a copy. `node tools/bundle-kits.mjs --write` generates the copies, and `--check` (a gate) fails on any difference, on a kit no entry names, and on a plugin kit folder no entry generates. [`index.json`](index.json) broadcasts each kit's latest release, its index file and the binding keys it offers; `node tools/kit.mjs index --check` holds it equal to the kits.

## Release a kit

Edit `kits/<kit>`, never the copy inside a plugin.

1. Edit the sources and bump `.ia/release.json` `version`. Commit (the sources commit).
2. Set `.ia/release.json` `source.commit` to that commit and `source.epoch` to its commit time.
3. `IA_CLI_PATH=<@inventarch/cli 3.6.0 dist/main.js> node tools/kit.mjs pack <kit>` packs it in a scratch copy and records `releases/<version>.json` and the index row (with `source`).
4. `node tools/kit.mjs bundle --write`, `node tools/kit.mjs index --write`; add a release note for the core (`node tools/release.mjs note --plugin ia ...`, [releases/README.md](../releases/README.md)): the release pull request bumps its version and CHANGELOG. Raise the version in `packages/public-kits/package.json`, then run `node tools/kit.mjs package --write` ([docs/public-kits-package.md](../docs/public-kits-package.md)), then `python tools/selection.py --write` (the package rewrites `plugins/ia/config/public-kits.json`, which the selection hashes). Commit (the stamp commit).

`node tools/kit.mjs convert <kit folder>` converts a format 1 `releases.json` to format 2 losslessly and verifies the round trip; `--expand` prints the format 1 document back.
