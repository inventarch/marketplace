# Getting help

## Read first

- The [README](README.md) covers installation in Claude Code and Codex, the bootstrap for a team repository, the account offer and the kit names.
- The [ia plugin guide](plugins/ia/README.md) says what the core does in each situation, which files do what, and its contracts.
- The [kit sources guide](kits/README.md) and each kit's README ([ia-method](kits/ia-method/README.md), [ia-kb](kits/ia-kb/README.md), [ia-authoring](kits/ia-authoring/README.md)) describe what a kit offers and the keys it binds.
- [Host support](docs/hosts.md) says what each host loads, which hooks run where and what has been qualified on a real host.
- `/ia:doctor` reports the plugin, workspace, kit and binding state it observes, with the repair it suggests for each problem. `node "<plugin root>/scripts/kit.mjs" check` reports each kit's trust and whether it runs code.
- A refusal names its code and the command that resolves it (for example `IA-CORE-NO-METHOD` names `kit.mjs bind <kit> --install --apply`). Follow it before retrying.

## Ask

Open an issue using the templates:

- **Bug report** when the plugin, a kit or the catalogue behaves differently from what its README or decisions say. Include the plugin and kit versions, the host and the smallest repository that reproduces it.
- **Feature request** for a change to the plugin, a public kit, host support or the tooling.
- **Documentation** when a document is wrong, missing or unclear.

A question that is not one of those is still welcome as an issue; say what you tried and what you expected.

A problem in the `ia` CLI, the language, its vocabulary or `@inventarch/mcp-door` belongs in [inventarch/ia](https://github.com/inventarch/ia/issues).

## Security

Do not report security problems in an issue. Use the process in [SECURITY.md](SECURITY.md).

## What this repository does not cover

Kits served with an InventArch account and the hosted services behind it belong with their operators.
