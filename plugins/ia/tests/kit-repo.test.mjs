// Qualification and unit tests for inventarch/ia-repo-kit (repo-system 0.1.0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adopt, findKit, sourcesDigest } from '../scripts/lib/kit.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { expandFolder } from '../scripts/lib/releases.mjs';
import { FORMAT, PACKAGE_KINDS, checkLayers, isCanonicalRepoPath, isCredentialFreeLocator } from '../config/kits/ia-repo/scripts/layer-checker.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-repo');
const SOURCE_KIT = join(REPO_ROOT, 'kits', 'ia-repo');
const KIT_ID = 'inventarch/ia-repo-kit';
const SYSTEM = 'repo-system';
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const ROLES = ['documentation', 'asset'];
const WORDS = ['area', 'layer', 'package', 'repository'];

const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

function parseRecords(kitDir = KIT) {
  const srcRoot = join(kitDir, '.ia', 'src');
  const records = [];
  for (const file of walk(srcRoot).filter(f => f.endsWith('.ia')).sort()) {
    const rel = relative(srcRoot, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('#! ia 1.0\n'), `${rel}: native header`);
    for (const block of text.split(/^(?=@)/m).filter(b => b.startsWith('@'))) {
      const lines = block.trimEnd().split('\n');
      const [, word, name] = /^@([a-z-]+)\s+([a-z0-9-]+)$/.exec(lines[0]) ?? [];
      assert.ok(word && name, `${rel}: malformed header ${lines[0]}`);
      records.push({ file: rel, word, name, body: lines.slice(1) });
    }
  }
  return records;
}

function sectionField(record, section, key) {
  let inSection = false;
  for (const line of record.body) {
    if (/^  [a-z-]+$/.test(line)) inSection = line.trim() === section;
    else if (inSection) {
      const m = new RegExp(`^    ${key} (.*)$`).exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

const unquote = v => (typeof v === 'string' && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function checksProblems(records, checks) {
  const problems = [];
  if (checks.format !== 1) problems.push('checks.json: format must be 1');
  const declared = Object.fromEntries(records.filter(r => r.word === 'check').map(r => [r.name, unquote(sectionField(r, 'check', 'scope'))]));
  for (const [name, spec] of Object.entries(checks.checks ?? {})) {
    if (!(name in declared)) {
      problems.push(`${name}: not a @check record`);
      continue;
    }
    if (name === `${SYSTEM}-coverage`) problems.push(`${name}: coverage check is evaluated by IA`);
    if (!Array.isArray(spec.argv) || !spec.argv.length || !spec.argv.every(a => typeof a === 'string' && a.length)) {
      problems.push(`${name}: argv`);
      continue;
    }
    if (!['workspace', 'kit', 'plugin'].includes(spec.cwd ?? 'workspace')) problems.push(`${name}: cwd`);
    const command = spec.argv.map(a => ({ '${NODE}': 'node', '${IA}': 'ia' })[a] ?? a).join(' ');
    if (command !== declared[name]) problems.push(`${name}: argv ${command} differs from check.scope ${declared[name]}`);
  }
  const gates = Object.keys(declared).filter(n => n !== `${SYSTEM}-coverage`).sort();
  if (JSON.stringify(Object.keys(checks.checks ?? {}).sort()) !== JSON.stringify(gates)) {
    problems.push(`checks.json must name exactly ${gates.join(', ')}`);
  }
  for (const gate of gates) {
    if (!declared[gate]) problems.push(`${gate}: empty check.scope`);
  }
  return problems;
}

function assetProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const problems = [];
  for (const asset of descriptor.assets) {
    const full = join(root, asset.path);
    if (!ROLES.includes(asset.role)) problems.push(`${asset.path}: invalid role ${asset.role}`);
    if (!existsSync(full)) {
      problems.push(`${asset.path}: missing`);
      continue;
    }
    if (asset.path.endsWith('.md') && asset.role !== 'documentation') problems.push(`${asset.path}: expected documentation role`);
    if (!asset.path.endsWith('.md') && asset.role !== 'asset') problems.push(`${asset.path}: expected asset role`);
  }
  const shipped = ['assets', 'scripts']
    .filter(d => existsSync(join(root, d)))
    .flatMap(d => walk(join(root, d)))
    .map(f => relative(root, f).replace(/\\/g, '/'));
  for (const rel of shipped) {
    if (!descriptor.assets.some(a => a.path === rel)) problems.push(`${rel}: shipped but not listed in release.json`);
  }
  if (existsSync(join(root, 'checks.json')) && !descriptor.assets.some(a => a.path === 'checks.json')) {
    problems.push('checks.json: missing from release.json assets');
  }
  return problems;
}

function releaseProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const index = JSON.parse(readFileSync(join(root, 'releases.json'), 'utf8'));
  const problems = [];
  if (index.format !== 2) problems.push('releases.json: expected format 2');
  if (index.kit !== descriptor.id) problems.push(`releases.json kit ${index.kit} !== ${descriptor.id}`);
  const expanded = expandFolder(root);
  const recorded = expanded.releases.find(r => r.version === descriptor.version);
  if (!recorded) {
    problems.push(`releases.json records no release ${descriptor.version}`);
    return problems;
  }
  if (recorded.sources !== sourcesDigest(root)) problems.push('sources digest mismatch');
  if (JSON.stringify(recorded.records) !== JSON.stringify(kitRecordNames(root))) problems.push('recorded records mismatch');
  return problems;
}

// Synthetic ia-records snapshot builders for unit testing checkLayers
const strVal = text => ({ kind: 'string', text });
const numVal = value => ({ kind: 'scalar', text: String(value), value });
const refVal = (discriminator, name) => ({ kind: 'ref', discriminator, name });
const listVal = items => ({ kind: 'list', items });
const reqEdge = (discriminator, name) => ({
  predicate: 'require',
  direction: 'out',
  reference: { kind: 'ref', discriminator, name },
  target: null,
});

function synRepo(name, url, { profile = null, organisation = null, kb = null } = {}) {
  const fields = [{ key: 'url', value: strVal(url) }];
  if (profile !== null) fields.push({ key: 'profile', value: strVal(profile) });
  if (organisation !== null) fields.push({ key: 'organisation', value: strVal(organisation) });
  if (kb !== null) fields.push({ key: 'knowledge-base', value: strVal(kb) });
  return {
    identity: `repo-system/definition/repository/${name}`,
    discriminator: 'repository',
    name,
    provenance: 'workspace',
    source: { path: '.ia/src/repository.ia', line: 3 },
    sections: [{ name: 'repository', fields }],
    edges: [],
  };
}

function synLayer(name, rank, { paths = [], requires = [], provenance = 'workspace' } = {}) {
  const fields = [
    { key: 'rank', value: numVal(rank) },
    { key: 'title', value: strVal(name) },
  ];
  if (paths.length) fields.push({ key: 'paths', value: listVal(paths.map(strVal)) });
  return {
    identity: `repo-system/definition/layer/${name}`,
    discriminator: 'layer',
    name,
    provenance,
    source: { path: '.ia/src/layers.ia', line: 3 },
    sections: [{ name: 'layer', fields }],
    edges: requires.map(r => reqEdge('layer', r)),
  };
}

function synPkg(name, path, layerName, { kind = null, reqLayers = [layerName], reqPkgs = [], repository = null } = {}) {
  const fields = [
    { key: 'name', value: strVal(`@acme/${name}`) },
    { key: 'path', value: strVal(path) },
    { key: 'layer', value: refVal('layer', layerName) },
  ];
  if (kind !== null) fields.push({ key: 'kind', value: strVal(kind) });
  if (repository !== null) fields.push({ key: 'repository', value: refVal('repository', repository) });
  return {
    identity: `repo-system/definition/package/${name}`,
    discriminator: 'package',
    name,
    provenance: 'workspace',
    source: { path: '.ia/src/packages.ia', line: 3 },
    sections: [{ name: 'package', fields }],
    edges: [...reqLayers.map(l => reqEdge('layer', l)), ...reqPkgs.map(p => reqEdge('package', p))],
  };
}

function synArea(name, pkgNames, { reqAreas = [] } = {}) {
  return {
    identity: `repo-system/definition/area/${name}`,
    discriminator: 'area',
    name,
    provenance: 'workspace',
    source: { path: '.ia/src/areas.ia', line: 3 },
    sections: [
      {
        name: 'area',
        fields: [
          { key: 'packages', value: listVal(pkgNames.map(p => refVal('package', p))) },
          { key: 'purpose', value: strVal(`${name} boundary`) },
        ],
      },
    ],
    edges: reqAreas.map(a => reqEdge('area', a)),
  };
}

test('REQ-REPO-01 success: the kit admits offline with steward hygiene, four word schemas and zero private content', { skip: SKIP_CLI }, t => {
  // Refuse private kit ids, private repo paths, hardcoded tier labels (L0-L7), Proprietary/UNLICENSED, PR numbers
  const deny = /private-|\b(?!ia-repo-kit\b)ia-[a-z]+(?:-[a-z]+)*-kit\b|inventarch\/(?!ia-repo-kit\b|language\b|cli\b|marketplace\.git\b)|inventarch-[a-z]|\bL[0-7]\b|Proprietary|UNLICENSED|PR #\d+|#\d{2,}/i;
  for (const root of [KIT, SOURCE_KIT]) {
    const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
    assert.equal(descriptor.id, KIT_ID);
    assert.equal(descriptor.license, 'Apache-2.0');
    for (const file of walk(root).filter(f => !relative(root, f).replace(/\\/g, '/').startsWith('releases'))) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes(0x0d), false, `${relative(root, file)}: CR byte found`);
      const lines = bytes.toString('utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        assert.doesNotMatch(line, deny, `${relative(root, file)}:${i + 1}`);
      }
    }
  }

  const records = parseRecords(KIT);
  assert.ok(records.some(r => r.word === 'system' && r.name === SYSTEM));
  assert.ok(records.some(r => r.word === 'agent' && r.name === `${SYSTEM}-steward`));
  assert.ok(records.some(r => r.word === 'mandate' && r.name === `${SYSTEM}-stewardship`));
  for (const word of WORDS) {
    assert.ok(records.some(r => r.word === 'schema' && r.name === word), `missing @schema ${word}`);
    assert.ok(records.some(r => r.word === 'convention' && r.name === `repo-guide-${word}`), `missing authoring guide convention for ${word}`);
  }

  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-req01-ok-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const ws = join(scratch, 'ws');
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(join(KIT, '.ia'), join(ws, '.ia'), { recursive: true });
  cpSync(join(KIT, 'assets'), join(ws, 'assets'), { recursive: true });
  cpSync(join(KIT, 'scripts'), join(ws, 'scripts'), { recursive: true });
  cpSync(join(KIT, 'checks.json'), join(ws, 'checks.json'));

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', ws, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);
  assert.equal(JSON.parse(restore.stdout).applied?.status, 'installed');

  const validate = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const verdict = JSON.parse(validate.stdout);
  assert.equal(verdict.status, 'admitted');
  assert.equal(verdict.counts.errors, 0);
});

test('REQ-REPO-01 failure: unknown evaluators and duplicate word owners are refused', { skip: SKIP_CLI }, t => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-req01-fail-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  // 1. Unknown evaluator refused at restore
  const wsEval = join(scratch, 'eval');
  const homeEval = join(scratch, 'home-eval');
  mkdirSync(homeEval, { recursive: true });
  cpSync(join(KIT, '.ia'), join(wsEval, '.ia'), { recursive: true });
  const compPath = join(wsEval, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(compPath, readFileSync(compPath, 'utf8').replace('runs COMP-CHECK\n    scope "ia validate --json"', 'runs UNKNOWN-EVAL\n    scope "ia validate --json"'));

  const restoreEval = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', wsEval, '--json'], {
    env: { ...process.env, IA_HOME: homeEval, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(restoreEval.status, 0);
  assert.match(restoreEval.stdout + restoreEval.stderr, /IA-COMP-CHECK-UNKNOWN/);

  // 2. Composing a second system that mints `layer` is refused at validation
  const wsDup = join(scratch, 'dup');
  const homeDup = join(scratch, 'home-dup');
  mkdirSync(homeDup, { recursive: true });
  cpSync(join(KIT, '.ia'), join(wsDup, '.ia'), { recursive: true });
  mkdirSync(join(wsDup, '.ia', 'src', 'systems', 'shadow-system'), { recursive: true });
  writeFileSync(
    join(wsDup, '.ia', 'src', 'systems', 'shadow-system', 'system.ia'),
    `#! ia 1.0

@system shadow-system
  provider "local"
  version "0.1.0"
  describes "Conflicting system minting layer."
  steward @agent shadow-steward
  requires
    - agent-system
  discriminators
    layer lowers to definition
      category boundary
      facets [layer]
      schema @schema shadow-layer
      artifact-set product-definition
      primitive Attention
      move Observation

@schema shadow-layer
  lowers to definition
  sections
    must have meaning
    closed
  fields
    must have meaning.says as text

@agent shadow-steward
  meaning
    says "Shadow steward."
    answers "Who?"
  governance
    applies [layer]
`,
  );
  const wsPath = join(wsDup, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsPath, readFileSync(wsPath, 'utf8').replace('@system repo-system]', '@system repo-system, @system shadow-system]'));

  spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', wsDup, '--json'], {
    env: { ...process.env, IA_HOME: homeDup, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const valDup = spawnSync(process.execPath, [CLI, 'validate', '--root', wsDup, '--json'], {
    env: { ...process.env, IA_HOME: homeDup, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const dupJson = JSON.parse(valDup.stdout);
  assert.notEqual(dupJson.status, 'admitted');
});

test('REQ-REPO-02 success: checks, assets and format 2 release metadata match', () => {
  const records = parseRecords(KIT);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.deepEqual(checksProblems(records, checks), []);
  assert.deepEqual(assetProblems(KIT), []);
  assert.deepEqual(releaseProblems(KIT), []);
});

test('REQ-REPO-02 failure: drifted checks, assets and releases are refused', t => {
  const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-req02-fail-')));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(KIT, copy, { recursive: true });

  const compPath = join(copy, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  const originalComp = readFileSync(compPath, 'utf8');
  writeFileSync(compPath, originalComp.replace('scope "ia validate --json"', 'scope ""'));
  assert.ok(checksProblems(parseRecords(copy), JSON.parse(readFileSync(join(copy, 'checks.json'), 'utf8'))).length > 0);
  writeFileSync(compPath, originalComp);

  writeFileSync(join(copy, 'assets', 'stray.md'), '# stray\n');
  assert.match(assetProblems(copy).join('\n'), /stray\.md: shipped but not listed/);
  rmSync(join(copy, 'assets', 'stray.md'));

  writeFileSync(compPath, `${originalComp}\n`);
  assert.match(releaseProblems(copy).join('\n'), /sources digest mismatch/);
});

test('REQ-REPO-03 success: all four words, seven package kinds, unclassified packages and spec citations admit', { skip: SKIP_CLI }, t => {
  assert.deepEqual([...PACKAGE_KINDS], ['host', 'contract', 'core', 'adapter', 'view', 'composition', 'tool']);
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-req03-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  const init = spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  adopt(ws, findKit('ia-repo'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });

  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system repo-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'structure.ia'),
    `#! ia 1.0

@decision boundary-decision
  meaning
    says "Split contracts from adapters."
  work
    title "Boundary split"
    status made
  decision
    question "How are boundaries split?"
    decider "Maintainers"
    choice "Layered packages"
    rationale "Offline verifiable."

@repository service-repo
  meaning
    says "Primary service repository."
  repository
    url "https://example.org/acme/service.git"
    profile "four-tier"
    organisation "workspace-system/definition/workspace/acme-org"
    knowledge-base "https://example.org/acme/org-kb.git"

@layer contracts-tier
  meaning
    says "Shared wire contracts."
  layer
    rank 10
    title "Contracts"
    paths ["packages/contracts"]
    repository @repository service-repo

@layer domain-tier
  meaning
    says "Pure domain logic."
  layer
    rank 20
    title "Domain"
    paths ["packages/core"]
    repository @repository service-repo
  relationships
    requires @layer contracts-tier

@layer integration-tier
  meaning
    says "Adapters, views and compositions."
  layer
    rank 30
    title "Integration"
    paths ["packages/adapters", "packages/views", "packages/compositions"]
    repository @repository service-repo
  relationships
    requires @layer domain-tier

@layer runtime-tier
  meaning
    says "Deployable hosts and build tooling."
  layer
    rank 40
    title "Runtime and Tooling"
    paths ["apps", "tools"]
    repository @repository service-repo
  relationships
    requires @layer integration-tier

@package pkg-contract
  meaning
    says "Contract types."
  package
    name "@acme/contract"
    path "packages/contracts/core"
    layer @layer contracts-tier
    kind contract
    repository @repository service-repo
  relationships
    requires @layer contracts-tier

@package pkg-core
  meaning
    says "Domain engine."
  package
    name "@acme/core"
    path "packages/core/engine"
    layer @layer domain-tier
    kind core
    repository @repository service-repo
  relationships
    requires @layer domain-tier
    requires @package pkg-contract

@package pkg-adapter
  meaning
    says "Storage adapter."
  package
    name "@acme/adapter"
    path "packages/adapters/storage"
    layer @layer integration-tier
    kind adapter
    repository @repository service-repo
  relationships
    requires @layer integration-tier
    requires @package pkg-core

@package pkg-view
  meaning
    says "UI components."
  package
    name "@acme/view"
    path "packages/views/dashboard"
    layer @layer integration-tier
    kind view
    repository @repository service-repo
  relationships
    requires @layer integration-tier
    requires @package pkg-contract

@package pkg-composition
  meaning
    says "Slice composition."
  package
    name "@acme/composition"
    path "packages/compositions/main"
    layer @layer integration-tier
    kind composition
    repository @repository service-repo
  relationships
    requires @layer integration-tier
    requires @package pkg-core
    requires @package pkg-adapter
    requires @package pkg-view

@package pkg-host
  meaning
    says "HTTP server entrypoint."
  package
    name "@acme/server"
    path "apps/server"
    layer @layer runtime-tier
    kind host
    repository @repository service-repo
  relationships
    requires @layer runtime-tier
    requires @package pkg-composition

@package pkg-tool
  meaning
    says "Schema generator."
  package
    name "@acme/codegen"
    path "tools/codegen"
    layer @layer runtime-tier
    kind tool
    repository @repository service-repo
  relationships
    requires @layer runtime-tier
    requires @package pkg-contract

@package pkg-unclassified
  meaning
    says "Unclassified legacy utility package."
  package
    name "@acme/legacy"
    path "packages/contracts/legacy"
    layer @layer contracts-tier
    repository @repository service-repo
  relationships
    requires @layer contracts-tier

@area foundation-area
  meaning
    says "Shared contract area."
  area
    packages [@package pkg-contract, @package pkg-unclassified]
    purpose "Foundational wire schemas."
    repository @repository service-repo

@area service-area
  meaning
    says "End-to-end service area."
  area
    packages [@package pkg-core, @package pkg-adapter, @package pkg-view, @package pkg-composition, @package pkg-host]
    purpose "Core product delivery slice."
    repository @repository service-repo
  relationships
    requires @area foundation-area
    cites @decision boundary-decision

@spec service-architecture
  meaning
    says "Architecture specification citing all four repository words."
  work
    title "Service architecture"
    status draft
  relationships
    cites @repository service-repo
    cites @layer domain-tier
    cites @package pkg-core
    cites @area service-area
`,
  );

  const validate = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const verdict = JSON.parse(validate.stdout);
  assert.equal(verdict.status, 'admitted');
  assert.equal(verdict.counts.errors, 0);
});

test('REQ-REPO-03 failure: splicing out any of the three area consent rows refuses with IA-LANG-EDGE-UNCONSENTED', { skip: SKIP_CLI }, t => {
  const probes = [
    {
      row: 'cite * using area',
      snippet: `@area billing
  meaning
    says "Billing area citing a decision."
  area
    packages [@package pkg-a]
    purpose "Billing."
  relationships
    cites @decision dec-a
`,
    },
    {
      row: 'require area using area',
      snippet: `@area base-area
  meaning
    says "Base area."
  area
    packages [@package pkg-a]
    purpose "Base."

@area child-area
  meaning
    says "Child area requiring base-area."
  area
    packages [@package pkg-a]
    purpose "Child."
  relationships
    requires @area base-area
`,
    },
    {
      row: 'cite area using spec',
      snippet: `@area billing
  meaning
    says "Billing area."
  area
    packages [@package pkg-a]
    purpose "Billing."

@spec billing-spec
  meaning
    says "Spec citing an area."
  work
    title "Billing spec"
    status draft
  relationships
    cites @area billing
`,
    },
  ];

  for (const probe of probes) {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-consent-')));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const ws = join(scratch, 'ws');
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    cpSync(join(KIT, '.ia'), join(ws, '.ia'), { recursive: true });

    const sysPath = join(ws, '.ia', 'src', 'systems', SYSTEM, 'system.ia');
    const originalSys = readFileSync(sysPath, 'utf8');
    assert.ok(originalSys.includes(`    ${probe.row}\n`), `system.ia carries ${probe.row}`);
    writeFileSync(sysPath, originalSys.replace(`    ${probe.row}\n`, ''));

    writeFileSync(
      join(ws, '.ia', 'src', 'probe.ia'),
      `#! ia 1.0

@decision dec-a
  meaning
    says "Anchor decision."
  work
    title "Anchor"
    status draft
  decision
    question "Why?"

@layer tier-a
  meaning
    says "Tier A."
  layer
    rank 1
    title "Tier A"

@package pkg-a
  meaning
    says "Pkg A."
  package
    name "@acme/a"
    path "packages/a"
    layer @layer tier-a

${probe.snippet}`,
    );

    const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', ws, '--json'], {
      env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
      encoding: 'utf8',
      windowsHide: true,
    });
    const validate =
      restore.status === 0
        ? spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], {
            env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
            encoding: 'utf8',
            windowsHide: true,
          })
        : { stdout: '', stderr: '' };
    const combined = `${restore.stdout}${restore.stderr}${validate.stdout}${validate.stderr}`;
    assert.match(combined, /IA-LANG-EDGE-UNCONSENTED/, `removing "${probe.row}" must refuse with IA-LANG-EDGE-UNCONSENTED`);
  }
});

test('REQ-REPO-04 success: check-layers accepts valid arbitrary-rank topologies and dependency roles', () => {
  assert.equal(isCanonicalRepoPath('packages/core/engine'), true);
  assert.equal(isCanonicalRepoPath('../escape'), false);
  assert.equal(isCanonicalRepoPath('/abs/path'), false);
  assert.equal(isCanonicalRepoPath('win\\path'), false);
  assert.equal(isCredentialFreeLocator('https://github.com/example/repo.git'), true);
  assert.equal(isCredentialFreeLocator('git@github.com:example/repo.git'), true);
  assert.equal(isCredentialFreeLocator('https://token:secret@github.com/example/repo.git'), false);

  // Arbitrary ranks (e.g. -5, 100, 250, 500) + path-less adopted layer profile + all 7 kinds + unclassified
  const report = checkLayers({
    revision: 'rev-ok',
    records: [
      synRepo('main-repo', 'https://example.org/acme/monorepo.git', {
        profile: 'custom-ranks',
        organisation: 'workspace-system/definition/workspace/acme',
        kb: 'https://example.org/acme/kb.git',
      }),
      synLayer('contracts', -5, { provenance: 'adopted' }),
      synLayer('domain', 100, { requires: ['contracts'], paths: ['packages/domain'] }),
      synLayer('wiring', 250, { requires: ['domain'], paths: ['packages/adapters', 'packages/views', 'packages/slices'] }),
      synLayer('entrypoints', 500, { requires: ['wiring'], paths: ['apps', 'tools'] }),
      synPkg('wire-types', 'packages/contracts/wire', 'contracts', { kind: 'contract' }),
      synPkg('unclassified-types', 'packages/contracts/raw', 'contracts'),
      synPkg('billing-domain', 'packages/domain/billing', 'domain', { kind: 'core', reqPkgs: ['wire-types'] }),
      synPkg('sql-adapter', 'packages/adapters/sql', 'wiring', { kind: 'adapter', reqPkgs: ['billing-domain', 'wire-types'] }),
      synPkg('billing-view', 'packages/views/billing', 'wiring', { kind: 'view', reqPkgs: ['wire-types'] }),
      synPkg('billing-slice', 'packages/slices/billing', 'wiring', { kind: 'composition', reqPkgs: ['billing-domain', 'sql-adapter', 'billing-view'] }),
      synPkg('api-host', 'apps/api', 'entrypoints', { kind: 'host', reqPkgs: ['billing-slice'] }),
      synPkg('schema-tool', 'tools/schema', 'entrypoints', { kind: 'tool', reqPkgs: ['wire-types'] }),
      synArea('contracts-area', ['wire-types', 'unclassified-types']),
      synArea('billing-area', ['billing-domain', 'sql-adapter', 'billing-view', 'billing-slice', 'api-host'], { reqAreas: ['contracts-area'] }),
    ],
  });

  assert.equal(report.format, FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test('REQ-REPO-04 failure: check-layers refuses rank inversions, cycles, bad paths, credentialed URLs and role violations', () => {
  const report = checkLayers({
    revision: 'rev-bad',
    records: [
      synRepo('cred-repo', 'https://user:secret@example.org/acme/repo.git'),
      // Upward layer require (rank 10 requiring rank 20) + layer cycle (l-a <-> l-b)
      synLayer('low', 10, { requires: ['high'], paths: ['/bad/abs'] }),
      synLayer('high', 20),
      synLayer('cyc-a', 30, { requires: ['cyc-b'] }),
      synLayer('cyc-b', 30, { requires: ['cyc-a'] }),
      // Overlapping paths + package.layer mismatch + upward package require + role violations + package cycle
      synPkg('contract-bad', 'packages/shared', 'low', {
        kind: 'contract',
        reqLayers: ['high'],
        reqPkgs: ['adapter-high'],
      }),
      synPkg('overlap-pkg', 'packages/shared/nested', 'low', { kind: 'contract' }),
      synPkg('core-bad', 'packages/core', 'high', { kind: 'core', reqPkgs: ['adapter-high'] }),
      synPkg('adapter-high', 'packages/adapter', 'high', { kind: 'adapter', reqPkgs: ['host-top', 'tool-util'] }),
      synPkg('comp-1', 'packages/comp1', 'high', { kind: 'composition', reqPkgs: ['comp-2'] }),
      synPkg('comp-2', 'packages/comp2', 'high', { kind: 'composition', reqPkgs: ['comp-1'] }),
      synPkg('host-top', 'apps/web', 'high', { kind: 'host' }),
      synPkg('tool-util', 'tools/gen', 'high', { kind: 'tool' }),
      // Empty area + area cycle
      synArea('empty-area', []),
      synArea('area-1', ['host-top'], { reqAreas: ['area-2'] }),
      synArea('area-2', ['tool-util'], { reqAreas: ['area-1'] }),
    ],
  });

  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map(f => f.code));
  for (const expected of [
    'REPOSITORY_URL',
    'CANONICAL_PATH',
    'LAYER_RANK_ORDER',
    'LAYER_CYCLE',
    'PACKAGE_PATH_OVERLAP',
    'PACKAGE_LAYER_MISMATCH',
    'PACKAGE_LAYER_ORDER',
    'CONTRACT_PURITY',
    'CORE_PURITY',
    'HOST_DEPENDENCY',
    'TOOL_DEPENDENCY',
    'COMPOSITION_ISOLATION',
    'PACKAGE_CYCLE',
    'AREA_EMPTY',
    'AREA_CYCLE',
  ]) {
    assert.ok(codes.has(expected), `expected finding ${expected}, got ${[...codes].join(', ')}`);
  }
});

test('REQ-REPO-05 success: check.mjs runs repo-check-validate and check-layers to exit 0 on a sound workspace', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-runner-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-repo'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system repo-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'repo.ia'),
    `#! ia 1.0

@repository clean-repo
  meaning
    says "Clean layered repository."
  repository
    url "https://example.org/acme/clean.git"

@layer base-layer
  meaning
    says "Base contracts."
  layer
    rank 1
    title "Base"

@layer app-layer
  meaning
    says "Application core."
  layer
    rank 2
    title "Application"
  relationships
    requires @layer base-layer

@package base-contracts
  meaning
    says "Contracts package."
  package
    name "@acme/contracts"
    path "packages/contracts"
    layer @layer base-layer
    kind contract
  relationships
    requires @layer base-layer

@package app-core
  meaning
    says "Core package."
  package
    name "@acme/core"
    path "packages/core"
    layer @layer app-layer
    kind core
  relationships
    requires @layer app-layer
    requires @package base-contracts

@area core-area
  meaning
    says "Core domain area."
  area
    packages [@package base-contracts, @package app-core]
    purpose "Core domain."
`,
  );

  for (const checkName of ['repo-check-validate', 'check-layers']) {
    const ran = spawnSync(
      process.execPath,
      [join(PLUGIN, 'scripts', 'check.mjs'), checkName, '--kit', KIT_ID, '--root', ws, '--cli', CLI],
      { env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(ran.status, 0, `${checkName}: ${ran.stdout}\n${ran.stderr}`);
    assert.equal(JSON.parse(ran.stdout).exitCode, 0);
  }
});

test('REQ-REPO-05 failure: check.mjs exits 3 when check-layers detects structural or role violations', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-repo-runner-fail-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-repo'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system repo-system]'));

  // Schema-admitted, but lower-ranked contract requires higher-ranked adapter!
  writeFileSync(
    join(ws, '.ia', 'src', 'repo.ia'),
    `#! ia 1.0

@layer low-layer
  meaning
    says "Low layer."
  layer
    rank 1
    title "Low"

@layer high-layer
  meaning
    says "High layer."
  layer
    rank 2
    title "High"
  relationships
    requires @layer low-layer

@package high-adapter
  meaning
    says "Adapter."
  package
    name "@acme/adapter"
    path "packages/adapter"
    layer @layer high-layer
    kind adapter

@package bad-contract
  meaning
    says "Contract importing upward adapter."
  package
    name "@acme/contract"
    path "packages/contract"
    layer @layer low-layer
    kind contract
  relationships
    requires @package high-adapter
`,
  );

  const ran = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-layers', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(ran.status, 3, ran.stdout + ran.stderr);
  const body = JSON.parse(JSON.parse(ran.stdout).stdout);
  assert.equal(body.ok, false);
  assert.ok(body.findings.some(f => f.code === 'PACKAGE_LAYER_ORDER'));
  assert.ok(body.findings.some(f => f.code === 'CONTRACT_PURITY'));
});
