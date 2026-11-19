#!/usr/bin/env node
// inventarch/ia-design-base-kit offline Atomic Design & pattern/recipe checker (declared check: check-design-patterns).
// Pure Node built-in ESM, zero external npm dependencies, and zero network access.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node check-design-patterns.mjs [--ia] <the command words that run ia...>
// Prints { format, revision, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.design.pattern-check.v1';
export const STAGE_ORDER = Object.freeze({
  atom: 1,
  molecule: 2,
  organism: 3,
  'page-template': 4,
  page: 5,
});
const MAX_BUFFER = 256 * 1024 * 1024;

const EVIDENCE_RE = /^[0-9a-f]{64}\s+[A-Za-z0-9_-]+#[A-Za-z0-9:_-]+$/;
const ARROW_PAIR_RE = /^([^\s-][^]*?)\s*->\s*([^\s][^]*)$/;
const SLOT_MAP_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*<-\s*(\S[^]*)$/;
const VARIANT_MAP_RE = /^[^=\s]+=\S[^]*?\s*->\s*[^=\s]+=\S[^]*$/;

const RAW_HEX_OR_FUNC_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\(/;
const RAW_PALETTE_RE =
  /(?:^|:|-)(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/;
const PRIMITIVE_CLASS_RE = /(?:^|:)(?:bg|text|border|fill|stroke|ring)-(?:primitive|raw|palette)-/;
const ADAPT_SCALE_CLASS_RE =
  /^(?:[a-z0-9-]+:)*(?:-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|space-x|space-y|gap|gap-x|gap-y|w|min-w|max-w|h|min-h|max-h|size|inset|top|right|bottom|left)-|(?:flex|inline-flex|grid|inline-grid|block|inline-block|hidden|table|col-span-|row-span-|justify-|items-|content-|self-|place-|order-))/;

const PROTECTED_OUTPUT_PREFIXES = ['.ia/', '.git/', '.github/', 'node_modules/', 'vendor/'];
const PROTECTED_OUTPUT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'biome.json',
]);

// Seal verification constants (Ed25519 + RFC 8785 JCS)
const STATEMENT_PURPOSE = 'inventarch-approval';
const STATEMENT_VERSION = 1;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const GROUP_ORDER_LE = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
const ED25519_P = (1n << 255n) - 19n;
const HEX64_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const APPROVAL_FILE_RE = /^([a-z0-9-]+)\.([0-9a-f]{12})\.([0-9a-f]{8})\.ia$/;
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const LF_PIN_RE = /^(?:\*|\*\.ia)[ \t]+(?:\S+[ \t]+)*text(?:=auto)?[ \t]+(?:\S+[ \t]+)*eol=lf[ \t]*$/m;
const KEY_KIND_STRENGTH = { 'service-held': 0, 'person-held': 1 };

export function isSafeRecipeOutput(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[:\0]/.test(value) ||
    !value.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..')
  ) {
    return false;
  }
  const lower = value.toLowerCase();
  if (PROTECTED_OUTPUT_FILES.has(lower) || PROTECTED_OUTPUT_FILES.has(lower.split('/').at(-1))) return false;
  if (PROTECTED_OUTPUT_PREFIXES.some(prefix => lower.startsWith(prefix))) return false;
  return true;
}

export function inspectTokenClassList(classListText, primitiveClasses = new Set()) {
  const tokens = String(classListText ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return { raw: true, scale: false, reason: 'empty class list' };
  let raw = false;
  let scale = false;
  const reasons = [];
  for (const cls of tokens) {
    if (cls.startsWith('!') || cls.includes(':!')) {
      raw = true;
      reasons.push(`important flag in '${cls}'`);
    }
    if (cls.includes('[') || cls.includes(']')) {
      raw = true;
      reasons.push(`arbitrary value in '${cls}'`);
    }
    const withoutVariants = cls.split(':').pop() ?? cls;
    const bareUtility = withoutVariants.replace(/^[!-]+/, '');
    if (
      RAW_HEX_OR_FUNC_RE.test(cls) ||
      RAW_PALETTE_RE.test(cls) ||
      PRIMITIVE_CLASS_RE.test(cls) ||
      primitiveClasses.has(cls) ||
      primitiveClasses.has(withoutVariants) ||
      primitiveClasses.has(bareUtility)
    ) {
      raw = true;
      reasons.push(`raw or primitive token '${cls}'`);
    }
    if (ADAPT_SCALE_CLASS_RE.test(cls)) {
      scale = true;
    }
  }
  return { raw, scale, reason: reasons.join('; ') };
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

function outgoingEdges(record, predicate, targetDiscriminator, resolveRef, byIdentity) {
  const targets = [];
  for (const edge of record.edges ?? []) {
    if (edge.predicate !== predicate || (edge.direction && edge.direction !== 'out')) continue;
    const resolved = resolveRef(edge);
    if (!resolved) continue;
    const targetRecord = byIdentity.get(resolved);
    if (!targetDiscriminator || targetRecord?.discriminator === targetDiscriminator) targets.push(resolved);
  }
  return [...new Set(targets)];
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

function buildSealVerifier(snapshot, allRecords, byIdentity, resolveRef) {
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
      !HEX64_RE.test(recDigest) ||
      !revision ||
      !HEX64_RE.test(revision) ||
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
      return HEX64_RE.test(digest) ? { identity, digest } : null;
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

    // Verify dependency digests still hold
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

  const rulesCoveringRecord = record => {
    const recFile = recordFileOf(record) ?? '';
    const recWs = workspaceOfPath(recFile);
    const recKind = record.kind ?? 'definition';
    return parsedRules.filter(rule => {
      if (authoredRoots.length > 0 && rule.workspace && recWs && !workspaceCovers(rule.workspace, recWs)) return false;
      return (
        rule.words.includes(record.discriminator) ||
        rule.kinds.includes(recKind) ||
        (recFile !== '' && rule.paths.some(prefix => recFile.startsWith(prefix))) ||
        (rule.coversUnrecognised && unrecognised.has(record.identity))
      );
    });
  };

  const hasValidSeal = record => {
    if (typeof record?.digest !== 'string' || !HEX64_RE.test(record.digest)) return false;
    if (hasMalformedRule) return false;
    const recFile = recordFileOf(record);
    const recWs = workspaceOfPath(recFile);
    const seals = (verifiedSealsByTarget.get(record.identity) ?? []).filter(entry => {
      const s = entry.statement;
      if (s.recordDigest !== record.digest) return false;
      if (authoredRoots.length > 0 && recWs && s.workspace !== recWs) return false;
      return approverCovers(entry.approver, recWs ?? s.workspace);
    });
    if (seals.length === 0) return false;

    const covering = rulesCoveringRecord(record);
    if (covering.length === 0) return true;

    for (const rule of covering) {
      if (typeof rule.digest === 'string' && !HEX64_RE.test(rule.digest)) return false;
      const accountsForRule = new Set();
      for (const { statement: s, approver } of seals) {
        const ruleRef = s.rules.find(r => r.identity === rule.identity);
        if (!ruleRef) continue;
        if (typeof rule.digest === 'string' && HEX64_RE.test(rule.digest) && ruleRef.digest !== rule.digest) continue;
        const allowed =
          rule.via.includes(s.via) &&
          KEY_KIND_STRENGTH[s.keyKind] >= KEY_KIND_STRENGTH[rule.keyKind] &&
          (rule.from === null || rule.from.includes(approver.account));
        if (!allowed) continue;
        if (rule.staleness === 'current-revision') {
          if (!lfPinned) continue;
          if (validLanguages.size > 0 && !validLanguages.has(s.language)) continue;
          if (validRevisions.size > 0 && !validRevisions.has(s.revision)) continue;
        }
        accountsForRule.add(approver.account);
      }
      if (accountsForRule.size < rule.quorum) return false;
    }
    return true;
  };

  return { hasValidSeal, parsedRules, hasMalformedRule };
}

export function checkDesignPatterns(snapshot) {
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
  const designTokens = own.filter(r => r.discriminator === 'design-token');
  const levels = own.filter(r => r.discriminator === 'level');
  const parts = own.filter(r => r.discriminator === 'part');
  const slots = own.filter(r => r.discriminator === 'slot');
  const patterns = own.filter(r => r.discriminator === 'pattern');
  const recipes = own.filter(r => r.discriminator === 'recipe');
  const approvalRules = own.filter(r => r.discriminator === 'approval-rule');

  // Collect primitive token classes so recipes/parts cannot smuggle primitive tokens via class lists
  const primitiveClasses = new Set();
  const tokenTierById = new Map();
  for (const tok of allRecords.filter(r => r.discriminator === 'design-token')) {
    const tier = scalarText(sectionField(tok, 'token.tier'));
    tokenTierById.set(tok.identity, tier);
    if (tier === 'primitive') {
      for (const item of listItems(sectionField(tok, 'token.classes'))) {
        const cls = scalarText(item);
        if (cls) primitiveClasses.add(cls.trim());
      }
    }
  }

  // 1. @level checks: unique stages and rank ordering consistent with atom < molecule < organism < page-template < page
  const levelInfo = new Map();
  const seenStage = new Map();
  for (const lvl of allRecords.filter(r => r.discriminator === 'level')) {
    const rank = numberValue(sectionField(lvl, 'level.rank'));
    const stage = scalarText(sectionField(lvl, 'level.stage'));
    const stageIdx = stage ? (STAGE_ORDER[stage] ?? null) : null;
    levelInfo.set(lvl.identity, { rank, stage, stageIdx, record: lvl });
    if ((lvl.provenance ?? 'workspace') === 'workspace' && stage) {
      if (seenStage.has(stage)) {
        report('LEVEL_DUPLICATE_STAGE', lvl, `@level ${lvl.name} duplicates stage '${stage}' already declared by ${seenStage.get(stage)}`);
      } else {
        seenStage.set(stage, lvl.name);
      }
    }
  }

  const ownLevels = levels.map(l => levelInfo.get(l.identity)).filter(Boolean);
  for (let i = 0; i < ownLevels.length; i++) {
    for (let j = i + 1; j < ownLevels.length; j++) {
      const a = ownLevels[i];
      const b = ownLevels[j];
      if (a.stageIdx !== null && b.stageIdx !== null && a.rank !== null && b.rank !== null) {
        if ((a.stageIdx < b.stageIdx && a.rank >= b.rank) || (a.stageIdx > b.stageIdx && a.rank <= b.rank)) {
          const offender = a.stageIdx > b.stageIdx ? a.record : b.record;
          report(
            'LEVEL_STAGE_RANK_ORDER',
            offender,
            `@level ${a.record.name} (${a.stage}, rank ${a.rank}) and @level ${b.record.name} (${b.stage}, rank ${b.rank}) invert canonical Atomic Design order`,
          );
        }
      }
    }
  }

  // 2. @slot ownership index & duplicate check
  const slotsByPart = new Map();
  for (const slot of allRecords.filter(r => r.discriminator === 'slot')) {
    const ownerId = resolveRef(sectionField(slot, 'slot.part'), ['part']);
    const slotName = scalarText(sectionField(slot, 'slot.name')) ?? '';
    if (ownerId) {
      if (!slotsByPart.has(ownerId)) slotsByPart.set(ownerId, new Map());
      const map = slotsByPart.get(ownerId);
      if ((slot.provenance ?? 'workspace') === 'workspace' && map.has(slotName)) {
        report('SLOT_DUPLICATE_NAME', slot, `@slot ${slot.name} duplicates slot.name '${slotName}' on ${ownerId}`);
      } else {
        map.set(slotName, slot.identity);
      }
    } else if ((slot.provenance ?? 'workspace') === 'workspace') {
      report('SLOT_OWNER_MISMATCH', slot, `@slot ${slot.name}: slot.part does not resolve to an admitted @part`);
    }
  }

  // 3. @part checks: atomic hierarchy, cycles, token tiers, slot ownership, and unambiguous Figma component-set claims
  const partGraph = new Map();
  const figmaClaimants = new Map();

  for (const part of allRecords.filter(r => r.discriminator === 'part')) {
    const composedRefs = listItems(sectionField(part, 'part.composes'))
      .map(r => resolveRef(r, ['part']))
      .filter(Boolean);
    const reqParts = outgoingEdges(part, 'require', 'part', resolveRef, byIdentity);
    partGraph.set(part.identity, [...new Set([...composedRefs, ...reqParts])]);
  }

  for (const part of parts) {
    const lvlId = resolveRef(sectionField(part, 'part.level'), ['level']);
    const fromLevel = lvlId ? levelInfo.get(lvlId) : null;
    if (!fromLevel) {
      report('PART_LEVEL_UNRESOLVED', part, `@part ${part.name}: part.level does not resolve to an admitted @level`);
    }

    for (const childId of partGraph.get(part.identity) ?? []) {
      const childPart = byIdentity.get(childId);
      if (!childPart) continue;
      const childLvlId = resolveRef(sectionField(childPart, 'part.level'), ['level']);
      const toLevel = childLvlId ? levelInfo.get(childLvlId) : null;
      if (fromLevel && toLevel) {
        const upwardStage = fromLevel.stageIdx !== null && toLevel.stageIdx !== null && toLevel.stageIdx > fromLevel.stageIdx;
        const upwardRank = fromLevel.rank !== null && toLevel.rank !== null && toLevel.rank > fromLevel.rank;
        if (upwardStage || upwardRank) {
          report(
            'PART_ATOMIC_HIERARCHY',
            part,
            `@part ${part.name} (${fromLevel.stage}) cannot compose higher-stage @part ${childPart.name} (${toLevel.stage})`,
          );
        }
      }
      if (
        fromLevel?.stage === 'page' &&
        childPart &&
        toLevel?.stage === 'page' &&
        part.identity !== childId
      ) {
        report('PART_ATOMIC_HIERARCHY', part, `@part ${part.name} (page) should instantiate templates/organisms rather than another page`);
      }
    }

    // Slot references on @part must belong to this @part
    for (const slotItem of listItems(sectionField(part, 'part.slots'))) {
      const slotId = resolveRef(slotItem, ['slot']);
      const slotRec = slotId ? byIdentity.get(slotId) : null;
      const slotOwner = slotRec ? resolveRef(sectionField(slotRec, 'slot.part'), ['part']) : null;
      if (!slotRec || slotOwner !== part.identity) {
        report(
          'SLOT_OWNER_MISMATCH',
          part,
          `@part ${part.name}: part.slots references ${scalarText(slotItem) ?? slotId ?? 'unknown'}, whose slot.part is not ${part.name}`,
        );
      }
    }

    // Tokens on @part must be semantic or component, never primitive
    for (const tokItem of listItems(sectionField(part, 'part.tokens'))) {
      const tokId = resolveRef(tokItem, ['design-token']);
      if (tokId && tokenTierById.get(tokId) === 'primitive') {
        report(
          'PART_PRIMITIVE_TOKEN',
          part,
          `@part ${part.name} references primitive @design-token ${byIdentity.get(tokId)?.name ?? tokId}; parts paint with semantic or component tokens only`,
        );
      }
    }

    // Single-claimant Figma component-set check across proposed/active parts (REQ-PAT-06)
    const standing = scalarText(sectionField(part, 'part.standing')) ?? 'proposed';
    if (standing === 'proposed' || standing === 'active') {
      const explicitNames = listItems(sectionField(part, 'part.figma-names'))
        .map(scalarText)
        .filter(v => typeof v === 'string' && v.length > 0);
      const partName = scalarText(sectionField(part, 'part.name')) ?? part.name;
      const claimedSets = explicitNames.length > 0 ? explicitNames : [partName];
      for (const setName of new Set(claimedSets)) {
        if (!figmaClaimants.has(setName)) figmaClaimants.set(setName, []);
        figmaClaimants.get(setName).push(part);
      }
    }
  }

  for (const [setName, claimants] of figmaClaimants.entries()) {
    if (claimants.length > 1) {
      for (const claimant of claimants) {
        report(
          'PART_FIGMA_SET_AMBIGUOUS',
          claimant,
          `Figma component set '${setName}' is claimed by multiple parts (${claimants.map(c => c.name).join(', ')}); ownership is ambiguous`,
        );
      }
    }
  }

  for (const cyclicId of detectCycles(partGraph)) {
    const part = byIdentity.get(cyclicId);
    if (part && (part.provenance ?? 'workspace') === 'workspace') {
      report('PART_CYCLE', part, `@part ${part.name} participates in a composition cycle`);
    }
  }

  const { hasValidSeal, parsedRules, hasMalformedRule } = buildSealVerifier(snapshot, allRecords, byIdentity, resolveRef);

  // Named-words-rule check when @approval-rule records exist alongside @pattern or @recipe (REQ-PAT-04)
  if (approvalRules.length > 0 && (patterns.length > 0 || recipes.length > 0)) {
    const coveredWords = new Set();
    let coversAllDefinitions = false;
    for (const rule of parsedRules) {
      for (const w of rule.words) coveredWords.add(w);
      if (rule.kinds.includes('definition')) coversAllDefinitions = true;
    }
    if (hasMalformedRule || (!coversAllDefinitions && (!coveredWords.has('pattern') || !coveredWords.has('recipe')))) {
      const anchor = patterns[0] ?? recipes[0];
      report(
        'MISSING_NAMED_WORDS_RULE',
        anchor,
        `workspace declares @approval-rule records alongside @pattern/@recipe without covering both 'pattern' and 'recipe'`,
      );
    }
  }

  // 4. @pattern checks
  const patternGraph = new Map();
  for (const pat of allRecords.filter(r => r.discriminator === 'pattern')) {
    patternGraph.set(pat.identity, outgoingEdges(pat, 'supersede', 'pattern', resolveRef, byIdentity));
  }
  for (const pat of patterns) {
    const matches = listItems(sectionField(pat, 'pattern.matches'))
      .map(scalarText)
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    if (matches.length === 0) {
      report('PATTERN_MATCHES_EMPTY', pat, `@pattern ${pat.name}: pattern.matches must hold at least one structural match entry`);
    }

    const yieldsRaw = scalarText(sectionField(pat, 'pattern.yields')) ?? '';
    const yieldedId = resolveRef(yieldsRaw, ['part', 'level']);
    const yieldedRec = yieldedId ? byIdentity.get(yieldedId) : null;
    if (!yieldedRec || !['part', 'level'].includes(yieldedRec.discriminator)) {
      report('PATTERN_YIELDS_UNKNOWN', pat, `@pattern ${pat.name}: pattern.yields '${yieldsRaw}' resolves to no admitted @part or @level`);
    }

    const slotEntries = listItems(sectionField(pat, 'pattern.slots')).map(scalarText);
    for (const entry of slotEntries) {
      const m = SLOT_MAP_RE.exec(entry ?? '');
      if (!m) {
        report('PATTERN_SLOT_UNKNOWN', pat, `@pattern ${pat.name}: pattern.slots entry ${JSON.stringify(entry)} must match '<slot name> <- <node path>'`);
        continue;
      }
      const slotName = m[1];
      if (yieldedRec?.discriminator !== 'part' || !slotsByPart.get(yieldedRec.identity)?.has(slotName)) {
        report(
          'PATTERN_SLOT_UNKNOWN',
          pat,
          `@pattern ${pat.name}: slot '${slotName}' is not a declared @slot of yielded part ${yieldedRec?.name ?? yieldsRaw}`,
        );
      }
    }

    const recipeRaw = scalarText(sectionField(pat, 'pattern.recipe'));
    if (recipeRaw !== null) {
      const recId = resolveRef(recipeRaw, ['recipe']);
      const recObj = recId ? byIdentity.get(recId) : null;
      if (!recObj || recObj.discriminator !== 'recipe') {
        report('PATTERN_RECIPE_UNKNOWN', pat, `@pattern ${pat.name}: pattern.recipe '${recipeRaw}' resolves to no admitted @recipe`);
      } else if (yieldedRec?.discriminator === 'part') {
        const recipePartId = resolveRef(scalarText(sectionField(recObj, 'recipe.part')), ['part']);
        if (recipePartId !== yieldedRec.identity) {
          report(
            'PATTERN_RECIPE_UNKNOWN',
            pat,
            `@pattern ${pat.name}: pattern.recipe ${recObj.name} lowers ${recipePartId ?? 'unknown'}, not yielded part ${yieldedRec.name}`,
          );
        }
      }
    }

    const evidence = listItems(sectionField(pat, 'pattern.evidence')).map(scalarText);
    if (evidence.length === 0 || evidence.some(e => !EVIDENCE_RE.test(e ?? ''))) {
      report(
        'PATTERN_EVIDENCE_INVALID',
        pat,
        `@pattern ${pat.name}: pattern.evidence must contain non-empty '<64-hex digest> <fileKey>#<nodeId>' entries`,
      );
    }

    const standing = scalarText(sectionField(pat, 'pattern.standing'));
    if (standing === 'active' && !hasValidSeal(pat)) {
      report('ACTIVE_PATTERN_UNSEALED', pat, `@pattern ${pat.name} has standing active without a valid cryptographic @approval seal`);
    }
  }

  for (const cyclicId of detectCycles(patternGraph)) {
    const pat = byIdentity.get(cyclicId);
    if (pat && (pat.provenance ?? 'workspace') === 'workspace') {
      report('PATTERN_CYCLE', pat, `@pattern ${pat.name} participates in a supersede cycle`);
    }
  }

  // 5. @recipe checks
  const recipeGraph = new Map();
  for (const rec of allRecords.filter(r => r.discriminator === 'recipe')) {
    recipeGraph.set(rec.identity, outgoingEdges(rec, 'supersede', 'recipe', resolveRef, byIdentity));
  }

  for (const rec of recipes) {
    const partRaw = scalarText(sectionField(rec, 'recipe.part')) ?? '';
    const partId = resolveRef(partRaw, ['part']);
    const partRec = partId ? byIdentity.get(partId) : null;
    if (!partRec || partRec.discriminator !== 'part') {
      report('RECIPE_PART_UNKNOWN', rec, `@recipe ${rec.name}: recipe.part '${partRaw}' resolves to no admitted @part`);
    }
    const codeExport = partRec ? scalarText(sectionField(partRec, 'part.code-export')) : null;
    const hasCodeExport = typeof codeExport === 'string' && codeExport.trim().length > 0;

    const mode = scalarText(sectionField(rec, 'recipe.mode')) ?? '';
    const template = scalarText(sectionField(rec, 'recipe.template'));
    const props = listItems(sectionField(rec, 'recipe.props')).map(scalarText);
    const variants = listItems(sectionField(rec, 'recipe.variants')).map(scalarText);
    const overridesField = sectionField(rec, 'recipe.overrides');
    const overrides = listItems(overridesField).map(scalarText);
    const gap = scalarText(sectionField(rec, 'recipe.gap'));
    const classesField = sectionField(rec, 'recipe.classes');
    const classes = listItems(classesField).map(scalarText);
    const output = scalarText(sectionField(rec, 'recipe.output'));
    const standing = scalarText(sectionField(rec, 'recipe.standing'));

    for (const p of props) {
      if (!ARROW_PAIR_RE.test(p ?? '')) {
        report('RECIPE_PROP_FORMAT', rec, `@recipe ${rec.name}: recipe.props entry ${JSON.stringify(p)} must match '<figma prop> -> <code prop>'`);
      }
    }
    for (const v of variants) {
      if (!VARIANT_MAP_RE.test(v ?? '')) {
        report(
          'RECIPE_VARIANT_FORMAT',
          rec,
          `@recipe ${rec.name}: recipe.variants entry ${JSON.stringify(v)} must match '<figma prop>=<value> -> <code prop>=<value>'`,
        );
      }
    }

    if (mode === 'use') {
      if (partRec && !hasCodeExport) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode use) requires part.code-export on @part ${partRec.name}`);
      }
      if (template !== null || classesField !== undefined || overridesField !== undefined || gap !== null) {
        report(
          'RECIPE_MODE_CONTRACT',
          rec,
          `@recipe ${rec.name} (mode use) must omit recipe.template, recipe.classes, recipe.overrides and recipe.gap`,
        );
      }
    } else if (mode === 'adapt') {
      if (partRec && !hasCodeExport) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires part.code-export on @part ${partRec.name}`);
      }
      if (template !== null || classesField !== undefined) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) must omit recipe.template and recipe.classes`);
      }
      if (overrides.length === 0) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires a non-empty recipe.overrides list`);
      }
      if (!gap || !gap.trim()) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires a non-empty recipe.gap naming the library gap`);
      }
    } else if (mode === 'compose') {
      if (!template || !template.trim() || classes.length === 0) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode compose) requires recipe.template and non-empty recipe.classes`);
      }
      if (overridesField !== undefined || gap !== null) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode compose) must omit recipe.overrides and recipe.gap`);
      }
    } else if (mode === 'define') {
      if (hasCodeExport) {
        report(
          'RECIPE_DEFINE_OVER_EXPORT',
          rec,
          `@recipe ${rec.name} (mode define) is refused because @part ${partRec.name} already declares part.code-export (${codeExport})`,
        );
      }
      if (!template || !template.trim() || classes.length === 0 || !output || !output.trim()) {
        report(
          'RECIPE_MODE_CONTRACT',
          rec,
          `@recipe ${rec.name} (mode define) requires recipe.template, non-empty recipe.classes and recipe.output`,
        );
      }
      if (overridesField !== undefined || gap !== null) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode define) must omit recipe.overrides and recipe.gap`);
      }
    }

    for (const entry of classes) {
      const m = ARROW_PAIR_RE.exec(entry ?? '');
      if (!m) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.classes entry ${JSON.stringify(entry)} must match '<node role> -> <class list>'`);
        continue;
      }
      const checked = inspectTokenClassList(m[2], primitiveClasses);
      if (checked.raw) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.classes '${entry}' uses disallowed styling (${checked.reason})`);
      }
    }

    for (const entry of overrides) {
      const m = ARROW_PAIR_RE.exec(entry ?? '');
      if (!m) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.overrides entry ${JSON.stringify(entry)} must match '<node role> -> <class list>'`);
        continue;
      }
      const checked = inspectTokenClassList(m[2], primitiveClasses);
      if (checked.raw) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.overrides '${entry}' uses disallowed styling (${checked.reason})`);
      }
      if (checked.scale) {
        report(
          'RECIPE_ADAPT_SCALE',
          rec,
          `@recipe ${rec.name}: adapt override '${entry}' contains size, spacing or layout classes; report those as a library gap instead`,
        );
      }
    }

    if (output !== null && !isSafeRecipeOutput(output)) {
      report(
        'RECIPE_OUTPUT_UNSAFE',
        rec,
        `@recipe ${rec.name}: recipe.output ${JSON.stringify(output)} must be a canonical repo-relative path outside protected .ia, CI or config files`,
      );
    }

    if (standing === 'active' && !hasValidSeal(rec)) {
      report('ACTIVE_RECIPE_UNSEALED', rec, `@recipe ${rec.name} has standing active without a valid cryptographic @approval seal`);
    }
  }

  for (const cyclicId of detectCycles(recipeGraph)) {
    const rec = byIdentity.get(cyclicId);
    if (rec && (rec.provenance ?? 'workspace') === 'workspace') {
      report('RECIPE_CYCLE', rec, `@recipe ${rec.name} participates in a supersede cycle`);
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      designTokens: designTokens.length,
      levels: levels.length,
      parts: parts.length,
      slots: slots.length,
      patterns: patterns.length,
      recipes: recipes.length,
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
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-design-rev-')));
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
      return snap.authoredRevision || null;
    } catch {
      return null;
    }
  };
  try {
    const revisions = new Set();
    const add = rev => {
      if (rev) revisions.add(rev);
    };
    add(capture('full', []));
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

  // Enrich any distribution dependency referenced in @approval seal.depends-on
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
        HEX64_RE.test(text('record-digest')) &&
        HEX64_RE.test(text('revision')) &&
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

export function runWorkspaceDesignPatternCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node check-design-patterns.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkDesignPatterns(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspaceDesignPatternCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-design-patterns: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
