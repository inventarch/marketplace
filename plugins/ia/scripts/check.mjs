#!/usr/bin/env node
// The checker runner: runs one @check the bound or pinned kit declares, with
// the fixed argv its kit's checks.json gives it, and nothing else. This is the
// mechanical restriction behind the checker agent: an agent's tools allowlist
// cannot carry a Bash pattern, so the agent is told to run only this script,
// and this script runs only declared checks.
//   node scripts/check.mjs <check-name> [--root <repo>] [--kit <id>] [--project <p> --task <t>] [--cli <main.js>]
// Which kit: --kit; else the task's pin (IA_CORE_RUN_ROOT, or --project and
// --task); else every kit the repository's .ia/bindings.json names; else the
// kits installed in the repository that this plugin carries. The first kit
// that declares the check runs it. argv tokens: ${IA} (the resolved CLI,
// several argv words), ${NODE}, ${WORKSPACE}, ${KIT} (the kit's sources),
// ${PLUGIN}. cwd: "workspace" (default), "kit" or "plugin". An entry may also
// carry "timeout", a positive integer of seconds (default 600), for long
// budgeted runs. ${ARG:manifest} is a whole data slot declared as
// arguments: { manifest: "workspace-file" }, filled by --manifest. No shell.
// The check's environment carries IA_CORE_CHECK (its name) and, when --cli is
// given, IA_CLI_PATH, so a script that resolves the CLI itself uses the same one.
// Only a kit lib/trust.mjs trusts runs a check (decision public-kit-trust):
// another kit's check is refused with IA-CORE-KIT-UNTRUSTED and runs nothing.
// Every child gets lib/hygiene.mjs's allowlisted environment, not the whole
// of this process's; the check's process tree is killed on its deadline and
// its output is bounded (lib/check-output.mjs keeps it as evidence, up to its
// own limit).
// Prints { check, kit, record, argv, exitCode, stdout, stderr, durationMs,
// output, timedOut, outputLimitExceeded, terminationFailed, qualification }.
// stdout/stderr remain tails; output retains bounded full logs and digests.
// Exit 0 only for complete execution with exit 0, 3 when it exits
// otherwise, 1 on a refusal (IA-CORE-CHECK-UNKNOWN for an undeclared check),
// 2 on bad usage.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCli } from './lib/cli.mjs';
import { childEnv } from './lib/hygiene.mjs';
import { kitTrust } from './lib/trust.mjs';
import { checkArguments } from './lib/check-arguments.mjs';
import { readBindings, selectBinding } from './lib/binding.mjs';
import { assertPinnedKit, canonicalKitId, findKit, installedKits, kitChecks, listKits, requireKitInstalled } from './lib/kit.mjs';
import { retainedKit } from './lib/retained.mjs';
import { closureStore } from './lib/home.mjs';
import { pinRootFor, readPin } from './lib/pin.mjs';
import { runMethodCheck } from './lib/method-check.mjs';
import { readMethodPin } from './lib/method-pin.mjs';
import { runOrdinaryCheck } from './lib/check-output.mjs';
import { findWorkspace, parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]*$/;

class CheckError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// The kit ids a repository's bindings name, keys and defaults alike.
const boundKitIds = bindings => (bindings ? [...new Set([...Object.values(bindings.bindings).flat(), ...Object.values(bindings.defaults)].map(b => canonicalKitId(b.kit)))] : []);

// A repository-bound method runs a kit only while the repository's own lock installs it (lib/kit.mjs
// requireKitInstalled, the one guard resolve.mjs and every route here share). It comes before any kit is retained,
// trusted or run. A kit the task pin or the bindings do not name stays the plugin-only route, which needs no row.
function candidateKits(options, workspaceRoot) {
  const pin = readPin(pinRootFor({ project: options.project, task: options.task }), workspaceRoot);
  if (pin) {
    const ids = options.kit ? [Object.hasOwn(pin.kits, options.kit) ? options.kit : findKit(options.kit).id] : Object.keys(pin.kits);
    const bound = boundKitIds(readBindings(workspaceRoot));
    for (const id of ids) if (Object.hasOwn(pin.kits, id) || bound.includes(id)) requireKitInstalled(workspaceRoot, { id });
    const kits = ids.map(id => {
      const saved = pin.kits[id];
      if (!saved?.retained) throw new CheckError(`kit ${id} has no retained implementation in this pin; explicitly rebind`, 'IA-CORE-PIN-UNAVAILABLE');
      const kit = retainedKit(saved.retained);
      if (kit.id !== id) throw new CheckError('retained kit identity differs from pin', 'IA-CORE-CLOSURE-INTEGRITY');
      assertPinnedKit(kit, saved);
      return kit;
    });
    return { kits, via: `pin revision ${pin.revision}` };
  }
  const bindings = readBindings(workspaceRoot);
  if (options.kit) {
    const kit = findKit(options.kit);
    if (boundKitIds(bindings).includes(kit.id)) requireKitInstalled(workspaceRoot, { id: kit.id });
    return { kits: [kit], via: 'option' };
  }
  if (bindings) {
    const carried = listKits().map(k => k.id);
    const ids = boundKitIds(bindings).filter(id => carried.includes(id));
    // Every carried kit the bindings name, not only the one that declares the check: running none of them would read as no kit being bound.
    for (const id of ids) requireKitInstalled(workspaceRoot, { id });
    return { kits: ids.map(id => findKit(id)), via: 'bindings' };
  }
  const carried = listKits();
  return { kits: installedKits(workspaceRoot).map(p => carried.find(k => k.id === p.id)).filter(Boolean), via: 'installed' };
}

// The kit a qualified check's activity key names: the task's format 4 pin when it holds the key, else the
// repository's binding for it. Null when neither names one, which leaves the qualified run to its own refusal.
function qualifiedKit(activityKey, pinRoot, workspaceRoot) {
  try {
    const named = readMethodPin(pinRoot)?.keys?.[activityKey]?.kit;
    if (named) return named;
  } catch { /* an unreadable pin is the qualified run's refusal to give */ }
  const [entry, ...activity] = activityKey.split('.');
  try { return selectBinding(readBindings(workspaceRoot), entry, activity.join('.')).kit; } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.filter(a => a === '--manifest' || a.startsWith('--manifest=')).length > 1) throw new UsageError('--manifest may be given only once');
  const { options, rest } = parseArgs(args, { root: 'value', kit: 'value', project: 'value', task: 'value', cli: 'value', manifest: 'value', 'qualified-input': 'value', activity: 'value' }, { positionals: 1 });
  const name = rest[0];
  if (!name || !NAME.test(name)) throw new UsageError('check.mjs needs one <check-name> (lowercase letters, digits and hyphens)');
  const workspaceRoot = findWorkspace(options.root ?? realpathSync.native(process.cwd()));
  if (!workspaceRoot) throw new CheckError(`${options.root ?? process.cwd()} is not inside an IA workspace (no .ia/src at or above it)`, 'IA-CORE-NO-WORKSPACE');
  if (options['qualified-input']) {
    const pinRoot = pinRootFor({ project: options.project, task: options.task });
    if (!pinRoot || !options.activity || options.kit || options.manifest) throw new UsageError('qualified checks need a task pin and --activity, without --kit or --manifest');
    const kitId = qualifiedKit(options.activity, pinRoot, workspaceRoot);
    if (kitId) requireKitInstalled(workspaceRoot, { id: kitId });
    const stat = lstatSync(options['qualified-input']);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new UsageError('qualified input must be bounded regular JSON');
    const input = JSON.parse(readFileSync(options['qualified-input'], 'utf8'));
    if (input.checkId !== name) throw new UsageError('check name differs from qualified input');
    const result = await runMethodCheck({ input, activityKey: options.activity, pinRoot, workspaceRoot, storeRoot: closureStore(), cli: resolveCli(workspaceRoot, { cliPath: options.cli, allowNpx: false }) });
    printJson(result);
    process.exit(result.receipt.exitCode === 0 && !result.receipt.timedOut && !result.receipt.outputLimitExceeded && !result.receipt.terminationFailed && !result.receipt.pinChanged && !result.receipt.subjectChanged ? 0 : 3);
  }
  if (options.activity) throw new UsageError('--activity requires --qualified-input');
  const { kits, via } = candidateKits(options, workspaceRoot);
  const declared = [];
  let found;
  for (const kit of kits) {
    const { checks } = kitChecks(kit);
    for (const id of Object.keys(checks)) declared.push(`${kit.id}#${id}`);
    // Own names only: a name every object inherits (constructor) is no declared check.
    if (!found && Object.hasOwn(checks, name)) found = { kit, spec: checks[name] };
  }
  if (!found) throw new CheckError(`${name} is not a check the ${via === 'option' ? 'named' : 'bound'} kit${kits.length === 1 ? '' : 's'} declare${kits.length === 1 ? 's' : ''} (${kits.map(k => k.id).join(', ') || 'no kit is bound, pinned or installed'}); declared checks: ${declared.join(', ') || 'none'}. The runner runs only declared @check records with their fixed argv`, 'IA-CORE-CHECK-UNKNOWN', { candidates: declared });
  const { kit, spec } = found;
  const trust = kitTrust(kit);
  if (!trust.trusted) throw new CheckError(`${name} is declared by ${kit.id}, whose code does not run here, because ${trust.reason}. Only kits from a trusted publisher whose bytes are their recorded release run checks (decision public-kit-trust)`, 'IA-CORE-KIT-UNTRUSTED', { kit: kit.id });
  // Execute the retained runner itself, so future core upgrades cannot change
  // argument validation or checker dispatch under an existing task pin.
  if (kit.pluginDir && realpathSync(kit.pluginDir) !== realpathSync(PLUGIN)) {
    const delegated = spawnSync(process.execPath, [join(kit.pluginDir, 'scripts', 'check.mjs'), ...args], { cwd: workspaceRoot, env: childEnv(process.env), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (delegated.error) throw new CheckError(`retained checker did not start: ${delegated.error.message}`, 'IA-CORE-CHECK-FAILED');
    process.stdout.write(delegated.stdout ?? '');
    process.stderr.write(delegated.stderr ?? '');
    process.exit(delegated.status ?? 3);
  }
  const argumentsByToken = checkArguments(spec, options, workspaceRoot);
  const plugin = kit.pluginDir ?? PLUGIN;
  const cwd = { workspace: workspaceRoot, kit: kit.dir, plugin }[spec.cwd];
  if (!cwd) throw new CheckError(`check ${name}: cwd must be workspace, kit or plugin, not ${spec.cwd}`, 'IA-CORE-CHECK-MALFORMED');
  const cli = spec.argv.some(a => a.includes('${IA}')) ? resolveCli(workspaceRoot, { cliPath: options.cli }) : null;
  const argv = spec.argv.flatMap(a => {
    if (Object.hasOwn(argumentsByToken, a)) return [argumentsByToken[a]];
    if (a === '${IA}') return cli.argv;
    const places = { NODE: process.execPath, WORKSPACE: workspaceRoot, KIT: kit.dir, PLUGIN: plugin };
    const substituted = a.replace(/\$\{(NODE|WORKSPACE|KIT|PLUGIN)\}/g, (_, name) => places[name]);
    return [substituted === a ? a : normalize(substituted)];
  });
  const started = Date.now();
  // A script the check runs that resolves its own CLI (lib/scratch.mjs) gets the --cli given here, as IA_CLI_PATH.
  const env = childEnv(process.env, { IA_CORE_CHECK: name, ...(options.cli ? { IA_CLI_PATH: resolve(options.cli) } : {}) });
  let ran;
  try { ran = await runOrdinaryCheck({ argv, cwd, timeoutSeconds: spec.timeout ?? 600, env }); }
  catch (error) { throw new CheckError(`check ${name} could not retain execution evidence: ${error.message}`, error.code === 'IA-CORE-CHECK-OUTPUT' ? error.code : 'IA-CORE-CHECK-FAILED'); }
  printJson({ check: name, kit: kit.id, retained: kit.retained ?? null, provenance: kit.retained ? 'retained-carried-bytes' : 'unretained', record: spec.record, argv, cwd, ...ran, durationMs: Date.now() - started });
  process.exit(ran.exitCode === 0 && ran.output.complete ? 0 : 3);
}

try { await main(); } catch (error) { process.exit(refuse(error)); }

