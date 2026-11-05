# The public kits package

`@inventarch/public-kits` carries the three kits the `ia` plugin bundles (`ia-method`, `ia-kb`, `ia-authoring`) to a bare IA door or workspace as one npm package (decision `public-kits-package`; contracts C7 and C7b). npm is transport only: a repository records the package as one entry in its `.ia/distributions.lock.json`, and the IA engine expands each kit from its IA archive into `.ia/distributions/store/`, as an ordinary installed release.

## What it holds

`packages/public-kits/package.json` is committed. Its `version` is the package's own semver, set by hand. Every other byte is generated, and `ia.kits` is the claim a lock entry repeats:

```json
{ "id": "inventarch/ia-kb-kit", "version": "0.9.0", "archive": "<sha256 of the IA archive>",
  "manifest": "<sha256 of the archive's distribution.json>", "sources": "<sourcesDigest of the kit folder>", "folder": "ia-kb" }
```

Each row is the kit's latest release row in `plugins/ia/config/kits/<folder>/releases.json`. The package has no scripts, dependencies, entry points or `exports`.

The built files sit beside it:

| Path | From |
|---|---|
| `archives/<archive>.ia.tgz` | The kit's recorded release, packed again with the pinned `@inventarch/cli` 3.5.0 (`packRelease`). The build refuses bytes whose sha256 is not the recorded `archive`. |
| `archives/<archive>.distribution.json` | That archive's manifest. Its sha256 is the recorded `manifest`. |
| `kits/<folder>/` | `plugins/ia/config/kits/<folder>/`, byte for byte. |
| `index.json` | `kits/index.json`. |
| `LICENSE`, `NOTICE` | The repository's. |

The kit folders stay beside the archives for folder consumers and release history. Runtime sidecars (`delivery.json`, `bindings.json`, `checks.json`, `onwrite.json`, `handlers.json`) present in a kit must be declared release assets. The package gate refuses an omitted sidecar: an engine that expands only the IA archive needs those files to discover bindings, deliver whole procedures and locate checks without a plugin. The runtime reconstructs installed-kit identity and asset declarations from the pinned archive manifest; the producer's `.ia/release.json` is not an archive payload file.

The built files are gitignored, not committed. The plugin and `kits/` already hold these bytes twice, and `bundle --check` proves they agree. The committed `package.json` binds the build to them by digest, and the build is deterministic: the same commit always gives the same archives, which the build checks against the recorded digests. Neither the export selection nor the consistency rules read the built files, so they gain nothing from committed bytes, while the history would gain a binary copy of every kit release.

## Commands

```sh
node tools/kit.mjs package --check            # a gate: package.json is the claim; built files, if present, match
node tools/kit.mjs package --write            # rewrite package.json's ia.kits, then build (needs the pinned CLI)
node tools/kit.mjs package --build            # build only; refuses a stale package.json
node tools/kit.mjs package --check --built    # the same check, requiring the built files
```

`--check` runs in lefthook, in `npm run check` and in the gates workflow. When a kit release changes (the stamp commit in [kits/README.md](../kits/README.md)), run `package --write` and raise the package version. `python tools/consistency.py --base <ref>` refuses a changed `ia.kits` whose version did not rise.

## Publishing (the operator's step)

`.github/workflows/publish-public-kits.yml` publishes the package. It has no trigger except `workflow_dispatch`, so only an operator starts it: from the Actions tab, or with `gh workflow run publish-public-kits.yml -R inventarch/marketplace --ref main`. Its job runs in the `npm` environment, which GitHub deploys only from `main` and only once its required reviewer, the operator, approves the run; that approval is the publication checkpoint, and no agent gives it. In order, it:

1. refuses any ref but `main`;
2. installs the root dependencies with `--ignore-scripts` on Node 22.22.2;
3. checks the bundle, the kit index and `package --check`, then installs npm 12.2.0, the npm that made the trusted publisher. setup-node writes no `.npmrc`, so npm has only its OIDC token to publish with;
4. refuses a version npm already has (`npm view @inventarch/public-kits@<version>`);
5. builds with the pinned CLI and runs `package --check --built`;
6. prints `npm pack --dry-run --json`, whose `integrity` is the value a lock entry records;
7. runs `npm publish --provenance --access public` under OIDC trusted publishing, with no token stored or passed.

npm trusts the workflow only through its trusted publisher: GitHub Actions, organisation `inventarch`, repository `marketplace`, workflow `publish-public-kits.yml`, environment `npm`. The environment is what binds publication to `main`. npm checks the workflow's file name, not its branch, so without it a copy of the workflow edited on another branch and dispatched there could publish; the step that refuses another ref is inside the file it would edit.

npm adds a trusted publisher only to a name that exists, and `@inventarch/public-kits` did not exist before its first release. The operator created it the way inventarch/ia creates its new names, with no real version published by hand:

1. With npm 12.2.0 and an owner login, stage a placeholder: a folder holding only a `package.json` (`@inventarch/public-kits`, version `0.0.0-bootstrap.0`, no scripts or dependencies) and a README, then `npm stage publish <folder> --access public --tag bootstrap --ignore-scripts`. The stage is never approved; the registry then lists the name with its `0.0.0-stage` placeholder.
2. `npm trust github @inventarch/public-kits --file publish-public-kits.yml --repo inventarch/marketplace --environment npm --allow-publish`, answered at its 2FA prompt.
3. Dispatch the workflow within two days. A trusted publisher that sees no publish in its first two days expires, and must be deleted and made again.

Every version, the first included, is published by the workflow, so each one carries a provenance attestation.

After a publish, record the integrity the workflow printed, which `npm view @inventarch/public-kits@<version> dist.integrity` also returns. That is the npm integrity a repository's lock entry carries. A local `npm pack` can give a different integrity if its npm version compresses differently, so the published value is the one that counts.
