// bootstrap.mjs: silent outside an IA workspace; inside one, one valid JSON
// SessionStart payload of at most 2,500 characters naming the workspace, the
// installed kits, the bindings grouped by kit and the resolve instruction,
// which survives however many keys are bound; exit 0 always, with or without
// a CLI.
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boundKeys, LIMIT, NOTICE_LIMIT, notInstalledNotice } from '../scripts/bootstrap.mjs';
import { envFor, fakeCli, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

const hook = (cwd, env) => run('bootstrap.mjs', [], env, { input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', cwd }) });

test('outside an IA workspace the hook prints nothing and exits 0', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir });
  const out = hook(join(dir, 'temp'), env);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  const garbage = run('bootstrap.mjs', [], env, { input: 'not json', cwd: join(dir, 'temp') });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('inside a workspace it prints one SessionStart payload of at most 2000 characters with identity, kits, bindings and the instruction', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const repo = makeRepo(join(dir, 'repo'), {
    bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability }, 'work.*': { kit: alpha.id, capability: alpha.capability } }, precedence: [alpha.id], defaults: { knowledge: { kit: alpha.id, capability: alpha.capability } } },
    lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '1.2.0', archive: 'a'.repeat(64) }, { id: alpha.id, version: '0.1.0', archive: alpha.archive }] },
  });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(join(repo, 'sub'), env);
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = payload.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= LIMIT && LIMIT === 2500, `${text.length} chars`);
  assert.match(text, /^This repository is an InventArch workspace\. When a task needs a method, route it through the lanes of the ia plugin/, 'the routing instruction comes first, and only when a method is needed');
  assert.match(text, /`ia:delivery`.*`ia:work`.*`ia:knowledge`/s);
  assert.match(text, /workspace-system\/definition\/workspace\/fake/);
  assert.match(text, /revision rev-fake/);
  assert.match(text, /Kits installed: inventarch\/alpha-kit@0\.1\.0\./);
  assert.match(text, /Bindings \(\.ia\/bindings\.json\): inventarch\/alpha-kit: delivery\.review, work\.\*; defaults for knowledge; precedence inventarch\/alpha-kit\./);
  assert.match(text, /node "<plugin>\/scripts\/resolve\.mjs" --entry <work\|delivery\|knowledge> --activity <activity>/);
  assert.equal(out.stdout.trim().split('\n').length, 1, 'one JSON line');
});

test('bound keys are grouped by kit, and however many there are the resolve instruction still closes the payload', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  const one = { kit: alpha.id, capability: alpha.capability };
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`delivery.activity-number-${i}`, { kit: beta.id, capability: beta.capability }]));
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': one, 'delivery.change': one, 'work.*': [one, { kit: beta.id, capability: beta.capability }], ...many }, precedence: [alpha.id, beta.id] } });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.ok(text.length <= LIMIT, `${text.length} chars`);
  assert.match(text, /inventarch\/alpha-kit: delivery\.\{review, change\}, work\.\*; inventarch\/beta-kit: work\.\*, delivery\.\{activity-number-0, /, 'a key with two candidates is listed under both kits');
  assert.match(text, / \.\.\. \(truncated; bind\.mjs show lists every key\); precedence inventarch\/alpha-kit > inventarch\/beta-kit\./);
  assert.match(text, /\nWhen a method is needed, resolve before acting: node "<plugin>\/scripts\/resolve\.mjs" --entry .*\(ia:init has the protocol\)\.$/, 'the resolve instruction is whole and last');
  assert.equal(boundKeys({ bindings: { 'work.task': [one, { kit: alpha.id, capability: 'other' }] } }), 'inventarch/alpha-kit: work.task', 'two candidates of one kit list the key once');
});

test('without any CLI it still reports from the sources, and without bindings it says nothing is bound', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: join(dir, 'absent', 'main.js'), kitsDir: join(dir, 'kits'), temp: dir, extra: { IA_CORE_NO_NPX: '1' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /@workspace repo \(identity unread\)/);
  assert.match(text, /IA CLI unavailable: IA-CORE-CLI-MISSING/);
  assert.match(text, /Kits installed: none/);
  assert.match(text, /no \.ia\/bindings\.json, so no method is bound.*kit\.mjs bind <kit> --install --apply installs a kit and writes the keys it recommends/);
  assert.ok(text.length <= LIMIT);
});

test('after a compaction it re-injects the current task pin, the one written last for this workspace', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const home = join(dir, 'home');
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir, extra: { IA_HOME: home, CLAUDE_PLUGIN_ROOT: '<plugin>', IA_NO_ACCOUNT_OFFER: '1' } });
  const pin = (project, task, root, capability, when) => {
    const folder = join(home, 'work-v1', project, task);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'binding.json');
    writeFileSync(file, JSON.stringify({ format: 3, revision: 2, workspace: { root, revision: 'r' }, task, kits: { 'inventarch/alpha-kit': { version: '0.3.0', archive: 'a'.repeat(64), sources: 'b'.repeat(64) } }, keys: { 'work.milestone': { kit: 'inventarch/alpha-kit', capability, records: [], scopeKey: null, intent: null } } }));
    utimesSync(file, when, when);
  };
  pin('proj', 'older', repo, 'old-method', new Date('2026-10-01T00:00:00Z'));
  pin('proj', 'newer', repo, 'milestone-method', new Date('2026-10-20T00:00:00Z'));
  pin('proj', 'elsewhere', join(dir, 'other-repo'), 'not-this-one', new Date('2026-10-29T00:00:00Z'));
  const compact = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo }) });
  assert.equal(compact.status, 0, compact.stderr);
  const text = compact.json.hookSpecificOutput.additionalContext;
  assert.match(text, /Current task pin \(proj\/newer, revision 2\): work\.milestone -> inventarch\/alpha-kit@0\.3\.0 milestone-method/);
  assert.match(text, /ia_method \{key, task: "newer"\}/);
  assert.match(text, /<plugin>\/scripts\/resolve\.mjs" --entry <lane> --activity <activity> --project proj --task newer --json/);
  assert.doesNotMatch(text, /old-method|not-this-one/);
  const startup = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: repo }) });
  assert.doesNotMatch(startup.json.hookSpecificOutput.additionalContext, /Current task pin/, 'only a compaction re-injects the pin');
});

// The conditional bootstrap: contribution needs no binding; only an operation that needs a method refuses.
const MARKER_LINE = 'ia-bootstrap v1 public-contribution=available needs-method=ia:work,ia:knowledge,ia:delivery needs-authority=declared-operations';
const MARKER = /^ia-bootstrap v1( [a-z-]+=\S+)+$/m;
const AVAILABLE = /public[- ]contribution[^\n]{0,80}available|available[^\n]{0,80}public[- ]contribution/i;
const NEEDS_BINDING = /(need|require)s?[^\n]{0,60}(bound method|binding|private authority)/i;
const SENTENCE = 'Operations that need a bound method or private authority refuse alone, naming it; everything else continues.';
const contextOf = (out) => JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
const withoutMarker = (text) => text.split('\n').filter(line => !MARKER.test(line)).join('\n');

// Asserts what every output of the bootstrap carries, whatever the repository holds.
function assertConditional(text) {
  assert.ok(text.length <= LIMIT, `${text.length} chars`);
  assert.equal(text.split('\n').filter(line => MARKER.test(line)).join(''), MARKER_LINE, 'the marker line, whole');
  assert.match(text, AVAILABLE);
  assert.ok(text.split('\n').includes(SENTENCE), 'the required sentence, on one line');
  assert.match(withoutMarker(text), NEEDS_BINDING, 'the sentence states what needs a binding apart from the marker');
  assert.doesNotMatch(text, /Before any other skill, plan or action/i);
  assert.doesNotMatch(text, /For any task, use one lane/);
  assert.match(text, /When a task needs a method, route it through the lanes of the ia plugin/);
  assert.ok(text.includes("Reading, building, testing, editing and submitting a change need no binding, plugin, door or private access; follow the repository's own contributing guide."), 'the committed block\'s public-path sentence, whole');
  assert.match(text, /for method-dependent work, other skills apply only when that packet asks for them/);
  assert.doesNotMatch(text, /; other skills apply only when that packet asks/, 'the restriction is scoped to method-dependent work');
  assert.match(text, /When a method is needed, resolve before acting:/);
}

test('F1 no bindings: the marker is there, routing is conditional, and only a method-dependent operation refuses', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = contextOf(out);
  assertConditional(text);
  assert.match(text, /no method is bound; only an operation that needs a method refuses with IA-CORE-NO-METHOD until kit\.mjs bind <kit> --install --apply installs a kit and writes the keys it recommends[^\n]*reading, building, testing and editing continue/);
});

test('F2 a bound workspace still shows the lanes, under "When a task needs a method"', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability } }, precedence: [alpha.id], defaults: {} } });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const text = contextOf(hook(repo, env));
  assertConditional(text);
  assert.match(text, /When a task needs a method, route it through the lanes of the ia plugin:.*`ia:delivery`.*`ia:work`.*`ia:knowledge`/s);
  assert.match(text, /Bindings \(\.ia\/bindings\.json\): inventarch\/alpha-kit: delivery\.review/);
});

test('F3 a locked kit this plugin does not carry is named alone, and the marker still stands', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const carried = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const lock = { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '1.2.0', archive: 'a'.repeat(64) }, { id: carried.id, version: '0.1.0', archive: carried.archive }, { id: 'acme/uncarried-kit', version: '2.0.0', archive: 'c'.repeat(64) }] };
  const repo = makeRepo(join(dir, 'repo'), { lock });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>', IA_CORE_NO_HOME_KITS: '1' } });
  const text = contextOf(hook(repo, env));
  assertConditional(text);
  assert.match(text, /Kit bytes this plugin does not carry: acme\/uncarried-kit; only an operation that needs one of them refuses\./);
  assert.doesNotMatch(text, /does not carry: [^\n]*alpha-kit/);
});

test('F4 no CLI and no door: exit 0, the marker, and a payload within the limit', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: join(dir, 'absent', 'main.js'), kitsDir: join(dir, 'kits'), temp: dir, extra: { IA_CORE_NO_NPX: '1', CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = contextOf(out);
  assertConditional(text);
  assert.match(text, /IA CLI unavailable: IA-CORE-CLI-MISSING/);
});

test('40 bound keys still fit, and the marker and the sentence survive truncation', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  for (const count of [40, 400]) {
    const many = Object.fromEntries(Array.from({ length: count }, (_, i) => [`delivery.activity-number-${i}`, { kit: beta.id, capability: beta.capability }]));
    const repo = makeRepo(join(dir, `repo-${count}`), { bindings: { format: 1, bindings: many, precedence: [beta.id] } });
    const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
    const text = contextOf(hook(repo, env));
    assertConditional(text);
    assert.match(text, /delivery\.\{activity-number-0, /);
  }
});

test('the marker is the one spelling the committed bootstrap block carries, and parses to the same keys', async () => {
  const { BOOTSTRAP_MARKER, BOOTSTRAP_MARKER_PATTERN } = await import('../scripts/bootstrap.mjs');
  assert.equal(BOOTSTRAP_MARKER, MARKER_LINE);
  assert.equal(BOOTSTRAP_MARKER_PATTERN.source, MARKER.source);
  assert.equal(BOOTSTRAP_MARKER_PATTERN.source, '^ia-bootstrap v1( [a-z-]+=\\S+)+$');
  const keys = Object.fromEntries(BOOTSTRAP_MARKER.split(' ').slice(2).map(pair => pair.split('=')));
  assert.deepEqual(keys, { 'public-contribution': 'available', 'needs-method': 'ia:work,ia:knowledge,ia:delivery', 'needs-authority': 'declared-operations' });
});

// The budget covers the whole additionalContext, the optional notices and a compaction's pin included.
const lines = text => text.split('\n');
const assertTail = text => {
  const all = lines(text);
  assert.ok(all.includes(SENTENCE), 'the sentence survives');
  assert.ok(all.includes(MARKER_LINE), 'the marker survives');
  assert.match(text, /When a method is needed, resolve/);
};

function budgetFixture(t, count) {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  const many = Object.fromEntries(Array.from({ length: count }, (_, i) => [`delivery.activity-number-${i}`, { kit: beta.id, capability: beta.capability }]));
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: many, precedence: [beta.id] } });
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { dir, kitsDir, repo, home };
}

test('the final payload, notices and compaction pin included, stays within the limit for 40 and 400 keys', t => {
  for (const count of [40, 400]) {
    const { dir, kitsDir, repo, home } = budgetFixture(t, count);
    const extra = { CLAUDE_PLUGIN_ROOT: '<plugin>', IA_HOME: home, HOME: home, USERPROFILE: home, CI: '', IA_NO_ACCOUNT_OFFER: '' };
    const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra });
    const startup = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: repo }) });
    assert.equal(startup.status, 0, startup.stderr);
    const text = startup.json.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= LIMIT, `${count} keys at startup: ${text.length} chars`);
    assertTail(text);
    assert.match(text, /This repository is governed/, 'the governance reminder is kept');
    assert.ok(startup.json.systemMessage, 'the notices are shown to the person');

    const folder = join(home, 'work-v1', 'proj', 'task');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'binding.json'), JSON.stringify({ format: 3, revision: 2, workspace: { root: repo, revision: 'r' }, task: 'task', kits: { 'inventarch/beta-kit': { version: '0.3.0', archive: 'a'.repeat(64), sources: 'b'.repeat(64) } }, keys: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`work.key-number-${i}`, { kit: 'inventarch/beta-kit', capability: 'some-capability', records: [], scopeKey: null, intent: null }])) }));
    const compact = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo }) });
    assert.equal(compact.status, 0, compact.stderr);
    const after = compact.json.hookSpecificOutput.additionalContext;
    assert.ok(after.length <= LIMIT, `${count} keys after a compaction: ${after.length} chars`);
    assertTail(after);
    assert.match(after, /Current task pin/);
  }
});

test('a very long plugin path cannot push the reserved sentence and marker past the limit', t => {
  for (const length of [200, 1200, 2400, 6000]) {
    const { dir, kitsDir, repo, home } = budgetFixture(t, 400);
    const plugin = `/${'p'.repeat(length)}`;
    const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: plugin, IA_HOME: home, HOME: home, USERPROFILE: home } });
    for (const source of ['startup', 'compact']) {
      const out = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd: repo }) });
      assert.equal(out.status, 0, out.stderr);
      const text = out.json.hookSpecificOutput.additionalContext;
      assert.ok(text.length <= LIMIT, `plugin path of ${length}, ${source}: ${text.length} chars`);
      assertTail(text);
      assert.ok(text.endsWith(lines(text).at(-1)) && lines(text).includes(MARKER_LINE));
      if (length >= 2400) assert.ok(!text.includes(plugin), 'a path that cannot fit is left out of the resolve instruction');
    }
  }
});

// The bound kits the repository's lock does not install: one reserved line, capped, ahead of the unchanged tail.
const NOTICE_HEAD = "Bound kits this repository's lock does not install: ";
const noticeLines = text => lines(text).filter(line => line.startsWith(NOTICE_HEAD));

test('a bound kit the lock does not install is named with the remedy, ahead of the tail, and an installed one is not', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit', capability: 'beta-operate' });
  const bindings = { format: 1, bindings: { 'work.*': { kit: alpha.id, capability: alpha.capability }, 'delivery.review': [{ kit: beta.id, capability: beta.capability }] }, precedence: [alpha.id], defaults: { knowledge: { kit: 'alpha-folder-alias-not-a-kit', capability: 'x' }, work: { kit: alpha.id, capability: alpha.capability } } };
  const lock = { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '3.2.0', archive: 'a'.repeat(64) }, { id: alpha.id, version: '0.1.0', archive: alpha.archive }] };
  const repo = makeRepo(join(dir, 'repo'), { bindings, lock });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>', IA_CORE_NO_HOME_KITS: '1' } });
  const text = contextOf(hook(repo, env));
  assertConditional(text);
  assertTail(text);
  assert.deepEqual(noticeLines(text), [`${NOTICE_HEAD}${beta.id}, alpha-folder-alias-not-a-kit; run kit.mjs add <id> --apply.`], "alpha is a direct row here, which shadows the package entry, so every remedy is add");
  const open = makeRepo(join(dir, "repo-open"), { bindings, lock: { ...lock, packages: [lock.packages[0]] } });
  assert.deepEqual(noticeLines(contextOf(hook(open, env))), [`${NOTICE_HEAD}${alpha.id}, ${beta.id}, alpha-folder-alias-not-a-kit (add); run kit.mjs bind <id> --install --apply, or kit.mjs add <id> --apply for those marked (add).`], "no shadow: the package kits bind --install, the kit it does not carry is marked add");
  const all = lines(text);
  assert.equal(all.indexOf(SENTENCE), all.length - 3, 'the tail keeps its order: the sentence, the marker, the resolve instruction');
  assert.equal(all.indexOf(noticeLines(text)[0]), all.indexOf(SENTENCE) - 1, 'the notice sits just ahead of the tail');
  // The installed lock silences it, through an entry as through a packages row.
  const viaEntry = makeRepo(join(dir, 'repo-entry'), { bindings, lock: { ...lock, packages: [lock.packages[0]], entries: [{ kind: 'package', name: '@inventarch/public-kits', version: '1.0.0', kits: [alpha, beta].map(k => ({ id: k.id, version: '0.1.0', archive: k.archive })) }] } });
  assert.deepEqual(noticeLines(contextOf(hook(viaEntry, env))), [`${NOTICE_HEAD}alpha-folder-alias-not-a-kit; run kit.mjs add <id> --apply.`]);
});

test('with 40 long kit ids the notice is capped and the context stays within the limit; overflow keeps the notice and the tail order', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const keep = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  const ids = Array.from({ length: 40 }, (_, i) => `some-organisation-with-a-long-name/an-especially-long-kit-name-number-${i}`);
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`delivery.activity-number-${i}`, { kit: keep.id, capability: keep.capability }]));
  const kitBindings = Object.fromEntries(ids.map((id, i) => [`work.k${i}`, { kit: id, capability: 'c' }]));
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { ...many, ...kitBindings }, precedence: [keep.id] }, lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: keep.id, version: '0.1.0', archive: keep.archive }] } });
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>', IA_HOME: home, HOME: home, USERPROFILE: home, CI: '', IA_NO_ACCOUNT_OFFER: '' } });
  for (const source of ['startup', 'compact']) {
    const out = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd: repo }) });
    assert.equal(out.status, 0, out.stderr);
    const text = out.json.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= LIMIT, `${source}: ${text.length} chars`);
    assertTail(text);
    const [notice] = noticeLines(text);
    assert.ok(notice && notice.length <= NOTICE_LIMIT, `the notice is capped at ${NOTICE_LIMIT}: ${notice?.length}`);
    assert.match(notice, / \.\.\. and \d+ more; run kit\.mjs add <id> --apply\.$/);
    assert.ok(notice.includes(ids[0]), 'the first kits are named');
    const all = lines(text);
    assert.equal(all.indexOf(SENTENCE), all.length - 3, 'the tail order is unchanged');
    assert.equal(all[all.indexOf(SENTENCE) - 1], notice, 'the notice is whole, just ahead of the tail');
  }
});

test('notInstalledNotice names every kit that fits, counts the rest, and never exceeds its cap', () => {
  assert.equal(notInstalledNotice([]), '');
  assert.equal(notInstalledNotice(['a/b']), `${NOTICE_HEAD}a/b; run kit.mjs bind <id> --install --apply.`);
  const huge = [`${'x'.repeat(NOTICE_LIMIT * 2)}`, 'a/b'];
  assert.ok(notInstalledNotice(huge).length <= NOTICE_LIMIT, 'a single oversized id is cut, not allowed through');
  const forty = Array.from({ length: 40 }, (_, i) => `org/kit-name-${i}`);
  const line = notInstalledNotice(forty);
  assert.ok(line.length <= NOTICE_LIMIT);
  assert.match(line, / and (\d+) more; run kit\.mjs/);
  const shown = line.slice(NOTICE_HEAD.length).split(' ... and ')[0].split(', ').length;
  assert.equal(Number(/and (\d+) more/.exec(line)[1]), 40 - shown);
});

test('a corrupt lock never silences the hook: the payload still prints, with the unreadable lock named', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'work.*': { kit: alpha.id, capability: alpha.capability } }, precedence: [alpha.id] } });
  writeFileSync(join(repo, '.ia', 'distributions.lock.json'), '{ not json');
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>', IA_CORE_NO_HOME_KITS: '1' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = contextOf(out);
  assertConditional(text);
  assert.match(text, /\.ia\/distributions\.lock\.json could not be read/);
  assert.match(text, /Bindings \(\.ia\/bindings\.json\): inventarch\/alpha-kit: work\.\*/);
  assert.deepEqual(noticeLines(text), [], 'no notice can be computed from a lock that cannot be read');
});

test('a single kit id longer than the cap is cut, never the remedy; the add kits are marked when the kinds are mixed', () => {
  const line = notInstalledNotice(['x'.repeat(NOTICE_LIMIT * 3), 'a/b']);
  assert.ok(line.length <= NOTICE_LIMIT, `${line.length}`);
  assert.match(line, /~ \.\.\. and 1 more; run kit\.mjs bind <id> --install --apply\.$/);
  const cutAdd = notInstalledNotice(['x'.repeat(NOTICE_LIMIT * 3), 'a/b'], ['x'.repeat(NOTICE_LIMIT * 3), 'a/b']);
  assert.ok(cutAdd.length <= NOTICE_LIMIT);
  assert.match(cutAdd, /; run kit\.mjs add <id> --apply\.$/);
  const mixed = notInstalledNotice(['p/one', 'q/two'], ['q/two']);
  assert.equal(mixed, `${NOTICE_HEAD}p/one, q/two (add); run kit.mjs bind <id> --install --apply, or kit.mjs add <id> --apply for those marked (add).`);
  const longMixed = notInstalledNotice(['y'.repeat(900), 'q/two'], ['y'.repeat(900)]);
  assert.ok(longMixed.length <= NOTICE_LIMIT && longMixed.includes('~ (add)'), longMixed);
});

test('a notice of 400 characters with long extras keeps the tail and the head minimum', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const keep = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  const bound = { 'work.big': { kit: `some-organisation/${'k'.repeat(900)}`, capability: 'c' }, 'work.keep': { kit: keep.id, capability: keep.capability } };
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: bound, precedence: [keep.id] }, lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: keep.id, version: '0.1.0', archive: keep.archive }] } });
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const folder = join(home, 'work-v1', 'proj', 'task');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'binding.json'), JSON.stringify({ format: 3, revision: 2, workspace: { root: repo, revision: 'r' }, task: 'task', kits: { [keep.id]: { version: '0.3.0', archive: 'a'.repeat(64), sources: 'b'.repeat(64) } }, keys: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`work.pinned-activity-${i}`, { kit: keep.id, capability: keep.capability }])), createdAt: 'x' }));
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: `/${'p'.repeat(1200)}`, IA_HOME: home, HOME: home, USERPROFILE: home, CI: '', IA_NO_ACCOUNT_OFFER: '' } });
  const out = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo }) });
  const text = out.json.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= LIMIT, `${text.length}`);
  assertTail(text);
  const [notice] = noticeLines(text);
  assert.ok(notice && notice.length <= NOTICE_LIMIT && notice.endsWith('; run kit.mjs add <id> --apply.'), notice);
  assert.ok(text.startsWith('This repository is an InventArch workspace.') && text.indexOf(notice) > 100, 'the head stays ahead of the notice');
});
