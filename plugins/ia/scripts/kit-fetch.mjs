#!/usr/bin/env node
// Fetch one kit archive the InventArch account connector offered, check its digest, and hand the file to
// `kit.mjs add --from` (decision public-account-connector). The connector's kit_download tool returns
// { url, expiresAt, archive }: a short-lived signed URL, and the SHA-256 of the bytes behind it. This script
// is the only code that touches that URL. It reads it from stdin (never argv, so it is not in a process
// listing), never prints it, never stores it, and keeps no token: the host runs the sign-in and the signed
// URL carries its own authority. It installs nothing; `kit.mjs add --from <file> --apply` does.
//   kit-fetch.mjs get < entry.json    entry.json is { "id", "version", "url", "archive" }, piped on stdin
//   kit-fetch.mjs clean <file>        remove the downloaded file and the folder it was made in
// `get` prints { file, sha256, bytes } and exits 0, or { error: { code, message } } and exits 1 (a bad
// digest writes nothing). Exit 2 on bad usage.
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printJson, refuse, UsageError } from './lib/workspace.mjs';

const USAGE = 'usage: kit-fetch.mjs get (a JSON { id, version, url, archive } on stdin) | kit-fetch.mjs clean <file>\n';
const PREFIX = 'ia-kit-fetch-';
export const MAX_BYTES = 64 * 1024 * 1024;

class FetchError extends Error {
  constructor(message, code = 'IA-CORE-KIT-FETCH') { super(message); this.code = code; }
}

// The expected digest, from "<hex>" or "sha256:<hex>", lower-cased.
export function expectedDigest(archive) {
  const hex = typeof archive === 'string' ? archive.trim().replace(/^sha256[:-]/i, '').toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new FetchError('archive must be the SHA-256 of the kit archive (64 hex digits)', 'IA-CORE-KIT-FETCH-ARGS');
  return hex;
}

const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'kit';

// Download `url`, require its bytes to hash to `archive`, and write them to <tmp>/ia-kit-fetch-*/<id>-<version>.tgz.
export async function fetchKit({ id, version, url, archive }, { fetchImpl = fetch, tmp = tmpdir() } = {}) {
  const want = expectedDigest(archive);
  let target;
  try { target = new URL(url); } catch { throw new FetchError('url is not a URL', 'IA-CORE-KIT-FETCH-ARGS'); }
  if (target.protocol !== 'https:') throw new FetchError('url must be https', 'IA-CORE-KIT-FETCH-ARGS');
  let response;
  try { response = await fetchImpl(target, { redirect: 'follow' }); } catch (error) { throw new FetchError(`the download failed: ${error?.cause?.code ?? error?.name ?? 'error'}`); }
  if (!response.ok) throw new FetchError(`the download was refused: HTTP ${response.status}${response.status === 403 || response.status === 410 ? ' (the signed URL may have expired; ask kit_download for a new one)' : ''}`);
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new FetchError(`the archive is over ${MAX_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new FetchError(`the archive is over ${MAX_BYTES} bytes`);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new FetchError(`the downloaded bytes hash to ${got}, not the offered ${want}; nothing was written`, 'IA-CORE-KIT-FETCH-DIGEST');
  const dir = mkdtempSync(join(tmp, PREFIX));
  const file = join(dir, `${slug(id)}-${slug(version)}.tgz`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sha256: got, bytes: bytes.length };
}

// Remove a file `get` made, and its folder. Refuses any other path.
export function cleanFetched(file, { tmp = tmpdir() } = {}) {
  const dir = dirname(resolve(file));
  let root;
  try { root = realpathSync.native(tmp); } catch { root = resolve(tmp); }
  let real;
  try { real = realpathSync.native(dir); } catch { return { removed: false }; }
  if (!basename(real).startsWith(PREFIX) || dirname(real) !== root) throw new FetchError(`${file} is not a download of this script`, 'IA-CORE-KIT-FETCH-ARGS');
  rmSync(real, { recursive: true, force: true });
  return { removed: true };
}

const readStdin = async () => { let text = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) text += chunk; return text; };

export async function main(argv, readInput = readStdin) {
  const [command, ...rest] = argv;
  if (command === 'clean' && rest.length === 1) return cleanFetched(rest[0]);
  if (command !== 'get' || rest.length) throw new UsageError(USAGE.trim());
  let input;
  try { input = JSON.parse(await readInput()); } catch { throw new UsageError('stdin must be the JSON { id, version, url, archive }'); }
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') throw new UsageError('stdin must be the JSON { id, version, url, archive }');
  return fetchKit(input);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try { printJson(await main(process.argv.slice(2))); } catch (error) {
    if (error.code === 'IA-CORE-USAGE') { process.stderr.write(USAGE); process.exit(2); }
    process.exit(refuse(error));
  }
}
