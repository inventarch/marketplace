#!/usr/bin/env node
// Cross-model delegation, one level deep (decision public-delegate): builds the
// command line that hands one step and its packet to another model's CLI, and
// runs it only with --run. Off by default: it refuses unless the person turned
// it on ("delegation": true in <IA home>/config.json, or IA_DELEGATION=1), and
// it refuses inside a delegated run (IA_DELEGATION_DEPTH of 1 or more), so a
// delegate never delegates again. The delegate gets the IA door as its MCP
// server and the packet inline in its prompt, on stdin (no command-line length
// limit), with IA_DELEGATION_DEPTH one higher and a timeout.
//   node scripts/delegate.mjs --to <claude|codex|gemini> --packet <file> --brief <file> [--root <repo>] [--timeout <seconds>] [--bin <path>] [--run]
// --packet is the JSON ia_method returned or resolve.mjs printed; --brief is the
// step to hand over, as the person stated it. Prints one JSON value: the
// command (argv, cwd, environment change, timeout) and, with --run, its exit
// status and output tails. Exit 0 on success, 1 on a refusal, 2 on bad usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iaHome } from './lib/home.mjs';
import { parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

export const DEFAULT_TIMEOUT = 900;
export const MAX_TIMEOUT = 3600;
export const GEMINI_POLICY_PLACEHOLDER = '<ephemeral policy.toml>';
export const GEMINI_DENIED_TOOLS = ['exit_plan_mode', 'enter_plan_mode', 'write_file', 'replace', 'run_shell_command'];
const TAIL = 4000;
const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const SPEC = { to: 'value', packet: 'value', brief: 'value', root: 'value', timeout: 'value', bin: 'value', run: 'flag' };

// Ephemeral user-tier TOML policy (tier 4) passed via `gemini --policy <file>`:
// - Denies `exit_plan_mode` (which non-interactively switches plan mode to YOLO in gemini-cli),
//   `enter_plan_mode`, `write_file`, `replace` (including plan.toml's `.md` rules), and `run_shell_command`
//   at priority 4.900 across all approval modes.
// - Allows the `ia` MCP door's tools (`mcp_ia_*`) at priority 4.800 across all modes (including headless `plan`).
export function geminiPolicyToml() {
  const denied = GEMINI_DENIED_TOOLS.map(name => JSON.stringify(name)).join(', ');
  return [
    '[[rule]]',
    `toolName = [${denied}]`,
    'decision = "deny"',
    'priority = 900',
    'denyMessage = "Gemini delegation runs read-only; mutations and plan-mode transitions are disabled."',
    '',
    '[[rule]]',
    'mcpName = "ia"',
    'toolName = "*"',
    'decision = "allow"',
    'priority = 800',
    '',
  ].join('\n');
}

class DelegateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// The door the delegate runs: the same launcher, pin and kits this plugin's .mcp.json uses (scripts/door.mjs starts
// npx -y @inventarch/mcp-door@<PINNED>, never through a shell).
export function doorServer(plugin = PLUGIN) {
  return { command: 'node', args: [`${plugin}/scripts/door.mjs`], env: { IA_KITS_DIR: `${plugin}/config/kits` } };
}

// Is delegation turned on, and is this run allowed to delegate? Throws a DelegateError when not.
export function gate(env = process.env) {
  const depth = Number.parseInt(env.IA_DELEGATION_DEPTH ?? '0', 10);
  if (Number.isFinite(depth) && depth >= 1) throw new DelegateError(`this run is already a delegate (IA_DELEGATION_DEPTH=${env.IA_DELEGATION_DEPTH}); delegation is one level deep, so do the step here or hand it back`, 'IA-CORE-DELEGATION-DEPTH');
  let enabled = env.IA_DELEGATION === '1';
  if (!enabled) {
    try { enabled = JSON.parse(readFileSync(join(iaHome(env), 'config.json'), 'utf8')).delegation === true; } catch { enabled = false; }
  }
  if (!enabled) throw new DelegateError('delegation is off by default: turn it on with "delegation": true in ~/.ia/config.json, or IA_DELEGATION=1, and only on the person\'s word', 'IA-CORE-DELEGATION-OFF');
  return Number.isFinite(depth) ? depth : 0;
}

// The prompt the delegate reads on stdin: the brief, then the packet inline.
export function prompt(brief, packet) {
  return `${brief.trim()}\n\nYou are a delegate, one level deep: do not delegate this step again. Follow only this packet, from the InventArch method its key resolves to; the IA door (MCP server ia) answers ia_method with the same packet if you need it again. Report what you changed, what you ran with exit codes, and what the packet's checks still need; acceptance is the person's.\n\nThe packet:\n\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\`\n`;
}

// The command for one host: argv. The prompt goes to stdin.
export function command(to, { bin, plugin = PLUGIN, policyPath = GEMINI_POLICY_PLACEHOLDER } = {}) {
  const door = doorServer(plugin);
  if (to === 'claude') return [bin ?? 'claude', '-p', '--mcp-config', JSON.stringify({ mcpServers: { ia: door } })];
  if (to === 'codex') {
    const toml = value => JSON.stringify(value);
    return [bin ?? 'codex', 'exec',
      '-c', `mcp_servers.ia.command=${toml(door.command)}`,
      '-c', `mcp_servers.ia.args=[${door.args.map(toml).join(',')}]`,
      '-c', `mcp_servers.ia.env={IA_KITS_DIR=${toml(door.env.IA_KITS_DIR)}}`,
      '-'];
  }
  if (to === 'gemini') {
    return [
      bin ?? 'gemini',
      '--approval-mode', 'plan',
      '--policy', policyPath,
      '--allowed-mcp-server-names', 'ia',
      '-p', 'Follow the delegate brief and InventArch packet on stdin.',
    ];
  }
  throw new UsageError('--to is claude, codex or gemini');
}

// On Windows, npm installs `gemini` as a `.cmd` shim next to `node_modules/@google/gemini-cli/dist/index.js`.
// Resolving that JS entrypoint lets `spawnSync` run without a shell (`shell: false`).
export function resolveGeminiSpawn(argv, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return argv;
  const first = argv[0];
  if (first === process.execPath) return argv;
  const candidates = [];
  if (/\.(?:cmd|bat)$/i.test(first)) candidates.push(dirname(resolve(first)));
  else if (first === 'gemini') {
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
    for (const dir of String(pathKey ? env[pathKey] : '').split(delimiter).filter(Boolean)) candidates.push(dir);
  }
  for (const dir of candidates) {
    const script = join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
    if (existsSync(script)) return [process.execPath, script, ...argv.slice(1)];
  }
  return argv;
}

export function plan(argv, env = process.env) {
  const { options } = parseArgs(argv, SPEC, { positionals: 0 });
  if (!options.to || !options.packet || !options.brief) throw new UsageError('delegate.mjs needs --to <claude|codex|gemini>, --packet <file> and --brief <file>');
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : Number(options.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) throw new UsageError(`--timeout is a whole number of seconds from 1 to ${MAX_TIMEOUT}`);
  const depth = gate(env);
  // A --bin that is a Node script (a CLI shipped as .mjs or .js) runs under this Node.
  const script = options.bin && /\.(?:mjs|cjs|js)$/i.test(options.bin);
  const argvFor = script ? [process.execPath, ...command(options.to, { bin: resolve(options.bin) })] : command(options.to, { bin: options.bin });
  const read = (path, what) => {
    if (!existsSync(path)) throw new UsageError(`--${what} ${path} does not exist`);
    return readFileSync(path, 'utf8');
  };
  let packet;
  try { packet = JSON.parse(read(options.packet, 'packet')); } catch (error) { if (error.code === 'IA-CORE-USAGE') throw error; throw new UsageError(`--packet is not JSON: ${error.message}`); }
  if (!packet || typeof packet !== 'object' || packet.error) throw new DelegateError('--packet holds a refusal, not a packet: resolve the method first', 'IA-CORE-DELEGATION-PACKET');
  const brief = read(options.brief, 'brief');
  if (!brief.trim()) throw new UsageError('--brief is empty');
  const cwd = resolve(options.root ?? '.');
  const mcpSettings = options.to === 'gemini'
    ? { mcpServers: { ia: doorServer() }, policyPaths: [GEMINI_POLICY_PLACEHOLDER], tools: { exclude: [...GEMINI_DENIED_TOOLS] } }
    : null;
  const policyToml = options.to === 'gemini' ? geminiPolicyToml() : null;
  const childEnv = { IA_DELEGATION_DEPTH: String(depth + 1), ...(mcpSettings ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '<ephemeral settings.json>' } : {}) };
  return {
    to: options.to,
    argv: argvFor,
    cwd,
    env: childEnv,
    ...(mcpSettings ? { mcpSettings, policyToml } : {}),
    timeoutSeconds: timeout,
    input: prompt(brief, packet),
    run: Boolean(options.run),
  };
}

export function delegate(argv, env = process.env) {
  const p = plan(argv, env);
  const shown = {
    to: p.to,
    argv: p.argv,
    cwd: p.cwd,
    env: p.env,
    ...(p.mcpSettings ? { mcpSettings: p.mcpSettings, policyToml: p.policyToml } : {}),
    timeoutSeconds: p.timeoutSeconds,
    promptBytes: Buffer.byteLength(p.input),
    packetDigest: null,
  };
  try { shown.packetDigest = JSON.parse(p.input.slice(p.input.indexOf('```json\n') + 8, p.input.lastIndexOf('```'))).digest ?? null; } catch { /* a packet without a digest */ }
  if (!p.run) return { ...shown, ran: false, next: 'show the person this command; run it with --run only on their word' };
  let tempDir = null;
  try {
    const runEnv = { ...env, ...p.env };
    let effectiveArgv = p.argv;
    if (p.mcpSettings) {
      tempDir = mkdtempSync(join(tmpdir(), 'ia-delegate-gemini-'));
      const policyPath = join(tempDir, 'policy.toml');
      writeFileSync(policyPath, p.policyToml ?? geminiPolicyToml(), 'utf8');
      const settingsPath = join(tempDir, 'settings.json');
      const runtimeSettings = { ...p.mcpSettings, policyPaths: [policyPath] };
      writeFileSync(settingsPath, JSON.stringify(runtimeSettings, null, 2) + '\n', 'utf8');
      runEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
      effectiveArgv = p.argv.map(arg => (arg === GEMINI_POLICY_PLACEHOLDER ? policyPath : arg));
    }
    const spawnArgv = p.to === 'gemini' ? resolveGeminiSpawn(effectiveArgv, runEnv) : effectiveArgv;
    const child = spawnSync(spawnArgv[0], spawnArgv.slice(1), { cwd: p.cwd, input: p.input, encoding: 'utf8', timeout: p.timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: runEnv });
    const tail = text => (text ?? '').length > TAIL ? `[${text.length - TAIL} characters cut] ${text.slice(-TAIL)}` : (text ?? '');
    const timedOut = child.error?.code === 'ETIMEDOUT';
    return { ...shown, ran: true, status: child.status, timedOut, error: child.error && !timedOut ? child.error.message : null, stdout: tail(child.stdout), stderr: tail(child.stderr) };
  } finally {
    if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    printJson(delegate(process.argv.slice(2)));
  } catch (error) {
    if (error.code === 'IA-CORE-USAGE') { process.stderr.write(`${error.message}\nusage: delegate.mjs --to <claude|codex|gemini> --packet <file> --brief <file> [--root <repo>] [--timeout <seconds>] [--bin <path>] [--run]\n`); process.exit(2); }
    process.exit(refuse(error));
  }
}
