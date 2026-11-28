// Qualification and unit tests for inventarch/ia-slack-base-kit (slack-system 0.1.0).
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
import { FORMAT, checkSlackChannels, isCredentialFreeHome, isOpaqueSecretName, parseSlackUserId } from '../config/kits/ia-slack-base/scripts/check-slack-channels.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-slack-base');
const SOURCE_KIT = join(REPO_ROOT, 'kits', 'ia-slack-base');
const KIT_ID = 'inventarch/ia-slack-base-kit';
const SYSTEM = 'slack-system';
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const ROLES = ['documentation', 'asset'];

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

// Synthetic ia-records builders for unit testing checkSlackChannels
const strVal = text => ({ kind: 'string', text });
const refVal = (discriminator, name) => ({ kind: 'ref', discriminator, name });
const listVal = items => ({ kind: 'list', items });

function synWorkspace(name) {
  return {
    identity: `workspace-system/definition/workspace/${name}`,
    discriminator: 'workspace',
    name,
    provenance: 'workspace',
    origin: { file: '.ia/src/workspace.ia', line: 3 },
    sections: [],
    edges: [],
  };
}

function synChannel(name, fields) {
  const slackFields = [
    { key: 'label', value: strVal(fields.label ?? name) },
    { key: 'channel', value: strVal(fields.channel ?? name) },
    { key: 'workspace', value: fields.workspaceRef ?? refVal('workspace', fields.workspace ?? 'org-root') },
    { key: 'home', value: strVal(fields.home ?? 'https://example.org/acme/kb.git') },
    { key: 'approver', value: strVal(fields.approver ?? 'T01234567 U01234567') },
    { key: 'members', value: listVal((fields.members ?? ['T01234567 U01234567', 'T01234567 U07654321']).map(strVal)) },
    { key: 'app', value: strVal(fields.app ?? 'organisation') },
    { key: 'secret', value: strVal(fields.secret ?? 'acme-slack-bot') },
  ];
  if (fields.channelId !== undefined) slackFields.push({ key: 'channel-id', value: strVal(fields.channelId) });
  if (fields.answers !== undefined) slackFields.push({ key: 'answers', value: strVal(fields.answers) });
  if (fields.sources !== undefined) slackFields.push({ key: 'sources', value: listVal(fields.sources.map(strVal)) });
  if (fields.shows !== undefined) slackFields.push({ key: 'shows', value: listVal(fields.shows.map(strVal)) });
  if (fields.kind !== undefined) slackFields.push({ key: 'kind', value: strVal(fields.kind) });
  if (fields.form !== undefined) slackFields.push({ key: 'form', value: strVal(fields.form) });
  if (fields.asks !== undefined) slackFields.push({ key: 'asks', value: listVal(fields.asks.map(strVal)) });
  if (fields.rate !== undefined) slackFields.push({ key: 'rate', value: strVal(fields.rate) });
  if (fields.disclosure !== undefined) slackFields.push({ key: 'disclosure', value: strVal(fields.disclosure) });

  return {
    identity: `slack-system/binding/slack-channel/${name}`,
    discriminator: 'slack-channel',
    name,
    provenance: 'workspace',
    origin: { file: '.ia/src/slack-channels.ia', line: 5 },
    sections: [
      { name: 'meaning', fields: [{ key: 'says', value: strVal(`Space ${name}.`) }] },
      { name: 'slack', fields: slackFields },
    ],
    edges: [],
  };
}

test('REQ-SLACK-BASE-01 success: the kit admits offline with steward hygiene, schema and five channel rules', { skip: SKIP_CLI }, t => {
  const records = parseRecords(KIT);
  const byWord = word => records.filter(r => r.word === word).map(r => r.name).sort();
  assert.deepEqual(byWord('schema'), ['slack-channel']);
  assert.ok(records.some(r => r.word === 'agent' && r.name === 'slack-system-steward'));
  assert.ok(records.some(r => r.word === 'mandate' && r.name === 'slack-system-stewardship'));
  assert.deepEqual(byWord('law'), ['slack-channel-audience-disclosure', 'slack-user-bound-before-served']);
  assert.deepEqual(byWord('convention'), [
    'slack-bot-non-execution-bounds',
    'slack-decision-answer-named-person',
    'slack-guide-slack-channel',
    'slack-text-is-data',
  ]);

  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-base-ok-')));
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

test('REQ-SLACK-BASE-01 failure: an unknown evaluator is refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-base-bad-')));
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

test('REQ-SLACK-BASE-02 success: checks, assets and format 2 release metadata match', () => {
  const records = parseRecords(KIT);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.deepEqual(checksProblems(records, checks), []);
  assert.deepEqual(assetProblems(KIT), []);
  assert.deepEqual(releaseProblems(KIT), []);
});

test('REQ-SLACK-BASE-02 failure: drifted checks, assets and releases are refused', t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-base-drift-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const copyChecks = join(base, 'checks');
  cpSync(KIT, copyChecks, { recursive: true });
  const comp = join(copyChecks, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(comp, readFileSync(comp, 'utf8').replace('scope "ia validate --json"', 'scope ""'));
  assert.ok(checksProblems(parseRecords(copyChecks), JSON.parse(readFileSync(join(copyChecks, 'checks.json'), 'utf8'))).length > 0);

  const copyAssets = join(base, 'assets');
  cpSync(KIT, copyAssets, { recursive: true });
  rmSync(join(copyAssets, 'assets', 'slack-vocabulary.md'));
  assert.ok(assetProblems(copyAssets).some(p => p.includes('missing')));

  const copyRelease = join(base, 'release');
  cpSync(KIT, copyRelease, { recursive: true });
  writeFileSync(join(copyRelease, 'assets', 'slack-vocabulary.md'), '# drifted\n');
  assert.ok(releaseProblems(copyRelease).some(p => p.includes('sources digest mismatch')));
});

test('REQ-SLACK-BASE-03 success: consented workspace bindings and citations validate', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-consent-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-slack-base'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsName = /@workspace\s+([a-z0-9-]+)/.exec(readFileSync(wsFile, 'utf8'))[1];
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system slack-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'slack.ia'),
    `#! ia 1.0

@spec channel-spec
  meaning
    says "Channel routing specification."
  work
    title "Channel routing"
    status draft
  relationships
    cites @slack-channel eng-design

@slack-channel eng-design
  meaning
    says "Engineering design space."
  slack
    label "Engineering Design"
    icon ":compass:"
    channel "eng-design"
    channel-id "C0123456789"
    workspace @workspace ${wsName}
    home "https://example.org/acme/kb.git"
    approver "T01234567 U01234567"
    members ["T01234567 U01234567", "T01234567 U07654321"]
    app organisation
    secret "acme-slack-bot"
    answers on
    sources ["docs/architecture"]
    shows ["work-system/contract/spec/channel-spec"]
    kind design-channel
    form channel
    asks [status, decision, space]
    rate "20 2000"
    creation person
    disclosure link-only
  relationships
    cites @spec channel-spec
    requires @workspace ${wsName}
`,
  );

  const val = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(val.status, 0, val.stdout + val.stderr);
  assert.equal(JSON.parse(val.stdout).counts.errors, 0);
});

test('REQ-SLACK-BASE-03 failure: unconsented edges and disallowed field values are refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-consent-bad-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // 1. Disallowed slack.asks value 'work'
  const copyEnum = join(base, 'enum');
  cpSync(SOURCE_KIT, copyEnum, { recursive: true });
  writeFileSync(
    join(copyEnum, '.ia', 'src', 'bad-channel.ia'),
    `#! ia 1.0

@slack-channel bad-asks
  meaning
    says "Tries to allow starting work from Slack."
  slack
    label "Bad"
    channel "bad"
    workspace @workspace ia-slack-base-kit
    home "https://example.org/acme/kb.git"
    approver "U01234567"
    members ["U01234567"]
    app organisation
    secret "acme-bot"
    asks [work]
`,
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

  // 2. Splicing out cite consent refuses @slack-channel citing @workspace
  const copyEdge = join(base, 'edge');
  cpSync(SOURCE_KIT, copyEdge, { recursive: true });
  const sysPath = join(copyEdge, '.ia', 'src', 'systems', SYSTEM, 'system.ia');
  writeFileSync(sysPath, readFileSync(sysPath, 'utf8').replace('    cite * using slack-channel\n', ''));
  writeFileSync(
    join(copyEdge, '.ia', 'src', 'unconsented.ia'),
    `#! ia 1.0

@slack-channel no-cite
  meaning
    says "Cites workspace without consent."
  slack
    label "NoCite"
    channel "no-cite"
    workspace @workspace ia-slack-base-kit
    home "https://example.org/acme/kb.git"
    approver "U01234567"
    members ["U01234567"]
    app organisation
    secret "acme-bot"
  relationships
    cites @workspace ia-slack-base-kit
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

test('REQ-SLACK-BASE-04 success: compliant organisation and person spaces pass check-slack-channels', () => {
  assert.equal(isOpaqueSecretName('acme-slack-bot'), true);
  assert.equal(isOpaqueSecretName('xoxb-123456-secret'), false);
  assert.deepEqual(parseSlackUserId('T01234567 U01234567'), { teamId: 'T01234567', userId: 'U01234567' });
  assert.equal(isCredentialFreeHome('https://example.org/acme/kb.git'), true);
  assert.equal(isCredentialFreeHome('https://user:token@example.org/acme/kb.git'), false);

  const report = checkSlackChannels({
    revision: 'rev-ok',
    records: [
      synWorkspace('org-root'),
      synWorkspace('owner-personal'),
      synChannel('org-design', {
        channel: 'org-design',
        channelId: 'C0123456789',
        workspace: 'org-root',
        answers: 'on',
        sources: ['docs/design'],
        shows: ['work-system/definition/decision/'],
        kind: 'design-channel',
        form: 'channel',
        asks: ['status', 'decision'],
        rate: '15 1800',
        disclosure: 'link-only',
      }),
      synChannel('org-private-coord', {
        channel: 'org-coord',
        channelId: 'G0987654321',
        workspace: 'org-root',
        shows: ['work-system/definition/plan/q4'],
        kind: 'coordination-space',
        form: 'group',
        disclosure: 'content',
      }),
      synChannel('owner-dm', {
        channel: 'owner-dm',
        channelId: 'D0112233445',
        workspace: 'owner-personal',
        app: 'person',
        approver: 'U01234567',
        members: ['U01234567'],
        kind: 'direct',
        form: 'direct',
        disclosure: 'link-only',
      }),
    ],
  });

  assert.equal(report.format, FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test('REQ-SLACK-BASE-04 failure: check-slack-channels refuses tokens, duplicates, bad bindings and disclosure violations', () => {
  const report = checkSlackChannels({
    revision: 'rev-bad',
    records: [
      synWorkspace('org-root'),
      synChannel('chan-one', {
        channel: 'shared-name',
        channelId: 'C0123456789',
        secret: 'xoxb-11111111-22222222-secret',
        home: 'https://user:pass@example.org/acme/kb.git',
        approver: 'not-a-slack-id',
        members: ['bad-member'],
        answers: 'on',
        rate: '0 -5',
      }),
      synChannel('chan-dup', {
        channel: 'shared-name',
        channelId: 'C0123456789',
        workspace: 'missing-ws',
        approver: 'U99999999',
        members: ['U01234567', 'U01234567'],
        disclosure: 'content',
      }),
      synChannel('chan-wildcard', {
        channel: 'wild',
        channelId: 'bad-id',
        disclosure: 'content',
        shows: ['*'],
      }),
      synChannel('chan-answers-wildcard', {
        channel: 'answers-wild',
        answers: 'on',
        disclosure: 'link-only',
        sources: ['*'],
      }),
      synChannel('person-omitted-posture', {
        channel: 'person-defaulted',
        app: 'person',
        approver: 'U01234567',
        members: ['U01234567'],
      }),
      synChannel('person-shared', {
        channel: 'person-chan',
        app: 'person',
        form: 'channel',
        kind: 'design-channel',
        approver: 'U01234567',
        members: ['U01234567', 'U07654321'],
      }),
    ],
  });

  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map(f => f.code));
  for (const expected of [
    'SLACK_SECRET_TOKEN',
    'SLACK_HOME_INVALID',
    'SLACK_APPROVER_FORMAT',
    'SLACK_MEMBER_FORMAT',
    'SLACK_ANSWERS_ALLOWLIST_EMPTY',
    'SLACK_ANSWERS_WILDCARD',
    'SLACK_RATE_FORMAT',
    'SLACK_CHANNEL_NAME_DUPLICATE',
    'SLACK_CHANNEL_ID_DUPLICATE',
    'SLACK_WORKSPACE_UNRESOLVED',
    'SLACK_MEMBER_DUPLICATE',
    'SLACK_APPROVER_NOT_MEMBER',
    'SLACK_CONTENT_ALLOWLIST_EMPTY',
    'SLACK_CHANNEL_ID_FORMAT',
    'SLACK_CONTENT_WILDCARD',
    'SLACK_PERSON_APP_POSTURE',
  ]) {
    assert.ok(codes.has(expected), `expected finding ${expected}, got ${[...codes].join(', ')}`);
  }
  assert.ok(
    report.findings.some(f => f.name === 'person-omitted-posture' && f.code === 'SLACK_PERSON_APP_POSTURE'),
    'person app omitting form and kind must fail SLACK_PERSON_APP_POSTURE',
  );
});

test('REQ-SLACK-BASE-05 success: check.mjs runs slack-check-validate and check-slack-channels to exit 0', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-runner-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-slack-base'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsName = /@workspace\s+([a-z0-9-]+)/.exec(readFileSync(wsFile, 'utf8'))[1];
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system slack-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'slack.ia'),
    `#! ia 1.0

@slack-channel clean-space
  meaning
    says "Clean workspace channel."
  slack
    label "Clean"
    channel "clean-space"
    channel-id "C0123456789"
    workspace @workspace ${wsName}
    home "https://example.org/acme/clean.git"
    approver "T01234567 U01234567"
    members ["T01234567 U01234567"]
    app organisation
    secret "acme-slack-secret"
    disclosure link-only
`,
  );

  for (const checkName of ['slack-check-validate', 'check-slack-channels']) {
    const ran = spawnSync(
      process.execPath,
      [join(PLUGIN, 'scripts', 'check.mjs'), checkName, '--kit', KIT_ID, '--root', ws, '--cli', CLI],
      { env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(ran.status, 0, `${checkName}: ${ran.stdout}\n${ran.stderr}`);
    assert.equal(JSON.parse(ran.stdout).exitCode, 0);
  }
});

test('REQ-SLACK-BASE-05 failure: check.mjs exits 3 when check-slack-channels detects violations', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-slack-runner-fail-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-slack-base'), { cli: { argv: [process.execPath, CLI], version: '3.10.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsName = /@workspace\s+([a-z0-9-]+)/.exec(readFileSync(wsFile, 'utf8'))[1];
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system slack-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'slack.ia'),
    `#! ia 1.0

@slack-channel leaked-token-space
  meaning
    says "Space with raw token."
  slack
    label "Bad"
    channel "leaked"
    workspace @workspace ${wsName}
    home "https://example.org/acme/clean.git"
    approver "U01234567"
    members ["U07654321"]
    app organisation
    secret "xoxb-raw-secret-token"
`,
  );

  const ran = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-slack-channels', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(ran.status, 3, ran.stdout + ran.stderr);
  const body = JSON.parse(JSON.parse(ran.stdout).stdout);
  assert.equal(body.ok, false);
  assert.ok(body.findings.some(f => f.code === 'SLACK_SECRET_TOKEN'));
  assert.ok(body.findings.some(f => f.code === 'SLACK_APPROVER_NOT_MEMBER'));
});
