// Kit handlers (contract C2, decision public-kit-handlers): scripts/handlers.mjs
// runs the session, prompt, tool and stop handlers installed kits declare in
// handlers.json, merges their additionalContext with a cap per kit, honours a
// pre block only in a workspace with .ia/governance.json, and is a silent
// no-op when no kit declares a handler. The governance probe asks whether an
// installed kit declares governance handlers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { governanceNotice } from '../scripts/lib/account.mjs';
import { declaresGovernance, handlerKits, KIT_CONTEXT_CAP, kitHandlers, PLUGIN_RUNS, pluginScriptPresent, runHandlers, selectHandlers } from '../scripts/lib/handlers.mjs';
import { findKit } from '../scripts/lib/kit.mjs';
import { kitProblems } from '../scripts/lib/kit-ops.mjs';
import { declareAssets, envFor, fakeCli, makeKit, makeRepo, PLUGIN, recordSources, run, sandbox } from './helpers/fixtures.mjs';
import { taskId, taskRecord, workCli } from './helpers/work-cli.mjs';

// A handler script: echoes what it saw as additionalContext, or answers `answer`.
const ECHO = `import { readFileSync } from 'node:fs';
const hook = JSON.parse(readFileSync(0, 'utf8') || '{}');
const seen = { event: hook.hook_event_name, source: hook.source ?? null, tool: hook.tool_name ?? null, kit: process.env.IA_KIT_ROOT ? 'set' : 'unset', workspace: process.env.IA_WORKSPACE_ROOT || '', home: process.env.IA_HOME ? 'set' : 'unset' };
process.stdout.write(JSON.stringify(process.env.IA_TEST_HANDLER_ANSWER ? JSON.parse(process.env.IA_TEST_HANDLER_ANSWER) : { additionalContext: 'saw ' + JSON.stringify(seen) }) + '\\n');
`;

// A kit carrying handlers.json and the scripts it names, declared as assets
// (unless declare is false), with its sources recorded as its release, so it
// is trusted. The environment passes only allowlisted names, so the test
// answer travels as IA_TEST_HANDLER_ANSWER.
function handlerKit(kitsDir, folder, handlers, scripts = { 'scripts/echo.mjs': ECHO }, { declare = true, id = `inventarch/${folder}-kit` } = {}) {
  const { dir } = makeKit(kitsDir, { folder, id });
  for (const [rel, text] of Object.entries(scripts)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(join(dir, 'handlers.json'), JSON.stringify({ format: 1, ...handlers }, null, 2) + '\n');
  if (declare) declareAssets(dir, Object.keys(scripts));
  recordSources(dir);
  return dir;
}

function setup(t) {
  const dir = sandbox(t, 'ia-core-handlers-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const repo = makeRepo(dir);
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp'), extra: { IA_HOME: join(dir, 'home') } });
  const hook = (event, input) => run('handlers.mjs', [event], env, { input: JSON.stringify({ cwd: repo, ...input }) });
  return { dir, kitsDir, repo, env, hook };
}

test('kitHandlers reads a well-formed handlers.json and refuses a malformed one', t => {
  const { kitsDir } = setup(t);
  const dir = handlerKit(kitsDir, 'good', {
    session: [{ run: 'scripts/echo.mjs', events: ['compact'] }], prompt: [{ run: 'scripts/echo.mjs', timeout: 5 }],
    tool: [{ run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit' }, { run: 'scripts/echo.mjs', phase: 'post' }], stop: [{ run: 'scripts/echo.mjs' }],
  });
  const read = kitHandlers({ dir });
  assert.deepEqual(read.session, [{ run: 'scripts/echo.mjs', context: null, timeout: 20, events: ['compact'] }]);
  assert.deepEqual(read.prompt, [{ run: 'scripts/echo.mjs', context: null, timeout: 5 }]);
  assert.deepEqual(read.tool.map(h => [h.phase, h.match, h.timeout]), [['pre', 'Write|Edit', 20], ['post', null, 20]]);
  assert.deepEqual(read.stop, [{ run: 'scripts/echo.mjs', context: null, timeout: 20 }]);
  for (const [bad, message] of [
    [{ format: 2 }, /format 1/],
    [{ format: 1, session: [{ run: '../escape.mjs' }] }, /inside the kit/],
    [{ format: 1, session: [{ run: 'scripts/echo.sh' }] }, /\.mjs script/],
    [{ format: 1, tool: [{ run: 'scripts/echo.mjs' }] }, /phase is pre or post/],
    [{ format: 1, prompt: [{ run: 'scripts/echo.mjs', timeout: 60 }] }, /timeout/],
    [{ format: 1, session: [{ run: 'scripts/echo.mjs', events: ['fork'] }] }, /events/],
    [{ format: 1, notify: [] }, /unknown key notify/],
    [{ format: 1, prompt: [{ run: 'scripts/echo.mjs', argv: ['x'] }] }, /unknown key argv/],
    [{ format: 1, prompt: [{ timeout: 5 }] }, /needs a run script, a context text, or both/],
    [{ format: 1, prompt: [{ context: '  ' }] }, /context is a non-empty text/],
    [{ format: 1, prompt: [{ context: 'x'.repeat(KIT_CONTEXT_CAP + 1) }] }, /at most 2000 characters/],
  ]) {
    writeFileSync(join(dir, 'handlers.json'), JSON.stringify(bad));
    assert.throws(() => kitHandlers({ dir }), message, JSON.stringify(bad));
  }
});

test('with no kit declaring a handler every event is a silent no-op', t => {
  const { kitsDir, hook } = setup(t);
  makeKit(kitsDir, { folder: 'plain', id: 'inventarch/plain-kit' });
  for (const [event, input] of [['session', { source: 'startup' }], ['prompt', { prompt: 'hi' }], ['pre', { tool_name: 'Write', tool_input: {} }], ['post', { tool_name: 'Write', tool_input: { file_path: 'a.md' } }], ['stop', {}], ['unknown', {}]]) {
    const ran = hook(event, { hook_event_name: event, ...input });
    assert.equal(ran.status, 0, event);
    assert.equal(ran.stdout, '', `${event} prints nothing`);
  }
});

test('a session handler runs for its events only, with the kit, workspace and home in its environment', t => {
  const { kitsDir, repo, hook } = setup(t);
  handlerKit(kitsDir, 'sess', { session: [{ run: 'scripts/echo.mjs', events: ['startup', 'compact'] }] });
  const started = hook('session', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(started.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = started.json.hookSpecificOutput.additionalContext;
  assert.match(text, /^inventarch\/sess-kit: saw /);
  const seen = JSON.parse(text.slice(text.indexOf('{')));
  assert.deepEqual(seen, { event: 'SessionStart', source: 'compact', tool: null, kit: 'set', workspace: repo, home: 'set' });
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'resume' }).stdout, '', 'resume is not one of its events');
});

test('prompt and stop handlers add context; a stop already continuing adds none', t => {
  const { kitsDir, hook } = setup(t);
  handlerKit(kitsDir, 'turns', { prompt: [{ run: 'scripts/echo.mjs' }], stop: [{ run: 'scripts/echo.mjs' }] });
  assert.equal(hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x' }).json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(hook('stop', { hook_event_name: 'Stop', stop_hook_active: false }).json.hookSpecificOutput.hookEventName, 'Stop');
  assert.equal(hook('stop', { hook_event_name: 'Stop', stop_hook_active: true }).stdout, '');
});

test('every kit\'s context is merged, each capped at its own limit', t => {
  const { kitsDir, env, repo } = setup(t);
  const long = `process.stdout.write(JSON.stringify({ additionalContext: 'x'.repeat(${KIT_CONTEXT_CAP * 2}) }));`;
  handlerKit(kitsDir, 'aaa', { prompt: [{ run: 'scripts/long.mjs' }] }, { 'scripts/long.mjs': long });
  handlerKit(kitsDir, 'bbb', { prompt: [{ run: 'scripts/echo.mjs' }] });
  const ran = run('handlers.mjs', ['prompt'], env, { input: JSON.stringify({ cwd: repo, hook_event_name: 'UserPromptSubmit' }) });
  const [first, second] = ran.json.hookSpecificOutput.additionalContext.split('\n\n');
  assert.equal(first.length, KIT_CONTEXT_CAP);
  assert.match(first, /^inventarch\/aaa-kit: x+ \[truncated\]$/);
  assert.match(second, /^inventarch\/bbb-kit: saw /);
});

test('a pre handler blocks only in a workspace opted in through .ia/governance.json, and only for its tools', t => {
  const { kitsDir, env, repo, hook } = setup(t);
  handlerKit(kitsDir, 'gate', { tool: [{ run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit' }] });
  const blocking = { ...env, IA_TEST_HANDLER_ANSWER: JSON.stringify({ decision: 'block', reason: 'no ledger entry for this change' }) };
  const pre = (tool, e = blocking) => run('handlers.mjs', ['pre'], e, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }) });
  const open = pre('Write');
  assert.equal(open.json.hookSpecificOutput.permissionDecision, undefined, 'not governed: not blocked');
  assert.match(open.json.hookSpecificOutput.additionalContext, /asked to block this tool call: no ledger entry for this change; not applied/);
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const governed = pre('Write');
  assert.deepEqual(governed.json.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'inventarch/gate-kit: no ledger entry for this change' });
  assert.equal(pre('Bash').stdout, '', 'Bash does not match Write|Edit');
  assert.equal(hook('post', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }).stdout, '', 'a pre handler is not a post handler');
});

test('a pre handler that crashes refuses the call in a governed workspace (fail closed), and only there', t => {
  const { kitsDir, env, repo } = setup(t);
  handlerKit(kitsDir, 'crash', { tool: [{ run: 'scripts/crash.mjs', phase: 'pre' }] }, { 'scripts/crash.mjs': "throw new Error('cannot read the ledger');\n" });
  const pre = () => run('handlers.mjs', ['pre'], env, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }) });
  assert.equal(pre().stdout, '', 'not governed: a crash neither blocks nor speaks');
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const governed = pre().json.hookSpecificOutput;
  assert.equal(governed.permissionDecision, 'deny');
  assert.match(governed.permissionDecisionReason, /^inventarch\/crash-kit: its pre-tool handler failed, so the call is refused \(fail closed\): Error: cannot read the ledger$/);
});

test('a handler whose script the kit does not hold never runs (a fetched release carries no executables)', t => {
  const { kitsDir, hook } = setup(t);
  const dir = handlerKit(kitsDir, 'fetched', { session: [{ run: 'scripts/echo.mjs' }] });
  rmSync(join(dir, 'scripts'), { recursive: true });
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }).stdout, '');
});

test('a handler whose script a link carries outside its kit never runs', t => {
  const { dir, kitsDir, hook } = setup(t);
  const kit = handlerKit(kitsDir, 'linked', { session: [{ run: 'scripts/echo.mjs' }] });
  // scripts/ becomes a link to a folder outside the kit that holds the same script.
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'echo.mjs'), ECHO);
  rmSync(join(kit, 'scripts'), { recursive: true });
  try { symlinkSync(outside, join(kit, 'scripts'), 'junction'); } catch (error) { return t.skip(`cannot create a folder link here: ${error.code}`); }
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }).stdout, '');
});

test('kit check refuses a handler script that is not a declared asset', t => {
  const { kitsDir, env } = setup(t);
  handlerKit(kitsDir, 'loose', { stop: [{ run: 'scripts/echo.mjs' }] }, undefined, { declare: false });
  const saved = process.env.IA_CORE_KITS_DIR;
  process.env.IA_CORE_KITS_DIR = env.IA_CORE_KITS_DIR;
  t.after(() => { if (saved === undefined) delete process.env.IA_CORE_KITS_DIR; else process.env.IA_CORE_KITS_DIR = saved; });
  const problems = kitProblems(findKit('inventarch/loose-kit'));
  assert.ok(problems.some(p => /handlers\.json runs scripts that are not declared assets in \.ia\/release\.json: scripts\/echo\.mjs/.test(p)), problems.join('\n'));
});

test('the governance probe names the ia-governance kit until an installed kit declares governance handlers', t => {
  const { kitsDir, repo } = setup(t);
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const kits = () => [findKit('inventarch/gov-kit', kitsDir)];
  handlerKit(kitsDir, 'gov', { session: [{ run: 'scripts/echo.mjs' }] });
  assert.equal(declaresGovernance(handlerKits({ kits: kits() }).kits), false, 'a session handler is not a governance handler');
  const notice = governanceNotice({ source: 'startup', root: repo, kits: kits() });
  assert.match(notice, /this repository is governed \(\.ia\/governance\.json\); add the ia-governance kit \(`ia kit add`\)/);
  assert.doesNotMatch(notice, /plugin/);
  assert.equal(governanceNotice({ source: 'resume', root: repo, kits: kits() }), null, 'startup only');
  writeFileSync(join(kitsDir, 'gov', 'handlers.json'), JSON.stringify({ format: 1, tool: [{ run: 'scripts/echo.mjs', phase: 'pre' }] }));
  assert.match(governanceNotice({ source: 'startup', root: repo, kits: kits() }), /an installed governance gate may not run: inventarch\/gov-kit, because its bytes are not its recorded release.*Every edit and shell command is refused/s, 'a changed handlers.json is not the recorded release');
  recordSources(join(kitsDir, 'gov'));
  assert.equal(governanceNotice({ source: 'startup', root: repo, kits: kits() }), null, 'a kit with a pre handler governs');
});

// ---- the core's own script as a handler run (the method kit's run points)

const ADVISE = '${PLUGIN}/scripts/method-advise.mjs';
const adviseHandlers = { session: [{ run: ADVISE, events: ['resume', 'compact'], timeout: 25 }], tool: [{ run: ADVISE, phase: 'post', match: 'Bash|PowerShell', timeout: 25 }] };
const context = out => out.json?.hookSpecificOutput?.additionalContext ?? '';

// A git work tree holding one uncommitted closed task, a stand-in CLI that knows it, and a kit that carries
// only sidecars (no script) naming the core's script.
function adviseWorld(t, { id = 'inventarch/advice-kit', handlers = adviseHandlers, onwrite } = {}) {
  const dir = sandbox(t, 'ia-core-advise-hook-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const cli = workCli(t, { records: { [taskId('t-none')]: taskRecord('t-none', { status: 'closed' }) }, directed: { [taskId('t-none')]: [] } });
  const repo = cli.root;
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  writeFileSync(join(repo, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n\n@workspace repo\n  meaning\n    says "A repository."\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'start');
  const record = join(repo, '.ia', 'src', 'work.ia');
  writeFileSync(record, '#! ia 1.0\n\n@task t-none\n  work\n    status closed\n');
  const folder = id.split('/')[1].replace(/-kit$/, '');
  const made = makeKit(kitsDir, { folder, id });
  writeFileSync(join(made.dir, 'handlers.json'), JSON.stringify({ format: 1, ...handlers }, null, 2) + '\n');
  if (onwrite) writeFileSync(join(made.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: onwrite }, null, 2) + '\n');
  recordSources(made.dir);
  const env = envFor({ cli: cli.main, kitsDir, temp: join(dir, 'temp'), extra: { IA_HOME: join(dir, 'home') } });
  const post = (payload, event = 'post') => run('handlers.mjs', [event], env, { input: JSON.stringify({ cwd: repo, hook_event_name: event === 'session' ? 'SessionStart' : 'PostToolUse', ...payload }) });
  return { dir, kitsDir, repo, record, env, made, post, cli, git };
}

test('kitHandlers accepts the one allowlisted ${PLUGIN} run and nothing else of that shape', t => {
  const { kitsDir } = setup(t);
  const dir = handlerKit(kitsDir, 'plug', adviseHandlers, {});
  const read = kitHandlers({ dir });
  assert.deepEqual(read.session.map(h => [h.run, h.plugin, h.events]), [[null, 'scripts/method-advise.mjs', ['resume', 'compact']]]);
  assert.deepEqual(read.tool.map(h => [h.run, h.plugin, h.phase, h.match]), [[null, 'scripts/method-advise.mjs', 'post', 'Bash|PowerShell']]);
  assert.deepEqual(PLUGIN_RUNS, ['scripts/method-advise.mjs']);
  for (const [bad, message] of [
    [{ tool: [{ run: ADVISE, phase: 'pre' }] }, /advisory and is refused on a pre handler/],
    [{ prompt: [{ run: ADVISE }] }, /runs only on session and tool post handlers, never on prompt/],
    [{ stop: [{ run: ADVISE }] }, /runs only on session and tool post handlers, never on stop/],
    [{ session: [{ run: '${PLUGIN}/scripts/ceiling.mjs' }] }, /written out in full/],
    [{ session: [{ run: '${PLUGIN}/../x.mjs' }] }, /written out in full/],
    [{ session: [{ run: '${PLUGIN}/scripts/sub/method-advise.mjs' }] }, /written out in full/],
    [{ session: [{ run: '${PLUGIN}/scripts/method-advise.mjs --root x' }] }, /written out in full/],
    [{ session: [{ run: '${PLUGIN}/scripts/method-advise.sh' }] }, /written out in full/],
    [{ session: [{ run: '${KIT}/scripts/x.mjs' }] }, /takes no placeholder/],
    [{ session: [{ run: 'scripts/${PLUGIN}.mjs' }] }, /takes no placeholder/],
  ]) {
    writeFileSync(join(dir, 'handlers.json'), JSON.stringify({ format: 1, ...bad }));
    assert.throws(() => kitHandlers({ dir }), message, JSON.stringify(bad));
  }
  // A loader without the allowlist entry skips the kit with its reason; the hook does not crash.
  writeFileSync(join(dir, 'handlers.json'), JSON.stringify({ format: 1, session: [{ run: '${PLUGIN}/scripts/other-advise.mjs' }] }));
  const { kits, skipped } = handlerKits({ kits: [{ id: 'inventarch/plug-kit', dir, origin: 'home' }] });
  assert.deepEqual(kits, []);
  assert.match(skipped[0].error, /written out in full/);
});

test('the allowlisted script must be that very file of the plugin: a link out of the scripts folder or a missing file is refused', t => {
  const dir = sandbox(t, 'ia-core-plugin-root-');
  const handler = { plugin: 'scripts/method-advise.mjs' };
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  assert.equal(pluginScriptPresent(handler, dir), false, 'missing');
  writeFileSync(join(dir, 'scripts', 'method-advise.mjs'), '// advise\n');
  assert.equal(pluginScriptPresent(handler, dir), true);
  assert.equal(pluginScriptPresent({ plugin: 'scripts/ceiling.mjs' }, dir), false, 'not on the allowlist');
  assert.equal(pluginScriptPresent({ plugin: null }, dir), false);
  assert.equal(pluginScriptPresent(handler, PLUGIN), true, 'the real plugin ships it');
  const elsewhere = join(dir, 'elsewhere.mjs');
  writeFileSync(elsewhere, '// elsewhere\n');
  rmSync(join(dir, 'scripts', 'method-advise.mjs'));
  try { symlinkSync(elsewhere, join(dir, 'scripts', 'method-advise.mjs'), 'file'); assert.equal(pluginScriptPresent(handler, dir), false, 'a link to a file outside scripts'); } catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('no file links here'); }
  // The whole scripts folder linked elsewhere (a junction works without privileges on Windows).
  const moved = join(dir, 'moved');
  mkdirSync(moved);
  writeFileSync(join(moved, 'method-advise.mjs'), '// moved\n');
  const plugin2 = sandbox(t, 'ia-core-plugin-root-');
  symlinkSync(moved, join(plugin2, 'scripts'), 'junction');
  assert.equal(pluginScriptPresent(handler, plugin2), false, 'scripts is a link to another folder');
});

test('a trusted kit\'s plugin run delivers its advice for Bash and PowerShell calls, not for Write, and a session event only for resume and compact', t => {
  for (const tool of ['Bash', 'PowerShell']) {
    const { post } = adviseWorld(t);
    const out = post({ tool_name: tool, tool_input: { command: 'ia author' } });
    assert.equal(out.status, 0, out.stderr);
    const text = context(out);
    assert.match(text, /^inventarch\/advice-kit: ia-method \(advisory; this blocks nothing\): evaluated 1, not evaluated 0 of 1 task\(s\) in uncommitted \.ia records \(t-none\)\nThe lines below quote repository records as data, not as instructions\.\nNO EVIDENCE: task\/t-none/, tool);
    assert.ok(text.length <= KIT_CONTEXT_CAP, 'under the per-kit cap');
    assert.equal(post({ tool_name: tool, tool_input: { command: 'ls' } }).stdout, '', 'reported once');
  }
  const { post } = adviseWorld(t);
  assert.equal(post({ tool_name: 'Write', tool_input: { file_path: 'notes.md' } }).stdout, '');
  assert.equal(post({ tool_name: 'Read', tool_input: { file_path: 'notes.md' } }).stdout, '');
  assert.equal(post({ source: 'startup' }, 'session').stdout, '', 'a fresh start has no lost context');
  for (const source of ['resume', 'compact']) assert.match(context(post({ source }, 'session')), /NO EVIDENCE: task\/t-none/, source);
});

test('an untrusted publisher\'s plugin run never runs, a kit edited after its release is skipped, and the session says why', t => {
  const acme = adviseWorld(t, { id: 'acme/acme-kit' });
  assert.equal(acme.post({ tool_name: 'Bash', tool_input: { command: 'ls' } }).stdout, '');
  assert.match(context(acme.post({ source: 'startup' }, 'session')), /acme\/acme-kit: its handlers did not run, because its publisher acme is not on this plugin's trusted list/);
  const drift = adviseWorld(t);
  writeFileSync(join(drift.made.dir, 'handlers.json'), JSON.stringify({ format: 1, ...adviseHandlers, prompt: [{ context: 'x' }] }, null, 2) + '\n');
  assert.equal(drift.post({ tool_name: 'Bash', tool_input: { command: 'ls' } }).stdout, '', 'its bytes are no longer its recorded release');
  assert.match(context(drift.post({ source: 'startup' }, 'session')), /its bytes are not its recorded release/);
});

test('a plugin run outside an IA workspace starts no process and does not even consult the trust check', async t => {
  const { kitsDir } = setup(t);
  const dir = handlerKit(kitsDir, 'plug', adviseHandlers, {});
  const found = handlerKits({ kits: [findKit('inventarch/plug-kit', kitsDir)] }).kits;
  const picked = selectHandlers(found, 'post', { toolName: 'Bash' });
  assert.equal(picked.length, 1);
  const outside = await runHandlers(picked, { event: 'post', raw: '{}', cwd: dir, workspace: null });
  assert.deepEqual(outside.ran, []);
  assert.deepEqual(outside.skipped, []);
  assert.equal(picked[0].found.trustResult, undefined, 'no trust digest was computed');
});

test('a Write of a .ia file is advised once, by onwrite.json, even when handlers.json also names the script; kit check does not call the plugin run an undeclared asset', t => {
  const { post, record, env } = adviseWorld(t, { onwrite: [{ name: 'method-advise', extensions: ['.ia'], argv: ['${NODE}', '${PLUGIN}/scripts/method-advise.mjs'], timeout: 25 }] });
  const out = post({ tool_name: 'Write', tool_input: { file_path: record } });
  assert.equal(out.status, 0, out.stderr);
  assert.equal((context(out).match(/NO EVIDENCE: task\/t-none/g) ?? []).length, 1, context(out));
  const saved = process.env.IA_CORE_KITS_DIR;
  process.env.IA_CORE_KITS_DIR = env.IA_CORE_KITS_DIR;
  t.after(() => { if (saved === undefined) delete process.env.IA_CORE_KITS_DIR; else process.env.IA_CORE_KITS_DIR = saved; });
  const problems = kitProblems(findKit('inventarch/advice-kit'));
  assert.ok(!problems.some(p => /handlers\.json runs scripts/.test(p)), problems.join('\n'));
});

test('a repository with no .ia makes the shell hook start nothing and answer nothing', t => {
  const w = adviseWorld(t);
  const bare = join(w.dir, 'bare');
  mkdirSync(bare);
  const out = run('handlers.mjs', ['post'], w.env, { input: JSON.stringify({ cwd: bare, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, '');
  assert.deepEqual(w.cli.calls(), [], 'no CLI call was started');
});
