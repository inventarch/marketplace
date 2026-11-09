// scripts/door.mjs (decision public-door-mcp): the launcher the plugin's
// .mcp.json runs. It starts npx -y @inventarch/mcp-door at the plugin's IA pin
// without a shell: npm's npx-cli.js under this node wherever it is found (the
// only way on Windows, where npx is a .cmd shim), npx on PATH elsewhere; stdio
// passes through, IA_KITS_DIR is set and the environment kept; it exits with
// the door's exit code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOOR_PACKAGE, doorCommand } from '../scripts/door.mjs';
import { PINNED } from '../scripts/lib/cli.mjs';
import { sandbox, SCRIPTS } from './helpers/fixtures.mjs';

const MCP = JSON.parse(readFileSync(fileURLToPath(new URL('../.mcp.json', import.meta.url)), 'utf8'));
const PINNED_DOOR = `@inventarch/mcp-door@${PINNED}`;

test('the .mcp.json runs the launcher with node, and the launcher pins the door to the plugin IA version', () => {
  assert.deepEqual(MCP.mcpServers.ia, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/door.mjs'], env: { IA_KITS_DIR: '${CLAUDE_PLUGIN_ROOT}/config/kits' } });
  assert.equal(DOOR_PACKAGE, '@inventarch/mcp-door');
  assert.equal(PINNED, '3.6.0');
});

test('win32 runs npx-cli.js under node, never a shell, and refuses without it; posix falls back to npx on PATH', () => {
  const env = { PATH: '/bin', OTHER: 'kept' };
  const win = doorCommand({ platform: 'win32', env, plugin: 'C:/plugin', execPath: 'C:/node/node.exe', npxScript: 'C:/node/node_modules/npm/bin/npx-cli.js' });
  assert.equal(win.command, 'C:/node/node.exe');
  assert.deepEqual(win.args, ['C:/node/node_modules/npm/bin/npx-cli.js', '-y', PINNED_DOOR]);
  assert.equal(win.options.shell, undefined, 'no shell');
  assert.equal(win.options.stdio, 'inherit');
  assert.deepEqual(win.options.env, { PATH: '/bin', OTHER: 'kept', IA_KITS_DIR: 'C:/plugin/config/kits' });
  const winBare = doorCommand({ platform: 'win32', env, execPath: 'C:/node/node.exe', npxScript: null });
  assert.match(winBare.error, /npx-cli\.js is not next to C:\/node\/node\.exe/);
  for (const platform of ['linux', 'darwin']) {
    const found = doorCommand({ platform, env, plugin: '/plugin', execPath: '/usr/bin/node', npxScript: '/usr/lib/node_modules/npm/bin/npx-cli.js' });
    assert.deepEqual([found.command, ...found.args], ['/usr/bin/node', '/usr/lib/node_modules/npm/bin/npx-cli.js', '-y', PINNED_DOOR], platform);
    const bare = doorCommand({ platform, env, plugin: '/plugin', execPath: '/usr/bin/node', npxScript: null });
    assert.deepEqual([bare.command, ...bare.args], ['npx', '-y', PINNED_DOOR], platform);
    assert.equal(bare.options.shell, undefined, `${platform}: no shell`);
    assert.equal(bare.options.env.IA_KITS_DIR, '/plugin/config/kits');
  }
  // An IA_KITS_DIR the .mcp.json set is kept; IA_CORE_NPX_CLI names the script; a pin can be injected.
  assert.equal(doorCommand({ platform: 'linux', env: { IA_KITS_DIR: '/given' }, npxScript: null }).options.env.IA_KITS_DIR, '/given');
  assert.equal(doorCommand({ platform: 'win32', env: { IA_CORE_NPX_CLI: 'C:/x/npx-cli.js' } }).args[0], 'C:/x/npx-cli.js');
  assert.deepEqual(doorCommand({ platform: 'linux', version: '9.9.9', npxScript: null }).args, ['-y', '@inventarch/mcp-door@9.9.9']);
});

test('run for real against a stand-in npx-cli.js, stdio passes through and the exit code is the door one', t => {
  const dir = sandbox(t, 'ia-core-door-');
  // The stand-in echoes its arguments, IA_KITS_DIR and stdin, then exits 7.
  const stand = join(dir, 'npx-cli.js');
  writeFileSync(stand, `let input = ''; process.stdin.on('data', d => { input += d; }).on('end', () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(2), kits: process.env.IA_KITS_DIR, input })); process.exit(7); });\n`);
  const env = { ...process.env, IA_CORE_NPX_CLI: stand, IA_KITS_DIR: '/kits' };
  const ran = spawnSync(process.execPath, [join(SCRIPTS, 'door.mjs')], { input: '{"jsonrpc":"2.0"}\n', encoding: 'utf8', env, windowsHide: true });
  assert.equal(ran.status, 7, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { args: ['-y', PINNED_DOOR], kits: '/kits', input: '{"jsonrpc":"2.0"}\n' });
});
