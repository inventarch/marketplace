// Kit execution trust and process hygiene (decision public-kit-trust): only a
// kit from a trusted publisher whose bytes are its recorded release runs code
// through handlers.json, onwrite.json or checks.json; another kit's handlers
// are data only. Every child gets an allowlisted environment, its process tree
// is killed on its deadline and its output is capped. Hygiene, not a sandbox.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { governanceNotice } from '../scripts/lib/account.mjs';
import { childEnv, killTree, OUTPUT_CAP, runChild } from '../scripts/lib/hygiene.mjs';
import { findKit, sourcesDigest } from '../scripts/lib/kit.mjs';
import { kitTrust, trustedPublishers } from '../scripts/lib/trust.mjs';
import { declareAssets, envFor, fakeCli, makeKit, makeRepo, PLUGIN, recordSources, run, sandbox } from './helpers/fixtures.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// A handler that leaves a marker in its kit folder, so a test can tell it ran, and answers with context.
const MARKER = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.IA_KIT_ROOT, 'ran'), 'yes');
process.stdout.write(JSON.stringify(process.env.IA_TEST_HANDLER_ANSWER ? JSON.parse(process.env.IA_TEST_HANDLER_ANSWER) : { additionalContext: 'code ran' }) + '\\n');
`;

function setup(t) {
  const dir = sandbox(t, 'ia-core-trust-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp'), extra: { IA_HOME: join(dir, 'home') } });
  const hook = (event, input, e = env) => run('handlers.mjs', [event], e, { input: JSON.stringify({ cwd: repo, ...input }) });
  return { dir, kitsDir, repo, env, hook };
}

// A kit with handlers.json and the scripts it names, declared as assets and recorded, unless told otherwise.
function kit(kitsDir, folder, { id = `inventarch/${folder}-kit`, handlers, scripts = { 'scripts/marker.mjs': MARKER }, onwrite, declare = true } = {}) {
  const made = makeKit(kitsDir, { folder, id });
  for (const [rel, text] of Object.entries(scripts)) {
    mkdirSync(join(made.dir, rel, '..'), { recursive: true });
    writeFileSync(join(made.dir, rel), text);
  }
  if (handlers) writeFileSync(join(made.dir, 'handlers.json'), JSON.stringify({ format: 1, ...handlers }, null, 2) + '\n');
  if (onwrite) writeFileSync(join(made.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: onwrite }, null, 2) + '\n');
  if (declare) declareAssets(made.dir, Object.keys(scripts));
  recordSources(made.dir);
  return made;
}

const context = out => out.json?.hookSpecificOutput?.additionalContext ?? '';
const ran = made => existsSync(join(made.dir, 'ran'));

test('the plugin ships one trusted publisher, inventarch, and nothing at run time adds one', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(PLUGIN, 'config', 'trusted-publishers.json'), 'utf8')), { format: 1, publishers: ['inventarch'] });
  assert.deepEqual(trustedPublishers(), ['inventarch']);
  assert.deepEqual(trustedPublishers(join(PLUGIN, 'config', 'no-such-file.json')), [], 'a missing list trusts no one');
});

test('an untrusted publisher\'s handlers run no process; their context is delivered, with one note at session start', t => {
  const { kitsDir, hook } = setup(t);
  const acme = kit(kitsDir, 'acme', { id: 'acme/acme-kit', handlers: { session: [{ run: 'scripts/marker.mjs', context: 'acme says: read the style guide' }], prompt: [{ run: 'scripts/marker.mjs' }, { context: 'acme prompt reminder' }] } });
  const started = hook('session', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(started.status, 0, started.stderr);
  const text = context(started);
  assert.match(text, /acme\/acme-kit: acme says: read the style guide/, 'the data-only context is delivered');
  assert.match(text, /acme\/acme-kit: its handlers did not run, because its publisher acme is not on this plugin's trusted list \(config\/trusted-publishers\.json\)/);
  assert.equal(text.match(/did not run/g).length, 1, 'one note per kit');
  const prompt = hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(context(prompt), 'acme/acme-kit: acme prompt reminder', 'no note outside session start, and no run');
  assert.equal(ran(acme), false, 'no handler process ran');
  assert.equal(kitTrust(findKit('acme/acme-kit', kitsDir)).trusted, false);
});

test('an untrusted pre handler never blocks, even in a governed workspace', t => {
  const { kitsDir, repo, env } = setup(t);
  const acme = kit(kitsDir, 'acme', { id: 'acme/acme-kit', handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre' }] } });
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const blocking = { ...env, IA_TEST_HANDLER_ANSWER: JSON.stringify({ decision: 'block', reason: 'no' }) };
  const pre = run('handlers.mjs', ['pre'], blocking, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }) });
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '', 'not run, so neither a block nor a refusal');
  assert.equal(ran(acme), false);
});

// An altered gate (the operator's ruling, 2026-10-31): in a governed workspace,
// a kit from a trusted publisher whose pre handler the trust check refuses
// refuses every pre-tool call, naming the kit and the fix. Nothing of it runs.
const preCall = (env, repo, tool = 'Write') => run('handlers.mjs', ['pre'], env, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }) });
const denial = out => out.json?.hookSpecificOutput?.permissionDecision === 'deny' ? out.json.hookSpecificOutput.permissionDecisionReason : null;

test('an altered governed pre kit refuses every tool call, naming the kit and the fix', t => {
  const { kitsDir, repo, env, hook } = setup(t);
  const gate = kit(kitsDir, 'gate', { handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre', match: 'Write' }] } });
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  assert.equal(denial(preCall(env, repo)), null, 'its recorded release runs and allows');
  assert.equal(ran(gate), true);
  rmSync(join(gate.dir, 'ran'));
  writeFileSync(join(gate.dir, 'scripts', 'marker.mjs'), MARKER + '// edited after the release\n');
  for (const tool of ['Write', 'Bash', 'Edit']) {
    const reason = denial(preCall(env, repo, tool));
    assert.ok(reason, `${tool} is refused, matched or not`);
    assert.match(reason, /^inventarch\/gate-kit: its pre-tool gate may not run, because its bytes are not its recorded release 0\.1\.0 \(the sources digest differs\), so every tool call in this governed repository is refused \(fail closed\)\. To fix it, /);
    assert.match(reason, /`node "[^"]+[\\/]scripts[\\/]kit\.mjs" add --from <its release folder or archive> --apply`/);
    assert.match(reason, /or remove \.ia\/governance\.json to stop governing this repository\.$/);
  }
  assert.equal(ran(gate), false, 'the altered gate never ran');
  assert.match(governanceNotice({ source: 'startup', root: repo, kits: [findKit('inventarch/gate-kit', kitsDir)] }), /an installed governance gate may not run: inventarch\/gate-kit, because its bytes are not its recorded release.*Every edit and shell command is refused until it is mended \(fail closed\)\. To fix it, .*kit\.mjs" add --from/s);
  assert.match(context(hook('session', { hook_event_name: 'SessionStart', source: 'startup' })), /inventarch\/gate-kit: its handlers did not run, because its bytes are not its recorded release/);
  // A pre script that is not a declared asset is refused the same way.
  const loose = kit(kitsDir, 'loose', { handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre' }] }, declare: false });
  writeFileSync(join(gate.dir, 'scripts', 'marker.mjs'), MARKER);
  assert.equal(kitTrust(findKit('inventarch/gate-kit', kitsDir)).trusted, true, 'the gate is mended');
  assert.match(denial(preCall(env, repo)), /^inventarch\/loose-kit: its pre-tool gate may not run, because its handler script scripts\/marker\.mjs is not a declared asset/);
  assert.equal(ran(loose), false);
  rmSync(join(loose.dir, 'handlers.json'));
  assert.equal(denial(preCall(env, repo)), null, 'mended: the calls pass again');
});

test('an altered pre kit in an ungoverned workspace does not block', t => {
  const { kitsDir, repo, env } = setup(t);
  const gate = kit(kitsDir, 'gate', { handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre' }] } });
  writeFileSync(join(gate.dir, 'scripts', 'marker.mjs'), MARKER + '// edited after the release\n');
  const pre = preCall(env, repo);
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '', 'no block and no refusal without .ia/governance.json');
  assert.equal(ran(gate), false, 'and its code still does not run');
});

test('an altered pre kit from an untrusted publisher never blocks a governed workspace', t => {
  const { kitsDir, repo, env } = setup(t);
  const acme = kit(kitsDir, 'acme', { id: 'acme/acme-kit', handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre' }] } });
  kit(kitsDir, 'acmeloose', { id: 'acme/acmeloose-kit', handlers: { tool: [{ run: 'scripts/marker.mjs', phase: 'pre' }] }, declare: false });
  writeFileSync(join(acme.dir, 'scripts', 'marker.mjs'), MARKER + '// edited after the release\n');
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  assert.equal(kitTrust(findKit('acme/acme-kit', kitsDir)).publisherTrusted, false);
  const pre = preCall(env, repo);
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '', 'neither a block nor a refusal');
  assert.equal(ran(acme), false);
});

test('a trusted kit whose sources were changed after their release runs nothing, and says why', t => {
  const { kitsDir, hook } = setup(t);
  const gate = kit(kitsDir, 'gate', { handlers: { session: [{ run: 'scripts/marker.mjs' }] } });
  assert.equal(kitTrust(findKit('inventarch/gate-kit', kitsDir)).trusted, true);
  writeFileSync(join(gate.dir, 'scripts', 'marker.mjs'), MARKER + '// edited after the release\n');
  const trust = kitTrust(findKit('inventarch/gate-kit', kitsDir));
  assert.deepEqual(trust, { trusted: false, publisher: 'inventarch', publisherTrusted: true, reason: 'its bytes are not its recorded release 0.1.0 (the sources digest differs)' });
  const started = hook('session', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(context(started), /inventarch\/gate-kit: its handlers did not run, because its bytes are not its recorded release 0\.1\.0/);
  assert.equal(ran(gate), false);
});

test('a kit with no recorded sources, a descriptor naming another publisher or a handler script outside its assets runs nothing', t => {
  const { kitsDir, hook } = setup(t);
  makeKit(kitsDir, { folder: 'unrecorded', id: 'inventarch/unrecorded-kit', recorded: false });
  assert.match(kitTrust(findKit('inventarch/unrecorded-kit', kitsDir)).reason, /records no release with a sources digest/);
  const spoof = kit(kitsDir, 'spoof', { handlers: { session: [{ run: 'scripts/marker.mjs' }] } });
  const descriptor = JSON.parse(readFileSync(join(spoof.dir, '.ia', 'release.json'), 'utf8'));
  writeFileSync(join(spoof.dir, '.ia', 'release.json'), JSON.stringify({ ...descriptor, publisher: 'acme' }, null, 2) + '\n');
  recordSources(spoof.dir);
  assert.match(kitTrust(findKit('inventarch/spoof-kit', kitsDir)).reason, /names publisher "acme", not its id's inventarch/);
  const loose = kit(kitsDir, 'loose', { handlers: { session: [{ run: 'scripts/marker.mjs' }] }, declare: false });
  assert.equal(kitTrust(findKit('inventarch/loose-kit', kitsDir)).trusted, true, 'the kit is trusted');
  const text = context(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(text, /inventarch\/loose-kit: its handlers did not run, because its handler script scripts\/marker\.mjs is not a declared asset/);
  assert.match(text, /inventarch\/spoof-kit: its handlers did not run/);
  assert.equal(ran(spoof) || ran(loose), false);
});

test('a trusted kit whose bytes are its recorded release runs its handlers', t => {
  const { kitsDir, hook } = setup(t);
  const good = kit(kitsDir, 'good', { handlers: { session: [{ run: 'scripts/marker.mjs', context: 'data first' }] } });
  const text = context(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(text, 'inventarch/good-kit: data first\ncode ran');
  assert.equal(ran(good), true);
});

test('an untrusted kit\'s onwrite.json commands are skipped, with a note at session start', t => {
  const { kitsDir, repo, env, hook } = setup(t);
  const onwrite = [{ name: 'any-md', extensions: ['.md'], argv: ['${NODE}', '${KIT}/scripts/marker.mjs'] }];
  const acme = kit(kitsDir, 'acme', { id: 'acme/acme-kit', onwrite });
  kit(kitsDir, 'ours', { onwrite: [{ name: 'any-md', extensions: ['.md'], argv: ['${NODE}', '-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'ours checked' } })))"] }] });
  const input = JSON.stringify({ cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'notes.md' } });
  const direct = run('on-write.mjs', [], env, { input });
  assert.equal(direct.json.hookSpecificOutput.additionalContext, 'ours checked');
  const post = run('handlers.mjs', ['post'], env, { input });
  assert.equal(context(post), 'ours checked');
  assert.equal(ran(acme), false, 'the untrusted kit\'s command never ran');
  assert.match(context(hook('session', { hook_event_name: 'SessionStart', source: 'startup' })), /^acme\/acme-kit: its on-write checks did not run, because its publisher acme is not on this plugin's trusted list/);
});

test('an untrusted kit\'s check is refused with IA-CORE-KIT-UNTRUSTED and runs nothing', t => {
  const { kitsDir, repo, env } = setup(t);
  const acme = makeKit(kitsDir, { folder: 'acme', id: 'acme/acme-kit', checks: ['acme-gate'] });
  writeFileSync(join(acme.dir, 'check-ok.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes');\n");
  recordSources(acme.dir);
  const refused = run('check.mjs', ['acme-gate', '--root', repo, '--kit', 'acme/acme-kit'], env);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(refused.json.error.code, 'IA-CORE-KIT-UNTRUSTED');
  assert.match(refused.json.error.message, /acme-gate is declared by acme\/acme-kit, whose code does not run here, because its publisher acme is not on this plugin's trusted list/);
  assert.equal(existsSync(join(repo, 'executed')), false);
  const ours = makeKit(kitsDir, { folder: 'ours', id: 'inventarch/ours-kit', checks: ['ours-gate'] });
  writeFileSync(join(ours.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'ours-gate': { argv: ['${NODE}', '-e', 'process.exit(0)'] } } }));
  const tampered = run('check.mjs', ['ours-gate', '--root', repo, '--kit', 'inventarch/ours-kit'], env);
  assert.equal(tampered.json.error.code, 'IA-CORE-KIT-UNTRUSTED', 'a changed checks.json is not the recorded release');
  recordSources(ours.dir);
  assert.equal(run('check.mjs', ['ours-gate', '--root', repo, '--kit', 'inventarch/ours-kit'], env).status, 0);
});

test('childEnv keeps the allowlist, drops everything else and every credential-like name, and folds case on Windows', () => {
  const env = { PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', IA_HOME: '/ia', IA_GOVERNANCE_STATE_DIR: '/s', IA_API_TOKEN: 'secret', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', CLAUDE_PID: '42', AWS_SECRET_ACCESS_KEY: 'secret', GITHUB_TOKEN: 'secret', INVENTARCH_ACCESS_TOKEN: 'secret', NODE_OPTIONS: '--require evil.js', NODE_PATH: '/evil', CLAUDE_CODE_OAUTH_TOKEN: 'secret', SOMETHING: 'x' };
  assert.deepEqual(Object.keys(childEnv(env, {}, { platform: 'linux' })).sort(), ['CLAUDE_PID', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'HOME', 'IA_GOVERNANCE_STATE_DIR', 'IA_HOME', 'IA_NO_HANDOFF', 'LANG', 'LC_ALL', 'PATH']);
  assert.equal(childEnv({ path: '/bin' }, {}, { platform: 'linux' }).path, undefined, 'POSIX names are exact');
  const windows = childEnv({ Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', ComSpec: 'cmd', ia_home: 'x', UserProfile: 'C:\\u', Secret: 'x' }, { IA_HOME: 'C:\\ia' }, { platform: 'win32' });
  assert.deepEqual(windows, { Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', ComSpec: 'cmd', UserProfile: 'C:\\u', IA_NO_HANDOFF: '1', IA_HOME: 'C:\\ia' }, 'an override replaces any spelling of its name');
});

// public-cli-3-6-0-handoff: an ia a child starts runs the CLI it was given, never the repository's installed one.
test('childEnv sets IA_NO_HANDOFF=1 by default, over the parent environment, and an explicit override still wins', () => {
  for (const platform of ['linux', 'win32']) {
    assert.equal(childEnv({ PATH: '/bin' }, {}, { platform }).IA_NO_HANDOFF, '1', platform);
    assert.equal(childEnv({ PATH: '/bin', IA_NO_HANDOFF: '0' }, {}, { platform }).IA_NO_HANDOFF, '1', `${platform}: the parent's value does not pass`);
    assert.equal(childEnv({ PATH: '/bin' }, { IA_NO_HANDOFF: '0' }, { platform }).IA_NO_HANDOFF, '0', `${platform}: an override wins`);
    assert.equal(Object.hasOwn(childEnv({ PATH: '/bin', IA_NO_HANDOFF: '1' }, { IA_NO_HANDOFF: null }, { platform }), 'IA_NO_HANDOFF'), false, `${platform}: a null override removes it`);
  }
  assert.deepEqual(childEnv({ ia_no_handoff: '0' }, {}, { platform: 'win32' }), { IA_NO_HANDOFF: '1' }, 'the default replaces any spelling of its name on Windows');
});

test('a handler, an on-write command and a check each see only the allowlisted environment', t => {
  const { kitsDir, repo, env, hook } = setup(t);
  const dump = `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
writeFileSync(join(process.env.IA_KIT_ROOT ?? process.cwd(), 'env-' + (process.argv[2] ?? 'handler') + '.json'), JSON.stringify(Object.keys(process.env)));
process.stdout.write('{}\\n');`;
  const k = kit(kitsDir, 'envkit', { handlers: { session: [{ run: 'scripts/dump.mjs' }] }, scripts: { 'scripts/dump.mjs': dump }, onwrite: [{ name: 'md', extensions: ['.md'], argv: ['${NODE}', '${KIT}/scripts/dump.mjs', 'onwrite'] }] });
  writeFileSync(join(k.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'fake-gate': { argv: ['${NODE}', '${KIT}/scripts/dump.mjs', 'check'], cwd: 'kit' } } }));
  recordSources(k.dir);
  // NODE_OPTIONS here is harmless to the runner itself; it must not reach the children.
  const secret = { ...env, IA_TEST_SECRET_SENTINEL_TOKEN: 'leak', MY_SERVICE_PASSWORD: 'leak', UNRELATED_SETTING: 'leak', NODE_OPTIONS: '--no-deprecation', IA_VISIBLE: 'yes' };
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }, secret).status, 0);
  assert.equal(run('on-write.mjs', [], secret, { input: JSON.stringify({ cwd: repo, tool_input: { file_path: 'a.md' } }) }).status, 0);
  const checked = run('check.mjs', ['fake-gate', '--root', repo, '--kit', 'inventarch/envkit-kit'], secret);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  for (const name of ['handler', 'onwrite', 'check']) {
    // An on-write command runs in the hook's working folder, the others with IA_KIT_ROOT or in the kit.
    const seen = JSON.parse(readFileSync(join(name === 'onwrite' ? repo : k.dir, `env-${name}.json`), 'utf8'));
    for (const leaked of ['IA_TEST_SECRET_SENTINEL_TOKEN', 'MY_SERVICE_PASSWORD', 'UNRELATED_SETTING', 'NODE_OPTIONS']) assert.ok(!seen.includes(leaked), `${name} saw ${leaked}`);
    assert.ok(seen.some(n => n.toUpperCase() === 'PATH'), `${name} keeps PATH`);
    assert.ok(seen.includes('IA_VISIBLE'), `${name} keeps IA_*`);
    assert.ok(seen.includes('IA_NO_HANDOFF'), `${name} gets IA_NO_HANDOFF`);
  }
  assert.ok(JSON.parse(readFileSync(join(k.dir, 'env-handler.json'), 'utf8')).includes('IA_KIT_ROOT'));
  assert.ok(JSON.parse(readFileSync(join(k.dir, 'env-check.json'), 'utf8')).includes('IA_CORE_CHECK'));
});

// A handler that starts a grandchild which would sleep for a minute, records
// the grandchild's pid, and then never answers.
const SPAWNER = `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
writeFileSync(join(process.env.IA_KIT_ROOT ?? process.cwd(), 'grandchild.pid'), String(child.pid));
setInterval(() => {}, 1000);`;

test('a handler that times out takes its sleeping grandchild with it', async t => {
  const { kitsDir, hook } = setup(t);
  const k = kit(kitsDir, 'slow', { handlers: { prompt: [{ run: 'scripts/spawner.mjs', timeout: 2 }] }, scripts: { 'scripts/spawner.mjs': SPAWNER } });
  const started = Date.now();
  const out = hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(out.status, 0);
  assert.ok(Date.now() - started < 15000, 'the hook returned after the handler deadline');
  const pid = Number(readFileSync(join(k.dir, 'grandchild.pid'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  t.diagnostic(`platform ${process.platform}, grandchild ${pid}`);
  assert.equal(alive(pid), false, 'the grandchild did not outlive its handler');
});

test('runChild kills the process tree on its deadline and caps each stream', async t => {
  const dir = sandbox(t, 'ia-core-hygiene-');
  const script = join(dir, 'spawner.mjs');
  writeFileSync(script, SPAWNER.replace("process.env.IA_KIT_ROOT ?? process.cwd()", JSON.stringify(dir)));
  const slow = await runChild({ argv: [process.execPath, script], cwd: dir, timeoutMs: 1500, env: childEnv(process.env) });
  assert.equal(slow.timedOut, true);
  const pid = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, 'the grandchild is gone');
  const loud = await runChild({ argv: [process.execPath, '-e', `process.stdout.write('o'.repeat(${OUTPUT_CAP * 4})); process.stderr.write('e'.repeat(${OUTPUT_CAP + 10}));`], cwd: dir, timeoutMs: 20000, env: childEnv(process.env) });
  assert.equal(loud.status, 0);
  assert.equal(OUTPUT_CAP, 256 * 1024);
  assert.equal(loud.stdout.length, OUTPUT_CAP);
  assert.equal(loud.stderr.length, OUTPUT_CAP);
  assert.deepEqual(loud.truncated, { stdout: true, stderr: true });
  const quiet = await runChild({ argv: [process.execPath, '-e', "process.stdin.pipe(process.stdout)"], cwd: dir, input: 'echo', timeoutMs: 20000, env: childEnv(process.env) });
  assert.deepEqual([quiet.status, quiet.stdout, quiet.truncated], [0, 'echo', { stdout: false, stderr: false }]);
  const missing = await runChild({ argv: [join(dir, 'no-such-program')], cwd: dir, timeoutMs: 1000, env: childEnv(process.env) });
  assert.ok(missing.error, 'a program that cannot start resolves with its error');
});

test('killTree signals the POSIX process group, and runs taskkill /T /F on Windows', () => {
  const signals = [];
  assert.equal(killTree(4242, { platform: 'linux', kill: (pid, signal) => signals.push([pid, signal]) }), true);
  assert.deepEqual(signals, [[-4242, 'SIGKILL']]);
  const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
  assert.equal(killTree(4242, { platform: 'darwin', kill: () => { throw gone; } }), false);
  const calls = [];
  assert.equal(killTree(4242, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: (file, args) => { calls.push([file, args]); return { status: 0 }; } }), true);
  assert.deepEqual(calls, [['C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4242']]]);
  assert.equal(killTree(0, { platform: 'linux', kill: () => { throw new Error('never'); } }), false);
});

test('a handler\'s output is capped; a governed gate whose answer was cut, or that never answered, refuses the call', t => {
  const { kitsDir, repo, env, hook } = setup(t);
  const flood = `process.stdout.write('x'.repeat(${OUTPUT_CAP * 2}) + '\\n' + JSON.stringify({ additionalContext: 'too late' }) + '\\n');`;
  kit(kitsDir, 'loud', { handlers: { tool: [{ run: 'scripts/flood.mjs', phase: 'pre' }], prompt: [{ run: 'scripts/flood.mjs' }] }, scripts: { 'scripts/flood.mjs': flood } });
  const prompt = hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.equal(prompt.stdout, '', 'the answer past the cap is not read');
  const pre = () => run('handlers.mjs', ['pre'], env, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }) });
  assert.equal(pre().stdout, '', 'ungoverned: nothing to refuse');
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  assert.match(pre().json.hookSpecificOutput.permissionDecisionReason, /^inventarch\/loud-kit: its pre-tool handler failed, so the call is refused \(fail closed\): its answer was cut at the output cap$/);
  const silent = makeKit(kitsDir, { folder: 'slowgate', id: 'inventarch/slowgate-kit' });
  writeFileSync(join(silent.dir, 'gate.mjs'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(silent.dir, 'handlers.json'), JSON.stringify({ format: 1, tool: [{ run: 'gate.mjs', phase: 'pre', timeout: 1 }] }));
  declareAssets(silent.dir, ['gate.mjs']);
  recordSources(silent.dir);
  writeFileSync(join(kitsDir, 'loud', 'handlers.json'), JSON.stringify({ format: 1, prompt: [{ run: 'scripts/flood.mjs' }] }));
  recordSources(join(kitsDir, 'loud'));
  assert.match(pre().json.hookSpecificOutput.permissionDecisionReason, /^inventarch\/slowgate-kit: its pre-tool handler failed, so the call is refused \(fail closed\): it did not answer within 1 s$/);
});

// End to end with the real ia-governance kit, when IA_CORE_TEST_GOVERNANCE_KIT
// names its source folder (read only): add it to a temporary IA home with
// kit.mjs add --from, then show its pre-tool gate blocks and allows as it
// should under the allowlisted environment and the async runner.
const GOVERNANCE = process.env.IA_CORE_TEST_GOVERNANCE_KIT;
test('the ia-governance kit installed with add --from still gates a governed repository', { skip: !GOVERNANCE && 'set IA_CORE_TEST_GOVERNANCE_KIT to an ia-governance kit folder', timeout: 180_000 }, t => {
  const dir = sandbox(t, 'ia-core-governance-');
  const home = join(dir, 'home');
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'no-bundled-kits'), temp: join(dir, 'temp'), extra: { IA_HOME: home, IA_GOVERNANCE_STATE_DIR: join(dir, 'state'), IA_TEST_SECRET_SENTINEL_TOKEN: 'leak' } });
  mkdirSync(join(dir, 'no-bundled-kits'));
  // The source stays read only: a copy is installed. A release that does not yet
  // declare its handler scripts as assets (kit.mjs check refuses it) gets them
  // declared in the copy and its sources re-recorded there, engine bytes unchanged.
  const copy = join(dir, 'ia-governance');
  cpSync(GOVERNANCE, copy, { recursive: true, filter: p => !/[\\/](?:node_modules|\.git)$/.test(p) });
  const strict = run('kit.mjs', ['add', '--from', copy], env);
  if (strict.status !== 0) {
    assert.match(strict.json.error.message, /handlers\.json runs scripts that are not declared assets/, strict.stdout);
    const handlers = JSON.parse(readFileSync(join(copy, 'handlers.json'), 'utf8'));
    declareAssets(copy, [...new Set(['session', 'prompt', 'tool', 'stop'].flatMap(k => (handlers[k] ?? []).map(h => h.run)))]);
    recordSources(copy);
    t.diagnostic(`the source release does not declare its handler scripts; the copy records sources ${sourcesDigest(copy)}`);
  }
  const added = run('kit.mjs', ['add', '--from', copy, '--apply'], env);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.equal(added.json.installed, true);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.ia', 'src'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n\n@workspace repo\n  meaning\n    says "A repository."\n');
  writeFileSync(join(repo, '.ia', 'governance.json'), JSON.stringify({ format: 'ia-governance/1' }) + '\n');
  writeFileSync(join(repo, 'README.md'), 'readme\n');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'test'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-q', '-m', 'init']]) assert.equal(git(...args).status, 0, args.join(' '));
  const hook = (event, input) => run('handlers.mjs', [event], env, { input: JSON.stringify({ session_id: 'trust-e2e', cwd: repo, transcript_path: '', ...input }) });
  const decision = out => out.json?.hookSpecificOutput?.permissionDecision ?? null;
  const reason = out => out.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const started = hook('session', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(context(started), /did not run/, 'the installed release is trusted');
  const write = hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(repo, 'src', 'a.js'), content: 'x' } });
  assert.equal(decision(write), 'deny', write.stdout + write.stderr);
  assert.match(reason(write), /^inventarch\/ia-governance-kit: .*REQ-OPAL-03/s);
  const forged = hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'echo {} >> .ia/ledger/demo/ledger.jsonl' } });
  assert.equal(decision(forged), 'deny');
  assert.match(reason(forged), /REQ-OPAL-08/);
  const read = hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'cat README.md' } });
  assert.equal(read.status, 0);
  assert.equal(decision(read), null, 'a read is allowed');
  const post = hook('post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'cat README.md' }, tool_response: { stdout: 'readme', stderr: '', interrupted: false } });
  assert.equal(post.status, 0, post.stderr);
  // A changed engine entry script is not the recorded release: the gate does not run, every call is refused until
  // it is reinstalled (fail closed), and the session says why.
  const pre = join(home, 'kits', 'ia-governance', added.json.version, 'scripts', 'handlers', 'pre-tool.mjs');
  writeFileSync(pre, readFileSync(pre, 'utf8') + '\n// changed\n');
  const altered = hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b3', tool_input: { command: 'cat README.md' } });
  assert.equal(decision(altered), 'deny');
  assert.match(reason(altered), /^inventarch\/ia-governance-kit: its pre-tool gate may not run, because its bytes are not its recorded release .*kit\.mjs" add --from/s);
  assert.match(context(hook('session', { hook_event_name: 'SessionStart', source: 'startup' })), /inventarch\/ia-governance-kit: its handlers did not run, because its bytes are not its recorded release/);
});
