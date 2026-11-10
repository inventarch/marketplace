#!/usr/bin/env node
// The resolver: turns an entry point's activity into the packet an agent acts
// on, from the repository's bindings, the task's pin and the bound kit's
// records, read through `ia position` and `ia inspect`.
//   node scripts/resolve.mjs --entry <work|delivery|knowledge> --activity <activity>
//        [--subject <text>] [--seat <identity>] [--root <repo>] [--shape <H>] [--phase <P>]
//        [--project <p> --task <t> [--run <r>]] [--pin|--no-pin] [--rebind] [--cli <main.js>] [--json]
//        [--kit <kit> --capability <name> [--profile <name>]]   (outside an IA workspace only)
// Order: bindings (lib/binding.mjs) -> the task's pin (lib/pin.mjs) -> kit root
// (an isolated read root from the retained method bytes) -> `ia position --json` with the scope key the entry and
// activity state (lib/workspace.mjs SCOPE_KEYS; --shape and --phase override
// it) -> the capability's playbooks, checks and effects -> the instructions:
// the bound playbooks' cells the position delivers, or, for a whole-procedure
// activity (lib/workspace.mjs WHOLE_PROCEDURE), a capability the kit declares
// whole (its delivery.json) or when the position delivers none of them, every
// cell of each bound playbook read by identity (`ia inspect` for the
// structure, `ia read <playbook>#<phase>/<Primitive>` for each cell) -> packet
// (lib/packet.mjs). Exit 0 with the packet; 1 with { error: {
// code, message, candidates? } } on a refusal; 2 on bad usage. Output is
// always one JSON value.
import { realpathSync } from 'node:fs';
import { resolveCli, runIa } from './lib/cli.mjs';
import { readBindings, RENAMED, renamedMessage, selectBinding } from './lib/binding.mjs';
import { assertPinnedKit, findKit, implementationDigest, installedKit, kitBindings, kitChecks, kitDelivery, listKits, readRoot, requireKitInstalled, sourcesDigest } from './lib/kit.mjs';
import { assemblePacket } from './lib/packet.mjs';
import { closureStore } from './lib/home.mjs';
import { kitUpdate, PinError, pinRootFor, readPin, writePin } from './lib/pin.mjs';
import { retainKit, retainedKit } from './lib/retained.mjs';
import { identityOf } from './lib/records.mjs';
import { resolveQualifiedMethod } from './lib/qualified-resolve.mjs';
import { findWorkspace, isWholeProcedure, parseArgs, PHASES, printJson, refuse, scopeKey, UsageError } from './lib/workspace.mjs';

export const RESOLVER = 'inventarch/resolve 0.1.0';
const SPEC = { entry: 'value', activity: 'value', subject: 'value', seat: 'value', root: 'value', shape: 'value', phase: 'value', project: 'value', task: 'value', run: 'value', pin: 'flag', 'no-pin': 'flag', rebind: 'flag', cli: 'value', json: 'flag', host: 'value', kit: 'value', capability: 'value', profile: 'value', qualified: 'flag', qualification: 'value', 'preview-rebind': 'flag' };

class ResolveError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// A record's section field as plain values: text for strings and scalars,
// ref names for refs, lists of those for lists.
function field(record, section, key) {
  const value = record?.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
  const plain = v => (v?.kind === 'ref' ? v.name : v?.text ?? null);
  if (!value) return undefined;
  return value.kind === 'list' ? (value.items ?? []).map(plain) : plain(value);
}

// The repository's binding for the key. When none answers, the refusal also
// names the carried kits that recommend the key, and the command that shows
// and applies their recommendation; nothing is bound on the person's behalf.
function bound(workspaceRoot, entry, activity) {
  try { return selectBinding(readBindings(workspaceRoot), entry, activity); } catch (error) {
    if (error.code !== 'IA-CORE-NO-METHOD') throw error;
    const key = `${entry}.${activity}`, wildcard = `${entry}.*`;
    // A kit folder that cannot be read never replaces the refusal itself.
    let kits = [];
    try { kits = listKits(); } catch { /* the plain refusal stands */ }
    const recommending = kits.flatMap(k => {
      let recommend;
      try { ({ recommend } = kitBindings(k)); } catch { return []; }
      const hit = recommend[key] ?? recommend[wildcard];
      return hit ? [{ kit: k.id, capability: hit.capability, key: recommend[key] ? key : wildcard }] : [];
    });
    if (recommending.length) {
      error.message += `. Carried kits recommend it: ${recommending.map(r => `${r.kit} (${r.key} -> ${r.capability})`).join(', ')}; bind.mjs recommend <kit> shows a kit's keys and --apply writes the ones this repository does not bind yet`;
      error.candidates = recommending;
    }
    throw error;
  }
}

function inspect(kitRoot, identity, cli, extra = []) {
  const ran = runIa(kitRoot, ['inspect', identity, ...extra], { cli });
  if (ran.code !== 0 || ran.json?.ok === false) return null;
  return ran.json ?? null;
}

// Every cell of each playbook, read by identity at the kit root: the phases in
// PHASES order (orient, plan, act, learn) and, within a phase, the primitives
// in the order the playbook declares them (`ia inspect` lists its cells in
// declaration order); each cell's text and digest from
// `ia read <playbook>#<phase>/<Primitive>`. A playbook or cell that cannot be
// read refuses the packet, never replaced by another playbook's cells.
function playbookCells(kitRoot, playbooks, cli) {
  const cells = [];
  for (const playbook of playbooks) {
    const record = inspect(kitRoot, playbook, cli)?.records?.find(r => r.identity === playbook);
    if (!record) throw new ResolveError(`required playbook ${playbook} is not admitted at ${kitRoot}`, 'IA-CORE-COMPOSITION-MISSING');
    const declared = Array.isArray(record.cells) ? record.cells : [];
    if (!declared.length) throw new ResolveError(`required playbook ${playbook} declares no cell`, 'IA-CORE-COMPOSITION-MISSING');
    for (const phase of PHASES) {
      for (const cell of declared.filter(c => c.phase === phase)) {
        const address = `${playbook}#${cell.phase}/${cell.primitive}`;
        const read = runIa(kitRoot, ['read', address], { cli });
        if (read.code !== 0 || typeof read.json?.body !== 'string') {
          throw new ResolveError(`required cell ${address} could not be read: ${read.json?.message ?? (read.stderr.trim() || `exit ${read.code}`)}`, 'IA-CORE-COMPOSITION-MISSING');
        }
        cells.push({ playbook, address, text: read.json.body, digest: read.json.digest ?? null, source: 'playbook' });
      }
    }
  }
  return cells;
}

async function main() {
  const started = Date.now();
  const { options } = parseArgs(process.argv.slice(2), SPEC);
  if (!options.entry || !options.activity) throw new UsageError('resolve.mjs needs --entry <work|delivery|knowledge> and --activity <activity>');
  if (RENAMED[options.entry]) throw new UsageError(renamedMessage(options.entry));
  if (options.pin && options['no-pin']) throw new UsageError('--pin and --no-pin exclude each other');
  if ((options.qualification || options['preview-rebind']) && !options.qualified) throw new UsageError('--qualification and --preview-rebind require --qualified');
  if (options['preview-rebind'] && !options.rebind) throw new UsageError('--preview-rebind requires --rebind');
  // What the packet lacks or the host cannot enforce; every entry has a kind and a message.
  const missing = [];
  const note = (message, extra = {}) => missing.push({ kind: 'note', message, ...extra });

  // 1. The workspace, its bindings and the one binding for this key. Outside
  // an IA workspace, --kit and --capability name the method directly (an
  // unbound resolve): the kit's
  // restored root answers, nothing is pinned. Inside one, the repository's
  // bindings choose, and --kit is refused.
  const unbound = options.kit !== undefined || options.capability !== undefined || options.profile !== undefined;
  if (unbound && (!options.kit || !options.capability)) throw new UsageError('--kit and --capability go together (--profile is optional)');
  const pinRoot = pinRootFor({ project: options.project, task: options.task, run: options.run });
  if (options.pin && !pinRoot) throw new UsageError('--pin needs a task folder: IA_CORE_RUN_ROOT, or --project and --task');
  const startRoot = options.root ?? realpathSync.native(process.cwd());
  const workspaceRoot = findWorkspace(startRoot);
  if (!workspaceRoot && !unbound) throw new ResolveError(`${startRoot} is not inside an IA workspace (no .ia/src at or above it); a capability its kit resolves outside one (kit.mjs list: its unbound list, or any when the kit declares none) resolves with --kit <kit> --capability <capability>`, 'IA-CORE-NO-WORKSPACE');
  if (workspaceRoot && unbound) throw new ResolveError(`${workspaceRoot} is an IA workspace, and its .ia/bindings.json chooses the method: bind the kit there (bind.mjs set ${options.entry}.${options.activity} ${options.kit} ${options.capability}, or bind.mjs recommend ${options.kit} --apply for the keys it recommends) instead of naming it with --kit`, 'IA-CORE-UNBOUND-IN-WORKSPACE');
  const activityKey = `${options.entry}.${options.activity}`;
  const binding = unbound ? { kit: options.kit, capability: options.capability, ...(options.profile ? { profile: options.profile } : {}), key: activityKey, via: 'unbound' } : bound(workspaceRoot, options.entry, options.activity);
  // A bound key runs only a kit the repository's own lock installs, whatever copy of the kit is carried, held in the IA
  // home or retained by a pin. The refusal comes before the qualified route, before the CLI is resolved and before
  // anything is retained or written. The unbound route (outside a workspace, --kit with --capability) has no lock.
  if (!unbound) requireKitInstalled(workspaceRoot, { id: binding.kit });
  if (options.qualified) {
    const cli = resolveCli(workspaceRoot ?? startRoot, { cliPath: options.cli, allowNpx: false });
    printJson(await resolveQualifiedMethod({ binding, activityKey, workspaceRoot, cli, pinRoot, options, storeRoot: closureStore() }));
    return;
  }
  if (unbound) {
    // A kit that lists what it resolves outside a workspace refuses the rest
    //; one that lists nothing
    // resolves any capability, as before kits declared it.
    const declared = kitBindings(findKit(binding.kit)).unbound;
    if (declared && !declared.includes(binding.capability)) throw new ResolveError(`${binding.kit} does not resolve ${binding.capability} outside an IA workspace; it declares ${declared.length ? declared.join(', ') : 'none'} (its bindings.json unbound list). Resolve it from an IA workspace that binds it`, 'IA-CORE-UNBOUND-UNDECLARED');
  }

  // 2. The task's pin, when a task folder is known: one entry per activity key.
  if (unbound && pinRoot) note('not pinned: an unbound resolve has no workspace to pin the task to', { kind: 'pin' });
  const pin = unbound ? null : readPin(pinRoot, workspaceRoot);
  // Renaming a binding must not silently discard an existing task capability.
  // Legacy keys are migrated only by an explicit, persisted rebind.
  const legacyKey = options.entry === 'delivery' ? `development.${options.activity}` : null;
  const legacyPin = legacyKey && Object.hasOwn(pin?.keys ?? {}, legacyKey);
  if (legacyPin && (!options.rebind || options['no-pin'])) throw new PinError(`the task pins ${legacyKey} (revision ${pin.revision}); pass --rebind without --no-pin to replace it with ${activityKey} in a new revision`, 'IA-CORE-REBIND-REQUIRED', { key: legacyKey });

  // 3. The kit: what the plugin carries, what the repository installed, what
  // the task pinned. A key the task pinned keeps its kit version and
  // capability; a key it has not resolved yet joins the pin, at the version the
  // task already holds for that kit (one version per kit per task) or else
  // the available one; a changed binding for a pinned key, or another kit
  // than the key's, needs --rebind, which moves that key and its kit's version.
  const keyPin = pin?.keys?.[activityKey] ?? null;
  const savedKit = pin?.kits?.[binding.kit] ?? null;
  let carried;
  try { carried = findKit(binding.kit); } catch (error) { if (!savedKit?.retained || options.rebind) throw error; }
  const kit = savedKit?.retained && !options.rebind ? retainedKit(savedKit.retained) : retainKit(carried);
  const installed = workspaceRoot ? installedKit(workspaceRoot, kit.id) : null;
  const available = carried ? { version: carried.latest?.version ?? carried.version ?? null, archive: carried.latest?.archive ?? null } : { version: kit.latest?.version, archive: kit.latest?.archive };
  const sources = sourcesDigest(kit.dir);
  const kitPin = pin?.kits?.[kit.id] ?? null;
  let effective, rebound = false, pinChange = !pin;
  if (keyPin && !options.rebind) {
    if (keyPin.kit !== kit.id || keyPin.capability !== binding.capability || (keyPin.profile ?? null) !== (binding.profile ?? null)) throw new PinError(`the task pins ${activityKey} to ${keyPin.kit}#${keyPin.capability} (revision ${pin.revision}), and the repository now binds it to ${kit.id}#${binding.capability}: pass --rebind to write a new revision, or keep the pin`, 'IA-CORE-REBIND-REQUIRED', { key: activityKey });
    effective = { kit: { id: kit.id, version: kitPin.version, archive: kitPin.archive ?? null, sources: kitPin.sources ?? null, implementation: kitPin.implementation ?? null, retained: kitPin.retained ?? null }, capability: keyPin.capability };
  } else if (kitPin && !options.rebind) {
    effective = { kit: { id: kit.id, version: kitPin.version, archive: kitPin.archive ?? null, sources: kitPin.sources ?? null, implementation: kitPin.implementation ?? null, retained: kitPin.retained ?? null }, capability: binding.capability };
    pinChange = true;
  } else {
    effective = { kit: { id: kit.id, version: kit.latest?.version ?? kit.version, archive: kit.latest?.archive ?? null, sources, implementation: implementationDigest(kit), retained: kit.retained }, capability: binding.capability };
    rebound = Boolean(pin && options.rebind);
    pinChange = true;
  }
  const update = kitPin && !options.rebind ? kitUpdate(kitPin, available) : null;
  if (update) note(`kit ${kit.id} ${update.available.version} is available; the task stays pinned to ${update.pinned.version} (pass --rebind to move)`, { kind: 'kit-update' });
  if (effective.kit.version !== available.version) note(`the records readable now are kit ${kit.id} ${available.version}, not the pinned ${effective.kit.version}`, { kind: 'kit-version' });

  assertPinnedKit(kit, effective.kit);

  // 4. The kit root and the position.
  const cli = resolveCli(workspaceRoot ?? startRoot, { cliPath: options.cli });
  const kitRoot = readRoot(kit, { cli });
  const key = scopeKey(options.entry, options.activity, { shape: options.shape, phase: options.phase });
  const positionArgs = ['position', '--shape', key.shape, '--phase', key.phase];
  if (options.seat) note(`--seat ${options.seat} selects the consumer's position${installed ? ', whose laws and mandates the packet carries' : ' for scope only; the laws come from the kit'}; method instructions come from the isolated kit`, { kind: 'seat' });
  const refusal = ran => `ia position refused: ${ran.json?.message ?? (ran.stderr.trim() || 'no output')}${ran.json?.next ? ` (next: ${ran.json.next})` : ''}`;
  const position = runIa(kitRoot, positionArgs, { cli });
  if (!position.json?.ok || !position.json.body) throw new ResolveError(refusal(position), 'IA-CORE-POSITION');
  const body = position.json.body;
  // The consumer's position at the seat. In an adopted repository it carries the
  // governance (laws, seat mandates), so its refusal (IA's restore hint in an
  // unrestored clone) refuses the packet; elsewhere it is context only.
  const subjectPosition = workspaceRoot ? runIa(workspaceRoot, [...positionArgs, ...(options.seat ? ['--seat', options.seat] : [])], { cli }) : null;
  const subjectOk = Boolean(subjectPosition && subjectPosition.code === 0 && subjectPosition.json?.ok && subjectPosition.json.body);
  if (subjectPosition && !subjectOk && installed) throw new ResolveError(refusal(subjectPosition), 'IA-CORE-POSITION');
  if (subjectPosition && !subjectOk) note(`the repository's own position is unavailable, so scope comes from the kit: ${refusal(subjectPosition)}`, { kind: 'position' });
  const subjectBody = subjectOk ? subjectPosition.json.body : body;
  const governance = installed ? subjectBody : body;

  // 5. The capability: playbooks, checks, effects and the profile that composes it.
  const capabilityId = identityOf('capability', effective.capability);
  const cap = inspect(kitRoot, capabilityId, cli)?.records?.find(r => r.identity === capabilityId) ?? null;
  if (!cap) throw new ResolveError(`capability record ${capabilityId} is not admitted at ${kitRoot}`, 'IA-CORE-CAPABILITY-UNAVAILABLE');
  const playbooks = (field(cap, 'composition', 'playbooks') ?? []).map(n => identityOf('playbook', n));
  const checkNames = field(cap, 'composition', 'checks') ?? [];
  const effects = field(cap, 'execution', 'effects') ?? [];
  let profileId = binding.profile ? identityOf('agent-profile', binding.profile) : null;
  if (!profileId && cap) {
    const inboundResult = inspect(kitRoot, capabilityId, cli, ['--edges', 'in']);
    if (!inboundResult) throw new ResolveError(`profile composition of ${capabilityId} could not be inspected`, 'IA-CORE-COMPOSITION-MISSING');
    const inbound = inboundResult.directed ?? [];
    const profiles = [...new Set(inbound.filter(d => d.field === 'composition.capabilities' && /\/agent-profile\//.test(d.declaredOn ?? d.identity ?? '')).map(d => d.declaredOn ?? d.identity))];
    if (profiles.length === 1) profileId = profiles[0];
    else if (profiles.length > 1) throw new ResolveError(`${profiles.length} agent-profiles compose ${capabilityId}; name one in the binding: ${profiles.join(', ')}`, 'IA-CORE-PROFILE-AMBIGUOUS');
  }
  const profile = profileId ? inspect(kitRoot, profileId, cli)?.records?.find(r => r.identity === profileId) ?? null : null;
  if (profileId && !profile) throw new ResolveError(`required agent-profile ${profileId} is not admitted at ${kitRoot}`, 'IA-CORE-COMPOSITION-MISSING');
  // The role's own mandate: the moves the profile runs under, which the
  // position's seat mandates do not carry.
  const mandateName = profile ? field(profile, 'composition', 'mandate') : null;
  const mandateId = mandateName ? identityOf('mandate', mandateName) : null;
  const mandate = mandateId ? inspect(kitRoot, mandateId, cli)?.records?.find(r => r.identity === mandateId) ?? null : null;
  if (mandateId && !mandate) throw new ResolveError(`required mandate ${mandateId} of ${profileId} is not admitted at ${kitRoot}`, 'IA-CORE-COMPOSITION-MISSING');
  const briefParts = [profile && field(profile, 'meaning', 'says'), cap && field(cap, 'meaning', 'says')].filter(Boolean);
  const role = { profile: profile ? profileId : null, brief: briefParts.length ? briefParts.join('\n\n') : null };
  if (!role.brief) note('no role brief: neither an agent-profile nor the capability states one', { kind: 'role' });

  // 6. Instructions: the bound playbooks' cells the position delivers at this
  // scope key (source 'position'); for a whole-procedure activity, a capability
  // the kit declares whole, or when the
  // position delivers none of them, every cell of each bound playbook read by
  // identity (source 'playbook').
  // Another capability's cells are never delivered as the procedure. Then the
  // references from the position, the role's mandate, and the checks the runner
  // may run.
  const delivery = kitDelivery(kit);
  if (delivery.undeclared.length) note(`delivery.json names capabilities that are not @capability records of the kit: ${delivery.undeclared.join(', ')}`, { kind: 'delivery' });
  const whole = isWholeProcedure(options.entry, options.activity) || delivery.whole.includes(effective.capability);
  let cells = (body.cells ?? []).map(c => ({ playbook: c.playbook, address: c.address, text: c.text, source: 'position' }));
  if (playbooks.length) {
    const completeCells = playbookCells(kitRoot, playbooks, cli);
    const own = cells.filter(c => playbooks.includes(c.playbook));
    cells = whole || !own.length ? completeCells : own;
    if (!cells.length) note(`no cell of the capability's playbooks (${playbooks.join(', ')}) could be read at ${kitRoot}`, { kind: 'instructions' });
  } else if (checkNames.length) {
    // A native check-only capability is executable through its required fixed
    // runners. It has no playbook instructions; never inherit position cells.
    cells = [];
  } else {
    throw new ResolveError('the capability declares neither playbooks nor checks; inspection-only execution is not supported by this packet contract', 'IA-CORE-COMPOSITION-MISSING');
  }
  const ref = (r, when) => ({ identity: r.identity, digest: r.digest ?? null, when });
  const references = [...(governance.rules ?? []).map(r => ref(r, 'always')), ...(governance.mandates ?? []).map(r => ref(r, 'seat')), ...(mandate ? [ref(mandate, 'role')] : []), ...(body.loaded ?? []).filter(r => r.hop > 0).slice(0, 32).map(r => ref(r, 'as-needed'))];
  const { checks: runnerChecks, undeclared } = kitChecks(kit);
  if (undeclared.length) note(`checks.json names checks that are not @check records of the kit: ${undeclared.join(', ')}`, { kind: 'checks' });
  const evaluators = {};
  for (const name of checkNames) {
    const record = inspect(kitRoot, identityOf('check', name), cli)?.records?.find(r => r.identity === identityOf('check', name));
    if (!record) throw new ResolveError(`required check record ${name} is not admitted`, 'IA-CORE-CHECK-UNAVAILABLE');
    evaluators[name] = field(record, 'check', 'runs') ?? null;
  }
  // A composed check whose record runs an IA evaluator other than COMP-CHECK
  // (COMP-COVERAGE) is IA-evaluated: ia validate gives its verdict, so it needs
  // no runner and stays required. A COMP-CHECK the kit gives no runner is
  // host-run (a kit README may document it as not runnable here): it stays
  // required and is reported unavailable. A capability none of whose runnable
  // checks the runner can run refuses; IA-evaluated checks do not count.
  const iaEvaluated = checkNames.filter(name => !Object.hasOwn(runnerChecks, name) && evaluators[name] && evaluators[name] !== 'COMP-CHECK');
  for (const name of iaEvaluated) missing.push({ kind: 'ia-evaluated', check: name, runs: evaluators[name], message: `required check ${name} runs ${evaluators[name]}: ia validate evaluates it, not scripts/check.mjs, so its evidence is the ia validate verdict` });
  const hostRun = checkNames.filter(name => !Object.hasOwn(runnerChecks, name) && !iaEvaluated.includes(name));
  if (hostRun.length && hostRun.length === checkNames.length - iaEvaluated.length) throw new ResolveError(`required check${hostRun.length === 1 ? '' : 's'} ${hostRun.join(', ')} ha${hostRun.length === 1 ? 's' : 've'} no declared runner`, 'IA-CORE-CHECK-UNAVAILABLE');
  for (const name of hostRun) missing.push({ kind: 'check-unavailable', check: name, message: `required check ${name} has no runner in the kit's checks.json: scripts/check.mjs cannot run it, so its evidence is host-run and stays unverified until the host reports it` });
  const runner = [...new Set([...checkNames, ...Object.keys(runnerChecks)])].sort();
  // A capability that composes checks requires the checker restriction. No host
  // enforces it from a tools allowlist (an allowlist cannot carry a Bash
  // pattern), so the packet says so rather than letting equal content imply
  // equal permissions: the mechanical restriction is scripts/check.mjs.
  if (checkNames.length && process.env.IA_CORE_HOST_ENFORCES_CHECKS !== '1') {
    missing.push({ kind: 'enforcement', requirement: 'constrained-checks', via: 'scripts/check.mjs', checks: [...checkNames].sort(), message: `the capability requires that checks run only as ${checkNames.join(', ')}; this host does not enforce it, so run them only through node scripts/check.mjs <check-name> (the checker agent is restricted to it)` });
  }
  const records = [...new Set([capabilityId, ...playbooks, ...(profile ? [profileId] : []), ...(mandate ? [mandateId] : []), ...runner.map(n => identityOf('check', n))])];

  // 7. The packet, then the pin.
  const scope = { entry: options.entry, activity: options.activity, subject: options.subject ?? null, key: body.key, seat: subjectBody.seat?.identity ?? null, word: null, mapped: key.mapped, workspace: workspaceRoot ? { root: workspaceRoot, revision: subjectBody.revision } : null };
  const packet = assemblePacket({
    resolver: RESOLVER,
    binding: null,
    closure: { kit: effective.kit.id, version: effective.kit.version, archive: effective.kit.archive, sources: effective.kit.sources, implementation: effective.kit.implementation, retained: effective.kit.retained, records },
    scope, instructions: cells, references, role, requestedOperations: effects, runner, required: [...checkNames].sort(), missing,
    kitUpdateAvailable: update,
    envelope: { host: options.host ?? process.env.IA_CORE_HOST ?? (process.env.CLAUDE_PLUGIN_ROOT ? 'claude-code' : 'unknown'), cliVersion: cli.version ?? null, cliSource: cli.source, kitRoot, kitInstalled: Boolean(installed), run: options.run ?? null, latencyMs: 0 },
  });
  let written = pin ?? null;
  if (pinRoot && !unbound && !options['no-pin'] && (pinChange || options.rebind)) {
    const { version, archive, sources: pinnedSources, implementation, retained } = effective.kit;
    const retainedKeys = { ...(pin?.keys ?? {}) };
    if (legacyPin) delete retainedKeys[legacyKey];
    written = writePin(pinRoot, {
      workspace: { root: workspaceRoot, revision: subjectBody.revision }, task: options.task ?? pin?.task ?? null,
      kits: { ...(pin?.kits ?? {}), [kit.id]: { version, archive, sources: pinnedSources, implementation, retained } },
      keys: { ...retainedKeys, [activityKey]: { kit: kit.id, capability: effective.capability, profile: binding.profile ?? null, records, scopeKey: { shape: body.key.shape, phase: body.key.phase, seat: scope.seat, word: null }, intent: { entry: options.entry, activity: options.activity, subject: options.subject ?? null } } },
    }, pin ?? undefined);
  }
  packet.binding = {
    key: binding.key, via: binding.via, kit: binding.kit, capability: binding.capability,
    revision: written ? written.revision : null, supersedes: written ? written.supersedes ?? null : null,
    pin: written ? { root: pinRoot, path: written.path, key: activityKey } : null, run: options.run ?? null, rebound: rebound && Boolean(written),
  };
  packet.envelope.latencyMs = Date.now() - started;
  printJson(packet);
}

try { await main(); } catch (error) { process.exit(refuse(error)); }

