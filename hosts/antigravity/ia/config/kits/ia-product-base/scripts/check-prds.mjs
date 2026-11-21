#!/usr/bin/env node
// inventarch/ia-product-base-kit offline PRD completeness & traceability checker (declared check: check-prds).
// Pure Node built-in ESM, zero external npm dependencies, and zero network access.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node check-prds.mjs [--ia] <the command words that run ia...>
// Prints { format, revision, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.product.prd-check.v1';
const MAX_BUFFER = 256 * 1024 * 1024;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const CLAUSE_PREFIX_RE = /^([A-Za-z][A-Za-z0-9_-]*-\d+)\s*:/;
const ENFORCED_STATUSES = new Set(['ratified', 'active']);

// Seal verification constants (Ed25519 + RFC 8785 JCS)
const STATEMENT_PURPOSE = 'inventarch-approval';
const STATEMENT_VERSION = 1;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const GROUP_ORDER_LE = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
const ED25519_P = (1n << 255n) - 19n;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const APPROVAL_FILE_RE = /^([a-z0-9-]+)\.([0-9a-f]{12})\.([0-9a-f]{8})\.ia$/;
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const LF_PIN_RE = /^(?:\*|\*\.ia)[ \t]+(?:\S+[ \t]+)*text(?:=auto)?[ \t]+(?:\S+[ \t]+)*eol=lf[ \t]*$/m;
const KEY_KIND_STRENGTH = { 'service-held': 0, 'person-held': 1 };

export function isValidPrdSource(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /\s/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.username === '' && parsed.password === '' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || /[:@\0]/.test(value)) return false;
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function sectionField(record, path) {
  const [section, key] = path.split('.');
  const fromSec = record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
  if (fromSec !== undefined) return fromSec;
  if (record.fields && Object.hasOwn(record.fields, path)) {
    const raw = record.fields[path];
    return Array.isArray(raw) ? { kind: 'list', items: raw.map(t => ({ kind: 'string', text: String(t) })) } : { kind: 'string', text: String(raw) };
  }
  return undefined;
}

function scalarText(value) {
  if (!value) return null;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'number' || typeof value.value === 'string') return String(value.value);
  return null;
}

function numberValue(value) {
  if (!value) return null;
  if (typeof value.value === 'number') return Number.isFinite(value.value) ? value.value : null;
  if (typeof value.text === 'string' && value.text.trim() !== '') {
    const parsed = Number(value.text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function listItems(value) {
  return value?.kind === 'list' && Array.isArray(value.items) ? value.items : [];
}

function recordFileOf(record) {
  return record?.origin?.file ?? record?.source?.path ?? record?.sourcePath ?? null;
}

function refKey(value) {
  if (!value) return null;
  if (value.kind === 'identity' && typeof value.identity === 'string') return value.identity;
  if (value.kind === 'ref' && value.discriminator && value.name) {
    return `@${value.discriminator} ${String(value.name).toLowerCase()}`;
  }
  return null;
}

function buildLookup(records) {
  const byIdentity = new Map();
  const byRef = new Map();
  const byShortName = new Map();
  for (const r of records) {
    byIdentity.set(r.identity, r);
    const nameLower = String(r.name ?? '').toLowerCase();
    const key = `@${r.discriminator} ${nameLower}`;
    if (!byRef.has(key) || r.provenance === 'workspace') byRef.set(key, r.identity);
    const shortKey = `${r.discriminator}:${nameLower}`;
    if (!byShortName.has(shortKey) || r.provenance === 'workspace') byShortName.set(shortKey, r.identity);
  }
  const resolveRef = (ref, expectedDiscriminators = null) => {
    if (!ref) return null;
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      if (byIdentity.has(trimmed)) return trimmed;
      const lower = trimmed.toLowerCase();
      if (byRef.has(lower)) return byRef.get(lower);
      if (expectedDiscriminators) {
        for (const d of expectedDiscriminators) {
          const hit = byShortName.get(`${d}:${lower}`);
          if (hit) return hit;
        }
      }
      return null;
    }
    if (ref.target && byIdentity.has(ref.target)) return ref.target;
    const key = refKey(ref.reference ?? ref);
    if (!key) return null;
    return byIdentity.has(key) ? key : (byRef.get(key) ?? null);
  };
  return { byIdentity, resolveRef };
}

function detectCycles(graph) {
  const active = new Set();
  const visited = new Set();
  const cyclic = new Set();

  function dfs(node, stack) {
    if (active.has(node)) {
      const idx = stack.indexOf(node);
      for (const member of stack.slice(idx >= 0 ? idx : 0)) cyclic.add(member);
      cyclic.add(node);
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) dfs(next, stack);
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort()) dfs(node, []);
  return [...cyclic].sort();
}

// ---------------------------------------------------------------------------
// Offline Ed25519 + RFC 8785 JCS seal & roster verifier
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

function decodeBase64url(text) {
  if (typeof text !== 'string' || !BASE64URL_ALPHABET.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return Buffer.from(bytes).toString('base64url') === text ? new Uint8Array(bytes) : null;
}

function decodeEd25519Point(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
  const x0 = ((bytes[31] ?? 0) >>> 7) & 1;
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    const byte = i === 31 ? (bytes[i] ?? 0) & 0x7f : (bytes[i] ?? 0);
    y |= BigInt(byte) << BigInt(8 * i);
  }
  if (y >= ED25519_P) return null;
  const y2 = modP(y * y);
  const x2 = modP(modP(y2 - 1n) * modPowP(modP(ED25519_D * y2 + 1n), ED25519_P - 2n));
  if (x2 === 0n) return x0 === 1 ? null : { X: 0n, Y: y, Z: 1n };
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
  return { X: modP(E * F), Y: modP(G * H), Z: modP(F * G) };
}

function isSmallOrderPoint(pt) {
  const p8 = doubleEd25519Point(doubleEd25519Point(doubleEd25519Point(pt)));
  return p8.Z === 0n || (p8.X === 0n && p8.Y === p8.Z);
}

function decodeValidPublicKey(text) {
  const raw = decodeBase64url(text);
  if (raw === null || raw.length !== 32) return null;
  const pt = decodeEd25519Point(raw);
  return pt !== null && !isSmallOrderPoint(pt) ? raw : null;
}

function keyIdOf(rawPublicKey) {
  return Buffer.from(createHash('sha256').update(rawPublicKey).digest()).toString('base64url');
}

function nameSafeKeyTag(keyId) {
  return createHash('sha256').update(keyId).digest('hex').slice(0, 8);
}

function scalarIsCanonical(signature) {
  for (let i = 31; i >= 0; i--) {
    const s = signature[32 + i] ?? 0;
    const l = GROUP_ORDER_LE[i] ?? 0;
    if (s !== l) return s < l;
  }
  return false;
}

function canonicalizeJcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new Error('lone surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(',')}]`;
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .sort()
      .map(k => `${canonicalizeJcs(k)}:${canonicalizeJcs(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error('unsupported JSON value');
}

function verifyStatementSignature(statement, signatureText, rawPublicKey) {
  const sig = decodeBase64url(signatureText);
  if (sig === null || sig.length !== 64 || !scalarIsCanonical(sig)) return false;
  const rPt = decodeEd25519Point(sig.subarray(0, 32));
  if (rPt === null || isSmallOrderPoint(rPt)) return false;
  try {
    const pubKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPublicKey)]),
      format: 'der',
      type: 'spki',
    });
    const payload = new TextEncoder().encode(canonicalizeJcs(statement));
    return verify(null, payload, pubKey, sig);
  } catch {
    return false;
  }
}

function isValidRfc3339Utc(text) {
  const m = typeof text === 'string' ? RFC3339_UTC_RE.exec(text) : null;
  if (!m) return false;
  const [, y, mo, d, hh, mm, ss] = m;
  const dt = new Date(text);
  return (
    !Number.isNaN(dt.getTime()) &&
    dt.getUTCFullYear() === Number(y) &&
    dt.getUTCMonth() + 1 === Number(mo) &&
    dt.getUTCDate() === Number(d) &&
    dt.getUTCHours() === Number(hh) &&
    dt.getUTCMinutes() === Number(mm) &&
    dt.getUTCSeconds() === Number(ss)
  );
}

function isSortedStrings(items) {
  return items.every((item, idx) => idx === 0 || (items[idx - 1] ?? '') < item);
}

function buildPrdSealEvaluator(snapshot, allRecords, byIdentity, resolveRef) {
  const workspaces = allRecords.filter(
    r =>
      r.discriminator === 'workspace' &&
      (r.provenance ?? 'workspace') === 'workspace' &&
      !(recordFileOf(r) ?? '').startsWith('.ia/distributions/') &&
      !(recordFileOf(r) ?? '').startsWith('.ia/floor/'),
  );
  const authoredRoots = workspaces.flatMap(ws => {
    const srcPath = recordFileOf(ws) ?? '.ia/src/workspace.ia';
    const nestedIdx = srcPath.startsWith('.ia/src/') ? -1 : srcPath.indexOf('/.ia/src/');
    const wsBase = nestedIdx > 0 ? srcPath.slice(0, nestedIdx) : '.';
    const rawSources = listItems(sectionField(ws, 'composition.sources')).map(scalarText).filter(Boolean);
    return rawSources.flatMap(entry => {
      const [rawRoot, placement] = entry.split(' @');
      if (placement !== 'authored' || !rawRoot) return [];
      const trimmed = rawRoot.trim().replace(/\/+$/, '') || '.';
      if (trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.split('/').some(seg => seg === '..')) return [];
      const resolved =
        wsBase === '.'
          ? trimmed
          : trimmed === '.'
            ? wsBase
            : trimmed === '.ia/src' || trimmed.startsWith('.ia/src/')
              ? `${wsBase}/${trimmed}`
              : trimmed;
      if (wsBase !== '.' && resolved !== wsBase && !resolved.startsWith(`${wsBase}/`)) return [];
      return [{ workspace: ws.identity, root: resolved, base: wsBase }];
    });
  });

  const workspaceOfPath = path => {
    if (!path || authoredRoots.length === 0) return null;
    const hits = authoredRoots
      .filter(({ root }) => root === '.' || path === root || path.startsWith(`${root}/`))
      .sort((a, b) => b.root.length - a.root.length);
    return hits[0]?.workspace ?? null;
  };

  const workspaceParentsOf = wsId => {
    const ws = byIdentity.get(wsId);
    if (!ws || ws.discriminator !== 'workspace') return [];
    const parents = new Set();
    const add = id => {
      if (id && id !== wsId) parents.add(id);
    };
    const govByField = scalarText(sectionField(ws, 'composition.governed-by'));
    if (govByField) add(resolveRef(govByField, ['workspace']));
    for (const edge of ws.edges ?? []) {
      if (edge.predicate === 'governed-by' && (!edge.direction || edge.direction === 'out')) {
        add(resolveRef(edge, ['workspace']));
      } else if (edge.predicate === 'govern' && edge.direction === 'in') {
        add(resolveRef(edge, ['workspace']));
      }
    }
    for (const other of workspaces) {
      if (other.identity === wsId) continue;
      for (const edge of other.edges ?? []) {
        if (edge.predicate === 'govern' && (!edge.direction || edge.direction === 'out') && resolveRef(edge, ['workspace']) === wsId) {
          add(other.identity);
        }
      }
    }
    const ownRoots = authoredRoots.filter(r => r.workspace === wsId);
    for (const own of ownRoots) {
      for (const other of authoredRoots) {
        if (other.workspace === wsId) continue;
        if (
          (other.root === '.' && own.root !== '.') ||
          (other.root !== own.root && own.root.startsWith(`${other.root}/`)) ||
          (other.base === '.' && own.base !== '.' && (other.root === '.' || other.root === '.ia/src'))
        ) {
          add(other.workspace);
        }
      }
    }
    return [...parents];
  };

  const workspaceCovers = (ancestor, target) => {
    if (!ancestor || !target) return false;
    if (ancestor === target) return true;
    const visited = new Set([target]);
    const queue = [target];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const p of workspaceParentsOf(cur)) {
        if (p === ancestor) return true;
        if (!visited.has(p)) {
          visited.add(p);
          queue.push(p);
        }
      }
    }
    return false;
  };

  const candidates = [...new Set(authoredRoots.map(r => r.workspace))];
  const outermost = candidates.filter(
    c => !candidates.some(o => o !== c && workspaceCovers(o, c) && !workspaceCovers(c, o)),
  );
  const organisation = candidates.length === 0 ? null : outermost.length === 1 ? outermost[0] : '__ambiguous__';

  // Parse @approver roster
  const roster = [];
  for (const rec of allRecords.filter(r => r.discriminator === 'approver')) {
    const account = scalarText(sectionField(rec, 'person.account'));
    const display = scalarText(sectionField(rec, 'person.display'));
    const wsField = sectionField(rec, 'authority.workspaces');
    const entriesField = sectionField(rec, 'keys.entries');
    if (!account || !display || !wsField || !entriesField) continue;
    const wsList = listItems(wsField).map(scalarText).filter(Boolean);
    const keyTexts = listItems(entriesField).map(scalarText);
    if (keyTexts.some(t => !t)) continue;
    let badKey = false;
    const keys = [];
    for (const kt of keyTexts) {
      const parts = kt.split(' ');
      if (parts.length !== 5) {
        badKey = true;
        break;
      }
      const [kid, alg, pubText, status, from] = parts;
      if (!['active', 'retired', 'revoked'].includes(status) || alg !== 'ed25519') {
        badKey = true;
        break;
      }
      if (status === 'active' ? from !== '-' : !COMMIT_RE.test(from)) {
        badKey = true;
        break;
      }
      const pub = decodeValidPublicKey(pubText);
      if (!pub || keyIdOf(pub) !== kid) {
        badKey = true;
        break;
      }
      keys.push({ keyId: kid, publicKey: pub, status });
    }
    if (badKey || new Set(keys.map(k => k.keyId)).size !== keys.length) continue;
    const slack = scalarText(sectionField(rec, 'person.slack'));
    const slackPending = scalarText(sectionField(rec, 'person.slack-pending'));
    roster.push({ identity: rec.identity, account, workspaces: wsList, keys, slack, slackPending });
  }

  const accounts = roster.map(a => a.account);
  const dupAccounts = new Set(accounts.filter((a, i) => accounts.indexOf(a) !== i));
  const slackIds = roster.flatMap(a => {
    const pendingParts = a.slackPending ? a.slackPending.split(' ') : [];
    const pendingId = pendingParts.length >= 2 && pendingParts[0] !== 'remove' ? pendingParts.slice(1).join(' ') : null;
    return [a.slack, pendingId].filter(Boolean);
  });
  const dupSlacks = new Set(slackIds.filter((s, i) => slackIds.indexOf(s) !== i));

  const keyLookup = new Map();
  for (const approver of roster) {
    for (const key of approver.keys) {
      keyLookup.set(key.keyId, keyLookup.has(key.keyId) ? null : { approver, key });
    }
  }

  // Parse @docket unrecognised pieces
  const unrecognised = new Set();
  for (const doc of allRecords.filter(r => r.discriminator === 'docket')) {
    const producer = scalarText(sectionField(doc, 'docket.producer')) ?? '';
    for (const line of listItems(sectionField(doc, 'docket.pieces')).map(scalarText).filter(Boolean)) {
      const parts = line.split(' ');
      if (parts.length !== 6) continue;
      const [pieceId, recognition, , , , pattern] = parts;
      if (
        producer.split(' ')[0] === 'desk' ||
        recognition !== 'matched' ||
        pattern === '-' ||
        !byIdentity.has(pattern)
      ) {
        unrecognised.add(pieceId);
      }
    }
  }

  // Parse @approval-rule records
  const ownRules = allRecords.filter(r => r.discriminator === 'approval-rule' && (r.provenance ?? 'workspace') === 'workspace');
  let hasMalformedRule = false;
  const parsedRules = [];
  for (const r of ownRules) {
    const quorum = numberValue(sectionField(r, 'demand.quorum')) ?? 0;
    const words = listItems(sectionField(r, 'demand.words')).map(scalarText).filter(Boolean);
    const kinds = listItems(sectionField(r, 'demand.kinds')).map(scalarText).filter(Boolean);
    const paths = listItems(sectionField(r, 'demand.paths')).map(scalarText).filter(Boolean);
    const coversUnrecognised = scalarText(sectionField(r, 'demand.pieces')) === 'unrecognised';
    if (!Number.isInteger(quorum) || quorum < 1 || (words.length === 0 && kinds.length === 0 && paths.length === 0 && !coversUnrecognised)) {
      hasMalformedRule = true;
      continue;
    }
    const fromField = sectionField(r, 'demand.from');
    parsedRules.push({
      identity: r.identity,
      digest: r.digest ?? null,
      workspace: workspaceOfPath(recordFileOf(r)),
      quorum,
      words,
      kinds,
      paths,
      coversUnrecognised,
      from: fromField ? listItems(fromField).map(scalarText).filter(Boolean) : null,
      via: sectionField(r, 'demand.via') ? listItems(sectionField(r, 'demand.via')).map(scalarText).filter(Boolean) : ['desk', 'slack'],
      keyKind: scalarText(sectionField(r, 'demand.key-kind')) ?? 'service-held',
      staleness: scalarText(sectionField(r, 'demand.staleness')) ?? 'unchanged-inputs',
    });
  }

  // Parse & cryptographically verify @approval records
  const verifiedSealsByTarget = new Map();
  const misnamedApprovals = [];
  for (const app of allRecords.filter(r => r.discriminator === 'approval')) {
    const text = k => scalarText(sectionField(app, `seal.${k}`));
    const listFieldVal = k => sectionField(app, `seal.${k}`);
    const action = text('action');
    const org = text('organisation');
    const ws = text('workspace');
    const recId = text('record');
    const recDigest = text('record-digest');
    const revision = text('revision');
    const language = text('language-version');
    const baseCommit = text('base-commit');
    const signer = text('signer');
    const keyId = text('key-id');
    const keyKind = text('key-kind');
    const via = text('via');
    const request = text('request');
    const signedAt = text('signed-at');
    const algorithm = text('algorithm');
    const signature = text('signature');
    const depField = listFieldVal('depends-on');
    const rulesField = listFieldVal('rules');
    const sysField = listFieldVal('system-versions');

    if (
      action !== 'approve' ||
      !org ||
      !ws ||
      !recId ||
      !recDigest ||
      !HEX_64_RE.test(recDigest) ||
      !revision ||
      !HEX_64_RE.test(revision) ||
      !language ||
      !baseCommit ||
      !COMMIT_RE.test(baseCommit) ||
      !signer ||
      !keyId ||
      !['service-held', 'person-held'].includes(keyKind) ||
      !['desk', 'slack'].includes(via) ||
      !request ||
      !isValidRfc3339Utc(signedAt) ||
      algorithm !== 'ed25519' ||
      !signature ||
      !depField ||
      !rulesField ||
      !sysField
    ) {
      continue;
    }

    const appFile = recordFileOf(app);
    if (appFile) {
      const fileName = appFile.split('/').pop() ?? '';
      const m = APPROVAL_FILE_RE.exec(fileName);
      const expectedName = recId.split('/').pop() ?? '';
      if (!m || m[1] !== expectedName || m[2] !== recDigest.slice(0, 12) || m[3] !== nameSafeKeyTag(keyId)) {
        misnamedApprovals.push({ record: app, expected: `${expectedName}.${recDigest.slice(0, 12)}.${nameSafeKeyTag(keyId)}.ia` });
        continue;
      }
      if (authoredRoots.length > 0) {
        if (organisation === '__ambiguous__' || (organisation !== null && org !== organisation)) continue;
        if (workspaceOfPath(appFile) !== ws) continue;
      }
    }

    const parseRefPair = line => {
      const idx = line ? line.lastIndexOf(' ') : -1;
      if (idx <= 0) return null;
      const identity = line.slice(0, idx);
      const digest = line.slice(idx + 1);
      return HEX_64_RE.test(digest) ? { identity, digest } : null;
    };
    const dependsOn = listItems(depField).map(scalarText).map(parseRefPair);
    const rules = listItems(rulesField).map(scalarText).map(parseRefPair);
    const systems = listItems(sysField)
      .map(scalarText)
      .map(line => {
        const idx = line ? line.lastIndexOf(' ') : -1;
        return idx > 0 ? { system: line.slice(0, idx), version: line.slice(idx + 1) } : null;
      });
    if (
      dependsOn.some(d => !d) ||
      rules.some(r => !r) ||
      systems.some(s => !s) ||
      !isSortedStrings(dependsOn.map(d => d.identity)) ||
      !isSortedStrings(rules.map(r => r.identity)) ||
      !isSortedStrings(systems.map(s => s.system))
    ) {
      continue;
    }

    if (dependsOn.some(dep => byIdentity.get(dep.identity)?.digest !== dep.digest)) continue;

    const found = keyLookup.get(keyId) ?? null;
    if (
      !found ||
      found.key.status !== 'active' ||
      found.approver.account !== signer ||
      dupAccounts.has(found.approver.account) ||
      (via === 'slack' && found.approver.slack && dupSlacks.has(found.approver.slack))
    ) {
      continue;
    }

    const statement = {
      purpose: STATEMENT_PURPOSE,
      version: STATEMENT_VERSION,
      action,
      organisation: org,
      workspace: ws,
      record: recId,
      recordDigest: recDigest,
      dependsOn,
      rules,
      revision,
      language,
      systems,
      baseCommit,
      signer,
      keyId,
      keyKind,
      via,
      request,
      signedAt,
    };

    if (!verifyStatementSignature(statement, signature, found.key.publicKey)) continue;

    if (!verifiedSealsByTarget.has(recId)) verifiedSealsByTarget.set(recId, []);
    verifiedSealsByTarget.get(recId).push({ statement, approver: found.approver });
  }

  const validLanguages = new Set([snapshot?.language, snapshot?.cliVersion].filter(Boolean));
  const validRevisions = new Set([snapshot?.revision, ...(snapshot?.validRevisions ?? [])].filter(Boolean));
  const lfPinned = snapshot?.lineEndingsPinned ?? true;

  const approverCovers = (approver, wsId) => {
    if (!wsId) return false;
    if (authoredRoots.length === 0) return approver.workspaces.includes(wsId);
    return approver.workspaces.some(granted => workspaceCovers(granted, wsId));
  };

  const rulesCoveringPrd = prd => {
    const recFile = recordFileOf(prd) ?? '';
    const recWs = workspaceOfPath(recFile);
    const recKind = prd.kind ?? 'definition';
    return parsedRules.filter(rule => {
      if (authoredRoots.length > 0 && rule.workspace && recWs && !workspaceCovers(rule.workspace, recWs)) return false;
      return (
        rule.words.includes('prd') ||
        rule.kinds.includes(recKind) ||
        (recFile !== '' && rule.paths.some(prefix => recFile.startsWith(prefix))) ||
        (rule.coversUnrecognised && unrecognised.has(prd.identity))
      );
    });
  };

  const evaluate = prd => {
    const covering = rulesCoveringPrd(prd);
    if (!hasMalformedRule && covering.length === 0) return { required: false, satisfied: true };
    if (hasMalformedRule || typeof prd?.digest !== 'string' || !HEX_64_RE.test(prd.digest)) {
      return { required: true, satisfied: false };
    }
    const recFile = recordFileOf(prd);
    const recWs = workspaceOfPath(recFile);
    const seals = (verifiedSealsByTarget.get(prd.identity) ?? []).filter(entry => {
      const s = entry.statement;
      if (s.recordDigest !== prd.digest) return false;
      if (authoredRoots.length > 0 && recWs && s.workspace !== recWs) return false;
      return approverCovers(entry.approver, recWs ?? s.workspace);
    });
    if (seals.length === 0) return { required: true, satisfied: false };

    for (const rule of covering) {
      if (typeof rule.digest === 'string' && !HEX_64_RE.test(rule.digest)) return { required: true, satisfied: false };
      const accountsForRule = new Set();
      for (const { statement: s, approver } of seals) {
        const ruleRef = s.rules.find(r => r.identity === rule.identity);
        if (!ruleRef) continue;
        if (typeof rule.digest === 'string' && HEX_64_RE.test(rule.digest) && ruleRef.digest !== rule.digest) continue;
        const allowed =
          rule.via.includes(s.via) &&
          KEY_KIND_STRENGTH[s.keyKind] >= KEY_KIND_STRENGTH[rule.keyKind] &&
          (rule.from === null || rule.from.includes(approver.account));
        if (!allowed) continue;
        if (rule.staleness === 'current-revision') {
          if (!lfPinned) continue;
          if (validLanguages.size > 0 && !validLanguages.has(s.language)) continue;
          // As in check-seal, a current-revision seal needs a revision the workspace accepts; an empty set accepts none.
          if (!validRevisions.has(s.revision)) continue;
        }
        accountsForRule.add(approver.account);
      }
      if (accountsForRule.size < rule.quorum) return { required: true, satisfied: false };
    }
    return { required: true, satisfied: true };
  };
  return { evaluate, misnamedApprovals };
}

export function checkPrds(snapshot) {
  const allRecords = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const { byIdentity, resolveRef } = buildLookup(allRecords);
  const findings = [];

  const report = (code, record, message) => {
    findings.push({
      code,
      severity: 'error',
      discriminator: record.discriminator,
      identity: record.identity,
      name: record.name ?? null,
      file: recordFileOf(record),
      line: record.origin?.line ?? null,
      message,
    });
  };

  const own = allRecords.filter(r => (r.provenance ?? 'workspace') === 'workspace');
  const prds = own.filter(r => r.discriminator === 'prd');
  const specs = allRecords.filter(r => r.discriminator === 'spec');
  const decisions = allRecords.filter(r => r.discriminator === 'decision');

  // Collect incoming traces from @spec and @decision records pointing at @prd records
  const incomingTraceByPrd = new Map();
  for (const rec of [...specs, ...decisions]) {
    for (const edge of rec.edges ?? []) {
      if (edge.direction && edge.direction !== 'out') continue;
      if (!['cite', 'ground', 'require', 'record-lineage-from'].includes(edge.predicate)) continue;
      const targetId = resolveRef(edge);
      if (targetId && byIdentity.get(targetId)?.discriminator === 'prd') {
        if (!incomingTraceByPrd.has(targetId)) incomingTraceByPrd.set(targetId, new Set());
        incomingTraceByPrd.get(targetId).add(rec.identity);
      }
    }
  }

  const { evaluate: evaluatePrdSeal, misnamedApprovals } = buildPrdSealEvaluator(snapshot, allRecords, byIdentity, resolveRef);
  // As in check-seal (seal-malformed), an approval saved under a file name other than its record, digest and key counts
  // for nothing, and it is reported rather than skipped silently.
  for (const { record, expected } of misnamedApprovals) {
    report('APPROVAL_FILE_MISNAMED', record, `@approval ${record.name} counts for nothing: its file name must be ${expected}`);
  }

  const supersedeGraph = new Map();
  for (const p of allRecords.filter(r => r.discriminator === 'prd')) {
    const targets = [];
    for (const edge of p.edges ?? []) {
      if (edge.predicate !== 'supersede' || (edge.direction && edge.direction !== 'out')) continue;
      const resolved = resolveRef(edge);
      if (resolved && byIdentity.get(resolved)?.discriminator === 'prd') targets.push(resolved);
    }
    supersedeGraph.set(p.identity, [...new Set(targets)]);
  }

  for (const prd of prds) {
    const problem = scalarText(sectionField(prd, 'meaning.problem')) ?? '';
    const goalsRaw = listItems(sectionField(prd, 'scope.goals')).map(scalarText);
    const nonGoalsRaw = listItems(sectionField(prd, 'scope.non-goals')).map(scalarText);
    const reqsRaw = listItems(sectionField(prd, 'scope.requirements')).map(scalarText);
    const status = scalarText(sectionField(prd, 'governance.status')) ?? 'draft';
    const source = scalarText(sectionField(prd, 'governance.source'));
    const bodyDigest = scalarText(sectionField(prd, 'governance.body-digest'));

    if (!problem.trim()) {
      report('PRD_PROBLEM_EMPTY', prd, `@prd ${prd.name}: meaning.problem must be non-empty`);
    }

    for (const [fieldName, entries] of [
      ['scope.goals', goalsRaw],
      ['scope.non-goals', nonGoalsRaw],
      ['scope.requirements', reqsRaw],
    ]) {
      if (entries.some(entry => typeof entry !== 'string' || !entry.trim())) {
        report('PRD_BLANK_ENTRY', prd, `@prd ${prd.name}: ${fieldName} must not contain blank strings`);
      }
    }

    const goals = goalsRaw.filter(g => typeof g === 'string' && g.trim().length > 0);
    const reqs = reqsRaw.filter(r => typeof r === 'string' && r.trim().length > 0);

    const seenClauseIds = new Set();
    for (const req of reqs) {
      const m = CLAUSE_PREFIX_RE.exec(req.trim());
      if (m) {
        const clauseId = m[1].toUpperCase();
        if (seenClauseIds.has(clauseId)) {
          report('PRD_REQUIREMENT_DUPLICATE_ID', prd, `@prd ${prd.name}: duplicate requirement clause identifier '${clauseId}'`);
        }
        seenClauseIds.add(clauseId);
      }
    }

    if (source !== null && !isValidPrdSource(source)) {
      report(
        'PRD_SOURCE_INVALID',
        prd,
        `@prd ${prd.name}: governance.source ${JSON.stringify(source)} must be a credential-free, traversal-free path or URL`,
      );
    }

    if (bodyDigest !== null) {
      if (!HEX_64_RE.test(bodyDigest)) {
        report('PRD_BODY_DIGEST_FORMAT', prd, `@prd ${prd.name}: governance.body-digest must be 64 lowercase hex characters`);
      }
      if (source === null) {
        report('PRD_DIGEST_WITHOUT_SOURCE', prd, `@prd ${prd.name}: governance.body-digest requires governance.source to be set`);
      }
    }

    if (ENFORCED_STATUSES.has(status)) {
      if (goals.length === 0) {
        report('PRD_GOALS_EMPTY', prd, `@prd ${prd.name} (${status}): scope.goals must list at least one measurable goal`);
      }
      if (reqs.length === 0) {
        report('PRD_REQUIREMENTS_EMPTY', prd, `@prd ${prd.name} (${status}): scope.requirements must list at least one requirement clause`);
      }

      // Collect outgoing + incoming traced @spec and @decision records
      const tracedIds = new Set(incomingTraceByPrd.get(prd.identity) ?? []);
      for (const edge of prd.edges ?? []) {
        if (edge.direction && edge.direction !== 'out') continue;
        if (!['cite', 'ground', 'require'].includes(edge.predicate)) continue;
        const targetId = resolveRef(edge);
        const targetRec = targetId ? byIdentity.get(targetId) : null;
        if (targetRec && ['spec', 'decision'].includes(targetRec.discriminator)) {
          tracedIds.add(targetRec.identity);
        }
      }

      if (tracedIds.size === 0) {
        report(
          'PRD_UNTRACED_COVERAGE',
          prd,
          `@prd ${prd.name} (${status}) has no resolved traceability relationship to or from an admitted @spec or @decision`,
        );
      } else {
        const tracedRecords = [...tracedIds].map(id => byIdentity.get(id)).filter(Boolean);
        const activeTraces = tracedRecords.filter(r => scalarText(sectionField(r, 'work.status')) !== 'withdrawn');
        if (activeTraces.length === 0) {
          report(
            'PRD_TRACE_WITHDRAWN',
            prd,
            `@prd ${prd.name} (${status}) traces only to withdrawn @spec/@decision records`,
          );
        }
      }

      const sealStatus = evaluatePrdSeal(prd);
      if (sealStatus.required && !sealStatus.satisfied) {
        report('PRD_UNSEALED', prd, `@prd ${prd.name} (${status}) requires a valid cryptographic @approval seal under the workspace's approval rules`);
      }
    }
  }

  for (const cyclicId of detectCycles(supersedeGraph)) {
    const prd = byIdentity.get(cyclicId);
    if (prd && (prd.provenance ?? 'workspace') === 'workspace') {
      report('PRD_SUPERSEDE_CYCLE', prd, `@prd ${prd.name} participates in a supersede cycle`);
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      prds: prds.length,
      specs: specs.length,
      decisions: decisions.length,
      findings: findings.length,
    },
    findings,
  };
}

const handoffOff = () => ({ ...process.env, IA_NO_HANDOFF: '1' });

function refusal(ran, reply) {
  if (ran.error) return ran.error.message;
  if (typeof reply?.message === 'string') return reply.code && !reply.message.startsWith(reply.code) ? `${reply.code}: ${reply.message}` : reply.message;
  if (reply?.ok === true) return ran.status !== 0 ? `it answered ok but exited ${ran.status}` : 'its answer holds no records';
  return (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`;
}

function readAdmission(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (reply?.status === 'admitted') return;
  if (reply?.status === 'refused') {
    const errors = reply.counts?.errors;
    const first = (reply.findings ?? []).find(f => f.severity === 'error');
    const named = first ? `, the first ${first.code}: ${first.message}` : '';
    throw new Error(`ia validate refused the workspace with ${errors} error${errors === 1 ? '' : 's'}${named}; a refused workspace is not judged`);
  }
  throw new Error(`ia validate did not admit the workspace: ${refusal(ran, reply)}`);
}

function stripApprovalBlocks(fullPath) {
  if (!existsSync(fullPath)) return;
  const content = readFileSync(fullPath, 'utf8');
  const blocks = content.split(/^(?=@)/m);
  const header = blocks[0]?.startsWith('@') ? '' : (blocks.shift() ?? '');
  const kept = blocks.filter(b => !/^@approval\s/.test(b));
  if (kept.length === 0) rmSync(fullPath, { force: true });
  else writeFileSync(fullPath, `${header}${kept.join('')}`);
}

const APPROVAL_TEXT_FIELDS = [
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

// The revisions a current-revision seal may name, as check-seal accepts them: the full capture, the capture
// with every @approval stripped, and, when a seal names neither and there are 2+ approvals, each sequential
// signer's step (well-formed approvals, as check-seal's parseApproval admits them, ordered by signed-at then file; step i strips approvals i..n-1, so signer i+1's
// capture with approvals 0..i-1 present). Each probe runs on a fresh copy of the authored tree; a failed
// probe adds nothing and keeps the revisions already found.
function computeUnsealedRevisions(command, root, approvals) {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-prd-rev-')));
  const skipTop = new Set(['.git', 'node_modules', 'vendor', '.scratch']);
  const capture = (tag, stripFiles) => {
    try {
      const copy = join(scratch, tag);
      mkdirSync(copy, { recursive: true });
      const walkCopy = (srcDir, dstDir) => {
        for (const name of readdirSync(srcDir)) {
          if (srcDir === root && skipTop.has(name)) continue;
          const s = join(srcDir, name);
          const d = join(dstDir, name);
          if (name === '.ia') {
            cpSync(s, d, { recursive: true, filter: p => !/[\\/]\.ia[\\/]work(?:[\\/]|$)/.test(p) });
          } else if (statSync(s).isDirectory() && existsSync(join(s, '.ia'))) {
            walkCopy(s, d);
          }
        }
      };
      walkCopy(root, copy);
      for (const rel of stripFiles) stripApprovalBlocks(join(copy, rel));
      const ran = spawnSync(command[0], [...command.slice(1), 'capture', '--root', copy], {
        cwd: copy,
        env: handoffOff(),
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      if (ran.status !== 0) return null;
      const snap = JSON.parse(readFileSync(join(copy, '.ia', 'work', 'snapshot', 'current.json'), 'utf8'));
      if (!snap.authoredRevision) return null;
      const records = new Map();
      for (const entry of snap.records ?? []) {
        records.set(entry.identity, { digest: entry.digest, approval: entry.system === 'approval-system' && entry.facet === 'approval' });
      }
      return { revision: snap.authoredRevision, records };
    } catch {
      return null;
    }
  };
  // A probe counts only when stripping removed approvals and nothing else: every other record of the full capture
  // keeps its identity and digest, and the probe adds none. stripApprovalBlocks splits raw lines, so it could also cut
  // into another record's text, or bring back text hidden inside an approval's value; either way the records differ
  // from the full capture's, and the probe adds no revision. An approval here is approval-system's word; a local word
  // that declares the approval facet is compared like any other record.
  const keepsOtherRecords = (full, probe) => {
    for (const [identity, record] of full.records) {
      if (record.approval) continue;
      if (probe.records.get(identity)?.digest !== record.digest) return false;
    }
    for (const [identity, record] of probe.records) {
      if (!record.approval && !full.records.has(identity)) return false;
    }
    return true;
  };
  try {
    const revisions = new Set();
    const full = capture('full', []);
    if (full === null) return [];
    revisions.add(full.revision);
    const add = probe => {
      if (probe !== null && keepsOtherRecords(full, probe)) revisions.add(probe.revision);
    };
    add(capture('unsealed', [...new Set(approvals.map(a => a.file))]));
    const ordered = approvals
      .filter(a => a.wellFormed)
      .sort((a, b) => (a.signedAt < b.signedAt ? -1 : a.signedAt > b.signedAt ? 1 : a.file < b.file ? -1 : 1));
    if (ordered.length > 1 && ordered.some(a => !revisions.has(a.revision))) {
      for (let i = 1; i < ordered.length; i++) {
        add(capture(`step-${i}`, [...new Set(ordered.slice(i).map(a => a.file))]));
      }
    }
    return [...revisions];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function enrichSnapshotWithDigests(command, root, result) {
  const records = result.records ?? [];
  const files = [
    ...new Set(
      records
        .filter(r => (r.provenance ?? 'workspace') === 'workspace')
        .map(recordFileOf)
        .filter(f => Boolean(f) && !f.startsWith('.ia/distributions/') && !f.startsWith('.ia/floor/')),
    ),
  ];
  const infoById = new Map();
  for (const file of files) {
    const ran = spawnSync(command[0], [...command.slice(1), 'inspect', '--path', file, '--depth', '0', '--json', '--root', root], {
      cwd: root,
      env: handoffOff(),
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    if (ran.status !== 0) continue;
    try {
      const parsed = JSON.parse(ran.stdout);
      for (const rec of parsed.records ?? []) {
        if (rec.identity && rec.digest) infoById.set(rec.identity, { digest: rec.digest, kind: rec.kind, system: rec.system });
      }
    } catch {
      // ignore malformed inspect output
    }
  }

  const missingIds = new Set();
  for (const rec of records) {
    if (rec.discriminator === 'system' && rec.identity.startsWith('floor/') && !infoById.has(rec.identity)) {
      missingIds.add(rec.identity);
    }
    if (rec.discriminator !== 'approval') continue;
    for (const item of listItems(sectionField(rec, 'seal.depends-on')).map(scalarText).filter(Boolean)) {
      const space = item.lastIndexOf(' ');
      const depId = space > 0 ? item.slice(0, space) : null;
      if (depId && !infoById.has(depId)) missingIds.add(depId);
    }
  }
  let floorLanguage = null;
  for (const id of missingIds) {
    const ran = spawnSync(command[0], [...command.slice(1), 'inspect', id, '--depth', '0', '--json', '--root', root], {
      cwd: root,
      env: handoffOff(),
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    if (ran.status !== 0) continue;
    try {
      const parsed = JSON.parse(ran.stdout);
      for (const rec of parsed.records ?? []) {
        if (rec.identity && rec.digest) infoById.set(rec.identity, { digest: rec.digest, kind: rec.kind, system: rec.system });
        if (rec.system === 'floor' && rec.facet === 'system' && !floorLanguage) {
          floorLanguage = scalarText(sectionField(rec, 'version')) ?? rec.head?.find(f => f.key === 'version')?.value?.text ?? null;
        }
      }
    } catch {
      // ignore
    }
  }

  for (const rec of records) {
    const extra = infoById.get(rec.identity);
    if (extra) {
      rec.digest = extra.digest;
      if (!rec.kind && extra.kind) rec.kind = extra.kind;
    }
  }

  const verRun = spawnSync(command[0], [...command.slice(1), '--version'], {
    env: handoffOff(),
    encoding: 'utf8',
    windowsHide: true,
  });
  const cliVersion = (verRun.stdout || '').trim().replace(/^ia\s+/, '') || null;
  const lfPinned = existsSync(join(root, '.gitattributes'))
    ? LF_PIN_RE.test(readFileSync(join(root, '.gitattributes'), 'utf8'))
    : true;

  const hasCurrentRevRule = records.some(
    r => r.discriminator === 'approval-rule' && scalarText(sectionField(r, 'demand.staleness')) === 'current-revision',
  );
  const approvals = records
    .filter(r => r.discriminator === 'approval' && recordFileOf(r))
    .map(r => {
      const text = key => scalarText(sectionField(r, `seal.${key}`));
      const listed = key => sectionField(r, `seal.${key}`)?.kind === 'list';
      // The structural gate check-seal's parseApproval applies before it orders sequential signers
      const wellFormed =
        APPROVAL_TEXT_FIELDS.every(key => Boolean(text(key))) &&
        ['depends-on', 'rules', 'system-versions'].every(listed) &&
        text('algorithm') === 'ed25519' &&
        HEX_64_RE.test(text('record-digest')) &&
        HEX_64_RE.test(text('revision')) &&
        COMMIT_RE.test(text('base-commit')) &&
        ['approve', 'delete'].includes(text('action')) &&
        ['service-held', 'person-held'].includes(text('key-kind')) &&
        ['desk', 'slack'].includes(text('via')) &&
        isValidRfc3339Utc(text('signed-at'));
      return { file: recordFileOf(r), signedAt: text('signed-at'), revision: text('revision'), wellFormed };
    });
  const validRevisions = hasCurrentRevRule ? computeUnsealedRevisions(command, root, approvals) : [];

  return {
    ...result,
    language: floorLanguage ?? cliVersion,
    cliVersion,
    lineEndingsPinned: lfPinned,
    validRevisions,
  };
}

function readRecords(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'records', '--root', root, '--params', '{}'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (!ran.error && ran.status === 0 && reply?.ok === true && Array.isArray(reply.result?.records)) {
    return enrichSnapshotWithDigests(command, root, reply.result);
  }
  throw new Error(`ia records did not return the admitted records: ${refusal(ran, reply)}`);
}

export function runWorkspacePrdCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node check-prds.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkPrds(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspacePrdCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-prds: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
