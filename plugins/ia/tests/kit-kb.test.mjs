// Structural tests for the inventarch/ia-kb-kit sources under
// config/kits/ia-kb: the record files parse as IA text with the expected
// words, every reference resolves, every declared check carries one fixed
// command that checks.json repeats, every shipped file is listed and exists,
// the recorded release names these sources, every record name and kit file
// the guidance cites resolves, the locator checker runs from the kit folder,
// directly and through the core's checker runner (REQ-KB-02 to REQ-KB-06 of
// the ia-kb contract), and the kit's own decision checker passes and refuses
// decision records, directly and through the runner with a stand-in CLI
// (REQ-KB-10). None of this needs the IA CLI. With
// IA_CORE_TEST_CLI=<path to @inventarch/cli dist/main.js> the kit is also
// restored and validated in a scratch copy (REQ-KB-01), kb-check-validate
// runs through the runner (REQ-KB-07), kb-check-decisions reads a workspace's
// own decisions through ia records (REQ-KB-10), every recommended binding
// resolves through the core's resolve.mjs to its whole playbook with the
// kit's laws, from the restored kit root and in an adopting repository at its
// workspace seat and at a @spec seat (REQ-KB-08), and the sources repack to
// the recorded release.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findKit, kitDelivery, releaseRecords, sourcesDigest } from '../scripts/lib/kit.mjs';
import { recordSources } from './helpers/fixtures.mjs';

const KIT = fileURLToPath(new URL('../config/kits/ia-kb/', import.meta.url));
const PLUGIN = fileURLToPath(new URL('../', import.meta.url));
const KIT_ID = 'inventarch/ia-kb-kit';
const SYSTEM = 'ia-kb';
const VERSION = '0.9.4';
const PUBLIC_SYSTEMS = ['agent-composition-system', 'agent-system', 'authoring-system', 'compliance-system', 'governance-system', 'hook-authoring-system', 'learning-system', 'session-system', 'template-system', 'work-system', 'workspace-system'];
const EVALUATORS = ['COMP-PARSE', 'COMP-SCHEMA', 'COMP-SYSTEM', 'COMP-SCHEMA-ENROLLED', 'COMP-CONSENT-DECLARED', 'COMP-CONSENT', 'COMP-IDENTITY', 'COMP-SELECTOR', 'COMP-VARIANT', 'COMP-COVERAGE', 'COMP-FRAGMENT', 'COMP-ADOPTION', 'COMP-KERNEL', 'COMP-FIXTURES', 'COMP-STEWARD', 'COMP-BOOTSTRAP', 'COMP-CHECK'];
const ROLES = ['documentation', 'asset', 'license'];
// Every file the kit ships beside its records.
const ASSETS = [
  'assets/examples/split-body/README.md',
  'assets/examples/split-body/anchor.ia',
  'assets/examples/split-body/locators.json',
  'assets/examples/split-body/model-api.md',
  'assets/kb-document-binding.md',
  'assets/kb-lifecycle.md',
  'assets/kb-placement.md',
  'bindings.json',
  'checks.json',
  'delivery.json',
  'scripts/check-decisions.mjs',
  'scripts/check-locators.mjs',
];
// The example body: its bytes are pinned by the example manifest.
const EXAMPLE_BODY = 'assets/examples/split-body/model-api.md';
const EXAMPLE_MANIFEST = 'assets/examples/split-body/locators.json';
const DECISIONS = 'scripts/check-decisions.mjs';
// The stages, each a capability with its own playbook of the same name.
const STAGES = ['kb-knowledge', 'kb-place-content', 'kb-bind-document', 'kb-maintain-document', 'kb-check', 'kb-migrate'];
// The recommended bindings, kb-knowledge first.
const BINDINGS = {
  'knowledge.*': 'kb-knowledge',
  'knowledge.find': 'kb-retrieve',
  'knowledge.explain': 'kb-retrieve',
  'knowledge.maintain': 'kb-maintain-document',
  'knowledge.place': 'kb-place-content',
  'knowledge.bind': 'kb-bind-document',
  'knowledge.check': 'kb-check',
  'knowledge.migrate': 'kb-migrate',
  'knowledge.review': 'kb-review',
};

// ---------------------------------------------------------------- parsing

function walk(dir) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = root => walk(join(root, '.ia', 'src')).filter(p => p.endsWith('.ia'));
const lf = text => text.replace(/\r\n/g, '\n');

// A record is `@word name` at column 0 followed by its indented block. The
// block is kept as lines so a test can read a field such as check.scope.
function parseRecords(text, file = '') {
  const lines = text.split('\n');
  const records = [];
  let current;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    const head = /^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
    if (head) {
      current = { word: head[1], name: head[2], file, line: index + 1, body: [] };
      records.push(current);
    } else if (current && line.trim()) {
      assert.match(line, /^\s/, `${file}:${index + 1}: a non-record line must be indented`);
      current.body.push(line);
    }
  }
  return records;
}

function readKit(root = KIT) {
  const records = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(join(root, '.ia', 'src'), file).replace(/\\/g, '/');
    assert.equal(text.split('\n')[0].replace(/\r$/, ''), '#! ia 1.0', `${rel} must start with the grammar header`);
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

// Structural references only: an `@word name` outside quoted text. Prose
// inside a "..." string mentions IA words but references nothing.
function refsIn(record) {
  const refs = [];
  for (const line of record.body) for (const m of line.replace(/"[^"]*"/g, '""').matchAll(/@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/g)) refs.push({ word: m[1], name: m[2] });
  return refs;
}

// The (system, word, name) triples the pack tool records, read the way
// scripts/lib/records.mjs reads them: system folders only.
function recordTriples(root = KIT) {
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

function gateProblems(records) {
  const problems = [];
  for (const check of records.filter(r => r.word === 'check')) {
    const runs = field(check, 'check', 'runs');
    const scope = unquote(field(check, 'check', 'scope'));
    if (!runs || !EVALUATORS.includes(runs)) problems.push(`${check.name}: runs must name a built-in evaluator, got ${runs ?? 'nothing'}`);
    if (check.name === `${SYSTEM}-coverage`) { if (runs !== 'COMP-COVERAGE') problems.push(`${check.name}: must run COMP-COVERAGE`); continue; }
    if (runs !== 'COMP-CHECK') problems.push(`${check.name}: a gate must run COMP-CHECK`);
    if (!scope || !scope.trim() || !/^[a-z]/i.test(scope.trim())) problems.push(`${check.name}: a gate must carry exactly one fixed command in check.scope`);
  }
  return problems;
}

// checks.json against the @check records: every key is a gate record, the
// argv is shell-free, and its words are the record's command (${NODE} and
// ${IA} written as node and ia; ${KIT} as it stands).
function checksProblems(records, checks) {
  const problems = [];
  if (checks.format !== 1) problems.push('checks.json: format must be 1');
  const declared = Object.fromEntries(records.filter(r => r.word === 'check').map(r => [r.name, unquote(field(r, 'check', 'scope'))]));
  for (const [name, spec] of Object.entries(checks.checks ?? {})) {
    if (!(name in declared)) { problems.push(`${name}: not a @check record`); continue; }
    if (name === `${SYSTEM}-coverage`) problems.push(`${name}: the coverage check is evaluated by IA, not run`);
    if (!Array.isArray(spec.argv) || !spec.argv.length || !spec.argv.every(a => typeof a === 'string' && a.length)) { problems.push(`${name}: argv`); continue; }
    if (!['workspace', 'kit', 'plugin'].includes(spec.cwd ?? 'workspace')) problems.push(`${name}: cwd`);
    if (spec.argv.some(a => /&&|\|\||[;|<>]/.test(a))) problems.push(`${name}: argv is run without a shell`);
    const command = spec.argv.map(a => ({ '${NODE}': 'node', '${IA}': 'ia' })[a] ?? a).join(' ');
    if (command !== declared[name]) problems.push(`${name}: argv ${command} differs from check.scope ${declared[name]}`);
  }
  const gates = Object.keys(declared).filter(n => n !== `${SYSTEM}-coverage`).sort();
  if (JSON.stringify(Object.keys(checks.checks ?? {}).sort()) !== JSON.stringify(gates)) problems.push(`checks.json must name exactly the gate checks ${gates.join(', ')}`);
  return problems;
}

function assetProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const problems = [];
  for (const asset of descriptor.assets) {
    const path = join(root, asset.path);
    if (!ROLES.includes(asset.role)) problems.push(`${asset.path}: role must be one of ${ROLES.join(', ')}`);
    if (/(^|\/)(\.[^/]+|node_modules|dist)\//.test(asset.path)) problems.push(`${asset.path}: under a hidden, node_modules or dist folder`);
    if (!existsSync(path)) { problems.push(`${asset.path}: missing`); continue; }
    if (asset.path === EXAMPLE_BODY) {
      const manifest = JSON.parse(readFileSync(join(root, EXAMPLE_MANIFEST), 'utf8'));
      const pinned = manifest.documents.find(d => `assets/examples/split-body/${basename(d.path)}` === EXAMPLE_BODY)?.sha256;
      if (createHash('sha256').update(lf(readFileSync(path, 'utf8'))).digest('hex') !== pinned) problems.push(`${asset.path}: no longer the bytes ${EXAMPLE_MANIFEST} pins`);
    } else if (asset.path.endsWith('.md')) {
      if (asset.role !== 'documentation') problems.push(`${asset.path}: a Markdown document has role documentation`);
    } else if (asset.role !== 'asset') problems.push(`${asset.path}: a ${asset.path.endsWith('.mjs') ? 'script' : 'machine file'} has role asset`);
  }
  const shipped = ['assets', 'scripts'].filter(d => existsSync(join(root, d))).flatMap(d => walk(join(root, d))).map(f => relative(root, f).replace(/\\/g, '/'));
  for (const path of shipped) if (!descriptor.assets.some(a => a.path === path)) problems.push(`${path}: shipped but not listed in release.json`);
  return problems;
}

function releaseProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const releases = JSON.parse(readFileSync(join(root, 'releases.json'), 'utf8'));
  const problems = [];
  if (releases.kit !== descriptor.id) problems.push(`releases.json names ${releases.kit}, the descriptor ${descriptor.id}`);
  const recorded = releases.releases.find(r => r.version === descriptor.version);
  if (!recorded) { problems.push(`releases.json records no release ${descriptor.version}`); return problems; }
  for (const key of ['archive', 'manifest', 'sources']) if (!/^[0-9a-f]{64}$/.test(recorded[key] ?? '')) problems.push(`release ${descriptor.version}: ${key} is not a sha256 digest`);
  const language = descriptor.dependencies.find(d => d.id === 'inventarch/language');
  if (recorded.language !== `${language.id} ${language.range}`) problems.push(`release ${descriptor.version}: language ${recorded.language} is not ${language.id} ${language.range}`);
  if (!/^@inventarch\/cli \d+\.\d+\.\d+$/.test(recorded.cli ?? '')) problems.push(`release ${descriptor.version}: cli must name an exact @inventarch/cli`);
  if (recorded.sources !== sourcesDigest(root)) problems.push(`release ${descriptor.version}: sources ${recorded.sources} is not the kit's sourcesDigest ${sourcesDigest(root)}: repack`);
  if (JSON.stringify(releaseRecords(root, recorded)) !== JSON.stringify(recordTriples(root))) problems.push(`release ${descriptor.version}: recorded records differ from the sources`);
  return problems;
}

// Every kb- or ia-kb- name and every kit file path that a record other than a
// case quotes. A name must be a declared record; a path (assets/..., or
// config/kits/ia-kb/... under the plugin root) a listed asset or a folder
// holding one. Cases are left out: they quote the fixtures their tests build.
const NAME = /(?<![A-Za-z0-9_/.-])(?:ia-)?kb-[a-z0-9]+(?:-[a-z0-9]+)*/g;
const PATH = /(?<![A-Za-z0-9_/.-])(?:config\/kits\/ia-kb\/[A-Za-z0-9._/-]*[A-Za-z0-9_]|(?:\$\{KIT\}\/)?assets\/[A-Za-z0-9._/-]*[A-Za-z0-9_])/g;
function citationProblems(root = KIT) {
  const records = readKit(root);
  const declared = new Set(records.map(r => r.name));
  const assets = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8')).assets.map(a => a.path);
  const problems = [];
  for (const record of records.filter(r => r.word !== 'case')) {
    const quoted = record.body.flatMap(line => [...line.matchAll(/"([^"]*)"/g)].map(m => m[1])).join('\n');
    for (const [name] of quoted.matchAll(NAME)) if (!declared.has(name)) problems.push(`${record.word} ${record.name}: names ${name}, which no record declares`);
    for (const [raw] of quoted.matchAll(PATH)) {
      const path = raw.replace(/^config\/kits\/ia-kb\//, '').replace(/^\$\{KIT\}\//, '');
      if (!assets.some(a => a === path || a.startsWith(`${path}/`))) problems.push(`${record.word} ${record.name}: names ${raw}, which is no listed asset`);
    }
  }
  return [...new Set(problems)];
}

// --------------------------------------------------------- scratch copies

function scratchCopy(mutate, prefix = 'ia-kb-kit-') {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  for (const part of ['.ia', 'assets', 'scripts', 'releases.json', 'releases', 'bindings.json', 'checks.json', 'delivery.json']) if (existsSync(join(KIT, part))) cpSync(join(KIT, part), join(dir, part), { recursive: true });
  for (const file of walk(dir)) if (/\.(?:ia|json|md|mjs)$/.test(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('\r\n')) writeFileSync(file, lf(text));
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

const COMPLIANCE = join('.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
const PLAYBOOKS = join('.ia', 'src', 'systems', SYSTEM, 'records', 'playbooks.ia');
const checksJson = (root = KIT) => JSON.parse(readFileSync(join(root, 'checks.json'), 'utf8'));
// The checks.json argv of a check with ${NODE} and ${KIT} filled for a kit folder.
const argvFor = (name, kitDir = KIT) => checksJson(kitDir).checks[name].argv.map(a => (a === '${NODE}' ? process.execPath : a.replace('${KIT}', kitDir.replace(/[\\/]$/, ''))));
const runArgv = (argv, cwd) => spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
const ENV_CLEAN = env => { const out = { ...env }; for (const k of ['IA_CORE_KITS_DIR', 'IA_CORE_RUN_ROOT', 'IA_METHOD_CLI', 'IA_CORE_HOST_ENFORCES_CHECKS']) delete out[k]; return out; };
function runChecker(name, root, env = {}) {
  const ran = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'check.mjs'), name, '--kit', KIT_ID, '--root', root], { env: { ...ENV_CLEAN(process.env), ...env }, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  return { code: ran.status, json, stdout: ran.stdout, stderr: ran.stderr };
}
// An empty folder that the core takes for an IA workspace (it holds .ia/src).
function bareWorkspace(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-ws-')));
  mkdirSync(join(dir, '.ia', 'src'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ------------------------------------------------------------------ tests

test('every record file parses as IA text with the expected words', () => {
  const records = readKit();
  const byFile = {};
  for (const r of records) (byFile[r.file] ??= new Set()).add(r.word);
  const expect = {
    'workspace.ia': ['workspace', 'agent', 'mandate'],
    [`systems/${SYSTEM}/system.ia`]: ['system', 'agent'],
    [`systems/${SYSTEM}/records/capabilities.ia`]: ['capability'],
    [`systems/${SYSTEM}/records/playbooks.ia`]: ['playbook'],
    [`systems/${SYSTEM}/records/conventions.ia`]: ['convention'],
    [`systems/${SYSTEM}/records/laws.ia`]: ['law'],
    [`systems/${SYSTEM}/records/roles.ia`]: ['agent', 'mandate', 'agent-profile'],
    [`systems/${SYSTEM}/records/compliance.ia`]: ['contract', 'check', 'case'],
    [`systems/${SYSTEM}/records/distribution.ia`]: ['distribution'],
  };
  for (const [file, words] of Object.entries(expect)) {
    assert.ok(byFile[file], `${file} is missing`);
    assert.deepEqual([...byFile[file]].sort(), [...words].sort(), `${file} words`);
  }
  assert.deepEqual(Object.keys(byFile).sort(), Object.keys(expect).sort(), 'no other record files');
  const names = new Set(records.map(r => `${r.word}/${r.name}`));
  for (const stage of STAGES) {
    assert.ok(names.has(`capability/${stage}`), `capability ${stage}`);
    assert.ok(names.has(`playbook/${stage}`), `playbook ${stage}`);
  }
  for (const [capability, playbook] of [['kb-retrieve', 'kb-retrieval'], ['kb-review', 'kb-review']]) {
    assert.ok(names.has(`capability/${capability}`), capability);
    assert.ok(names.has(`playbook/${playbook}`), playbook);
  }
  assert.deepEqual(records.filter(r => r.word === 'capability').map(r => r.name).sort(), [...STAGES, 'kb-retrieve', 'kb-review', 'kb-gates'].sort());
  assert.deepEqual(records.filter(r => r.word === 'agent' && r.file.startsWith('systems/')).map(r => r.name).sort(), ['ia-kb-steward', 'kb-curator', 'kb-gate-runner', 'kb-librarian', 'kb-reviewer']);
  assert.deepEqual(records.filter(r => r.word === 'convention').map(r => r.name).sort(), ['kb-document-binding', 'kb-evidence-reporting', 'kb-host-adaptation', 'kb-ia-reads', 'kb-lifecycle', 'kb-placement', 'kb-role-briefs', 'kb-workspace-location']);
  assert.ok(names.has(`contract/${SYSTEM}`));
  assert.ok(names.has(`distribution/${SYSTEM}-distribution`));
  assert.ok(names.has(`system/${SYSTEM}`));
  for (const r of records.filter(r => !['workspace.ia', `systems/${SYSTEM}/system.ia`].includes(r.file) && r.word !== 'contract' && r.word !== 'distribution' && r.name !== `${SYSTEM}-coverage`)) {
    assert.match(r.name, /^(kb-|ia-kb-)/, `${r.word} ${r.name} carries the kit's prefix`);
  }
  const duplicates = records.map(r => `${r.word}/${r.name}`).filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepEqual(duplicates, [], 'duplicate record names');
});

test('every playbook has the four phases with their four primitive cells', () => {
  const playbooks = readKit().filter(r => r.word === 'playbook');
  assert.equal(playbooks.length, 8);
  for (const playbook of playbooks) {
    const text = playbook.body.join('\n');
    assert.match(text, /^  subject\n    subject-word [a-z-]+$/m, `${playbook.name}: subject-word`);
    for (const phase of ['orient', 'plan', 'act', 'learn']) {
      const block = new RegExp(`^    ${phase}\\n((?:      .*\\n?)+)`, 'm').exec(text + '\n');
      assert.ok(block, `${playbook.name}: phase ${phase}`);
      for (const primitive of ['Attention', 'Inference', 'Decision', 'Learning']) assert.match(block[1], new RegExp(`^      ${primitive} means "[^"]+"$`, 'm'), `${playbook.name}: ${phase} ${primitive}`);
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
    if (!['capability', 'playbook', 'check', 'contract', 'agent', 'agent-profile', 'mandate', 'law', 'system', 'distribution', 'case', 'workspace'].includes(ref.word)) continue;
    if (ref.word === 'workspace' && record.word !== 'mandate') continue;
    if (!declared.has(key)) unresolved.push(`${record.file}:${record.line} ${record.word} ${record.name} -> @${key}`);
  }
  assert.deepEqual(unresolved, []);
});

test('system records reference no workspace mandate, and the profiles run on the system\'s own mandates', () => {
  const records = readKit().filter(r => r.file.startsWith(`systems/${SYSTEM}/`));
  for (const record of records) for (const ref of refsIn(record)) assert.notEqual(`${ref.word}/${ref.name}`, 'mandate/ia-kb-kit-mandate', `${record.name} references the workspace's mandate`);
  const moves = Object.fromEntries(records.filter(r => r.word === 'mandate').map(r => [r.name, field(r, 'authority', 'moves')]));
  assert.deepEqual(moves, {
    'ia-kb-reader-mandate': '[Observation, Verification]',
    'ia-kb-checker-mandate': '[Observation, Verification, Execution]',
    'ia-kb-worker-mandate': '[Observation, Verification, Synthesis, Delegation, Execution]',
  });
});

test('profiles bind the librarian and reviewer as reader, the gate runner as checker, and the curator as worker', () => {
  const profiles = readKit().filter(r => r.word === 'agent-profile');
  const roles = Object.fromEntries(profiles.map(r => [r.name, [field(r, 'execution', 'role'), field(r, 'composition', 'mandate')]]));
  assert.deepEqual(roles, {
    'kb-librarian-profile': ['reader', '@mandate ia-kb-reader-mandate'],
    'kb-reviewer-profile': ['reader', '@mandate ia-kb-reader-mandate'],
    'kb-gate-runner-profile': ['checker', '@mandate ia-kb-checker-mandate'],
    'kb-curator-profile': ['worker', '@mandate ia-kb-worker-mandate'],
  });
  const budget = Object.fromEntries(profiles.map(r => [r.name, field(r, 'execution', 'limit-steps')]));
  assert.deepEqual(budget, { 'kb-librarian-profile': '25', 'kb-reviewer-profile': '30', 'kb-gate-runner-profile': undefined, 'kb-curator-profile': '40' });
  // Each capability is composed by at most one profile, so the resolver can
  // name the role without a --profile in the binding.
  const composers = {};
  for (const p of profiles) for (const m of (field(p, 'composition', 'capabilities') ?? '').matchAll(/@capability ([a-z0-9-]+)/g)) (composers[m[1]] ??= []).push(p.name);
  for (const [capability, list] of Object.entries(composers)) assert.equal(list.length, 1, `${capability} is composed by ${list.join(', ')}`);
  // The gate runner has its own capability; kb-check, the corpus check, is
  // composed by no profile, so the agent running the stage is its role.
  assert.deepEqual(composers['kb-gates'], ['kb-gate-runner-profile']);
  assert.equal(composers['kb-check'], undefined);
  assert.deepEqual(composers['kb-retrieve'], ['kb-librarian-profile']);
  assert.deepEqual(composers['kb-bind-document'], ['kb-curator-profile']);
  assert.deepEqual(composers['kb-maintain-document'], ['kb-curator-profile']);
  // The writer boundaries, the single-writer and not-evaluated rules and the
  // independence rule ride in role.brief.
  const says = name => unquote(field(profiles.find(p => p.name === name), 'meaning', 'says'));
  assert.match(says('kb-librarian-profile'), /write nothing, through the shell either/);
  assert.match(says('kb-reviewer-profile'), /Never accept your own authored work or infer approval from a draft status/);
  assert.match(says('kb-curator-profile'), /Do not write adopted definitions/);
  assert.match(says('kb-curator-profile'), /grants no permission/);
  assert.match(says('kb-curator-profile'), /One system has one canonical source writer/);
  assert.match(says('kb-curator-profile'), /zero errors with not-evaluated requirements is admission without a full compliance pass/);
});

test('the checks each capability composes are exactly what its claim needs', () => {
  const capabilities = readKit().filter(r => r.word === 'capability');
  const checks = Object.fromEntries(capabilities.map(c => [c.name, [...(field(c, 'composition', 'checks') ?? '').matchAll(/@check ([a-z0-9-]+)/g)].map(m => m[1])]));
  assert.deepEqual(checks['kb-gates'], ['kb-check-validate', 'kb-check-locators', 'kb-check-task-locators', 'kb-check-decisions']);
  // The decision check reads the workspace's own decisions, so the stages whose
  // claims rest on them require it: the KB check, and document maintenance,
  // which records and updates decisions.
  for (const name of ['kb-check', 'kb-maintain-document']) assert.deepEqual(checks[name], ['kb-check-validate', 'kb-check-decisions'], name);
  assert.deepEqual(checks['kb-migrate'], ['kb-check-validate']);
  // The locator check's fixed argv covers only the kit's example, so no stage
  // requires it as evidence.
  for (const [name, list] of Object.entries(checks)) if (name !== 'kb-gates') assert.ok(!list.includes('kb-check-locators'), `${name} composes kb-check-locators`);
  for (const name of ['kb-knowledge', 'kb-place-content', 'kb-bind-document', 'kb-retrieve', 'kb-review']) assert.deepEqual(checks[name], [], name);
  assert.equal(field(capabilities.find(c => c.name === 'kb-gates'), 'composition', 'playbooks'), undefined);
});

test('the router and bind cells say where the locator checker is and that it runs directly on the task\'s manifest', () => {
  const playbooks = readKit().filter(r => r.word === 'playbook');
  for (const name of ['kb-knowledge', 'kb-bind-document']) {
    const text = playbooks.find(p => p.name === name).body.join('\n');
    assert.match(text, /config\/kits\/ia-kb\/scripts\/check-locators\.mjs under the ia plugin root/, name);
    assert.match(text, /directly on the task's own manifest/, name);
    assert.match(text, /sanctioned way/, name);
    assert.doesNotMatch(text, /<kit folder>/, name);
  }
  // The manifest format lives in the binding convention, the record the
  // binding stage reads.
  const binding = readKit().find(r => r.word === 'convention' && r.name === 'kb-document-binding');
  const says = unquote(field(binding, 'meaning', 'says'));
  for (const fact of ['ia.document-locators.v1', 'repo://repository-id/exact-commit/repo-relative-path', 'documentId, specIdentity, repository, commit, path and sha256', '--checkout repository-id=absolute-path']) assert.ok(says.includes(fact), fact);
});

test('the workspace location convention is the place stage\'s rule where placement is decided', () => {
  const records = readKit();
  const convention = records.find(r => r.word === 'convention' && r.name === 'kb-workspace-location');
  assert.ok(convention, 'kb-workspace-location');
  assert.equal(field(convention, 'subject', 'subject-word'), 'workspace');
  assert.equal(field(convention, 'governance', 'severity'), 'advisory');
  const says = unquote(field(convention, 'meaning', 'says'));
  for (const fact of ['~/Documents/ia/<name>', '~/Documents/ia/studio', '~/Documents/ia/music', '~/Documents/ia/design', 'the user can point a workspace anywhere else', '~/.ia is the IA home only', 'the location registry and the installed kits', 'refuses a workspace inside its home', 'one .ia/src, at the repository root', 'A personal or single-team KB declares one @workspace', 'one @workspace per department, each declaring its own scope folders', 'declares the repository root as a source (. @authored)', 'workspaces/<name>/', 'released or adopted on its own']) assert.ok(says.includes(fact), fact);
  assert.match(unquote(field(convention, 'governance', 'requires')), /never inside ~\/\.ia/);
  // The plan cell of kb-place-content decides the placement and cites it.
  const place = records.find(r => r.word === 'playbook' && r.name === 'kb-place-content').body.join('\n');
  const plan = /^    plan\n((?:      .*\n?)+)/m.exec(place + '\n')[1];
  assert.match(plan, /^      Attention means "Decide where the workspace itself sits by the convention kb-workspace-location: a user's workspace defaults to ~\/Documents\/ia\/<name>/m);
  assert.match(unquote(field(records.find(r => r.name === 'kb-placement'), 'meaning', 'says')), /the convention kb-workspace-location/);
  // No record names the old folder rule or a workspace under the home.
  for (const record of records) {
    const text = record.body.join('\n');
    assert.doesNotMatch(text, /IA [A-Z][a-z]+ folder|~\/Documents\/IA /, `${record.name}: old folder naming`);
    assert.doesNotMatch(text, /~\/\.ia\/workspaces/, `${record.name}: a workspace in the home`);
  }
});

test('delivery.json declares whole every capability that has a playbook, and nothing else', () => {
  const delivery = JSON.parse(readFileSync(join(KIT, 'delivery.json'), 'utf8'));
  assert.equal(delivery.format, 1);
  assert.equal(delivery.whole[0], 'kb-knowledge', 'the lane entry is first');
  const withPlaybook = readKit().filter(r => r.word === 'capability' && field(r, 'composition', 'playbooks')).map(r => r.name).sort();
  assert.equal(withPlaybook.length, 8);
  assert.deepEqual([...delivery.whole].sort(), withPlaybook);
  const read = kitDelivery(findKit(KIT_ID));
  assert.deepEqual(read.undeclared, []);
  assert.deepEqual([...read.whole].sort(), withPlaybook);
});

test('bindings.json recommends the lane entry first and one key per public stage', () => {
  const bindings = JSON.parse(readFileSync(join(KIT, 'bindings.json'), 'utf8'));
  assert.equal(bindings.format, 1);
  assert.deepEqual(Object.keys(bindings.recommend), Object.keys(BINDINGS));
  for (const [key, capability] of Object.entries(BINDINGS)) assert.deepEqual(bindings.recommend[key], { capability }, key);
  const whole = JSON.parse(readFileSync(join(KIT, 'delivery.json'), 'utf8')).whole;
  for (const capability of Object.values(BINDINGS)) assert.ok(whole.includes(capability), `${capability} is delivered whole`);
});

test('the kb-knowledge capability includes every stage capability and the retrieval and review capabilities', () => {
  const entry = readKit().find(r => r.word === 'capability' && r.name === 'kb-knowledge');
  const includes = field(entry, 'composition', 'includes');
  assert.deepEqual([...includes.matchAll(/@capability ([a-z0-9-]+)/g)].map(m => m[1]).sort(), [...STAGES.filter(s => s !== 'kb-knowledge'), 'kb-retrieve', 'kb-review'].sort());
  assert.equal(field(entry, 'composition', 'playbooks'), '[@playbook kb-knowledge]');
});

test('the blocking rules are laws, and the contract governs every one', () => {
  const records = readKit();
  const laws = records.filter(r => r.word === 'law');
  assert.deepEqual(laws.map(l => l.name).sort(), ['kb-disclosure-boundary', 'kb-exact-pins', 'kb-not-evaluated-is-not-pass', 'kb-one-canonical-writer', 'kb-reviewer-independence']);
  for (const law of laws) {
    assert.equal(field(law, 'governance', 'severity'), 'blocking', law.name);
    // subject-kind definition reaches the workspace seat (a workspace is a
    // definition); subject-word spec reaches a @spec seat. The opt-in delivery
    // test proves both in an adopting repository.
    assert.equal(field(law, 'subject', 'subject-kind'), 'definition', law.name);
    assert.equal(field(law, 'subject', 'subject-word'), 'spec', law.name);
  }
  const contract = records.find(r => r.word === 'contract' && r.name === SYSTEM);
  for (const law of laws) assert.ok(contract.body.some(l => l.trim() === `governs @law ${law.name}`), `contract governs ${law.name}`);
  for (const convention of records.filter(r => r.word === 'convention')) assert.equal(field(convention, 'governance', 'severity'), 'advisory', convention.name);
});

test('the kit text is LF, carries no machine path, and links only inside the kit', () => {
  for (const file of walk(KIT).filter(f => /\.(?:ia|json|md|mjs)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(KIT, file).replace(/\\/g, '/');
    assert.ok(!text.includes('\r'), `${rel} must be LF`);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]+Users[\\/]|\/[a-z]\/Users\/|\/Users\/[a-z]+\/|\/home\/[a-z]+\/|AppData[\\/]/i, `${rel} must not carry a machine path`);
    if (!file.endsWith('.md')) continue;
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/.test(target)) continue;
      const resolved = join(file, '..', target);
      assert.ok(!relative(KIT, resolved).startsWith('..'), `${rel} links outside the kit: ${target}`);
      assert.ok(existsSync(resolved), `${rel} links to a missing file: ${target}`);
    }
  }
});

test('the descriptor is the public release, and the lock pins the language base it depends on', () => {
  const descriptor = JSON.parse(readFileSync(join(KIT, '.ia', 'release.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(KIT, '.ia', 'distributions.lock.json'), 'utf8'));
  assert.equal(descriptor.id, KIT_ID);
  assert.equal(descriptor.version, VERSION);
  assert.equal(descriptor.distribution, `workspace-system/definition/distribution/${SYSTEM}-distribution`);
  assert.equal(descriptor.license, 'Apache-2.0');
  // The commit and epoch are stamped by the release.
  const { commit, epoch, ...source } = descriptor.source;
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(epoch));
  assert.deepEqual(source, { repository: 'https://github.com/inventarch/marketplace.git', recipe: 'ustar-v1' });
  const language = descriptor.dependencies.find(d => d.id === 'inventarch/language');
  assert.deepEqual(lock.requests, [{ id: 'inventarch/language', range: language.range }]);
  const pinned = lock.packages.find(p => p.id === 'inventarch/language');
  assert.equal(pinned.version, '3.2.0');
  assert.match(pinned.archive, /^[0-9a-f]{64}$/);
  // The same pinned base as the method kit, byte for byte.
  const method = fileURLToPath(new URL('../config/kits/ia-method/.ia/distributions.lock.json', import.meta.url));
  assert.equal(lf(readFileSync(join(KIT, '.ia', 'distributions.lock.json'), 'utf8')), lf(readFileSync(method, 'utf8')));
});

test('REQ-KB-02 success: every gate check declares one fixed command and checks.json carries it', () => {
  const records = readKit();
  assert.deepEqual(gateProblems(records), []);
  assert.deepEqual(checksProblems(records, checksJson()), []);
  const commands = Object.fromEntries(records.filter(r => r.word === 'check').map(g => [g.name, unquote(field(g, 'check', 'scope'))]));
  assert.equal(commands['kb-check-validate'], 'ia validate --json');
  assert.equal(commands['kb-check-locators'], 'node ${KIT}/scripts/check-locators.mjs ${KIT}/assets/examples/split-body/locators.json');
  // The trailing ia is ${IA}, the CLI the runner resolves, which the checker
  // runs to read the records.
  assert.equal(commands['kb-check-decisions'], 'node ${KIT}/scripts/check-decisions.mjs ia');
  assert.deepEqual(checksJson().checks['kb-check-decisions'], { argv: ['${NODE}', '${KIT}/scripts/check-decisions.mjs', '${IA}'], cwd: 'workspace' });
  assert.deepEqual(Object.keys(checksJson().checks).sort(), ['kb-check-decisions', 'kb-check-locators', 'kb-check-task-locators', 'kb-check-validate']);
});

test('REQ-KB-02 failure: a gate without a command is refused', () => {
  const dir = scratchCopy(d => splice(join(d, COMPLIANCE), '    scope "ia validate --json"', '    scope ""'));
  try {
    assert.deepEqual(gateProblems(readKit(dir)), ['kb-check-validate: a gate must carry exactly one fixed command in check.scope']);
    assert.deepEqual(checksProblems(readKit(dir), checksJson(dir)), ['kb-check-validate: argv ia validate --json differs from check.scope ']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-KB-03 success: every listed asset exists with its role', () => {
  assert.deepEqual(assetProblems(), []);
  const descriptor = JSON.parse(readFileSync(join(KIT, '.ia', 'release.json'), 'utf8'));
  assert.deepEqual(descriptor.assets.map(a => a.path).sort(), [...ASSETS].sort());
});

test('REQ-KB-03 failure: a missing, an unlisted and a drifted asset are reported', () => {
  const cases = [
    [d => splice(join(d, '.ia', 'release.json'), '"assets": [', '"assets": [\n    { "path": "assets/missing.md", "role": "documentation" },'), ['assets/missing.md: missing']],
    [d => writeFileSync(join(d, 'assets', 'stray.md'), '# Stray\n'), ['assets/stray.md: shipped but not listed in release.json']],
    [d => writeFileSync(join(d, EXAMPLE_BODY), '# Model API example\n\nEdited.\n'), [`${EXAMPLE_BODY}: no longer the bytes ${EXAMPLE_MANIFEST} pins`]],
  ];
  for (const [mutate, expected] of cases) {
    const dir = scratchCopy(mutate);
    try {
      assert.deepEqual(assetProblems(dir), expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// Fails until the release of VERSION is recorded in releases.json.
test('REQ-KB-04 success: releases.json matches the release descriptor and the sources', () => {
  assert.deepEqual(releaseProblems(), []);
  const releases = JSON.parse(readFileSync(join(KIT, 'releases.json'), 'utf8'));
  assert.equal(releases.kit, KIT_ID);
  assert.equal(releases.releases.at(-1).version, VERSION);
  assert.equal(releases.releases.at(-1).cli, '@inventarch/cli 3.8.0');
  assert.equal(releases.releases.at(-1).sources, sourcesDigest(KIT));
});

test('REQ-KB-04 failure: a release record that drifts from the descriptor or the sources is reported', () => {
  const drifted = scratchCopy(d => splice(join(d, '.ia', 'release.json'), `"version": "${VERSION}"`, '"version": "0.0.9"'));
  try {
    assert.deepEqual(releaseProblems(drifted), ['releases.json records no release 0.0.9']);
  } finally { rmSync(drifted, { recursive: true, force: true }); }
  // Against the latest recorded release, a cell edited after it was recorded.
  const edited = scratchCopy(d => {
    splice(join(d, PLAYBOOKS), '      Attention means "Return actionable findings and evidence."', '      Attention means "Return findings."');
    const latest = JSON.parse(readFileSync(join(d, 'releases.json'), 'utf8')).latest;
    const descriptor = join(d, '.ia', 'release.json');
    writeFileSync(descriptor, JSON.stringify({ ...JSON.parse(readFileSync(descriptor, 'utf8')), version: latest }, null, 2) + '\n');
  });
  try {
    const problems = releaseProblems(edited);
    assert.ok(problems.length >= 1, 'the edit is reported');
    assert.ok(problems.some(p => /^release \d+\.\d+\.\d+: sources [0-9a-f]{64} is not the kit's sourcesDigest [0-9a-f]{64}: repack$/.test(p)), problems.join('\n'));
  } finally { rmSync(edited, { recursive: true, force: true }); }
});

test('REQ-KB-05 success: every name and path the records cite resolves', () => {
  assert.deepEqual(citationProblems(), []);
  // The check sees the citations it is meant to see.
  const quoted = readKit().filter(r => r.word !== 'case').flatMap(r => r.body).join('\n');
  for (const cited of ['kb-workspace-location', 'kb-gate-runner-profile', 'assets/kb-placement.md', 'config/kits/ia-kb/scripts/check-locators.mjs', 'assets/examples/split-body']) assert.ok(quoted.includes(cited), cited);
});

test('REQ-KB-05 failure: a dangling name and a dangling path are reported', () => {
  const dir = scratchCopy(d => splice(join(d, PLAYBOOKS), '      Attention means "Return actionable findings and evidence."', '      Attention means "Return actionable findings and evidence, after the convention kb-nowhere and the kit asset assets/kb-nowhere.md."'));
  try {
    assert.deepEqual(citationProblems(dir), ['playbook kb-review: names kb-nowhere, which no record declares', 'playbook kb-review: names assets/kb-nowhere.md, which is no listed asset']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-KB-06 success: the locator checker accepts the worked example from the kit folder', t => {
  const ran = runArgv(argvFor('kb-check-locators'), KIT);
  assert.equal(ran.status, 0, ran.stderr);
  const out = JSON.parse(ran.stdout);
  assert.deepEqual(out, { format: 'ia.document-locators.v1', documents: [{ documentId: 'example-model-api', standing: 'metadata-only; bytes unavailable' }], networkRequests: 0, bodyDisclosure: false, nativeGraphClosure: 'not evaluated' });
  // Through the core's checker runner, which fills ${NODE} and ${KIT} itself.
  const viaRunner = runChecker('kb-check-locators', bareWorkspace(t));
  assert.equal(viaRunner.code, 0, viaRunner.stdout + viaRunner.stderr);
  assert.equal(viaRunner.json.exitCode, 0);
  assert.equal(viaRunner.json.kit, KIT_ID);
  assert.match(viaRunner.json.stdout, /"standing": "metadata-only; bytes unavailable"/);
});

test('REQ-KB-06 failure: the locator checker refuses a mutable revision', t => {
  const kits = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-kits-')));
  t.after(() => rmSync(kits, { recursive: true, force: true }));
  const copy = join(kits, 'ia-kb');
  cpSync(KIT, copy, { recursive: true });
  splice(join(copy, EXAMPLE_MANIFEST), '"commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', '"commit": "main"');
  const ran = runArgv(argvFor('kb-check-locators', copy), copy);
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /commit must be an exact object ID/);
  assert.equal(ran.stdout, '');
  // The changed copy is no longer the recorded release, so it runs no code (lib/trust.mjs) until it is recorded as one.
  recordSources(copy);
  const viaRunner = runChecker('kb-check-locators', bareWorkspace(t), { IA_CORE_KITS_DIR: kits });
  assert.equal(viaRunner.code, 3, viaRunner.stdout + viaRunner.stderr);
  assert.equal(viaRunner.json.exitCode, 1);
  assert.match(viaRunner.json.stderr, /commit must be an exact object ID/);
});

// The locator checker's behaviour: the metadata-only result, the refusals,
// and byte verification against a local Git checkout.
test('the locator checker reports metadata only, refuses bad manifests, and verifies bytes in a checkout', async t => {
  const { checkLocators } = await import(new URL('../config/kits/ia-kb/scripts/check-locators.mjs', import.meta.url));
  const fixture = () => JSON.parse(readFileSync(join(KIT, EXAMPLE_MANIFEST), 'utf8'));
  const value = checkLocators(fixture());
  assert.equal(value.networkRequests, 0);
  assert.equal(value.bodyDisclosure, false);
  assert.match(value.documents[0].standing, /metadata-only/);
  for (const [change, expected] of [
    [m => { m.documents[0].commit = 'main'; }, /exact object ID/],
    [m => { m.documents[0].path = '../secret'; }, /traversal/],
    [m => { m.documents[0].path = 'C:/secret'; }, /relative document/],
    [m => { m.documents.push({ ...m.documents[0], documentId: 'other' }); }, /duplicate canonical/],
    [m => { m.documents[0].grantedBy = 'someone'; }, /unknown document/],
  ]) { const m = fixture(); change(m); assert.throws(() => checkLocators(m), expected); }
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-locator-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'design.md'), 'Pinned design.\n');
  git(['add', 'docs/design.md']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', 'commit', '-qm', 'fixture']);
  const manifest = fixture(), doc = manifest.documents[0];
  doc.path = 'docs/design.md';
  doc.commit = git(['rev-parse', 'HEAD']);
  doc.sha256 = createHash('sha256').update(readFileSync(join(root, doc.path))).digest('hex');
  assert.match(checkLocators(manifest, { 'example-app': root }).documents[0].standing, /bytes verified/);
  writeFileSync(join(root, doc.path), 'Changed uncommitted body.\n');
  assert.throws(() => checkLocators(manifest, { 'example-app': root }), /working body/);
  doc.commit = 'b'.repeat(40);
  assert.throws(() => checkLocators(manifest, { 'example-app': root }), /HEAD differs/);
});

// ------------------------------------------------- the decision lifecycle

// The decisions the REQ-KB-10 tests check, as [name, fields]: the passing side
// of every rule, then each way to fail one. The opt-in real-CLI test authors
// the same decisions as IA text. A decision's acceptance is its decider,
// choice and rationale; the accepted revision (decision.effective-revision)
// is not required yet, since no current decision records one.
const ACCEPTED = { decider: 'Operator', choice: 'This way.', rationale: 'It holds.' };
const REVISION = 'f'.repeat(64);
const PASSING = [
  ['made-whole', { status: 'made', ...ACCEPTED, revision: REVISION }],
  ['made-unrevised', { status: 'made', ...ACCEPTED }],
  // A successor names the decision it replaces (supersedes), or the replaced
  // decision names its successor (superseded-by), in the same file or in
  // another one, by name in any case or by identity.
  ['replaced', { status: 'superseded', ...ACCEPTED }],
  ['replacement', { status: 'made', ...ACCEPTED, supersedes: 'replaced' }],
  ['replaced-naming', { status: 'superseded', ...ACCEPTED, supersededBy: 'replacement-named' }],
  ['replacement-named', { status: 'made', ...ACCEPTED }],
  ['replaced-elsewhere', { status: 'superseded', ...ACCEPTED }],
  ['replacement-elsewhere', { status: 'made', ...ACCEPTED, supersedes: 'Replaced-Elsewhere', file: 'successors.ia' }],
  ['replaced-naming-elsewhere', { status: 'superseded', ...ACCEPTED, supersededBy: 'work-system/definition/decision/replacement-named-elsewhere' }],
  ['replacement-named-elsewhere', { status: 'made', ...ACCEPTED, file: 'successors.ia' }],
  // The rules leave open and withdrawn decisions alone.
  ['still-open', { status: 'open' }],
  ['dropped', { status: 'withdrawn' }],
];
const FAILING = [
  ['made-bare', { status: 'made' }],
  ['made-gap', { status: 'made', ...ACCEPTED, rationale: undefined }],
  ['orphan', { status: 'superseded', ...ACCEPTED }],
  // A decision is not its own successor; IA admits the loop.
  ['self-loop', { status: 'superseded', ...ACCEPTED, supersedes: 'self-loop' }],
  // A revision alone is no acceptance.
  ['stripped', { status: 'superseded', revision: REVISION }],
  ['stripping', { status: 'made', ...ACCEPTED, supersedes: 'stripped' }],
  // A successor of another word is no @decision, even beside a decision of
  // its name: IA admits superseded-by @spec newer-word with no such record,
  // warning IA-GRAPH-TARGET-MISSING.
  ['other-word', { status: 'superseded', ...ACCEPTED, supersededBy: '@spec newer-word' }],
  ['newer-word', { status: 'made', ...ACCEPTED }],
];
// What the check reports for FAILING, in identity order.
const FAILED = [
  { code: 'decision-made-needs-acceptance', record: '@decision made-bare', message: '@decision made-bare is made without decision.decider, decision.choice and decision.rationale' },
  { code: 'decision-made-needs-acceptance', record: '@decision made-gap', message: '@decision made-gap is made without decision.rationale' },
  { code: 'decision-superseded-needs-successor', record: '@decision orphan', message: '@decision orphan is superseded, but no @decision supersedes it' },
  { code: 'decision-superseded-needs-successor', record: '@decision other-word', message: '@decision other-word is superseded, but no @decision supersedes it' },
  { code: 'decision-superseded-needs-successor', record: '@decision self-loop', message: '@decision self-loop is superseded, but no @decision supersedes it' },
  { code: 'decision-superseded-needs-acceptance', record: '@decision stripped', message: '@decision stripped is superseded without decision.decider, decision.choice and decision.rationale' },
];

// A @decision as ia records returns it (CLI 3.3.0 and 3.4.0, which the opt-in test
// reads): its sections' fields as { key, value: { kind, text } }, and the
// supersede edge it writes itself, out for the successor's supersedes and in
// for the replaced one's superseded-by, with the reference as written: a name,
// whose capitals it keeps, with its word (@decision unless written), or an
// identity. The CLI resolves the target only within the record's own file: an
// edge into another file, or to no record, keeps target null.
const decisionId = name => `work-system/definition/decision/${name}`;
const fileOf = (decisions, name) => decisions.find(([other]) => other === name)?.[1].file ?? 'decisions.ia';
const referenceTo = other => (other.startsWith('@') ? { kind: 'ref', discriminator: other.slice(1, other.indexOf(' ')), name: other.slice(other.indexOf(' ') + 1) }
  : other.includes('/') ? { kind: 'identity', identity: other } : { kind: 'ref', discriminator: 'decision', name: other });
const nameIn = other => (other.includes('/') ? other.split('/').at(-1) : other.toLowerCase());
function decisionRecord([name, { status, decider, choice, rationale, revision, supersedes, supersededBy, provenance = 'workspace', file = 'decisions.ia' }], decisions) {
  const field = (key, text, kind = 'string') => ({ key, value: { kind, text } });
  const acceptance = Object.entries({ decider, choice, rationale, 'effective-revision': revision }).filter(([, text]) => text !== undefined).map(([key, text]) => field(key, text));
  const edge = (direction, spelling, other) => ({
    predicate: 'supersede', direction, spelling, reference: referenceTo(other),
    target: decisions.some(([known]) => known === nameIn(other)) && fileOf(decisions, nameIn(other)) === file ? decisionId(nameIn(other)) : null,
  });
  const edges = [];
  if (supersedes) edges.push(edge('out', 'supersedes', supersedes));
  if (supersededBy) edges.push(edge('in', 'superseded-by', supersededBy));
  return {
    identity: decisionId(name), discriminator: 'decision', name, provenance, source: { path: `.ia/src/${file}`, line: 1 },
    sections: [
      { name: 'meaning', fields: [field('says', `The ${name} decision.`)] },
      { name: 'work', fields: [field('title', name), field('status', status, 'scalar')] },
      { name: 'decision', fields: [field('question', 'Which way?'), ...acceptance] },
    ],
    edges,
  };
}
const snapshot = decisions => ({ revision: 'a'.repeat(64), root: '', records: decisions.map(decision => decisionRecord(decision, decisions)), systems: [] });
const codesAndMessages = findings => findings.map(({ code, message }) => ({ code, message }));
const findingsOf = report => codesAndMessages(report.findings);
const checkDecisions = async () => (await import(new URL(`../config/kits/ia-kb/${DECISIONS}`, import.meta.url))).checkDecisions;

// What ia validate --json prints for a workspace it admits.
const ADMITTED = { version: 1, status: 'admitted', counts: { errors: 0, warnings: 2, notEvaluated: 2 }, findings: [] };
// A bare workspace whose stand-in IA CLI answers ia validate with `validate`
// and ia records with `records`, each with its exit code, and appends the
// arguments and folder of every call to calls.jsonl.
function standInWorkspace(t, { records, recordsExit = 0, validate = ADMITTED, validateExit = 0 }) {
  const root = bareWorkspace(t);
  const cli = join(root, 'ia-stand-in.mjs');
  const answers = { validate: [validate, validateExit], records: [records, recordsExit] };
  writeFileSync(cli, [
    'import { appendFileSync } from \'node:fs\';',
    'const argv = process.argv.slice(2);',
    'appendFileSync(new URL(\'./calls.jsonl\', import.meta.url), `${JSON.stringify({ argv, cwd: process.cwd() })}\\n`);',
    `const [reply, exit] = ${JSON.stringify(answers)}[argv[0]];`,
    'process.stdout.write(`${JSON.stringify(reply)}\\n`);',
    'process.exitCode = exit;',
    '',
  ].join('\n'));
  return { root, cli, calls: () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('REQ-KB-10 success: kb-check-decisions passes made decisions with their acceptance and superseded ones with a successor', async t => {
  const check = await checkDecisions();
  // A made decision with its decider, choice and rationale passes without an
  // effective revision: the check does not require the accepted revision yet.
  assert.deepEqual(check(snapshot([['made-unrevised', { status: 'made', ...ACCEPTED }]])).findings, [], 'decision.effective-revision is not required');
  // A successor in another file: ia records leaves that edge's target null and
  // keeps its reference as written, here a capitalized name and an identity,
  // which the check resolves.
  const elsewhere = snapshot(PASSING.filter(([name]) => name.includes('elsewhere')));
  assert.deepEqual(elsewhere.records.flatMap(r => r.edges.map(e => [e.target, e.reference])), [
    [null, { kind: 'ref', discriminator: 'decision', name: 'Replaced-Elsewhere' }],
    [null, { kind: 'identity', identity: decisionId('replacement-named-elsewhere') }],
  ]);
  assert.deepEqual(check(elsewhere).findings, [], 'a successor in another file');
  // An adopted made decision without its acceptance is not the workspace's own.
  const adopted = ['adopted-gap', { status: 'made', provenance: 'methodology' }];
  assert.deepEqual(check(snapshot([...PASSING, adopted])), { format: 'ia.kb.decision-lifecycle.v1', revision: 'a'.repeat(64), decisions: 12, findings: [] });
  // Through the core's checker runner, which hands the checker the CLI it
  // resolves (${IA}); the checker asks it whether the workspace root admits,
  // then for its records.
  const { root, cli, calls } = standInWorkspace(t, { records: { ok: true, result: snapshot(PASSING) } });
  const viaRunner = runChecker('kb-check-decisions', root, { IA_CLI_PATH: cli });
  assert.equal(viaRunner.code, 0, viaRunner.stdout + viaRunner.stderr);
  assert.equal(viaRunner.json.exitCode, 0);
  assert.deepEqual(viaRunner.json.argv, [process.execPath, join(KIT, DECISIONS), process.execPath, cli]);
  assert.deepEqual(JSON.parse(viaRunner.json.stdout), { format: 'ia.kb.decision-lifecycle.v1', revision: 'a'.repeat(64), decisions: 12, findings: [] });
  assert.deepEqual(calls(), [{ argv: ['validate', '--root', root, '--severity', 'error', '--json'], cwd: root }, { argv: ['records', '--root', root, '--params', '{}'], cwd: root }]);
});

test('REQ-KB-10 failure: kb-check-decisions refuses a made decision without its acceptance and a superseded one without a successor', async t => {
  const check = await checkDecisions();
  const fails = decisions => findingsOf(check(snapshot(decisions)));
  // Each part of the acceptance, missing or blank, fails a made decision, and
  // the other two are not enough, with or without a revision.
  for (const [key, path] of [['decider', 'decision.decider'], ['choice', 'decision.choice'], ['rationale', 'decision.rationale']]) {
    for (const value of [undefined, ' \t']) {
      assert.deepEqual(fails([['made-gap', { status: 'made', ...ACCEPTED, revision: REVISION, [key]: value }]]), [{ code: 'decision-made-needs-acceptance', message: `@decision made-gap is made without ${path}` }], `${path} ${JSON.stringify(value)}`);
    }
  }
  // A superseded decision without a successor, or without its acceptance. A
  // supersede edge whose target is no decision the records hold names no
  // successor.
  assert.deepEqual(fails([['orphan', { status: 'superseded', ...ACCEPTED, supersededBy: 'nowhere' }]]), [{ code: 'decision-superseded-needs-successor', message: '@decision orphan is superseded, but no @decision supersedes it' }]);
  assert.deepEqual(fails(FAILING), codesAndMessages(FAILED));
  // Findings come in identity order, whatever order the records come in.
  assert.deepEqual(fails([...FAILING].reverse()), codesAndMessages(FAILED), 'identity order');
  // Through the runner: the checker reports each finding and exits 1, the runner 3.
  const { root, cli } = standInWorkspace(t, { records: { ok: true, result: snapshot([...PASSING, ...FAILING]) } });
  const viaRunner = runChecker('kb-check-decisions', root, { IA_CLI_PATH: cli });
  assert.equal(viaRunner.code, 3, viaRunner.stdout + viaRunner.stderr);
  assert.equal(viaRunner.json.exitCode, 1);
  const report = JSON.parse(viaRunner.json.stdout);
  assert.equal(report.decisions, 20);
  assert.deepEqual(findingsOf(report), codesAndMessages(FAILED));
  // What the checker cannot judge is never a pass: it exits 2 with nothing on
  // stdout, and the runner 3, having called the CLI for `calls`.
  const notJudged = (answers, stderr, calls) => {
    const standIn = standInWorkspace(t, answers);
    const ran = runChecker('kb-check-decisions', standIn.root, { IA_CLI_PATH: standIn.cli });
    assert.equal(ran.code, 3, ran.stdout + ran.stderr);
    assert.equal(ran.json.exitCode, 2);
    assert.equal(ran.json.stdout, '');
    assert.equal(ran.json.stderr, stderr);
    assert.deepEqual(standIn.calls().map(call => call.argv[0]), calls);
  };
  const records = { ok: true, result: snapshot(PASSING) };
  // A workspace IA refuses, whose records ia records would still answer
  // without the refused ones, is never read; nor is one ia validate cannot open.
  const collision = { severity: 'error', code: 'IA-LANG-IDENTITY-COLLISION', path: '.ia/src/d.ia', line: 3, message: '.ia/src/d.ia:3: identity work-system/definition/decision/foo is also declared at .ia/src/d.ia:12 (band 100)' };
  const refusedValidation = { version: 1, status: 'refused', counts: { errors: 2, warnings: 2, notEvaluated: 2 }, findings: [{ severity: 'warning', code: 'IA-COMP-NOT-EVALUATED', message: 'COMP-FIXTURES: not supplied' }, collision, { ...collision, line: 12 }] };
  notJudged({ records, validate: refusedValidation, validateExit: 1 }, `kb-check-decisions: ia validate refused the workspace with 2 errors, the first IA-LANG-IDENTITY-COLLISION: ${collision.message}; a workspace IA refuses is not judged\n`, ['validate']);
  notJudged({ records, validate: { ...refusedValidation, counts: { errors: 1, warnings: 2, notEvaluated: 2 }, findings: [collision] }, validateExit: 1 }, `kb-check-decisions: ia validate refused the workspace with 1 error, the first IA-LANG-IDENTITY-COLLISION: ${collision.message}; a workspace IA refuses is not judged\n`, ['validate']);
  // A refusal that lists no error, as --json would if warnings filled its 50
  // findings, is still not judged.
  notJudged({ records, validate: { ...refusedValidation, counts: { errors: 1, warnings: 52, notEvaluated: 2 }, findings: [refusedValidation.findings[0]] }, validateExit: 1 }, 'kb-check-decisions: ia validate refused the workspace with 1 error; a workspace IA refuses is not judged\n', ['validate']);
  notJudged({ records, validate: { version: 1, ok: false, code: 'IA-DB-ROOT-INVALID', message: 'No .ia/src directory at the root' }, validateExit: 3 }, 'kb-check-decisions: ia validate did not admit the workspace: IA-DB-ROOT-INVALID: No .ia/src directory at the root\n', ['validate']);
  // Records it cannot read: a refusal, a refusal that exits 0, an ok answer
  // that exits 1, and an ok answer that holds no records.
  notJudged({ records: { ok: false, code: 'IA-DB-ROOT-INVALID', message: 'IA-DB-ROOT-INVALID: Cannot open workspace' }, recordsExit: 1 }, 'kb-check-decisions: ia records did not return the admitted records: IA-DB-ROOT-INVALID: Cannot open workspace\n', ['validate', 'records']);
  notJudged({ records: { ...records, ok: false, code: 'IA-RUNTIME-REQUEST-INVALID', message: 'IA-RUNTIME-REQUEST-INVALID: within is unknown' } }, 'kb-check-decisions: ia records did not return the admitted records: IA-RUNTIME-REQUEST-INVALID: within is unknown\n', ['validate', 'records']);
  notJudged({ records, recordsExit: 1 }, 'kb-check-decisions: ia records did not return the admitted records: it answered ok but exited 1\n', ['validate', 'records']);
  notJudged({ records: { ok: true, result: {} } }, 'kb-check-decisions: ia records did not return the admitted records: its answer holds no records\n', ['validate', 'records']);
  // A folder that is not a workspace root, and no command at all.
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const direct = runArgv([process.execPath, join(KIT, DECISIONS), process.execPath, cli], outside);
  assert.equal(direct.status, 2);
  assert.equal(direct.stdout, '');
  assert.equal(direct.stderr, `kb-check-decisions: ${outside} is not a workspace root (it has no .ia/src); run the check from the root of the workspace under check\n`);
  const bare = runArgv([process.execPath, join(KIT, DECISIONS)], root);
  assert.equal(bare.status, 2);
  assert.equal(bare.stderr, 'kb-check-decisions: usage: node check-decisions.mjs <the command that runs ia, such as node <path to @inventarch/cli>/dist/main.js>, from the workspace root\n');
});

test('the README names the stages, the workspace location and the bindings bindings.json recommends', () => {
  const body = readFileSync(join(KIT, 'README.md'), 'utf8');
  for (const [key, capability] of Object.entries(BINDINGS)) {
    const written = key === 'knowledge.*' ? `'${key}'` : key;
    assert.ok(body.includes(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" set ${written} ${KIT_ID} ${capability}\n`), `binding ${key}`);
  }
  for (const name of [...STAGES, 'kb-retrieve', 'kb-review', 'kb-gates', 'kb-workspace-location', '~/Documents/ia/<name>', 'Apache-2.0']) assert.ok(body.includes(name), `README names ${name}`);
  for (const word of ['`@spec`']) assert.ok(body.includes(word), 'IA words are in backticks');
  assert.doesNotMatch(body, /npx\s+(?:--no\s+)?ia\b/, 'runs ia through npx');
  assert.doesNotMatch(body, /(?:npx|npm install)[^\n]*@inventarch\/cli(?!@(?:\d+\.\d+\.\d+|<version>))/, 'runs @inventarch/cli without an exact version');
});

test('the recommended bindings resolve to capabilities the kit declares', () => {
  const capabilities = new Set(readKit().filter(r => r.word === 'capability').map(r => r.name));
  const body = readFileSync(join(KIT, 'README.md'), 'utf8');
  const lines = [...body.matchAll(/scripts\/bind\.mjs" set (\S+) (\S+) (\S+)$/gm)];
  assert.equal(lines.length, Object.keys(BINDINGS).length);
  for (const [, key, kit, capability] of lines) {
    assert.match(key, /^'?knowledge\.(?:\*|[a-z][a-z0-9-]*)'?$/, key);
    assert.equal(kit, KIT_ID);
    assert.ok(capabilities.has(capability), `${key} -> ${capability}`);
    assert.equal(BINDINGS[key.replace(/'/g, '')], capability, `${key}: the README and bindings.json agree`);
  }
});

// -------------------------------------------------------- opt-in: the CLI

const CLI = process.env.IA_CORE_TEST_CLI;
const SKIP = !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js';

function ia(root, args) {
  const ran = spawnSync(process.execPath, [CLI, ...args, '--root', root, '--json'], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, json };
}

test('REQ-KB-01 success: the kit admits under the pinned CLI', { skip: SKIP }, () => {
  const dir = scratchCopy();
  try {
    const restored = ia(dir, ['restore', '--apply', '--yes']);
    assert.equal(restored.json?.applied?.status, 'installed', restored.stdout.slice(0, 2000) || restored.stderr);
    const validated = ia(dir, ['validate']);
    assert.equal(validated.json?.status, 'admitted', validated.stdout.slice(0, 2000) || validated.stderr);
    assert.equal(validated.json.counts.errors, 0, JSON.stringify(validated.json.findings?.filter(f => f.severity === 'error')?.slice(0, 5)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-KB-01 failure: an unknown evaluator is refused', { skip: SKIP }, () => {
  const dir = scratchCopy(d => splice(join(d, COMPLIANCE), '    runs COMP-CHECK\n    scope "ia validate --json"', '    runs kb-gate\n    scope "ia validate --json"'));
  try {
    const restored = ia(dir, ['restore', '--apply', '--yes']);
    assert.equal(restored.json?.ok, false);
    assert.equal(restored.json?.code, 'IA-DIST-ADMISSION-FAILED');
    assert.match(restored.json?.message ?? '', /IA-COMP-CHECK-UNKNOWN/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-KB-07 success: kb-check-validate passes on an admitted workspace', { skip: SKIP }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-validate-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const init = spawnSync(process.execPath, [CLI, 'init', repo, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const passed = runChecker('kb-check-validate', repo, { IA_CLI_PATH: CLI });
  assert.equal(passed.code, 0, passed.stdout.slice(0, 2000) + passed.stderr);
  assert.equal(passed.json.exitCode, 0);
  assert.match(passed.json.stdout, /"status":"admitted"/);
});

test('REQ-KB-07 failure: kb-check-validate fails on a refused workspace', { skip: SKIP }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-validate-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const init = spawnSync(process.execPath, [CLI, 'init', repo, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  writeFileSync(join(repo, '.ia', 'src', 'broken.ia'), ['#! ia 1.0', '', '@capability broken-thing', '  meaning', '    says 42', '  bogus-section', '    nothing here', ''].join('\n'));
  const failed = runChecker('kb-check-validate', repo, { IA_CLI_PATH: CLI });
  assert.equal(failed.code, 3, failed.stdout.slice(0, 2000) + failed.stderr);
  assert.notEqual(failed.json.exitCode, 0);
  assert.match(failed.json.stdout, /"status":"refused"/);
});

// REQ-KB-10 with the real CLI: the decisions above, authored as IA text in a
// workspace ia init made, each in its file under .ia/src, and read back
// through ia records.
function decisionsSources(decisions) {
  const files = {};
  for (const [name, { status, decider, choice, rationale, revision, supersedes, supersededBy, question = 'Which way?', file = 'decisions.ia' }] of decisions) {
    const lines = (files[file] ??= ['#! ia 1.0']);
    lines.push('', `@decision ${name}`, '  meaning', `    says "The ${name} decision."`, '  work', `    title "${name}"`, `    status ${status}`, '  decision');
    if (question !== null) lines.push(`    question ${JSON.stringify(question)}`);
    for (const [key, text] of Object.entries({ decider, choice, rationale, 'effective-revision': revision })) if (text !== undefined) lines.push(`    ${key} ${JSON.stringify(text)}`);
    const written = other => (other.startsWith('@') || other.includes('/') ? other : `@decision ${other}`);
    if (supersedes) lines.push('  relationships', `    supersedes ${written(supersedes)}`);
    if (supersededBy) lines.push('  relationships', `    superseded-by ${written(supersededBy)}`);
  }
  return Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, `${lines.join('\n')}\n`]));
}
function writeDecisions(repo, decisions) {
  const sources = decisionsSources(decisions);
  for (const [file, text] of Object.entries(sources)) writeFileSync(join(repo, '.ia', 'src', file), text);
  return sources;
}

test('REQ-KB-10 real CLI: kb-check-decisions reads the workspace\'s own decisions through ia records', { skip: SKIP }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-decisions-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = initWorkspace(base, 'repo');
  // Two successors sit in successors.ia, so their supersede edges cross files.
  assert.deepEqual(Object.keys(writeDecisions(repo, PASSING)), ['decisions.ia', 'successors.ia']);
  // IA admits both sets: its decision schema leaves the acceptance optional.
  assert.equal(ia(repo, ['validate']).json?.status, 'admitted');
  const passed = runChecker('kb-check-decisions', repo, { IA_CLI_PATH: CLI });
  assert.equal(passed.code, 0, passed.stdout.slice(0, 2000) + passed.stderr);
  const clean = JSON.parse(passed.json.stdout);
  assert.match(clean.revision, /^[0-9a-f]{64}$/);
  assert.equal(clean.decisions, 12);
  assert.deepEqual(clean.findings, []);
  const text = writeDecisions(repo, [...PASSING, ...FAILING])['decisions.ia'];
  assert.equal(ia(repo, ['validate']).json?.status, 'admitted');
  const failed = runChecker('kb-check-decisions', repo, { IA_CLI_PATH: CLI });
  assert.equal(failed.code, 3, failed.stdout.slice(0, 2000) + failed.stderr);
  assert.equal(failed.json.exitCode, 1);
  const report = JSON.parse(failed.json.stdout);
  assert.equal(report.decisions, 20);
  const lineOf = record => text.split('\n').indexOf(record) + 1;
  assert.deepEqual(report.findings, FAILED.map(f => ({ ...f, path: '.ia/src/decisions.ia', line: lineOf(f.record) })));
  // A workspace IA refuses is never judged, though ia records answers it
  // without the refused decisions: two decisions whose names differ only in
  // case, and a decision without its question, beside the passing ones.
  writeDecisions(repo, PASSING);
  for (const [refused, errors, code] of [[[['Foo', { status: 'made' }], ['foo', { status: 'made' }]], '2 errors', 'IA-LANG-IDENTITY-COLLISION'], [[['no-question', { status: 'made', ...ACCEPTED, question: null }]], '1 error', 'IA-COMP-FIELD-MISSING']]) {
    writeFileSync(join(repo, '.ia', 'src', 'refused.ia'), decisionsSources(refused)['decisions.ia']);
    const validated = ia(repo, ['validate']);
    assert.equal(validated.json?.status, 'refused', validated.stdout.slice(0, 2000));
    const first = validated.json.findings.find(f => f.severity === 'error');
    assert.equal(first.code, code);
    const judged = runChecker('kb-check-decisions', repo, { IA_CLI_PATH: CLI });
    assert.equal(judged.code, 3, judged.stdout.slice(0, 2000) + judged.stderr);
    assert.equal(judged.json.exitCode, 2);
    assert.equal(judged.json.stdout, '');
    assert.equal(judged.json.stderr, `kb-check-decisions: ia validate refused the workspace with ${errors}, the first ${code}: ${first.message}; a workspace IA refuses is not judged\n`);
  }
});

// ------------------------------------------- opt-in: delivery of the bindings

const LAWS = ['kb-disclosure-boundary', 'kb-exact-pins', 'kb-not-evaluated-is-not-pass', 'kb-one-canonical-writer', 'kb-reviewer-independence'].map(n => `governance-system/governance/law/${n}`);
const SPEC_SEAT = 'work-system/contract/spec/model-api';

// The cells of a playbook as its record declares them: the phases in order,
// each phase's primitives in declared order, with the address the resolver gives.
function declaredCells(name) {
  const cells = [];
  let phase;
  for (const line of readKit().find(r => r.word === 'playbook' && r.name === name).body) {
    const head = /^    (orient|plan|act|learn)$/.exec(line);
    if (head) { phase = head[1]; continue; }
    const cell = /^      (Attention|Inference|Decision|Learning) means "(.*)"$/.exec(line);
    if (cell && phase) cells.push({ phase, primitive: cell[1], text: cell[2] });
  }
  const order = ['orient', 'plan', 'act', 'learn'];
  return order.flatMap(p => cells.filter(c => c.phase === p)).map(c => ({ address: `governance-system/definition/procedure/${name}#${c.phase}/${c.primitive}`, text: c.text }));
}

// What the README's delivery table says each recommended key delivers, read
// from the table itself, with the keys of its bind.mjs lines.
function readmeDelivery() {
  const body = readFileSync(join(KIT, 'README.md'), 'utf8');
  const bound = Object.fromEntries([...body.matchAll(/scripts\/bind\.mjs" set '?(knowledge\.[a-z*-]+)'? (\S+) (\S+)$/gm)].map(m => [m[1], m[3]]));
  const rows = [];
  for (const line of body.split('\n').filter(l => /^\| `knowledge\./.test(l))) {
    const cols = line.split('|').slice(1, -1).map(c => c.trim());
    const keys = [...cols[0].matchAll(/`(knowledge\.[a-z*-]+)`/g)].map(m => m[1]);
    const capability = /^`([a-z0-9-]+)`$/.exec(cols[1])?.[1];
    const playbook = /^16 cells of `([a-z0-9-]+)`/.exec(cols[2])?.[1];
    const profile = /`([a-z0-9-]+-profile)`/.exec(cols[3])?.[1] ?? null;
    const required = [...cols[4].matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]).sort();
    for (const key of keys) rows.push({ key, capability, playbook, profile, required });
  }
  return { bound, rows };
}

// What the records say each capability delivers: its one playbook, the one
// profile that composes it (if any) and that profile's mandate, its checks.
function recordDelivery(capability) {
  const records = readKit();
  const cap = records.find(r => r.word === 'capability' && r.name === capability);
  const playbook = /@playbook ([a-z0-9-]+)/.exec(field(cap, 'composition', 'playbooks') ?? '')?.[1];
  const profile = records.find(r => r.word === 'agent-profile' && new RegExp(`@capability ${capability}\\b`).test(field(r, 'composition', 'capabilities') ?? ''));
  const mandate = profile ? /@mandate ([a-z0-9-]+)/.exec(field(profile, 'composition', 'mandate'))[1] : null;
  const required = [...(field(cap, 'composition', 'checks') ?? '').matchAll(/@check ([a-z0-9-]+)/g)].map(m => m[1]).sort();
  return { playbook, profile: profile?.name ?? null, mandate, required };
}

function resolveAsync(root, activity, env, seat) {
  return new Promise((done, fail) => {
    const args = [join(PLUGIN, 'scripts', 'resolve.mjs'), '--entry', 'knowledge', '--activity', activity, '--root', root, '--json', ...(seat ? ['--seat', seat] : [])];
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', fail);
    child.on('close', code => {
      let packet;
      try { packet = JSON.parse(out); } catch { return fail(new Error(`${activity}: exit ${code}, not JSON: ${out.slice(0, 500)} ${err.slice(0, 500)}`)); }
      if (code !== 0) return fail(new Error(`${activity}: exit ${code}: ${JSON.stringify(packet.error ?? packet).slice(0, 800)}`));
      done(packet);
    });
  });
}

// Runs the jobs `width` at a time; ia position, inspect and read write nothing
// into the workspace, so concurrent resolves of one root do not interfere.
async function pool(jobs, width = 6) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); }
  }));
  return results;
}

function initWorkspace(base, name) {
  const repo = join(base, name);
  const init = spawnSync(process.execPath, [CLI, 'init', repo, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return repo;
}

function writeBindings(repo, bound) {
  const bindings = Object.fromEntries(Object.entries(bound).map(([key, capability]) => [key, { kit: KIT_ID, capability }]));
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings }, null, 2) + '\n');
}

// Every activity a README row names: the wildcard row resolves as packet and
// as an activity no key names.
const activitiesOf = key => (key === 'knowledge.*' ? ['packet', 'no-such-activity'] : [key.slice('knowledge.'.length)]);

function assertDelivery(packet, row, where, expectedSeat = null) {
  const label = `${row.key} ${where}`;
  const fromRecords = recordDelivery(row.capability);
  assert.equal(packet.binding.capability, row.capability, label);
  assert.equal(row.playbook, fromRecords.playbook, `${label}: the README names the capability's playbook`);
  assert.equal(row.profile, fromRecords.profile, `${label}: the README names the composing profile`);
  assert.deepEqual(row.required, fromRecords.required, `${label}: the README names the capability's checks`);
  assert.deepEqual(packet.instructions.map(c => ({ address: c.address, text: c.text })), declaredCells(row.playbook), `${label}: all sixteen cells in phase order`);
  assert.equal(packet.instructions.length, 16, label);
  for (const cell of packet.instructions) assert.equal(cell.source, 'playbook', `${label}: ${cell.address}`);
  assert.equal(packet.role.profile, row.profile ? `agent-composition-system/binding/agent-profile/${row.profile}` : null, `${label}: role`);
  const laws = packet.references.filter(r => r.identity.startsWith('governance-system/governance/law/'));
  assert.deepEqual(laws.map(r => r.identity).sort(), LAWS, `${label}: the five laws`);
  for (const law of laws) assert.equal(law.when, 'always', `${label}: ${law.identity}`);
  const roleMandates = packet.references.filter(r => r.when === 'role').map(r => r.identity);
  assert.deepEqual(roleMandates, fromRecords.mandate ? [`agent-system/policy/mandate/${fromRecords.mandate}`] : [], `${label}: the role's mandate`);
  assert.deepEqual(packet.evidence.required, row.required, `${label}: evidence.required`);
  assert.deepEqual(packet.missing.filter(m => m.kind === 'seat'), expectedSeat ? [{ kind: 'seat', message: `--seat ${expectedSeat} selects the consumer's position, whose laws and mandates the packet carries; method instructions come from the isolated kit` }] : [], `${label}: consumer seat diagnostic`);
  const kinds = [...new Set(packet.missing.filter(m => m.kind !== 'seat').map(m => m.kind))];
  assert.deepEqual(kinds, row.required.length ? ['enforcement'] : [], `${label}: missing ${JSON.stringify(packet.missing)}`);
}

test('REQ-KB-08 success: every recommended binding delivers its whole playbook and the laws once the kit is installed, and an uninstalled kit is refused', { skip: SKIP }, async t => {
  const { bound, rows } = readmeDelivery();
  assert.equal(Object.keys(bound).length, Object.keys(BINDINGS).length);
  assert.deepEqual(rows.map(r => r.key).sort(), Object.keys(bound).sort(), 'the delivery table covers every bind.mjs line, once');
  for (const row of rows) assert.equal(row.capability, bound[row.key], `${row.key}: the table and the bind.mjs line agree`);
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-delivery-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const temp = join(base, 'temp');
  mkdirSync(temp);
  const env = { ...ENV_CLEAN(process.env), IA_CLI_PATH: CLI, TMPDIR: temp, TEMP: temp, TMP: temp, IA_CORE_CLOSURES_DIR: join(temp, 'closures') };
  const jobs = (root, seat) => rows.flatMap(row => activitiesOf(row.key).map(activity => async () => ({ row, packet: await resolveAsync(root, activity, env, seat) })));

  // A workspace that binds the kit while its lock does not install it is refused.
  const restored = initWorkspace(base, 'restored');
  writeBindings(restored, bound);
  const refused = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'resolve.mjs'), '--entry', 'knowledge', '--activity', 'check', '--root', restored, '--json'], { env, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'IA-CORE-KIT-NOT-INSTALLED');
  assert.equal(refusal.kit, KIT_ID);

  // In a repository that adopted the kit and holds a @spec, at its workspace
  // seat and with --seat at the @spec.
  const { resolveCli } = await import('../scripts/lib/cli.mjs');
  const { adopt } = await import('../scripts/lib/kit.mjs');
  const adopted = initWorkspace(base, 'adopted');
  assert.ok(adopt(adopted, findKit(KIT_ID), { cli: resolveCli(adopted, { env: { IA_CLI_PATH: CLI } }) }).written.length > 0);
  mkdirSync(join(adopted, 'docs'));
  writeFileSync(join(adopted, 'docs', 'model-api.md'), '# Model API\n\nA design.\n');
  writeFileSync(join(adopted, '.ia', 'src', 'docs.ia'), ['#! ia 1.0', '', '@spec model-api', '  meaning', '    says "The model API design."', '    answers "Where is the model API design?"', '  work', '    title "Model API"', '    status draft', '    owner "Docs owner"', '    source "docs/model-api.md"', ''].join('\n'));
  const validated = ia(adopted, ['validate']);
  assert.equal(validated.json?.status, 'admitted', validated.stdout.slice(0, 2000));
  writeBindings(adopted, bound);
  for (const [seat, where] of [[null, 'adopted, workspace seat'], [SPEC_SEAT, 'adopted, @spec seat']]) {
    for (const { row, packet } of await pool(jobs(adopted, seat))) {
      assert.equal(packet.envelope.kitInstalled, true, where);
      assert.equal(packet.scope.seat, seat ?? 'workspace-system/definition/workspace/adopted', where);
      assert.notEqual(packet.envelope.kitRoot, adopted);
      assertDelivery(packet, row, where, seat);
    }
  }
});

test('REQ-KB-08 failure: a capability delivery.json leaves out arrives as the position\'s cells', { skip: SKIP }, async t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-kb-kit-partial-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const kits = join(base, 'kits');
  cpSync(KIT, join(kits, 'ia-kb'), { recursive: true });
  const temp = join(base, 'temp');
  mkdirSync(temp);
  const repo = initWorkspace(base, 'repo');
  writeBindings(repo, { 'knowledge.check': 'kb-check' });
  // The lock must install the kit before a binding to it runs: adopt the unchanged copy, then leave kb-check out of
  // the scratch copy's delivery.json (the resolver reads the declaration from IA_CORE_KITS_DIR).
  const { resolveCli } = await import('../scripts/lib/cli.mjs');
  const { adopt } = await import('../scripts/lib/kit.mjs');
  assert.ok(adopt(repo, findKit(KIT_ID, kits), { cli: resolveCli(repo, { env: { IA_CLI_PATH: CLI } }) }).written.length > 0);
  const delivery = join(kits, 'ia-kb', 'delivery.json');
  const parsed = JSON.parse(readFileSync(delivery, 'utf8'));
  writeFileSync(delivery, JSON.stringify({ ...parsed, whole: parsed.whole.filter(n => n !== 'kb-check') }, null, 2) + '\n');
  const env = { ...ENV_CLEAN(process.env), IA_CLI_PATH: CLI, TMPDIR: temp, TEMP: temp, TMP: temp, IA_CORE_KITS_DIR: kits, IA_CORE_CLOSURES_DIR: join(temp, 'closures') };
  const packet = await resolveAsync(repo, 'check', env, null);
  assert.deepEqual(packet.instructions.map(c => [c.address, c.source]), [['governance-system/definition/procedure/kb-check#orient/Attention', 'position']]);
});

// The kit declares nine assets: packing its sources reproduces the recorded
// archive only when buildKit copies them into the pack root (ia pack refuses
// a missing explicit asset), which is what adopt runs.
test('real CLI: the sources and declared assets repack to the recorded release (opt-in: IA_CORE_TEST_CLI)', { skip: SKIP }, async () => {
  const { resolveCli } = await import('../scripts/lib/cli.mjs');
  const { DEFAULT_KITS_DIR, findKit, packRelease } = await import('../scripts/lib/kit.mjs');
  const kit = findKit(KIT_ID, DEFAULT_KITS_DIR);
  assert.equal(JSON.parse(readFileSync(join(KIT, '.ia', 'release.json'), 'utf8')).assets.length, ASSETS.length);
  const cli = resolveCli(KIT, { env: { IA_CLI_PATH: CLI } });
  const built = packRelease(kit, kit.latest, cli);
  try {
    assert.equal(built.digest, kit.latest.archive);
  } finally { built.cleanup(); }
});
