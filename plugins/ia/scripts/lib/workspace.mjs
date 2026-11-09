// Shared by the entry scripts: the IA workspace that holds a folder, the scope
// key an entry point's activity states to `ia position`, and a small argv
// parser (long options only, no shell, no free text).
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class UsageError extends Error {
  constructor(message) { super(message); this.code = 'IA-CORE-USAGE'; }
}

// The nearest folder at or above `from` that holds .ia/src, or null.
export function findWorkspace(from) {
  let dir = resolve(from);
  try { dir = realpathSync.native(dir); } catch { /* keep the given path */ }
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.ia', 'src'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The scope key each entry point's activity states to `ia position`. The
// shape names the intent (context, governance, execution, sequence, learning),
// the phase the moment (orient, plan, act, learn). An activity the table does
// not name takes the entry's default; --shape and --phase override either.
export const SCOPE_KEYS = {
  work: {
    default: ['governance', 'plan'],
    task: ['governance', 'plan'],
    decision: ['governance', 'plan'],
    dependencies: ['sequence', 'plan'],
    delegation: ['execution', 'act'],
    progress: ['context', 'orient'],
    completion: ['learning', 'learn'],
  },
  delivery: {
    default: ['execution', 'act'],
    understand: ['context', 'orient'],
    design: ['governance', 'plan'],
    change: ['execution', 'act'],
    diagnose: ['context', 'orient'],
    review: ['learning', 'learn'],
    deliver: ['learning', 'learn'],
  },
  knowledge: {
    default: ['context', 'orient'],
    find: ['context', 'orient'],
    explain: ['context', 'orient'],
    packet: ['context', 'orient'],
    // Placement is the Knowledge lane's plan cell: where content goes is decided before it is written.
    place: ['governance', 'plan'],
    reconcile: ['learning', 'learn'],
    maintain: ['execution', 'act'],
  },
};
export const SHAPES = ['context', 'governance', 'execution', 'sequence', 'learning'];
export const PHASES = ['orient', 'plan', 'act', 'learn'];

// The activities whose packet carries the whole procedure regardless of the
// kit: every cell of each bound playbook, all four phases, read by identity.
// A kit declares its own whole capabilities in delivery.json (each lane's entry
// capability is one), so the core names none itself.
export const WHOLE_PROCEDURE = {};
export const isWholeProcedure = (entry, activity) => (WHOLE_PROCEDURE[entry] ?? []).includes(activity);

export function scopeKey(entry, activity, { shape, phase } = {}) {
  const table = Object.hasOwn(SCOPE_KEYS, entry) ? SCOPE_KEYS[entry] : null;
  if (!table) throw new UsageError(`unknown entry point ${entry}; the entry points are ${Object.keys(SCOPE_KEYS).join(', ')}`);
  const mapped = Object.hasOwn(table, activity);
  const [s, p] = mapped ? table[activity] : table.default;
  if (shape && !SHAPES.includes(shape)) throw new UsageError(`--shape must be one of ${SHAPES.join(', ')}`);
  if (phase && !PHASES.includes(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(', ')}`);
  return { shape: shape ?? s, phase: phase ?? p, mapped };
}

// Parses `--name value` and `--flag` options; `spec` maps each option to
// 'value' or 'flag'. Unknown options and stray positionals are refused.
export function parseArgs(argv, spec, { positionals = 0 } = {}) {
  const options = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = (eq > 0 ? arg.slice(2, eq) : arg.slice(2));
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);
    if (kind === 'flag') { if (eq > 0) throw new UsageError(`--${name} takes no value`); options[name] = true; continue; }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    options[name] = value;
  }
  if (rest.length > positionals) throw new UsageError(`unexpected argument ${rest[positionals]}`);
  return { options, rest };
}

export const printJson = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

// Prints a refusal as JSON and returns the exit code to use.
export function refuse(error) {
  const code = error.code ?? 'IA-CORE-ERROR';
  const body = { error: { code, message: error.message } };
  if (error.candidates) body.error.candidates = error.candidates;
  if (error.key) body.error.key = error.key;
  if (error.code === 'IA-CORE-KIT-NOT-INSTALLED' && error.kit) body.error.kit = error.kit;
  printJson(body);
  return code === 'IA-CORE-USAGE' ? 2 : 1;
}
