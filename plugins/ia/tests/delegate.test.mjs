// scripts/delegate.mjs (decision public-delegate): off by default, one level
// deep, the IA door handed to the delegate, the packet inline on stdin, a
// timeout, and nothing run without --run.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { command, DEFAULT_TIMEOUT, doorServer, gate, GEMINI_DENIED_TOOLS, GEMINI_POLICY_PLACEHOLDER, geminiPolicyToml } from '../scripts/delegate.mjs';
import { run, sandbox } from './helpers/fixtures.mjs';

function setup(t, config) {
  const dir = sandbox(t, 'ia-core-delegate-');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'packet.json'), JSON.stringify({ format: 'inventarch.packet', digest: 'f'.repeat(64), instructions: [] }));
  writeFileSync(join(dir, 'brief.txt'), 'Write the milestone record the packet describes.\n');
  const env = { ...process.env, IA_HOME: home };
  for (const k of ['IA_DELEGATION', 'IA_DELEGATION_DEPTH']) delete env[k];
  const args = (to, extra = []) => ['--to', to, '--packet', join(dir, 'packet.json'), '--brief', join(dir, 'brief.txt'), '--root', dir, ...extra];
  return { dir, home, env, args };
}

test('delegation refuses until the person turns it on, and refuses inside a delegate', t => {
  const { env, args } = setup(t);
  const off = run('delegate.mjs', args('codex'), env);
  assert.equal(off.status, 1);
  assert.equal(off.json.error.code, 'IA-CORE-DELEGATION-OFF');
  const on = { ...env, IA_DELEGATION: '1' };
  assert.equal(run('delegate.mjs', args('codex'), on).status, 0);
  const nested = run('delegate.mjs', args('codex'), { ...on, IA_DELEGATION_DEPTH: '1' });
  assert.equal(nested.status, 1);
  assert.equal(nested.json.error.code, 'IA-CORE-DELEGATION-DEPTH');
  assert.throws(() => gate({ IA_DELEGATION: '1', IA_DELEGATION_DEPTH: '2' }), e => e.code === 'IA-CORE-DELEGATION-DEPTH');
});

test('the config file turns it on; the preview names the command, the door, the depth and the timeout, and runs nothing', t => {
  const { env, args } = setup(t, { delegation: true });
  const codex = run('delegate.mjs', args('codex'), env);
  assert.equal(codex.status, 0, codex.stdout + codex.stderr);
  assert.equal(codex.json.ran, false);
  assert.equal(codex.json.timeoutSeconds, DEFAULT_TIMEOUT);
  assert.deepEqual(codex.json.env, { IA_DELEGATION_DEPTH: '1' });
  assert.equal(codex.json.packetDigest, 'f'.repeat(64));
  assert.deepEqual(codex.json.argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(codex.json.argv.includes('mcp_servers.ia.command="node"'));
  assert.ok(codex.json.argv.some(a => /^mcp_servers\.ia\.args=\[".*\/scripts\/door\.mjs"\]$/.test(a)), codex.json.argv.join(' '));
  assert.equal(codex.json.argv.at(-1), '-', 'the prompt goes on stdin');
  const claude = run('delegate.mjs', args('claude', ['--timeout', '60']), env);
  assert.deepEqual(claude.json.argv.slice(0, 3), ['claude', '-p', '--mcp-config']);
  const door = JSON.parse(claude.json.argv[3]).mcpServers.ia;
  assert.equal(door.command, 'node');
  assert.match(door.args[0], /\/scripts\/door\.mjs$/);
  assert.equal(claude.json.timeoutSeconds, 60);
  const gemini = run('delegate.mjs', args('gemini', ['--timeout', '120']), env);
  assert.equal(gemini.status, 0, gemini.stdout + gemini.stderr);
  assert.deepEqual(gemini.json.argv.slice(0, 8), [
    'gemini',
    '--approval-mode', 'plan',
    '--policy', GEMINI_POLICY_PLACEHOLDER,
    '--allowed-mcp-server-names', 'ia',
    '-p',
  ]);
  assert.equal(gemini.json.mcpSettings.mcpServers.ia.command, 'node');
  assert.match(gemini.json.mcpSettings.mcpServers.ia.args[0], /\/scripts\/door\.mjs$/);
  assert.deepEqual(gemini.json.mcpSettings.tools.exclude, GEMINI_DENIED_TOOLS);
  assert.deepEqual(gemini.json.mcpSettings.policyPaths, [GEMINI_POLICY_PLACEHOLDER]);
  assert.equal(gemini.json.policyToml, geminiPolicyToml());
  assert.match(gemini.json.policyToml, /toolName = \["exit_plan_mode", "enter_plan_mode", "write_file", "replace", "run_shell_command"\]/);
  assert.match(gemini.json.policyToml, /decision = "deny"\npriority = 900/);
  assert.match(gemini.json.policyToml, /mcpName = "ia"\ntoolName = "\*"\ndecision = "allow"\npriority = 800/);
  assert.equal(gemini.json.env.IA_DELEGATION_DEPTH, '1');
  assert.equal(gemini.json.timeoutSeconds, 120);
  assert.equal(run('delegate.mjs', args('claude', ['--timeout', '99999']), env).status, 2);
  assert.equal(run('delegate.mjs', args('cursor'), env).status, 2);
});

test('with --run the delegate gets the packet inline on stdin and the depth one higher, inside its timeout', t => {
  const { dir, env, args } = setup(t, { delegation: true });
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, `import { readFileSync } from 'node:fs'; let input = ''; process.stdin.on('data', d => { input += d; }).on('end', () => { const settings = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ? JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')) : null; const pIdx = process.argv.indexOf('--policy'); const policy = pIdx >= 0 && process.argv[pIdx + 1] ? readFileSync(process.argv[pIdx + 1], 'utf8') : null; process.stdout.write(JSON.stringify({ depth: process.env.IA_DELEGATION_DEPTH, packet: input.includes('"digest": "${'f'.repeat(64)}"'), brief: input.startsWith('Write the milestone'), args: process.argv.slice(2), settings, policy })); });\n`);
  // --bin names a Node script, which stands in for the other model's CLI.
  const ran = run('delegate.mjs', args('claude', ['--bin', stub, '--run']), env);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(ran.json.ran, true);
  assert.equal(ran.json.timedOut, false);
  assert.equal(ran.json.status, 0);
  const seen = JSON.parse(ran.json.stdout);
  assert.deepEqual({ depth: seen.depth, packet: seen.packet, brief: seen.brief }, { depth: '1', packet: true, brief: true });
  assert.deepEqual(seen.args.slice(0, 2), ['-p', '--mcp-config']);
  const ranGemini = run('delegate.mjs', args('gemini', ['--bin', stub, '--run']), env);
  assert.equal(ranGemini.status, 0, ranGemini.stdout + ranGemini.stderr);
  const seenGemini = JSON.parse(ranGemini.json.stdout);
  assert.deepEqual({ depth: seenGemini.depth, packet: seenGemini.packet, brief: seenGemini.brief }, { depth: '1', packet: true, brief: true });
  assert.deepEqual(seenGemini.args.slice(0, 3), ['--approval-mode', 'plan', '--policy']);
  assert.notEqual(seenGemini.args[3], GEMINI_POLICY_PLACEHOLDER);
  assert.deepEqual(seenGemini.args.slice(4, 7), ['--allowed-mcp-server-names', 'ia', '-p']);
  assert.equal(seenGemini.settings?.mcpServers?.ia?.command, 'node');
  assert.deepEqual(seenGemini.settings?.policyPaths, [seenGemini.args[3]]);
  assert.deepEqual(seenGemini.settings?.tools?.exclude, GEMINI_DENIED_TOOLS);
  assert.equal(seenGemini.policy, geminiPolicyToml());
  assert.deepEqual(command('codex', { bin: 'x', plugin: '/p' }).slice(-2), ['mcp_servers.ia.env={IA_KITS_DIR="/p/config/kits"}', '-']);
  assert.deepEqual(doorServer('/p'), { command: 'node', args: ['/p/scripts/door.mjs'], env: { IA_KITS_DIR: '/p/config/kits' } });
});
