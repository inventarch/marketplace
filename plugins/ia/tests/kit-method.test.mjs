// The inventarch/ia-method-kit sources under config/kits/ia-method stay
// honest: every source is LF IA text, every case names a test that exists,
// every requirement has its cases, every playbook has its sixteen cells, every
// public record word has exactly one <word>-method capability (read and apply
// only for the governance words) and the taxonomy one capability, the
// bindings and the whole-procedure delivery name kit records, the release
// lists the records the sources hold, and the kit's README and the Work entry
// point name only records, files and keys that exist. None of this needs the
// IA CLI. With IA_CORE_TEST_CLI=<@inventarch/cli dist/main.js> the kit is also
// restored and validated in a scratch copy, the CLI's vocabulary is the one
// this file covers, its sources must repack to the recorded archive, and the
// resolver delivers the per-word and whole-procedure packets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adopt, DEFAULT_KITS_DIR, findKit, kitBindings, kitDelivery, KitError, packRelease, readDescriptor, readReleases, releaseRecords, sourcesDigest } from '../scripts/lib/kit.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { PHASES } from '../scripts/lib/workspace.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-method');
const KIT_ID = 'inventarch/ia-method-kit';
const VERSION = '0.8.0';
const SYSTEMS = join(KIT, '.ia', 'src', 'systems');
const README = join(KIT, 'README.md');
const WORK_SKILL = join(PLUGIN, 'skills', 'work', 'SKILL.md');
const PUBLIC_SYSTEMS = ['agent-composition-system', 'agent-system', 'authoring-system', 'compliance-system', 'governance-system', 'hook-authoring-system', 'learning-system', 'session-system', 'template-system', 'work-system', 'workspace-system'];
// The public IA vocabulary (docs/reference/language/vocabulary.json, 44 words):
// 30 record words and 14 taxonomy words. The opt-in CLI case checks the CLI
// ships exactly these.
const RECORD_WORDS = ['agent', 'agent-profile', 'authoring-guide', 'capability', 'case', 'check', 'contract', 'convention', 'decision', 'distribution', 'execution-binding', 'harness', 'hook', 'improvement', 'law', 'mandate', 'milestone', 'observation', 'operation', 'plan', 'playbook', 'principle', 'run', 'schema', 'spec', 'system', 'task', 'template', 'voice', 'workspace'];
const TAXONOMY = ['artifact-set', 'axis', 'cardinality', 'category', 'dimension', 'intent-shape', 'kind', 'lane', 'move', 'phase', 'placement', 'predicate', 'primitive', 'value-type'];
// Read and apply only: the cells apply the rule, and nothing here authors or enforces it.
const GOVERNANCE_WORDS = ['check', 'convention', 'law', 'mandate', 'principle'];
const PRIMITIVES = ['Attention', 'Inference', 'Decision', 'Learning'];

const walk = dir => readdirSync(dir).sort().flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const sources = () => walk(join(KIT, '.ia', 'src')).filter(f => f.endsWith('.ia'));
const text = (system, file) => readFileSync(join(SYSTEMS, system, 'records', file), 'utf8');
const kit = () => findKit(KIT_ID, DEFAULT_KITS_DIR);
const names = () => new Set(kitRecordNames(KIT).map(r => r.name));
const testTitles = () => readdirSync(join(PLUGIN, 'tests')).filter(f => f.endsWith('.test.mjs'))
  .flatMap(f => [...readFileSync(join(PLUGIN, 'tests', f), 'utf8').matchAll(/^test\('([^']+)'/gm)].map(m => `plugins/ia/tests/${f} :: ${m[1]}`));

// Records as `@word name` and their indented block.
function readKit() {
  const records = [];
  for (const file of sources()) {
    const rel = relative(join(KIT, '.ia', 'src'), file).replace(/\\/g, '/');
    let current;
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      const head = /^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
      if (head) records.push(current = { word: head[1], name: head[2], file: rel, line: index + 1, body: [] });
      else if (current && line.trim()) current.body.push(line);
    }
  }
  return records;
}

function field(record, section, name) {
  let inSection = false;
  for (const line of record.body) {
    const indent = line.length - line.trimStart().length;
    if (indent === 2) inSection = line.trim() === section;
    else if (inSection && indent === 4) {
      const m = new RegExp(`^${name}(?:\\s+(.*))?$`).exec(line.trim());
      if (m) return m[1] ?? '';
    }
  }
  return undefined;
}

const refsIn = record => record.body.flatMap(line => [...line.replace(/"[^"]*"/g, '""').matchAll(/@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/g)].map(m => ({ word: m[1], name: m[2] })));

// The cells of a playbook as its record declares them, in PHASES order.
function declaredCells(name) {
  const body = readKit().find(r => r.word === 'playbook' && r.name === name).body;
  const cells = [];
  let phase;
  for (const line of body) {
    const head = /^    (orient|plan|act|learn)$/.exec(line);
    if (head) { phase = head[1]; continue; }
    const cell = /^      (Attention|Inference|Decision|Learning) means "(.*)"$/.exec(line);
    if (cell && phase) cells.push({ phase, primitive: cell[1], text: cell[2] });
  }
  const identity = `governance-system/definition/procedure/${name}`;
  return PHASES.flatMap(p => cells.filter(c => c.phase === p)).map(c => ({ address: `${identity}#${c.phase}/${c.primitive}`, text: c.text }));
}

// Kit record names a document gives: backticked method-* and <word>-method
// names, and full identities whose last segment is a record name.
function namedRecords(body) {
  const named = [...body.matchAll(/`((?:method-[a-z-]*[a-z])|(?:[a-z-]+-method))`/g)].map(m => m[1]).filter(n => !n.startsWith('<'));
  const identities = [...body.matchAll(/(?:governance-system\/governance\/(?:principle|law|convention)|governance-system\/definition\/procedure|agent-composition-system\/definition\/capability)\/([a-z0-9-]*[a-z0-9])(?![a-z0-9<-])/g)].map(m => m[1]);
  return [...new Set([...named, ...identities])];
}

function pluginPathProblems(file) {
  const body = readFileSync(file, 'utf8');
  return [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+[\w])/g)].map(m => m[1]).filter(p => !existsSync(join(PLUGIN, p))).map(p => `${relative(PLUGIN, file)} names ${p}, which does not exist`);
}

// ------------------------------------------------------------------ tests

test('every kit source is an LF IA 1.0 file, the kit text carries no CR and no machine path, and the kit folder holds only its sidecars', () => {
  for (const file of sources()) {
    const body = readFileSync(file, 'utf8');
    assert.ok(body.startsWith('#! ia 1.0\n'), `${file} does not open with #! ia 1.0`);
    assert.ok(body.endsWith('\n') && !body.endsWith('\n\n'), `${file} ends with one newline`);
    assert.doesNotMatch(body, /[ \t]$/m, `${file} has trailing whitespace`);
  }
  for (const file of walk(KIT).filter(f => /\.(?:ia|json|md)$/.test(f))) {
    const body = readFileSync(file, 'utf8');
    assert.ok(!body.includes('\r'), `${file} has CR bytes`);
    assert.doesNotMatch(body, /[A-Za-z]:\\Users\\|\/Users\/[a-z]+\/|\/home\/[a-z]+\//, `${file} carries a machine path`);
  }
  assert.deepEqual(readdirSync(KIT).sort(), ['.ia', 'README.md', 'bindings.json', 'delivery.json', 'releases', 'releases.json'], 'the kit carries no assets and no checks.json: its bindings, its delivery and its releases');
  assert.deepEqual(readdirSync(SYSTEMS), ['ia-method'], 'one system');
});

test('the descriptor is the public 0.8.0 release of one system, and the distribution ships that system', () => {
  const descriptor = readDescriptor(KIT);
  assert.equal(descriptor.id, KIT_ID);
  assert.equal(descriptor.version, VERSION);
  assert.equal(descriptor.license, 'Apache-2.0');
  assert.equal(descriptor.source.repository, 'https://github.com/inventarch/marketplace.git');
  assert.equal(descriptor.distribution, 'workspace-system/definition/distribution/ia-method-distribution');
  assert.deepEqual(descriptor.assets, [{ path: 'bindings.json', role: 'asset' }, { path: 'delivery.json', role: 'asset' }]);
  assert.deepEqual(descriptor.dependencies.map(d => [d.id, d.range]), [['inventarch/language', '^3.2.0']]);
  assert.deepEqual([...descriptor.dependencies[0].systems].sort(), PUBLIC_SYSTEMS);
  const lock = JSON.parse(readFileSync(join(KIT, '.ia', 'distributions.lock.json'), 'utf8'));
  assert.deepEqual(lock.requests, [{ id: 'inventarch/language', range: '^3.2.0' }]);
  assert.match(text('ia-method', 'distribution.ia'), /^ {4}records \[@system ia-method\]$/m);
  const system = readFileSync(join(SYSTEMS, 'ia-method', 'system.ia'), 'utf8');
  for (const s of PUBLIC_SYSTEMS) assert.match(system, new RegExp(`^ {4}- ${s}$`, 'm'), `ia-method requires ${s}`);
  const workspace = readFileSync(join(KIT, '.ia', 'src', 'workspace.ia'), 'utf8');
  assert.match(workspace, /^@workspace ia-method-kit$/m);
  assert.match(workspace, /systems \[[^\]]*@system ia-method\]/);
  assert.match(system, /steward @agent ia-method-steward/);
});

// Written from the requirements (README "What the kit holds" and "Activation"),
// not read from the records: a changed rule, severity or activation line fails here.
test('the governance rules are exactly these, with these severities and activation lines', () => {
  const expected = {
    'principle method-capability-is-the-unit': ['advisory', ['phase is orient', 'phase is plan']],
    'principle method-locate-before-inventing': ['advisory', ['phase is orient', 'phase is plan']],
    'principle method-same-pattern-every-layer': ['advisory', ['phase is plan']],
    'principle method-levels-of-knowledge': ['advisory', ['phase is orient', 'phase is learn']],
    'principle method-claims-within-evidence': ['blocking', []],
    'principle method-lineage-accountable': ['advisory', ['move is Synthesis']],
    'principle method-ask-while-continuing': ['advisory', ['primitive is Decision', 'primitive is Escalation']],
    'principle method-one-account': ['advisory', ['move is Synthesis']],
    'law method-provisional-foundation-ceiling': ['blocking', []],
    'convention method-capture-before-delivery': ['advisory', ['phase is plan']],
    'convention method-handoff-packet': ['advisory', ['phase is learn']],
    'convention method-reconcile-on-change': ['advisory', ['phase is learn']],
    'convention method-improvement-lifecycle': ['advisory', ['phase is learn']],
  };
  const actual = {};
  for (const r of readKit().filter(r => ['principle', 'law', 'convention'].includes(r.word))) {
    const lines = r.body.map(l => /^ {4}activate when (.+)$/.exec(l)?.[1]).filter(Boolean);
    actual[`${r.word} ${r.name}`] = [field(r, 'governance', 'severity'), lines];
  }
  assert.deepEqual(actual, expected);
});

test('every case evaluator names a test that exists in the core', () => {
  const titles = new Set(testTitles());
  const evaluators = [...text('ia-method', 'compliance.ia').matchAll(/evaluator "([^"]+)"/g)].map(m => m[1]);
  assert.ok(evaluators.length >= 2);
  for (const evaluator of evaluators) {
    assert.match(evaluator, /^plugins\/ia\/tests\/ceiling\.test\.mjs :: /);
    assert.ok(titles.has(evaluator), `no test named by ${evaluator}`);
  }
});

test('every contract requirement has a success and a failure case, and every blocking law is governed by the contract', () => {
  const compliance = text('ia-method', 'compliance.ia');
  const requirements = [...compliance.matchAll(/^ {4}(REQ-METHOD-\d+) "/gm)].map(m => m[1]);
  assert.ok(requirements.length >= 1);
  for (const req of requirements) {
    const kinds = [...compliance.matchAll(new RegExp(`kind (\\w+)[\\s\\S]*?implements @contract ia-method#${req}\\b`, 'g'))].map(m => m[1]);
    assert.ok(kinds.includes('success') && kinds.includes('failure'), `${req} cases: ${kinds}`);
  }
  const laws = [...text('ia-method', 'laws.ia').matchAll(/^@law ([a-z0-9-]+)\n[\s\S]*?severity (\w+)/gm)];
  assert.ok(laws.some(([, law]) => law === 'method-provisional-foundation-ceiling'), 'the ceiling law stays public');
  for (const [, law, severity] of laws) {
    if (severity === 'blocking') assert.match(compliance, new RegExp(`governs @law ${law}\\n`), `blocking law ${law} is not governed by the contract`);
  }
});

test('every playbook has the four phases with their four primitive cells', () => {
  const playbooks = readKit().filter(r => r.word === 'playbook');
  const expected = ['method-operate', 'method-provisional-foundation', 'method-vocabulary', ...RECORD_WORDS.map(w => `${w}-method`)].sort();
  assert.deepEqual(playbooks.map(p => p.name).sort(), expected);
  for (const playbook of playbooks) {
    const body = playbook.body.join('\n') + '\n';
    for (const phase of PHASES) {
      const block = new RegExp(`^    ${phase}\\n((?:      .*\\n?)+)`, 'm').exec(body);
      assert.ok(block, `${playbook.name}: phase ${phase}`);
      for (const primitive of PRIMITIVES) assert.match(block[1], new RegExp(`^      ${primitive} means "[^"]+"$`, 'm'), `${playbook.name}: ${phase} ${primitive}`);
      assert.match(block[1], /^      primary (?:Attention|Inference|Decision|Learning)$/m, `${playbook.name}: ${phase} primary`);
    }
    assert.equal(declaredCells(playbook.name).length, 16, `${playbook.name}: sixteen cells`);
  }
});

test('every public record word is covered by exactly one <word>-method capability, whose playbook is about that word', () => {
  const records = readKit();
  const get = (word, name) => records.find(r => r.word === word && r.name === name);
  const subjectOf = name => field(get('playbook', name), 'subject', 'subject-word');
  const capabilities = records.filter(r => r.word === 'capability');
  for (const word of RECORD_WORDS) {
    const name = `${word}-method`;
    const capability = get('capability', name);
    assert.ok(capability, `no capability ${name}`);
    assert.equal(field(capability, 'composition', 'playbooks'), `[@playbook ${name}]`, `${name} composes its own playbook`);
    assert.equal(subjectOf(name), word, `playbook ${name} is about ${word}`);
    assert.equal(field(capability, 'execution', 'effects'), GOVERNANCE_WORDS.includes(word) ? '[read]' : '[read, local-write]', `${name} effects`);
    const covering = capabilities.filter(c => c.name.endsWith('-method') && c.name !== 'method-vocabulary' && subjectOf(/\[@playbook ([a-z0-9-]+)\]/.exec(field(c, 'composition', 'playbooks'))[1]) === word);
    assert.deepEqual(covering.map(c => c.name), [name], `${word} is covered once`);
    const cells = declaredCells(name);
    const all = cells.map(c => c.text).join('\n');
    assert.match(cells[0].text, new RegExp(`ia position --word ${word}\\b`), `${name} orients through ia position --word`);
    assert.match(all, new RegExp(`ia vocabulary ${word} --schema`), `${name} reads the word's schema`);
    if (GOVERNANCE_WORDS.includes(word)) {
      assert.match(all, /reads and applies .* records only/, `${name} is read and apply only`);
      assert.match(all, /enforcement \(gates, recorded evidence, verifiers\) is not part of this public kit/, `${name} leaves enforcement out`);
      assert.doesNotMatch(all, /ia author /, `${name} authors nothing`);
    } else if (!['schema', 'system', 'workspace', 'distribution'].includes(word)) {
      assert.match(all, new RegExp(`ia preview ${word} <name>[^"]*then ia author with the same form and the digest preview returned, then ia validate`), `${name} changes records through preview, author and validate`);
    }
  }
  for (const word of ['schema', 'system', 'workspace', 'distribution']) {
    assert.match(declaredCells(`${word}-method`).map(c => c.text).join('\n'), /lies outside this kit \(by hand from the public IA documentation, or with an InventArch subscription\)/, `${word}-method authors no new ${word}`);
  }
  const owners = { schema: 'floor', system: 'floor' };
  for (const word of RECORD_WORDS.filter(w => !owners[w])) assert.match(declaredCells(`${word}-method`)[2].text, /re-seat with ia position --seat floor\/definition\/system\/[a-z-]+-system /, `${word}-method re-seats at the owning system`);
});

test('one capability reads the fourteen taxonomy words through ia vocabulary and ia position --word', () => {
  const records = readKit();
  const capability = records.find(r => r.word === 'capability' && r.name === 'method-vocabulary');
  const playbook = records.find(r => r.word === 'playbook' && r.name === 'method-vocabulary');
  assert.equal(field(capability, 'composition', 'playbooks'), '[@playbook method-vocabulary]');
  assert.equal(field(capability, 'execution', 'effects'), '[read]');
  assert.ok(TAXONOMY.includes(field(playbook, 'subject', 'subject-word')));
  const all = declaredCells('method-vocabulary').map(c => c.text).join('\n');
  for (const word of TAXONOMY) assert.match(all, new RegExp(`\\b${word}\\b`), `method-vocabulary names ${word}`);
  assert.match(all, /ia vocabulary <word> --schema/);
  assert.match(all, /ia position --word <word>/);
  assert.match(all, /Mint no words/);
  // No capability per taxonomy word.
  for (const word of TAXONOMY) assert.ok(!records.some(r => r.name === `${word}-method`), `${word} has no capability of its own`);
});

test('every reference in a record resolves to a declared record or a public system, and no record is declared twice', () => {
  const records = readKit();
  const declared = new Set(records.map(r => `${r.word}/${r.name}`));
  for (const s of PUBLIC_SYSTEMS) declared.add(`system/${s}`);
  const unresolved = [];
  for (const record of records) for (const ref of refsIn(record)) {
    if (!['capability', 'playbook', 'check', 'contract', 'agent', 'agent-profile', 'mandate', 'law', 'system', 'distribution', 'case', 'workspace'].includes(ref.word)) continue;
    if (ref.word === 'workspace' && record.word !== 'mandate') continue;
    if (!declared.has(`${ref.word}/${ref.name}`)) unresolved.push(`${record.file}:${record.line} ${record.word} ${record.name} -> @${ref.word}/${ref.name}`);
  }
  assert.deepEqual(unresolved, []);
  const duplicates = records.map(r => `${r.word}/${r.name}`).filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepEqual(duplicates, []);
  // The steward applies every word its system holds.
  const system = readFileSync(join(SYSTEMS, 'ia-method', 'system.ia'), 'utf8');
  for (const word of new Set(records.filter(r => r.file.startsWith('systems/ia-method/') && !['system', 'workspace', 'mandate'].includes(r.word)).map(r => r.word))) {
    assert.match(system, new RegExp(`applies \\[[^\\]]*\\b${word}\\b`), `ia-method-steward applies ${word}`);
  }
});

test('the recommended bindings and the whole-procedure delivery name kit records only', () => {
  const bindings = kitBindings(kit());
  assert.deepEqual(bindings.undeclared, []);
  assert.equal(bindings.unbound, null);
  const expected = { 'work.*': 'method-operate', 'knowledge.vocabulary': 'method-vocabulary', ...Object.fromEntries(RECORD_WORDS.map(w => [`work.${w}`, `${w}-method`])) };
  assert.deepEqual(Object.keys(bindings.recommend).sort(), Object.keys(expected).sort());
  for (const [key, capability] of Object.entries(expected)) assert.deepEqual(bindings.recommend[key], { kit: KIT_ID, capability }, key);
  const delivery = kitDelivery(kit());
  assert.deepEqual(delivery, { whole: ['method-operate'], undeclared: [] });
  // The entry capability is whole: every playbook it composes has all four phases.
  const operate = readKit().find(r => r.word === 'capability' && r.name === 'method-operate');
  assert.equal(field(operate, 'composition', 'playbooks'), '[@playbook method-operate, @playbook method-provisional-foundation]');
  for (const name of ['method-operate', 'method-provisional-foundation']) assert.deepEqual([...new Set(declaredCells(name).map(c => c.address.split('#')[1].split('/')[0]))], PHASES);
});

test('the recorded release is 0.8.0 and lists the source records, with the sources digest and the CLI it was packed with (fails until the release is recorded)', () => {
  const { kit: id, releases } = readReleases(KIT);
  const latest = releases.at(-1);
  assert.equal(id, KIT_ID);
  assert.equal(latest.version, VERSION, 'record the 0.8.0 release');
  assert.equal(readDescriptor(KIT).version, latest.version);
  assert.deepEqual(releaseRecords(KIT, latest), kitRecordNames(KIT));
  assert.equal(latest.sources, sourcesDigest(KIT), 'the kit sources changed since the recorded release: bump the version in .ia/release.json and record the release');
  assert.match(latest.archive, /^[a-f0-9]{64}$/);
  assert.match(latest.cli, /^@inventarch\/cli \d+\.\d+\.\d+$/);
  assert.equal(latest.language, 'inventarch/language ^3.2.0');
  assert.equal(kit().latest.archive, latest.archive, 'the core finds the kit by id');
  assert.equal(findKit('ia-method', DEFAULT_KITS_DIR).id, KIT_ID, 'and by folder');
});

// Generic patterns only, so the test names nothing private: private decision
// ids, other kits and repositories, foundation records other than the public
// ceiling, governed-run machinery, closed licences and pull request numbers.
test('the kit carries no private content', () => {
  const deny = /private-|\bia-method-(?!kit\b|steward\b|distribution\b|coverage\b)|\b(?!ia-method-kit\b)ia-[a-z]+(?:-[a-z]+)*-kit\b|inventarch\/(?!ia-method-kit\b|language\b|cli\b|marketplace\.git\b|tests\/)|inventarch-[a-z]|(?<!provisional-)foundation-[a-z]|opal-|\bledger|Proprietary|UNLICENSED|PR #\d+/i;
  for (const file of walk(KIT).filter(f => !relative(KIT, f).startsWith('releases'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) assert.doesNotMatch(line, deny, `${relative(KIT, file)}:${i + 1}`);
  }
});

test('the kit README names only records, files and keys that exist', () => {
  const body = readFileSync(README, 'utf8');
  const known = names();
  for (const name of namedRecords(body)) assert.ok(known.has(name), `the README names ${name}, which is not a kit record`);
  assert.deepEqual(pluginPathProblems(README), []);
  for (const m of body.matchAll(/scripts\/kit\.mjs" (root|status|adopt)( [^\s`]+)?/g)) assert.equal(m[2], ' ia-method', `kit.mjs ${m[1]} names the kit: ${m[0]}`);
  for (const m of body.matchAll(/scripts\/bind\.mjs" recommend ([^\s`]+)/g)) assert.equal(m[1], KIT_ID);
  const cell = c => c.trim().replace(/^`|`$/g, '');
  const rows = body.split('\n').filter(l => /^\| `(?:work|knowledge|delivery)\./.test(l)).map(l => l.split('|').slice(1, -1).map(cell));
  assert.deepEqual(rows.map(r => r[0]), ['work.*', 'work.<word>`, for each of the 30 record words', 'knowledge.vocabulary']);
  assert.match(body, /Apache-2\.0/);
  assert.match(body, /available with an InventArch subscription/);
  assert.doesNotMatch(body, /\]\((?!https:)/, 'the README links nothing (the kit installs inside the core)');
  // The ceiling stays documented, with the report's exit codes.
  assert.match(body, /fails closed \(unknown, exit 2\)/);
  assert.match(body, /exit 1 means beyond the ceiling/);
});

test('the kit README runs no ia on PATH, no unpinned CLI through npx, and no shell (the core\'s shipped-file patterns)', () => {
  const body = readFileSync(README, 'utf8');
  assert.doesNotMatch(body, /npx\s+(?:--no\s+)?ia\b/, 'runs ia through npx');
  assert.doesNotMatch(body, /(?:npx|npm install)[^\n]*@inventarch\/cli(?!@(?:\d+\.\d+\.\d+|\$\{PINNED\}|<version>))/, 'installs or runs @inventarch/cli without an exact version');
  assert.doesNotMatch(body, /(?:spawn|exec)\w*\(\s*'ia'/, 'runs an ia on PATH');
});

test('the Work entry point names only method records of this kit that exist, and plugin files that exist', () => {
  const body = readFileSync(WORK_SKILL, 'utf8');
  const known = names();
  for (const name of [...body.matchAll(/`(method-[a-z-]*[a-z])`/g)].map(m => m[1])) assert.ok(known.has(name), `the work skill names ${name}, which is not a kit record`);
  assert.deepEqual(pluginPathProblems(WORK_SKILL), []);
  assert.doesNotMatch(body, /inventarch-method\b/, 'no method plugin');
});

test('sourcesDigest ignores CRLF line endings and sees a content change', () => {
  const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-method-crlf-')));
  try {
    cpSync(join(KIT, '.ia'), join(copy, '.ia'), { recursive: true });
    for (const sidecar of ['bindings.json', 'delivery.json']) cpSync(join(KIT, sidecar), join(copy, sidecar));
    const file = join(copy, '.ia', 'src', 'workspace.ia');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(sourcesDigest(copy), sourcesDigest(KIT));
    writeFileSync(file, readFileSync(file, 'utf8') + '\n');
    assert.notEqual(sourcesDigest(copy), sourcesDigest(KIT));
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test('adopt refuses a folder that is not an IA workspace, and packRelease refuses another CLI version', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-method-adopt-')));
  try {
    assert.throws(() => adopt(dir, kit(), { cli: { argv: [process.execPath, 'none'], version: '3.1.1' } }), e => e instanceof KitError && /not an IA workspace/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => packRelease(kit(), kit().latest, { argv: [process.execPath, 'none'], version: '9.9.9' }), e => e instanceof KitError && /would not reproduce/.test(e.message));
});

// -------------------------------------------------------- opt-in: the CLI

const CLI = process.env.IA_CORE_TEST_CLI;
const SKIP = !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js';

test('real CLI: the kit restores and admits with no errors in a scratch copy (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-method-kit-')));
  const ia = args => {
    const ran = spawnSync(process.execPath, [CLI, ...args, '--root', dir, '--json'], { cwd: dir, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    let json;
    try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
    return { stdout: ran.stdout, stderr: ran.stderr, json };
  };
  try {
    cpSync(join(KIT, '.ia'), join(dir, '.ia'), { recursive: true });
    const restored = ia(['restore', '--apply', '--yes']);
    assert.equal(restored.json?.applied?.status, 'installed', restored.stdout.slice(0, 2000) || restored.stderr);
    const validated = ia(['validate']);
    assert.equal(validated.json?.status, 'admitted', validated.stdout.slice(0, 2000) || validated.stderr);
    assert.equal(validated.json.counts.errors, 0, JSON.stringify(validated.json.findings?.filter(f => f.severity === 'error')?.slice(0, 5)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real CLI: the CLI\'s public vocabulary is the 30 record words and 14 taxonomy words this kit covers (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, () => {
  const ran = spawnSync(process.execPath, [CLI, 'vocabulary', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const words = JSON.parse(ran.stdout).words;
  assert.deepEqual(words.map(w => w.word).sort(), [...RECORD_WORDS, ...TAXONOMY].sort());
  assert.deepEqual(words.filter(w => w.owner === 'taxonomy').map(w => w.word).sort(), TAXONOMY);
});

test('real CLI: the sources repack to the recorded release (opt-in: IA_CORE_TEST_CLI; fails until the release is recorded)', { skip: SKIP }, async () => {
  const { resolveCli } = await import('../scripts/lib/cli.mjs');
  const cli = resolveCli(KIT, { env: { IA_CLI_PATH: CLI } });
  assert.equal(kit().latest.version, VERSION, 'record the 0.8.0 release');
  const built = packRelease(kit(), kit().latest, cli);
  built.cleanup();
});

test('real CLI: with the recommended bindings, an uninstalled kit is refused, then a word activity, any other Work activity and the vocabulary resolve once it is installed (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, async () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-method-resolve-')));
  const repo = join(base, 'repo');
  const temp = join(base, 'temp');
  mkdirSync(temp);
  try {
    const env = { ...process.env, IA_CLI_PATH: CLI, TMPDIR: temp, TEMP: temp, TMP: temp, IA_CORE_CLOSURES_DIR: join(temp, 'closures') };
    for (const k of ['IA_CORE_KITS_DIR', 'IA_CORE_RUN_ROOT', 'IA_METHOD_CLI']) delete env[k];
    const init = spawnSync(process.execPath, [CLI, 'init', repo, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const core = (script, args) => spawnSync(process.execPath, [join(PLUGIN, 'scripts', script), ...args], { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, windowsHide: true });
    const bound = core('bind.mjs', ['recommend', KIT_ID, repo, '--apply']);
    assert.equal(bound.status, 0, bound.stdout + bound.stderr);
    assert.equal(JSON.parse(bound.stdout).added.length, RECORD_WORDS.length + 2);
    const resolve = (entry, activity) => {
      const ran = core('resolve.mjs', ['--entry', entry, '--activity', activity, '--root', repo, '--json']);
      assert.equal(ran.status, 0, ran.stdout.slice(0, 2000) + ran.stderr);
      return JSON.parse(ran.stdout);
    };
    const cellsOf = packet => packet.instructions.map(c => c.address.split('#')[0]);
    // The lock does not install the kit yet: the resolver refuses and names the kit.
    const refused = core('resolve.mjs', ['--entry', 'work', '--activity', 'milestone', '--root', repo, '--json']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const refusal = JSON.parse(refused.stdout).error;
    assert.equal(refusal.code, 'IA-CORE-KIT-NOT-INSTALLED');
    assert.equal(refusal.kit, KIT_ID);
    // Installed (the vendored route), the same bindings resolve.
    const { resolveCli } = await import('../scripts/lib/cli.mjs');
    assert.ok(adopt(repo, kit(), { cli: resolveCli(repo, { env: { IA_CLI_PATH: CLI } }) }).written.length > 0);
    // A word activity: the word's own playbook, never method-operate.
    const milestone = resolve('work', 'milestone');
    assert.equal(milestone.envelope.kitInstalled, true, 'read from the installed kit');
    assert.ok(milestone.instructions.length > 0);
    assert.deepEqual([...new Set(cellsOf(milestone))], ['governance-system/definition/procedure/milestone-method']);
    // Any other Work activity: method-operate, whole, every cell of both playbooks in phase order.
    const progress = resolve('work', 'progress');
    assert.equal(progress.instructions.length, 32, 'all sixteen cells of each playbook method-operate composes');
    for (const cell of progress.instructions) assert.equal(cell.source, 'playbook');
    for (const name of ['method-operate', 'method-provisional-foundation']) {
      assert.deepEqual(progress.instructions.filter(c => c.address.startsWith(`governance-system/definition/procedure/${name}#`)).map(c => ({ address: c.address, text: c.text })), declaredCells(name), `${name}: every cell, in phase order`);
    }
    // The vocabulary.
    const vocabulary = resolve('knowledge', 'vocabulary');
    assert.deepEqual([...new Set(cellsOf(vocabulary))], ['governance-system/definition/procedure/method-vocabulary']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
