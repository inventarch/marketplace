#!/usr/bin/env node
// Runs the IA CLI the way this plugin resolves it (lib/cli.mjs): IA_CLI_PATH
// (or IA_METHOD_CLI), else the repository's pinned install at or above the
// working folder (never above its .git), else exactly @inventarch/cli 3.8.0
// through npm's npx. Never an `ia` on PATH and never a shell. The arguments
// reach it verbatim, with this process's stdin, stdout and stderr, and its
// exit code is this one's. IA_NO_HANDOFF=1 keeps that CLI the one that runs
// (decision public-cli-3-6-0-handoff). Exit 127: no CLI could be resolved;
// 126: it did not start.
//   node <plugin>/scripts/ia.mjs <command> [args...]
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { resolveCli } from './lib/cli.mjs';

let cli;
try { cli = resolveCli(realpathSync.native(process.cwd())); } catch (error) {
  process.stderr.write(`ia.mjs: ${error.code ?? 'IA-CORE-CLI'}: ${error.message}\n`);
  process.exit(127);
}
const [command, ...prefix] = cli.argv;
const ran = spawnSync(command, [...prefix, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, IA_NO_HANDOFF: '1' }, windowsHide: true });
if (ran.error) {
  process.stderr.write(`ia.mjs: ${command} did not start: ${ran.error.message}\n`);
  process.exit(126);
}
process.exit(ran.status ?? 128 + (constants.signals[ran.signal] ?? 0));
