// on-write.mjs, the PostToolUse hook (decision private-core-on-write-hook):
// silent unless a carried kit's onwrite.json matches the written file by
// extension and marker; a match runs the kit's argv with the hook payload on
// stdin and hands back its additionalContext; output that is not a hook
// answer, a failing or slow check and a malformed sidecar are dropped; the
// whole answer stays within 8,000 characters; exit 0 always.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matches, MAX_CONTEXT } from '../scripts/on-write.mjs';
import { envFor, fakeCli, makeKit, recordSources, run, sandbox } from './helpers/fixtures.mjs';

// A check that answers as a hook would, naming the file from its stdin payload.
const ANSWER = `let raw = ''; process.stdin.on('data', d => raw += d).on('end', () => { const p = JSON.parse(raw); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: process.argv[2] + ' checked ' + p.tool_input.file_path } }) + '\\n'); });\n`;

function world(t) {
  const dir = sandbox(t, 'ia-core-onwrite-');
  const kitsDir = join(dir, 'kits');
  const cards = makeKit(kitsDir, { folder: 'cards', id: 'inventarch/cards-kit' });
  const other = makeKit(kitsDir, { folder: 'other', id: 'inventarch/other-kit' });
  makeKit(kitsDir, { folder: 'quiet', id: 'inventarch/quiet-kit' });
  for (const kit of [cards, other]) writeFileSync(join(kit.dir, 'answer.mjs'), ANSWER);
  writeFileSync(join(cards.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: [{ name: 'card', extensions: ['.md'], marker: 'design.index.md', maxDepth: 2, argv: ['${NODE}', '${KIT}/answer.mjs', 'cards'] }] }));
  writeFileSync(join(other.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: [{ name: 'any-md', extensions: ['.MD'], argv: ['${NODE}', '${KIT}/answer.mjs', 'other'] }] }));
  // onwrite.json is a sidecar the sources digest covers: record it, so both kits are trusted (lib/trust.mjs).
  for (const kit of [cards, other]) recordSources(kit.dir);
  const design = join(dir, 'repo', 'design');
  mkdirSync(join(design, 'systems', 'a'), { recursive: true });
  writeFileSync(join(design, 'design.index.md'), '# index\n');
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp') });
  const hook = (filePath, cwd = join(dir, 'repo'), extra = {}) => run('on-write.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: filePath }, ...extra }) });
  return { dir, kitsDir, cards, other, design, hook };
}

const context = out => (out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null);

test('a linked plugin root runs the hook while importing it stays silent', t => {
  const { dir, kitsDir } = world(t);
  const linked = join(dir, 'linked-plugin');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), linked, process.platform === 'win32' ? 'junction' : 'dir');
  const script = join(linked, 'scripts', 'on-write.mjs');
  const input = JSON.stringify({ cwd: join(dir, 'repo'), tool_input: { file_path: 'design/systems/a/system.md' } });
  const options = { input, encoding: 'utf8', env: envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp') }), timeout: 10000, windowsHide: true };
  const out = spawnSync(process.execPath, [script], options);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(context(out)?.additionalContext, 'cards checked design/systems/a/system.md\n\nother checked design/systems/a/system.md');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)});`], options);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '', 'importing the module must not consume the hook payload or run checks');
});

test('a card under a design marker runs every matching kit, in folder order, with the payload on stdin', t => {
  const { hook } = world(t);
  const out = hook('design/systems/a/system.md');
  assert.equal(out.status, 0, out.stderr);
  const answer = context(out);
  assert.equal(answer.hookEventName, 'PostToolUse');
  assert.equal(answer.additionalContext, 'cards checked design/systems/a/system.md\n\nother checked design/systems/a/system.md', 'the payload reached each check unchanged');
  assert.equal(out.stdout.trim().split('\n').length, 1);
});

test('no match is silent: another extension, a Markdown file outside the marker, past maxDepth, or no file path', t => {
  const { dir, design, hook } = world(t);
  assert.equal(hook('design/systems/a/notes.txt').stdout, '', 'no kit declares .txt');
  assert.equal(context(hook('README.md')).additionalContext, 'other checked README.md', 'outside the design only the marker-free entry runs');
  mkdirSync(join(design, 'one', 'two', 'three'), { recursive: true });
  assert.ok(!context(hook('design/one/two/three/deep.md')).additionalContext.includes('cards'), 'three folders below the marker is past maxDepth 2');
  assert.equal(hook(undefined).stdout, '');
  const garbage = run('on-write.mjs', [], envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: join(dir, 'temp') }), { input: 'not json' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('a check that fails, answers in plain text or cannot start is dropped; a malformed sidecar skips that kit only', t => {
  const { cards, other, hook } = world(t);
  writeFileSync(join(other.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: [{ name: 'plain', extensions: ['.md'], argv: ['${NODE}', '-e', "process.stdout.write('not a hook answer\\n')"] }, { name: 'gone', extensions: ['.md'], argv: ['no-such-binary-for-on-write'] }] }));
  recordSources(other.dir);
  assert.equal(context(hook('design/x.md')).additionalContext, 'cards checked design/x.md');
  writeFileSync(join(cards.dir, 'onwrite.json'), '{"format":1,"onWrite":[{"name":"Bad"}]}');
  recordSources(cards.dir);
  const out = hook('design/x.md');
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '', 'nothing else matched, so the hook stays silent');
});

test('the answer stays within 8,000 characters however much the checks say', t => {
  const { other, hook } = world(t);
  writeFileSync(join(other.dir, 'answer.mjs'), `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'x'.repeat(20000) } }) + '\\n'));\n`);
  const text = context(hook('README.md')).additionalContext;
  assert.ok(text.length <= MAX_CONTEXT, `${text.length}`);
  assert.ok(text.endsWith(' [truncated]'));
});

test('an entry with no marker that runs the core\'s own script matches a record under .ia/src in a workspace with no lock file, and only a .ia file', t => {
  const { dir, kitsDir } = world(t);
  const method = makeKit(kitsDir, { folder: 'method', id: 'inventarch/method-kit' });
  writeFileSync(join(method.dir, 'onwrite.json'), JSON.stringify({ format: 1, onWrite: [{ name: 'method-advise', extensions: ['.ia'], argv: ['${NODE}', '${PLUGIN}/scripts/method-advise.mjs'], timeout: 25 }] }));
  recordSources(method.dir);
  const records = join(dir, 'repo', '.ia', 'src', 'systems', 'x', 'records');
  mkdirSync(records, { recursive: true });
  const kit = { folder: 'method', dir: method.dir };
  assert.equal(matches(join(records, 'a.ia'), [kit]).length, 1);
  assert.equal(matches(join(records, 'a.IA'), [kit]).length, 1, 'extensions match without regard to case');
  assert.equal(matches(join(records, 'a.md'), [kit]).length, 0);
  assert.deepEqual(matches(join(records, 'a.ia'), [kit])[0].entry.argv, ['${NODE}', '${PLUGIN}/scripts/method-advise.mjs']);
});
