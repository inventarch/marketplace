# Roadmap

Open work for the public catalogue. Each item is a `@task` in `.ia/src/work.ia`, under the plan its section names; the records are authoritative. The first table is the `marketplace-public-launch` plan.

| Task | Standing | Record |
|---|---|---|
| Install the core from GitHub in Claude Code and exercise the entry points, the session hook (with a compaction), the account offer and its suppression, the governance probe, the IA door's tools, a kit's handlers and the agents. | open | `qualify-claude-code` |
| Run the Codex host smoke after every manifest, skill or `CODEX.md` change and commit its report. | open | `qualify-codex` |
| Run the native qualification shards on Ubuntu, Windows and macOS against the 3.6.0 pins and the kits re-cut on them. | open | `native-qualification-refresh` |
| Propose that the IA home spec name the `accountOffer` key beside `updateCheck`. | proposed | `account-offer-key-in-spec` |
| Lower `.ia/bindings.json` to `@execution-binding` records once the CLI admits them for kit capabilities. | proposed | `bindings-as-records` |
| Qualify the `ia-authoring` method closure: a reviewed execution contract for every runner, then carry it beside `ia-kb`. | open | `authoring-method-qualification` |
| Once `@inventarch/mcp-door` ships `ia_session`, `ia_catalogue` and `ia_method`, move the door's pin to that release and drop the lanes' `resolve.mjs` fallback. Done in 1.2.0 (door 3.5.0). | closed | `drop-door-fallback` |
| Carry the kit handler hooks to Codex once qualified there. The IA door half is done in 1.2.0 (decision `public-door-codex`). | proposed | `codex-door-and-handlers` |
| Sign kit releases and check the signature before a kit runs code, so trust stops resting on the namespace claim and covers every module a kit imports. | proposed | `signed-kit-releases` |
| Give Codex the InventArch account connector once its documented plugin MCP config is shown to take a remote HTTP server with the API's pre-registered OAuth client (client id claude-code, callback port 43822) and tools/smoke-codex.mjs can sign in and list kit_offerings. Until then the Codex manifest names only the door (.codex-mcp.json) and Codex users add the server with codex mcp add (decision public-account-connector). | proposed | `codex-account-connector` |
| claude plugin validate warns that plugins/ia/.claude-plugin/plugin.json has no privacyPolicyUrl now that the core bundles a remote connector. This repository has no privacy policy page to point at: publish one (on inventarch.com) and add privacyPolicyUrl to the Claude manifest. | proposed | `plugin-privacy-policy-url` |
| In a real Claude Code session: the plugin's inventarch server appears in /mcp and signs in with client id claude-code on callback port 43822; kit_offerings and kit_download answer under mcp__plugin_ia_inventarch__*; and a downloaded archive is a kit folder tarball that kit.mjs add --from accepts (its releases.json at the root or in its one folder). Record the observed kit_offerings shape in ia:init section 6. | proposed | `qualify-account-connector` |
| Guard `bind.mjs set` and `recommend` against a kit the lock does not install; the resolver guard catches it at resolve time. | proposed | `cli-3-6-0-bind-mjs-guard` |

## The IA 3.6.0 migration (plan `cli-3-6-0-migration`)

Release N migrates users onto installed kits on the 3.5.x pins; release N+1 moves to 3.6.0. The decisions are the 3.6.0 migration section of `docs/decisions.md`.

### Release N: the migration on 3.5.x (`cli-3-6-0-release-n`)

| Task | Standing | Record |
|---|---|---|
| Record the 3.6.0 decisions and tasks. | closed | `cli-3-6-0-record-decisions` |
| Migrate users to installed kits (package route). | closed | `cli-3-6-0-install-migration` |
| Install the catalogue's own kits locally. | closed | `cli-3-6-0-own-lock` |
| Change the kits' install guidance. | closed | `cli-3-6-0-kit-guidance` |
| Release notes for release N. | closed | `cli-3-6-0-release-notes-n` |
| Re-cut the kits for release N. | closed | `cli-3-6-0-kit-stamp-n` |
| Host gates for release N. | closed | `cli-3-6-0-host-gates-n` |
| Release N and publish the kits; `@inventarch/public-kits@<the version in plugins/ia/config/public-kits.json>` is on npm (`npm view`) before the release pull request merges. | closed | `cli-3-6-0-release-n` |
| Resolver parity with door 3.6.0. | closed | `cli-3-6-0-resolver-parity` |

### Release N+1: 3.6.0 sources merged (`cli-3-6-0-sources`)

| Task | Standing | Record |
|---|---|---|
| Move the pins and cohort to 3.6.0. | closed | `cli-3-6-0-pins` |
| Guard the chosen CLI against hand-off. | closed | `cli-3-6-0-handoff-guard` |
| Closure default workspace under 3.6.0. | closed | `cli-3-6-0-default-workspace` |
| Change the kits' toolchain to 3.6.0. | closed | `cli-3-6-0-kit-sources` |
| Release notes for 3.6.0. | closed | `cli-3-6-0-release-notes` |

### Release N+1: 3.6.0 released and qualified (`cli-3-6-0-released`)

| Task | Standing | Record |
|---|---|---|
| Re-cut the kits on 3.6.0. | closed | `cli-3-6-0-kit-stamp` |
| Host gates for 3.6.0. | closed | `cli-3-6-0-host-gates` |
| Release N+1 and publish the kits. | closed | `cli-3-6-0-release-and-publish` |
