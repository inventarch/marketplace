// The session-start account offer and governance probe (decisions
// public-account-pointer, which supersedes public-account-offer, and
// public-governance-probe). Both read local files and
// the environment only: no network, no token, nothing written.
//
// The account offer runs at session startup only (a resume or a clear never
// repeats it), so it appears once per session. It is suppressed by
// "accountOffer": false in <IA home>/config.json, by IA_NO_ACCOUNT_OFFER=1, and
// by a non-empty CI. An account counts as present when a design binding is set
// in the environment (INVENTARCH_DESIGN_BINDING) or the host already lists an
// inventarch MCP server that the user added by hand in its documented local
// configuration (Claude Code's <config dir>/.claude.json, user and per-project
// servers, or the repository's .mcp.json, or Codex's <CODEX_HOME>/config.toml).
// The core ships the connector itself (.mcp.json, decision
// public-account-connector), so it never appears in those files, and a sign-in
// to it is not looked for: the host keeps it with its credentials, which this
// file never opens. After a sign-in the pointer still shows once at startup,
// never blocks, and says to ignore it when already signed in.
//
// The governance probe: a repository with .ia/governance.json is governed;
// when no installed kit declares governance handlers (a tool `pre` handler in
// its handlers.json, lib/handlers.mjs), the session says so once, at startup,
// and never pretends it is ungoverned. No plugin is looked for: governance
// arrives as a kit (decision public-governance-probe).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alteredGates, declaresGovernance, gateRemedy, governanceKits, handlerKits } from './handlers.mjs';
import { iaHome } from './home.mjs';

export const MCP_URL = 'https://api.inventarch.dev/mcp';

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

const claudeJson = (env, home) => (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'));
const codexHome = (env, home) => env.CODEX_HOME || join(home, '.codex');

// An MCP server entry that is InventArch's: named inventarch, or pointing at the InventArch MCP URL.
const isInventarch = (name, server) => name.toLowerCase() === 'inventarch' || (typeof server?.url === 'string' && server.url.replace(/\/+$/, '').toLowerCase() === MCP_URL);
const listsInventarch = servers => Boolean(servers && typeof servers === 'object' && Object.entries(servers).some(([name, server]) => isInventarch(name, server)));
const sameFolder = (a, b) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function offerDisabled(env = process.env) {
  if (env.IA_NO_ACCOUNT_OFFER === '1' || (env.CI ?? '') !== '') return true;
  let home;
  try { home = iaHome(env); } catch { return false; }
  return readJson(join(home, 'config.json'))?.accountOffer === false;
}

// Where an account was found, or null.
export function accountFound({ env = process.env, home = homedir(), cwd = process.cwd(), repo = null } = {}) {
  if (env.INVENTARCH_DESIGN_BINDING) return 'INVENTARCH_DESIGN_BINDING';
  const user = readJson(claudeJson(env, home));
  if (listsInventarch(user?.mcpServers)) return 'claude user mcpServers';
  for (const [folder, project] of Object.entries(user?.projects ?? {})) {
    if ((sameFolder(folder, cwd) || (repo && sameFolder(folder, repo))) && listsInventarch(project?.mcpServers)) return 'claude project mcpServers';
  }
  for (const root of [repo, cwd].filter(Boolean)) if (listsInventarch(readJson(join(root, '.mcp.json'))?.mcpServers)) return '.mcp.json';
  if (/^\s*\[mcp_servers\.(?:"inventarch"|inventarch)\]\s*$/m.test(readText(join(codexHome(env, home), 'config.toml')))) return 'codex config.toml';
  return null;
}

// The one-line offer, or null when it does not apply.
export function accountOffer({ env = process.env, source, home = homedir(), cwd = process.cwd(), repo = null } = {}) {
  if (source !== 'startup' || offerDisabled(env) || accountFound({ env, home, cwd, repo })) return null;
  return 'InventArch: no account is connected. To use the subscription kits, sign in to InventArch: run /mcp and choose inventarch (or claude mcp login inventarch); if you already have, ignore this. To stop this offer, set "accountOffer": false in ~/.ia/config.json or IA_NO_ACCOUNT_OFFER=1.';
}

// Does an installed kit declare governance handlers?
export function governanceInstalled({ kits } = {}) {
  return declaresGovernance(handlerKits({ kits }).kits);
}

// The governance notice for a workspace root, or null. A kit that declares a
// governance handler but may not run it (lib/trust.mjs) is named, with why; an
// altered gate (a trusted publisher's kit, lib/handlers.mjs alteredGates) is
// named with the fix, since every tool call is refused until it is mended.
export function governanceNotice({ source, root, kits } = {}) {
  if (source !== 'startup' || !root || !existsSync(join(root, '.ia', 'governance.json'))) return null;
  const found = handlerKits({ kits }).kits;
  const altered = alteredGates(found);
  if (altered.length) return `InventArch: this repository is governed (.ia/governance.json), and an installed governance gate may not run: ${altered.map(g => `${g.kit.id}, because ${g.reason}`).join('; ')}. Every edit and shell command is refused until it is mended (fail closed). ${altered.map(g => gateRemedy(g.kit)).find(Boolean)}`;
  const declared = governanceKits(found);
  if (declared.some(g => g.trusted)) return null;
  if (declared.length) return `InventArch: this repository is governed (.ia/governance.json), but no installed governance handler may run: ${declared.map(g => `${g.kit.id}, because ${g.reason}`).join('; ')}. Reinstall the kit's recorded release (\`ia kit add\`). Nothing here enforces its rules: say so before changing anything, and do not treat the repository as ungoverned.`;
  return 'InventArch: this repository is governed (.ia/governance.json); add the ia-governance kit (`ia kit add`). No installed kit declares governance handlers, so nothing here enforces its rules: say so before changing anything, and do not treat the repository as ungoverned.';
}
