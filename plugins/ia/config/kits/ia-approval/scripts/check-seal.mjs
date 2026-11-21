#!/usr/bin/env node
// inventarch/ia-approval-kit offline seal verifier (declared check: check-seal).
// Pure Node built-in ESM (node:crypto Ed25519 + RFC 8785 JCS canonicalization),
// zero external npm dependencies, zero network access, and zero private keys in check paths.
//
// Modes:
//   1. Runner / workspace mode (invoked by plugins/ia/scripts/check.mjs):
//        node check-seal.mjs [--ia] <ia command words...>
//      Validates and captures a read-only scratch copy of the current workspace and
//      verifies its @approver, @approval-rule, @docket and @approval records offline.
//   2. Pull-request mode (target branch authority vs head branch):
//        node check-seal.mjs --repo <clone> --target <ref> --head <ref> [--cli <ia main.js>] [--now <ISO>] [--json]
//      Judges head against target's ratified @approver roster, @approval-rule set and @docket patterns.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.approval.seal-check.v1';
export const STATEMENT_PURPOSE = 'inventarch-approval';
export const STATEMENT_VERSION = 1;
export const APPROVALS_DIR = '.ia/src/approvals';
export const APPROVAL_WORD = 'approval';
const APPROVAL_SYSTEM = 'approval-system';
export const DOCKET_WORD = 'docket';
export const DESK_PRODUCER = 'desk';
export const RAW_PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const NOTICE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTICE_LAPSE_MS = 30 * 24 * 60 * 60 * 1000;
export const ROOT_FACETS = new Set(['approver', 'approval-rule', 'docket']);

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// Ed25519 group order L (little-endian), RFC 8032 section 5.1.7.
const GROUP_ORDER_LE = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
// Ed25519 prime field p = 2^255 - 19 and twisted Edwards constant d = -121665/121666 mod p (RFC 8032 section 5.1).
const ED25519_P = (1n << 255n) - 19n;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const APPROVAL_FILE_RE = /^([a-z0-9-]+)\.([0-9a-f]{12})\.([0-9a-f]{8})\.ia$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const SAFE_REF = /^[A-Za-z0-9_./@~^{}:+-]+$/;
const LF_PIN_RE = /^(?:\*|\*\.ia)[ \t]+(?:\S+[ \t]+)*text(?:=auto)?[ \t]+(?:\S+[ \t]+)*eol=lf[ \t]*$/m;
const MAX_BUFFER = 256 * 1024 * 1024;

const KEY_KINDS = ['service-held', 'person-held'];
const KEY_KIND_STRENGTH = { 'service-held': 0, 'person-held': 1 };
const VIAS = ['desk', 'slack'];
const ACTIONS = ['approve', 'delete'];
const STATUSES = ['active', 'retired', 'revoked'];
const RECOGNITIONS = ['matched', 'none', 'ambiguous'];
const SLACK_NOTICE_ACTIONS = ['set', 'remove', 'change'];

const INFORMATIONAL = new Set([
  'recovery-announced',
  'recovered-by-person',
  'recovery-cancelled',
  'revocation',
  'founding',
  'line-endings-unpinned',
  'docket-disagreement',
  'rule-names-unknown-word',
  'slack-id-announced',
  'slack-id-cancelled',
  'slack-id-completed',
]);

export const isFailing = finding => !INFORMATIONAL.has(finding.name);
export const findingLabel = finding => (finding.cause === undefined ? finding.name : `${finding.name}: ${finding.cause}`);
export const passes = report => !report.findings.some(isFailing);

// ---------------------------------------------------------------------------
// Strict RFC 4648 section 5 unpadded base64url & RFC 3339 UTC timestamp parser
// ---------------------------------------------------------------------------

export function encodeBase64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64url(text) {
  if (typeof text !== 'string' || !BASE64URL_ALPHABET.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return Buffer.from(bytes).toString('base64url') === text ? new Uint8Array(bytes) : null;
}

export function parseNowTimestamp(text) {
  const match = typeof text === 'string' ? RFC3339_UTC.exec(text) : null;
  if (match === null) {
    throw new Error(`--now requires a valid RFC 3339 UTC timestamp, got ${JSON.stringify(text)}`);
  }
  const [, yStr, mStr, dStr, hhStr, mmStr, ssStr] = match;
  const parsed = new Date(text);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(yStr) ||
    parsed.getUTCMonth() + 1 !== Number(mStr) ||
    parsed.getUTCDate() !== Number(dStr) ||
    parsed.getUTCHours() !== Number(hhStr) ||
    parsed.getUTCMinutes() !== Number(mmStr) ||
    parsed.getUTCSeconds() !== Number(ssStr)
  ) {
    throw new Error(`--now is not a valid UTC calendar timestamp: ${JSON.stringify(text)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme (JCS)
// ---------------------------------------------------------------------------

export class CanonicalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalError';
  }
}

function canonicalString(text) {
  if (LONE_SURROGATE.test(text)) throw new CanonicalError('a string holds a lone surrogate');
  return JSON.stringify(text);
}

function canonicalNumber(value) {
  if (!Number.isFinite(value)) throw new CanonicalError(`${value} is not a JSON number`);
  return JSON.stringify(value);
}

function canonicalObject(value) {
  const members = Object.keys(value)
    .sort()
    .map(name => {
      const member = value[name];
      if (member === undefined) throw new CanonicalError(`member ${name} is undefined`);
      return `${canonicalString(name)}:${canonicalize(member)}`;
    });
  return `{${members.join(',')}}`;
}

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') return canonicalObject(value);
  throw new CanonicalError(`a ${typeof value} is not JSON`);
}

// ---------------------------------------------------------------------------
// Ed25519 keys, RFC 8032 point decompression, small-order & S < L guards
// ---------------------------------------------------------------------------

function modP(n) {
  const r = n % ED25519_P;
  return r < 0n ? r + ED25519_P : r;
}

function modPowP(base, exp) {
  let result = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = modP(result * b);
    b = modP(b * b);
    e >>= 1n;
  }
  return result;
}

const ED25519_D = modP(-121665n * modPowP(121666n, ED25519_P - 2n));
const ED25519_SQRT_M1 = modPowP(2n, (ED25519_P - 1n) / 4n);

// Strict RFC 8032 section 5.1.3 canonical point decompression on -x^2 + y^2 = 1 + d*x^2*y^2.
export function decodeEd25519Point(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== RAW_PUBLIC_KEY_BYTES) return null;
  const x0 = ((bytes[31] ?? 0) >>> 7) & 1;
  let y = 0n;
  for (let i = 0; i < RAW_PUBLIC_KEY_BYTES; i++) {
    const byte = i === 31 ? (bytes[i] ?? 0) & 0x7f : (bytes[i] ?? 0);
    y |= BigInt(byte) << BigInt(8 * i);
  }
  if (y >= ED25519_P) return null;
  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(ED25519_D * y2 + 1n);
  const x2 = modP(u * modPowP(v, ED25519_P - 2n));
  if (x2 === 0n) {
    return x0 === 1 ? null : { X: 0n, Y: y, Z: 1n };
  }
  let x = modPowP(x2, (ED25519_P + 3n) / 8n);
  if (modP(x * x) !== x2) x = modP(x * ED25519_SQRT_M1);
  if (modP(x * x) !== x2) return null;
  if (Number(x & 1n) !== x0) x = ED25519_P - x;
  return { X: x, Y: y, Z: 1n };
}

function doubleEd25519Point(pt) {
  const A = modP(pt.X * pt.X);
  const B = modP(pt.Y * pt.Y);
  const C = modP(2n * modP(pt.Z * pt.Z));
  const H = modP(A + B);
  const sum = modP(pt.X + pt.Y);
  const E = modP(H - modP(sum * sum));
  const G = modP(A - B);
  const F = modP(C + G);
  return {
    X: modP(E * F),
    Y: modP(G * H),
    Z: modP(F * G),
  };
}

// Rejects all 8 cofactor torsion points ([8]P == (0, 1)).
export function isSmallOrderPoint(pt) {
  const p8 = doubleEd25519Point(doubleEd25519Point(doubleEd25519Point(pt)));
  return p8.Z === 0n || (p8.X === 0n && p8.Y === p8.Z);
}

export function isValidEd25519PublicKeyBytes(bytes) {
  const pt = decodeEd25519Point(bytes);
  return pt !== null && !isSmallOrderPoint(pt);
}

export function keyIdOf(rawPublicKey) {
  return encodeBase64url(createHash('sha256').update(rawPublicKey).digest());
}

export function nameSafeKeyTag(keyId) {
  return createHash('sha256').update(keyId).digest('hex').slice(0, 8);
}

export function decodePublicKey(text) {
  const raw = decodeBase64url(text);
  return raw !== null && raw.length === RAW_PUBLIC_KEY_BYTES && isValidEd25519PublicKeyBytes(raw) ? raw : null;
}

export function publicKeyObject(rawPublicKey) {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPublicKey)]),
    format: 'der',
    type: 'spki',
  });
}

export function rawPublicKeyOf(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(SPKI_PREFIX.length));
}

export function signingKeyFromPem(pem) {
  const privateKey = createPrivateKey(pem);
  const rawPublicKey = rawPublicKeyOf(createPublicKey(privateKey));
  return { privateKey, rawPublicKey, keyId: keyIdOf(rawPublicKey) };
}

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { key: signingKeyFromPem(pem), pem };
}

export function scalarIsCanonical(signature) {
  for (let index = RAW_PUBLIC_KEY_BYTES - 1; index >= 0; index--) {
    const s = signature[RAW_PUBLIC_KEY_BYTES + index] ?? 0;
    const l = GROUP_ORDER_LE[index] ?? 0;
    if (s !== l) return s < l;
  }
  return false;
}

const byIdentity = (a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
const bySystem = (a, b) => (a.system < b.system ? -1 : a.system > b.system ? 1 : 0);

export function buildStatement(parts) {
  return {
    ...parts,
    purpose: STATEMENT_PURPOSE,
    version: STATEMENT_VERSION,
    dependsOn: [...parts.dependsOn].sort(byIdentity),
    rules: [...parts.rules].sort(byIdentity),
    systems: [...parts.systems].sort(bySystem),
  };
}

export function encodeStatement(statement) {
  return new TextEncoder().encode(canonicalize(statement));
}

export function signStatement(statement, key) {
  return encodeBase64url(sign(null, encodeStatement(statement), key.privateKey));
}

export function verifyStatement(statement, signatureText, rawPublicKey) {
  const signature = decodeBase64url(signatureText);
  if (signature === null || signature.length !== SIGNATURE_BYTES || !scalarIsCanonical(signature)) return false;
  if (!isValidEd25519PublicKeyBytes(rawPublicKey)) return false;
  const rPoint = decodeEd25519Point(signature.subarray(0, RAW_PUBLIC_KEY_BYTES));
  if (rPoint === null || isSmallOrderPoint(rPoint)) return false;
  try {
    return verify(null, encodeStatement(statement), publicKeyObject(rawPublicKey), signature);
  } catch {
    return false;
  }
}

export function isSorted(keys) {
  return keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key);
}

export const refText = ref => `${ref.identity} ${ref.digest}`;
export function parseRefText(text) {
  const space = text.lastIndexOf(' ');
  return space > 0 ? { identity: text.slice(0, space), digest: text.slice(space + 1) } : null;
}

export const systemText = entry => `${entry.system} ${entry.version}`;
export function parseSystemText(text) {
  const space = text.lastIndexOf(' ');
  return space > 0 ? { system: text.slice(0, space), version: text.slice(space + 1) } : null;
}

// ---------------------------------------------------------------------------
// Corpus helpers, nested workspace hierarchy & record parsers
// ---------------------------------------------------------------------------

export function textField(record, key) {
  const value = record.fields?.[key];
  return typeof value === 'string' ? value : null;
}

export function listField(record, key) {
  const value = record.fields?.[key];
  return Array.isArray(value) ? value : null;
}

export function recordsOfFacet(view, facet) {
  return [...view.records.values()].filter(record => record.facet === facet);
}

export function floorLanguageVersion(view) {
  for (const record of recordsOfFacet(view, 'system')) {
    if (record.system === 'floor') {
      const version = textField(record, 'version');
      if (version !== null) return version;
    }
  }
  return null;
}

export function mintedWords(view) {
  const prefix = 'discriminators.';
  return new Set(
    recordsOfFacet(view, 'system').flatMap(system =>
      Object.keys(system.fields)
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length)),
    ),
  );
}

export function allSystemVersions(view) {
  const systems = recordsOfFacet(view, 'system').flatMap(record => {
    const version = textField(record, 'version');
    return version === null ? [] : [{ system: record.name, version }];
  });
  return systems.sort(bySystem);
}

export function systemsTiedTo(view, records) {
  const used = new Set(records.map(record => record.system));
  return allSystemVersions(view).filter(entry => used.has(entry.system));
}

function workspaceBaseOf(sourcePath) {
  if (typeof sourcePath !== 'string') return '.';
  if (sourcePath.startsWith('.ia/src/')) return '.';
  const nestedIdx = sourcePath.indexOf('/.ia/src/');
  if (nestedIdx > 0) return sourcePath.slice(0, nestedIdx);
  return '.';
}

function normalizeDeclaredRoot(rawRoot, wsBase) {
  if (typeof rawRoot !== 'string') return null;
  const trimmed = rawRoot.trim().replace(/\/+$/, '') || '.';
  if (trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.split('/').some(seg => seg === '..')) return null;
  if (wsBase === '.') return trimmed;
  if (trimmed === '.') return wsBase;
  if (trimmed === '.ia/src' || trimmed.startsWith('.ia/src/')) return `${wsBase}/${trimmed}`;
  if (trimmed === wsBase || trimmed.startsWith(`${wsBase}/`)) return trimmed;
  return null;
}

function authoredRoots(view) {
  return recordsOfFacet(view, 'workspace')
    .filter(
      workspace =>
        (workspace.provenance ?? 'workspace') === 'workspace' &&
        !workspace.sourcePath.startsWith('.ia/distributions/') &&
        !workspace.sourcePath.startsWith('.ia/floor/'),
    )
    .flatMap(workspace => {
      const wsBase = workspaceBaseOf(workspace.sourcePath);
      return (listField(workspace, 'composition.sources') ?? []).flatMap(entry => {
        const [rawRoot, placement] = entry.split(' @');
        if (placement !== 'authored') return [];
        const resolved = normalizeDeclaredRoot(rawRoot, wsBase);
        if (resolved === null) return [];
        const withinBase = wsBase === '.' || resolved === wsBase || resolved.startsWith(`${wsBase}/`);
        return withinBase ? [{ workspace: workspace.identity, root: resolved, base: wsBase }] : [];
      });
    });
}

export function authoredRootPaths(view) {
  return [...new Set(authoredRoots(view).map(entry => entry.root))];
}

export function approvalsDirOf(workspaceIdentity, view) {
  if (!view || !workspaceIdentity) return APPROVALS_DIR;
  const roots = authoredRoots(view)
    .filter(entry => entry.workspace === workspaceIdentity)
    .map(entry => entry.root);
  if (roots.length === 0) return APPROVALS_DIR;
  const iaSrcRoot = roots
    .filter(r => r === '.ia/src' || r.endsWith('/.ia/src') || r.startsWith('.ia/src/') || r.includes('/.ia/src/'))
    .sort((a, b) => b.length - a.length)[0];
  if (iaSrcRoot !== undefined) return `${iaSrcRoot}/approvals`;
  if (roots.includes('.')) return APPROVALS_DIR;
  const longest = [...roots].sort((a, b) => b.length - a.length)[0];
  return `${longest}/.ia/src/approvals`;
}

export function workspaceOfPath(view, path) {
  const seated = authoredRoots(view)
    .filter(({ root }) => root === '.' || path === root || path.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length);
  return seated[0]?.workspace ?? null;
}

function resolveWorkspaceRef(raw, workspaces) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const byId = workspaces.find(w => w.identity === trimmed);
    if (byId) return byId.identity;
    const stripped = trimmed.replace(/^@workspace\s+/, '');
    const byName = workspaces.find(w => w.name === stripped);
    return byName?.identity ?? null;
  }
  if (typeof raw.target === 'string') {
    const byTarget = workspaces.find(w => w.identity === raw.target);
    if (byTarget) return byTarget.identity;
  }
  const ref = raw.reference ?? raw;
  if (ref?.kind === 'identity' && typeof ref.identity === 'string') {
    return workspaces.find(w => w.identity === ref.identity)?.identity ?? null;
  }
  if (ref?.kind === 'ref' && ref.discriminator === 'workspace' && typeof ref.name === 'string') {
    return workspaces.find(w => w.name === ref.name)?.identity ?? null;
  }
  return null;
}

function workspaceParentsOf(workspaceIdentity, view) {
  const workspaces = recordsOfFacet(view, 'workspace');
  const ws = view.records.get(workspaceIdentity);
  if (!ws || ws.facet !== 'workspace') return [];
  const parents = new Set();

  const addParent = id => {
    if (id && id !== workspaceIdentity) parents.add(id);
  };

  // 1. Field composition.governed-by (if present)
  addParent(resolveWorkspaceRef(textField(ws, 'composition.governed-by'), workspaces));

  // 2. Explicit edges: ws --governed-by--> parent, or parent --govern--> ws
  for (const edge of ws.edges ?? []) {
    if (edge.predicate === 'governed-by' && (!edge.direction || edge.direction === 'out')) {
      addParent(resolveWorkspaceRef(edge, workspaces));
    } else if (edge.predicate === 'govern' && edge.direction === 'in') {
      addParent(resolveWorkspaceRef(edge, workspaces));
    }
  }
  for (const other of workspaces) {
    if (other.identity === workspaceIdentity) continue;
    for (const edge of other.edges ?? []) {
      if (edge.predicate === 'govern' && (!edge.direction || edge.direction === 'out')) {
        if (resolveWorkspaceRef(edge, workspaces) === workspaceIdentity) addParent(other.identity);
      }
    }
  }

  // 3. Structural containment of authored roots (e.g. .ia/src enclosing .ia/src/eng, or . enclosing subpaths)
  const roots = authoredRoots(view);
  const ownRoots = roots.filter(r => r.workspace === workspaceIdentity);
  for (const own of ownRoots) {
    for (const other of roots) {
      if (other.workspace === workspaceIdentity) continue;
      const strictlyEncloses =
        (other.root === '.' && own.root !== '.') ||
        (other.root !== own.root && own.root.startsWith(`${other.root}/`)) ||
        (other.base === '.' && own.base !== '.' && (other.root === '.' || other.root === '.ia/src'));
      if (strictlyEncloses) addParent(other.workspace);
    }
  }

  return [...parents];
}

// True when ancestorWorkspace === targetWorkspace or ancestorWorkspace governs/encloses targetWorkspace.
export function workspaceCovers(ancestorWorkspace, targetWorkspace, view) {
  if (!ancestorWorkspace || !targetWorkspace) return false;
  if (ancestorWorkspace === targetWorkspace) return true;
  if (!view) return false;
  const visited = new Set([targetWorkspace]);
  const queue = [targetWorkspace];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const parent of workspaceParentsOf(current, view)) {
      if (parent === ancestorWorkspace) return true;
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

export function organisationOf(view) {
  const roots = authoredRoots(view);
  const candidates = [...new Set(roots.map(entry => entry.workspace))];
  if (candidates.length === 0) return null;
  const outermost = candidates.filter(
    candidate => !candidates.some(other => other !== candidate && workspaceCovers(other, candidate, view) && !workspaceCovers(candidate, other, view)),
  );
  return outermost.length === 1 ? (outermost[0] ?? null) : null;
}

function parseKeyEntry(text) {
  const parts = text.split(' ');
  if (parts.length !== 5) return null;
  const [keyId, algorithm, publicText, status, from] = parts;
  if (!keyId || !algorithm || !publicText || !STATUSES.includes(status)) return null;
  if (status === 'active' && from !== '-') return null;
  const publicKey = decodePublicKey(publicText);
  const fromCommit = from === '-' ? null : from;
  const fromCommitValid = status === 'active' ? true : fromCommit !== null && COMMIT_RE.test(fromCommit);
  return {
    keyId,
    algorithm,
    publicKey,
    status,
    fromCommit,
    fromCommitValid,
    idMatchesKey: publicKey !== null && keyIdOf(publicKey) === keyId,
  };
}

export function parseApprover(record) {
  const account = textField(record, 'person.account');
  const display = textField(record, 'person.display');
  const workspaces = listField(record, 'authority.workspaces');
  const entries = listField(record, 'keys.entries');
  if (account === null || display === null || workspaces === null || entries === null) return null;
  const keys = entries.map(parseKeyEntry);
  if (keys.some(key => key === null)) return null;
  const uniqueKeyIds = new Set(keys.map(key => key.keyId));
  if (uniqueKeyIds.size !== keys.length) return null;
  return {
    identity: record.identity,
    account,
    display,
    workspaces,
    founding: textField(record, 'authority.anchor') === 'founding',
    keys,
    recoveryPending: textField(record, 'authority.recovery-pending'),
    slack: textField(record, 'person.slack'),
    slackPending: textField(record, 'person.slack-pending'),
    sourcePath: record.sourcePath,
  };
}

export function keyEntryText(entry) {
  return `${entry.keyId} ${entry.algorithm} ${encodeBase64url(entry.publicKey)} ${entry.status} ${entry.fromCommit ?? '-'}`;
}

export function parseRule(record, view = null) {
  const quorum = Number(textField(record, 'demand.quorum'));
  if (!Number.isInteger(quorum) || quorum < 1) return null;
  return {
    identity: record.identity,
    digest: record.digest,
    sourcePath: record.sourcePath,
    workspace: view ? workspaceOfPath(view, record.sourcePath) : null,
    words: listField(record, 'demand.words') ?? [],
    kinds: listField(record, 'demand.kinds') ?? [],
    paths: listField(record, 'demand.paths') ?? [],
    coversUnrecognisedPieces: textField(record, 'demand.pieces') === 'unrecognised',
    quorum,
    from: listField(record, 'demand.from'),
    via: listField(record, 'demand.via') ?? ['desk', 'slack'],
    keyKind: textField(record, 'demand.key-kind') ?? 'service-held',
    staleness: textField(record, 'demand.staleness') ?? 'unchanged-inputs',
    merge: textField(record, 'demand.merge') ?? 'person',
  };
}

export function selectsRecords(rule) {
  return rule.words.length > 0 || rule.kinds.length > 0 || rule.paths.length > 0 || rule.coversUnrecognisedPieces;
}

function ruleCoversRoot(rule) {
  return (
    rule.words.includes('approver') ||
    rule.words.includes('approval-rule') ||
    rule.kinds.includes('governance') ||
    rule.kinds.includes('definition')
  );
}

function decodeReference(reference) {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}

function parsePiece(line) {
  const fields = line.split(' ');
  if (fields.length !== 6 || fields.some(field => field === '')) {
    return `"${line}" does not have exactly 6 fields: percent-encode a space in the source reference`;
  }
  const [record, recognition, kind, reference, digest, pattern] = fields;
  if (!RECOGNITIONS.includes(recognition)) return `${record}: "${recognition}" is not matched, none or ambiguous`;
  if (!PRINTABLE_ASCII.test(reference) || BAD_ESCAPE.test(reference)) {
    return `${record}: the source reference "${reference}" is not percent-encoded: no control or non-ASCII character, and every % followed by two hex digits`;
  }
  return {
    record,
    recognition,
    source: { kind, reference: decodeReference(reference), digest },
    pattern: pattern === '-' ? null : pattern,
  };
}

export function parseDocket(record) {
  const producer = textField(record, 'docket.producer');
  const lines = listField(record, 'docket.pieces');
  if (producer === null || lines === null) return { ok: false, reason: 'docket.producer or docket.pieces is missing' };
  const pieces = [];
  for (const line of lines) {
    const piece = parsePiece(line);
    if (typeof piece === 'string') return { ok: false, reason: piece };
    if (pieces.some(earlier => earlier.record === piece.record)) return { ok: false, reason: `${piece.record} is listed twice in one docket` };
    pieces.push(piece);
  }
  return { ok: true, docket: { identity: record.identity, producer, run: textField(record, 'docket.run'), pieces } };
}

export function refusalOf(docket, head) {
  const vouched = docket.pieces.find(piece => piece.record === docket.identity || head.records.get(piece.record)?.facet === DOCKET_WORD);
  if (vouched !== undefined) {
    return { name: 'docket-self-vouching', detail: `a docket may not list a docket (${vouched.record}) as a piece` };
  }
  if (docket.producer.split(' ')[0] === DESK_PRODUCER) {
    const claimed = docket.pieces.find(piece => piece.recognition === 'matched' || piece.pattern !== null);
    if (claimed !== undefined) {
      return { name: 'desk-docket-matched', detail: `the Desk has no matcher: ${claimed.record} may be none or ambiguous with no pattern` };
    }
  }
  return null;
}

export function isUnrecognised(piece, target) {
  return piece.recognition !== 'matched' || piece.pattern === null || !target.records.has(piece.pattern);
}

export function unrecognisedPieces(target, head, findings) {
  const claims = new Map();
  const changedOrNewDockets = recordsOfFacet(head, DOCKET_WORD).filter(record => {
    const prior = target.records.get(record.identity);
    return prior === undefined || prior.digest !== record.digest;
  });
  for (const record of changedOrNewDockets) {
    const parsed = parseDocket(record);
    if (!parsed.ok) {
      findings.push({ name: 'docket-malformed', subject: record.identity, detail: parsed.reason });
      continue;
    }
    const refusal = refusalOf(parsed.docket, head);
    if (refusal !== null) {
      findings.push({ ...refusal, subject: record.identity });
      continue;
    }
    if (!target.records.has(record.identity)) {
      for (const piece of parsed.docket.pieces) {
        claims.set(piece.record, [...(claims.get(piece.record) ?? []), { docket: record.identity, piece }]);
      }
    }
  }
  const unrecognised = new Set();
  for (const [identity, made] of claims) {
    if (made.some(({ piece }) => isUnrecognised(piece, target))) unrecognised.add(identity);
    const verdicts = new Set(made.map(({ piece }) => `${piece.recognition} ${piece.pattern ?? '-'}`));
    if (verdicts.size > 1) {
      const by = made.map(({ docket, piece }) => `${docket}: ${piece.recognition}`).join('; ');
      findings.push({ name: 'docket-disagreement', subject: identity, detail: `dockets disagree, the least trusting wins (${by})` });
    }
  }
  return unrecognised;
}

function refList(texts, label) {
  const refs = [];
  for (const text of texts) {
    const ref = parseRefText(text);
    if (ref === null || !HEX64.test(ref.digest)) return `${label} entry "${text}" is not "<identity> <64 hex>"`;
    refs.push(ref);
  }
  return isSorted(refs.map(ref => ref.identity)) ? refs : `${label} is not sorted by identity`;
}

function systemList(texts) {
  const systems = [];
  for (const text of texts) {
    const entry = parseSystemText(text);
    if (entry === null) return `system-versions entry "${text}" is not "<system> <version>"`;
    systems.push(entry);
  }
  return isSorted(systems.map(entry => entry.system)) ? systems : 'system-versions is not sorted by system';
}

export function parseApproval(record) {
  const text = key => textField(record, `seal.${key}`);
  const list = key => listField(record, `seal.${key}`);
  const required = [
    'action',
    'organisation',
    'workspace',
    'record',
    'record-digest',
    'revision',
    'language-version',
    'base-commit',
    'signer',
    'key-id',
    'key-kind',
    'via',
    'request',
    'signed-at',
    'algorithm',
    'signature',
  ];
  const missing = required.filter(key => text(key) === null);
  const dependsOn = list('depends-on');
  const rules = list('rules');
  const systemTexts = list('system-versions');
  if (missing.length > 0 || dependsOn === null || rules === null || systemTexts === null) {
    const missingLists = [
      ...(dependsOn === null ? ['depends-on'] : []),
      ...(rules === null ? ['rules'] : []),
      ...(systemTexts === null ? ['system-versions'] : []),
    ];
    return { ok: false, reason: `missing seal field(s): ${[...missing, ...missingLists].join(', ')}` };
  }
  if (text('algorithm') !== 'ed25519') return { ok: false, reason: `unknown algorithm ${text('algorithm')}` };
  if (!HEX64.test(text('record-digest')) || !HEX64.test(text('revision'))) {
    return { ok: false, reason: 'a digest or the revision is not 64 lowercase hex' };
  }
  if (!COMMIT_RE.test(text('base-commit'))) return { ok: false, reason: 'base-commit is not a git object id' };
  if (!ACTIONS.includes(text('action'))) return { ok: false, reason: 'action is not approve or delete' };
  if (!KEY_KINDS.includes(text('key-kind')) || !VIAS.includes(text('via'))) {
    return { ok: false, reason: 'key-kind or via is not a known value' };
  }
  const signedAtText = text('signed-at');
  try {
    parseNowTimestamp(signedAtText);
  } catch {
    return { ok: false, reason: 'signed-at is not RFC 3339 UTC' };
  }
  const dependsOnRefs = refList(dependsOn, 'depends-on');
  const ruleRefs = refList(rules, 'rules');
  const systems = systemList(systemTexts);
  if (typeof dependsOnRefs === 'string') return { ok: false, reason: dependsOnRefs };
  if (typeof ruleRefs === 'string') return { ok: false, reason: ruleRefs };
  if (typeof systems === 'string') return { ok: false, reason: systems };
  return {
    ok: true,
    approval: {
      identity: record.identity,
      sourcePath: record.sourcePath,
      algorithm: text('algorithm'),
      signature: text('signature'),
      statement: {
        purpose: STATEMENT_PURPOSE,
        version: STATEMENT_VERSION,
        action: text('action'),
        organisation: text('organisation'),
        workspace: text('workspace'),
        record: text('record'),
        recordDigest: text('record-digest'),
        dependsOn: dependsOnRefs,
        rules: ruleRefs,
        revision: text('revision'),
        language: text('language-version'),
        systems,
        baseCommit: text('base-commit'),
        signer: text('signer'),
        keyId: text('key-id'),
        keyKind: text('key-kind'),
        via: text('via'),
        request: text('request'),
        signedAt: signedAtText,
      },
    },
  };
}

function quoted(text) {
  if (/["\\\r\n]/.test(text)) {
    throw new Error(`a value of an approval record may not hold a quote, backslash or line break: ${JSON.stringify(text)}`);
  }
  return `"${text}"`;
}

const quotedList = texts => `[${texts.map(quoted).join(', ')}]`;

export function approvalName(recordName, statement) {
  return `${recordName}-${statement.recordDigest.slice(0, 12)}-${nameSafeKeyTag(statement.keyId)}`;
}

export function approvalFileName(recordName, statement) {
  return `${recordName}.${statement.recordDigest.slice(0, 12)}.${nameSafeKeyTag(statement.keyId)}.ia`;
}

export function approvalSource(name, display, statement, signature) {
  const s = statement;
  return [
    '#! ia 1.0',
    '',
    `@approval ${name}`,
    '  meaning',
    `    says ${quoted(`${display} approved ${s.record} at ${s.recordDigest.slice(0, 12)}`)}`,
    `    answers ${quoted(s.rules.length === 0 ? 'the built-in root of the check' : s.rules.map(rule => rule.identity).join(', '))}`,
    '  seal',
    `    action ${s.action}`,
    `    organisation ${quoted(s.organisation)}`,
    `    workspace ${quoted(s.workspace)}`,
    `    record ${quoted(s.record)}`,
    `    record-digest ${quoted(s.recordDigest)}`,
    `    depends-on ${quotedList(s.dependsOn.map(refText))}`,
    `    rules ${quotedList(s.rules.map(refText))}`,
    `    revision ${quoted(s.revision)}`,
    `    language-version ${quoted(s.language)}`,
    `    system-versions ${quotedList(s.systems.map(systemText))}`,
    `    base-commit ${quoted(s.baseCommit)}`,
    `    signer ${quoted(s.signer)}`,
    `    key-id ${quoted(s.keyId)}`,
    `    key-kind ${s.keyKind}`,
    `    via ${s.via}`,
    `    request ${quoted(s.request)}`,
    `    signed-at ${quoted(s.signedAt)}`,
    '    algorithm ed25519',
    `    signature ${quoted(signature)}`,
    '',
  ].join('\n');
}

export function sealRecord(request) {
  const statement = buildStatement({
    action: request.action,
    organisation: request.organisation,
    workspace: request.workspace,
    record: request.record.identity,
    recordDigest: request.recordDigest,
    dependsOn: request.dependsOn,
    rules: request.rules,
    revision: request.revision,
    language: request.toolchain.language,
    systems: request.toolchain.systems,
    baseCommit: request.baseCommit,
    signer: request.signer.account,
    keyId: request.key.keyId,
    keyKind: request.keyKind,
    via: request.via,
    request: request.request,
    signedAt: (request.signedAt instanceof Date ? request.signedAt.toISOString() : String(request.signedAt)).replace(/\.\d{3}Z$/, 'Z'),
  });
  const signature = signStatement(statement, request.key);
  const dir = request.approvalsDir ?? (request.view ? approvalsDirOf(request.workspace, request.view) : APPROVALS_DIR);
  return {
    statement,
    signature,
    path: `${dir}/${approvalFileName(request.record.name, statement)}`,
    source: approvalSource(approvalName(request.record.name, statement), request.signer.display, statement, signature),
  };
}

// ---------------------------------------------------------------------------
// Pull-request & rule judgement (target branch authority)
// ---------------------------------------------------------------------------

export function changesBetween(target, head) {
  const changes = [];
  for (const after of head.records.values()) {
    const before = target.records.get(after.identity) ?? null;
    const unchanged = before !== null && before.digest === after.digest && before.sourcePath === after.sourcePath;
    if (after.facet === APPROVAL_WORD || unchanged) continue;
    const kind = before === null ? 'added' : before.digest === after.digest ? 'moved' : 'changed';
    changes.push({
      identity: after.identity,
      kind,
      before,
      after,
      record: after,
      action: 'approve',
      expectedDigest: after.digest,
    });
  }
  for (const before of target.records.values()) {
    if (before.facet === APPROVAL_WORD || head.records.has(before.identity)) continue;
    changes.push({
      identity: before.identity,
      kind: 'deleted',
      before,
      after: null,
      record: before,
      action: 'delete',
      expectedDigest: before.digest,
    });
  }
  return changes.sort(byIdentity);
}

export function rulesCovering(rules, record, unrecognised, view = null) {
  const recordWs = view ? workspaceOfPath(view, record.sourcePath) : null;
  return rules.filter(rule => {
    if (view && rule.workspace && recordWs && !workspaceCovers(rule.workspace, recordWs, view)) {
      return false;
    }
    return (
      rule.words.includes(record.facet) ||
      rule.kinds.includes(record.kind) ||
      rule.paths.some(prefix => record.sourcePath.startsWith(prefix)) ||
      (rule.coversUnrecognisedPieces && unrecognised.has(record.identity))
    );
  });
}

export function parseSlackNotice(text) {
  if (text === null) return null;
  const space = text.indexOf(' ');
  const action = text.slice(0, space);
  const id = text.slice(space + 1);
  return space > 0 && SLACK_NOTICE_ACTIONS.includes(action) && id !== '' ? { action, id } : null;
}

function noticeEnteredAt(notice, ctx) {
  const { facts } = ctx.input;
  const blob = facts.targetBlobOf(notice.sourcePath);
  if (blob === null) return null;
  const entry = typeof facts.targetLatestEntryOf === 'function' ? facts.targetLatestEntryOf(notice.sourcePath, blob) : facts.targetEntryOfBlob(blob);
  return entry === null ? null : facts.targetCommitTime(entry);
}

function slackCoherent(notice, current) {
  if (notice.action === 'set') return current === null;
  if (notice.action === 'change') return current !== null && current !== notice.id;
  return current === notice.id;
}

function judgeSlackRoute(change, before, after, ctx) {
  const finding = (name, detail) => ({ name, subject: change.identity, detail });
  const idChanged = before.slack !== after.slack;
  const pending = parseSlackNotice(after.slackPending);
  const announced = parseSlackNotice(before.slackPending);
  if (!idChanged && after.slackPending !== before.slackPending) {
    if (after.slackPending === null) {
      return { route: 'accepted', finding: finding('slack-id-cancelled', 'the Slack id notice was cleared; a person merges it') };
    }
    if (pending !== null && slackCoherent(pending, before.slack)) {
      return {
        route: 'accepted',
        finding: finding('slack-id-announced', `a Slack id change was announced: ${after.slackPending}; a person merges it, and the id moves after seven days`),
      };
    }
    return { route: 'none' };
  }
  const expectedAfter = announced?.action === 'remove' ? null : announced?.id;
  const completes =
    idChanged && announced !== null && after.slackPending === null && after.slack === expectedAfter && slackCoherent(announced, before.slack);
  if (!completes) return { route: 'none' };
  const noticed = noticeEnteredAt(before, ctx);
  if (noticed === null) return { route: 'none' };
  const age = ctx.input.now.getTime() - noticed.getTime();
  if (!(age >= NOTICE_DELAY_MS)) {
    return {
      route: 'refused',
      finding: finding('slack-id-pending-early', `the notice entered the target branch ${noticed.toISOString()}, fewer than seven days ago`),
    };
  }
  if (age > NOTICE_LAPSE_MS) return { route: 'none' };
  return { route: 'accepted', finding: finding('slack-id-completed', 'the Slack id moved after the notice and its delay; a person merges it') };
}

function slackIdsOf(approver) {
  const announced = parseSlackNotice(approver.slackPending);
  return [approver.slack, announced?.action === 'remove' ? null : (announced?.id ?? null)].flatMap(id => (id === null ? [] : [id]));
}

function rosterOf(view, standing) {
  const roster = [];
  for (const record of recordsOfFacet(view, 'approver')) {
    const approver = parseApprover(record);
    if (
      approver === null ||
      approver.keys.some(k => !k.idMatchesKey || k.publicKey === null || k.algorithm !== 'ed25519' || !k.fromCommitValid)
    ) {
      standing.push({ name: 'rule-malformed', subject: record.identity, detail: 'an approver record is malformed or carries a mismatched key id' });
    } else {
      roster.push(approver);
    }
  }
  const accounts = roster.map(approver => approver.account);
  const duplicateAccounts = new Set(accounts.filter((entry, index) => accounts.indexOf(entry) !== index));
  for (const account of duplicateAccounts) {
    standing.push({ name: 'duplicate-approver', subject: account, detail: `two approver records name the account ${account}` });
  }
  const slackIds = roster.flatMap(approver => slackIdsOf(approver));
  const duplicateSlackIds = new Set(slackIds.filter((id, index) => slackIds.indexOf(id) !== index));
  for (const slack of duplicateSlackIds) {
    standing.push({ name: 'duplicate-slack-id', subject: slack, detail: `two approver records carry the Slack id ${slack}` });
  }
  for (const approver of roster) {
    approver.taintedAccount = duplicateAccounts.has(approver.account);
    approver.taintedSlack = slackIdsOf(approver).some(id => duplicateSlackIds.has(id));
  }
  return roster;
}

function unknownWordWarnings(head) {
  const minted = mintedWords(head);
  return recordsOfFacet(head, 'approval-rule').flatMap(record => {
    const rule = parseRule(record, head);
    if (rule === null) return [];
    const unknown = rule.words.filter(word => !minted.has(word));
    const coversNothing = unknown.length === rule.words.length && rule.kinds.length === 0 && rule.paths.length === 0 && !rule.coversUnrecognisedPieces;
    return unknown.map(word => ({
      name: 'rule-names-unknown-word',
      subject: rule.identity,
      detail: `no system mints the word ${word}${coversNothing ? '; this rule covers no record' : ''}`,
    }));
  });
}

function rulesOf(view, standing) {
  const rules = [];
  for (const record of recordsOfFacet(view, 'approval-rule')) {
    const rule = parseRule(record, view);
    if (rule === null || !selectsRecords(rule)) {
      standing.push({
        name: 'rule-malformed',
        subject: record.identity,
        detail: 'a rule needs a quorum of at least 1 and one of words, kinds, paths or pieces',
      });
    } else {
      rules.push(rule);
    }
  }
  return rules;
}

function deduplicateFindings(list) {
  const seen = new Set();
  return list.filter(f => {
    const key = `${f.name}\0${f.subject ?? ''}\0${f.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildContext(input) {
  if (input.now !== undefined && (!(input.now instanceof Date) || Number.isNaN(input.now.getTime()))) {
    throw new Error('now must be a valid Date');
  }
  const baseStanding = [];
  if (!input.lineEndingsPinned) {
    baseStanding.push({
      name: 'line-endings-unpinned',
      subject: '.gitattributes',
      detail: 'the target branch does not pin line endings (* text eol=lf); a current-revision comparison is refused',
    });
  }
  const targetStanding = [];
  const organisation = organisationOf(input.target);
  if (organisation === null) {
    targetStanding.push({ name: 'scope-unresolved', subject: 'target', detail: 'the target branch declares no single organisation workspace' });
  }
  const roster = rosterOf(input.target, targetStanding);
  const rules = rulesOf(input.target, targetStanding);

  const headStanding = [];
  if (organisationOf(input.head) === null) {
    headStanding.push({ name: 'scope-unresolved', subject: 'head', detail: 'the head branch declares no single organisation workspace' });
  }
  rosterOf(input.head, headStanding);
  rulesOf(input.head, headStanding);

  const docketStanding = [];
  const unrecognised = unrecognisedPieces(input.target, input.head, docketStanding);
  const warnings = unknownWordWarnings(input.head);

  const changes = changesBetween(input.target, input.head);
  const rootRepairOnly =
    changes.length > 0 &&
    changes.every(c => ROOT_FACETS.has(c.record.facet) || c.record.facet === 'workspace') &&
    !headStanding.some(isFailing) &&
    !docketStanding.some(isFailing);

  const standing = deduplicateFindings([
    ...baseStanding,
    ...(rootRepairOnly ? [] : targetStanding),
    ...headStanding,
    ...docketStanding,
    ...warnings,
  ]);

  return {
    input,
    organisation: organisation ?? organisationOf(input.head),
    roster,
    rules,
    unrecognised,
    standing,
  };
}

function keyOnRoster(roster, keyId) {
  const matches = [];
  for (const approver of roster) {
    const key = approver.keys.find(entry => entry.keyId === keyId);
    if (key !== undefined) matches.push({ approver, key });
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const sameSystems = (a, b) => a.length === b.length && a.every((entry, index) => entry.system === b[index]?.system && entry.version === b[index]?.version);

function keyStanding(key, approval, ctx) {
  if (key.status === 'active') return null;
  const name = key.status === 'retired' ? 'key-retired' : 'key-revoked';
  const { facts } = ctx.input;
  const from = key.fromCommit === null || !key.fromCommitValid ? null : facts.targetPositionOf(key.fromCommit);
  if (from === null) return { name, detail: `key ${key.keyId} is ${key.status} from a commit that is not on the target branch` };
  const blob = facts.headBlobOf(approval.sourcePath);
  const entered = blob === null ? null : facts.targetEntryOfBlob(blob);
  return entered === null || entered >= from
    ? { name, detail: `key ${key.keyId} is ${key.status} and this approval enters the target branch after it` }
    : null;
}

function tiedSystems(change, approval, ctx) {
  const { head, target } = ctx.input;
  const s = approval.statement;
  const named = (view, refs) => refs.flatMap(ref => (view.records.has(ref.identity) ? [view.records.get(ref.identity)] : []));
  return systemsTiedTo(head, [change.record, ...named(head, s.dependsOn), ...named(target, s.rules)]);
}

function staleness(change, approval, ctx) {
  const { input } = ctx;
  const s = approval.statement;
  const stale = cause => ({ name: 'stale', subject: approval.sourcePath, detail: `the seal no longer holds: ${cause}`, cause });
  const changedDependencies = s.dependsOn.filter(ref => input.head.records.get(ref.identity)?.digest !== ref.digest);
  const changedRules = s.rules.filter(ref => ctx.rules.find(rule => rule.identity === ref.identity)?.digest !== ref.digest);
  const digestsMoved = s.recordDigest !== change.expectedDigest || changedDependencies.length > 0 || changedRules.length > 0;
  const toolchainMoved = !sameSystems(s.systems, tiedSystems(change, approval, ctx));
  if (digestsMoved && toolchainMoved) return [stale('toolchain')];
  const findings = [];
  if (s.recordDigest !== change.expectedDigest && s.record === change.identity) {
    findings.push({
      name: 'seal-wrong-record',
      subject: approval.sourcePath,
      detail: 'the record changed after it was signed: its digest differs from seal.record-digest',
    });
  }
  for (const ref of changedDependencies) findings.push(stale(`${ref.identity} changed since signed`));
  for (const ref of changedRules) findings.push(stale(`the rule ${ref.identity} changed`));
  if (!input.facts.isAncestorOfTarget(s.baseCommit)) findings.push(stale('the base commit is not in the target branch history'));
  return findings;
}

export function judgeApproval(change, approval, ctx) {
  const { input } = ctx;
  const s = approval.statement;
  const findings = [];
  const report = finding => findings.push({ ...finding, subject: approval.sourcePath });

  if (s.action !== change.action) {
    report({
      name: 'seal-wrong-record',
      detail: `it is a seal to ${s.action} and cannot answer ${change.kind === 'deleted' ? 'a deletion' : 'an addition or an edit'}`,
    });
  }
  if (s.record !== change.identity) {
    report({ name: 'seal-wrong-record', detail: `it names ${s.record} but is attached to ${change.identity}` });
  }
  const here = workspaceOfPath(input.head, approval.sourcePath);
  if (s.organisation !== ctx.organisation) {
    report({ name: 'seal-wrong-workspace', detail: `it was signed for organisation ${s.organisation}` });
  }
  const recordWorkspace = workspaceOfPath(change.kind === 'deleted' ? input.target : input.head, change.record.sourcePath);
  if (s.workspace !== here || s.workspace !== recordWorkspace) {
    report({ name: 'seal-wrong-workspace', detail: `it was signed for workspace ${s.workspace}, not the one that holds it and its record` });
  }

  const found = keyOnRoster(ctx.roster, s.keyId);
  if (found === null) {
    report({ name: 'signer-unknown', detail: `key ${s.keyId} is not on the target branch's roster` });
  } else if (!found.key.idMatchesKey || found.key.publicKey === null || found.key.algorithm !== 'ed25519') {
    report({ name: 'signer-unknown', detail: `the roster entry for ${s.keyId} is not an Ed25519 key with that id` });
  } else if (found.approver.account !== s.signer) {
    report({ name: 'seal-forged', detail: `key ${s.keyId} belongs to ${found.approver.account}, not ${s.signer}` });
  } else if (!verifyStatement(s, approval.signature, found.key.publicKey)) {
    report({ name: 'seal-forged', detail: 'the signature does not verify over the rebuilt statement' });
  } else if (found.approver.taintedAccount) {
    report({ name: 'signer-not-allowed', detail: `account ${found.approver.account} is duplicated on the target branch and cannot ratify until repaired` });
  } else if (s.via === 'slack' && found.approver.taintedSlack) {
    report({ name: 'signer-not-allowed', detail: `${found.approver.account} shares a duplicate Slack id on the target branch and must ratify via desk` });
  } else {
    const standing = keyStanding(found.key, approval, ctx);
    if (standing !== null) report(standing);
  }

  const staleFindings = staleness(change, approval, ctx);
  const nonStale = findings.length;
  findings.push(...staleFindings);
  return {
    approval,
    findings,
    valid: findings.length === 0,
    approver: found?.approver ?? null,
    key: found?.key ?? null,
    staleOnly: nonStale === 0 && staleFindings.length > 0 && staleFindings.every(finding => finding.name === 'stale'),
  };
}

function sealedDemand(ctx, route, subject = null, viaDesk = false) {
  const untaintedCount = ctx.roster.filter(a => !a.taintedAccount).length;
  const distinct = untaintedCount <= 1 ? 1 : 2;
  const subjectTainted = subject !== null && ctx.roster.some(a => a.account === subject && a.taintedAccount);
  return {
    viaDesk,
    distinct,
    subject: distinct <= 1 || subjectTainted ? null : subject,
    route,
  };
}

function isRevocation(was, now, ctx) {
  const samePublicKey = was.publicKey !== null && now.publicKey !== null && Buffer.from(was.publicKey).equals(Buffer.from(now.publicKey));
  if (
    was.keyId !== now.keyId ||
    was.algorithm !== now.algorithm ||
    !samePublicKey ||
    was.status === 'revoked' ||
    now.status !== 'revoked' ||
    !now.fromCommitValid ||
    now.fromCommit === null
  ) {
    return false;
  }
  const nowPos = ctx.input.facts.targetPositionOf(now.fromCommit);
  if (nowPos === null) return false;
  if (was.status === 'retired') {
    if (!was.fromCommitValid || was.fromCommit === null) return false;
    const wasPos = ctx.input.facts.targetPositionOf(was.fromCommit);
    if (wasPos === null || nowPos > wasPos) return false;
  }
  return true;
}

function touchesOutsideAllowedFields(beforeRecord, afterRecord, allowedFieldKeys) {
  if (beforeRecord.sourcePath !== afterRecord.sourcePath) return true;
  if (JSON.stringify(beforeRecord.edges ?? []) !== JSON.stringify(afterRecord.edges ?? [])) return true;
  const allowed = new Set(allowedFieldKeys);
  const allKeys = new Set([...Object.keys(beforeRecord.fields ?? {}), ...Object.keys(afterRecord.fields ?? {})]);
  for (const key of allKeys) {
    if (allowed.has(key)) continue;
    if (JSON.stringify(beforeRecord.fields?.[key]) !== JSON.stringify(afterRecord.fields?.[key])) return true;
  }
  return false;
}

function editOf(before, after, beforeRecord, afterRecord, ctx) {
  const keyIds = approver => approver.keys.map(key => key.keyId);
  const entry = (approver, keyId) => approver.keys.find(key => key.keyId === keyId);
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const nonRouteMetadataChanged = touchesOutsideAllowedFields(beforeRecord, afterRecord, [
    'keys.entries',
    'person.slack',
    'person.slack-pending',
    'authority.recovery-pending',
  ]);
  const addedKeys = keyIds(after).filter(id => !keyIds(before).includes(id));
  const removedKeys = keyIds(before).filter(id => !keyIds(after).includes(id));
  const keyOrderChanged = addedKeys.length === 0 && removedKeys.length === 0 && !sameJson(keyIds(before), keyIds(after));
  const changedKeys = keyIds(before).filter(id => {
    const was = entry(before, id);
    const now = entry(after, id);
    return now !== undefined && was !== undefined && !sameJson(was, now);
  });
  const revocationsOnly =
    !keyOrderChanged &&
    addedKeys.length === 0 &&
    removedKeys.length === 0 &&
    changedKeys.length > 0 &&
    changedKeys.every(id => {
      const was = entry(before, id);
      const now = entry(after, id);
      return was !== undefined && now !== undefined && isRevocation(was, now, ctx);
    });
  const slackTouched = before.slack !== after.slack || before.slackPending !== after.slackPending;
  return {
    otherFields: nonRouteMetadataChanged || keyOrderChanged,
    slackTouched,
    anyOther: nonRouteMetadataChanged || keyOrderChanged || slackTouched,
    addedKeys,
    removedKeys,
    changedKeys,
    revocationsOnly,
    pendingChanged: before.recoveryPending !== after.recoveryPending,
  };
}

function judgeRecovery(change, before, after, ctx) {
  const edit = editOf(before, after, change.before, change.after, ctx);
  const pending = before.recoveryPending;
  if (pending === null) {
    return { findings: [{ name: 'recovery-not-announced', subject: change.identity, detail: 'the key entries changed and no recovery notice is on the target branch' }], demand: null };
  }
  const [announcedId, ...retiring] = pending.split(' ');
  if (after.recoveryPending !== null || touchesOutsideAllowedFields(change.before, change.after, ['authority.recovery-pending', 'keys.entries'])) {
    return { findings: [{ name: 'recovery-touches-more', subject: change.identity, detail: "a recovery clears the notice and touches only the approver's key entries" }], demand: null };
  }
  const beforeUntouchedOrder = before.keys.map(k => k.keyId);
  const afterRemainingOrder = after.keys.filter(k => beforeUntouchedOrder.includes(k.keyId)).map(k => k.keyId);
  const orderPreserved = JSON.stringify(beforeUntouchedOrder) === JSON.stringify(afterRemainingOrder);
  const untouched = orderPreserved && edit.changedKeys.every(id => retiring.includes(id)) && edit.removedKeys.length === 0;
  const retired = retiring.every(id => after.keys.find(key => key.keyId === id)?.status !== 'active');
  if (!untouched || !retired) {
    return { findings: [{ name: 'recovery-touches-more', subject: change.identity, detail: 'a recovery may only retire or revoke the keys the notice names' }], demand: null };
  }
  if (edit.addedKeys.length !== 1 || edit.addedKeys[0] !== announcedId) {
    return { findings: [{ name: 'recovery-key-mismatch', subject: change.identity, detail: `the notice announced key ${announcedId}, not ${edit.addedKeys.join(', ') || 'no new key'}` }], demand: null };
  }
  const noticed = noticeEnteredAt(before, ctx);
  if (noticed === null) {
    return { findings: [{ name: 'recovery-not-announced', subject: change.identity, detail: 'the notice commit is not on the target branch history' }], demand: null };
  }
  const age = ctx.input.now.getTime() - noticed.getTime();
  if (!(age >= NOTICE_DELAY_MS)) {
    return { findings: [{ name: 'recovery-too-early', subject: change.identity, detail: `the notice entered the target branch ${noticed.toISOString()}, fewer than seven days ago` }], demand: null };
  }
  return { findings: [{ name: 'recovered-by-person', subject: change.identity, detail: "the sole approver's key was replaced after the notice and its delay; a person merges it" }], demand: null };
}

function uncomputableFromCommit(before, after, ctx) {
  const { facts } = ctx.input;
  return after.keys.find(key => {
    const was = before?.keys.find(entry => entry.keyId === key.keyId);
    const written = key.status !== 'active' && (was === undefined || was.fromCommit !== key.fromCommit || was.status !== key.status);
    return written && (!key.fromCommitValid || key.fromCommit === null || facts.targetPositionOf(key.fromCommit) === null);
  });
}

function judgeApproverEdit(change, before, after, ctx) {
  const badKey = uncomputableFromCommit(before, after, ctx);
  if (badKey !== undefined) {
    return {
      findings: [{ name: 'from-commit-uncomputable', subject: change.identity, detail: `key ${badKey.keyId}: from-commit must be a commit already on the target branch's first-parent history` }],
      demand: null,
    };
  }
  const edit = editOf(before, after, change.before, change.after, ctx);
  if (edit.revocationsOnly && !touchesOutsideAllowedFields(change.before, change.after, ['keys.entries'])) {
    return { findings: [{ name: 'revocation', subject: change.identity, detail: 'a key was revoked by the unsealed route; a person merges it' }], demand: null };
  }
  const keysMoved = edit.addedKeys.length + edit.removedKeys.length + edit.changedKeys.length > 0;
  if (edit.slackTouched && !keysMoved && !touchesOutsideAllowedFields(change.before, change.after, ['person.slack', 'person.slack-pending'])) {
    const route = judgeSlackRoute(change, before, after, ctx);
    if (route.route !== 'none') return { findings: [route.finding], demand: null };
  }
  if (ctx.roster.length === 1) {
    if (!keysMoved && edit.pendingChanged && !touchesOutsideAllowedFields(change.before, change.after, ['authority.recovery-pending'])) {
      return after.recoveryPending === null
        ? { findings: [{ name: 'recovery-cancelled', subject: change.identity, detail: 'the recovery notice was cleared; a person merges it' }], demand: null }
        : { findings: [{ name: 'recovery-announced', subject: change.identity, detail: `a recovery of the sole approver's key was announced: ${after.recoveryPending}` }], demand: null };
    }
    if (keysMoved) return judgeRecovery(change, before, after, ctx);
    return { findings: [], demand: sealedDemand(ctx, 'approver field change', null, edit.slackTouched) };
  }
  return { findings: [], demand: sealedDemand(ctx, 'approver change', before.account, edit.slackTouched) };
}

export function judgeRoot(change, ctx) {
  if (change.record.facet === 'docket') {
    if (change.kind === 'added') return { findings: [], demand: null };
    if (ctx.roster.length === 0) {
      return { findings: [{ name: 'root-needs-approver', subject: change.identity, detail: 'no approver is on the target branch to approve a docket change' }], demand: null };
    }
    return { findings: [], demand: sealedDemand(ctx, 'docket change') };
  }
  if (change.record.facet === 'approval-rule') {
    if (change.after !== null) {
      const rule = parseRule(change.after, ctx.input.head);
      if (rule === null || !selectsRecords(rule)) {
        return {
          findings: [{ name: 'rule-malformed', subject: change.identity, detail: 'a rule needs a quorum of at least 1 and one of words, kinds, paths or pieces' }],
          demand: null,
        };
      }
      if (rule.merge === 'automatic' && ruleCoversRoot(rule)) {
        return { findings: [{ name: 'root-needs-person', subject: change.identity, detail: 'a rule on approval-rule or approver records may not merge automatically' }], demand: null };
      }
    }
    if (ctx.roster.length === 0) {
      return { findings: [{ name: 'root-needs-approver', subject: change.identity, detail: 'no approver is on the target branch to approve a rule change' }], demand: null };
    }
    return { findings: [], demand: sealedDemand(ctx, 'rule change') };
  }
  if (change.record.facet === 'approver') {
    const n = ctx.roster.length;
    const before = change.before === null ? null : parseApprover(change.before);
    const after = change.after === null ? null : parseApprover(change.after);
    if (change.kind === 'added') {
      if (after === null || after.keys.some(k => !k.idMatchesKey || k.publicKey === null || k.algorithm !== 'ed25519')) {
        return { findings: [{ name: 'rule-malformed', subject: change.identity, detail: 'the approver record is malformed' }], demand: null };
      }
      const badAddedKey = uncomputableFromCommit(null, after, ctx);
      if (badAddedKey !== undefined) {
        return {
          findings: [{ name: 'from-commit-uncomputable', subject: change.identity, detail: `key ${badAddedKey.keyId}: from-commit must be a commit already on the target branch's first-parent history` }],
          demand: null,
        };
      }
      if (n === 0) {
        return after.founding
          ? { findings: [{ name: 'founding', subject: change.identity, detail: 'the founding approver record; a person merges it' }], demand: null }
          : { findings: [{ name: 'root-needs-approver', subject: change.identity, detail: 'the first approver must carry authority.anchor founding' }], demand: null };
      }
      return { findings: [], demand: sealedDemand(ctx, 'approver added', null, after.slack !== null) };
    }
    if (change.kind === 'deleted') {
      if (n <= 1) {
        return {
          findings: [{ name: 'root-needs-approver', subject: change.identity, detail: 'the last approver record may not be deleted; a sole approver replaces keys by the recovery route' }],
          demand: null,
        };
      }
      return { findings: [], demand: sealedDemand(ctx, 'approver deleted', before?.account ?? null) };
    }
    if (after === null || after.keys.some(k => !k.idMatchesKey || k.publicKey === null || k.algorithm !== 'ed25519')) {
      return { findings: [{ name: 'rule-malformed', subject: change.identity, detail: 'the approver record is malformed' }], demand: null };
    }
    if (before === null) {
      return { findings: [], demand: sealedDemand(ctx, 'approver repair') };
    }
    return judgeApproverEdit(change, before, after, ctx);
  }
  return { findings: [], demand: null };
}

function fileNameParts(path) {
  const file = path.split('/').pop() ?? '';
  const match = APPROVAL_FILE_RE.exec(file);
  return match === null ? null : { name: match[1], digest: match[2], tag: match[3] };
}

function readApprovals(input, findings) {
  const approvals = [];
  for (const record of recordsOfFacet(input.head, APPROVAL_WORD)) {
    const prior = input.target.records.get(record.identity);
    if (prior !== undefined && prior.digest === record.digest && prior.sourcePath === record.sourcePath) {
      continue;
    }
    const parsed = parseApproval(record);
    if (!parsed.ok) {
      findings.push({ name: 'seal-malformed', subject: record.sourcePath, detail: parsed.reason });
      continue;
    }
    const parts = fileNameParts(record.sourcePath);
    const s = parsed.approval.statement;
    const expectedRecordName = s.record.split('/').pop() ?? '';
    if (parts === null || parts.name !== expectedRecordName || parts.digest !== s.recordDigest.slice(0, 12) || parts.tag !== nameSafeKeyTag(s.keyId)) {
      findings.push({
        name: 'seal-malformed',
        subject: record.sourcePath,
        detail: `approval file name must match ${expectedRecordName}.${s.recordDigest.slice(0, 12)}.${nameSafeKeyTag(s.keyId)}.ia`,
      });
      continue;
    }
    approvals.push({ approval: parsed.approval, claimedName: parts.name });
  }
  return approvals;
}

function validLanguageSet(inputOrOpts) {
  return new Set([inputOrOpts.language, inputOrOpts.cliVersion].filter(v => typeof v === 'string' && v.length > 0));
}

function validRevisionSet(view) {
  return new Set([view.revision, view.unsealedRevision, ...(view.validRevisions ?? [])].filter(v => typeof v === 'string' && v.length > 0));
}

function revisionRefusal(revision, language, ctx) {
  if (!ctx.input.lineEndingsPinned) {
    return { name: 'line-endings-unpinned-revision', detail: 'a current-revision rule cannot compare the revision while line endings are not pinned' };
  }
  const languages = validLanguageSet(ctx.input);
  if (languages.size > 0 && !languages.has(language)) {
    return { name: 'stale', detail: 'a current-revision rule: the language version changed; re-ratify', cause: 'the language version changed; re-ratify' };
  }
  const revisions = validRevisionSet(ctx.input.head);
  return revisions.has(revision)
    ? null
    : { name: 'stale', detail: 'a current-revision rule: the organisation revision changed; re-ratify', cause: 'the organisation revision changed; re-ratify' };
}

export function approverCoversWorkspace(approver, workspaceIdentity, view) {
  if (!workspaceIdentity) return false;
  return approver.workspaces.some(granted => workspaceCovers(granted, workspaceIdentity, view));
}

function requiredWorkspacesForRule(rule, change, ctx) {
  const required = [];
  if (change.before !== null) {
    const beforeRules = rulesCovering([rule], change.before, ctx.unrecognised, ctx.input.target);
    if (beforeRules.length > 0) {
      const ws = workspaceOfPath(ctx.input.target, change.before.sourcePath);
      if (ws) required.push({ workspace: ws, view: ctx.input.target });
    }
  }
  if (change.after !== null) {
    const afterRules = rulesCovering([rule], change.after, ctx.unrecognised, ctx.input.head);
    if (afterRules.length > 0) {
      const ws = workspaceOfPath(ctx.input.head, change.after.sourcePath);
      if (ws) required.push({ workspace: ws, view: ctx.input.head });
    }
  }
  if (required.length === 0) {
    const fallbackView = change.kind === 'deleted' ? ctx.input.target : ctx.input.head;
    const ws = workspaceOfPath(fallbackView, change.record.sourcePath);
    if (ws) required.push({ workspace: ws, view: fallbackView });
  }
  return required;
}

function answersToRule(rule, change, judgements, ctx) {
  const accounts = new Set();
  const findings = [];
  const requiredSeats = requiredWorkspacesForRule(rule, change, ctx);
  for (const judgement of judgements) {
    const { approver } = judgement;
    const s = judgement.approval.statement;
    if (!judgement.valid || approver === null || !s.rules.some(ref => ref.identity === rule.identity)) continue;
    const coversAllSeats =
      requiredSeats.length > 0 && requiredSeats.every(({ workspace, view }) => approverCoversWorkspace(approver, workspace, view));
    const allowed =
      rule.via.includes(s.via) &&
      KEY_KIND_STRENGTH[s.keyKind] >= KEY_KIND_STRENGTH[rule.keyKind] &&
      (rule.from === null || rule.from.includes(approver.account)) &&
      coversAllSeats;
    if (!allowed) {
      findings.push({
        name: 'signer-not-allowed',
        subject: judgement.approval.sourcePath,
        detail: `${approver.account} may not sign for ${rule.identity} here, by ${s.via}, with a ${s.keyKind} key`,
      });
    } else if (rule.staleness === 'current-revision') {
      const refusal = revisionRefusal(s.revision, s.language, ctx);
      if (refusal === null) accounts.add(approver.account);
      else findings.push({ ...refusal, subject: judgement.approval.sourcePath });
    } else {
      accounts.add(approver.account);
    }
  }
  return { accounts, findings };
}

function answersToRoot(demand, judgements, subject) {
  const accounts = new Set(judgements.flatMap(j => (j.valid && j.approver !== null ? [j.approver.account] : [])));
  const viaSlack = judgements.find(j => j.valid && j.approval.statement.via !== 'desk');
  if (demand.viaDesk && viaSlack !== undefined) {
    return {
      met: false,
      findings: [{ name: 'slack-id-needs-desk', subject, detail: 'a change to a Slack id needs every counted seal via desk' }],
    };
  }
  const met = accounts.size >= demand.distinct && (demand.subject === null || accounts.has(demand.subject));
  return { met, findings: [] };
}

function coveringRulesForChange(change, ctx) {
  const map = new Map();
  if (change.before !== null) {
    for (const rule of rulesCovering(ctx.rules, change.before, ctx.unrecognised, ctx.input.target)) {
      map.set(rule.identity, rule);
    }
  }
  if (change.after !== null) {
    for (const rule of rulesCovering(ctx.rules, change.after, ctx.unrecognised, ctx.input.head)) {
      map.set(rule.identity, rule);
    }
  }
  return [...map.values()];
}

function judgeChange(change, candidates, ctx) {
  const rules = coveringRulesForChange(change, ctx);
  const root = ROOT_FACETS.has(change.record.facet) ? judgeRoot(change, ctx) : { findings: [], demand: null };
  if (rules.length === 0 && root.demand === null && root.findings.length === 0) {
    return { report: null, findings: [], needsPerson: false };
  }
  const forRecord = candidates
    .filter(({ approval }) => approval.statement.record === change.identity)
    .map(({ approval }) => approval);
  const exactCurrent = forRecord.filter(
    approval => approval.statement.action === change.action && approval.statement.recordDigest === change.expectedDigest,
  );
  const attached = exactCurrent.length > 0 ? exactCurrent : forRecord;
  const judgements = attached.map(approval => judgeApproval(change, approval, ctx));
  const findings = [...root.findings, ...judgements.flatMap(j => j.findings)];
  let met = true;
  for (const rule of rules) {
    const { accounts, findings: refused } = answersToRule(rule, change, judgements, ctx);
    findings.push(...refused);
    if (accounts.size < rule.quorum) {
      met = false;
      findings.push({
        name: 'unratified',
        subject: change.identity,
        detail: `rule ${rule.identity}: ${accounts.size} of ${rule.quorum} distinct approver(s)`,
      });
    }
  }
  const answered = root.demand === null ? null : answersToRoot(root.demand, judgements, change.identity);
  if (root.demand !== null && answered !== null && !answered.met) {
    met = false;
    findings.push(...answered.findings);
    const { distinct, route } = root.demand;
    findings.push({
      name: 'unratified',
      subject: change.identity,
      detail: `built-in root (${route}): needs ${distinct} distinct approver(s)${root.demand.subject === null ? '' : ` including ${root.demand.subject}`}`,
    });
  }
  const refused = root.findings.some(isFailing);
  const verdict =
    !met || refused
      ? judgements.some(j => j.staleOnly)
        ? 'stale'
        : 'unratified'
      : judgements.some(j => j.valid && j.key?.status === 'revoked')
        ? 'sealed-by-revoked-key'
        : 'ratified';
  return {
    report: { identity: change.identity, change: change.kind, verdict },
    findings,
    needsPerson: ROOT_FACETS.has(change.record.facet) || rules.some(rule => rule.merge === 'person'),
  };
}

export function checkSeal(input) {
  const ctx = buildContext(input);
  const findings = [...ctx.standing];
  const candidates = readApprovals(input, findings);
  const records = [];
  let needsPersonMerge = false;
  for (const change of changesBetween(input.target, input.head)) {
    const judged = judgeChange(change, candidates, ctx);
    findings.push(...judged.findings);
    needsPersonMerge = needsPersonMerge || (judged.needsPerson && judged.report !== null);
    if (judged.report !== null) records.push(judged.report);
  }
  return { format: FORMAT, mode: 'pull-request', records, findings, needsPersonMerge };
}

// ---------------------------------------------------------------------------
// Single-workspace offline audit (for scripts/check.mjs check-seal)
// ---------------------------------------------------------------------------

export function checkWorkspace(view, options = {}) {
  const lfPinned = options.lineEndingsPinned ?? true;
  const languages = validLanguageSet(options);
  const revisions = validRevisionSet(view);
  const findings = [];
  if (!lfPinned) {
    findings.push({
      name: 'line-endings-unpinned',
      subject: '.gitattributes',
      detail: 'line endings (* text eol=lf) are not pinned; current-revision comparisons are refused',
    });
  }
  const organisation = organisationOf(view);
  if (organisation === null) {
    findings.push({ name: 'scope-unresolved', subject: 'workspace', detail: 'the workspace declares no single outermost organisation workspace' });
  }
  const roster = rosterOf(view, findings);
  const rules = rulesOf(view, findings);
  findings.push(...unknownWordWarnings(view));

  for (const rule of rules) {
    if (rule.merge === 'automatic' && ruleCoversRoot(rule)) {
      findings.push({
        name: 'root-needs-person',
        subject: rule.identity,
        detail: 'a rule covering approval-rule or approver records may not merge automatically',
      });
    }
  }

  const unrecognised = new Set();
  const docketClaims = new Map();
  for (const record of recordsOfFacet(view, DOCKET_WORD)) {
    const parsed = parseDocket(record);
    if (!parsed.ok) {
      findings.push({ name: 'docket-malformed', subject: record.identity, detail: parsed.reason });
      continue;
    }
    const refusal = refusalOf(parsed.docket, view);
    if (refusal !== null) {
      findings.push({ ...refusal, subject: record.identity });
      continue;
    }
    for (const piece of parsed.docket.pieces) {
      docketClaims.set(piece.record, [...(docketClaims.get(piece.record) ?? []), piece]);
    }
  }
  for (const [pieceId, pieces] of docketClaims) {
    if (pieces.some(piece => isUnrecognised(piece, view))) unrecognised.add(pieceId);
  }

  // Pre-parse approvals so we can distinguish superseded historical seals from tampered/unsealed current records
  const parsedApprovals = [];
  for (const record of recordsOfFacet(view, APPROVAL_WORD)) {
    const parsed = parseApproval(record);
    if (!parsed.ok) {
      findings.push({ name: 'seal-malformed', subject: record.sourcePath, detail: parsed.reason });
      continue;
    }
    const { approval } = parsed;
    const s = approval.statement;
    const parts = fileNameParts(record.sourcePath);
    const expectedRecordName = s.record.split('/').pop() ?? '';
    if (
      parts === null ||
      parts.name !== expectedRecordName ||
      parts.digest !== s.recordDigest.slice(0, 12) ||
      parts.tag !== nameSafeKeyTag(s.keyId)
    ) {
      findings.push({
        name: 'seal-malformed',
        subject: record.sourcePath,
        detail: `approval file name does not match ${expectedRecordName}.${s.recordDigest.slice(0, 12)}.${nameSafeKeyTag(s.keyId)}.ia`,
      });
      continue;
    }
    parsedApprovals.push({ record, approval });
  }

  // First pass: evaluate each approval record
  const evaluated = parsedApprovals.map(({ record, approval }) => {
    const s = approval.statement;
    const sealFindings = [];
    const failSeal = (name, detail, cause) => {
      sealFindings.push({ name, subject: record.sourcePath, detail, ...(cause ? { cause } : {}) });
    };

    const here = workspaceOfPath(view, record.sourcePath);
    if (organisation !== null && s.organisation !== organisation) {
      failSeal('seal-wrong-workspace', `it was signed for organisation ${s.organisation}, not ${organisation}`);
    }
    if (s.workspace !== here) {
      failSeal('seal-wrong-workspace', `it was signed for workspace ${s.workspace}, not ${here}`);
    }

    const found = keyOnRoster(roster, s.keyId);
    let cryptoOk = false;
    if (found === null) {
      failSeal('signer-unknown', `key ${s.keyId} is not on the workspace approver roster`);
    } else if (found.approver.account !== s.signer) {
      failSeal('seal-forged', `key ${s.keyId} belongs to ${found.approver.account}, not ${s.signer}`);
    } else if (!verifyStatement(s, approval.signature, found.key.publicKey)) {
      failSeal('seal-forged', 'the signature does not verify over the rebuilt RFC 8785 JCS statement');
    } else {
      cryptoOk = true;
      if (found.approver.taintedAccount) {
        failSeal('signer-not-allowed', `account ${found.approver.account} is duplicated and cannot ratify`);
      } else if (s.via === 'slack' && found.approver.taintedSlack) {
        failSeal('signer-not-allowed', `${found.approver.account} shares a duplicate Slack id and must ratify via desk`);
      } else if (found.key.status !== 'active') {
        failSeal(found.key.status === 'retired' ? 'key-retired' : 'key-revoked', `key ${s.keyId} has status ${found.key.status}`);
      }
    }

    const targetRecord = view.records.get(s.record) ?? null;
    let isHistoricalDigest = false;
    if (s.action === 'approve') {
      if (targetRecord === null) {
        isHistoricalDigest = true;
        failSeal('seal-wrong-record', `approved record ${s.record} is absent from the workspace`);
      } else {
        if (workspaceOfPath(view, targetRecord.sourcePath) !== s.workspace) {
          failSeal('seal-wrong-workspace', `record ${s.record} is not seated in ${s.workspace}`);
        }
        if (targetRecord.digest !== s.recordDigest) {
          isHistoricalDigest = true;
          failSeal('seal-wrong-record', 'the record changed after it was signed: its digest differs from seal.record-digest');
        }
      }
    } else if (targetRecord !== null) {
      isHistoricalDigest = true;
      failSeal('seal-wrong-record', `delete seal names ${s.record}, which is still present in the workspace`);
    }

    for (const dep of s.dependsOn) {
      if (view.records.get(dep.identity)?.digest !== dep.digest) {
        failSeal('stale', `the seal no longer holds: ${dep.identity} changed since signed`, `${dep.identity} changed since signed`);
      }
    }

    const countedRules = [];
    for (const ruleRef of s.rules) {
      const rule = rules.find(r => r.identity === ruleRef.identity);
      if (!rule || rule.digest !== ruleRef.digest) {
        failSeal('stale', `the seal no longer holds: the rule ${ruleRef.identity} changed`, `the rule ${ruleRef.identity} changed`);
        continue;
      }
      if (found !== null) {
        const allowed =
          rule.via.includes(s.via) &&
          KEY_KIND_STRENGTH[s.keyKind] >= KEY_KIND_STRENGTH[rule.keyKind] &&
          (rule.from === null || rule.from.includes(found.approver.account)) &&
          approverCoversWorkspace(found.approver, s.workspace, view);
        if (!allowed) {
          failSeal('signer-not-allowed', `${found.approver.account} may not sign for ${rule.identity} here`);
        } else if (rule.staleness === 'current-revision') {
          if (!lfPinned) {
            failSeal('line-endings-unpinned-revision', 'a current-revision rule requires pinned LF line endings');
          } else if (languages.size > 0 && !languages.has(s.language)) {
            failSeal('stale', 'the language version changed; re-ratify', 'the language version changed; re-ratify');
          } else if (!revisions.has(s.revision)) {
            failSeal('stale', 'the organisation revision changed; re-ratify', 'the organisation revision changed; re-ratify');
          } else {
            countedRules.push(rule.identity);
          }
        } else {
          countedRules.push(rule.identity);
        }
      }
    }

    return {
      record,
      approval,
      found,
      cryptoOk,
      isHistoricalDigest,
      sealOk: sealFindings.length === 0,
      sealFindings,
      countedRules,
    };
  });

  // Records with at least one valid current seal supersede older cryptographically-valid historical seals
  const recordsWithValidCurrentSeal = new Set(
    evaluated.filter(e => e.sealOk).map(e => e.approval.statement.record),
  );

  const records = [];
  const ruleAccountsByRecord = new Map();

  for (const item of evaluated) {
    const s = item.approval.statement;
    if (!item.sealOk && item.cryptoOk && item.isHistoricalDigest && recordsWithValidCurrentSeal.has(s.record)) {
      records.push({ identity: item.record.identity, change: 'verified', verdict: 'superseded' });
      continue;
    }
    findings.push(...item.sealFindings);
    if (item.sealOk && item.found !== null && s.action === 'approve') {
      for (const ruleId of item.countedRules) {
        const key = `${s.record}\0${ruleId}`;
        const set = ruleAccountsByRecord.get(key) ?? new Set();
        set.add(item.found.approver.account);
        ruleAccountsByRecord.set(key, set);
      }
    }
    records.push({ identity: item.record.identity, change: 'verified', verdict: item.sealOk ? 'ratified' : 'unratified' });
  }

  // Enforce covering @approval-rule quorum over all workspace-authored non-approval records
  const authoredRecords = [...view.records.values()]
    .filter(r => r.facet !== APPROVAL_WORD && (r.provenance ?? 'workspace') === 'workspace' && workspaceOfPath(view, r.sourcePath) !== null)
    .sort(byIdentity);

  for (const authored of authoredRecords) {
    const covering = rulesCovering(rules, authored, unrecognised, view);
    if (covering.length === 0) continue;
    let met = true;
    for (const rule of covering) {
      const accounts = ruleAccountsByRecord.get(`${authored.identity}\0${rule.identity}`) ?? new Set();
      if (accounts.size < rule.quorum) {
        met = false;
        findings.push({
          name: 'unratified',
          subject: authored.identity,
          detail: `rule ${rule.identity}: ${accounts.size} of ${rule.quorum} distinct approver(s)`,
        });
      }
    }
    if (!met) {
      records.push({ identity: authored.identity, change: 'workspace', verdict: 'unratified' });
    }
  }

  return {
    format: FORMAT,
    mode: 'workspace',
    revision: view.revision,
    approvers: roster.length,
    rules: rules.length,
    approvals: evaluated.length,
    records,
    findings,
    needsPersonMerge: roster.length > 0 || rules.length > 0,
  };
}

// ---------------------------------------------------------------------------
// IA CLI & Git adapters
// ---------------------------------------------------------------------------

function valueText(value) {
  return value.kind === 'ref' ? `@${value.discriminator} ${value.name}` : (value.text ?? '');
}

function fieldValue(value) {
  return value.kind === 'list' ? (value.items ?? []).map(valueText) : valueText(value);
}

function recordOfSnapshot(entry) {
  const fields = {};
  for (const field of entry.head ?? []) {
    if (field.value !== undefined) fields[field.key] = fieldValue(field.value);
  }
  for (const section of entry.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.value !== undefined) fields[`${section.name}.${field.key}`] = fieldValue(field.value);
    }
  }
  return {
    identity: entry.identity,
    system: entry.system,
    kind: entry.kind,
    facet: entry.facet,
    name: entry.name,
    digest: entry.digest,
    sourcePath: entry.source.path,
    provenance: entry.provenance ?? 'workspace',
    edges: entry.edges ?? [],
    fields,
  };
}

export class IaCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IaCliError';
  }
}

export class IaCli {
  constructor(commandOrPath, options = {}) {
    this.command = Array.isArray(commandOrPath) ? commandOrPath : [process.execPath, commandOrPath];
    this.env = options.env ?? process.env;
  }

  execute(args, cwd) {
    const done = spawnSync(this.command[0], [...this.command.slice(1), ...args], {
      cwd,
      env: { ...this.env, IA_NO_HANDOFF: '1' },
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    if (done.error) throw new IaCliError(done.error.message);
    if (done.status !== 0) {
      throw new IaCliError(`ia ${args.join(' ')} exited ${done.status}: ${(done.stdout || done.stderr || '').trim().slice(0, 600)}`);
    }
    return done.stdout;
  }

  run(root, args) {
    return this.execute([...args, '--root', root], root);
  }

  version() {
    const done = spawnSync(this.command[0], [...this.command.slice(1), '--version'], {
      env: { ...this.env, IA_NO_HANDOFF: '1' },
      encoding: 'utf8',
      windowsHide: true,
    });
    return (done.stdout || '').trim().replace(/^ia\s+/, '');
  }

  restore(root) {
    if (existsSync(join(root, '.ia', 'distributions.lock.json')) && !existsSync(join(root, '.ia', 'distributions', 'active.json'))) {
      const catalogRel = buildOfflineCatalog(root);
      if (catalogRel !== null) {
        try {
          this.run(root, ['restore', '--catalog', catalogRel, '--apply', '--yes']);
          return;
        } catch {
          // Fall back to default restore when lock only needs built-in floor language
        }
      }
      this.run(root, ['restore', '--apply', '--yes']);
    }
  }

  validateAdmitted(root) {
    const done = spawnSync(this.command[0], [...this.command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], {
      cwd: root,
      env: { ...this.env, IA_NO_HANDOFF: '1' },
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    let reply;
    try {
      reply = JSON.parse(done.stdout);
    } catch {
      reply = undefined;
    }
    if (reply?.status === 'admitted') return;
    const first = (reply?.findings ?? []).find(f => f.severity === 'error');
    const detail = first ? `${first.code}: ${first.message}` : (done.stderr || done.stdout || `exit ${done.status}`).trim();
    throw new IaCliError(`ia validate refused the workspace (${detail})`);
  }

  capture(root) {
    this.run(root, ['capture']);
    const snapshot = JSON.parse(readFileSync(join(root, '.ia', 'work', 'snapshot', 'current.json'), 'utf8'));
    if (snapshot.format !== 'ia-snapshot-1') throw new IaCliError(`unknown snapshot format ${snapshot.format}`);
    return {
      revision: snapshot.authoredRevision,
      records: new Map(snapshot.records.map(entry => [entry.identity, recordOfSnapshot(entry)])),
    };
  }
}

// Strips @approval records/files in a scratch copy so current-revision seals match pre-seal authored revisions
// without ever accepting post-seal edits to non-approval records.
function stripApprovalRecordsFromFile(fullPath) {
  if (!existsSync(fullPath)) return;
  const content = readFileSync(fullPath, 'utf8');
  const blocks = content.split(/^(?=@)/m);
  const header = blocks[0]?.startsWith('@') ? '' : (blocks.shift() ?? '');
  const kept = blocks.filter(block => !/^@approval\s/.test(block));
  if (kept.length === 0) {
    rmSync(fullPath, { force: true });
  } else {
    writeFileSync(fullPath, `${header}${kept.join('')}`);
  }
}

// A probe counts only when stripping removed approvals and nothing else: every other record of the full capture keeps
// its identity and digest, and the probe adds none. stripApprovalRecordsFromFile splits raw lines, so it could also cut
// into another record's text, or bring back text hidden inside an approval's value; either way the records differ from
// the full capture's, and the probe adds no revision. An approval here is approval-system's word; a local word that
// declares the approval facet is compared like any other record.
const isApprovalRecord = record => record.system === APPROVAL_SYSTEM && record.facet === APPROVAL_WORD;
function probeKeepsOtherRecords(full, probe) {
  for (const [identity, record] of full.records) {
    if (isApprovalRecord(record)) continue;
    if (probe.records.get(identity)?.digest !== record.digest) return false;
  }
  for (const [identity, record] of probe.records) {
    if (!isApprovalRecord(record) && !full.records.has(identity)) return false;
  }
  return true;
}

function captureRevisionWithoutApprovalPaths(cli, baseDir, scratchRoot, tag, approvalPathsToStrip, full) {
  const probe = join(scratchRoot, tag);
  mkdirSync(probe, { recursive: true });
  for (const name of readdirSync(baseDir)) {
    if (name === '.git') continue;
    cpSync(join(baseDir, name), join(probe, name), {
      recursive: true,
      filter: src => !/[\\/]\.ia[\\/]work(?:[\\/]|$)/.test(src),
    });
  }
  for (const relPath of approvalPathsToStrip) {
    stripApprovalRecordsFromFile(join(probe, relPath));
  }
  try {
    const probed = cli.capture(probe);
    return probeKeepsOtherRecords(full, probed) ? probed.revision : null;
  } catch {
    return null;
  }
}

function populateValidRevisions(cli, directory, view, scratchRoot, label, targetView = null) {
  const validRevisions = new Set([view.revision]);
  const approvalRecords = recordsOfFacet(view, APPROVAL_WORD);
  if (approvalRecords.length === 0) {
    view.unsealedRevision = view.revision;
    view.validRevisions = [...validRevisions];
    return;
  }

  const allApprovalPaths = [...new Set(approvalRecords.map(r => r.sourcePath))];
  const unsealed = captureRevisionWithoutApprovalPaths(cli, directory, scratchRoot, `${label}-unsealed`, allApprovalPaths, view);
  if (unsealed !== null) {
    view.unsealedRevision = unsealed;
    validRevisions.add(unsealed);
  }

  if (targetView !== null) {
    const newOrEditedPaths = [
      ...new Set(
        approvalRecords
          .filter(r => {
            const prior = targetView.records.get(r.identity);
            return prior === undefined || prior.digest !== r.digest || prior.sourcePath !== r.sourcePath;
          })
          .map(r => r.sourcePath),
      ),
    ];
    if (newOrEditedPaths.length > 0 && newOrEditedPaths.length < allApprovalPaths.length) {
      const prePr = captureRevisionWithoutApprovalPaths(cli, directory, scratchRoot, `${label}-prepr`, newOrEditedPaths, view);
      if (prePr !== null) validRevisions.add(prePr);
    }
  }

  // Support sequential multi-signer seals where Signer K ran ia capture with Signers 1..K-1's @approval files already present
  const parsed = approvalRecords
    .map(r => ({ record: r, parsed: parseApproval(r) }))
    .filter(x => x.parsed.ok)
    .sort((a, b) => {
      const ta = a.parsed.approval.statement.signedAt;
      const tb = b.parsed.approval.statement.signedAt;
      return ta < tb ? -1 : ta > tb ? 1 : a.record.sourcePath < b.record.sourcePath ? -1 : 1;
    });

  const unresolvedTargetRevisions = new Set(
    parsed.map(x => x.parsed.approval.statement.revision).filter(rev => !validRevisions.has(rev)),
  );
  if (unresolvedTargetRevisions.size > 0 && parsed.length > 1) {
    for (let i = 1; i < parsed.length; i++) {
      const stripFromHere = [...new Set(parsed.slice(i).map(x => x.record.sourcePath))];
      const stepRev = captureRevisionWithoutApprovalPaths(cli, directory, scratchRoot, `${label}-step-${i}`, stripFromHere, view);
      if (stepRev !== null) validRevisions.add(stepRev);
    }
  }

  view.validRevisions = [...validRevisions];
}

export function safeRef(ref) {
  if (typeof ref !== 'string' || ref.startsWith('-') || !SAFE_REF.test(ref)) {
    throw new Error(`not a safe git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

export class Git {
  constructor(repository) {
    this.repository = repository;
  }

  run(args, input) {
    return execFileSync('git', ['-C', this.repository, '-c', 'core.quotepath=off', ...args], {
      input,
      maxBuffer: MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  text(args) {
    return this.run(args).toString('utf8').trim();
  }

  commitOf(ref) {
    return this.text(['rev-parse', '--verify', '--end-of-options', `${safeRef(ref)}^{commit}`]);
  }

  isAncestor(commit, ref) {
    try {
      this.run(['merge-base', '--is-ancestor', '--end-of-options', safeRef(commit), safeRef(ref)]);
      return true;
    } catch {
      return false;
    }
  }

  firstParentLine(ref) {
    return this.text(['rev-list', '--first-parent', '--reverse', '--end-of-options', safeRef(ref)])
      .split('\n')
      .filter(Boolean);
  }

  commitTime(commit) {
    return new Date(this.text(['show', '-s', '--format=%cI', '--end-of-options', safeRef(commit)]));
  }

  blobAt(ref, path) {
    try {
      return this.text(['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRef(ref)}:${path}`]) || null;
    } catch {
      return null;
    }
  }

  readFileAt(ref, path) {
    try {
      return this.run(['cat-file', 'blob', `${safeRef(ref)}:${path}`]).toString('utf8');
    } catch {
      return null;
    }
  }

  tree(ref, prefix = '') {
    const listing = this.run([
      'ls-tree',
      '-r',
      '-z',
      '--end-of-options',
      safeRef(ref),
      ...(prefix === '' ? [] : ['--', prefix]),
    ]).toString('utf8');
    return listing
      .split('\0')
      .filter(Boolean)
      .flatMap(row => {
        const [meta, path] = row.split('\t');
        const [, type, blob] = (meta ?? '').split(' ');
        return type === 'blob' && blob !== undefined && path !== undefined ? [{ path, blob }] : [];
      });
  }

  exportTree(ref, directory) {
    const entries = this.tree(ref);
    if (!entries.length) return;
    const stream = this.run(['cat-file', '--batch'], `${entries.map(entry => entry.blob).join('\n')}\n`);
    let offset = 0;
    for (const entry of entries) {
      const newline = stream.indexOf(0x0a, offset);
      const size = Number(stream.subarray(offset, newline).toString('utf8').split(' ')[2]);
      const target = join(directory, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, stream.subarray(newline + 1, newline + 1 + size));
      offset = newline + 1 + size + 1;
    }
  }

  firstEntries(ref, pathspecs) {
    const positions = new Map(this.firstParentLine(ref).map((commit, index) => [commit, index]));
    const log = this.text([
      'log',
      '--first-parent',
      '--root',
      '--raw',
      '--no-abbrev',
      '--format=%x01%H',
      '--end-of-options',
      safeRef(ref),
      '--',
      ...pathspecs,
    ]);
    const entries = new Map();
    for (const block of log.split('\x01').filter(Boolean)) {
      const [commit, ...rows] = block.split('\n');
      const position = positions.get((commit ?? '').trim());
      if (position === undefined) continue;
      for (const row of rows) {
        const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([AMCR]\d*)\t/.exec(row);
        if (!match) continue;
        const [, oldBlob, newBlob, status] = match;
        if (status.startsWith('R') && oldBlob === newBlob) continue;
        if (oldBlob !== newBlob && !entries.has(newBlob)) {
          entries.set(newBlob, position);
        }
      }
    }
    return entries;
  }

  latestEntryForPath(ref, targetPath) {
    const positions = new Map(this.firstParentLine(ref).map((commit, index) => [commit, index]));
    const log = this.text([
      'log',
      '--first-parent',
      '--root',
      '--raw',
      '--no-abbrev',
      '-M',
      '--format=%x01%H',
      '--end-of-options',
      safeRef(ref),
    ]);
    let trackedPath = targetPath;
    for (const block of log.split('\x01').filter(Boolean)) {
      const [commit, ...rows] = block.split('\n');
      const position = positions.get((commit ?? '').trim());
      if (position === undefined) continue;
      for (const row of rows) {
        const match = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)\t([^\t]+)(?:\t([^\t]+))?$/.exec(row);
        if (!match) continue;
        const [, oldBlob, newBlob, status, firstPath, secondPath] = match;
        const newPath = secondPath ?? firstPath;
        if (newPath !== trackedPath) continue;
        if (status.startsWith('R') && oldBlob === newBlob) {
          trackedPath = firstPath;
          break;
        }
        return position;
      }
    }
    return null;
  }
}

export function gitFacts(git, options) {
  const line = git.firstParentLine(options.targetRef);
  const positions = new Map(line.map((commit, index) => [commit, index]));
  let entries = null;
  const pathEntryCache = new Map();
  return {
    headBlobOf: path => git.blobAt(options.headRef, path),
    targetBlobOf: path => git.blobAt(options.targetRef, path),
    targetPositionOf: commit => (COMMIT_RE.test(commit) ? (positions.get(commit) ?? null) : null),
    isAncestorOfTarget: commit => COMMIT_RE.test(commit) && git.isAncestor(commit, options.targetRef),
    targetEntryOfBlob: blob => {
      entries ??= git.firstEntries(options.targetRef, options.pathspecs);
      return entries.get(blob) ?? null;
    },
    targetLatestEntryOf: (path, _blob) => {
      if (!pathEntryCache.has(path)) {
        pathEntryCache.set(path, git.latestEntryForPath(options.targetRef, path));
      }
      return pathEntryCache.get(path) ?? null;
    },
    targetCommitTime: position => {
      const commit = line[position];
      return commit === undefined ? null : git.commitTime(commit);
    },
  };
}

export function lineEndingsPinned(git, ref) {
  return LF_PIN_RE.test(git.readFileAt(ref, '.gitattributes') ?? '');
}

function buildOfflineCatalog(root) {
  const entries = [];
  const seenNames = new Set();
  for (const relDir of ['.ia/distributions/cache', 'vendor/ia']) {
    const absDir = join(root, relDir);
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir).sort()) {
      if (!name.endsWith('.ia.tgz') || seenNames.has(name)) continue;
      seenNames.add(name);
      entries.push({ path: `${relDir}/${name}`, withdrawn: false });
    }
  }
  if (entries.length === 0) return null;
  const catalogRel = '.ia/work/offline-catalog.json';
  const catalogAbs = join(root, '.ia', 'work', 'offline-catalog.json');
  mkdirSync(dirname(catalogAbs), { recursive: true });
  writeFileSync(catalogAbs, `${JSON.stringify(entries, null, 2)}\n`);
  return catalogRel;
}

function seedOfflineDistributionCache(targetRoot, donorRoots) {
  const cacheDir = join(targetRoot, '.ia', 'distributions', 'cache');
  const sources = [];
  for (const donor of donorRoots) {
    for (const sub of [join(donor, '.ia', 'distributions', 'cache'), join(donor, 'vendor', 'ia')]) {
      if (existsSync(sub)) sources.push(sub);
    }
  }
  if (sources.length === 0) return;
  mkdirSync(cacheDir, { recursive: true });
  for (const srcDir of sources) {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ia.tgz')) continue;
      const dst = join(cacheDir, name);
      if (!existsSync(dst)) cpSync(join(srcDir, name), dst);
    }
  }
}

export function corpusAt(git, cli, ref, scratch, targetView = null) {
  const label = ref.replace(/[^A-Za-z0-9._-]/g, '_');
  const directory = join(scratch, label);
  git.exportTree(ref, directory);
  const targetLockPath = join(directory, '.ia', 'distributions.lock.json');
  const repoLockPath = join(git.repository, '.ia', 'distributions.lock.json');
  const repoDistDir = join(git.repository, '.ia', 'distributions');
  if (
    existsSync(targetLockPath) &&
    existsSync(repoLockPath) &&
    existsSync(join(repoDistDir, 'active.json')) &&
    readFileSync(targetLockPath, 'utf8') === readFileSync(repoLockPath, 'utf8')
  ) {
    cpSync(repoDistDir, join(directory, '.ia', 'distributions'), { recursive: true });
  } else {
    seedOfflineDistributionCache(directory, [directory, git.repository, ...(cli.env?.IA_HOME ? [cli.env.IA_HOME] : [])]);
    if (!existsSync(join(directory, 'vendor', 'ia', 'catalog.json')) && existsSync(join(git.repository, 'vendor', 'ia', 'catalog.json'))) {
      cpSync(join(git.repository, 'vendor', 'ia'), join(directory, 'vendor', 'ia'), { recursive: true });
    }
  }
  cli.restore(directory);
  cli.validateAdmitted(directory);
  const view = cli.capture(directory);
  populateValidRevisions(cli, directory, view, scratch, label, targetView);
  return view;
}

export function checkPullRequest(pullRequest, options = {}) {
  if (!options.cli) throw new Error('checkPullRequest requires an explicit IaCli instance');
  const cli = options.cli;
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('options.now must be a valid Date');
  }
  const git = new Git(pullRequest.repository);
  const targetCommit = git.commitOf(pullRequest.targetRef);
  const headCommit = git.commitOf(pullRequest.headRef);
  const scratch = mkdtempSync(join(tmpdir(), 'ia-seal-pr-'));
  try {
    const target = corpusAt(git, cli, targetCommit, scratch, null);
    const head = corpusAt(git, cli, headCommit, scratch, target);
    const cliVer = cli.version();
    const pathspecs = [...new Set([...authoredRootPaths(target), ...authoredRootPaths(head), APPROVALS_DIR])];
    return checkSeal({
      target,
      head,
      language: floorLanguageVersion(head) ?? cliVer,
      cliVersion: cliVer,
      lineEndingsPinned: lineEndingsPinned(git, targetCommit),
      now,
      facts: gitFacts(git, {
        targetRef: targetCommit,
        headRef: headCommit,
        pathspecs,
      }),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyWorkspaceSourcesForAudit(root, copy) {
  mkdirSync(copy, { recursive: true });
  const skipTop = new Set(['.git', 'node_modules', 'vendor', '.scratch']);
  const walkCopy = (srcDir, dstDir) => {
    for (const name of readdirSync(srcDir)) {
      if (srcDir === root && skipTop.has(name)) continue;
      const srcPath = join(srcDir, name);
      const dstPath = join(dstDir, name);
      if (name === '.ia') {
        cpSync(srcPath, dstPath, {
          recursive: true,
          filter: s => !/[\\/]\.ia[\\/]work(?:[\\/]|$)/.test(s),
        });
      } else if (name === '.gitattributes') {
        cpSync(srcPath, dstPath);
      } else if (statSync(srcPath).isDirectory()) {
        if (existsSync(join(srcPath, '.ia')) || readdirSync(srcPath).some(child => statSync(join(srcPath, child)).isDirectory())) {
          walkCopy(srcPath, dstPath);
        }
      }
    }
  };
  walkCopy(root, copy);
  seedOfflineDistributionCache(copy, [root]);
  if (existsSync(join(root, 'vendor', 'ia', 'catalog.json'))) {
    cpSync(join(root, 'vendor', 'ia'), join(copy, 'vendor', 'ia'), { recursive: true });
  }
}

export function runWorkspaceAudit(command, root = process.cwd()) {
  if (!command.length) {
    throw new Error('usage: node check-seal.mjs <ia command...> | --repo <clone> --target <ref> --head <ref> --cli <ia main.js>');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  const cli = new IaCli(command);
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-seal-ws-')));
  const copy = join(scratch, 'workspace');
  try {
    copyWorkspaceSourcesForAudit(root, copy);
    cli.restore(copy);
    cli.validateAdmitted(copy);
    const view = cli.capture(copy);
    populateValidRevisions(cli, copy, view, scratch, 'ws', null);
    const cliVer = cli.version();
    const lfPinned = existsSync(join(copy, '.gitattributes'))
      ? LF_PIN_RE.test(readFileSync(join(copy, '.gitattributes'), 'utf8'))
      : true;
    return checkWorkspace(view, {
      lineEndingsPinned: lfPinned,
      language: floorLanguageVersion(view) ?? cliVer,
      cliVersion: cliVer,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parsePrFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (['--repo', '--target', '--head', '--cli', '--now'].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      opts[arg.slice(2)] = argv[++i];
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

function main(argv) {
  if (!argv.length) {
    throw new Error('usage: node check-seal.mjs <ia command...> | --repo <clone> --target <ref> --head <ref> --cli <ia main.js> [--json]');
  }
  if (argv.includes('--repo') || argv.includes('--target') || argv.includes('--head')) {
    const opts = parsePrFlags(argv);
    if (!opts.repo || !opts.target || !opts.head) {
      throw new Error('pull-request mode requires --repo <clone> --target <ref> --head <ref>');
    }
    const cliEntry = opts.cli || process.env.IA_CLI_PATH;
    if (!cliEntry || !existsSync(resolve(cliEntry))) {
      throw new Error('pull-request mode requires --cli <@inventarch/cli dist/main.js> or IA_CLI_PATH');
    }
    const now = opts.now !== undefined ? parseNowTimestamp(opts.now) : undefined;
    const report = checkPullRequest(
      { repository: resolve(opts.repo), targetRef: opts.target, headRef: opts.head },
      { cli: new IaCli([process.execPath, resolve(cliEntry)]), ...(now ? { now } : {}) },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return passes(report) ? 0 : 1;
  }
  const command = argv[0] === '--ia' ? argv.slice(1) : argv;
  const report = runWorkspaceAudit(command, process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return passes(report) ? 0 : 1;
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-seal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
