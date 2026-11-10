import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectMethodGraph, resolveConsumerSubject } from '../plugins/ia/scripts/lib/closure-native.mjs';
import { resolveCli } from '../plugins/ia/scripts/lib/cli.mjs';
import { findKit, readRoot } from '../plugins/ia/scripts/lib/kit.mjs';

const require = createRequire(import.meta.url);
const importNative = specifier => import(pathToFileURL(require.resolve(specifier)).href);
const kit = findKit('ia-kb');
const descriptor = JSON.parse(readFileSync(join(kit.dir, '.ia/release.json'), 'utf8'));
const cli = resolveCli(process.cwd());
assert.equal(cli.version, '3.6.0');
const root = readRoot(kit, { cli });
const { packDistribution } = await importNative('@inventarch/distribution/pack');
const nativeManifest = packDistribution(root, descriptor).manifest;
const options = { root, descriptor, nativeManifest, importNative };

test('native closure separates vocabulary ownership from retained authoring membership', async () => {
  const graph = await inspectMethodGraph(options);
  assert.deepEqual(graph.distributionRoots, ['floor/definition/system/ia-kb']);
  assert.deepEqual(graph.packagedWorkspaces, []);
  const cap = graph.capabilities.find(row => row.identity.endsWith('/kb-place-content'));
  assert.equal(cap.vocabularyOwner, 'floor/definition/system/agent-composition-system');
  assert.equal(cap.authoringSystem, 'floor/definition/system/ia-kb');
  assert.match(graph.systems[0].revision, /^[a-f0-9]{64}$/);
  const subject = await resolveConsumerSubject({ root, importNative });
  assert.equal(subject.identity, 'workspace-system/definition/workspace/ia-kb-kit');
  assert.equal(subject.revision, graph.revision);
  assert.ok(subject.systems.some(row => row.identity === cap.authoringSystem));
  await assert.rejects(resolveConsumerSubject({ root, workspaceIdentity: 'tenant-123', importNative }), /consumer native workspace/);
});

test('native plural workspace roots require separate explicit qualification', async () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'closure-native-plural-'));
  try {
    cpSync(root, scratch, { recursive: true });
    const workspace = readFileSync(join(scratch, '.ia/src/workspace.ia'), 'utf8').replace(/systems \[[^\]]+\]/, 'systems [@system ia-kb]');
    writeFileSync(join(scratch, '.ia/src/systems/ia-kb/records/compositions.ia'), workspace.replaceAll('ia-kb-kit', 'first-composition') + '\n' + workspace.replace('#! ia 1.0', '').replaceAll('ia-kb-kit', 'second-composition'));
    const distribution = join(scratch, '.ia/src/systems/ia-kb/records/distribution.ia');
    writeFileSync(distribution, readFileSync(distribution, 'utf8').replace('records [@system ia-kb]', 'records [@workspace first-composition, @workspace second-composition]'));
    const manifest = packDistribution(scratch, descriptor).manifest;
    const input = { ...options, root: scratch, nativeManifest: manifest };
    await assert.rejects(inspectMethodGraph(input), /qualified work kind/);
    const identities = ['first-composition', 'second-composition'].map(name => `workspace-system/definition/workspace/${name}`);
    const workspaceContracts = Object.fromEntries(identities.map(identity => [identity, { workKind: 'governed work', boundaryEvidence: ['qualification:local-only'] }]));
    const result = await inspectMethodGraph({ ...input, workspaceContracts });
    assert.deepEqual(result.distributionRoots, identities);
    assert.deepEqual(result.packagedWorkspaces.map(row => row.identity), identities);
    assert.ok(result.packagedWorkspaces.every(row => row.systems.includes('floor/definition/system/ia-kb')));
    // IA's repository default, ia-kb-kit, is not one of the packaged roots: it is never taken by accident.
    await assert.rejects(resolveConsumerSubject({ root: scratch, importNative }), /unambiguous/);
    const explicit = await resolveConsumerSubject({ root: scratch, workspaceIdentity: identities[1], importNative });
    assert.equal(explicit.identity, identities[1]);
    assert.ok(explicit.systems.some(row => row.identity === 'floor/definition/system/agent-composition-system'));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('with no workspace named, the repository default is taken when it is a packaged root or nothing packages a workspace', async () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'closure-native-default-'));
  const expected = 'workspace-system/definition/workspace/ia-kb-kit';
  try {
    cpSync(root, scratch, { recursive: true });
    const workspace = readFileSync(join(scratch, '.ia/src/workspace.ia'), 'utf8').replace(/systems \[[^\]]+\]/, 'systems [@system ia-kb]');
    writeFileSync(join(scratch, '.ia/src/systems/ia-kb/records/compositions.ia'), workspace.replaceAll('ia-kb-kit', 'second-composition'));
    const distribution = join(scratch, '.ia/src/systems/ia-kb/records/distribution.ia');
    const original = readFileSync(distribution, 'utf8');
    // The default is one of the packaged roots: it resolves.
    writeFileSync(distribution, original.replace('records [@system ia-kb]', 'records [@workspace ia-kb-kit, @workspace second-composition]'));
    assert.equal((await resolveConsumerSubject({ root: scratch, importNative })).identity, expected);
    // A consumer that admits no distribution and one workspace: the default resolves.
    rmSync(join(scratch, '.ia/src/systems/ia-kb/records/compositions.ia'));
    rmSync(distribution);
    const consumer = await resolveConsumerSubject({ root: scratch, importNative });
    assert.equal(consumer.identity, expected);
    assert.ok(consumer.systems.some(row => row.identity === 'floor/definition/system/ia-kb'));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('native capability roots and explicit inspection-only qualification are admitted', async () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'closure-native-capability-'));
  try {
    cpSync(root, scratch, { recursive: true });
    const distribution = join(scratch, '.ia/src/systems/ia-kb/records/distribution.ia');
    writeFileSync(distribution, readFileSync(distribution, 'utf8').replace('records [@system ia-kb]', 'records [@capability kb-place-content]'));
    const source = join(scratch, '.ia/src/systems/ia-kb/records/capabilities.ia');
    writeFileSync(source, readFileSync(source, 'utf8').replace('playbooks [@playbook kb-place-content]', 'playbooks []'));
    const manifest = packDistribution(scratch, descriptor).manifest;
    const input = { ...options, root: scratch, nativeManifest: manifest };
    await assert.rejects(inspectMethodGraph(input), /explicit supported execution mode/);
    const identity = 'agent-composition-system/definition/capability/kb-place-content';
    const graph = await inspectMethodGraph({ ...input, capabilityContracts: { [identity]: { mode: 'inspection-only' } } });
    assert.deepEqual(graph.distributionRoots, [identity]);
    assert.equal(graph.capabilities.find(row => row.identity === identity).mode, 'inspection-only');
    await assert.rejects(inspectMethodGraph({ ...input, capabilityContracts: { [identity]: { mode: 'executable' } } }), /explicit supported execution mode/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('native missing references and direct vocabulary dependencies refuse', async () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'closure-native-refusal-'));
  try {
    cpSync(root, scratch, { recursive: true });
    const source = join(scratch, '.ia/src/systems/ia-kb/records/capabilities.ia');
    const original = readFileSync(source, 'utf8');
    writeFileSync(source, original.replace('@playbook kb-place-content', '@playbook nonexistent-playbook'));
    await assert.rejects(inspectMethodGraph({ ...options, root: scratch }), /Native admission refused|Required native reference/);
    writeFileSync(source, original);
    const declaration = join(scratch, '.ia/src/systems/ia-kb/system.ia');
    writeFileSync(declaration, readFileSync(declaration, 'utf8').replace('    - agent-composition-system', ''));
    await assert.rejects(inspectMethodGraph({ ...options, root: scratch }), /IA-COMP-DISCRIMINATOR-FOREIGN/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
