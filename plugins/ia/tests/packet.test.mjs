// The packet digest covers what the agent acts on and nothing else: envelope,
// binding, missing and host-determined parts may change without moving it;
// the closure (kit version, record set) and the instructions move it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemblePacket, canonical, DIGESTED, packetDigest } from '../scripts/lib/packet.mjs';

const base = () => ({
  resolver: 'inventarch/resolve 0.1.0',
  binding: { key: 'delivery.review', revision: 1 },
  closure: { kit: 'inventarch/fake-kit', version: '0.1.0', archive: 'a', sources: 's', records: ['x', 'y'] },
  scope: { entry: 'delivery', activity: 'review', subject: null, key: { shape: 'learning', phase: 'learn', depth: 1, budget: 16 }, seat: null, word: null, mapped: true, workspace: { root: '/repo', revision: 'r' } },
  instructions: [{ playbook: 'p', address: 'p#learn/Learning', text: 'review it' }],
  references: [{ identity: 'law', digest: 'd', when: 'always' }],
  role: { profile: 'profile', brief: 'brief' },
  requestedOperations: ['read'],
  runner: ['gate'],
  missing: [],
  envelope: { host: 'claude-code', cliVersion: '3.8.0', kitRoot: '/tmp/kit', latencyMs: 12 },
});

test('canonical JSON sorts keys recursively and drops undefined members', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('the digest is stable across envelope, binding and missing changes', () => {
  const one = assemblePacket(base());
  const other = assemblePacket({ ...base(), binding: { key: 'delivery.review', revision: 7 }, missing: [{ kind: 'note', message: 'x' }], runner: ['gate'], envelope: { host: 'codex', cliVersion: '2.0.1', kitRoot: '/elsewhere', latencyMs: 900 } });
  assert.equal(one.digest, other.digest);
  assert.match(one.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(DIGESTED, ['closure', 'scope', 'instructions', 'references', 'role', 'requestedOperations', 'evidence', 'effectiveOperations']);
  const reordered = { ...one, closure: { records: ['x', 'y'], sources: 's', archive: 'a', version: '0.1.0', kit: 'inventarch/fake-kit' } };
  assert.equal(packetDigest(reordered), one.digest);
});

test('a change in the closure (kit version or record set) or in the instructions changes the digest', () => {
  const one = assemblePacket(base());
  const version = assemblePacket({ ...base(), closure: { ...base().closure, version: '0.2.0' } });
  const records = assemblePacket({ ...base(), closure: { ...base().closure, records: ['x'] } });
  const instructions = assemblePacket({ ...base(), instructions: [{ playbook: 'p', address: 'p#learn/Learning', text: 'review it differently' }] });
  const role = assemblePacket({ ...base(), role: { profile: 'profile', brief: 'another brief' } });
  const effects = assemblePacket({ ...base(), requestedOperations: ['read', 'local-write'] });
  for (const changed of [version, records, instructions, role, effects]) assert.notEqual(changed.digest, one.digest);
  assert.equal(new Set([version.digest, records.digest, instructions.digest, role.digest, effects.digest]).size, 5);
});

test('the packet carries the contract, the evidence states and the host-determined operations', () => {
  const packet = assemblePacket(base());
  assert.equal(packet.contract, 1);
  assert.deepEqual(packet.effectiveOperations, { status: 'host-determined', runner: ['gate'] });
  assert.deepEqual(packet.evidence, { required: ['gate'], states: ['proposed', 'attempted', 'executed', 'verified', 'accepted'] });
  assert.equal(packet.kitUpdateAvailable, null);
});

test('required checks and allowed runner changes move the packet digest', () => {
  const one = assemblePacket(base());
  assert.notEqual(assemblePacket({ ...base(), required: [] }).digest, one.digest);
  assert.notEqual(assemblePacket({ ...base(), runner: ['other'], required: ['gate'] }).digest, one.digest);
});
