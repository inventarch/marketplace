// A two-kit fixture for kit dependencies (contract C3): fx-base, a kit with
// one system, and fx-app, a kit whose system requires fx-base and whose
// .ia/release.json depends on inventarch/fx-base-kit ^0.1.0. Both sit side by
// side in one source folder, as kits do in a source tree.
//   writePair(dir)                 the sources only; releases name stand-in archives
//   recordPair(dir, cli)           packs fx-base, installs it into fx-app's
//                                  workspace, packs fx-app, and records both
//                                  releases (needs the real pinned CLI)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildKit, sourcesDigest } from '../../scripts/lib/kit.mjs';
import { runIa } from '../../scripts/lib/cli.mjs';
import { kitRecordNames } from '../../scripts/lib/records.mjs';
import { PLUGIN } from './fixtures.mjs';

export const BASE_ID = 'inventarch/fx-base-kit';
export const APP_ID = 'inventarch/fx-app-kit';
const LANGUAGE_LOCK = join(PLUGIN, 'config', 'kits', 'ia-method', '.ia', 'distributions.lock.json');

const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = text => createHash('sha256').update(text).digest('hex');

function seat(name, systems) {
  return `#! ia 1.0

@workspace ${name}-kit
  meaning
    says "The ${name} fixture kit workspace."
    answers "Which systems does the ${name} fixture compose?"
  composition
    systems [${systems.map(s => `@system ${s}`).join(', ')}]
    sources [".ia/src @authored"]
    steward @agent ${name}-kit

@agent ${name}-kit
  meaning
    says "The agent of the ${name} fixture workspace."
    answers "Who acts in the ${name} fixture workspace?"
  governance
    applies []

@mandate ${name}-kit-mandate
  meaning
    says "The bounded authority in the ${name} fixture workspace."
    answers "Which moves may the agent make in the ${name} fixture workspace?"
  governance
    requires "Claim no host permission from this mandate."
  authority
    participant @agent ${name}-kit
    moves [Observation, Verification]
    scope [@workspace ${name}-kit]
`;
}

function system(name, requires) {
  return `#! ia 1.0

@system ${name}
  provider "local"
  version "0.1.0"
  describes "A fixture system for kit dependency tests."
  steward @agent ${name}-steward
  requires
${requires.map(r => `    - ${r}\n`).join('')}
@agent ${name}-steward
  meaning
    says "Owns the ${name} fixture system."
    answers "Who owns the ${name} fixture system?"
  governance
    applies []

@distribution ${name}-distribution
  meaning
    says "The release root of the ${name} fixture."
    answers "Which records does the ${name} fixture ship?"
  distribution
    records [@system ${name}]
`;
}

function records(dir, name, requires) {
  write(join(dir, '.ia', 'src', 'workspace.ia'), seat(name, ['agent-system', 'workspace-system', ...requires.filter(r => !['agent-system', 'workspace-system'].includes(r)), name]));
  write(join(dir, '.ia', 'src', 'systems', name, 'system.ia'), system(name, requires));
}

function kit(dir, { name, id, requires, dependencies }) {
  records(dir, name, requires);
  write(join(dir, '.ia', 'release.json'), json({
    formatVersion: 1, id, version: '0.1.0', distribution: `workspace-system/definition/distribution/${name}-distribution`, engine: '^0.1.1', language: ['1.0'],
    dependencies: [...dependencies, { id: 'inventarch/language', range: '^3.2.0', systems: ['agent-system', 'workspace-system'] }],
    assets: [], license: 'Apache-2.0', description: `The ${name} fixture kit.`,
    source: { repository: 'https://example.invalid/fixture.git', commit: '0000000000000000000000000000000000000000', recipe: 'ustar-v1', epoch: 1793378190 },
  }));
  mkdirSync(join(dir, '.ia'), { recursive: true });
  copyFileSync(LANGUAGE_LOCK, join(dir, '.ia', 'distributions.lock.json'));
}

const row = (dir, archive, manifest = sha(`manifest ${archive}`)) => ({ version: '0.1.0', archive, manifest, sources: sourcesDigest(dir), language: 'inventarch/language ^3.2.0', cli: '@inventarch/cli 3.8.0', records: kitRecordNames(dir) });
const record = (dir, id, archive, manifest) => writeFileSync(join(dir, 'releases.json'), json({ kit: id, releases: [row(dir, archive, manifest)] }));

// The two kit folders under dir/kits, with stand-in release rows. Returns their folders.
export function writePair(dir) {
  const kits = join(dir, 'kits'), base = join(kits, 'fx-base'), app = join(kits, 'fx-app');
  kit(base, { name: 'fx-base', id: BASE_ID, requires: ['agent-system', 'workspace-system'], dependencies: [] });
  kit(app, { name: 'fx-app', id: APP_ID, requires: ['agent-system', 'workspace-system', 'fx-base'], dependencies: [{ id: BASE_ID, range: '^0.1.0', systems: ['fx-base'] }] });
  record(base, BASE_ID, sha('stand-in fx-base'));
  record(app, APP_ID, sha('stand-in fx-app'));
  return { kits, base, app };
}

// Records real releases with the pinned CLI: fx-base is packed, vendored into
// fx-app's workspace and installed there (so fx-app's lock pins it), then
// fx-app is packed with fx-base vendored.
export function recordPair(dir, cli) {
  const pair = writePair(dir);
  const baseKit = { folder: 'fx-base', dir: pair.base, id: BASE_ID, latest: { version: '0.1.0', cli: '@inventarch/cli 3.8.0' } };
  const built = buildKit(baseKit, cli);
  try {
    record(pair.base, BASE_ID, built.digest, built.manifest);
    const vendor = join(pair.app, 'vendor');
    mkdirSync(vendor, { recursive: true });
    for (const path of [built.archive, built.base.path]) copyFileSync(path, join(vendor, path.split(/[\\/]/).at(-1)));
    writeFileSync(join(vendor, 'catalog.json'), json([built.digest, built.base.archive].map(a => ({ path: `vendor/${a}.ia.tgz`, withdrawn: false }))));
    // fx-app's sources admit only once fx-base is installed: restore and install with a seat that does not
    // require it yet, then put the real sources back.
    records(pair.app, 'fx-app', ['agent-system', 'workspace-system']);
    const restored = runIa(pair.app, ['restore', '--apply', '--yes'], { cli });
    if (restored.code !== 0) throw new Error(`fixture: ia restore of fx-app refused: ${restored.stdout}${restored.stderr}`);
    const installed = runIa(pair.app, ['install', `${BASE_ID}@0.1.0`, '--catalog', 'vendor/catalog.json', '--apply', '--yes'], { cli });
    if (installed.code !== 0) throw new Error(`fixture: ia install of fx-base into fx-app refused: ${installed.stdout}${installed.stderr}`);
    const lock = JSON.parse(readFileSync(join(pair.app, '.ia', 'distributions.lock.json'), 'utf8'));
    // Only the sources stay: the lock the install wrote, without its vendor and generation folders.
    rmSync(vendor, { recursive: true, force: true });
    rmSync(join(pair.app, '.ia', 'distributions'), { recursive: true, force: true });
    records(pair.app, 'fx-app', ['agent-system', 'workspace-system', 'fx-base']);
    const appKit = { folder: 'fx-app', dir: pair.app, id: APP_ID, latest: { version: '0.1.0', cli: '@inventarch/cli 3.8.0' } };
    const builtApp = buildKit(appKit, cli, { vendor: [built.archive, built.base.path] });
    try { record(pair.app, APP_ID, builtApp.digest, builtApp.manifest); } finally { builtApp.cleanup(); }
    return { ...pair, baseArchive: built.digest, appArchive: builtApp.digest, lock };
  } finally { built.cleanup(); }
}
