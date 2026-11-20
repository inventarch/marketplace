// The packet resolve.mjs delivers, and its canonical digest. The digest covers
// what the agent acts on (closure, scope, instructions, references, role,
// requestedOperations, required checks and allowed runners), serialized with sorted keys; the envelope (host, CLI,
// kit root, latency) is excluded, so the same
// resolution digests the same on every host and machine.
import { createHash } from 'node:crypto';

export const CONTRACT = 1;
// The attested, qualified packet/2 is not part of this contract family.
export const ACTIVATION_PACKET_CONTRACT = 3;
export const EVIDENCE_STATES = ['proposed', 'attempted', 'executed', 'verified', 'accepted'];
export const DIGESTED = ['closure', 'scope', 'instructions', 'references', 'role', 'requestedOperations', 'evidence', 'effectiveOperations'];

// JSON with every object's keys sorted, recursively; undefined members dropped.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v === undefined ? null : v)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function packetDigest(packet) {
  const subject = {};
  if (packet.contract === ACTIVATION_PACKET_CONTRACT) subject.contract = ACTIVATION_PACKET_CONTRACT;
  for (const key of DIGESTED) subject[key] = packet[key] ?? null;
  return createHash('sha256').update(canonical(subject)).digest('hex');
}

// Assembles a packet from its parts and stamps the digest. `runner` is every
// check the checker runner may run for the kit; `required` the checks the
// capability composes (the evidence a claim needs), runner by default.
export function assemblePacket({ contract = CONTRACT, resolver, binding, closure, scope, instructions, references, role, requestedOperations, runner, required, missing, envelope, kitUpdateAvailable }) {
  const packet = {
    contract,
    resolver,
    binding,
    closure,
    scope,
    instructions,
    references,
    role,
    requestedOperations,
    effectiveOperations: { status: 'host-determined', runner },
    missing,
    evidence: { required: required ?? runner, states: EVIDENCE_STATES },
    kitUpdateAvailable: kitUpdateAvailable ?? null,
    envelope,
  };
  packet.digest = packetDigest(packet);
  return packet;
}
