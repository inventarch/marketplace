// The session-start account offer and governance probe (lib/account.mjs,
// decisions public-account-pointer, which supersedes public-account-offer, and public-governance-probe): the offer
// appears once, at startup only, never on resume, and never when an account is
// found or the offer is turned off; the governance notice appears at startup in
// a governed repository where no installed kit declares governance handlers;
// neither blocks, writes or fetches, and the hook always exits 0.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountFound, accountOffer, governanceNotice, MCP_URL, offerDisabled } from '../scripts/lib/account.mjs';
import { declareAssets, envFor, fakeCli, makeKit, makeRepo, recordSources, run, sandbox } from './helpers/fixtures.mjs';

// An environment with its own IA home, Claude config dir and Codex home, so nothing on this machine leaks in.
function isolated(dir, extra = {}) {
  const env = { IA_HOME: join(dir, 'ia-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex'), ...extra };
  for (const folder of [env.IA_HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) mkdirSync(folder, { recursive: true });
  return env;
}
const hook = (cwd, env, source) => run('bootstrap.mjs', [], env, { input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source, cwd }) });
const hookEnv = (dir, extra = {}) => {
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir });
  for (const k of ['CI', 'IA_NO_ACCOUNT_OFFER', 'INVENTARCH_DESIGN_BINDING']) delete env[k];
  return { ...env, ...isolated(dir), ...extra };
};

test('the offer is made at startup only, points at the bundled connector sign-in and says how to stop', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = isolated(dir);
  const offer = accountOffer({ env, source: 'startup', cwd: dir });
  assert.match(offer, /run \/mcp and choose inventarch \(or claude mcp login inventarch\)/);
  assert.doesNotMatch(offer, /claude mcp add/, 'the user adds no server: the core ships the connector');
  assert.doesNotMatch(offer, /\n/, 'one line');
  assert.match(offer, /"accountOffer": false/);
  assert.match(offer, /IA_NO_ACCOUNT_OFFER=1/);
  for (const source of ['resume', 'clear', 'compact', undefined]) assert.equal(accountOffer({ env, source, cwd: dir }), null, `no offer on ${source}`);
});

test('the offer is suppressed by config.json, IA_NO_ACCOUNT_OFFER and CI', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = isolated(dir);
  assert.equal(offerDisabled(env), false);
  assert.equal(offerDisabled({ ...env, IA_NO_ACCOUNT_OFFER: '1' }), true);
  assert.equal(offerDisabled({ ...env, CI: 'true' }), true);
  assert.equal(offerDisabled({ ...env, CI: '' }), false, 'an empty CI does not count');
  writeFileSync(join(env.IA_HOME, 'config.json'), JSON.stringify({ updateCheck: false, accountOffer: false }));
  assert.equal(offerDisabled(env), true);
  assert.equal(accountOffer({ env, source: 'startup', cwd: dir }), null);
  writeFileSync(join(env.IA_HOME, 'config.json'), '{ not json');
  assert.equal(offerDisabled(env), false, 'an unreadable config never suppresses by accident, and never throws');
});

test('an account is found from a design binding or an inventarch MCP server in the documented local configuration', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = isolated(dir), repo = join(dir, 'repo');
  mkdirSync(repo);
  assert.equal(accountFound({ env, cwd: repo, repo }), null);
  assert.equal(accountFound({ env: { ...env, INVENTARCH_DESIGN_BINDING: '/x/binding.json' }, cwd: repo }), 'INVENTARCH_DESIGN_BINDING');
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { other: { url: 'https://example.invalid/mcp' } } }));
  assert.equal(accountFound({ env, cwd: repo, repo }), null, 'another server is not an account');
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: { work: { type: 'http', url: `${MCP_URL}/` } } }));
  assert.equal(accountFound({ env, cwd: repo, repo }), 'claude user mcpServers', 'matched by URL under any name');
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [repo]: { mcpServers: { inventarch: { type: 'http' } } } } }));
  assert.equal(accountFound({ env, cwd: repo, repo }), 'claude project mcpServers');
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), '{}');
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { inventarch: { type: 'http', url: MCP_URL } } }));
  assert.equal(accountFound({ env, cwd: repo, repo }), '.mcp.json');
  writeFileSync(join(repo, '.mcp.json'), '{}');
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), `[mcp_servers.inventarch]\nurl = "${MCP_URL}"\n`);
  assert.equal(accountFound({ env, cwd: repo, repo }), 'codex config.toml');
  assert.equal(accountOffer({ env, source: 'startup', cwd: repo, repo }), null, 'no offer once an account is found');
});

test('the host credentials file is never read: a stored sign-in there is not an account', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = isolated(dir), repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'plugin:ia:inventarch|abc123': { accessToken: 'secret-token' } } }));
  assert.equal(accountFound({ env, cwd: repo, repo }), null);
  assert.match(accountOffer({ env, source: 'startup', cwd: repo, repo }), /if you already have, ignore this/);
});

test('the hook shows the offer once at startup outside a workspace too, never on resume, and writes nothing', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = hookEnv(dir);
  const outside = join(dir, 'temp');
  const before = readdirSync(dir).sort();
  const started = hook(outside, env, 'startup');
  assert.equal(started.status, 0, started.stderr);
  const payload = JSON.parse(started.stdout);
  assert.match(payload.systemMessage, /^InventArch: no account is connected\./);
  assert.match(payload.hookSpecificOutput.additionalContext, /do not repeat it and do not wait for it/);
  assert.equal(started.stdout.trim().split('\n').length, 1);
  const resumed = hook(outside, env, 'resume');
  assert.equal(resumed.status, 0);
  assert.equal(resumed.stdout, '', 'resume repeats nothing outside a workspace');
  const quiet = hook(outside, { ...env, IA_NO_ACCOUNT_OFFER: '1' }, 'startup');
  assert.equal(quiet.stdout, '');
  assert.deepEqual(readdirSync(dir).sort(), before, 'the hook writes no state');
});

test('a governed repository is named once at startup until an installed kit declares governance handlers', t => {
  const dir = sandbox(t, 'ia-core-account-');
  const env = hookEnv(dir, { IA_NO_ACCOUNT_OFFER: '1' });
  const repo = makeRepo(join(dir, 'repo'));
  assert.equal(governanceNotice({ source: 'startup', root: repo, kits: [] }), null, 'not governed: no notice');
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  assert.match(governanceNotice({ source: 'startup', root: repo, kits: [] }), /is governed \(\.ia\/governance\.json\); add the ia-governance kit/);
  assert.equal(governanceNotice({ source: 'resume', root: repo, kits: [] }), null);
  const out = hook(repo, env, 'startup');
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.match(payload.systemMessage, /add the ia-governance kit \(`ia kit add`\)/);
  assert.doesNotMatch(payload.systemMessage, /no account is connected/, 'the offer stays suppressed');
  assert.match(payload.hookSpecificOutput.additionalContext, /^This repository is an InventArch workspace\./);
  assert.match(payload.hookSpecificOutput.additionalContext, /never treat the repository as ungoverned/);
  // An installed kit with a tool pre handler (and its script) declares governance handlers: the notice stops.
  const { dir: kit } = makeKit(join(dir, 'kits'), { folder: 'gov', id: 'inventarch/gov-kit' });
  mkdirSync(join(kit, 'scripts'), { recursive: true });
  writeFileSync(join(kit, 'scripts', 'gate.mjs'), 'process.stdout.write("{}");\n');
  writeFileSync(join(kit, 'handlers.json'), JSON.stringify({ format: 1, tool: [{ run: 'scripts/gate.mjs', phase: 'pre' }] }));
  // Until its bytes, handler script included, are its recorded release it may not run (lib/trust.mjs), and the notice says so.
  assert.match(JSON.parse(hook(repo, env, 'startup').stdout).systemMessage, /an installed governance gate may not run: inventarch\/gov-kit, because its bytes are not its recorded release.*Every edit and shell command is refused until it is mended \(fail closed\)/s);
  declareAssets(kit, ['scripts/gate.mjs']);
  recordSources(kit);
  const installed = JSON.parse(hook(repo, env, 'startup').stdout);
  assert.equal(installed.systemMessage, undefined);
});
