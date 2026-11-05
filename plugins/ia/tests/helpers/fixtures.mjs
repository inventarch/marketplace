// Fixtures built at runtime: a stand-in IA CLI that answers from canned JSON
// the kit carries in .ia/fake-cli.json, kits with their text sources, and
// repositories with bindings. No network, no real CLI (the opt-in real-CLI
// tests set IA_CORE_TEST_CLI).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcesDigest } from '../../scripts/lib/kit.mjs';

export const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));
export const SCRIPTS = join(PLUGIN, 'scripts');

// The scripts canonicalize the workspace through realpathSync.native (on a
// Windows runner the 8.3 temp folder RUNNER~1 becomes its long form), so the
// sandbox is canonical too and expected paths compare equal.
export function sandbox(t, prefix = 'ia-core-') {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(dir, 'temp'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_CLI = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = value('--root') ?? process.cwd();
const print = v => process.stdout.write(JSON.stringify(v) + '\\n');
const command = args[0];
if (command === '--version') { process.stdout.write(VERSION + '\\n'); process.exit(0); }
if (command === 'restore' && UNAVAILABLE) {
  print({ version: 1, ok: false, code: 'IA-DIST-ARTIFACT-UNAVAILABLE', message: 'The default registry is not available', exit: 4 });
  process.exit(4);
}
if (command === 'restore' && DELISTED) {
  print({ version: 1, ok: false, code: 'IA-DIST-CONFLICT', message: 'Registry no longer lists the locked release: inventarch/language@3.2.0', exit: 3 });
  process.exit(3);
}
if (command === 'restore' && CONFLICT) {
  print({ version: 1, ok: false, code: 'IA-DIST-CONFLICT', message: 'inventarch/language: ranges conflict', exit: 3 });
  process.exit(3);
}
if (command === 'restore') {
  mkdirSync(join(root, '.ia', 'distributions'), { recursive: true });
  writeFileSync(join(root, '.ia', 'distributions', 'active.json'), '{}');
  print({ version: 1, command: 'restore', status: 'restored' });
  process.exit(0);
}
const cannedPath = join(root, '.ia', 'fake-cli.json');
const canned = existsSync(cannedPath) ? JSON.parse(readFileSync(cannedPath, 'utf8')) : {};
if (command === 'position') {
  const shape = value('--shape') ?? 'context', phase = value('--phase') ?? 'orient';
  const p = canned.position ?? {};
  if (p.refuse) { print({ version: 1, ok: false, ...p.refuse, exit: 1 }); process.exit(1); }
  const cells = (p.cells ?? []).filter(c => c.address.includes('#' + phase + '/'));
  const seat = value('--seat') ? { kind: 'record', identity: value('--seat') } : (p.seat ?? { kind: 'workspace', identity: 'workspace-system/definition/workspace/fake' });
  const body = { format: 'ia.position-body.v1', revision: p.revision ?? 'rev-fake', key: { shape, phase, depth: Number(value('--depth') ?? 1), budget: Number(value('--budget') ?? 16) }, seat, loaded: p.loaded ?? [], rules: p.rules ?? [], pointers: [], cells, mandates: p.mandates ?? [], frontier: [], unknowns: [] };
  print({ version: 1, ok: true, body, digest: 'digest-fake', hostNote: { revision: body.revision, freshness: 'no-capture', key: body.key } });
  process.exit(0);
}
if (command === 'inspect') {
  const identity = args[1];
  const inbound = value('--edges') === 'in';
  const hit = inbound ? canned.inbound?.[identity] : canned.inspect?.[identity];
  if (!hit) { print({ version: 1, ok: false, code: 'IA-DB-SOURCE-UNAVAILABLE', message: identity + ' is not admitted in this workspace', exit: 1 }); process.exit(1); }
  print(inbound ? { version: 1, root, records: [], edges: [], directed: hit } : { version: 1, root, records: [hit], edges: [], directed: [] });
  process.exit(0);
}
if (command === 'read') {
  const hit = canned.read?.[args[1]];
  if (!hit) { print({ version: 1, ok: false, code: 'IA-RUNTIME-READ-UNADMITTED', message: args[1] + ' is not in this workspace', exit: 1 }); process.exit(1); }
  const body = typeof hit === 'string' ? hit : hit.body;
  print({ version: 1, locator: args[1], identity: args[1].split('#')[0], kind: 'record', digest: typeof hit === 'string' ? 'd' : hit.digest, body, certified: false });
  process.exit(0);
}
process.stderr.write('fake ia: unsupported command ' + command + '\\n');
process.exit(2);
`;

// Writes the stand-in CLI and returns its path, with a package.json beside it
// so lib/cli.mjs reads its version (the pinned 3.5.0 unless another is given).
// restoreUnavailable and restoreDelisted: its restore refuses as a real CLI does
// for a language base it does not ship, when the registry cannot be reached
// (IA-DIST-ARTIFACT-UNAVAILABLE, exit 4) or answers that it no longer lists that
// base (IA-DIST-CONFLICT, exit 3; CLI 3.2.2 and 3.3.0 against the default
// registry, 2026-10-22). restoreConflict: its restore refuses with a conflict that
// is not about the base it ships (IA-DIST-CONFLICT, ranges conflict, exit 3).
export function fakeCli(dir, version = '3.5.0', { restoreUnavailable = false, restoreDelisted = false, restoreConflict = false } = {}) {
  const pkg = join(dir, 'fake-cli');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@inventarch/cli', version, bin: { ia: 'dist/main.js' } }));
  const main = join(pkg, 'dist', 'main.js');
  writeFileSync(main, `const VERSION = ${JSON.stringify(version)};\nconst UNAVAILABLE = ${restoreUnavailable};\nconst DELISTED = ${restoreDelisted};\nconst CONFLICT = ${restoreConflict};\n` + FAKE_CLI);
  writeFileSync(join(pkg, 'dist', 'package.json'), '{"type":"module"}');
  return main;
}

const text = (v, kind = 'string') => ({ kind, text: v });
const ref = (discriminator, name) => ({ kind: 'ref', discriminator, name });
const list = items => ({ kind: 'list', items });
const section = (name, fields) => ({ name, fields: Object.entries(fields).map(([key, value]) => ({ key, value })) });

export const PRIMARY = { orient: 'Attention', plan: 'Inference', act: 'Decision', learn: 'Learning' };
export const PRIMITIVES = ['Attention', 'Inference', 'Decision', 'Learning'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// One kit under <kitsDir>/<folder>: its sources, descriptor, lock, releases,
// checks.json and the canned CLI answers. Options: id, folder, version,
// archive, system, capability, playbook, profile (null for none), checks
// (names), effects, rules (identities), cellText; and for the playbook read by
// identity: phaseOrder (the order its phases are declared in), primitiveOrder
// ({ phase: [primitives] }, declaration order within a phase) and
// positionPlaybook (a playbook whose cells `ia position` delivers instead of
// the bound one's); delivery (capability names written to delivery.json as
// whole); profileMandate (the profile's composition.mandate); runnerChecks
// (checks declared and in checks.json that the capability does not compose). `ia position` delivers each phase's primary cell; `ia
// inspect` of the playbook lists all sixteen cells in declaration order, and
// `ia read <playbook>#<phase>/<Primitive>` answers each with its text and the
// sha256 of that text as its digest.
export function makeKit(kitsDir, o = {}) {
  const folder = o.folder ?? 'fake', id = o.id ?? 'inventarch/fake-kit', version = o.version ?? '0.1.0';
  const system = o.system ?? 'fake-system', capability = o.capability ?? 'fake-operate', playbook = o.playbook ?? 'fake-operate';
  const profile = o.profile === undefined ? 'fake-worker' : o.profile;
  const checks = o.checks ?? ['fake-gate'];
  const runnerChecks = o.runnerChecks ?? [];
  const effects = o.effects ?? ['read', 'local-write'];
  const dir = join(kitsDir, folder);
  const records = join(dir, '.ia', 'src', 'systems', system, 'records');
  mkdirSync(records, { recursive: true });
  writeFileSync(join(dir, '.ia', 'src', 'workspace.ia'), `#! ia 1.0\n\n@workspace ${folder}-kit\n  meaning\n    says "The ${id} kit."\n`);
  writeFileSync(join(dir, '.ia', 'src', 'systems', system, 'system.ia'), `#! ia 1.0\n\n@system ${system}\n  meaning\n    says "A fake system."\n`);
  const lines = [`#! ia 1.0`, ``, `@capability ${capability}`, `  meaning`, `    says "Capability ${capability} of ${id} ${version}."`, `  composition`, `    playbooks [@playbook ${playbook}]`, ...(checks.length ? [`    checks [${checks.map(c => `@check ${c}`).join(', ')}]`] : []), `  execution`, `    effects [${effects.join(', ')}]`, ``, `@playbook ${playbook}`, `  meaning`, `    says "The ${playbook} playbook."`];
  for (const c of [...checks, ...runnerChecks]) lines.push(``, `@check ${c}`, `  meaning`, `    says "Check ${c}."`, `  check`, `    runs COMP-COVERAGE`, `    scope "*"`);
  if (profile) lines.push(``, `@agent-profile ${profile}`, `  meaning`, `    says "Role brief of ${profile}: act within the packet."`, `  composition`, ...(o.profileMandate ? [`    mandate @mandate ${o.profileMandate}`] : []), `    capabilities [@capability ${capability}]`);
  if (o.profileMandate) lines.push(``, `@mandate ${o.profileMandate}`, `  meaning`, `    says "The moves the ${profile} role runs under."`);
  writeFileSync(join(records, 'method.ia'), lines.join('\n') + '\n');
  writeFileSync(join(dir, '.ia', 'release.json'), JSON.stringify({ formatVersion: 1, id, version, distribution: `workspace-system/definition/distribution/${folder}-distribution`, engine: '^0.1.1', language: ['1.0'], dependencies: [{ id: 'inventarch/language', range: '^3.2.0', systems: [] }], assets: [], license: 'Apache-2.0', description: `Fake kit ${id}.` }, null, 2) + '\n');
  writeFileSync(join(dir, '.ia', 'distributions.lock.json'), JSON.stringify({ engine: '0.1.1', formatVersion: 1, packages: [{ archive: 'a'.repeat(64), dependencies: [], id: 'inventarch/language', location: 'sha256:' + 'a'.repeat(64), manifest: 'b'.repeat(64), version: '3.2.0' }], requests: [{ id: 'inventarch/language', range: '^3.2.0' }] }) + '\n');
  const archive = o.archive ?? (version.replace(/\D/g, '') + '0').padEnd(64, 'c');
  writeFileSync(join(dir, 'releases.json'), JSON.stringify({ kit: id, releases: [{ version, archive, manifest: 'd'.repeat(64), sources: 'unverified', language: 'inventarch/language ^3.2.0', cli: '@inventarch/cli 3.5.0', records: [] }] }, null, 2) + '\n');
  writeFileSync(join(dir, 'check-ok.mjs'), `process.stdout.write('check ' + process.env.IA_CORE_CHECK + ' ran in ' + process.cwd() + '\\n');\n`);
  writeFileSync(join(dir, 'check-fail.mjs'), `process.stderr.write('check failed\\n'); process.exit(4);\n`);
  const checksJson = { format: 1, checks: {} };
  for (const c of [...checks, ...runnerChecks]) checksJson.checks[c] = { argv: ['${NODE}', `\${KIT}/check-${c.endsWith('fail') ? 'fail' : 'ok'}.mjs`], cwd: 'workspace' };
  if (o.undeclaredCheck) checksJson.checks[o.undeclaredCheck] = { argv: ['${NODE}', '-e', 'process.exit(0)'] };
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checksJson, null, 2) + '\n');
  if (o.delivery) writeFileSync(join(dir, 'delivery.json'), JSON.stringify({ format: 1, whole: o.delivery }, null, 2) + '\n');
  const mandateId = o.profileMandate ? `agent-system/policy/mandate/${o.profileMandate}` : null;
  const capId = `agent-composition-system/definition/capability/${capability}`;
  const playbookId = `governance-system/definition/procedure/${playbook}`;
  const profileId = profile ? `agent-composition-system/binding/agent-profile/${profile}` : null;
  const cellText = o.cellText ?? `${id} ${version}`;
  const positionPlaybookId = o.positionPlaybook ? `governance-system/definition/procedure/${o.positionPlaybook}` : playbookId;
  const positionText = phase => (o.positionPlaybook ? `${cellText}: ${phase} cell of ${o.positionPlaybook}` : `${cellText}: ${phase} cell`);
  const cellTextOf = (phase, primitive) => (primitive === PRIMARY[phase] ? `${cellText}: ${phase} cell` : `${cellText}: ${phase} ${primitive}`);
  const declared = (o.phaseOrder ?? Object.keys(PRIMARY)).flatMap(phase => (o.primitiveOrder?.[phase] ?? PRIMITIVES).map(primitive => ({ phase, primitive, primary: primitive === PRIMARY[phase], text: cellTextOf(phase, primitive) })));
  // What the resolver must deliver when it reads the playbook by identity: the
  // phases in orient, plan, act, learn order, each in its declared order.
  const playbookCells = Object.keys(PRIMARY).flatMap(phase => declared.filter(c => c.phase === phase)).map(c => ({ playbook: playbookId, address: `${playbookId}#${c.phase}/${c.primitive}`, text: c.text, digest: sha256(c.text), source: 'playbook' }));
  const canned = {
    position: {
      revision: `rev-${folder}-${version}`,
      seat: { kind: 'workspace', identity: `workspace-system/definition/workspace/${folder}-kit` },
      rules: (o.rules ?? [`governance-system/governance/law/${folder}-law`]).map(identity => ({ identity, word: 'law', kind: 'governance', hop: 0, digest: 'rule-' + folder })),
      mandates: [],
      loaded: [{ identity: playbookId, word: 'playbook', kind: 'definition', hop: 1, digest: 'pb-' + folder }],
      cells: Object.entries(PRIMARY).map(([phase, primitive]) => ({ playbook: positionPlaybookId, address: `${positionPlaybookId}#${phase}/${primitive}`, text: positionText(phase) })),
    },
    inspect: {
      ...Object.fromEntries([...checks, ...runnerChecks].map(name => [`compliance-system/check/gate/${name}`, { identity: `compliance-system/check/gate/${name}`, digest: sha256(name) }])),
      [capId]: { identity: capId, kind: 'definition', facet: 'capability', name: capability, sections: [section('meaning', { says: text(`Capability ${capability} of ${id} ${version}.`), answers: text('?') }), section('composition', { playbooks: list([ref('playbook', playbook)]), ...(checks.length ? { checks: list(checks.map(c => ref('check', c))) } : {}) }), section('execution', { effects: list(effects.map(e => text(e, 'scalar'))) })], digest: 'cap-' + folder },
      [playbookId]: { identity: playbookId, kind: 'definition', facet: 'playbook', name: playbook, discriminator: 'playbook', sections: [section('meaning', { says: text(`The ${playbook} playbook.`), answers: text('?') })], cells: declared, digest: 'pb-' + folder },
      ...(profileId ? { [profileId]: { identity: profileId, kind: 'binding', facet: 'agent-profile', name: profile, sections: [section('meaning', { says: text(`Role brief of ${profile}: act within the packet.`), answers: text('?') }), ...(o.profileMandate ? [section('composition', { mandate: ref('mandate', o.profileMandate) })] : [])], digest: 'profile-' + folder } } : {}),
      ...(mandateId ? { [mandateId]: { identity: mandateId, kind: 'policy', facet: 'mandate', name: o.profileMandate, sections: [section('meaning', { says: text(`The moves the ${profile} role runs under.`), answers: text('?') })], digest: 'mandate-' + folder } } : {}),
    },
    inbound: { [capId]: profileId ? [{ identity: capId, kind: 'field-ref', direction: 'in', field: 'composition.capabilities', declaredOn: profileId, counterpart: capId }] : [] },
    read: Object.fromEntries(declared.map(c => [`${playbookId}#${c.phase}/${c.primitive}`, { body: c.text, digest: sha256(c.text) }])),
  };
  writeFileSync(join(dir, '.ia', 'fake-cli.json'), JSON.stringify(canned, null, 2) + '\n');
  if (o.recorded !== false) recordSources(dir);
  return { dir, folder, id, version, archive, capability, playbook, profile, checks, runnerChecks, capId, playbookId, profileId, mandateId, positionPlaybookId, playbookCells };
}

// Records a kit's current sources digest as its latest release's, so the kit
// is trusted to run code (lib/trust.mjs) when its publisher is. Call it again
// after changing anything the digest covers (.ia/, declared assets, sidecars).
export function recordSources(dir) {
  const path = join(dir, 'releases.json');
  const index = JSON.parse(readFileSync(path, 'utf8'));
  const row = index.latest ? index.releases.find(r => r.version === index.latest) : index.releases.at(-1);
  row.sources = sourcesDigest(dir);
  writeFileSync(path, JSON.stringify(index, null, 2) + '\n');
  return row.sources;
}

// Declares kit-relative files as assets in .ia/release.json.
export function declareAssets(dir, paths) {
  const path = join(dir, '.ia', 'release.json');
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  for (const rel of paths) if (!descriptor.assets.some(a => a.path === rel)) descriptor.assets.push({ path: rel, role: 'asset' });
  writeFileSync(path, JSON.stringify(descriptor, null, 2) + '\n');
}

// The lock rows that install every kit a bindings object names, at the version and archive the kit's own
// releases.json gives when it is found in `kitsDirs`, else a placeholder: a repository that binds a kit installs it.
export function installLock(bindings) {
  const ids = [...new Set([...Object.values(bindings.bindings ?? {}).flat(), ...Object.values(bindings.defaults ?? {})].map(b => b.kit))];
  return { engine: '0.1.0', formatVersion: 1, packages: ids.map(id => ({ id, version: '0.1.0', archive: createHash('sha256').update(id).digest('hex') })) };
}

// A repository that is an IA workspace, with optional bindings and lock. A repository with bindings and no lock
// installs the kits those bindings name (a bound kit the lock does not install is refused, which tests that mean it
// say with lock: null); one with no bindings has no lock unless one is given.
export function makeRepo(dir, { bindings, lock } = {}) {
  if (bindings && lock === undefined) lock = installLock(bindings);
  mkdirSync(join(dir, '.ia', 'src'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n\n@workspace repo\n  meaning\n    says "A repository."\n');
  if (bindings) writeFileSync(join(dir, '.ia', 'bindings.json'), JSON.stringify(bindings, null, 2) + '\n');
  if (lock) writeFileSync(join(dir, '.ia', 'distributions.lock.json'), JSON.stringify(lock) + '\n');
  return dir;
}

// The environment the scripts run under in a sandbox: the stand-in CLI, the
// kits folder, a private temp folder, and no inherited IA settings.
export function envFor({ cli, kitsDir, temp, runRoot, extra = {} }) {
  const env = { ...process.env, IA_CLI_PATH: cli, IA_CORE_KITS_DIR: kitsDir, TMPDIR: temp, TEMP: temp, TMP: temp, IA_CORE_CLOSURES_DIR: join(temp, 'closures') };
  for (const k of ['IA_METHOD_CLI', 'IA_CORE_RUN_ROOT', 'IA_CORE_HOST', 'IA_CORE_HOST_ENFORCES_CHECKS', 'IA_CORE_NO_NPX', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
  Object.assign(env, extra);
  if (runRoot) env.IA_CORE_RUN_ROOT = runRoot;
  return env;
}

// Runs one plugin script and parses its JSON output.
export function run(script, args, env, { cwd, input } = {}) {
  const ran = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { env, cwd, input, encoding: 'utf8', windowsHide: true });
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  return { status: ran.status, signal: ran.signal, error: ran.error?.message ?? null, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', json };
}
