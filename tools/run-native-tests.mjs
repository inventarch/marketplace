import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function sourceSnapshot() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file).update('\0'); hash.update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<deleted>'); hash.update('\0'); }
  return hash.digest('hex');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// The one CLI version the native lane qualifies; tools/consistency.py holds it to sources.lock.json.
const CLI_VERSION = '3.5.0';
export function inspectCli(entry) {
  assert(entry, 'IA_CORE_TEST_CLI is required; use the installed @inventarch/cli/dist/main.js');
  const cli = resolve(entry);
  assert(existsSync(cli), `native CLI missing: ${cli}`);
  const pkg = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@inventarch/cli');
  assert.equal(pkg.version, CLI_VERSION, 'required native CLI version');
  const reported = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 30000 });
  assert.match(reported, new RegExp(`\\b${CLI_VERSION.replaceAll('.', '\\.')}\\b`), 'the native CLI reports another version');
  return { entry: cli, version: pkg.version, entrySha256: digest(readFileSync(cli)) };
}
export function reconcile(cases, results) {
  const ids = new Set(), owners = new Set();
  for (const c of cases) {
    assert(!ids.has(c.id), `duplicate inventory id: ${c.id}`); ids.add(c.id);
    const key = `${c.file}\0${c.name}`; assert(!owners.has(key), `duplicate inventory owner: ${c.id}`); owners.add(key);
    assert.equal(c.mode, 'native'); assert(c.platforms.includes(process.platform), `unsupported required platform: ${c.id}`);
  }
  return cases.map(c => {
    const found = results.filter(r => r.file === c.file && r.name === c.name);
    return { id: c.id, file: c.file, name: c.name, discovered: found.length, executed: found.length === 1 && !found[0].skip && !found[0].todo,
      status: found.length !== 1 ? 'missing-or-duplicate' : found[0].skip || found[0].todo ? 'skip' : found[0].status };
  });
}
// Every case names its shard (1..inventory.shards). `--shard <i>` runs one
// shard; `--verify <dir>...` accepts shard reports only when, together, they
// ran every inventory case exactly once and passed, on one source and one CLI.
export function checkShards(inventory) {
  const { shards, cases } = inventory;
  assert(Number.isInteger(shards) && shards >= 1, 'inventory.shards must be a positive integer');
  for (const c of cases) assert(Number.isInteger(c.shard) && c.shard >= 1 && c.shard <= shards, `case ${c.id} needs a shard in 1..${shards}`);
  for (let i = 1; i <= shards; i++) assert(cases.some(c => c.shard === i), `shard ${i} has no case`);
}
export function verifyReports(inventory, inventorySha256, reports) {
  checkShards(inventory);
  const problems = [];
  const same = ['format', 'platform', 'node', 'sourceRevision', 'sourceBefore', 'workingTreeDiffSha256', 'inventorySha256'];
  for (const r of reports) {
    for (const k of same) if (r[k] !== reports[0][k]) problems.push(`shard ${r.shard}: ${k} differs from shard ${reports[0].shard}`);
    if (r.cli?.entrySha256 !== reports[0].cli?.entrySha256) problems.push(`shard ${r.shard}: CLI differs`);
    if (r.sourceBefore !== r.sourceAfter) problems.push(`shard ${r.shard}: source tree changed during qualification`);
    if (r.inventorySha256 !== inventorySha256) problems.push(`shard ${r.shard}: ran another inventory`);
    if (r.shards !== inventory.shards) problems.push(`shard ${r.shard}: expected ${inventory.shards} shards, ran with ${r.shards}`);
    for (const f of r.infrastructureFailures ?? []) problems.push(`shard ${r.shard}: ${f}`);
  }
  const shards = reports.map(r => r.shard).sort((a, b) => a - b);
  if (JSON.stringify(shards) !== JSON.stringify(Array.from({ length: inventory.shards }, (_, i) => i + 1))) problems.push(`shards reported ${JSON.stringify(shards)}, expected 1..${inventory.shards} once each`);
  const results = reports.flatMap(r => r.results ?? []);
  for (const c of inventory.cases) {
    const ran = results.filter(r => r.id === c.id);
    if (ran.length !== 1) problems.push(`${c.id}: reported ${ran.length} times`);
    else if (ran[0].status !== 'pass' || !ran[0].executed) problems.push(`${c.id}: ${ran[0].status}`);
  }
  for (const r of results) if (!inventory.cases.some(c => c.id === r.id)) problems.push(`${r.id}: not in the inventory`);
  return problems;
}
// Artifact downloads can put a single shard directly in the destination, or
// put each shard in its own child directory. Keep every report (including
// duplicates) so verifyReports still enforces the complete inventory.
export function readShardReports(dirs) {
  const reports = [];
  for (const dir of dirs) {
    const folder = resolve(dir);
    const paths = [join(folder, 'native-report.json'), ...readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => join(folder, entry.name, 'native-report.json'))];
    for (const path of paths) if (existsSync(path)) reports.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return reports;
}
function verifyMain(dirs) {
  const inventoryBytes = readFileSync(join(root, 'tools/native-inventory.json'));
  const reports = readShardReports(dirs);
  const problems = verifyReports(JSON.parse(inventoryBytes), digest(inventoryBytes), reports);
  for (const p of problems) console.error(p);
  console.log(JSON.stringify({ verified: !problems.length, shards: reports.length, cases: reports.reduce((n, r) => n + (r.results?.length ?? 0), 0) }));
  if (problems.length) process.exitCode = 1;
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--verify') return verifyMain(args.slice(1));
  if (args[0] === '--plan') { const inventory = JSON.parse(readFileSync(join(root, 'tools/native-inventory.json'))); checkShards(inventory); return void console.log(`shards=${JSON.stringify(Array.from({ length: inventory.shards }, (_, i) => i + 1))}`); }
  const at = args.indexOf('--shard');
  const shard = at < 0 ? null : Number(args[at + 1]);
  const positional = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const cli = inspectCli(process.env.IA_CORE_TEST_CLI);
  assert.match(process.versions.node, /^22\.22\./, 'required Node 22.22.x');
  const inventoryBytes = readFileSync(join(root, 'tools/native-inventory.json'));
  const inventory = JSON.parse(inventoryBytes);
  reconcile(inventory.cases, []);
  checkShards(inventory);
  if (shard !== null) assert(Number.isInteger(shard) && shard >= 1 && shard <= inventory.shards, `--shard must be 1..${inventory.shards}`);
  const cases = shard === null ? inventory.cases : inventory.cases.filter(c => c.shard === shard);
  process.env.IA_CORE_TEST_CLI = cli.entry;
  process.env.IA_GOVERNANCE_TEST_CLI = cli.entry;
  process.env.IA_CLI_PATH = cli.entry;
  process.env.IA_CORE_NO_NPX = '1';
  // Retained method snapshots go to a scratch store, never the operator's ~/.ia/method-closures-v1.
  const closures = mkdtempSync(join(tmpdir(), 'ia-native-closures-'));
  process.env.IA_CORE_CLOSURES_DIR = closures;
  process.on('exit', () => rmSync(closures, { recursive: true, force: true }));
  const output = resolve(positional[0] || join(root, '.qualification/native-results'));
  const sourceBefore = sourceSnapshot();
  mkdirSync(output, { recursive: true });
  const results = [], raw = [], infrastructureFailures = [];
  for (const file of [...new Set(cases.map(c => c.file))]) {
    if (!existsSync(join(root, file))) { infrastructureFailures.push(`missing test file: ${file}`); continue; }
    const names = cases.filter(c => c.file === file).map(c => c.name);
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    console.log(`native: ${file}`);
    for await (const event of run({ files: [join(root, file)], testNamePatterns: [`^(?:${escaped.join('|')})$`], concurrency: 1 })) {
      raw.push(JSON.stringify(event, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value));
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const data = event.data;
        if (names.includes(data.name)) {
          results.push({ file, name: data.name, status: event.type === 'test:pass' ? 'pass' : 'fail', skip: data.skip, todo: data.todo });
          console.log(`${event.type}: ${data.name}${data.skip ? ' SKIP' : ''}`);
        }
        else if (event.type === 'test:fail') infrastructureFailures.push(`${file}: ${data.name}`);
      }
    }
  }
  const sourceAfter = sourceSnapshot();
  if (sourceBefore !== sourceAfter) infrastructureFailures.push('source tree changed during qualification');
  const reconciled = reconcile(cases, results);
  const rawBytes = raw.join('\n') + '\n';
  writeFileSync(join(output, 'native-events.jsonl'), rawBytes);
  const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const plugins = ['ia'].map(name => ({ name, version: readJson(`plugins/${name}/.claude-plugin/plugin.json`).version }));
  const report = { format: 'inventarch.native-report/1', platform: process.platform, node: process.version, cli, shard, shards: inventory.shards ?? null,
    sourceBefore, sourceAfter, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDiffSha256: digest(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })),
    inventorySha256: digest(inventoryBytes), rawReportSha256: digest(rawBytes), language: 'inventarch/language 3.2.0', plugins,
    kits: readdirSync(join(root, 'plugins/ia/config/kits')).filter(name => existsSync(join(root, 'plugins/ia/config/kits', name, 'releases.json'))).map(name => ({ name, releases: readJson(`plugins/ia/config/kits/${name}/releases.json`) })), results: reconciled, infrastructureFailures,
    passed: reconciled.every(c => c.status === 'pass' && c.executed) && !infrastructureFailures.length };
  writeFileSync(join(output, 'native-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.results));
  if (!report.passed) process.exitCode = 1;
}
if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
