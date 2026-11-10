// Kit handlers (contract C2, decisions public-kit-handlers and
// public-kit-trust): a kit may ship handlers.json at its root,
//   { format: 1,
//     session: [ { run?: "scripts/<file>.mjs", context?: "<text>", events?: ["startup","resume","compact","clear"], timeout?: 20 } ],
//     prompt:  [ { run?, context?, timeout?: 10 } ],
//     tool:    [ { run?, context?, phase: "pre"|"post", match?: "Write|Edit|Bash", timeout?: 20 } ],
//     stop:    [ { run?, context?, timeout?: 20 } ] }
// and the core's hooks run them (scripts/handlers.mjs). Each entry carries a
// `run` script, a `context` text, or both. `context` is data: the core
// delivers it as additionalContext and starts no process. `run` is code: it
// runs only for a kit lib/trust.mjs trusts (a publisher on the plugin's list,
// bytes that are its recorded release) and only when its script is one of the
// kit's declared assets, so that digest covers it; otherwise it is skipped,
// and scripts/handlers.mjs says why once at session start. Only installed kits
// run: the kits the core can resolve (its own config/kits, then
// <IA home>/kits/<kit>/<version>/, lib/kit.mjs listKits) whose folder holds
// the script. A fetched release carries no executables, so its handlers never
// run. Each handler runs as `node <script>` with the host's hook JSON on stdin,
// the allowlisted environment of lib/hygiene.mjs plus IA_KIT_ROOT,
// IA_WORKSPACE_ROOT and IA_HOME, its process tree killed on its deadline and
// its output capped; its stdout is one JSON value
// { additionalContext?, decision?: "block"|"allow", reason? }. The core merges
// every handler's additionalContext, at most KIT_CONTEXT_CAP characters per
// kit. A tool `pre` handler's block is honoured only in a workspace that opted
// in through .ia/governance.json; elsewhere it is reported, never applied.
// There, a trusted pre handler that cannot decide refuses the call (fail
// closed), and so does an altered gate: while a kit from a trusted publisher
// declares a pre handler whose code the trust check refuses (its bytes are not
// its release, or its script is not a declared asset), every pre-tool call is
// refused, naming the kit and the fix (alteredGates). A kit from a publisher
// that is not on the list never blocks: its pre handler never runs. A kit's
// onwrite.json stays supported as tool post handlers (scripts/on-write.mjs).
// One more form of `run`: `${PLUGIN}/<entry>`, where <entry> is written out in
// PLUGIN_RUNS (today only scripts/method-advise.mjs), runs that script of the
// core itself, for a kit whose release carries no code. It is an allowlist of
// literal names, never a pattern; it is accepted on session and tool `post`
// handlers only and refused on tool `pre`, prompt and stop handlers (a plugin
// run is advisory, can never gate, and has nothing to say there); the script must be that very file in the
// plugin's scripts folder once links are followed; the kit must still be
// trusted; it gets no arguments; and it is skipped, before the trust check and
// before any process starts, when the call is not inside an IA workspace.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iaHome } from './home.mjs';
import { childEnv, runChild } from './hygiene.mjs';
import { KitError, listKits } from './kit.mjs';
import { coversScript, kitTrust } from './trust.mjs';

export const HANDLERS_FORMAT = 1;
export const SESSION_EVENTS = ['startup', 'resume', 'compact', 'clear'];
export const KIT_CONTEXT_CAP = 2000;
export const MAX_TIMEOUT = 25;
// The scripts of the core a kit's handlers.json may run, as `${PLUGIN}/<entry>`.
export const PLUGIN_RUNS = ['scripts/method-advise.mjs'];
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_TIMEOUT = { session: 20, prompt: 10, tool: 20, stop: 20 };
const KIT_SCRIPT = resolve(fileURLToPath(new URL('../kit.mjs', import.meta.url)));
const KINDS = Object.keys(DEFAULT_TIMEOUT);

const plainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

// The handlers a kit declares, checked: { session, prompt, tool, stop }, each a
// list of { run, context, timeout, ... } (run or context may be null, never
// both). Without handlers.json every list is empty.
export function kitHandlers(kit) {
  const path = join(kit.dir, 'handlers.json');
  const none = { session: [], prompt: [], tool: [], stop: [] };
  if (!existsSync(path)) return none;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new KitError(`${path} is not JSON: ${error.message}`); }
  if (!plainObject(parsed) || parsed.format !== HANDLERS_FORMAT) throw new KitError(`${path} is malformed (format ${HANDLERS_FORMAT} with session, prompt, tool and stop lists)`);
  const unknown = Object.keys(parsed).filter(k => k !== 'format' && !KINDS.includes(k));
  if (unknown.length) throw new KitError(`${path}: unknown key ${unknown.join(', ')} (handlers are session, prompt, tool and stop)`);
  const root = resolve(kit.dir);
  const result = { ...none };
  for (const kind of KINDS) {
    if (parsed[kind] === undefined) continue;
    if (!Array.isArray(parsed[kind])) throw new KitError(`${path}: ${kind} is a list`);
    result[kind] = parsed[kind].map((entry, i) => {
      const where = `${path}: ${kind}[${i}]`;
      if (!plainObject(entry)) throw new KitError(`${where} is an object`);
      if (entry.run === undefined && entry.context === undefined) throw new KitError(`${where} needs a run script, a context text, or both`);
      let rel = null, plugin = null;
      if (typeof entry.run === 'string' && entry.run.startsWith('${PLUGIN}')) {
        const named = PLUGIN_RUNS.find(name => entry.run === `\${PLUGIN}/${name}`);
        if (!named) throw new KitError(`${where}: a \${PLUGIN} run is one of ${PLUGIN_RUNS.map(name => `\${PLUGIN}/${name}`).join(', ')}, written out in full`);
        if (kind === 'prompt' || kind === 'stop') throw new KitError(`${where}: a \${PLUGIN} run is advisory and runs only on session and tool post handlers, never on ${kind}`);
        plugin = named;
      } else if (entry.run !== undefined) {
        const run = entry.run;
        if (typeof run === 'string' && run.includes('${')) throw new KitError(`${where}: run takes no placeholder; only a \${PLUGIN} run of the core's own allowlisted script is written that way`);
        rel = typeof run === 'string' ? relative(root, resolve(root, run)).replace(/\\/g, '/') : '';
        if (typeof run !== 'string' || !/\.mjs$/.test(run) || isAbsolute(run) || /^[A-Za-z]:/.test(run) || rel === '' || rel.startsWith('../') || rel === '..') throw new KitError(`${where}: run is a .mjs script inside the kit, such as scripts/<file>.mjs`);
      }
      if (entry.context !== undefined && !(typeof entry.context === 'string' && entry.context.trim() && entry.context.length <= KIT_CONTEXT_CAP)) throw new KitError(`${where}: context is a non-empty text of at most ${KIT_CONTEXT_CAP} characters`);
      if (entry.timeout !== undefined && !(Number.isInteger(entry.timeout) && entry.timeout > 0 && entry.timeout <= MAX_TIMEOUT)) throw new KitError(`${where}: timeout is a whole number of seconds from 1 to ${MAX_TIMEOUT}`);
      const handler = { run: rel, context: entry.context?.trim() ?? null, timeout: entry.timeout ?? DEFAULT_TIMEOUT[kind], ...(plugin ? { plugin } : {}) };
      const allowed = { session: ['run', 'context', 'timeout', 'events'], prompt: ['run', 'context', 'timeout'], tool: ['run', 'context', 'timeout', 'phase', 'match'], stop: ['run', 'context', 'timeout'] }[kind];
      const extra = Object.keys(entry).filter(k => !allowed.includes(k));
      if (extra.length) throw new KitError(`${where}: unknown key ${extra.join(', ')}`);
      if (kind === 'session') {
        if (entry.events !== undefined && !(Array.isArray(entry.events) && entry.events.length && entry.events.every(e => SESSION_EVENTS.includes(e)))) throw new KitError(`${where}: events is a non-empty list of ${SESSION_EVENTS.join(', ')}`);
        handler.events = entry.events ?? [...SESSION_EVENTS];
      }
      if (kind === 'tool') {
        if (entry.phase !== 'pre' && entry.phase !== 'post') throw new KitError(`${where}: phase is pre or post`);
        if (entry.match !== undefined) {
          if (typeof entry.match !== 'string' || !entry.match) throw new KitError(`${where}: match is a tool-name pattern such as Write|Edit|Bash`);
          try { new RegExp(`^(?:${entry.match})$`); } catch { throw new KitError(`${where}: match is not a valid pattern`); }
        }
        if (plugin && entry.phase === 'pre') throw new KitError(`${where}: a \${PLUGIN} run is advisory and is refused on a pre handler`);
        handler.phase = entry.phase;
        handler.match = entry.match ?? null;
      }
      return handler;
    });
  }
  return result;
}

// One kit's trust, computed once per found entry and only when asked: the
// sources digest is read only when a handler of that kit has code to run.
export function trustOf(found) {
  if (!found.trustResult) found.trustResult = kitTrust(found.kit);
  return found.trustResult;
}

// The kits whose handlers may run or speak: every installed kit (lib/kit.mjs
// listKits) that ships handlers.json, as [{ kit, handlers }]. A kit whose
// handlers.json is malformed is skipped and named in `skipped`, so a hook
// never fails because of one kit.
export function handlerKits({ kits } = {}) {
  let all = kits;
  if (!all) { try { all = listKits(); } catch { all = []; } }
  const found = [], skipped = [];
  for (const kit of all) {
    if (!existsSync(join(kit.dir, 'handlers.json'))) continue;
    try { found.push({ kit, handlers: kitHandlers(kit) }); } catch (error) { skipped.push({ kit: kit.id, error: error.message }); }
  }
  return { kits: found, skipped };
}

// A handler's script is present when it is a file inside its kit's folder once
// links are followed: a run path is checked inside the kit when it is read,
// and a link must not carry it out.
// A plugin run is present when the allowlisted script is that file of the core
// itself: its real path is the expected one, inside the plugin's scripts folder.
export function pluginScriptPresent(handler, pluginRoot = PLUGIN_ROOT) {
  if (!handler.plugin || !PLUGIN_RUNS.includes(handler.plugin)) return false;
  try {
    const scripts = realpathSync(join(pluginRoot, 'scripts'));
    const real = realpathSync(join(pluginRoot, handler.plugin));
    const rel = relative(scripts, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    if (real !== join(realpathSync(pluginRoot), handler.plugin)) return false;
    return statSync(real).isFile();
  } catch { return false; }
}

const scriptPresent = (kit, handler) => {
  if (handler.plugin) return pluginScriptPresent(handler);
  if (!handler.run) return false;
  try {
    const root = realpathSync(kit.dir);
    const path = realpathSync(join(kit.dir, handler.run));
    const rel = relative(root, path);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    return statSync(path).isFile();
  } catch { return false; }
};

// Why a handler's script does not run, or null when it runs.
function codeRefusal(found, handler) {
  const trust = trustOf(found);
  if (!trust.trusted) return trust.reason;
  // The sidecar that names a plugin run is covered by the kit's digest; the script is the core's own.
  if (handler.plugin) return null;
  if (!coversScript(found.kit, handler.run)) return `its handler script ${handler.run} is not a declared asset, so its recorded release does not cover it`;
  return null;
}

// The kits that declare a governance handler (a tool `pre` handler with a run
// script that is present), each with whether it may run: [{ kit, trusted, reason }].
export function governanceKits(found = handlerKits().kits) {
  return found.filter(({ kit, handlers }) => handlers.tool.some(h => h.phase === 'pre' && scriptPresent(kit, h))).map(entry => {
    const refusals = entry.handlers.tool.filter(h => h.phase === 'pre' && scriptPresent(entry.kit, h)).map(h => codeRefusal(entry, h));
    return { kit: entry.kit, trusted: refusals.some(r => r === null), reason: refusals.find(Boolean) ?? null };
  });
}

// Does any installed kit declare a governance handler that may run? The
// governance probe asks this (lib/account.mjs governanceNotice).
export function declaresGovernance(found = handlerKits().kits) {
  return governanceKits(found).some(g => g.trusted);
}

// The altered gates: each kit whose id names a trusted publisher and that
// declares a tool `pre` handler with a run script the trust check refuses (its
// bytes are not its recorded release, its script is not a declared asset, or
// the script is not a file inside the kit), whatever the handler's tool match:
// [{ kit, reason }], one per kit. A kit from a publisher that is not on the
// list is never one. In a governed workspace each refuses every pre-tool call.
export function alteredGates(found) {
  const out = [];
  for (const entry of found) {
    const pre = entry.handlers.tool.filter(h => h.phase === 'pre' && h.run);
    if (!pre.length || !trustOf(entry).publisherTrusted) continue;
    const reason = pre.map(h => codeRefusal(entry, h) ?? (scriptPresent(entry.kit, h) ? null : `its handler script ${h.run} is not a file inside the kit`)).find(Boolean);
    if (reason) out.push({ kit: entry.kit, reason });
  }
  return out;
}

// How to mend an altered gate, in a sentence: reinstall the kit's recorded
// release, or stop governing the workspace.
export function gateRemedy(kit) {
  const add = `\`node "${KIT_SCRIPT}" add --from <its release folder or archive> --apply\``;
  const reinstall = kit.origin === 'plugin' ? `reinstall the ia plugin, which carries it, or install its recorded release with ${add}` : `reinstall its recorded release with ${add}`;
  return `To fix it, ${reinstall}, or remove .ia/governance.json to stop governing this repository.`;
}

// The refusal for a governed workspace's pre-tool call while an altered gate
// is installed: { kit, reason } for the first, or null. Nothing runs first:
// with its gate unable to run, no call may pass.
export function alteredGateBlock(found, workspace) {
  if (!workspace || !existsSync(join(workspace, '.ia', 'governance.json'))) return null;
  const [first] = alteredGates(found);
  if (!first) return null;
  return { kit: first.kit.id, reason: `its pre-tool gate may not run, because ${first.reason}, so every tool call in this governed repository is refused (fail closed). ${gateRemedy(first.kit)}` };
}

// The kits that ship handler code which does not run here, with why:
// [{ kit, reason }], one per kit. Code is a run entry whose script is present.
export function untrustedHandlerKits(found) {
  const out = [];
  for (const entry of found) {
    const scripts = Object.values(entry.handlers).flat().filter(h => scriptPresent(entry.kit, h));
    const reason = scripts.map(h => codeRefusal(entry, h)).find(Boolean);
    if (reason) out.push({ kit: entry.kit, reason });
  }
  return out;
}

// The handlers one hook event selects, in kit order: [{ kit, handler, found }].
// event: session (with source), prompt, pre, post or stop; toolName for pre
// and post. An entry is selected when it has context to deliver or a script
// that is present.
export function selectHandlers(found, event, { source, toolName } = {}) {
  const picked = [];
  for (const entry of found) {
    const { kit, handlers } = entry;
    let list;
    if (event === 'session') list = handlers.session.filter(h => h.events.includes(source));
    else if (event === 'prompt') list = handlers.prompt;
    else if (event === 'stop') list = handlers.stop;
    else if (event === 'pre' || event === 'post') list = handlers.tool.filter(h => h.phase === event && (h.match === null || new RegExp(`^(?:${h.match})$`).test(toolName ?? '')));
    else list = [];
    for (const handler of list) if (handler.context || scriptPresent(kit, handler)) picked.push({ kit, handler, found: entry });
  }
  return picked;
}

// Cuts one kit's merged context to the cap.
export function capContext(text, cap = KIT_CONTEXT_CAP) {
  if (text.length <= cap) return text;
  const marker = ' [truncated]';
  return text.slice(0, cap - marker.length) + marker;
}

// One handler's answer: the last line of its stdout as JSON. Accepts the flat
// contract shape and, for a script written as a hook, hookSpecificOutput.
function answerOf(stdout) {
  let value;
  try { value = JSON.parse(String(stdout ?? '').trim().split('\n').at(-1) || 'null'); } catch { return null; }
  if (!plainObject(value)) return null;
  const context = typeof value.additionalContext === 'string' ? value.additionalContext : (typeof value.hookSpecificOutput?.additionalContext === 'string' ? value.hookSpecificOutput.additionalContext : '');
  const decision = value.decision === 'block' || value.hookSpecificOutput?.permissionDecision === 'deny' ? 'block' : 'allow';
  const reason = typeof value.reason === 'string' ? value.reason : (typeof value.hookSpecificOutput?.permissionDecisionReason === 'string' ? value.hookSpecificOutput.permissionDecisionReason : '');
  return { context: context.trim(), decision, reason: reason.trim() };
}

const runName = handler => handler.run ?? `\${PLUGIN}/${handler.plugin}`;

// While a trusted pre handler runs in a governed workspace, the kit it belongs
// to: an entry point that has to exit before it answers refuses the call
// instead of allowing it (scripts/handlers.mjs).
export const gate = { kit: null };

// Runs the selected handlers for one event. Resolves { context, block, ran,
// skipped }: context is every kit's merged additionalContext (each prefixed
// with its kit id and capped per kit); block is { kit, reason } when a pre
// handler blocked in a governed workspace, else null; skipped lists the kits
// whose run entries did not run, with why. Handlers after a block do not run.
// The whole run stays inside budgetMs.
export async function runHandlers(picked, { event, raw = '{}', cwd = process.cwd(), workspace = null, env = process.env, budgetMs = 25_000 } = {}) {
  const started = Date.now();
  const governed = Boolean(workspace && existsSync(join(workspace, '.ia', 'governance.json')));
  let home = '';
  try { home = iaHome(env); } catch { /* a relative IA_HOME reaches no handler */ }
  const byKit = new Map(), ran = [], skipped = [];
  let block = null;
  for (const item of picked) {
    const { kit, handler } = item;
    const parts = byKit.get(kit.id) ?? [];
    byKit.set(kit.id, parts);
    if (handler.context) parts.push(handler.context);
    if (!scriptPresent(kit, handler)) continue;
    // A plugin run outside an IA workspace has nothing to read: no trust check, no process.
    if (handler.plugin && !workspace) continue;
    const refusal = codeRefusal(item.found ?? (item.found = { kit }), handler);
    if (refusal) {
      ran.push({ kit: kit.id, run: runName(handler), status: 'untrusted', reason: refusal });
      if (!skipped.some(s => s.kit === kit.id)) skipped.push({ kit: kit.id, reason: refusal });
      continue;
    }
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) { ran.push({ kit: kit.id, run: runName(handler), status: 'skipped', reason: 'hook budget spent' }); continue; }
    const gating = event === 'pre' && governed;
    const timeoutMs = Math.min(handler.timeout * 1000, left);
    if (gating) gate.kit = kit.id;
    const child = await runChild({
      argv: [process.execPath, handler.plugin ? join(PLUGIN_ROOT, handler.plugin) : join(kit.dir, handler.run)], cwd, input: raw, timeoutMs,
      env: childEnv(env, { IA_KIT_ROOT: kit.dir, IA_WORKSPACE_ROOT: workspace ?? '', IA_HOME: home }),
    });
    if (gating) gate.kit = null;
    const failed = Boolean(child.error) || child.timedOut || child.status !== 0;
    // Output cut at the cap may have lost a gate's answer, so a governed gate's cut output decides nothing.
    const answer = failed || (gating && child.truncated.stdout) ? null : answerOf(child.stdout);
    ran.push({ kit: kit.id, run: runName(handler), status: child.error ? 'error' : child.timedOut ? 'timed out' : child.status === 0 ? 'ran' : `exit ${child.status ?? child.signal}`, answered: Boolean(answer), truncated: child.truncated.stdout || child.truncated.stderr });
    // A pre handler that could not decide (it failed to start, crashed, timed out, exited non-zero, or said more than
    // the cap) refuses the call in a governed workspace: a gate that fails must not read as allow.
    if (gating && !answer && (failed || child.truncated.stdout)) {
      const stderr = String(child.stderr ?? '').split('\n').map(l => l.trim()).find(l => /^\w*Error\b/.test(l));
      const detail = child.error?.message ?? (child.timedOut ? `it did not answer within ${Math.ceil(timeoutMs / 1000)} s` : child.status === 0 ? 'its answer was cut at the output cap' : (stderr || `exit ${child.status ?? child.signal}`));
      block = { kit: kit.id, reason: `its pre-tool handler failed, so the call is refused (fail closed): ${detail}` };
      break;
    }
    if (!answer) continue;
    if (answer.context) parts.push(answer.context);
    if (event === 'pre' && answer.decision === 'block') {
      if (governed) {
        block = { kit: kit.id, reason: answer.reason || `${kit.id} blocked this tool call` };
        break;
      }
      parts.push(`(${kit.id} asked to block this tool call${answer.reason ? `: ${answer.reason}` : ''}; not applied, because this workspace has not opted in through .ia/governance.json.)`);
    }
  }
  const context = [...byKit].filter(([, parts]) => parts.length).map(([id, parts]) => capContext(`${id}: ${parts.join('\n')}`)).join('\n\n');
  return { context, block, ran, skipped };
}
