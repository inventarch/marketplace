#!/usr/bin/env node
// The method kits this core can resolve, for agents and people (decision
// public-kit-lookup). A kit is found in this plugin's config/kits first, then
// in <IA home>/kits/<kit>/<version>/. Every verb previews unless --apply.
//   node scripts/kit.mjs list                                       every kit: origin, latest release, versions, checks, whole
//                                                                   capabilities, the keys it offers, what it resolves unbound
//   node scripts/kit.mjs add <kit> [<repo>] [--apply]               install the kit's latest release into an IA workspace
//   node scripts/kit.mjs add --from <folder|archive> [--apply]      validate a kit and install it into <IA home>/kits/<kit>/<version>/
//   node scripts/kit.mjs bind <kit> [<repo>] [--install] [--apply]  add the keys the kit recommends that the repository does not bind;
//                                                                   refuses a kit the lock does not install (previews too), and --install
//                                                                   installs it first: ia install --package for the kits the public-kits
//                                                                   package carries, add for the rest
//   node scripts/kit.mjs bind <kit> [<repo>] --key <k> --capability <c> [--profile <p>] [--install] [--apply]   bind one key
//   node scripts/kit.mjs upgrade [<kit>] [<repo>] [--apply]         installed kits against their latest release; adopt the newer
//   node scripts/kit.mjs repin --project <p> --task <t> [<repo>] [--apply]   move a task pin's keys to the kits now available
//   node scripts/kit.mjs rebind <from-kit> <to-kit> [<repo>] [--keys a,b] [--apply]   move bound keys to another kit
//   node scripts/kit.mjs check [<kit>]                              each kit's release, sources, records and sidecars agree
//   node scripts/kit.mjs root <kit>                                 the folder to pass as --root to read that kit
//   node scripts/kit.mjs status <kit> [<repo>]                      is the kit installed in this IA workspace, and which release
//   node scripts/kit.mjs adopt <kit> <repo> [--dry-run]             add, applied unless --dry-run (kept for older instructions)
// <kit> is a kit id (inventarch/ia-<name>-kit) or its folder. <repo> defaults
// to the IA workspace at or above the working folder. Every command prints one
// JSON value. Exit 0 on success, 1 on a refusal (the JSON's error says why), 2 on bad usage.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCli } from './lib/cli.mjs';
import { adopt, findKit, installedKit, kitBindings, readRoot } from './lib/kit.mjs';
import { addFromOp, addOp, bindOp, checkOp, listOp, rebindOp, repinOp, upgradeOp } from './lib/kit-ops.mjs';
import { parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

const USAGE = 'usage: kit.mjs list | add <kit> [<repo>] [--apply] | add --from <folder|archive> [--apply] | bind <kit> [<repo>] [--key <k> --capability <c> [--profile <p>]] [--install] [--apply] | upgrade [<kit>] [<repo>] [--apply] | repin --project <p> --task <t> [<repo>] [--apply] | rebind <from-kit> <to-kit> [<repo>] [--keys a,b] [--apply] | check [<kit>] | root <kit> | status <kit> [<repo>] | adopt <kit> <repo> [--dry-run]\n';
const SPECS = {
  list: [{}, 0, 0], check: [{}, 0, 1], root: [{}, 1, 1], status: [{}, 1, 2],
  add: [{ apply: 'flag', from: 'value' }, 0, 2], bind: [{ apply: 'flag', install: 'flag', key: 'value', capability: 'value', profile: 'value' }, 1, 2],
  upgrade: [{ apply: 'flag' }, 0, 2], repin: [{ apply: 'flag', project: 'value', task: 'value' }, 0, 1],
  rebind: [{ apply: 'flag', keys: 'value' }, 2, 3], adopt: [{ 'dry-run': 'flag', dry: 'flag' }, 2, 2],
};

export function run(argv) {
  const [command, ...rest] = argv;
  const spec = SPECS[command];
  if (!spec) throw new UsageError(USAGE.trim());
  const { options, rest: positional } = parseArgs(rest, spec[0], { positionals: spec[2] });
  if (positional.length < spec[1]) throw new UsageError(USAGE.trim());
  const apply = Boolean(options.apply);
  switch (command) {
    case 'list': return listOp();
    case 'check': return checkOp(positional[0]);
    case 'add':
      if (options.from) { if (positional.length) throw new UsageError('add --from takes no kit or repository'); return addFromOp(options.from, { apply }); }
      if (!positional.length) throw new UsageError('add needs a kit, or --from <folder|archive>');
      return addOp(positional[0], positional[1], { apply });
    case 'bind': return bindOp(positional[0], positional[1], { apply, install: Boolean(options.install), key: options.key, capability: options.capability, profile: options.profile });
    case 'upgrade': {
      // One positional is a kit when it names one, else the repository.
      let [kit, repo] = positional;
      if (kit && !repo) { try { findKit(kit); } catch { repo = kit; kit = undefined; } }
      return upgradeOp(kit, repo, { apply });
    }
    case 'repin': return repinOp(positional[0], { project: options.project, task: options.task, apply });
    case 'rebind': return rebindOp(positional[0], positional[1], positional[2], { keys: options.keys ? options.keys.split(',').filter(Boolean) : undefined, apply });
    case 'root': { const kit = findKit(positional[0]); return { kit: kit.id, root: readRoot(kit, { cli: resolveCli(realpathSync.native(process.cwd())) }) }; }
    case 'status': {
      const kit = findKit(positional[0]);
      const root = resolve(positional[1] ?? '.');
      const locked = installedKit(root, kit.id);
      const latest = kit.latest;
      return { root, kit: kit.id, installed: locked ? { version: locked.version, archive: locked.archive } : null, latest: latest ? { version: latest.version, archive: latest.archive } : null, current: Boolean(locked && latest && locked.archive === latest.archive) };
    }
    default: {
      const kit = findKit(positional[0]);
      const result = adopt(positional[1], kit, { dry: Boolean(options['dry-run'] || options.dry) });
      const plugin = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
      if (Object.keys(kitBindings(kit).recommend).length) result.next = `node "${plugin}/scripts/kit.mjs" bind ${kit.id} "${result.root.replace(/\\/g, '/')}"`;
      return result;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    const result = run(process.argv.slice(2));
    printJson(result);
    if (result?.status === 'refused') process.exitCode = 1;
  } catch (error) {
    // A usage error prints the usage, as every other script does, and runs nothing.
    if (error.code === 'IA-CORE-USAGE') { process.stderr.write(USAGE); process.exit(2); }
    process.exit(refuse(error));
  }
}
