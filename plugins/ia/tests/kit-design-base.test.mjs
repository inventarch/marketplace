// Qualification and unit tests for inventarch/ia-design-base-kit (design-base-system 0.1.0).
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
import { FORMAT, STAGE_ORDER, checkDesignPatterns, inspectTokenClassList, isSafeRecipeOutput } from '../config/kits/ia-design-base/scripts/check-design-patterns.mjs';
import { APPROVALS_DIR, generateSigningKey, keyEntryText, sealRecord } from '../config/kits/ia-approval/scripts/check-seal.mjs';
import { sequentialSigners } from './helpers/sequential-signers.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-design-base');
const SOURCE_KIT = join(REPO_ROOT, 'kits', 'ia-design-base');
const KIT_ID = 'inventarch/ia-design-base-kit';
const SYSTEM = 'design-base-system';
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const ROLES = ['documentation', 'asset'];
const WORDS = ['design-token', 'level', 'part', 'pattern', 'recipe', 'slot'];

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

// Synthetic ia-records builders for unit testing checkDesignPatterns
const strVal = text => ({ kind: 'string', text });
const numVal = value => ({ kind: 'scalar', text: String(value), value });
const refVal = (discriminator, name) => ({ kind: 'ref', discriminator, name });
const listVal = items => ({ kind: 'list', items });

function synToken(name, tier, classes = []) {
  const fields = [
    { key: 'name', value: strVal(name) },
    { key: 'tier', value: strVal(tier) },
    { key: 'category', value: strVal('color') },
    { key: 'standing', value: strVal('active') },
  ];
  if (classes.length) fields.push({ key: 'classes', value: listVal(classes.map(strVal)) });
  return {
    identity: `design-base-system/definition/design-token/${name}`,
    discriminator: 'design-token',
    name,
    provenance: 'workspace',
    sections: [{ name: 'token', fields }],
    edges: [],
  };
}

function synLevel(name, stage, rank) {
  return {
    identity: `design-base-system/definition/level/${name}`,
    discriminator: 'level',
    name,
    provenance: 'workspace',
    sections: [
      {
        name: 'level',
        fields: [
          { key: 'rank', value: numVal(rank) },
          { key: 'stage', value: strVal(stage) },
          { key: 'title', value: strVal(name) },
        ],
      },
    ],
    edges: [],
  };
}

function synSlot(name, partName, slotName = name) {
  return {
    identity: `design-base-system/definition/slot/${name}`,
    discriminator: 'slot',
    name,
    provenance: 'workspace',
    sections: [
      {
        name: 'slot',
        fields: [
          { key: 'name', value: strVal(slotName) },
          { key: 'part', value: refVal('part', partName) },
        ],
      },
    ],
    edges: [],
  };
}

function synPart(name, levelName, opts = {}) {
  const fields = [
    { key: 'name', value: strVal(opts.displayName ?? name) },
    { key: 'level', value: refVal('level', levelName) },
    { key: 'standing', value: strVal(opts.standing ?? 'active') },
  ];
  if (opts.composes) fields.push({ key: 'composes', value: listVal(opts.composes.map(p => refVal('part', p))) });
  if (opts.slots) fields.push({ key: 'slots', value: listVal(opts.slots.map(s => refVal('slot', s))) });
  if (opts.tokens) fields.push({ key: 'tokens', value: listVal(opts.tokens.map(t => refVal('design-token', t))) });
  if (opts.figmaNames) fields.push({ key: 'figma-names', value: listVal(opts.figmaNames.map(strVal)) });
  if (opts.codeExport !== undefined) fields.push({ key: 'code-export', value: strVal(opts.codeExport) });
  return {
    identity: `design-base-system/definition/part/${name}`,
    discriminator: 'part',
    name,
    provenance: 'workspace',
    sections: [{ name: 'part', fields }],
    edges: (opts.reqParts ?? []).map(p => ({ predicate: 'require', direction: 'out', reference: refVal('part', p) })),
  };
}

function synPattern(name, opts) {
  const fields = [
    { key: 'name', value: strVal(opts.displayName ?? name) },
    { key: 'yields', value: strVal(opts.yields) },
    { key: 'matches', value: listVal((opts.matches ?? ['frame layout=horizontal']).map(strVal)) },
    { key: 'evidence', value: listVal((opts.evidence ?? [`${'a'.repeat(64)} fileKey123#10:20`]).map(strVal)) },
    { key: 'standing', value: strVal(opts.standing ?? 'proposed') },
  ];
  if (opts.slots) fields.push({ key: 'slots', value: listVal(opts.slots.map(strVal)) });
  if (opts.recipe !== undefined) fields.push({ key: 'recipe', value: strVal(opts.recipe) });
  return {
    identity: `design-base-system/definition/pattern/${name}`,
    discriminator: 'pattern',
    name,
    digest: opts.digest ?? 'b'.repeat(64),
    provenance: 'workspace',
    sections: [{ name: 'pattern', fields }],
    edges: (opts.supersedes ?? []).map(p => ({ predicate: 'supersede', direction: 'out', reference: refVal('pattern', p) })),
  };
}

function synRecipe(name, opts) {
  const fields = [
    { key: 'name', value: strVal(opts.displayName ?? name) },
    { key: 'part', value: strVal(opts.part) },
    { key: 'target', value: strVal(opts.target ?? 'react-tailwind-shadcn') },
    { key: 'mode', value: strVal(opts.mode) },
    { key: 'props', value: listVal((opts.props ?? ['variant -> variant']).map(strVal)) },
    { key: 'standing', value: strVal(opts.standing ?? 'proposed') },
  ];
  if (opts.template !== undefined) fields.push({ key: 'template', value: strVal(opts.template) });
  if (opts.variants !== undefined) fields.push({ key: 'variants', value: listVal(opts.variants.map(strVal)) });
  if (opts.overrides !== undefined) fields.push({ key: 'overrides', value: listVal(opts.overrides.map(strVal)) });
  if (opts.gap !== undefined) fields.push({ key: 'gap', value: strVal(opts.gap) });
  if (opts.classes !== undefined) fields.push({ key: 'classes', value: listVal(opts.classes.map(strVal)) });
  if (opts.output !== undefined) fields.push({ key: 'output', value: strVal(opts.output) });
  return {
    identity: `design-base-system/definition/recipe/${name}`,
    discriminator: 'recipe',
    name,
    digest: opts.digest ?? 'c'.repeat(64),
    provenance: 'workspace',
    sections: [{ name: 'recipe', fields }],
    edges: (opts.supersedes ?? []).map(r => ({ predicate: 'supersede', direction: 'out', reference: refVal('recipe', r) })),
  };
}

function synApprover(name, account, key, workspaces = ['workspace-system/definition/workspace/design-ws']) {
  return {
    identity: `approval-system/definition/approver/${name}`,
    discriminator: 'approver',
    name,
    provenance: 'workspace',
    sections: [
      {
        name: 'person',
        fields: [
          { key: 'account', value: strVal(account) },
          { key: 'display', value: strVal(name) },
        ],
      },
      {
        name: 'authority',
        fields: [{ key: 'workspaces', value: listVal(workspaces.map(strVal)) }],
      },
      {
        name: 'keys',
        fields: [
          {
            key: 'entries',
            value: listVal([strVal(keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null }))]),
          },
        ],
      },
    ],
    edges: [],
  };
}

function synSignedApproval(targetRecord, targetDigest, key, signerAccount, rules = [], wsId = 'workspace-system/definition/workspace/design-ws') {
  const seal = sealRecord({
    action: 'approve',
    organisation: wsId,
    workspace: wsId,
    record: { identity: targetRecord.identity, name: targetRecord.name },
    recordDigest: targetDigest,
    dependsOn: [],
    rules,
    revision: '9'.repeat(64),
    toolchain: { language: '3.2.0', systems: [{ system: 'design-base-system', version: '0.1.0' }] },
    baseCommit: '1'.repeat(40),
    signer: { account: signerAccount, display: signerAccount },
    key,
    keyKind: 'service-held',
    via: 'desk',
    request: `req-${targetRecord.name}`,
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });
  const s = seal.statement;
  return {
    identity: `approval-system/definition/approval/${targetRecord.name}-seal`,
    discriminator: 'approval',
    name: `${targetRecord.name}-seal`,
    provenance: 'workspace',
    origin: { file: seal.path, line: 3 },
    sections: [
      {
        name: 'seal',
        fields: [
          { key: 'action', value: strVal(s.action) },
          { key: 'organisation', value: strVal(s.organisation) },
          { key: 'workspace', value: strVal(s.workspace) },
          { key: 'record', value: strVal(s.record) },
          { key: 'record-digest', value: strVal(s.recordDigest) },
          { key: 'depends-on', value: listVal(s.dependsOn.map(d => strVal(`${d.identity} ${d.digest}`))) },
          { key: 'rules', value: listVal(s.rules.map(r => strVal(`${r.identity} ${r.digest}`))) },
          { key: 'revision', value: strVal(s.revision) },
          { key: 'language-version', value: strVal(s.language) },
          { key: 'system-versions', value: listVal(s.systems.map(sys => strVal(`${sys.system} ${sys.version}`))) },
          { key: 'base-commit', value: strVal(s.baseCommit) },
          { key: 'signer', value: strVal(s.signer) },
          { key: 'key-id', value: strVal(s.keyId) },
          { key: 'key-kind', value: strVal(s.keyKind) },
          { key: 'via', value: strVal(s.via) },
          { key: 'request', value: strVal(s.request) },
          { key: 'signed-at', value: strVal(s.signedAt) },
          { key: 'algorithm', value: strVal('ed25519') },
          { key: 'signature', value: strVal(seal.signature) },
        ],
      },
    ],
    edges: [],
  };
}

function synApprovalRule(name, words, quorum = 1, digest = '7'.repeat(64)) {
  return {
    identity: `approval-system/governance/approval-rule/${name}`,
    discriminator: 'approval-rule',
    name,
    digest,
    provenance: 'workspace',
    sections: [
      {
        name: 'demand',
        fields: [
          { key: 'words', value: listVal(words.map(strVal)) },
          { key: 'quorum', value: numVal(quorum) },
        ],
      },
    ],
    edges: [],
  };
}

test('REQ-DESIGN-BASE-01 success: the kit admits offline with steward hygiene and six word schemas', { skip: SKIP_CLI }, t => {
  const records = parseRecords(KIT);
  const schemas = records.filter(r => r.word === 'schema').map(r => r.name).sort();
  assert.deepEqual(schemas, WORDS);
  assert.equal(schemas.includes('template'), false, 'never collides with floor @template');
  assert.ok(records.some(r => r.word === 'agent' && r.name === 'design-base-system-steward'));
  assert.ok(records.some(r => r.word === 'mandate' && r.name === 'design-base-system-stewardship'));
  assert.deepEqual(
    records.filter(r => r.word === 'convention' && r.name.startsWith('design-guide-')).map(r => r.name).sort(),
    WORDS.map(w => `design-guide-${w}`).sort(),
  );

  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-base-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const copy = join(base, 'kit');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(SOURCE_KIT, copy, { recursive: true });

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);

  const validate = spawnSync(process.execPath, [CLI, 'validate', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const parsed = JSON.parse(validate.stdout);
  assert.equal(parsed.status, 'admitted');
  assert.equal(parsed.counts.errors, 0);
});

test('REQ-DESIGN-BASE-01 failure: an unknown evaluator is refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-base-bad-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const copy = join(base, 'kit');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(SOURCE_KIT, copy, { recursive: true });
  const comp = join(copy, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(
    comp,
    readFileSync(comp, 'utf8').replace('    runs COMP-CHECK\n    scope "ia validate --json"', '    runs UNKNOWN-EVAL\n    scope "ia validate --json"'),
  );

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stdout + restore.stderr, /IA-COMP-CHECK-UNKNOWN/);
});

test('REQ-DESIGN-BASE-02 success: checks, assets and format 2 release metadata match', () => {
  const records = parseRecords(KIT);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.deepEqual(checksProblems(records, checks), []);
  assert.deepEqual(assetProblems(KIT), []);
  assert.deepEqual(releaseProblems(KIT), []);
});

test('REQ-DESIGN-BASE-02 failure: drifted checks, assets and releases are refused', t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-base-drift-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const copyChecks = join(base, 'checks');
  cpSync(KIT, copyChecks, { recursive: true });
  const comp = join(copyChecks, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(comp, readFileSync(comp, 'utf8').replace('scope "ia validate --json"', 'scope ""'));
  assert.ok(checksProblems(parseRecords(copyChecks), JSON.parse(readFileSync(join(copyChecks, 'checks.json'), 'utf8'))).length > 0);

  const copyAssets = join(base, 'assets');
  cpSync(KIT, copyAssets, { recursive: true });
  rmSync(join(copyAssets, 'assets', 'design-vocabulary.md'));
  assert.ok(assetProblems(copyAssets).some(p => p.includes('missing')));

  const copyRelease = join(base, 'release');
  cpSync(KIT, copyRelease, { recursive: true });
  writeFileSync(join(copyRelease, 'assets', 'design-vocabulary.md'), '# drifted\n');
  assert.ok(releaseProblems(copyRelease).some(p => p.includes('sources digest mismatch')));
});

test('REQ-DESIGN-BASE-03 success: six design words coexist with floor @template and validate consented edges', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-consent-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-design-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  adopt(ws, findKit('ia-approval'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(
    wsFile,
    readFileSync(wsFile, 'utf8').replace(
      /systems \[([^\]]+)\]/,
      'systems [$1, @system template-system, @system approval-system, @system design-base-system]',
    ),
  );

  writeFileSync(
    join(ws, '.ia', 'src', 'design.ia'),
    `#! ia 1.0

@template render-stub
  meaning
    says "Floor template coexisting cleanly with page-template atomic stage."
    answers "Does floor @template coexist with design-base-system?"
  template
    filename "docs/ui-summary.md"
    parameters []
    lines ["Summary"]

@design-token surface-card
  meaning
    says "Semantic card surface token."
  token
    name "surface-card"
    tier semantic
    category color
    css-var "--surface-card"
    classes ["bg-surface-card", "border-surface-card"]
    standing active

@level atom-level
  meaning
    says "Atomic controls."
  level
    rank 1
    stage atom
    title "Atom"

@level page-template-level
  meaning
    says "Page layout templates."
  level
    rank 4
    stage page-template
    title "Page Template"

@part action-button
  meaning
    says "Primary action button atom."
  part
    name "Button"
    level @level atom-level
    tokens [@design-token surface-card]
    code-export "@acme/ui#Button"
    standing active

@part shell-layout
  meaning
    says "Shell page-template composing button."
  part
    name "ShellLayout"
    level @level page-template-level
    composes [@part action-button]
    slots [@slot shell-header]
    standing proposed
  relationships
    requires @part action-button

@slot shell-header
  meaning
    says "Header slot on ShellLayout."
  slot
    name "header"
    part @part shell-layout
    accepts [atom, molecule]

@pattern shell-pattern
  meaning
    says "Shell header arrangement."
  pattern
    name "Shell Pattern"
    yields "design-base-system/definition/part/shell-layout"
    matches ["frame layout=vertical", "slot=header"]
    slots ["header <- root/top"]
    recipe "design-base-system/definition/recipe/shell-recipe"
    evidence ["${'1'.repeat(64)} figFile#1:2"]
    standing proposed

@recipe shell-recipe
  meaning
    says "Compose recipe for ShellLayout."
  recipe
    name "Shell Recipe"
    part "design-base-system/definition/part/shell-layout"
    target "react-tailwind-shadcn"
    mode compose
    template "templates/shell.tsx.hbs"
    props ["header -> header"]
    classes ["root -> bg-surface-card border-surface-card"]
    standing proposed

@approval-rule design-words-rule
  meaning
    says "Require ratification on pattern and recipe."
    answers "Which design records need seals?"
  demand
    words [pattern, recipe]
    quorum 1
    merge person
`,
  );

  const val = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(val.status, 0, val.stdout + val.stderr);
  assert.equal(JSON.parse(val.stdout).counts.errors, 0);
});

test('REQ-DESIGN-BASE-03 failure: unconsented edges and invalid enum values are refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-consent-bad-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // 1. Invalid recipe.mode
  const copyEnum = join(base, 'enum');
  cpSync(SOURCE_KIT, copyEnum, { recursive: true });
  writeFileSync(
    join(copyEnum, '.ia', 'src', 'bad-recipe.ia'),
    `#! ia 1.0

@recipe bad-mode
  meaning
    says "Invalid recipe mode."
  recipe
    name "Bad"
    part "design-base-system/definition/part/btn"
    target "react"
    modeinline-invalid
    props []
    standing proposed
`.replace('modeinline-invalid', 'mode invalid-mode'),
  );
  const resEnum = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copyEnum, '--json'], {
    env: { ...process.env, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const valEnum =
    resEnum.status === 0
      ? spawnSync(process.execPath, [CLI, 'validate', '--root', copyEnum, '--json'], {
          env: { ...process.env, IA_NO_HANDOFF: '1' },
          encoding: 'utf8',
          windowsHide: true,
        })
      : { stdout: '', stderr: '' };
  assert.match(resEnum.stdout + resEnum.stderr + valEnum.stdout + valEnum.stderr, /IA-COMP-FIELD-VALUE/);

  // 2. Splicing out require part consent refuses @part requiring @part
  const copyEdge = join(base, 'edge');
  cpSync(SOURCE_KIT, copyEdge, { recursive: true });
  const sysPath = join(copyEdge, '.ia', 'src', 'systems', SYSTEM, 'system.ia');
  writeFileSync(sysPath, readFileSync(sysPath, 'utf8').replace('    require part using part, slot, pattern, recipe\n', ''));
  writeFileSync(
    join(copyEdge, '.ia', 'src', 'unconsented.ia'),
    `#! ia 1.0

@level lvl-atom
  meaning
    says "Atom."
  level
    rank 1
    stage atom
    title "Atom"

@part p-a
  meaning
    says "A."
  part
    name "A"
    level @level lvl-atom
    standing active

@part p-b
  meaning
    says "B."
  part
    name "B"
    level @level lvl-atom
    standing active
  relationships
    requires @part p-a
`,
  );
  const resEdge = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copyEdge, '--json'], {
    env: { ...process.env, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const valEdge =
    resEdge.status === 0
      ? spawnSync(process.execPath, [CLI, 'validate', '--root', copyEdge, '--json'], {
          env: { ...process.env, IA_NO_HANDOFF: '1' },
          encoding: 'utf8',
          windowsHide: true,
        })
      : { stdout: '', stderr: '' };
  assert.match(resEdge.stdout + resEdge.stderr + valEdge.stdout + valEdge.stderr, /IA-(?:LANG|GRAPH)-EDGE-UNCONSENTED/);
});

test('REQ-DESIGN-BASE-04 success: compliant atomic hierarchy, overrides and sealed active recipes pass', () => {
  assert.equal(STAGE_ORDER.atom < STAGE_ORDER.molecule && STAGE_ORDER.molecule < STAGE_ORDER.organism && STAGE_ORDER.organism < STAGE_ORDER['page-template'], true);
  assert.equal(isSafeRecipeOutput('src/features/account-list/index.tsx'), true);
  assert.equal(isSafeRecipeOutput('.ia/src/workspace.ia'), false);
  assert.equal(inspectTokenClassList('bg-surface-primary text-ink-default').raw, false);
  assert.equal(inspectTokenClassList('bg-[#ff0000]').raw, true);
  assert.equal(inspectTokenClassList('hover:bg-prim-blue-500', new Set(['bg-prim-blue-500'])).raw, true, 'variant-prefixed primitive token refused');
  assert.equal(inspectTokenClassList('dark:focus:bg-prim-blue-500', new Set(['bg-prim-blue-500'])).raw, true, 'nested variant-prefixed primitive token refused');

  const { key: designKey } = generateSigningKey();
  const patDigest = '1'.repeat(64);
  const recDigest = '2'.repeat(64);
  const ruleDigest = '7'.repeat(64);
  const btnUseRec = synRecipe('btn-use', {
    part: 'design-base-system/definition/part/btn',
    mode: 'use',
    variants: ['variant=Default -> variant=action'],
    standing: 'active',
    digest: recDigest,
  });
  const toolbarPatRec = synPattern('toolbar-pat', {
    yields: 'design-base-system/definition/part/toolbar',
    matches: ['frame layout=horizontal', 'slot=actions'],
    slots: ['actions <- root/right'],
    recipe: 'design-base-system/definition/recipe/toolbar-compose',
    standing: 'active',
    digest: patDigest,
  });
  const namedRule = synApprovalRule('named-words-rule', ['pattern', 'recipe'], 1, ruleDigest);
  const ruleRef = [{ identity: namedRule.identity, digest: ruleDigest }];

  const report = checkDesignPatterns({
    revision: 'rev-design-ok',
    records: [
      synToken('prim-blue-500', 'primitive', ['bg-prim-blue-500']),
      synToken('sem-action', 'semantic', ['bg-action-primary', 'text-action-ink']),
      synLevel('lvl-atom', 'atom', 10),
      synLevel('lvl-molecule', 'molecule', 20),
      synLevel('lvl-organism', 'organism', 30),
      synLevel('lvl-template', 'page-template', 40),
      synPart('btn', 'lvl-atom', { displayName: 'Button', tokens: ['sem-action'], codeExport: '@acme/ui#Button' }),
      synPart('search-box', 'lvl-molecule', { displayName: 'SearchBox', composes: ['btn'], codeExport: '@acme/ui#SearchBox' }),
      synSlot('toolbar-actions', 'toolbar', 'actions'),
      synPart('toolbar', 'lvl-organism', { displayName: 'Toolbar', composes: ['search-box'], slots: ['toolbar-actions'] }),
      synPart('list-shell', 'lvl-template', { displayName: 'ListShell', composes: ['toolbar'] }),
      btnUseRec,
      synRecipe('search-adapt', {
        part: 'design-base-system/definition/part/search-box',
        mode: 'adapt',
        overrides: ['root -> bg-action-primary text-action-ink'],
        gap: 'SearchBox lacks subtle surface variant',
        standing: 'proposed',
      }),
      synRecipe('toolbar-compose', {
        part: 'design-base-system/definition/part/toolbar',
        mode: 'compose',
        template: 'templates/toolbar.tsx.hbs',
        classes: ['root -> bg-action-primary'],
        standing: 'proposed',
      }),
      synRecipe('shell-define', {
        part: 'design-base-system/definition/part/list-shell',
        mode: 'define',
        template: 'templates/list-shell.tsx.hbs',
        classes: ['root -> bg-action-primary'],
        output: 'src/features/list-shell/ListShell.tsx',
        standing: 'proposed',
      }),
      toolbarPatRec,
      synApprover('design-lead', 'acct-design', designKey),
      namedRule,
      synSignedApproval(toolbarPatRec, patDigest, designKey, 'acct-design', ruleRef),
      synSignedApproval(btnUseRec, recDigest, designKey, 'acct-design', ruleRef),
    ],
  });

  assert.equal(report.format, FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test('REQ-DESIGN-BASE-04 failure: check-design-patterns refuses upward composition, bad overrides and unsealed active records', () => {
  const report = checkDesignPatterns({
    revision: 'rev-design-bad',
    records: [
      synToken('prim-raw', 'primitive', ['bg-custom-prim']),
      // Duplicate stage + inverted rank (molecule rank 5 < atom rank 10)
      synLevel('lvl-atom', 'atom', 10),
      synLevel('lvl-atom-dup', 'atom', 10),
      synLevel('lvl-mol-inverted', 'molecule', 5),
      synLevel('lvl-org', 'organism', 30),
      // Atom composing organism (upward), using primitive token, wrong slot owner, duplicate Figma component set, and cycle
      synSlot('wrong-owner-slot', 'org-part', 'header'),
      synSlot('dup-slot-1', 'org-part', 'footer'),
      synSlot('dup-slot-2', 'org-part', 'footer'),
      synPart('atom-bad', 'lvl-atom', {
        displayName: 'SharedSet',
        composes: ['org-part'],
        tokens: ['prim-raw'],
        slots: ['wrong-owner-slot'],
        codeExport: '@acme/ui#AtomBad',
      }),
      synPart('org-part', 'lvl-org', { displayName: 'SharedSet' }),
      synPart('cyc-1', 'lvl-org', { composes: ['cyc-2'] }),
      synPart('cyc-2', 'lvl-org', { composes: ['cyc-1'] }),
      // Pattern issues: empty matches, unknown yield, bad slot, bad recipe, bad evidence, active unsealed, cycle
      synPattern('pat-bad', {
        yields: 'design-base-system/definition/part/missing',
        matches: [],
        slots: ['nonexistent <- root/a'],
        recipe: 'design-base-system/definition/recipe/missing',
        evidence: ['not-a-digest'],
        standing: 'active',
        supersedes: ['pat-cyc'],
      }),
      synPattern('pat-cyc', {
        yields: 'design-base-system/definition/part/org-part',
        supersedes: ['pat-bad'],
      }),
      // Recipe issues: unknown part, define over code-export, raw hex/palette/primitive classes, adapt scale override, missing gap, unsafe .ia output, active unsealed, cycle
      synRecipe('rec-define-over-export', {
        part: 'design-base-system/definition/part/atom-bad',
        mode: 'define',
        template: 'templates/a.hbs',
        classes: ['root -> bg-blue-500 bg-[#123456] !text-white bg-custom-prim'],
        output: '.ia/src/injected.tsx',
        standing: 'active',
        supersedes: ['rec-cyc'],
      }),
      synRecipe('rec-cyc', {
        part: 'design-base-system/definition/part/missing',
        mode: 'adapt',
        props: ['badprop'],
        variants: ['badvariant'],
        overrides: ['root -> px-4 flex'],
        supersedes: ['rec-define-over-export'],
      }),
      // Approval rule omitting recipe -> triggers MISSING_NAMED_WORDS_RULE
      synApprovalRule('incomplete-rule', ['pattern']),
    ],
  });

  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map(f => f.code));
  for (const expected of [
    'LEVEL_DUPLICATE_STAGE',
    'LEVEL_STAGE_RANK_ORDER',
    'PART_ATOMIC_HIERARCHY',
    'PART_PRIMITIVE_TOKEN',
    'SLOT_OWNER_MISMATCH',
    'SLOT_DUPLICATE_NAME',
    'PART_FIGMA_SET_AMBIGUOUS',
    'PART_CYCLE',
    'MISSING_NAMED_WORDS_RULE',
    'PATTERN_MATCHES_EMPTY',
    'PATTERN_YIELDS_UNKNOWN',
    'PATTERN_SLOT_UNKNOWN',
    'PATTERN_RECIPE_UNKNOWN',
    'PATTERN_EVIDENCE_INVALID',
    'ACTIVE_PATTERN_UNSEALED',
    'PATTERN_CYCLE',
    'RECIPE_PART_UNKNOWN',
    'RECIPE_DEFINE_OVER_EXPORT',
    'RECIPE_MODE_CONTRACT',
    'RECIPE_PROP_FORMAT',
    'RECIPE_VARIANT_FORMAT',
    'RECIPE_RAW_STYLE',
    'RECIPE_ADAPT_SCALE',
    'RECIPE_OUTPUT_UNSAFE',
    'ACTIVE_RECIPE_UNSEALED',
    'RECIPE_CYCLE',
  ]) {
    assert.ok(codes.has(expected), `expected finding ${expected}, got ${[...codes].join(', ')}`);
  }
});

test('REQ-DESIGN-BASE-05 success: check.mjs runs design-check-validate and check-design-patterns to exit 0', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-runner-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-design-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system design-base-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'design.ia'),
    `#! ia 1.0

@design-token action-surface
  meaning
    says "Action surface token."
  token
    name "action-surface"
    tier semantic
    category color
    classes ["bg-action-surface"]
    standing active

@level atom-lvl
  meaning
    says "Atoms."
  level
    rank 1
    stage atom
    title "Atom"

@level molecule-lvl
  meaning
    says "Molecules."
  level
    rank 2
    stage molecule
    title "Molecule"

@part action-btn
  meaning
    says "Button atom."
  part
    name "ActionButton"
    level @level atom-lvl
    tokens [@design-token action-surface]
    code-export "@acme/ui#ActionButton"
    standing active

@part filter-bar
  meaning
    says "Filter bar molecule."
  part
    name "FilterBar"
    level @level molecule-lvl
    composes [@part action-btn]
    standing proposed

@recipe btn-recipe
  meaning
    says "Use recipe for ActionButton."
  recipe
    name "ActionButton Use"
    part "design-base-system/definition/part/action-btn"
    target "react-tailwind-shadcn"
    mode use
    props ["size -> size"]
    standing proposed
`,
  );

  for (const checkName of ['design-check-validate', 'check-design-patterns']) {
    const ran = spawnSync(
      process.execPath,
      [join(PLUGIN, 'scripts', 'check.mjs'), checkName, '--kit', KIT_ID, '--root', ws, '--cli', CLI],
      { env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(ran.status, 0, `${checkName}: ${ran.stdout}\n${ran.stderr}`);
    assert.equal(JSON.parse(ran.stdout).exitCode, 0);
  }
});

test('REQ-DESIGN-BASE-05 failure: check.mjs exits 3 when check-design-patterns detects violations', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-runner-fail-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-design-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system design-base-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'design.ia'),
    `#! ia 1.0

@level atom-lvl
  meaning
    says "Atoms."
  level
    rank 1
    stage atom
    title "Atom"

@level org-lvl
  meaning
    says "Organisms."
  level
    rank 3
    stage organism
    title "Organism"

@part header-org
  meaning
    says "Header organism."
  part
    name "HeaderOrg"
    level @level org-lvl
    standing active

@part upward-atom
  meaning
    says "Atom wrongly composing organism."
  part
    name "UpwardAtom"
    level @level atom-lvl
    composes [@part header-org]
    code-export "@acme/ui#UpwardAtom"
    standing active

@recipe unsealed-raw-recipe
  meaning
    says "Active unsealed adapt recipe with raw hex."
  recipe
    name "Bad Adapt"
    part "design-base-system/definition/part/upward-atom"
    target "react-tailwind-shadcn"
    mode adapt
    props ["size -> size"]
    overrides ["root -> bg-[#ff00ff] p-4"]
    gap "Missing accent"
    standing active
`,
  );

  const ran = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-design-patterns', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(ran.status, 3, ran.stdout + ran.stderr);
  const body = JSON.parse(JSON.parse(ran.stdout).stdout);
  assert.equal(body.ok, false);
  assert.ok(body.findings.some(f => f.code === 'PART_ATOMIC_HIERARCHY'));
  assert.ok(body.findings.some(f => f.code === 'RECIPE_RAW_STYLE'));
  assert.ok(body.findings.some(f => f.code === 'RECIPE_ADAPT_SCALE'));
  assert.ok(body.findings.some(f => f.code === 'ACTIVE_RECIPE_UNSEALED'));
});

test('REQ-DESIGN-BASE-06: forged/zero-signature seals, missing digests and variant-prefixed primitives fail, while real Ed25519 seals pass', { skip: SKIP_CLI }, t => {
  // 1. Unit: zero-signature fake @approval, missing record.digest, and hover:<primitive> class
  const patNoDigest = { ...synPattern('no-digest-pat', { yields: 'design-base-system/definition/part/btn', standing: 'active' }), digest: undefined };
  const fakeApproval = {
    identity: 'approval-system/definition/approval/fake-seal',
    discriminator: 'approval',
    name: 'fake-seal',
    provenance: 'workspace',
    sections: [
      {
        name: 'seal',
        fields: [
          { key: 'action', value: strVal('approve') },
          { key: 'organisation', value: strVal('workspace-system/definition/workspace/design-ws') },
          { key: 'workspace', value: strVal('workspace-system/definition/workspace/design-ws') },
          { key: 'record', value: strVal('design-base-system/definition/recipe/fake-sealed-rec') },
          { key: 'record-digest', value: strVal('f'.repeat(64)) },
          { key: 'depends-on', value: listVal([]) },
          { key: 'rules', value: listVal([]) },
          { key: 'revision', value: strVal('0'.repeat(64)) },
          { key: 'language-version', value: strVal('3.2.0') },
          { key: 'system-versions', value: listVal([strVal('design-base-system 0.1.0')]) },
          { key: 'base-commit', value: strVal('1'.repeat(40)) },
          { key: 'signer', value: strVal('nonexistent-signer') },
          { key: 'key-id', value: strVal('kid-fake') },
          { key: 'key-kind', value: strVal('service-held') },
          { key: 'via', value: strVal('desk') },
          { key: 'request', value: strVal('req-fake') },
          { key: 'signed-at', value: strVal('2026-11-18T00:00:00Z') },
          { key: 'algorithm', value: strVal('ed25519') },
          { key: 'signature', value: strVal('A'.repeat(86)) },
        ],
      },
    ],
    edges: [],
  };
  const unitReport = checkDesignPatterns({
    revision: 'rev-sec',
    records: [
      synToken('prim-card', 'primitive', ['bg-surface-prim']),
      synLevel('lvl-atom', 'atom', 1),
      synPart('btn', 'lvl-atom', { displayName: 'Button', codeExport: '@acme/ui#Button' }),
      patNoDigest,
      synRecipe('fake-sealed-rec', {
        part: 'design-base-system/definition/part/btn',
        mode: 'adapt',
        overrides: ['root -> hover:bg-surface-prim'],
        gap: 'gap',
        standing: 'active',
        digest: 'f'.repeat(64),
      }),
      fakeApproval,
    ],
  });
  assert.equal(unitReport.ok, false);
  assert.ok(unitReport.findings.some(f => f.identity === patNoDigest.identity && f.code === 'ACTIVE_PATTERN_UNSEALED'));
  assert.ok(unitReport.findings.some(f => f.name === 'fake-sealed-rec' && f.code === 'ACTIVE_RECIPE_UNSEALED'));
  assert.ok(unitReport.findings.some(f => f.name === 'fake-sealed-rec' && f.code === 'RECIPE_RAW_STYLE'));

  // 2. Real CLI workspace check: fake zero-signature @approval fails exit 3, real Ed25519 @approval passes exit 0
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-seal-live-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-design-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  adopt(ws, findKit('ia-approval'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsText = readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system approval-system, @system design-base-system]');
  writeFileSync(wsFile, wsText);
  const wsId = `workspace-system/definition/workspace/${/^@workspace\s+([a-z0-9-]+)/m.exec(wsText)[1]}`;

  writeFileSync(
    join(ws, '.ia', 'src', 'design.ia'),
    `#! ia 1.0

@level atom-lvl
  meaning
    says "Atoms."
  level
    rank 1
    stage atom
    title "Atom"

@part action-btn
  meaning
    says "Button atom."
  part
    name "ActionButton"
    level @level atom-lvl
    code-export "@acme/ui#ActionButton"
    standing active

@recipe active-btn-recipe
  meaning
    says "Active recipe requiring genuine seal."
  recipe
    name "ActionButton Use"
    part "design-base-system/definition/part/action-btn"
    target "react-tailwind-shadcn"
    mode use
    props ["size -> size"]
    standing active
`,
  );

  // Plant a schema-valid fake @approval with invented digest, nonexistent signer, and all-zero signature
  mkdirSync(join(ws, APPROVALS_DIR), { recursive: true });
  const bogusPath = join(ws, APPROVALS_DIR, 'active-btn-recipe.aaaaaaaaaaaa.00000000.ia');
  writeFileSync(
    bogusPath,
    `#! ia 1.0

@approval fake-btn-seal
  meaning
    says "Forged zero-signature approval."
    answers "the built-in root of the check"
  seal
    action approve
    organisation "${wsId}"
    workspace "${wsId}"
    record "design-base-system/definition/recipe/active-btn-recipe"
    record-digest "${'a'.repeat(64)}"
    depends-on []
    rules []
    revision "${'b'.repeat(64)}"
    language-version "3.2.0"
    system-versions ["design-base-system 0.1.0"]
    base-commit "${'c'.repeat(40)}"
    signer "nobody"
    key-id "fake-key"
    key-kind service-held
    via desk
    request "req-forged"
    signed-at "2026-11-18T00:00:00Z"
    algorithm ed25519
    signature "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
`,
  );

  const bogusRun = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-design-patterns', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(bogusRun.status, 3, bogusRun.stdout + bogusRun.stderr);
  assert.ok(JSON.parse(JSON.parse(bogusRun.stdout).stdout).findings.some(f => f.code === 'ACTIVE_RECIPE_UNSEALED'));

  // Replace bogus seal with real @approver + Ed25519 signature over exact compiled digest
  rmSync(bogusPath, { force: true });
  const { key } = generateSigningKey();
  writeFileSync(
    join(ws, '.ia', 'src', 'approvers.ia'),
    `#! ia 1.0

@approver design-steward
  meaning
    says "Design approver."
    answers "Who ratifies active design recipes?"
  person
    account "acct-design"
    display "Design Steward"
  authority
    workspaces ["${wsId}"]
    anchor founding
  keys
    entries ["${keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null })}"]
`,
  );

  const inspectRun = spawnSync(process.execPath, [CLI, 'inspect', '--path', '.ia/src/design.ia', '--depth', '0', '--json', '--root', ws], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(inspectRun.status, 0, inspectRun.stdout + inspectRun.stderr);
  const inspected = JSON.parse(inspectRun.stdout);
  const recipeSnap = inspected.records.find(r => r.name === 'active-btn-recipe');
  const realSeal = sealRecord({
    action: 'approve',
    organisation: wsId,
    workspace: wsId,
    record: { identity: recipeSnap.identity, name: recipeSnap.name },
    recordDigest: recipeSnap.digest,
    dependsOn: [],
    rules: [],
    revision: inspected.revision,
    toolchain: { language: '3.2.0', systems: [{ system: 'design-base-system', version: '0.1.0' }] },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-design', display: 'Design Steward' },
    key,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-real-design',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });
  writeFileSync(join(ws, realSeal.path), realSeal.source);

  const validRun = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-design-patterns', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(validRun.status, 0, validRun.stdout + validRun.stderr);
  assert.equal(JSON.parse(validRun.stdout).exitCode, 0);
});

test('REQ-DESIGN-BASE-07: sequential quorum-2 current-revision seals pass as in check-seal, and a post-seal edit still fails', { skip: SKIP_CLI }, t => {
  const pair = sequentialSigners(t, {
    cli: CLI,
    kit: 'ia-design-base',
    system: SYSTEM,
    words: 'pattern, recipe',
    target: 'design-base-system/definition/recipe/seq-recipe',
    checkName: 'check-design-patterns',
    kitId: KIT_ID,
    records: `#! ia 1.0

@level seq-atom
  meaning
    says "Atoms."
  level
    rank 1
    stage atom
    title "Atom"

@part seq-btn
  meaning
    says "Button atom."
  part
    name "SeqButton"
    level @level seq-atom
    code-export "@acme/ui#SeqButton"
    standing active

@recipe seq-recipe
  meaning
    says "Active recipe sealed by two approvers in turn."
  recipe
    name "SeqButton Use"
    part "design-base-system/definition/part/seq-btn"
    target "react-tailwind-shadcn"
    mode use
    props ["size -> size"]
    standing active
`,
  });
  pair.sealFirst();
  const one = pair.check();
  assert.equal(one.status, 3, one.output);
  assert.equal(pair.sealPasses(), false);
  assert.ok(one.findings.some(f => f.code === 'ACTIVE_RECIPE_UNSEALED'), one.output);

  // Control: both signers on the pre-seal revision
  pair.sealSecond({ onPreSeal: true });
  const control = pair.check();
  assert.equal(control.status, 0, control.output);
  assert.equal(pair.sealPasses(), true);

  // Signer 2 captured after approval 1 was written (the step revision check-seal accepts)
  pair.sealSecond();
  const sequential = pair.check();
  assert.equal(sequential.status, 0, sequential.output);
  assert.equal(pair.sealPasses(), true);

  // A post-seal edit to a non-approval record leaves no accepted revision
  pair.edit('later.ia', '#! ia 1.0\n\n@level seq-molecule\n  meaning\n    says "Added after both seals."\n  level\n    rank 2\n    stage molecule\n    title "Molecule"\n');
  const stale = pair.check();
  assert.equal(stale.status, 3, stale.output);
  assert.equal(pair.sealPasses(), false);
  assert.ok(stale.findings.some(f => f.code === 'ACTIVE_RECIPE_UNSEALED'), stale.output);
});
