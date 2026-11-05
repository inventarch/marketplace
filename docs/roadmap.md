# Roadmap

Open work for the public catalogue. Each item is a `@task` in `.ia/src/work.ia` under the `marketplace-public-launch` plan; the records are authoritative.

| Task | Standing | Record |
|---|---|---|
| Install the core from GitHub in Claude Code and exercise the entry points, the session hook (with a compaction), the account offer and its suppression, the governance probe, the IA door's tools, a kit's handlers and the agents. | open | `qualify-claude-code` |
| Run the Codex host smoke after every manifest, skill or `CODEX.md` change and commit its report. | open | `qualify-codex` |
| Run the native qualification shards on Ubuntu, Windows and macOS against the 3.5.0 pins and the re-cut kits. | open | `native-qualification-refresh` |
| Propose that the IA home spec name the `accountOffer` key beside `updateCheck`. | proposed | `account-offer-key-in-spec` |
| Lower `.ia/bindings.json` to `@execution-binding` records once the CLI admits them for kit capabilities. | proposed | `bindings-as-records` |
| Qualify the `ia-authoring` method closure: a reviewed execution contract for every runner, then carry it beside `ia-kb`. | open | `authoring-method-qualification` |
| Once `@inventarch/mcp-door` ships `ia_session`, `ia_catalogue` and `ia_method`, move the door's pin to that release and drop the lanes' `resolve.mjs` fallback. Done in 1.2.0 (door 3.5.0). | closed | `drop-door-fallback` |
| Carry the kit handler hooks to Codex once qualified there. The IA door half is done in 1.2.0 (decision `public-door-codex`). | proposed | `codex-door-and-handlers` |
| Sign kit releases and check the signature before a kit runs code, so trust stops resting on the namespace claim and covers every module a kit imports. | proposed | `signed-kit-releases` |
| Give Codex the InventArch account connector once its documented plugin MCP config is shown to take a remote HTTP server with the API's pre-registered OAuth client (client id claude-code, callback port 43822) and tools/smoke-codex.mjs can sign in and list kit_offerings. Until then the Codex manifest names only the door (.codex-mcp.json) and Codex users add the server with codex mcp add (decision public-account-connector). | proposed | `codex-account-connector` |
| claude plugin validate warns that plugins/ia/.claude-plugin/plugin.json has no privacyPolicyUrl now that the core bundles a remote connector. This repository has no privacy policy page to point at: publish one (on inventarch.com) and add privacyPolicyUrl to the Claude manifest. | proposed | `plugin-privacy-policy-url` |
| In a real Claude Code session: the plugin's inventarch server appears in /mcp and signs in with client id claude-code on callback port 43822; kit_offerings and kit_download answer under mcp__plugin_ia_inventarch__*; and a downloaded archive is a kit folder tarball that kit.mjs add --from accepts (its releases.json at the root or in its one folder). Record the observed kit_offerings shape in ia:init section 6. | proposed | `qualify-account-connector` |
