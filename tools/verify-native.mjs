// Cache-free validation against an explicitly selected existing published installation.
// No network, install, CLI effects, authored evidence or neighboring KB source reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// The published release this catalogue pins (sources.lock.json), and the one language base it ships.
const PINNED = Object.freeze({ cli: '3.8.0', language: { version: '3.2.0', archive: '7b36e4b4959a7bead1c57906cd346b419f32570dac0ac764af805ad20cd63b16' } });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumer = process.argv[2];
assert(consumer && path.isAbsolute(consumer), `Supply an existing IA ${PINNED.cli} consumer absolute root`);
const packageRoot = path.join(consumer, 'node_modules/@inventarch');
for (const name of ['cli', 'db']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, name, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@inventarch/' + name);
  assert.equal(pkg.version, PINNED.cli);
}
const { readInstalledGeneration } = await import(pathToFileURL(path.join(packageRoot, 'db/dist/distribution/index.js')));
const { readInputs } = await import(pathToFileURL(path.join(packageRoot, 'db/dist/index.js')));
const { EditorSnapshot } = await import(pathToFileURL(path.join(packageRoot, 'db/dist/editor/index.js')));
// Refuse a wider closure before the generation reader opens its distribution bodies.
const selectedLock = JSON.parse(fs.readFileSync(path.join(consumer, '.ia/distributions.lock.json'), 'utf8'));
assert.equal(selectedLock.packages.length, 1, 'Select a language-only consumer');
assert.equal(selectedLock.packages[0].id, 'inventarch/language');
assert.equal(selectedLock.packages[0].version, PINNED.language.version);
assert.equal(selectedLock.packages[0].archive, PINNED.language.archive);
const generation = readInstalledGeneration(consumer);
assert(generation, 'Existing native language installation required');
assert.equal(generation.lock.packages.length, 1, 'Refuse any corpus-bearing additional distribution');
const language = generation.lock.packages[0];
assert.equal(language.id, 'inventarch/language');
assert.equal(language.version, PINNED.language.version);
assert.equal(language.archive, PINNED.language.archive);
const input = readInputs(root, { candidateInstallation:null, adopted:[] });
const sources = [...input.sources, ...generation.sources].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const reader = new EditorSnapshot({...input, sources, installed:generation.lock.packages});
try {
  const errors = reader.report.findings.filter(f => f.severity === 'error');
  const result = {
    kind:`published-${PINNED.cli}-in-memory-native-admission`, cli:PINNED.cli, language,
    sourceFiles:input.sources.map(s => ({path:s.path, sha256:createHash('sha256').update(s.text).digest('hex')})),
    graphRevision:reader.revision, records:reader.snapshot().records.length,
    admission:errors.length ? 'refused' : 'admitted', report:reader.report,
    hostQualified:false, policyRatified:false, writes:[], evidenceInjected:false,
    limits:['Structural admission only', 'No fresh npm cohort/provenance audit', 'No installed host qualification']
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { reader.close(); }
