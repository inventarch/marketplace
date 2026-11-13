// Tests for the inventarch/ia-authoring-kit under config/kits/ia-authoring, its
// main system and its three parts (record, host and catalogue authoring): the
// records parse with the expected words, every reference resolves, every
// playbook has its four phases, every check carries one fixed command that
// checks.json runs, delivery.json and bindings.json name only the kit's
// capabilities, every listed asset exists and every carried file is listed,
// the recorded release names these sources and their digest, every contract
// requirement has a success and a failure case naming a test that exists, and
// the catalogue conventions still restate what the catalogue's validator
// carries. None of this needs the IA CLI. With IA_CORE_TEST_CLI=<path to
// @inventarch/cli dist/main.js> the kit is also restored and validated in a
// scratch copy, and its capabilities resolved outside a workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandReleases, findKit, kitBindings, kitDelivery, sourcesDigest } from '../scripts/lib/kit.mjs';

const KIT = fileURLToPath(new URL('../config/kits/ia-authoring/', import.meta.url));
const TESTS = fileURLToPath(new URL('./', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const RESOLVE = fileURLToPath(new URL('../scripts/resolve.mjs', import.meta.url));
const KIT_ID = 'inventarch/ia-authoring-kit';
const MAIN = 'ia-authoring';
const SYSTEMS = ['ia-authoring', 'ia-authoring-catalogue', 'ia-authoring-host', 'ia-authoring-record'];
const PUBLIC_SYSTEMS = ['agent-composition-system', 'agent-system', 'authoring-system', 'compliance-system', 'governance-system', 'hook-authoring-system', 'learning-system', 'session-system', 'template-system', 'work-system', 'workspace-system'];
const EVALUATORS = ['COMP-PARSE', 'COMP-SCHEMA', 'COMP-SYSTEM', 'COMP-SCHEMA-ENROLLED', 'COMP-CONSENT-DECLARED', 'COMP-CONSENT', 'COMP-IDENTITY', 'COMP-SELECTOR', 'COMP-VARIANT', 'COMP-COVERAGE', 'COMP-FRAGMENT', 'COMP-ADOPTION', 'COMP-KERNEL', 'COMP-FIXTURES', 'COMP-STEWARD', 'COMP-BOOTSTRAP', 'COMP-CHECK'];

// ---------------------------------------------------------------- parsing

function walk(dir) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = root => walk(join(root, '.ia', 'src')).filter(p => p.endsWith('.ia'));

// A record is `@word name` at column 0 followed by its indented block.
export function parseRecords(text, file = '') {
  const records = [];
  let current;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    const head = /^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
    if (head) {
      current = { word: head[1], name: head[2], file, system: /^systems\/([^/]+)\//.exec(file)?.[1] ?? null, line: index + 1, body: [] };
      records.push(current);
    } else if (current && line.trim()) {
      assert.match(line, /^\s/, `${file}:${index + 1}: a non-record line must be indented`);
      current.body.push(line);
    }
  }
  return records;
}

export function readKit(root = KIT) {
  const records = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(join(root, '.ia', 'src'), file).replace(/\\/g, '/');
    assert.equal(text.split('\n')[0], '#! ia 1.0', `${rel} must start with the grammar header`);
    records.push(...parseRecords(text, rel));
  }
  return records;
}

// The value of `<section>\n    <field> ...` inside a record body, or undefined.
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

const unquote = s => (s && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
const refList = s => [...(s ?? '').matchAll(/@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/g)].map(m => m[2]);

// Structural references only: an `@word name` outside quoted text.
function refsIn(record) {
  const refs = [];
  for (const line of record.body) for (const m of line.replace(/"[^"]*"/g, '""').matchAll(/@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/g)) refs.push({ word: m[1], name: m[2] });
  return refs;
}

// The (system, word, name) triples the pack tool records: system folders only.
export function recordTriples(root = KIT) {
  const systems = join(root, '.ia', 'src', 'systems');
  const names = [];
  for (const system of readdirSync(systems).sort()) {
    const dir = join(systems, system);
    const files = [join(dir, 'system.ia'), ...readdirSync(join(dir, 'records')).filter(f => f.endsWith('.ia')).sort().map(f => join(dir, 'records', f))];
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(/^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/gm)) names.push({ system, word: m[1], name: m[2] });
  }
  const key = r => `${r.system}/${r.word}/${r.name}`;
  return names.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

// ------------------------------------------------------------- the checks
// Each returns the list of problems, so a failure case can assert on them.

const COVERAGE = 'ia-authoring-record-coverage';

export function checkProblems(records) {
  const problems = [];
  for (const check of records.filter(r => r.word === 'check')) {
    const runs = field(check, 'check', 'runs');
    const scope = unquote(field(check, 'check', 'scope'));
    if (!runs || !EVALUATORS.includes(runs)) problems.push(`${check.name}: runs must name a built-in evaluator, got ${runs ?? 'nothing'}`);
    if (check.name === COVERAGE) { if (runs !== 'COMP-COVERAGE') problems.push(`${check.name}: the coverage check must run COMP-COVERAGE`); continue; }
    if (runs !== 'COMP-CHECK') problems.push(`${check.name}: a check must run COMP-CHECK`);
    if (!scope || !scope.trim() || !/^[a-z]/i.test(scope.trim())) problems.push(`${check.name}: a check must carry exactly one fixed command in check.scope`);
  }
  return problems;
}

// The runner's placeholders written as the records write them.
const spelled = argv => argv.map(a => a.replaceAll('${IA}', 'ia').replaceAll('${NODE}', 'node').replaceAll('${KIT}', '<kit>').replaceAll('${WORKSPACE}', '<workspace>')).join(' ');

// Every requirement of every contract has a success case and a failure case.
export function coverageProblems(records) {
  const problems = [];
  for (const contract of records.filter(r => r.word === 'contract')) {
    const requirements = [...contract.body.join('\n').matchAll(/^\s+(REQ-[A-Z]+-\d+) "/gm)].map(m => m[1]);
    for (const requirement of requirements) for (const kind of ['success', 'failure']) {
      const covered = records.some(r => r.word === 'case' && field(r, 'scenario', 'kind') === kind && r.body.some(l => l.trim() === `implements @contract ${contract.name}#${requirement}`));
      if (!covered) problems.push(`${requirement}: no ${kind} case`);
    }
  }
  return problems;
}

export function assetProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const problems = [];
  for (const asset of descriptor.assets) {
    const expected = asset.path.endsWith('.md') ? 'documentation' : 'asset';
    if (asset.role !== expected) problems.push(`${asset.path}: role must be ${expected}`);
    if (!existsSync(join(root, asset.path))) problems.push(`${asset.path}: missing`);
  }
  for (const dir of ['assets', 'scripts']) {
    const carried = existsSync(join(root, dir)) ? walk(join(root, dir)).map(f => relative(root, f).replace(/\\/g, '/')) : [];
    for (const path of carried) if (!descriptor.assets.some(a => a.path === path)) problems.push(`${path}: carried but not listed in release.json`);
  }
  return problems;
}

export function releaseProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const releases = expandReleases(root);
  const problems = [];
  if (releases.kit !== descriptor.id) problems.push(`releases.json names ${releases.kit}, the descriptor ${descriptor.id}`);
  const recorded = releases.releases.find(r => r.version === descriptor.version);
  if (!recorded) { problems.push(`releases.json records no release ${descriptor.version}`); return problems; }
  for (const key of ['archive', 'manifest', 'sources']) if (!/^[0-9a-f]{64}$/.test(recorded[key] ?? '')) problems.push(`release ${descriptor.version}: ${key} is not a sha256 digest`);
  const language = descriptor.dependencies.find(d => d.id === 'inventarch/language');
  if (recorded.language !== `${language.id} ${language.range}`) problems.push(`release ${descriptor.version}: language ${recorded.language} is not ${language.id} ${language.range}`);
  if (!/^@inventarch\/cli \d+\.\d+\.\d+$/.test(recorded.cli ?? '')) problems.push(`release ${descriptor.version}: cli must name an exact @inventarch/cli`);
  if (JSON.stringify(recorded.records) !== JSON.stringify(recordTriples(root))) problems.push(`release ${descriptor.version}: recorded records differ from the sources`);
  if (/^[0-9a-f]{64}$/.test(recorded.sources ?? '') && recorded.sources !== sourcesDigest(root)) problems.push(`release ${descriptor.version}: recorded sources digest differs from the sources`);
  return problems;
}

// --------------------------------------------------------- scratch copies

function scratchCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-authoring-kit-'));
  cpSync(join(KIT, '.ia'), join(dir, '.ia'), { recursive: true });
  for (const sub of ['assets', 'scripts', 'releases']) if (existsSync(join(KIT, sub))) cpSync(join(KIT, sub), join(dir, sub), { recursive: true });
  for (const file of ['checks.json', 'delivery.json', 'bindings.json', 'releases.json']) if (existsSync(join(KIT, file))) cpSync(join(KIT, file), join(dir, file));
  for (const file of walk(dir)) if (/\.(?:ia|json|md|mjs)$/.test(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('\r\n')) writeFileSync(file, text.replace(/\r\n/g, '\n'));
  }
  mutate?.(dir);
  return dir;
}

// Splices text in a file by exact match, never through String.prototype.replace.
function splice(file, from, to) {
  const text = readFileSync(file, 'utf8');
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `${file} does not contain ${from}`);
  writeFileSync(file, text.slice(0, at) + to + text.slice(at + from.length));
}

const compliance = system => join('.ia', 'src', 'systems', system, 'records', 'compliance.ia');

// ------------------------------------------------------------------ tests

const EXPECT = {
  'workspace.ia': ['workspace', 'agent', 'mandate'],
  'systems/ia-authoring/system.ia': ['system', 'agent'],
  'systems/ia-authoring/records/capabilities.ia': ['capability'],
  'systems/ia-authoring/records/playbooks.ia': ['playbook'],
  'systems/ia-authoring/records/conventions.ia': ['convention'],
  'systems/ia-authoring/records/distribution.ia': ['distribution'],
  'systems/ia-authoring-record/system.ia': ['system', 'agent'],
  'systems/ia-authoring-record/records/capabilities.ia': ['capability'],
  'systems/ia-authoring-record/records/playbooks.ia': ['playbook'],
  'systems/ia-authoring-record/records/conventions.ia': ['convention'],
  'systems/ia-authoring-record/records/conventions-rules.ia': ['convention'],
  'systems/ia-authoring-record/records/laws.ia': ['law'],
  'systems/ia-authoring-record/records/roles.ia': ['agent', 'mandate', 'agent-profile'],
  'systems/ia-authoring-record/records/compliance.ia': ['contract', 'check', 'case'],
  'systems/ia-authoring-host/system.ia': ['system', 'agent'],
  'systems/ia-authoring-host/records/capabilities.ia': ['capability'],
  'systems/ia-authoring-host/records/playbooks.ia': ['playbook'],
  'systems/ia-authoring-host/records/conventions.ia': ['convention'],
  'systems/ia-authoring-host/records/roles.ia': ['agent'],
  'systems/ia-authoring-host/records/compliance.ia': ['contract', 'check', 'case'],
  'systems/ia-authoring-catalogue/system.ia': ['system', 'agent'],
  'systems/ia-authoring-catalogue/records/capabilities.ia': ['capability'],
  'systems/ia-authoring-catalogue/records/playbooks.ia': ['playbook'],
  'systems/ia-authoring-catalogue/records/conventions.ia': ['convention'],
  'systems/ia-authoring-catalogue/records/compliance.ia': ['contract', 'check', 'case'],
};

test('every record file parses as IA text with the expected words, four systems and no duplicate names', () => {
  const records = readKit();
  const byFile = {};
  for (const r of records) (byFile[r.file] ??= new Set()).add(r.word);
  for (const [file, words] of Object.entries(EXPECT)) {
    assert.ok(byFile[file], `${file} is missing`);
    assert.deepEqual([...byFile[file]].sort(), [...words].sort(), `${file} words`);
  }
  assert.deepEqual(Object.keys(byFile).sort(), Object.keys(EXPECT).sort(), 'no other record files');
  assert.deepEqual(readdirSync(join(KIT, '.ia', 'src', 'systems')).sort(), SYSTEMS);
  const count = Object.fromEntries(SYSTEMS.map(s => [s, recordTriples().filter(r => r.system === s).length]));
  assert.deepEqual(count, { 'ia-authoring': 10, 'ia-authoring-catalogue': 17, 'ia-authoring-host': 35, 'ia-authoring-record': 44 });
  const duplicates = records.map(r => `${r.word}/${r.name}`).filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepEqual(duplicates, [], 'duplicate record names');
  // Every system has its steward, and the parts require nothing of the main system.
  for (const system of SYSTEMS) {
    const record = records.find(r => r.word === 'system' && r.name === system);
    const steward = refList(field(record, '', 'steward') ?? record.body.find(l => l.trim().startsWith('steward '))?.trim())[0];
    assert.ok(records.some(r => r.word === 'agent' && r.name === steward && r.system === system), `${system}: steward ${steward}`);
    const requires = record.body.filter(l => /^    - /.test(l)).map(l => l.trim().slice(2));
    if (system === MAIN) assert.deepEqual(requires.filter(s => s.startsWith('ia-')).sort(), SYSTEMS.filter(s => s !== MAIN));
    else assert.deepEqual(requires.filter(s => !PUBLIC_SYSTEMS.includes(s)), [], `${system} requires only public systems`);
  }
  const workspace = records.find(r => r.word === 'workspace');
  assert.equal(workspace.name, 'ia-authoring-kit');
  assert.deepEqual(refList(field(workspace, 'composition', 'systems')), [...PUBLIC_SYSTEMS, 'ia-authoring', 'ia-authoring-record', 'ia-authoring-host', 'ia-authoring-catalogue']);
  const distribution = records.find(r => r.word === 'distribution');
  assert.equal(distribution.name, 'ia-authoring-distribution');
  assert.equal(distribution.system, MAIN);
  assert.deepEqual(refList(field(distribution, 'distribution', 'records')).sort(), SYSTEMS);
});

test('every playbook has the four phases with their four primitive cells', () => {
  const playbooks = readKit().filter(r => r.word === 'playbook');
  assert.equal(playbooks.length, 9);
  for (const playbook of playbooks) {
    const text = playbook.body.join('\n');
    for (const phase of ['orient', 'plan', 'act', 'learn']) {
      const block = new RegExp(`^    ${phase}\\n((?:      .*\\n?)+)`, 'm').exec(text + '\n');
      assert.ok(block, `${playbook.name}: phase ${phase}`);
      for (const primitive of ['Attention', 'Inference', 'Decision', 'Learning']) assert.match(block[1], new RegExp(`^      ${primitive} means "`, 'm'), `${playbook.name}: ${phase} ${primitive}`);
      assert.match(block[1], /^      primary (?:Attention|Inference|Decision|Learning)$/m, `${playbook.name}: ${phase} primary`);
    }
  }
});

test('every reference in a record resolves to a declared record or a public system', () => {
  const records = readKit();
  const declared = new Set(records.map(r => `${r.word}/${r.name}`));
  for (const s of PUBLIC_SYSTEMS) declared.add(`system/${s}`);
  const unresolved = [];
  for (const record of records) for (const ref of refsIn(record)) {
    const key = `${ref.word}/${ref.name}`;
    if (ref.word === 'workspace' && !['mandate', 'workspace'].includes(record.word)) continue;
    if (!declared.has(key)) unresolved.push(`${record.file}:${record.line} ${record.word} ${record.name} -> @${key}`);
  }
  assert.deepEqual(unresolved, []);
  // Names a record cites in its text, such as authoring-scope, are kit records too.
  const cited = new Set();
  for (const record of records) for (const m of record.body.join('\n').matchAll(/(?<![a-z0-9-])((?:authoring|host|catalogue)-[a-z0-9-]*[a-z0-9])(?![a-z0-9-])/g)) cited.add(m[1]);
  const names = new Set(records.map(r => r.name));
  // Public words, ids and file names that are not records of the kit.
  const known = /^(?:authoring-(?:ia-rules|ia-model)|authoring-system|authoring-guide|host-trigger|host-feature|host-plugin|host-gate|authoring-worker-v1|authoring-probe-answers-v1)$/;
  const missing = [...cited].filter(n => !names.has(n) && !known.test(n)).sort();
  assert.deepEqual(missing, [], 'every kit record a text cites exists');
});

test('the kit text is LF, carries no machine path or private decision, and links only inside the kit', () => {
  for (const file of walk(KIT).filter(f => /\.(?:ia|json|md|mjs)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(KIT, file).replace(/\\/g, '/');
    assert.ok(!text.includes('\r'), `${rel} must be LF`);
    assert.doesNotMatch(text, /[A-Za-z]:\\Users\\|\/Users\/[a-z]+\/|\/home\/[a-z]+\//, `${rel} must not carry a machine path`);
    assert.doesNotMatch(text, /private-[a-z]+-[a-z-]+/, `${rel} must cite no private decision`);
    if (!file.endsWith('.md')) continue;
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/.test(target)) continue;
      const resolved = join(dirname(file), target);
      assert.ok(!relative(KIT, resolved).startsWith('..'), `${rel} links outside the kit: ${target}`);
      assert.ok(existsSync(resolved), `${rel} links to a missing file: ${target}`);
    }
  }
  // The four reference bodies the records already carry are not duplicated in the kit.
  for (const body of ['current-authoring.md', 'ia-model.md', 'ia-public-systems.md', 'ia-rules.md', 'trigger-protocol.md']) assert.equal(walk(KIT).some(f => f.endsWith(body)), false, body);
});

test('the descriptor names the public kit and its licence, and the lock pins the language base', () => {
  const descriptor = JSON.parse(readFileSync(join(KIT, '.ia', 'release.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(KIT, '.ia', 'distributions.lock.json'), 'utf8'));
  assert.equal(descriptor.id, KIT_ID);
  assert.equal(descriptor.license, 'Apache-2.0');
  assert.equal(descriptor.distribution, `workspace-system/definition/distribution/${MAIN}-distribution`);
  // The commit and epoch are stamped when the release is recorded.
  const { commit, epoch, ...source } = descriptor.source;
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(epoch) && epoch > 0);
  assert.deepEqual(source, { repository: 'https://github.com/inventarch/marketplace.git', recipe: 'ustar-v1' });
  assert.deepEqual(descriptor.dependencies.map(d => d.id), ['inventarch/language']);
  const language = descriptor.dependencies.find(d => d.id === 'inventarch/language');
  assert.equal(language.range, '^3.0.0');
  assert.deepEqual(lock.requests, [{ id: 'inventarch/language', range: language.range }]);
  const pinned = lock.packages.find(p => p.id === 'inventarch/language');
  assert.equal(pinned.version, '3.2.0');
  assert.match(pinned.archive, /^[0-9a-f]{64}$/);
});

test('delivery.json declares whole every capability that has a playbook, and nothing else', () => {
  const delivery = JSON.parse(readFileSync(join(KIT, 'delivery.json'), 'utf8'));
  assert.equal(delivery.format, 1);
  const withPlaybook = readKit().filter(r => r.word === 'capability' && field(r, 'composition', 'playbooks')).map(r => r.name).sort();
  assert.deepEqual(withPlaybook, ['authoring-deliver', 'authoring-probing-the-ia-toolchain', 'authoring-workspace-authoring', 'catalogue-author', 'host-evaluate', 'host-lower', 'host-project', 'host-qualify']);
  assert.deepEqual([...delivery.whole].sort(), withPlaybook);
  const read = kitDelivery(findKit(KIT_ID));
  assert.deepEqual(read.undeclared, []);
  assert.deepEqual([...read.whole].sort(), withPlaybook);
});

test('the Delivery entry is one whole capability that includes every part capability', () => {
  const records = readKit();
  const entry = records.find(r => r.word === 'capability' && r.name === 'authoring-deliver');
  assert.equal(entry.system, MAIN);
  assert.deepEqual(refList(field(entry, 'composition', 'playbooks')), ['authoring-deliver']);
  const parts = records.filter(r => r.word === 'capability' && r.name !== 'authoring-deliver').map(r => r.name).sort();
  assert.deepEqual(refList(field(entry, 'composition', 'includes')).sort(), parts);
  const bindings = kitBindings(findKit(KIT_ID));
  assert.deepEqual(bindings.undeclared, []);
  assert.deepEqual(Object.fromEntries(Object.entries(bindings.recommend).map(([k, v]) => [k, v.capability])), {
    'delivery.*': 'authoring-deliver',
    'delivery.author': 'authoring-workspace-authoring',
    'delivery.workspace-authoring': 'authoring-workspace-authoring',
    'delivery.probe': 'authoring-probing-the-ia-toolchain',
    'delivery.host': 'host-lower',
    'delivery.host-project': 'host-project',
    'delivery.host-evaluate': 'host-evaluate',
    'delivery.host-qualify': 'host-qualify',
    'delivery.catalogue': 'catalogue-author',
  });
  for (const v of Object.values(bindings.recommend)) assert.equal(v.kit, KIT_ID);
  assert.deepEqual([...bindings.unbound].sort(), ['authoring-deliver', 'catalogue-author', 'host-evaluate', 'host-lower', 'host-project', 'host-qualify']);
  // The probe runs under the toolchain prober's profile on the kit's worker mandate.
  const profile = records.find(r => r.word === 'agent-profile');
  assert.equal(profile.name, 'authoring-toolchain-prober-profile');
  assert.deepEqual([refList(field(profile, 'composition', 'agent'))[0], refList(field(profile, 'composition', 'mandate'))[0], refList(field(profile, 'composition', 'capabilities'))[0]], ['authoring-toolchain-prober', 'authoring-worker-mandate', 'authoring-probing-the-ia-toolchain']);
  assert.equal(field(profile, 'execution', 'role'), 'worker');
});

test('REQ-AUTH-02 success: every gate check declares one fixed command that checks.json runs', () => {
  const records = readKit();
  assert.deepEqual(checkProblems(records), []);
  const declared = Object.fromEntries(records.filter(r => r.word === 'check' && r.name !== COVERAGE).map(r => [r.name, unquote(field(r, 'check', 'scope'))]));
  assert.deepEqual(Object.keys(declared).sort(), ['authoring-field-lint', 'authoring-workspace-validate', 'catalogue-validate', 'host-fixed-point', 'host-trigger-eval', 'host-validate']);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.equal(checks.format, 1);
  assert.deepEqual(Object.keys(checks.checks).sort(), Object.keys(declared).sort());
  for (const [name, spec] of Object.entries(checks.checks)) {
    assert.ok(Array.isArray(spec.argv) && spec.argv.length > 0 && spec.argv.every(a => typeof a === 'string' && a.length), `${name}: argv`);
    assert.ok(['workspace', 'kit', 'plugin'].includes(spec.cwd ?? 'workspace'), `${name}: cwd`);
    for (const a of spec.argv) assert.doesNotMatch(a, /&&|\|\||[;|<>]/, `${name}: argv is run without a shell`);
    assert.equal(spelled(spec.argv), declared[name], `${name}: argv differs from check.scope`);
  }
  assert.equal(checks.checks['host-trigger-eval'].timeout, 21600);
  // Every capability's checks are declared checks.
  for (const capability of records.filter(r => r.word === 'capability')) for (const check of refList(field(capability, 'composition', 'checks'))) assert.ok(declared[check], `${capability.name}: ${check}`);
});

test('REQ-AUTH-02 failure: a gate without a command is refused', () => {
  const dir = scratchCopy(d => splice(join(d, compliance('ia-authoring-host')), '    scope "ia validate"', '    scope ""'));
  try {
    assert.deepEqual(checkProblems(readKit(dir)), ['host-validate: a check must carry exactly one fixed command in check.scope']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every contract requirement has a success and a failure case, and every cited test exists', () => {
  const records = readKit();
  assert.deepEqual(coverageProblems(records), []);
  assert.deepEqual(records.filter(r => r.word === 'contract').map(r => r.name).sort(), ['catalogue-authoring', 'host-authoring', 'ia-authoring-record']);
  assert.equal(records.filter(r => r.word === 'case').length, 18);
  for (const evaluator of records.filter(r => r.word === 'case').flatMap(r => unquote(field(r, 'scenario', 'evaluator')).split(' ; '))) {
    const [file, title] = evaluator.split(' :: ');
    if (file.startsWith('plugins/ia/tests/')) {
      const path = join(TESTS, file.slice('plugins/ia/tests/'.length));
      assert.ok(existsSync(path), `${file} exists`);
      const suite = readFileSync(path, 'utf8');
      assert.ok(suite.includes(`test('${title}'`) || suite.includes(`test("${title}"`), `${title} is a test of ${file}`);
    } else if (file === 'tests/test_scaffold.py') {
      assert.ok(readFileSync(join(REPO, file), 'utf8').includes(`    def ${title}(self)`), `${title} is a test of ${file}`);
    } else assert.equal(file, 'apps/cli/tests/host-plugin.test.ts', `${evaluator}: the IA CLI's own test`);
  }
});

test('a requirement without its failure case is reported', () => {
  const dir = scratchCopy(d => splice(join(d, compliance('ia-authoring-host')), 'kind failure\n    given "Two arms', 'kind success\n    given "Two arms'));
  try {
    assert.deepEqual(coverageProblems(readKit(dir)), ['REQ-HOST-03: no failure case']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-AUTH-03 success: every listed asset exists and every carried file is listed', () => {
  assert.deepEqual(assetProblems(), []);
  const descriptor = JSON.parse(readFileSync(join(KIT, '.ia', 'release.json'), 'utf8'));
  assert.deepEqual(descriptor.assets.map(a => a.path), ['assets/probe-examples/admitted.ia', 'assets/probe-examples/refused.ia', 'assets/trigger-config.md', 'bindings.json', 'checks.json', 'delivery.json', 'scripts/eval-triggers.mjs', 'scripts/field-lint.mjs', 'scripts/lib/scratch.mjs', 'scripts/probe.mjs']);
  // A carried script or example says where it was authored, and names no other kit.
  for (const path of descriptor.assets.map(a => a.path).filter(p => p.endsWith('.mjs') || p.endsWith('.ia'))) {
    const lines = readFileSync(join(KIT, path), 'utf8').split('\n');
    const provenance = path.endsWith('.ia') ? lines[1] : lines.find(l => l.startsWith('// '));
    if (path.endsWith('eval-triggers.mjs')) continue;
    assert.match(provenance, /authored in inventarch\/ia-authoring-kit 0\.1\.0/, path);
  }
});

test('REQ-AUTH-03 failure: a listed asset that is missing is reported', () => {
  const dir = scratchCopy(d => splice(join(d, '.ia', 'release.json'), '"assets": [', '"assets": [\n    { "path": "assets/missing.md", "role": "documentation" },'));
  try {
    assert.deepEqual(assetProblems(dir), ['assets/missing.md: missing']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// These two compare the sources with the recorded release, so they pass once 0.1.5 is recorded.
test('REQ-AUTH-04 success: the release index names the kit and the recorded release matches the sources', () => {
  assert.deepEqual(releaseProblems(), []);
  const releases = expandReleases(KIT);
  assert.equal(releases.kit, KIT_ID);
  assert.equal(releases.releases.at(-1).version, '0.1.5');
  assert.equal(releases.releases.at(-1).sources, sourcesDigest(KIT));
});

test('REQ-AUTH-04 failure: a release record that drifts from the sources is reported', () => {
  const dir = scratchCopy(d => writeFileSync(join(d, 'checks.json'), `${readFileSync(join(d, 'checks.json'), 'utf8')}\n`));
  try {
    assert.deepEqual(releaseProblems(dir), ['release 0.1.5: recorded sources digest differs from the sources']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -------------------------------------------- the catalogue's house rules

// The rule each convention restates: for each source, the text it must still carry anywhere (a string or a pattern)
// and the symbol or message the convention's says quotes. Rules are cited by symbol or message, never by line number.
const VALIDATE = 'tools/validate.py';
const SCHEMA = 'schemas/plugin-manifest.schema.json';
const same = text => [VALIDATE, text, text];
const RULES = {
  'catalogue-description-length': [same('<= 400 and TRIGGER.search'), same('TRIGGER = re.compile'), same('skill description needs what and when')],
  'catalogue-model-invocable-limit': [same('MODEL_INVOCABLE_PER_PLUGIN = 4'), same('too many model-invocable skills in'), same('disable-model-invocation')],
  'catalogue-listing-budget': [same('LISTING_BUDGET = 7500'), same('skill listing over budget')],
  'catalogue-hidden-description': [same('HIDDEN_DESCRIPTION = 160'), same('hidden skill description over'), same('UNADVERTISED')],
  'catalogue-codex-bridge': [same('CODEX_BRIDGE = re.compile'), same('skill must open with the Codex bridge line')],
  'catalogue-qualified-hooks': [same('QUALIFIED_HOOKS'), same('hooks differ from the qualified set'), same('RUNTIME_FILES'), same('runtime component not admitted'), same('runtime_keys')],
  'catalogue-agent-allowlist': [same('agent needs a tools allowlist'), same('disallowedTools')],
  'catalogue-author-licence': [[SCHEMA, /"author": \{[\s\S]*"name"/, 'author property'], [SCHEMA, /"license": \{\s*"const": "/, 'fixes license'], [SCHEMA, 'additionalProperties', 'no other property']],
  'catalogue-author-is-not-reviewer': [],
};

test('the nine catalogue conventions are blocking on capabilities, and the catalogue contract governs each of them', () => {
  const records = readKit();
  const conventions = records.filter(r => r.word === 'convention' && r.system === 'ia-authoring-catalogue');
  assert.deepEqual(conventions.map(c => c.name).sort(), Object.keys(RULES).sort());
  for (const c of conventions) {
    assert.equal(field(c, 'governance', 'severity'), 'blocking', `${c.name}: severity`);
    assert.equal(field(c, 'subject', 'subject-word'), 'capability', `${c.name}: subject-word`);
  }
  const contract = records.find(r => r.word === 'contract' && r.name === 'catalogue-authoring');
  const governed = contract.body.filter(l => l.trim().startsWith('governs @convention ')).map(l => l.trim().split(' ')[2]).sort();
  assert.deepEqual(governed, Object.keys(RULES).sort());
  const capability = records.find(r => r.word === 'capability' && r.name === 'catalogue-author');
  assert.deepEqual(refList(field(capability, 'composition', 'checks')), ['catalogue-validate']);
});

test('each catalogue convention still restates text its source carries, cited by symbol or message and never by line number', () => {
  const records = readKit();
  for (const [name, rules] of Object.entries(RULES)) {
    const record = records.find(r => r.word === 'convention' && r.name === name);
    const says = unquote(field(record, 'meaning', 'says'));
    assert.doesNotMatch(says, /\.(?:py|json|md):\d/, `${name}: cites a line number`);
    for (const [path, source, quoted] of rules) {
      const body = readFileSync(join(REPO, path), 'utf8');
      assert.ok(typeof source === 'string' ? body.includes(source) : source.test(body), `${name}: ${path} no longer carries ${source}`);
      assert.ok(says.includes(quoted), `${name}: says does not quote ${quoted}`);
    }
  }
  const licence = unquote(field(records.find(r => r.name === 'catalogue-author-licence'), 'meaning', 'says'));
  assert.match(licence, /Apache-2\.0 in a public catalogue/);
});

test('the catalogue conventions quote the limits the validator enforces', () => {
  const validate = readFileSync(join(REPO, VALIDATE), 'utf8');
  const limit = name => Number(new RegExp(`^${name} = (\\d+)`, 'm').exec(validate)[1]);
  const says = Object.fromEntries(readKit().filter(r => r.word === 'convention').map(r => [r.name, unquote(field(r, 'meaning', 'says'))]));
  assert.equal(limit('MODEL_INVOCABLE_PER_PLUGIN'), 4);
  assert.match(says['catalogue-model-invocable-limit'], /at most four/);
  assert.equal(limit('LISTING_BUDGET'), 7500);
  assert.match(says['catalogue-listing-budget'], /7,500/);
  assert.equal(limit('HIDDEN_DESCRIPTION'), 160);
  assert.match(says['catalogue-hidden-description'], /at most 160/);
  assert.match(says['catalogue-description-length'], /at most 400/);
});

test('the scope convention keeps new words, systems, workspaces and kits out of the kit', () => {
  const scope = readKit().find(r => r.word === 'convention' && r.name === 'authoring-scope');
  assert.equal(scope.system, MAIN);
  const says = unquote(field(scope, 'meaning', 'says'));
  assert.match(says, /records of existing public IA words/);
  assert.match(says, /a new word, a new system, a new workspace or a new kit/);
  assert.match(says, /by hand from the public IA documentation, or with an InventArch subscription/);
  const install = unquote(field(readKit().find(r => r.name === 'authoring-kit-install-and-bind'), 'meaning', 'says'));
  for (const verb of ['list', 'add --from <folder or archive>', 'bind', 'upgrade', 'repin', 'rebind', 'check']) assert.ok(install.includes(`kit.mjs ${verb}`), verb);
  assert.match(install, /config\/kits\/<folder>\/ .*<IA home>\/kits\/<kit>\/<version>\//);
  assert.match(install, /writes nothing unless --apply/);
});

// -------------------------------------------------------- opt-in: the CLI

const CLI = process.env.IA_CORE_TEST_CLI;

function ia(root, args) {
  const ran = spawnSync(process.execPath, [CLI, ...args, '--root', root, '--json'], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, json };
}

test('REQ-AUTH-01 success: the kit admits under the pinned CLI', { skip: !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, () => {
  const dir = scratchCopy();
  try {
    const restored = ia(dir, ['restore', '--apply', '--yes']);
    assert.equal(restored.json?.applied?.status, 'installed', restored.stdout.slice(0, 2000) || restored.stderr);
    const validated = ia(dir, ['validate']);
    assert.equal(validated.json?.status, 'admitted', validated.stdout.slice(0, 2000) || validated.stderr);
    assert.equal(validated.json.counts.errors, 0, JSON.stringify(validated.json.findings?.filter(f => f.severity === 'error')?.slice(0, 5)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-AUTH-01 failure: an unknown evaluator is refused at restore', { skip: !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, () => {
  const dir = scratchCopy(d => splice(join(d, compliance('ia-authoring-host')), '    runs COMP-CHECK\n    scope "ia validate"', '    runs host-gate\n    scope "ia validate"'));
  try {
    const restored = ia(dir, ['restore', '--apply', '--yes']);
    assert.equal(restored.json?.ok, false);
    assert.equal(restored.json?.code, 'IA-DIST-ADMISSION-FAILED');
    assert.match(restored.json?.message ?? '', /IA-COMP-CHECK-UNKNOWN/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Each capability that needs no workspace is a whole procedure (delivery.json): resolved outside an IA workspace, it
// delivers its playbook's sixteen cells read by identity, phases in order, at any scope key; one that needs a
// workspace is refused there.
test('real CLI: the capabilities that need no workspace resolve unbound to their whole playbook, the others are refused (opt-in: IA_CORE_TEST_CLI)', { skip: !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, () => {
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-authoring-resolve-')));
  const env = { ...process.env, IA_CLI_PATH: CLI, IA_CORE_CLOSURES_DIR: join(plain, 'closures') };
  for (const name of ['IA_CORE_RUN_ROOT', 'IA_CORE_KITS_DIR', 'IA_METHOD_CLI']) delete env[name];
  const resolve = (activity, capability) => spawnSync(process.execPath, [RESOLVE, '--entry', 'delivery', '--activity', activity, '--root', plain, '--kit', KIT_ID, '--capability', capability, '--json'], { encoding: 'utf8', env, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  try {
    for (const capability of ['authoring-deliver', 'host-lower', 'host-project', 'host-evaluate', 'host-qualify', 'catalogue-author']) {
      for (const activity of ['understand', 'review']) {
        const label = `${capability} as delivery.${activity}`;
        const ran = resolve(activity, capability);
        assert.equal(ran.status, 0, ran.stdout.slice(0, 1500) + ran.stderr.slice(0, 500));
        const packet = JSON.parse(ran.stdout);
        assert.deepEqual([packet.binding.via, packet.binding.capability, packet.closure.kit], ['unbound', capability, KIT_ID], label);
        assert.deepEqual(packet.instructions.map(c => [c.playbook, c.source]), Array(16).fill([`governance-system/definition/procedure/${capability}`, 'playbook']), `${label}: sixteen cells read by identity`);
        assert.deepEqual(packet.instructions.map(c => c.address.split('#')[1].split('/')[0]), ['orient', 'plan', 'act', 'learn'].flatMap(p => Array(4).fill(p)), `${label}: phase order`);
        assert.deepEqual(packet.missing.filter(m => ['instructions', 'delivery', 'record'].includes(m.kind)), [], label);
      }
    }
    const refused = resolve('probe', 'authoring-probing-the-ia-toolchain');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /IA-CORE-UNBOUND-UNDECLARED/);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});
