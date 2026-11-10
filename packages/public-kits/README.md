# `@inventarch/public-kits`

The public InventArch method kits as one npm package: `inventarch/ia-method-kit`, `inventarch/ia-kb-kit` and `inventarch/ia-authoring-kit`, the kits the `ia` plugin carries as its lane defaults. A repository that uses the package records it as one entry in its `.ia/distributions.lock.json`; the IA engine then expands each kit from its archive, so npm only carries the bytes (contract C7b).

## What it holds

| Path | What it is |
|---|---|
| `package.json` `ia.kits` | One row per kit: `id`, `version` (its latest release), `archive` and `manifest` (the sha256 of its IA archive and of that archive's manifest), `sources` (the digest of its folder) and `folder`. A lock entry repeats these. |
| `archives/<archive>.ia.tgz` | Each kit's recorded IA release, packed again from its sources with `@inventarch/cli` 3.6.0; the build refuses any other bytes. |
| `archives/<archive>.distribution.json` | That archive's manifest, its `distribution.json`. Its sha256 is the row's `manifest`. |
| `kits/<folder>/` | Each kit's folder, byte for byte as the plugin bundles it. An archive holds the records and declared assets; the folder also holds the sidecars (`delivery.json`, `bindings.json`, `checks.json`) and the release history. |
| `index.json` | The catalogue's `kits/index.json` at the published commit. |

The package has no scripts, no dependencies and no entry points, so installing it runs nothing.

## Where it comes from

It is generated in [inventarch/marketplace](https://github.com/inventarch/marketplace) under `packages/public-kits/` by `node tools/kit.mjs package`, from the kits the plugin bundles, and published from there with npm provenance. The package version is its own: it rises whenever a carried kit release changes. The repository's `docs/public-kits-package.md` describes the build and the publish step.

Licensed under the Apache License, Version 2.0.
