// Tests for plugins/ia/scripts/punt.mjs and plugins/ia/scripts/agy-swarm-sync.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeSubjectSha256,
  DEFAULT_FALLBACK_UNBOUND,
  PUBLIC_KIT_IDS,
  PUBLIC_PUNT_FORMAT,
  validatePublicPuntEnvelope,
  WITNESSED_RECEIPT_FORMAT,
} from '../scripts/punt.mjs';
import { validateSwarmPlan } from '../scripts/agy-swarm-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PUNT_SCRIPT = join(HERE, '..', 'scripts', 'punt.mjs');
const AGY_SYNC_SCRIPT = join(HERE, '..', 'scripts', 'agy-swarm-sync.mjs');
const IA_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');

function runScript(script, args, { input = undefined, cwd = REPO_ROOT, env = process.env } = {}) {
  const ran = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    input,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  let json = null;
  if (ran.stdout && ran.stdout.trim()) {
    try {
      json = JSON.parse(ran.stdout);
    } catch {
      json = null;
    }
  }
  return { status: ran.status, json, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

function makeEnvelope(overrides = {}) {
  const subjectLabel = overrides.subjectLabel ?? 'task:demo-slice--01';
  const base = {
    schema: PUBLIC_PUNT_FORMAT,
    assignmentId: 'asgn-001',
    attemptId: 'att-001',
    fence: 1,
    leaseExpiresAt: '2026-11-26T05:00:00.000Z',
    heartbeatSeconds: 20,
    run: {
      runId: 'run-001',
      checkpointId: 'cp-01',
      workspaceId: 'ws-001',
    },
    routing: {
      mode: 'punt-local',
      lane: 'ia:delivery',
      activityKey: 'delivery.change',
      workerRole: 'worker',
      reviewerRole: 'reviewer',
    },
    publicMethod: {
      kit: 'inventarch/ia-method-kit',
      capability: 'method-operate',
      subjectLabel,
      subjectSha256: `sha256:${createHash('sha256').update(subjectLabel, 'utf8').digest('hex')}`,
      fallbackUnbound: { ...DEFAULT_FALLBACK_UNBOUND },
    },
    repositoryTarget: {
      repositoryUrl: 'https://github.com/inventarch/ia-apps.git',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      writePaths: ['src/**'],
      forbidSymlinks: true,
    },
    declaredKitChecks: [],
    repoVerificationCommands: [],
    instructionsMarkdown: 'Execute checkpoint cp-01 cleanly.',
    limits: {
      maxDurationSeconds: 1800,
      allowPaidApiFallback: false,
    },
    contentDigest: `sha256:${'b'.repeat(64)}`,
  };
  return { ...base, ...overrides };
}

test('PUBLIC_KIT_IDS matches kits/index.json public catalog exactly', () => {
  const index = JSON.parse(readFileSync(join(REPO_ROOT, 'kits', 'index.json'), 'utf8'));
  const expected = new Set(index.kits.map((k) => k.id));
  assert.deepEqual(new Set(PUBLIC_KIT_IDS), expected);
});

test('punt.mjs validates PublicPuntEnvelopeV1 and enforces single-hash subjectSha256 parity', () => {
  const env = makeEnvelope({
    publicMethod: {
      kit: 'inventarch/ia-method-kit',
      capability: 'method-operate',
      subjectLabel: 'work:slice-alpha',
      subjectSha256: computeSubjectSha256('work:slice-alpha'),
      fallbackUnbound: { ...DEFAULT_FALLBACK_UNBOUND },
    },
  });
  const validated = validatePublicPuntEnvelope(env);
  assert.equal(validated.schema, 'inventarch.public-punt-envelope/1');
  assert.equal(validated.publicMethod.subjectSha256, computeSubjectSha256('work:slice-alpha'));
  assert.equal(validated.publicMethod.fallbackUnbound.kit, 'inventarch/ia-method-kit');
  assert.equal(validated.publicMethod.fallbackUnbound.capability, 'method-operate');

  // Mismatched subjectSha256 must fail closed.
  const badHash = makeEnvelope({
    publicMethod: {
      ...env.publicMethod,
      subjectSha256: `sha256:${'0'.repeat(64)}`,
    },
  });
  assert.throws(() => validatePublicPuntEnvelope(badHash), (err) => err.code === 'IA-PUNT-SUBJECT-MISMATCH');
});

test('punt.mjs rejects non-public kit ids in fields and embedded text without echoing leaked id', () => {
  const badKitField = makeEnvelope({
    publicMethod: {
      kit: 'inventarch/ia-proprietary-example-kit',
      capability: 'method-operate',
      subjectLabel: 's1',
      subjectSha256: computeSubjectSha256('s1'),
      fallbackUnbound: { ...DEFAULT_FALLBACK_UNBOUND },
    },
  });
  assert.throws(
    () => validatePublicPuntEnvelope(badKitField),
    (err) => err.code === 'IA-PUNT-CUSTODY-LEAK' && !err.message.includes('ia-proprietary-example-kit'),
  );

  const badFallback = makeEnvelope({
    publicMethod: {
      kit: 'inventarch/ia-method-kit',
      capability: 'method-operate',
      subjectLabel: 's2',
      subjectSha256: computeSubjectSha256('s2'),
      fallbackUnbound: { kit: 'inventarch/ia-private-example-kit', capability: 'operate' },
    },
  });
  assert.throws(() => validatePublicPuntEnvelope(badFallback), (err) => err.code === 'IA-PUNT-CUSTODY-LEAK');

  const embeddedPrivateKit = makeEnvelope({
    instructionsMarkdown: 'never load inventarch/ia-secret-example-kit in public envelopes',
  });
  assert.throws(() => validatePublicPuntEnvelope(embeddedPrivateKit), (err) => err.code === 'IA-PUNT-CUSTODY-LEAK');
});

test('punt.mjs resolve falls back on IA-CORE-NO-WORKSPACE and refuses silent fallback on IA-CORE-NO-METHOD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-punt-resolve-'));
  try {
    const nonWorkspaceDir = join(dir, 'plain-repo');
    mkdirSync(nonWorkspaceDir, { recursive: true });

    const envelopePath = join(dir, 'envelope.json');
    const subjectLabel = 'slice:unbound-check';
    const envelope = makeEnvelope({
      publicMethod: {
        kit: 'inventarch/ia-method-kit',
        capability: 'method-operate',
        subjectLabel,
        subjectSha256: computeSubjectSha256(subjectLabel),
        fallbackUnbound: { ...DEFAULT_FALLBACK_UNBOUND },
      },
    });
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const cliArgs = existsSync(IA_CLI) ? ['--cli', IA_CLI] : [];
    const res1 = runScript(PUNT_SCRIPT, ['resolve', '--envelope', envelopePath, '--root', nonWorkspaceDir, ...cliArgs]);
    assert.equal(res1.status, 0, `expected exit 0, got ${res1.status}: ${res1.stdout} ${res1.stderr}`);
    assert.equal(res1.json.ok, true);
    assert.equal(res1.json.mode, 'fallback-unbound');
    assert.equal(res1.json.fallbackReason, 'IA-CORE-NO-WORKSPACE');
    assert.equal(res1.json.packet.scope.subject, envelope.publicMethod.subjectSha256);
    assert.equal(res1.json.packet.closure.kit, 'inventarch/ia-method-kit');

    // Inside an IA workspace with no method bindings, resolve must refuse rather than silently falling back.
    const unboundWorkspaceDir = join(dir, 'ia-repo-no-bindings');
    mkdirSync(join(unboundWorkspaceDir, '.ia', 'src'), { recursive: true });
    const res2 = runScript(PUNT_SCRIPT, ['resolve', '--envelope', envelopePath, '--root', unboundWorkspaceDir, ...cliArgs]);
    assert.equal(res2.status, 1);
    assert.equal(res2.json.error.code, 'IA-CORE-NO-METHOD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('punt.mjs verify previews repoVerificationCommands unless --execute-repo-commands is passed, and emits WitnessedPuntReceiptV1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-punt-verify-'));
  try {
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    const envelopePath = join(dir, 'envelope.json');
    const receiptsPath = join(dir, 'receipts.json');
    const outPath = join(dir, 'witnessed-receipt.json');

    const envelope = makeEnvelope({
      declaredKitChecks: [{ kit: 'inventarch/ia-method-kit', check: 'check-example', required: true }],
      repoVerificationCommands: [
        {
          id: 'echo-literal',
          argv: [
            process.execPath,
            '-e',
            'const arg = process.argv[1]; if (arg !== "a&&b" || process.env.TEST_SECRET_TOKEN) process.exit(4); process.stdout.write("verified-ok");',
            'a&&b',
          ],
        },
      ],
    });
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');
    writeFileSync(receiptsPath, JSON.stringify([
      {
        check: 'check-example',
        kit: 'inventarch/ia-method-kit',
        exitCode: 0,
        output: {
          complete: true,
          stdout: { sha256: 'sha256:abc' },
          stderr: { sha256: 'sha256:def' },
        },
      },
    ], null, 2), 'utf8');

    const envWithSecret = { ...process.env, TEST_SECRET_TOKEN: 'must-not-leak' };

    // Preview-by-default never executes repo commands and stays blocked (exit 3)
    const preview = runScript(
      PUNT_SCRIPT,
      ['verify', '--envelope', envelopePath, '--root', repoDir, '--receipts', receiptsPath],
      { env: envWithSecret },
    );
    assert.equal(preview.status, 3);
    assert.equal(preview.json.status, 'blocked');
    assert.equal(preview.json.repoVerificationResults[0].passed, false);

    // Explicit opt-in --execute-repo-commands executes shell-free and emits canonical succeeded receipt
    const ran = runScript(
      PUNT_SCRIPT,
      ['verify', '--envelope', envelopePath, '--root', repoDir, '--receipts', receiptsPath, '--out', outPath, '--execute-repo-commands'],
      { env: envWithSecret },
    );
    assert.equal(ran.status, 0, `expected exit 0, got ${ran.status}: ${ran.stdout} ${ran.stderr}`);
    assert.equal(ran.json.schema, WITNESSED_RECEIPT_FORMAT);
    assert.equal(ran.json.status, 'succeeded');
    assert.equal(ran.json.assignmentId, envelope.assignmentId);
    assert.equal(ran.json.attemptId, envelope.attemptId);
    assert.equal(ran.json.fence, envelope.fence);
    assert.equal(ran.json.declaredKitCheckResults.length, 1);
    assert.equal(ran.json.declaredKitCheckResults[0].passed, true);
    assert.equal(ran.json.repoVerificationResults.length, 1);
    assert.equal(ran.json.repoVerificationResults[0].passed, true);
    assert.equal(ran.json.witnesses[0].role, 'checker');
    assert.equal(ran.json.witnesses[0].verdict, 'approved');
    assert.match(ran.json.witnesses[0].digest, /^[a-f0-9]{64}$/);
    assert.match(ran.json.repoVerificationResults[0].logDigest, /^[a-f0-9]{64}$/);
    assert.match(ran.json.declaredKitCheckResults[0].logDigest, /^[a-f0-9]{64}$/);
    assert.match(ran.json.receiptDigest, /^[a-f0-9]{64}$/);

    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, ran.json);

    // Missing declaredKitChecks receipt must fail closed (exit 3).
    const missingReceipts = runScript(PUNT_SCRIPT, ['verify', '--envelope', envelopePath, '--root', repoDir, '--execute-repo-commands']);
    assert.equal(missingReceipts.status, 3);
    assert.equal(missingReceipts.json.status, 'failed');
    assert.equal(missingReceipts.json.declaredKitCheckResults[0].passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agy-swarm-sync.mjs accepts canonical SwarmControlViewV1 (checkpoints/roster) and legacy direct plans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-agy-sync-'));
  try {
    const swarmDir = join(dir, 'swarm-state');
    const planInputPath = join(dir, 'control-view.json');
    const controlView = {
      format: 'swarm-control-view/1',
      runId: 'run-1',
      workspaceId: 'ws-1',
      status: 'running',
      generation: 0,
      goal: {
        title: 'Ship public punt and sync helpers',
        line: 'Validate public envelopes and sync Antigravity swarm plan files.',
      },
      checkpoints: [
        { id: 'worker-a', title: 'Implement punt helper', status: 'running' },
        { id: 'worker-b', title: 'Implement swarm sync', status: 'pending' },
      ],
      roster: [
        { name: 'worker-a', role: 'worker', status: 'working' },
      ],
      threads: [
        {
          id: 't-public-bridge',
          title: 'Public host bridges',
          goal: 'Deliver verified public punt and swarm sync scripts.',
          tasks: ['worker-a', 'worker-b'],
        },
      ],
    };
    writeFileSync(planInputPath, JSON.stringify(controlView, null, 2), 'utf8');

    const ran = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', swarmDir, '--plan-json', planInputPath]);
    assert.equal(ran.status, 0, `expected exit 0, got ${ran.status}: ${ran.stdout} ${ran.stderr}`);
    assert.equal(ran.json.ok, true);
    assert.equal(ran.json.taskCount, 2);
    assert.equal(ran.json.threadCount, 1);

    const planPath = join(swarmDir, 'plan.json');
    assert.equal(existsSync(planPath), true);
    const written = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.deepEqual(written, {
      goal: controlView.goal,
      tasks: {
        'worker-a': 'Implement punt helper',
        'worker-b': 'Implement swarm sync',
      },
      threads: controlView.threads,
    });

    const entries = readdirSync(swarmDir);
    assert.deepEqual(entries, ['plan.json']);

    // Stdin mode with direct legacy plan still works.
    const stdinRun = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', swarmDir], {
      input: JSON.stringify({
        goal: {
          title: 'Verify stdin swarm plan sync path',
          line: 'Confirm atomic overwrite from stdin JSON payload.',
        },
        tasks: { 'worker-c': 'Verify stdin' },
        threads: [
          { id: 't-stdin', title: 'Stdin sync', goal: 'Overwrite plan cleanly.', tasks: ['worker-c'] },
        ],
      }),
    });
    assert.equal(stdinRun.status, 0);
    const overwritten = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(overwritten.goal.title, 'Verify stdin swarm plan sync path');

    // Refuses builtin/ directory paths.
    const builtinAttempt = runScript(AGY_SYNC_SCRIPT, ['--swarm-dir', join(dir, 'builtin', 'swarm'), '--plan-json', planInputPath]);
    assert.equal(builtinAttempt.status, 1);
    assert.equal(builtinAttempt.json.error.code, 'IA-SWARM-SYNC-BUILTIN-REFUSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agy-swarm-sync.mjs enforces goal word bounds and thread count bounds', () => {
  const base = {
    goal: { title: 'Four word swarm title', line: 'Short valid summary line.' },
    tasks: { w1: 'Slice one' },
    threads: [{ id: 't-1', title: 'One', goal: 'Finish slice one.', tasks: ['w1'] }],
  };
  assert.ok(validateSwarmPlan(base));

  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, title: 'Too short title' } }),
    (err) => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, title: 'One two three four five six seven eight nine' } }),
    (err) => err.code === 'IA-PUNT-INVALID-ENVELOPE' || err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  assert.throws(
    () => validateSwarmPlan({ ...base, goal: { ...base.goal, line: 'one two three four five six seven eight nine ten eleven twelve thirteen' } }),
    (err) => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  assert.throws(
    () => validateSwarmPlan({ ...base, threads: [] }),
    (err) => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
  assert.throws(
    () => validateSwarmPlan({
      ...base,
      threads: Array.from({ length: 7 }, (_, i) => ({ id: `t-${i}`, title: `T${i}`, goal: 'Goal.', tasks: ['w1'] })),
    }),
    (err) => err.code === 'IA-SWARM-SYNC-INVALID-PLAN',
  );
});
