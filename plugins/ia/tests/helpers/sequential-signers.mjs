// A real-CLI workspace where two approvers seal one record in turn under a
// quorum 2, current-revision @approval-rule, as check-seal accepts it: signer 1
// captures before any approval exists, signer 2 captures after approval 1 was
// written. The design and product checkers must accept the same pair.
//   sequentialSigners(t, { cli, kit, system, words, records, target, checkName, kitId })
// returns { ws, env, check(), sealReport(), sealPasses(), sealFirst(), sealSecond({ onPreSeal }), edit(name, text),
//   read(name), approvalFileName(who), approvalPath(who) };
// sealReport() runs check-seal's workspace audit on the same workspace, the parity reference; sealPasses() is its verdict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APPROVALS_DIR, IaCli, generateSigningKey, keyEntryText, nameSafeKeyTag, passes, runWorkspaceAudit, sealRecord } from '../../config/kits/ia-approval/scripts/check-seal.mjs';
import { adopt, findKit } from '../../scripts/lib/kit.mjs';
import { PLUGIN } from './fixtures.mjs';

export function sequentialSigners(t, { cli, kit, system, words, records, target, checkName, kitId }) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-seq-signers-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: cli, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [cli, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit(kit), { cli: { argv: [process.execPath, cli], version: '3.8.0' }, env });
  adopt(ws, findKit('ia-approval'), { cli: { argv: [process.execPath, cli], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsText = readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, `systems [$1, @system approval-system, @system ${system}]`);
  writeFileSync(wsFile, wsText);
  const wsId = `workspace-system/definition/workspace/${/^@workspace\s+([a-z0-9-]+)/m.exec(wsText)[1]}`;

  const { key: keyA } = generateSigningKey();
  const { key: keyB } = generateSigningKey();
  const approver = (name, account, key) => `@approver ${name}
  meaning
    says "Approver ${name}."
    answers "Who ratifies?"
  person
    account "${account}"
    display "${name}"
  authority
    workspaces ["${wsId}"]
    anchor founding
  keys
    entries ["${keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null })}"]
`;
  writeFileSync(
    join(ws, '.ia', 'src', 'approvers.ia'),
    `#! ia 1.0

${approver('signer-a', 'acct-a', keyA)}
${approver('signer-b', 'acct-b', keyB)}
@approval-rule two-signers
  meaning
    says "Two approvers seal the current revision."
    answers "Which records need two current-revision seals?"
  demand
    words [${words}]
    quorum 2
    staleness current-revision
    merge person
`,
  );
  writeFileSync(join(ws, '.ia', 'src', 'governed.ia'), records);
  mkdirSync(join(ws, APPROVALS_DIR), { recursive: true });

  const iaCli = new IaCli([process.execPath, cli], { env });
  const seal = (view, account, key, signedAt) => {
    const rec = view.records.get(target);
    const rule = view.records.get('approval-system/governance/approval-rule/two-signers');
    assert.ok(rec && rule, 'target and rule are captured');
    const floorSys = [...view.records.values()].find(r => r.system === 'floor' && r.facet === 'system');
    const language = floorSys?.fields?.version;
    assert.ok(language, 'floor language version is captured');
    const sealed = sealRecord({
      action: 'approve',
      organisation: wsId,
      workspace: wsId,
      record: { identity: rec.identity, name: rec.name },
      recordDigest: rec.digest,
      dependsOn: [],
      rules: [{ identity: rule.identity, digest: rule.digest }],
      revision: view.revision,
      toolchain: { language, systems: [{ system, version: '0.1.0' }] },
      baseCommit: '1'.repeat(40),
      signer: { account, display: account },
      key,
      keyKind: 'service-held',
      via: 'desk',
      request: `req-${account}`,
      signedAt: new Date(signedAt),
    });
    writeFileSync(join(ws, sealed.path), sealed.source);
    return sealed.path;
  };

  // check-seal's full workspace report: findings carry a name, and unratified ones the record as their subject.
  const sealReport = () => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      return runWorkspaceAudit([process.execPath, cli], ws);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  };

  let preSeal = null;
  let first = null;
  let second = null;
  return {
    ws,
    env,
    sealFirst() {
      preSeal = iaCli.capture(ws);
      first = seal(preSeal, 'acct-a', keyA, '2026-11-18T00:00:00Z');
    },
    // Signer 2 captures now (approval 1 present), or on signer 1's pre-seal view.
    sealSecond({ onPreSeal = false } = {}) {
      if (second) rmSync(join(ws, second), { force: true });
      const view = onPreSeal ? preSeal : iaCli.capture(ws);
      second = seal(view, 'acct-b', keyB, '2026-11-18T01:00:00Z');
    },
    edit(name, text) {
      const file = join(ws, '.ia', 'src', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    read(name) {
      return readFileSync(join(ws, '.ia', 'src', name), 'utf8');
    },
    // The file name signer 'a' or 'b' gives an approval of the target as the target stands now.
    approvalFileName(who) {
      const rec = iaCli.capture(ws).records.get(target);
      assert.ok(rec, 'the target is captured');
      return `${target.split('/').pop()}.${rec.digest.slice(0, 12)}.${nameSafeKeyTag((who === 'a' ? keyA : keyB).keyId)}.ia`;
    },
    // Signer 'a' or 'b''s approval file as written, relative to the workspace.
    approvalPath(who) {
      return who === 'a' ? first : second;
    },
    sealReport,
    sealPasses() {
      return passes(sealReport());
    },
    check() {
      const ran = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'check.mjs'), checkName, '--kit', kitId, '--root', ws, '--cli', cli], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      let findings = [];
      try {
        findings = JSON.parse(JSON.parse(ran.stdout).stdout).findings ?? [];
      } catch {
        // a run that printed no report keeps findings empty; the status says why
      }
      return { status: ran.status, findings, output: ran.stdout + ran.stderr };
    },
  };
}
