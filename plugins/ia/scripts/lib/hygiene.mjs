// Process hygiene for the children the kit runners start (decision
// public-kit-trust): scripts/handlers.mjs (handlers.json), scripts/on-write.mjs
// (onwrite.json) and scripts/check.mjs (checks.json). This is hygiene, not a
// sandbox. A child still runs as the person, with their files, their network
// and every other process of theirs within reach; what keeps a hostile kit
// from running at all is lib/trust.mjs. Hygiene keeps an honest kit's child
// from seeing secrets it never needed, from outliving its deadline and from
// flooding the hook.
//   - childEnv: the environment is an allowlist, not the parent's whole
//     environment. NODE_OPTIONS and NODE_PATH never pass, so nothing preloads
//     into the child. IA_NO_HANDOFF=1 is set by default (decision
//     public-cli-3-6-0-handoff), so an ia a child starts never hands its
//     command to another installed CLI; a caller's override still wins.
//   - runChild: on its deadline the child's whole process tree is killed (a
//     POSIX process group, or taskkill /T on Windows), and each of stdout and
//     stderr keeps at most OUTPUT_CAP bytes, the rest dropped.
// Limits: a POSIX descendant that starts its own session leaves the group;
// on Windows a descendant still running after its parent has exited is not
// found by taskkill /T (a job object would need native code), so it is killed
// only on the deadline, while the handler itself still runs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export const OUTPUT_CAP = 256 * 1024;

// Names a child keeps, measured against what the ia-governance kit's hooks and
// the git and node they start read (2026-10-31), plus what Windows needs to
// start any process. Compared case-insensitively on Windows, where the
// environment is.
export const ENV_NAMES = [
  // the command search path and the OS
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PSModulePath',
  // the person's folders: os.homedir(), os.tmpdir(), git's global config, npm's cache, Codex's bundled binary
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'XDG_CONFIG_HOME',
  'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'LOGNAME', 'SHELL',
  // locale and time
  'LANG', 'LANGUAGE', 'TZ',
  // git's configuration lookup, through which hosts trust a sandboxed checkout (safe.directory)
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  // the host process: ia-governance keys a /clear record by CLAUDE_PID
  'CLAUDE_PID', 'CLAUDE_PROJECT_DIR',
];
// Families that pass by prefix: locale categories, git's numbered config
// pairs, and IA_*, InventArch's own namespace (the contract's IA_KIT_ROOT,
// IA_WORKSPACE_ROOT and IA_HOME, and the kit settings a person sets, such as
// IA_GOVERNANCE_STATE_DIR, IA_CORE_ROOT and IA_COORDINATION_HOME).
export const ENV_PREFIXES = [/^LC_/i, /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i, /^IA_/i];
// A name that looks like a credential never passes, even by prefix.
const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i;

// The environment for one child: the allowed names from env, then
// IA_NO_HANDOFF=1, then overrides.
export const NO_HANDOFF = Object.freeze({ IA_NO_HANDOFF: '1' });
export function childEnv(env = process.env, overrides = {}, { platform = process.platform } = {}) {
  const fold = platform === 'win32' ? name => name.toUpperCase() : name => name;
  const names = new Set(ENV_NAMES.map(fold));
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const byName = names.has(fold(name));
    if (!byName && !ENV_PREFIXES.some(p => p.test(name))) continue;
    if (!byName && SECRET.test(name)) continue;
    out[name] = String(value);
  }
  for (const [name, value] of [...Object.entries(NO_HANDOFF), ...Object.entries(overrides)]) {
    for (const key of Object.keys(out)) if (fold(key) === fold(name)) delete out[key];
    if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

// Kills a child's whole process tree; true when something was signalled.
// POSIX: the child leads its own process group (spawned detached), so
// kill(-pid) reaches every member. Windows: taskkill /T /F /PID.
export function killTree(pid, { platform = process.platform, kill = (p, s) => process.kill(p, s), run = spawnSync, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    const system = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const ran = run(run === spawnSync && !existsSync(system) ? 'taskkill' : system, ['/T', '/F', '/PID', String(pid)], { windowsHide: true, shell: false, timeout: 5000, stdio: 'ignore' });
    return !ran.error && ran.status === 0;
  }
  try { kill(-pid, 'SIGKILL'); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    try { kill(pid, 'SIGKILL'); return true; } catch { return false; }
  }
}

// The children still running, so an entry point that must exit early (its
// hook budget is spent) kills them first: killRunning().
const running = new Set();
export function killRunning({ platform = process.platform } = {}) {
  for (const child of running) { killTree(child.pid, { platform }); try { child.kill('SIGKILL'); } catch { /* gone */ } }
  running.clear();
}

// Runs argv (no shell) with input on stdin. Resolves, never rejects, with
// { status, signal, error, timedOut, stdout, stderr, truncated: { stdout, stderr } }.
export function runChild({ argv, cwd, input = '', env = childEnv(), timeoutMs, cap = OUTPUT_CAP, platform = process.platform }) {
  return new Promise(resolve => {
    const kept = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 }, truncated = { stdout: false, stderr: false };
    let child, timer, grace, timedOut = false, settled = false, exit = { status: null, signal: null }, failure = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      running.delete(child);
      resolve({ ...exit, error: failure, timedOut, truncated, stdout: Buffer.concat(kept.stdout).toString('utf8'), stderr: Buffer.concat(kept.stderr).toString('utf8') });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { failure = error; finish(); return; }
    running.add(child);
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        const room = cap - size[name];
        if (chunk.length > room) truncated[name] = true;
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        kept[name].push(part);
        size[name] += part.length;
      });
      child[name].on('error', () => { /* a destroyed pipe after exit */ });
    }
    child.stdin.on('error', () => { /* a child that never reads its stdin */ });
    child.stdin.end(input);
    child.on('error', error => { failure = error; finish(); });
    timer = setTimeout(() => { timedOut = true; killTree(child.pid, { platform }); try { child.kill('SIGKILL'); } catch { /* gone */ } }, Math.max(1, timeoutMs));
    child.on('exit', (status, signal) => {
      exit = { status, signal };
      // A handler's children must not outlive it: the rest of its group goes with it.
      if (platform !== 'win32') killTree(child.pid, { platform });
      // A descendant that still holds a pipe must not hold the hook: give the
      // pipes a moment to close, then stop reading.
      grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 250);
    });
    child.on('close', finish);
  });
}
