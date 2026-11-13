# 🧩 IA marketplace · the public InventArch plugin catalogue

[![Gates](https://github.com/inventarch/marketplace/actions/workflows/gates.yml/badge.svg?branch=main)](https://github.com/inventarch/marketplace/actions/workflows/gates.yml) [![ia plugin](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Finventarch%2Fmarketplace%2Fmain%2Fplugins%2Fia%2F.claude-plugin%2Fplugin.json&query=%24.version&label=ia%20plugin)](plugins/ia/CHANGELOG.md) [![IA CLI](https://img.shields.io/badge/%40inventarch%2Fcli-3.6.0-blue)](sources.lock.json) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-8a63d2)](docs/hosts.md)

> The **IA marketplace** is the plugin catalogue `inventarch` for Claude Code and Codex. It ships one plugin, **`ia`**, which gives a coding agent three lanes: Work, Knowledge and Delivery. Each lane delivers the method a repository binds as one packet the agent follows, instead of a prompt it improvises.
>
> This is the **public catalogue**: the `ia` plugin and the three public method kits it carries by default. It is licensed under Apache-2.0 and needs no account. More kits are available with an InventArch account, and they install into your IA home, never into this repository.

## Why the ia plugin

- **Three lanes, one door.** `ia:work`, `ia:knowledge` and `ia:delivery` go through the IA door (`ia_session`, `ia_catalogue`, `ia_method`), which reads the method kit the repository binds and returns its playbook as a packet. The agent follows only the packet.
- **Methods are kits, not prompts.** A kit is a versioned, released set of IA records. You bind one to a lane key in `.ia/bindings.json`, and upgrading, repinning or rebinding it is one previewed command.
- **Only trusted kits run code.** A kit runs a handler, an on-write check or a check only when its publisher is on the plugin's fixed list and its files are the release it recorded. Any other kit is data only.
- **Nothing happens behind your back.** Every `kit.mjs` verb previews until you pass `--apply`. The session hook reads no credentials and never fetches. The sign-in pointer appears once and never blocks.

> [!NOTE]
> **ia 1.2** is re-cut on IA 3.5.0: the lanes call only the IA door, the door is on under Codex too, the upkeep agent ships, and the bundled kits are re-released with the 3.5.0 CLI.
>
> **ia 1.1** routes the lanes through the IA door the plugin ships as its MCP server, lets kits declare handlers and depend on other kits, runs code only from trusted kits, and delivers governance as a kit. See the [changelog](plugins/ia/CHANGELOG.md).

---

## ⚡ Quick start

### 1. Install the catalogue and the plugin

Claude Code:

```sh
claude plugin marketplace add inventarch/marketplace
claude plugin install ia@inventarch
```

To pick up a new version, run `claude plugin marketplace update inventarch` and then `claude plugin update ia@inventarch`.

Codex:

```sh
codex plugin marketplace add inventarch/marketplace
codex plugin add ia@inventarch
```

`codex plugin marketplace upgrade` refreshes the Git snapshot. If the plugin's version did not change, Codex keeps its cached copy: run `codex plugin remove` and then `codex plugin add`.

Installing the plugin also gives Claude Code the IA door: the plugin's launcher (`scripts/door.mjs`, run with `node`) starts `npx -y @inventarch/mcp-door@3.6.0`, never through a shell (on Windows it runs npm's `npx-cli.js` with `node`), so the first session in a new environment needs network access to fetch it once.

### 2. Set up a repository

Run `/ia:init` in a repository: it offers `ia init` and binds the default kits. By hand, run `ia init` first when the repository is not an IA workspace yet (through the plugin's `scripts/ia.mjs`, never an `ia` on PATH), then install and bind each kit:

```sh
node "<plugin root>/scripts/kit.mjs" list
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-method-kit --install --apply
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-kb-kit --install --apply
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-authoring-kit --install --apply
```

`bind` refuses a kit the repository's lock does not install, on a preview too; `--install` installs it first. For the three default kits that runs `ia install --package @inventarch/public-kits@<version> --apply --yes` (the version is in the plugin's `config/public-kits.json`), which installs all three at once, so it needs npm and the registry; the first call in a workspace with no lock seeds one and restores it. Any other kit installs the way `kit.mjs add` does.

Every `kit.mjs` verb previews unless you pass `--apply`. `upgrade`, `repin` and `rebind` move a repository to a new kit release; `add --from <folder or archive>` installs a kit into `<IA home>/kits/<kit>/<version>/`. A kit that depends on another kit (its `.ia/release.json` names it) installs only once that kit is found: carried by the plugin, already in `<IA home>/kits`, or next to it in the same folder. Add the dependency first; adoption then vendors both.

### 3. Ask for work in a lane

Ask the agent for a task, a document or a change. It picks the lane (`ia:work`, `ia:knowledge` or `ia:delivery`), resolves the bound method and follows its packet. `/ia:doctor` explains what is unconfigured or refused, with the command that fixes each problem.

### Coexisting with the CLI-rendered plugin

`ia host claude --user` (IA CLI 3.4.x) renders its own `ia@inventarch` plugin into `~/.ia/claude/marketplace` and registers that folder under the same catalogue name, `inventarch`. The CLI will change so that `ia host` adds this public marketplace and installs `ia@inventarch` from it instead of rendering its own plugin. Until that CLI release, remove the CLI-rendered registration first:

```sh
claude plugin marketplace remove inventarch
claude plugin marketplace add inventarch/marketplace
claude plugin install ia@inventarch
```

This plugin carries the rendered plugin's `init` and `doctor` skills (`ia:init`, `ia:doctor`).

---

## 🧰 Kits

The core carries three public kits, one default per lane. Their sources are under [`kits/`](kits/README.md), and [`kits/index.json`](kits/index.json) lists each kit's latest release and the binding keys it offers.

| Kit | Lane | What it gives you |
|---|---|---|
| [`ia-method`](kits/ia-method/README.md) (`inventarch/ia-method-kit`) | Work | The IA operating loop, the ceiling on work that rests on a provisional foundation, and one method capability (a four-cell orient, plan, act, learn playbook) for every public IA record word, plus one over the vocabulary. |
| [`ia-kb`](kits/ia-kb/README.md) (`inventarch/ia-kb-kit`) | Knowledge | Where knowledge goes and where workspaces live, binding a document to its record, maintenance, checks, migration and review. |
| [`ia-authoring`](kits/ia-authoring/README.md) (`inventarch/ia-authoring-kit`) | Delivery | One authoring process in three parts: records of existing IA words, host plugins (lower, project, evaluate, qualify), and plugin catalogues. It replaces the retired `inventarch/host-authoring-kit` and `inventarch/catalogue-authoring-kit`. |

Each lane's entry capability is a whole procedure: a request with no specific activity gets all four phases, and `--phase` selects one.

More kits (meetings, governed work, organisation-wide knowledge custody, workspace and system design, and others) are available with an InventArch account. They are served by the InventArch API and installed into your IA home, never into this repository.

The three kits are also published together as the npm package [`@inventarch/public-kits`](packages/public-kits/README.md), for a door or workspace that has no plugin; [docs/public-kits-package.md](docs/public-kits-package.md) describes it.

### Kit names

Every kit follows one pattern, public or not:

| Part | Name |
|---|---|
| Folder | `ia-<name>` |
| Kit id | `inventarch/ia-<name>-kit` |
| Main system | `ia-<name>` |
| Extra systems | `ia-<name>-<part>` (for example `ia-authoring-host`) |
| Workspace | `ia-<name>-kit` |
| Distribution | `ia-<name>-distribution` |
| Steward | `ia-<name>-steward` |

Whether a kit is public is shown by the repository that holds it, never by its name.

---

## 🤝 Set it up for a team

### Offer the catalogue in a team repository

Commit this to the repository's `.claude/settings.json` to have Claude Code offer the catalogue to everyone who opens it:

```json
{
  "extraKnownMarketplaces": {
    "inventarch": {
      "source": { "source": "github", "repo": "inventarch/marketplace" }
    }
  },
  "enabledPlugins": {
    "ia@inventarch": true
  }
}
```

Claude Code asks each person to trust the folder before it applies these settings. Nothing in this catalogue edits a person's own settings.

### Bootstrap a repository for every host

A repository can carry its own way in, so that a clone works the same for everyone and in every host, with or without this plugin. Commit two small pieces; neither holds a local path or a credential.

1. **The instruction block**, in `CLAUDE.md` and `AGENTS.md` (and `.github/copilot-instructions.md` for Copilot):

   ```markdown
   ## InventArch

   Start with `ia_session`. For any task, use `ia:work`, `ia:knowledge` or `ia:delivery`: call `ia_catalogue` with that lane, choose a key, then `ia_method` with the key, and follow only the packet it returns. If context was lost, call `ia_method` again with the same key and task.
   ```

2. **The door entry**, which starts the IA door with `npx` at the pinned version:

   - Claude Code, `.mcp.json`:

     ```json
     { "mcpServers": { "ia": { "command": "npx", "args": ["-y", "@inventarch/mcp-door@3.6.0"] } } }
     ```

     On native Windows, Claude Code cannot start `npx` (a `.cmd` shim) directly; a repository whose people work there commits the `cmd /c` form instead:

     ```json
     { "mcpServers": { "ia": { "command": "cmd", "args": ["/c", "npx", "-y", "@inventarch/mcp-door@3.6.0"] } } }
     ```

     With this plugin installed you need neither: its own door entry runs `node` on its launcher, which starts npx without a shell on Windows too.

   - Codex, `.codex/config.toml`:

     ```toml
     [mcp_servers.ia]
     command = "npx"
     args = ["-y", "@inventarch/mcp-door@3.6.0"]
     ```

     On Windows, use `command = "cmd"` and `args = ["/c", "npx", "-y", "@inventarch/mcp-door@3.6.0"]`.

   - GitHub Copilot in VS Code, `.vscode/mcp.json`:

     ```json
     { "servers": { "ia": { "type": "stdio", "command": "npx", "args": ["-y", "@inventarch/mcp-door@3.6.0"] } } }
     ```

     For the Copilot coding agent, add the same server under the repository's Copilot MCP configuration on GitHub. Copilot has no plugin and no hooks, so the door and the instruction block are its only way in: the lanes' names in the block are what it calls through the door.

`ia init` and `ia host` (IA CLI) write these pieces for you once the framework release that commits them ships; until then, copy them by hand. With this plugin installed, Claude Code already has the door (the plugin ships it as its MCP server `ia`, whose tools are `mcp__plugin_ia_ia__<tool>`); a committed `.mcp.json` entry then adds a second copy under `mcp__ia__<tool>`, which is harmless, and is still what a teammate without the plugin, or another host, uses. The door finds the kits in `<IA home>/kits`; the plugin's own door also finds the kits it bundles.

The 3.6.0 door serves `ia_session`, `ia_catalogue` and `ia_method`, and this plugin's lanes use only them (a door older than 3.5.0 does not serve them, so a committed entry should pin 3.5.0 or later).

---

## 🧭 How the plugin behaves

### Names

Everything user-facing starts with `ia`: the plugin `ia`; its skills `ia:work`, `ia:knowledge`, `ia:delivery`, `ia:init` and `ia:doctor`; its agents `ia:reader`, `ia:checker` and `ia:worker`; and a capability bound to a lane, shown as `ia-<lane>:<activity>` whichever kit supplies it: the binding key re-spelled, so `work.milestone` reads `ia-work:milestone` and a lane's entry `work.*` reads `ia-work`. A kit extends a lane by binding its capability to that lane's key (a kit binding `work.brainstorm` adds `ia-work:brainstorm`). Kit ids (`inventarch/ia-<kit>-kit`) and the catalogue name (`inventarch`) do not change.

### An InventArch account

The core bundles the InventArch account connector, an MCP server named `inventarch` (`https://api.inventarch.dev/mcp`) with the public Claude Code OAuth client already filled in, so there is nothing to add by hand. Sign in once through `/mcp` (or `claude mcp login inventarch`); the host runs the OAuth sign-in and keeps the token, and the plugin ships no secret and stores no token. Then run `ia:init`: with the connector's tools available it lists the kits your account offers, downloads each one through a short-lived signed URL, checks the archive's SHA-256, installs it into your IA home and binds it as the kit recommends, previewing each write until you agree. At the start of a session the core points at the sign-in, once, in one line, never blocking and with no network call; it reads none of the host's credentials, so after you sign in it still shows once per session: ignore it, or turn it off. To stop the pointer, set `"accountOffer": false` in `~/.ia/config.json` or `IA_NO_ACCOUNT_OFFER=1`; it never appears when `CI` is set.

### Governed repositories

A repository adopted for governance (it has `.ia/governance.json`) needs a kit that declares governance handlers: the `ia-governance` kit, available with an account (`ia kit add`). Until one is installed the core says so once per session ("this repository is governed; add the ia-governance kit") and does not pretend the repository is ungoverned.

### Kit handlers

A kit may declare handlers in a `handlers.json` beside its records: scripts the core runs at session start, on each prompt, before or after an edit or shell command, and when a turn stops, or a plain `context` text it adds at those moments without running anything. Only installed kits whose folder holds the script run them (a kit fetched as a release carries no executables); each kit adds at most 2,000 characters of context; a handler may block a tool call only in a repository that opted in with `.ia/governance.json`. With no kit declaring a handler, the hooks do nothing. A trusted kit that ships no code may name one script of the core, `scripts/method-advise.mjs`, as a handler's `run` (decision `public-method-advisory-run-points`): the ia-method kit does, to report the ceiling and the exit evidence of the tasks in the changed or uncommitted records, as advice that blocks nothing.

### Kit trust

Only trusted kits run code, through `handlers.json`, `onwrite.json` or `checks.json` alike (decision `public-kit-trust`): the kit's publisher, the first part of its id (`inventarch/…`), is on the plugin's list (`plugins/ia/config/trusted-publishers.json`, `inventarch` alone for now), and its files are the release it recorded. Any other kit is data only: its handlers' `context` text still arrives, its scripts and commands are skipped, and the session says so once at its start. In a governed repository, a kit that names a trusted publisher but whose pre-tool gate cannot run, because its files changed after their release or its gate script is not one it declared, refuses every edit and shell command until you reinstall it (`node <ia plugin>/scripts/kit.mjs add --from <release> --apply`) or remove `.ia/governance.json`; another publisher's kit never blocks. You cannot add a publisher to the list yourself; an agent with a shell could then approve itself. Every script the core starts gets a short list of environment variables instead of all of yours, is stopped with everything it started when its time runs out, and has its output capped. That is hygiene, not a sandbox: a trusted kit's code runs as you. [docs/hosts.md](docs/hosts.md#kit-trust-and-process-hygiene) has the details.

### Delegating to another model

`/ia:delegate` hands one resolved step to `codex exec` or `claude -p`, with the IA door and the packet, one level deep and with a timeout. It is off until you set `"delegation": true` in `~/.ia/config.json`, and it runs nothing until you confirm the command it shows.

### Where workspaces live

Your workspaces default to `~/Documents/ia/<domain>` (for example `~/Documents/ia/studio`), and you can point elsewhere. `~/.ia` is the IA home only: configuration, state, the location registry and installed kits; the IA CLI refuses a workspace inside it.

---

## 📦 What is in the repository

| Path | What it holds |
| --- | --- |
| [`plugins/ia/`](plugins/ia/README.md) | The core plugin: the three lanes, `ia:init`, `ia:doctor` and `ia:delegate`, the reader, checker and worker agents, the door launcher, the session and kit handler hooks, the kit verbs, and the bundled kits under `config/kits/`. |
| [`kits/`](kits/README.md) | The public kit sources, their release history, the bundle map into the core and the kit index. |
| [`packages/public-kits/`](packages/public-kits/README.md) | The `@inventarch/public-kits` npm package, generated from the bundled kits. |
| [`releases/`](releases/README.md) | Pending release notes and the changesets of released plugin versions. |
| [`.ia/src/`](.ia/src/workspace.ia) | This repository's own IA workspace: its specs and [decisions](docs/decisions.md). |
| [`docs/`](docs/adding-plugins.md) | How to add or change a plugin, [host support](docs/hosts.md) and the decision index. |
| `tools/`, `tests/`, `schemas/` | The validator, the consistency check, the kit, release and selection tools, and their tests. |
| `.claude-plugin/`, `.agents/plugins/` | The Claude Code and Codex catalogue manifests. |

## 🚀 Releases

A pull request that changes a file the plugin ships adds a release note (`node tools/release.mjs note`). An operator runs the release pull request workflow, which folds the pending notes into the next version and its changelog entry. Merging it tags `ia-v<version>` and creates the GitHub release. [releases/README.md](releases/README.md) describes the flow, and the [changelog](plugins/ia/CHANGELOG.md) lists every version.

## ✅ Contributing and verification

Read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [docs/decisions.md](docs/decisions.md) and [docs/adding-plugins.md](docs/adding-plugins.md) first. Open work is in the [GitHub issues](https://github.com/inventarch/marketplace/issues). You need Python 3.11+ and Node 22.22.x. Run `npm ci` at the root once in each checkout: it installs lefthook, Biome and the pinned `@inventarch/cli` 3.6.0, and lefthook installs this repository's Git hooks. `npm run kits:install` then installs the three kits this repository's own lanes run (see CONTRIBUTING.md). CI runs the same gates on every pull request into `main` (`.github/workflows/gates.yml`):

| Command | What it checks |
| --- | --- |
| `python tools/validate.py` | What ships: plugin layout and components, manifests, skills and agents, hooks and the door, and that every decision and document has its record |
| `python tools/selection.py --check` | `export-selection.json` holds the hash of every shipped file |
| `node tools/bundle-kits.mjs --check` | The plugin's bundled kits are byte for byte the sources under `kits/` |
| `node tools/kit.mjs index --check` / `package --check` | The kit index and the `@inventarch/public-kits` claim match the kits |
| `python tools/consistency.py --base origin/main` | Encoding, links and anchors, IA pins, versions, release notes for shipped changes, and published kit releases left untouched |
| `node tools/release.mjs check` | Pending release notes and changesets are well formed |
| `npm run lint` | Biome lint over the JavaScript |
| `node tools/check-language.mjs` | Every bundled kit and `.ia/src` restored and validated by the pinned CLI |
| `npm test` | The repository, tool and plugin test suites |

`tools/kit.mjs` holds the maintainer verbs (`pack`, `bundle`, `index`, `convert`, `package`); see [the kit README](kits/README.md). [Security reports](SECURITY.md) go to the maintainers privately; [SUPPORT.md](SUPPORT.md) says where to ask a question.

---

## 📄 License

The IA marketplace is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
