// resolve.mjs end to end against the stand-in CLI: the packet, its refusals,
// the task pin (a newer kit never moves a pinned task; --rebind writes a new
// revision with supersedes), isolation between repositories, the enforcement
// entry a capability with checks puts in `missing`, and whole-procedure
// packets: every cell of the bound playbook read by identity, for a
// whole-procedure activity or when the position delivers none of them.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WHOLE_PROCEDURE } from '../scripts/lib/workspace.mjs';
import { envFor, fakeCli, installLock, makeKit, makeRepo, run, sandbox, sha256 } from './helpers/fixtures.mjs';

const bindings = (key, kit, capability, extra = {}) => ({ format: 1, bindings: { [key]: { kit, capability } }, ...extra });

function world(t) {
  const dir = sandbox(t, 'ia-core-resolve-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-review', playbook: 'alpha-operate', checks: ['alpha-gate'] });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit', capability: 'beta-task', playbook: 'beta-operate', checks: [], profile: null });
  const cli = fakeCli(dir);
  const env = (runRoot, extra) => envFor({ cli, kitsDir, temp: join(dir, 'temp'), runRoot, extra });
  return { dir, kitsDir, alpha, beta, cli, env };
}

const resolve = (args, env, cwd) => run('resolve.mjs', args, env, { cwd });
// A repository whose own position answers as the kit's does: a bound kit is installed, and the installed repository answers position itself.
const answeringAs = (repo, kit) => writeFileSync(join(repo, '.ia', 'fake-cli.json'), readFileSync(join(kit.dir, '.ia', 'fake-cli.json')));

test('a bound activity resolves to a packet: closure, scope key, instructions of the capability, references, role, effects, runner', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', alpha.id, alpha.capability) });
  answeringAs(repo, alpha);
  const out = resolve(['--entry', 'delivery', '--activity', 'review', '--subject', 'PR 7', '--root', repo, '--json'], env());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const p = out.json;
  assert.equal(p.contract, 1);
  assert.deepEqual(p.binding, { key: 'delivery.review', via: 'exact', kit: alpha.id, capability: alpha.capability, revision: null, supersedes: null, pin: null, run: null, rebound: false });
  assert.equal(p.closure.kit, alpha.id);
  assert.equal(p.closure.version, '0.1.0');
  assert.equal(p.closure.archive, alpha.archive);
  assert.match(p.closure.sources, /^[a-f0-9]{64}$/);
  assert.deepEqual(p.closure.records, [alpha.capId, alpha.playbookId, alpha.profileId, 'compliance-system/check/gate/alpha-gate']);
  assert.deepEqual(p.scope.key, { shape: 'learning', phase: 'learn', depth: 1, budget: 16 });
  assert.equal(p.scope.subject, 'PR 7');
  assert.equal(p.scope.mapped, true);
  assert.equal(p.scope.workspace.root, repo);
  assert.deepEqual(p.instructions, [{ playbook: alpha.playbookId, address: `${alpha.playbookId}#learn/Learning`, text: `${alpha.id} 0.1.0: learn cell`, source: 'position' }]);
  assert.deepEqual(p.references[0], { identity: 'governance-system/governance/law/alpha-law', digest: 'rule-alpha', when: 'always' });
  assert.equal(p.role.profile, alpha.profileId);
  assert.match(p.role.brief, /^Role brief of fake-worker/);
  assert.deepEqual(p.requestedOperations, ['read', 'local-write']);
  assert.deepEqual(p.effectiveOperations, { status: 'host-determined', runner: ['alpha-gate'] });
  assert.deepEqual(p.evidence.required, ['alpha-gate']);
  assert.equal(p.kitUpdateAvailable, null);
  assert.match(p.digest, /^[a-f0-9]{64}$/);
  assert.equal(p.envelope.kitInstalled, true, 'a bound kit is one the lock installs');
  assert.equal(p.envelope.cliVersion, '3.8.0');
  // The capability composes a check, so the packet says the host does not enforce the checker restriction.
  const enforcement = p.missing.find(m => m.kind === 'enforcement');
  assert.deepEqual({ requirement: enforcement.requirement, via: enforcement.via, checks: enforcement.checks }, { requirement: 'constrained-checks', via: 'scripts/check.mjs', checks: ['alpha-gate'] });
  // --shape and --phase override the mapped key; an unmapped activity takes the entry default.
  const overridden = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--shape', 'execution', '--phase', 'act'], env()).json;
  assert.deepEqual([overridden.scope.key.shape, overridden.scope.key.phase], ['execution', 'act']);
  assert.equal(overridden.instructions[0].address, `${alpha.playbookId}#act/Decision`);
  assert.notEqual(overridden.digest, p.digest);
  const wildcard = makeRepo(join(dir, 'repo2'), { bindings: bindings('delivery.*', alpha.id, alpha.capability) });
  const unmapped = resolve(['--entry', 'delivery', '--activity', 'tinker', '--root', wildcard], env()).json;
  assert.deepEqual([unmapped.scope.key.shape, unmapped.scope.key.phase, unmapped.scope.mapped, unmapped.binding.via], ['execution', 'act', false, 'wildcard']);
});

test('a capability without checks lists no enforcement requirement; a kit without a profile briefs from the capability', t => {
  const { dir, beta, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('work.task', beta.id, beta.capability) });
  const p = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json;
  assert.deepEqual([p.scope.key.shape, p.scope.key.phase], ['governance', 'plan']);
  assert.equal(p.missing.some(m => m.kind === 'enforcement'), false);
  assert.deepEqual(p.effectiveOperations.runner, []);
  assert.equal(p.role.profile, null);
  assert.match(p.role.brief, /^Capability beta-task/);
});

test('refusals: no workspace, no method, a conflict with candidates, an unknown kit, and bad usage', t => {
  const { dir, alpha, beta, env } = world(t);
  const none = resolve(['--entry', 'work', '--activity', 'task', '--root', join(dir, 'temp')], env());
  assert.equal(none.status, 1);
  assert.equal(none.json.error.code, 'IA-CORE-NO-WORKSPACE');
  const unbound = makeRepo(join(dir, 'unbound'));
  const noMethod = resolve(['--entry', 'work', '--activity', 'task', '--root', unbound], env());
  assert.equal(noMethod.status, 1);
  assert.equal(noMethod.json.error.code, 'IA-CORE-NO-METHOD');
  assert.equal(noMethod.json.error.key, 'work.task');
  const conflicted = makeRepo(join(dir, 'conflict'), { bindings: { format: 1, bindings: { 'work.task': [{ kit: alpha.id, capability: alpha.capability }, { kit: beta.id, capability: beta.capability }] } } });
  const conflict = resolve(['--entry', 'work', '--activity', 'task', '--root', conflicted], env());
  assert.equal(conflict.status, 1);
  assert.equal(conflict.json.error.code, 'IA-CORE-CONFLICT');
  assert.deepEqual(conflict.json.error.candidates, [{ kit: alpha.id, capability: alpha.capability }, { kit: beta.id, capability: beta.capability }]);
  writeFileSync(join(conflicted, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings: { 'work.task': [{ kit: alpha.id, capability: alpha.capability }, { kit: beta.id, capability: beta.capability }] }, precedence: [beta.id] }));
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', conflicted], env()).json.closure.kit, beta.id);
  const unknown = makeRepo(join(dir, 'unknown'), { bindings: bindings('work.task', 'inventarch/none-kit', 'x') });
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', unknown], env()).json.error.code, 'IA-CORE-KIT-UNKNOWN');
  assert.equal(resolve(['--entry', 'work'], env()).status, 2);
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', unbound, '--bogus'], env()).status, 2);
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', unbound, '--pin'], env()).status, 2, '--pin without a task folder');
});

test('pin: the first resolve writes revision 1; retained pinned bytes survive updates without changing the pin; --rebind writes revision 2 with supersedes', t => {
  const { dir, kitsDir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', alpha.id, alpha.capability) });
  const taskRoot = join(dir, 'work', 'proj', 'task-1');
  const first = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--run', 'run-a'], env(taskRoot)).json;
  assert.deepEqual([first.binding.revision, first.binding.supersedes, first.binding.run, first.binding.rebound], [1, null, 'run-a', false]);
  assert.equal(first.binding.pin.root, taskRoot);
  assert.equal(first.binding.pin.key, 'delivery.review');
  const pin = JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8'));
  assert.equal(pin.format, 3);
  assert.equal(pin.revision, 1);
  assert.equal(pin.supersedes, null);
  assert.deepEqual(pin.kits, { [alpha.id]: { version: '0.1.0', archive: alpha.archive, sources: first.closure.sources, implementation: first.closure.implementation, retained: first.closure.retained } });
  assert.deepEqual(Object.keys(pin.keys), ['delivery.review']);
  const pinned = pin.keys['delivery.review'];
  assert.equal(pinned.kit, alpha.id);
  assert.equal(pinned.capability, alpha.capability);
  assert.deepEqual(pinned.scopeKey, { shape: 'learning', phase: 'learn', seat: `workspace-system/definition/workspace/fake`, word: null });
  assert.deepEqual(pinned.intent, { entry: 'delivery', activity: 'review', subject: null });
  assert.equal(pin.workspace.root, repo);
  // A second run of the same task shares the pin and writes nothing new.
  const again = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--run', 'run-b'], env(taskRoot)).json;
  assert.deepEqual([again.binding.revision, again.binding.run, again.kitUpdateAvailable], [1, 'run-b', null]);
  assert.equal(again.digest, first.digest);
  // The plugin now carries a newer alpha kit.
  const newer = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', version: '0.2.0', capability: 'alpha-review', playbook: 'alpha-operate', checks: ['alpha-gate'] });
  const stale = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env(taskRoot)).json;
  assert.equal(stale.closure.version, '0.1.0');
  assert.deepEqual(stale.instructions, first.instructions);
  assert.equal(JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8')).revision, 1);
  // --rebind moves the task to the available kit in a new revision that supersedes the first.
  const rebound = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--rebind'], env(taskRoot)).json;
  assert.deepEqual([rebound.binding.revision, rebound.binding.supersedes, rebound.binding.rebound, rebound.closure.version, rebound.kitUpdateAvailable], [2, 1, true, '0.2.0', null]);
  const current = JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8'));
  assert.deepEqual([current.revision, current.supersedes, current.kits[alpha.id].version], [2, 1, '0.2.0']);
  assert.equal(JSON.parse(readFileSync(join(taskRoot, 'binding.1.json'), 'utf8')).revision, 1);
  // A binding change under a pin is refused until --rebind; --no-pin and a stateless resolve write nothing.
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify(bindings('delivery.review', alpha.id, 'alpha-other')));
  const changed = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env(taskRoot));
  assert.equal(changed.json.error.code, 'IA-CORE-REBIND-REQUIRED');
  const fresh = join(dir, 'work', 'proj', 'task-2');
  assert.equal(resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--no-pin'], env(fresh)).json.error.code, 'IA-CORE-CAPABILITY-UNAVAILABLE');
  assert.equal(existsSync(join(fresh, 'binding.json')), false);
  assert.equal(resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env()).json.error.code, 'IA-CORE-CAPABILITY-UNAVAILABLE');
});

test('isolation: two repositories with different bindings resolve different kits, and a task folder of repo A is refused for repo B', t => {
  const { dir, alpha, beta, env } = world(t);
  const a = makeRepo(join(dir, 'repo-a'), { bindings: bindings('work.task', alpha.id, alpha.capability) });
  const b = makeRepo(join(dir, 'repo-b'), { bindings: bindings('work.task', beta.id, beta.capability) });
  const taskA = join(dir, 'work', 'proj', 'task-a');
  const taskB = join(dir, 'work', 'proj', 'task-b');
  const fromA = resolve(['--entry', 'work', '--activity', 'task', '--root', a], env(taskA)).json;
  const fromB = resolve(['--entry', 'work', '--activity', 'task', '--root', b], env(taskB)).json;
  assert.equal(fromA.closure.kit, alpha.id);
  assert.equal(fromB.closure.kit, beta.id);
  assert.notEqual(fromA.digest, fromB.digest);
  assert.equal(fromA.instructions[0].text, `${alpha.id} 0.1.0: plan cell`);
  assert.equal(fromB.instructions[0].text, `${beta.id} 0.1.0: plan cell`);
  const crossed = resolve(['--entry', 'work', '--activity', 'task', '--root', b], env(taskA));
  assert.equal(crossed.status, 1);
  assert.equal(crossed.json.error.code, 'IA-CORE-RUN-MISMATCH');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(taskA, 'binding.json'), 'utf8')).kits), [alpha.id], 'the pin of A is untouched');
  assert.equal(JSON.parse(readFileSync(join(taskA, 'binding.json'), 'utf8')).revision, 1);
});

test('pin per key: a new key joins the task in a new revision, at the version the task holds for its kit; another kit joins beside it; a pinned key whose binding changed needs --rebind', t => {
  const { dir, kitsDir, alpha, beta, env } = world(t);
  const second = makeKit(kitsDir, { folder: 'alpha2', id: 'inventarch/alpha2-kit', capability: 'alpha2-review', playbook: 'alpha2-operate', checks: [], profile: null });
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'work.task': { kit: alpha.id, capability: alpha.capability }, 'work.meeting': { kit: alpha.id, capability: alpha.capability }, 'work.completion': { kit: beta.id, capability: beta.capability } } }, lock: installLock({ bindings: { a: { kit: alpha.id }, b: { kit: beta.id }, c: { kit: second.id } } }) });
  const taskRoot = join(dir, 'work', 'proj', 'task-k');
  const read = () => JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8'));
  const task = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot)).json;
  assert.deepEqual([task.binding.revision, task.binding.pin.key], [1, 'work.task']);
  // The plugin now carries alpha 0.2.0; the task already holds alpha 0.1.0.
  makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', version: '0.2.0', capability: 'alpha-review', playbook: 'alpha-operate', checks: ['alpha-gate'] });
  const retained = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot));
  assert.equal(retained.status, 0, retained.stdout);
  assert.equal(retained.json.closure.version, '0.1.0');
  assert.equal(read().revision, 1);
  makeKit(kitsDir, { folder: 'alpha', id: alpha.id, capability: alpha.capability, playbook: 'alpha-operate', checks: ['alpha-gate'] });
  const meeting = resolve(['--entry', 'work', '--activity', 'meeting', '--root', repo], env(taskRoot));
  assert.equal(meeting.status, 0, meeting.stdout + meeting.stderr);
  assert.deepEqual([meeting.json.binding.revision, meeting.json.binding.supersedes, meeting.json.binding.capability, meeting.json.closure.version], [2, 1, alpha.capability, '0.1.0'], 'a new key of a pinned kit joins at the task\'s version of that kit');
  assert.equal(meeting.json.kitUpdateAvailable, null);
  assert.deepEqual(Object.keys(read().keys).sort(), ['work.meeting', 'work.task']);
  assert.equal(read().kits[alpha.id].version, '0.1.0');
  // Resolving a pinned key again writes nothing.
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot)).json.binding.revision, 2);
  assert.equal(read().revision, 2);
  // Another kit joins beside it in its own revision.
  const completion = resolve(['--entry', 'work', '--activity', 'completion', '--root', repo], env(taskRoot)).json;
  assert.deepEqual([completion.binding.revision, completion.closure.kit], [3, beta.id]);
  assert.deepEqual(Object.keys(read().kits).sort(), [alpha.id, beta.id].sort());
  assert.equal(existsSync(join(taskRoot, 'binding.2.json')), true, 'every earlier revision is kept');
  // A pinned key whose binding moved to another kit or capability is refused, and names the key; --rebind moves that key and its kit's version.
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings: { 'work.task': { kit: second.id, capability: second.capability }, 'work.meeting': { kit: alpha.id, capability: alpha.capability }, 'work.completion': { kit: beta.id, capability: beta.capability } } }));
  const moved = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot));
  assert.equal(moved.json.error.code, 'IA-CORE-REBIND-REQUIRED');
  assert.match(moved.json.error.message, /pins work\.task to inventarch\/alpha-kit#alpha-review/);
  assert.equal(resolve(['--entry', 'work', '--activity', 'meeting', '--root', repo], env(taskRoot)).status, 0, 'the other keys still resolve');
  const rebound = resolve(['--entry', 'work', '--activity', 'task', '--root', repo, '--rebind'], env(taskRoot)).json;
  assert.deepEqual([rebound.binding.revision, rebound.binding.rebound, rebound.closure.kit], [4, true, second.id]);
  assert.deepEqual(read().keys['work.task'], { ...read().keys['work.task'], kit: second.id, capability: second.capability });
  assert.equal(read().keys['work.meeting'].kit, alpha.id, 'the other keys keep their pins');
});

test('a format 1 pin is read as its one key and written as format 3 on its next revision; a malformed pin is refused', t => {
  const { dir, alpha, beta, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability }, 'work.task': { kit: beta.id, capability: beta.capability } } } });
  const taskRoot = join(dir, 'work', 'proj', 'task-legacy');
  const legacy = { format: 1, revision: 3, workspace: { root: repo, revision: 'rev-alpha-0.1.0' }, task: 'task-legacy', intent: { entry: 'delivery', activity: 'review', subject: null }, kit: { id: alpha.id, version: '0.1.0', archive: alpha.archive, sources: 'legacy-sources' }, capability: alpha.capability, records: [], scopeKey: { shape: 'learning', phase: 'learn', seat: null, word: null }, createdAt: '2026-10-14T00:00:00.000Z', supersedes: 2 };
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, 'binding.json'), JSON.stringify(legacy));
  const review = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env(taskRoot)).json;
  assert.equal(review.error.code, 'IA-CORE-PIN-UNAVAILABLE', 'an unverifiable legacy pin must be explicitly rebound');
  assert.equal(JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8')).format, 1);
  const task = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot)).json;
  assert.deepEqual([task.binding.revision, task.binding.supersedes], [4, 3]);
  const upgraded = JSON.parse(readFileSync(join(taskRoot, 'binding.json'), 'utf8'));
  assert.equal(upgraded.format, 3);
  assert.deepEqual(Object.keys(upgraded.keys).sort(), ['delivery.review', 'work.task']);
  assert.equal(upgraded.kits[alpha.id].sources, 'legacy-sources');
  assert.equal(JSON.parse(readFileSync(join(taskRoot, 'binding.3.json'), 'utf8')).format, 1, 'the legacy revision is kept as it was');
  writeFileSync(join(taskRoot, 'binding.json'), JSON.stringify({ format: 2, revision: 5, workspace: { root: repo }, kits: {}, keys: { 'work.task': { kit: beta.id, capability: beta.capability } } }));
  assert.equal(resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot)).json.error.code, 'IA-CORE-PIN-MALFORMED', 'a key whose kit the pin does not hold');
});

test('unbound resolve: outside an IA workspace --kit and --capability name the method, nothing is pinned; inside one it is refused', t => {
  const { dir, alpha, env } = world(t);
  const plain = join(dir, 'plain');
  mkdirSync(join(plain, '.git'), { recursive: true });
  const taskRoot = join(dir, 'work', 'proj', 'task-u');
  const out = resolve(['--entry', 'work', '--activity', 'meeting', '--root', plain, '--kit', alpha.id, '--capability', alpha.capability, '--json'], env(taskRoot));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const p = out.json;
  assert.deepEqual([p.binding.via, p.binding.key, p.binding.kit, p.binding.capability, p.binding.pin, p.binding.revision], ['unbound', 'work.meeting', alpha.id, alpha.capability, null, null]);
  assert.equal(p.scope.workspace, null);
  assert.equal(p.closure.kit, alpha.id);
  assert.equal(p.role.profile, alpha.profileId);
  assert.ok(p.instructions.length > 0);
  assert.ok(p.missing.some(m => m.kind === 'pin'), 'a task folder is noted, not used');
  assert.equal(existsSync(join(taskRoot, 'binding.json')), false);
  // --profile picks the role; --kit without --capability is bad usage; without --kit it is NO-WORKSPACE, naming --kit.
  const named = resolve(['--entry', 'work', '--activity', 'meeting', '--root', plain, '--kit', 'alpha', '--capability', alpha.capability, '--profile', alpha.profile], env()).json;
  assert.deepEqual([named.binding.kit, named.role.profile], ['alpha', alpha.profileId], 'the kit may be named by folder; --profile names the role');
  const unknown = resolve(['--entry', 'work', '--activity', 'meeting', '--root', plain, '--kit', alpha.id, '--capability', alpha.capability, '--profile', 'someone-else'], env()).json;
  assert.equal(unknown.error.code, 'IA-CORE-COMPOSITION-MISSING');
  assert.match(unknown.error.message, /someone-else/);
  assert.equal(resolve(['--entry', 'work', '--activity', 'meeting', '--root', plain, '--kit', alpha.id], env()).status, 2);
  const none = resolve(['--entry', 'work', '--activity', 'meeting', '--root', plain], env()).json;
  assert.equal(none.error.code, 'IA-CORE-NO-WORKSPACE');
  assert.match(none.error.message, /--kit <kit> --capability <capability>/);
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('work.meeting', alpha.id, alpha.capability) });
  const inside = resolve(['--entry', 'work', '--activity', 'meeting', '--root', repo, '--kit', alpha.id, '--capability', alpha.capability], env()).json;
  assert.equal(inside.error.code, 'IA-CORE-UNBOUND-IN-WORKSPACE');
  assert.match(inside.error.message, /bind\.mjs set work\.meeting/);
});

test('a kit that lists what it resolves outside a workspace (bindings.json unbound) refuses the rest with IA-CORE-UNBOUND-UNDECLARED', t => {
  const { dir, alpha, beta, env } = world(t);
  const plain = join(dir, 'plain');
  mkdirSync(join(plain, '.git'), { recursive: true });
  const args = (kit, capability) => ['--entry', 'delivery', '--activity', 'design', '--root', plain, '--kit', kit, '--capability', capability, '--json'];
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: {}, unbound: [] }));
  const refused = resolve(args(alpha.id, alpha.capability), env());
  assert.equal(refused.status, 1);
  assert.equal(refused.json.error.code, 'IA-CORE-UNBOUND-UNDECLARED');
  assert.match(refused.json.error.message, /does not resolve alpha-review outside an IA workspace; it declares none/);
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: {}, unbound: [alpha.capability] }));
  assert.equal(resolve(args(alpha.id, alpha.capability), env()).status, 0, 'a declared capability resolves');
  assert.equal(resolve(args(beta.id, beta.capability), env()).status, 0, 'a kit without bindings.json resolves any capability, as before');
});

test('IA-CORE-NO-METHOD names the carried kits that recommend the key and the command that applies them; nothing is bound', t => {
  const { dir, alpha, beta, env } = world(t);
  writeFileSync(join(alpha.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'delivery.design': { capability: alpha.capability } } }));
  writeFileSync(join(beta.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'delivery.*': { capability: beta.capability } } }));
  const repo = makeRepo(join(dir, 'repo'));
  const out = resolve(['--entry', 'delivery', '--activity', 'design', '--root', repo], env());
  assert.equal(out.status, 1);
  assert.equal(out.json.error.code, 'IA-CORE-NO-METHOD');
  assert.deepEqual(out.json.error.candidates, [{ kit: alpha.id, capability: alpha.capability, key: 'delivery.design' }, { kit: beta.id, capability: beta.capability, key: 'delivery.*' }]);
  assert.match(out.json.error.message, /Carried kits recommend it: inventarch\/alpha-kit \(delivery\.design -> alpha-review\), inventarch\/beta-kit \(delivery\.\* -> beta-task\); bind\.mjs recommend <kit>/);
  assert.equal(existsSync(join(repo, '.ia', 'bindings.json')), false, 'the refusal binds nothing');
  const plain = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json.error;
  assert.equal(plain.candidates, undefined, 'a key no kit recommends keeps the plain refusal');
});

test('an installed kit cannot replace method content; --seat selects consumer context separately', t => {
  const { dir, alpha, env } = world(t);
  // A kit the repository binds but its lock does not install is refused, seat or no seat; it is never read as a context-only kit.
  const uninstalled = makeRepo(join(dir, 'uninstalled'), { bindings: bindings('knowledge.find', alpha.id, alpha.capability), lock: null });
  const refused = resolve(['--entry', 'knowledge', '--activity', 'find', '--root', uninstalled, '--seat', 'work-system/definition/task/t1'], env()).json;
  assert.equal(refused.error.code, 'IA-CORE-KIT-NOT-INSTALLED');
  const installed = makeRepo(join(dir, 'installed'), { bindings: bindings('knowledge.find', alpha.id, alpha.capability), lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: alpha.id, version: '0.1.0', archive: alpha.archive }] } });
  // The installed repository answers position itself: give it the kit's canned answers.
  writeFileSync(join(installed, '.ia', 'fake-cli.json'), readFileSync(join(alpha.dir, '.ia', 'fake-cli.json')));
  const seated = resolve(['--entry', 'knowledge', '--activity', 'find', '--root', installed, '--seat', 'work-system/definition/task/t1'], env()).json;
  assert.equal(seated.envelope.kitInstalled, true);
  assert.notEqual(seated.envelope.kitRoot, installed);
  assert.equal(seated.scope.seat, 'work-system/definition/task/t1');
  assert.equal(seated.missing.some(m => m.kind === 'seat'), true);
});

test("an adopted repository's packet carries the seat's laws and mandates, and its refused position passes IA's hint on; a kit the lock does not install is refused", t => {
  const { dir, alpha, env } = world(t);
  const canned = JSON.parse(readFileSync(join(alpha.dir, '.ia', 'fake-cli.json'), 'utf8'));
  const answer = (repo, position) => writeFileSync(join(repo, '.ia', 'fake-cli.json'), JSON.stringify({ ...canned, position }));
  const of = (packet, when) => packet.references.filter(r => r.when === when).map(r => r.identity);
  const installed = makeRepo(join(dir, 'installed'), { bindings: bindings('knowledge.find', alpha.id, alpha.capability), lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: alpha.id, version: '0.1.0', archive: alpha.archive }] } });
  answer(installed, { ...canned.position, rules: [{ identity: 'governance-system/governance/law/repo-law', digest: 'repo' }], mandates: [{ identity: 'agent-system/policy/mandate/repo-mandate', digest: 'seat' }] });
  const seated = resolve(['--entry', 'knowledge', '--activity', 'find', '--root', installed, '--seat', 'work-system/definition/task/t1'], env());
  assert.equal(seated.status, 0, seated.stdout + seated.stderr);
  assert.deepEqual([of(seated.json, 'always'), of(seated.json, 'seat')], [['governance-system/governance/law/repo-law'], ['agent-system/policy/mandate/repo-mandate']], "the seat's governance, not the kit's");
  assert.deepEqual(seated.json.instructions.map(c => c.text), resolve(['--entry', 'knowledge', '--activity', 'find', '--root', makeRepo(join(dir, 'plain'), { bindings: bindings('knowledge.find', alpha.id, alpha.capability) })], env()).json.instructions.map(c => c.text), 'the method still comes from the kit');
  // A kit the lock does not install does not bring its own laws to a repository that binds it: it is refused.
  const uninstalled = makeRepo(join(dir, 'uninstalled'), { bindings: bindings('knowledge.find', alpha.id, alpha.capability), lock: null });
  answer(uninstalled, { ...canned.position, rules: [{ identity: 'governance-system/governance/law/repo-law', digest: 'repo' }] });
  assert.equal(resolve(['--entry', 'knowledge', '--activity', 'find', '--root', uninstalled], env()).json.error.code, 'IA-CORE-KIT-NOT-INSTALLED');
  // A fresh, unrestored clone: IA refuses position in the repository.
  const unrestored = { refuse: { code: 'IA-DIST-NOT-RESTORED', message: 'the locked distributions are not restored', next: 'ia restore --apply' } };
  answer(installed, unrestored);
  const refused = resolve(['--entry', 'knowledge', '--activity', 'find', '--root', installed], env()).json;
  assert.equal(refused.error.code, 'IA-CORE-POSITION');
  assert.match(refused.error.message, /the locked distributions are not restored \(next: ia restore --apply\)/);
});

test('a composed check without a runner is carried as host-run and unavailable; a capability none of whose checks can run refuses', t => {
  const { dir, kitsDir, env } = world(t);
  const gamma = makeKit(kitsDir, { folder: 'gamma', id: 'inventarch/gamma-kit', capability: 'gamma-review', playbook: 'gamma-operate', checks: ['gamma-gate', 'gamma-host'] });
  const runners = join(gamma.dir, 'checks.json'), declared = JSON.parse(readFileSync(runners, 'utf8'));
  delete declared.checks['gamma-host'];
  writeFileSync(runners, JSON.stringify(declared));
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', gamma.id, gamma.capability) });
  const out = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.json.evidence.required, ['gamma-gate', 'gamma-host']);
  assert.deepEqual(out.json.missing.filter(m => m.kind === 'check-unavailable').map(m => m.check), ['gamma-host']);
  assert.equal(out.json.instructions.length > 0, true);
  delete declared.checks['gamma-gate'];
  writeFileSync(runners, JSON.stringify(declared));
  const none = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env()).json;
  assert.equal(none.error.code, 'IA-CORE-CHECK-UNAVAILABLE');
  assert.match(none.error.message, /gamma-gate, gamma-host have no declared runner/);
});

test('a composed check that runs an IA evaluator other than COMP-CHECK is IA-evaluated, not host-run, and does not count toward an all-host-run refusal', t => {
  const { dir, kitsDir, env } = world(t);
  const gamma = makeKit(kitsDir, { folder: 'gamma', id: 'inventarch/gamma-kit', capability: 'gamma-review', playbook: 'gamma-operate', checks: ['gamma-cover', 'gamma-gate', 'gamma-typo'] });
  const runners = join(gamma.dir, 'checks.json'), declared = JSON.parse(readFileSync(runners, 'utf8'));
  const canned = join(gamma.dir, '.ia', 'fake-cli.json'), cli = JSON.parse(readFileSync(canned, 'utf8'));
  const runs = (name, evaluator) => { cli.inspect[`compliance-system/check/gate/${name}`].sections = [{ name: 'check', fields: [{ key: 'runs', value: { kind: 'scalar', text: evaluator } }] }]; };
  runs('gamma-cover', 'COMP-COVERAGE');
  runs('gamma-typo', 'COMP-CHECK');
  writeFileSync(canned, JSON.stringify(cli));
  delete declared.checks['gamma-cover'];
  delete declared.checks['gamma-typo'];
  writeFileSync(runners, JSON.stringify(declared));
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', gamma.id, gamma.capability) });
  const out = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.json.evidence.required, ['gamma-cover', 'gamma-gate', 'gamma-typo']);
  assert.deepEqual(out.json.missing.filter(m => m.kind === 'check-unavailable').map(m => m.check), ['gamma-typo'], 'a runnerless COMP-CHECK is still reported');
  assert.deepEqual(out.json.missing.filter(m => m.kind === 'ia-evaluated').map(m => [m.check, m.runs]), [['gamma-cover', 'COMP-COVERAGE']]);
  // The only runnable check loses its runner: the typo is all that is left to
  // run, so the capability refuses; the IA-evaluated check does not rescue it.
  delete declared.checks['gamma-gate'];
  writeFileSync(runners, JSON.stringify(declared));
  const none = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env()).json;
  assert.equal(none.error.code, 'IA-CORE-CHECK-UNAVAILABLE');
  assert.match(none.error.message, /gamma-gate, gamma-typo have no declared runner/);
  // A capability whose only runnerless checks are IA-evaluated resolves.
  runs('gamma-gate', 'COMP-COVERAGE');
  runs('gamma-typo', 'COMP-COVERAGE');
  writeFileSync(canned, JSON.stringify(cli));
  const evaluated = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env());
  assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);
  assert.deepEqual(evaluated.json.missing.filter(m => m.kind === 'check-unavailable'), []);
  assert.deepEqual(evaluated.json.missing.filter(m => m.kind === 'ia-evaluated').map(m => m.check), ['gamma-cover', 'gamma-gate', 'gamma-typo']);
});

// ------------------------------------------- whole-procedure packets (F2)

// A playbook whose phases are declared out of order, and whose plan phase
// declares its primitives in a non-canonical order.
const auditKit = (kitsDir, extra = {}) => makeKit(kitsDir, { folder: 'gamma', id: 'inventarch/gamma-kit', capability: 'gamma-audit', playbook: 'gamma-audit', checks: [], profile: 'gamma-auditor', phaseOrder: ['learn', 'orient', 'act', 'plan'], primitiveOrder: { plan: ['Learning', 'Attention', 'Inference', 'Decision'] }, ...extra });
const ORDERED = ['orient/Attention', 'orient/Inference', 'orient/Decision', 'orient/Learning', 'plan/Learning', 'plan/Attention', 'plan/Inference', 'plan/Decision', 'act/Attention', 'act/Inference', 'act/Decision', 'act/Learning', 'learn/Attention', 'learn/Inference', 'learn/Decision', 'learn/Learning'];

test('a whole capability delivers every cell of the bound playbook, read by identity, the phases in order and each in its declared order', t => {
  const { dir, kitsDir, env } = world(t);
  const gamma = auditKit(kitsDir, { delivery: ['gamma-audit'] });
  assert.deepEqual(WHOLE_PROCEDURE, {}, 'the core names no whole-procedure activity; kits declare their own');
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('work.completion', gamma.id, gamma.capability) });
  const out = resolve(['--entry', 'work', '--activity', 'completion', '--root', repo, '--json'], env());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const p = out.json;
  assert.deepEqual([p.scope.key.shape, p.scope.key.phase], ['learning', 'learn'], 'SCOPE_KEYS still states the key');
  assert.deepEqual(p.instructions.map(c => c.address.split('#')[1]), ORDERED);
  assert.deepEqual(p.instructions, gamma.playbookCells);
  for (const cell of p.instructions) {
    assert.equal(cell.source, 'playbook');
    assert.equal(cell.playbook, gamma.playbookId);
    assert.equal(cell.digest, sha256(cell.text));
  }
  assert.equal(p.missing.some(m => m.kind === 'instructions'), false);
  assert.equal(p.role.profile, gamma.profileId);
  // Bound to the lane's entry (work.*), the whole capability carries the four phases at every activity.
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify(bindings('work.*', gamma.id, gamma.capability)));
  const entry = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json;
  assert.deepEqual(entry.instructions.map(c => c.address.split('#')[1]), ORDERED, 'the lane entry is whole at any activity');
  // The same playbook from a kit that declares nothing whole gets the position's cell of that phase only.
  const theta = auditKit(kitsDir, { folder: 'theta', id: 'inventarch/theta-kit' });
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify(bindings('work.*', theta.id, theta.capability)));
  writeFileSync(join(repo, '.ia', 'distributions.lock.json'), JSON.stringify(installLock(bindings('work.*', theta.id, theta.capability))));
  const phase = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json;
  assert.deepEqual(phase.instructions, [{ playbook: theta.playbookId, address: `${theta.playbookId}#plan/Inference`, text: `${theta.id} 0.1.0: plan cell`, source: 'position' }]);
});

test('when the position delivers no cell of the bound playbook, its cells are read by identity, never another playbook\'s', t => {
  const { dir, kitsDir, env } = world(t);
  const delta = makeKit(kitsDir, { folder: 'delta', id: 'inventarch/delta-kit', capability: 'delta-task', playbook: 'delta-operate', checks: [], profile: null, positionPlaybook: 'other-operate' });
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('work.task', delta.id, delta.capability) });
  const p = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json;
  assert.deepEqual(p.instructions, delta.playbookCells);
  assert.equal(p.instructions.length, 16);
  assert.ok(p.instructions.every(c => c.playbook === delta.playbookId && c.source === 'playbook'));
  assert.ok(!p.instructions.some(c => c.playbook === delta.positionPlaybookId || /other-operate/.test(c.text)), 'another playbook\'s cells are never the procedure');
  assert.equal(p.missing.some(m => /delivered instead/.test(m.message)), false);
  // Cells that cannot be read are noted, and nothing stands in for them.
  const file = join(delta.dir, '.ia', 'fake-cli.json');
  const canned = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...canned, read: {} }));
  const unread = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env()).json;
  assert.equal(unread.error.code, 'IA-CORE-COMPOSITION-MISSING');
  assert.match(unread.error.message, /could not be read/);
});

test('the packet digest covers the delivered cells: the same procedure digests the same, a changed cell changes it', t => {
  const { dir, kitsDir, env } = world(t);
  const gamma = auditKit(kitsDir, { delivery: ['gamma-audit'] });
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('work.progress', gamma.id, gamma.capability) });
  const first = resolve(['--entry', 'work', '--activity', 'progress', '--root', repo], env()).json;
  assert.equal(resolve(['--entry', 'work', '--activity', 'progress', '--root', repo], env()).json.digest, first.digest);
  const file = join(gamma.dir, '.ia', 'fake-cli.json');
  const canned = JSON.parse(readFileSync(file, 'utf8'));
  const address = `${gamma.playbookId}#act/Inference`;
  canned.read[address] = { body: 'a changed act cell', digest: sha256('a changed act cell') };
  writeFileSync(file, JSON.stringify(canned));
  const changed = resolve(['--entry', 'work', '--activity', 'progress', '--root', repo], env()).json;
  assert.equal(changed.instructions.find(c => c.address === address).text, 'a changed act cell');
  assert.notEqual(changed.digest, first.digest);
});

// ------------------------------------- kit-declared delivery

test('a capability its kit declares whole delivers every cell even where the position delivers one of them; an undeclared one keeps the position\'s cells', t => {
  const { dir, kitsDir, env } = world(t);
  const whole = makeKit(kitsDir, { folder: 'epsilon', id: 'inventarch/epsilon-kit', capability: 'epsilon-migrate', playbook: 'epsilon-migrate', checks: [], profile: null, delivery: ['epsilon-migrate'] });
  const plain = makeKit(kitsDir, { folder: 'zeta', id: 'inventarch/zeta-kit', capability: 'zeta-place', playbook: 'zeta-place', checks: [], profile: null, delivery: ['zeta-other', 'zeta-place-typo'] });
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'knowledge.migrate': { kit: whole.id, capability: whole.capability }, 'knowledge.place': { kit: plain.id, capability: plain.capability } } } });
  // The stand-in position delivers each phase's primary cell of the bound playbook, so without the declaration the packet is one cell.
  const migrate = resolve(['--entry', 'knowledge', '--activity', 'migrate', '--root', repo, '--json'], env());
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  assert.deepEqual(migrate.json.instructions, whole.playbookCells);
  assert.equal(migrate.json.instructions.length, 16);
  assert.ok(migrate.json.instructions.every(c => c.source === 'playbook'));
  assert.equal(migrate.json.missing.some(m => m.kind === 'delivery'), false);
  // Every scope key gets the whole procedure: --shape and --phase override the key, not the delivery.
  const overridden = resolve(['--entry', 'knowledge', '--activity', 'migrate', '--root', repo, '--shape', 'execution', '--phase', 'act'], env()).json;
  assert.deepEqual(overridden.instructions, whole.playbookCells);
  const place = resolve(['--entry', 'knowledge', '--activity', 'place', '--root', repo], env()).json;
  // Placement is the Knowledge lane's plan cell (decision public-opal-per-lane).
  assert.deepEqual(place.instructions, [{ playbook: plain.playbookId, address: `${plain.playbookId}#plan/Inference`, text: `${plain.id} 0.1.0: plan cell`, source: 'position' }]);
  const noted = place.missing.find(m => m.kind === 'delivery');
  assert.ok(noted && /zeta-other, zeta-place-typo/.test(noted.message), 'a delivery.json name that is no capability is noted');
});

test('the role\'s mandate reaches references as when: role, and the closure; evidence.required holds the checks the capability composes, the runner every declared one', t => {
  const { dir, kitsDir, env, alpha } = world(t);
  const eta = makeKit(kitsDir, { folder: 'eta', id: 'inventarch/eta-kit', capability: 'eta-review', playbook: 'eta-review', checks: ['eta-gate'], runnerChecks: ['eta-online'], profile: 'eta-reviewer', profileMandate: 'eta-reviewer-mandate' });
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', eta.id, eta.capability) });
  const out = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo, '--json'], env());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const p = out.json;
  assert.equal(p.role.profile, eta.profileId);
  assert.deepEqual(p.references.filter(r => r.when === 'role'), [{ identity: eta.mandateId, digest: 'mandate-eta', when: 'role' }]);
  assert.ok(p.closure.records.includes(eta.mandateId));
  assert.deepEqual(p.evidence.required, ['eta-gate']);
  assert.deepEqual(p.effectiveOperations.runner, ['eta-gate', 'eta-online']);
  // A profile without a mandate adds no role reference; a missing mandate record is noted, not invented.
  const plain = makeRepo(join(dir, 'repo2'), { bindings: bindings('delivery.review', alpha.id, alpha.capability) });
  assert.equal(resolve(['--entry', 'delivery', '--activity', 'review', '--root', plain], env()).json.references.some(r => r.when === 'role'), false);
  const file = join(eta.dir, '.ia', 'fake-cli.json');
  const canned = JSON.parse(readFileSync(file, 'utf8'));
  delete canned.inspect[eta.mandateId];
  writeFileSync(file, JSON.stringify(canned));
  const unadmitted = resolve(['--entry', 'delivery', '--activity', 'review', '--root', repo], env()).json;
  assert.equal(unadmitted.error.code, 'IA-CORE-COMPOSITION-MISSING');
  assert.ok(unadmitted.error.message.includes(eta.mandateId));
});


test('legacy Development task pins require an explicit persisted Delivery rebind, retaining other keys and history', t => {
  const { dir, alpha, beta, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: bindings('delivery.review', beta.id, beta.capability) });
  for (const format of [1, 2]) {
    const taskRoot = join(dir, `legacy-${format}`);
    mkdirSync(taskRoot);
    const legacy = { format: 1, revision: 3, workspace: { root: repo, revision: 'old' }, task: 'legacy', intent: { entry: 'development', activity: 'review', subject: null }, kit: { id: alpha.id, version: '0.1.0', archive: alpha.archive, sources: 'old-sources' }, capability: alpha.capability, records: [], scopeKey: { shape: 'learning', phase: 'learn', seat: null, word: null }, createdAt: '2026-10-14T00:00:00.000Z', supersedes: 2 };
    const otherKey = { kit: alpha.id, capability: alpha.capability };
    const stored = format === 1 ? legacy : { format: 2, revision: 3, workspace: legacy.workspace, task: 'legacy', kits: { [alpha.id]: { version: '0.1.0', archive: alpha.archive, sources: 'old-sources' } }, keys: { 'development.review': otherKey, 'work.task': otherKey, 'development.design': otherKey } };
    const file = join(taskRoot, 'binding.json');
    const original = JSON.stringify(stored);
    writeFileSync(file, original);
    const args = ['--entry', 'delivery', '--activity', 'review', '--root', repo];
    for (const extra of [[], ['--no-pin'], ['--rebind', '--no-pin']]) {
      const refused = resolve([...args, ...extra], env(taskRoot));
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.equal(refused.json.error.code, 'IA-CORE-REBIND-REQUIRED');
      assert.match(refused.json.error.message, /development\.review.*--rebind/);
      assert.equal(readFileSync(file, 'utf8'), original, 'a refusal never rewrites the legacy pin');
    }
    const migrated = resolve([...args, '--rebind'], env(taskRoot));
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    assert.deepEqual([migrated.json.binding.revision, migrated.json.binding.supersedes, migrated.json.binding.rebound, migrated.json.closure.kit], [4, 3, true, beta.id]);
    const current = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(current.format, 3);
    assert.equal(Object.hasOwn(current.keys, 'development.review'), false);
    assert.equal(current.keys['delivery.review'].kit, beta.id);
    if (format === 2) {
      assert.deepEqual(current.keys['work.task'], otherKey);
      assert.deepEqual(current.keys['development.design'], otherKey);
    }
    assert.equal(readFileSync(join(taskRoot, 'binding.3.json'), 'utf8'), original, 'the prior pin remains immutable');
    const again = resolve(args, env(taskRoot));
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(again.json.binding.revision, 4, 'the migrated key resolves without another rebind');
  }
});

// Every entry under a folder with its content (a directory is a marker), so a rewritten file shows as well as a new one.
function snapshot(folder) {
  const rows = {};
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    rows[path.slice(folder.length)] = entry.isDirectory() ? '<directory>' : readFileSync(path).toString('hex');
  }
  return rows;
}

test('a workspace with no bindings refuses only the method it asks for, writes nothing, and reads on', t => {
  const { dir, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, 'temp'), { recursive: true });
  const before = { repo: snapshot(repo), home: snapshot(home), temp: snapshot(join(dir, 'temp')) };
  const out = resolve(['--entry', 'work', '--activity', 'task', '--root', repo], env(undefined, { IA_HOME: home }));
  assert.equal(out.status, 1);
  assert.equal(out.json.error.code, 'IA-CORE-NO-METHOD');
  assert.equal(out.json.error.key, 'work.task');
  assert.equal(out.json.error.message, 'no method is bound for work.task in this repository: .ia/bindings.json names no work.task, no work.*, and no defaults.work. List the kits with kit.mjs list and bind one with bind.mjs set work.task <kit> <capability>');
  assert.deepEqual(snapshot(repo), before.repo, 'the refusal changes nothing in the repository, content included');
  assert.deepEqual(snapshot(home), before.home, 'nor in the isolated IA home');
  assert.deepEqual(snapshot(join(dir, 'temp')), before.temp, 'nor in the temp folder, so no retained closure');
  const listed = run('kit.mjs', ['list'], env(undefined, { IA_HOME: home }), { cwd: repo });
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
});
