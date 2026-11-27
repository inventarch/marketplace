// One scenario table through the three seal verifiers. check-seal is the reference: check-design-patterns and
// check-prds must reach its verdict on the same workspace, a fresh quorum-2, current-revision workspace per scenario
// (helpers/sequential-signers.mjs). A kit check that fails must also say the governed record is unsealed.
// The edit scenarios change a second record after both seals in ways a line-based strip of @approval blocks could
// undo: text that holds approval-shaped lines, a record moved into an approval's text value, a local word that
// declares the approval facet (also carrying a valid copy of a seal). Each must leave the governed record unsealed in
// all three verifiers, and check-seal must say why: the governed record is unratified, not only a file malformed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { passes } from '../config/kits/ia-approval/scripts/check-seal.mjs';
import { sequentialSigners } from './helpers/sequential-signers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const KITS = {
  design: {
    kit: 'ia-design-base',
    system: 'design-base-system',
    words: 'pattern, recipe',
    target: 'design-base-system/definition/recipe/seq-recipe',
    checkName: 'check-design-patterns',
    kitId: 'inventarch/ia-design-base-kit',
    unsealed: 'ACTIVE_RECIPE_UNSEALED',
    records: `#! ia 1.0

@level seq-atom
  meaning
    says "Atoms."
  level
    rank 1
    stage atom
    title "Atom"

@part seq-btn
  meaning
    says "Button atom."
  part
    name "SeqButton"
    level @level seq-atom
    code-export "@acme/ui#SeqButton"
    standing active

@recipe seq-recipe
  meaning
    says "Active recipe sealed by two approvers."
  recipe
    name "SeqButton Use"
    part "design-base-system/definition/part/seq-btn"
    target "react-tailwind-shadcn"
    mode use
    props ["size -> size"]
    standing active
`,
    other: `#! ia 1.0

@level seq-other
  meaning
    says """
Another level, sealed as it stands.
@kept as part of this text
"""
  level
    rank 3
    stage organism
    title "Other"
`,
    plain: name => `@level ${name}
  meaning
    says "A level the signers sealed."
  level
    rank 2
    stage molecule
    title "Gate"
`,
  },
  product: {
    kit: 'ia-product-base',
    system: 'product-base-system',
    words: 'prd',
    target: 'product-base-system/definition/prd/seq-prd',
    checkName: 'check-prds',
    kitId: 'inventarch/ia-product-base-kit',
    unsealed: 'PRD_UNSEALED',
    records: `#! ia 1.0

@spec seq-spec
  meaning
    says "Checkout specification."
  work
    title "Checkout spec"
    status accepted

@prd seq-prd
  meaning
    says "Checkout flow requirements sealed by two approvers."
    problem "Cart abandonment rises when totals appear late."
  scope
    goals ["Show itemized totals upfront"]
    non-goals ["Subscription billing"]
    requirements ["CHK-01: Render line-item totals before payment step"]
  governance
    status ratified
    source "docs/prd/checkout.md"
  relationships
    grounds @spec seq-spec
`,
    other: `#! ia 1.0

@spec seq-other
  meaning
    says """
Another specification, sealed as it stands.
@kept as part of this text
"""
  work
    title "Other spec"
    status accepted
`,
    plain: name => `@spec ${name}
  meaning
    says "A spec the signers sealed."
  work
    title "Gate spec"
    status accepted
`,
  },
};

// A local system whose word declares the approval facet; ia validate admits it.
const MEMO_SYSTEM = `#! ia 1.0

@system memo-system
  provider "local"
  version "0.1.0"
  describes "Local memos."
  steward @agent memo-system-steward
  requires
    - agent-system
    - compliance-system
    - governance-system
    - work-system
    - workspace-system
  discriminators
    memo lowers to definition
      category evidence
      facets [approval]
      schema @schema memo
      artifact-set product-definition
      primitive Attention
      move Observation

@agent memo-system-steward
  meaning
    says "Owns memos."
    answers "Who owns memos?"
  governance
    applies [memo]

@mandate memo-system-stewardship
  meaning
    says "Memo stewardship."
    answers "Which moves may the memo steward make?"
  governance
    requires "Nothing more."
  authority
    participant @agent memo-system-steward
    moves [Observation]
    covers [".ia/src/systems/memo-system/"]
`;
const MEMO_SCHEMA = `#! ia 1.0

@schema memo
  lowers to definition
  sections
    must have meaning
    closed
  fields
    must have meaning.says as text
`;
const MEMO = `#! ia 1.0

@memo m1
  meaning
    says """
Memo text the signers sealed.
@kept as part of this text
"""
`;
// The approval schema with every seal field optional, plus a notes section: a memo may carry a seal and still be a memo.
const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `the approval schema has ${JSON.stringify(from)}`);
  return text.replace(from, to);
};
const SEALABLE_MEMO_SCHEMA = (() => {
  let text = readFileSync(join(REPO_ROOT, 'kits/ia-approval/.ia/src/systems/approval-system/schemas/approval.schema.ia'), 'utf8');
  text = replaceOnce(text, '@schema approval', '@schema memo');
  text = replaceOnce(text, '    must have seal\n', '    may have seal\n    may have notes\n');
  text = replaceOnce(text, '    must have meaning.answers as text\n', '    may have meaning.answers as text\n    may have notes.says as text\n');
  return text.replace(/^ {4}must have seal\./gm, '    may have seal.');
})();
const addMemoSystem = (pair, schema) => {
  pair.edit('systems/memo-system/system.ia', MEMO_SYSTEM);
  pair.edit('systems/memo-system/schemas/memo.schema.ia', schema);
  pair.edit('workspace.ia', pair.read('workspace.ia').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system memo-system]'));
};
// The memo edited after both seals, carrying signer a's seal section: a strip of the file's lines from each @approval
// to the next @ line gives back the sealed memo byte for byte, and a verifier that takes any record of the approval
// facet for an approval finds a well-formed one to strip.
const sealedMemoEdit = pair => {
  const approval = readFileSync(join(pair.ws, pair.approvalPath('a')), 'utf8');
  const seal = approval.slice(approval.indexOf('\n  seal\n') + 1).replace(/\n {2}relationships\n[\s\S]*$/, '\n');
  assert.ok(seal.startsWith('  seal\n') && seal.includes('    signature '), "signer a's seal section");
  return `#! ia 1.0

@memo m1
  meaning
    says """
Memo text the signers sealed.
@approval note
Edited after both seals, never signed.
"""
${seal.trimEnd()}
  notes
    says """
@kept as part of this text
"""
`;
};

const sealBoth = pair => {
  pair.sealFirst();
  pair.sealSecond({ onPreSeal: true });
};
// Signer a's approval, renamed and without its pragma line: the same seal fields and a valid signature.
const approvalCopy = (pair, name) =>
  readFileSync(join(pair.ws, pair.approvalPath('a')), 'utf8')
    .replace('#! ia 1.0\n', '')
    .replace(/^@approval (\S+)/m, `@approval ${name}`)
    .replace(/^\n+/, '');
// Text edited after the seals whose new lines look like the start of an @approval.
const approvalShaped = text => text.replace('@kept as part of this text', '@approval note\nAdded after both seals.\n@kept as part of this text');
// A different character of the same alphabet at the start of the signature: still well formed, no longer valid.
const forgeSignature = file => {
  const text = readFileSync(file, 'utf8');
  const forged = text.replace(/(signature\s+")([^"]+)/, (_, head, signature) => {
    const first = signature[0];
    const swapped = /^[0-9a-f]+$/.test(signature) ? ((parseInt(first, 16) + 1) % 16).toString(16) : first === 'A' ? 'B' : 'A';
    return `${head}${swapped}${signature.slice(1)}`;
  });
  assert.notEqual(forged, text, 'the approval carries a signature to forge');
  writeFileSync(file, forged);
};

const SCENARIOS = [
  {
    name: 'one of two signers',
    passes: false,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      pair.sealFirst();
    },
  },
  {
    name: 'two signers on one revision',
    passes: true,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      sealBoth(pair);
    },
  },
  {
    name: 'sequential signers',
    passes: true,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      pair.sealFirst();
      pair.sealSecond();
    },
  },
  {
    name: 'a forged signature',
    passes: false,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      sealBoth(pair);
      forgeSignature(join(pair.ws, pair.approvalPath('a')));
    },
  },
  {
    name: 'a post-seal edit to another record',
    passes: false,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      sealBoth(pair);
      pair.edit('other.ia', kit.other.replace('sealed as it stands.', 'sealed as it stands, then edited.'));
    },
  },
  {
    name: 'a post-seal edit with approval-shaped lines, beside a misfiled approval',
    passes: false,
    misnamed: true,
    run: (pair, kit) => {
      pair.edit('other.ia', kit.other);
      sealBoth(pair);
      pair.edit('other.ia', `${approvalShaped(kit.other)}${approvalCopy(pair, 'misfiled-copy')}`);
    },
  },
  {
    // The edited record lives, from before the seals, in a file named as signer a's approval will be, so the copy
    // beside it is well named and no verifier can call it misfiled.
    name: 'a post-seal edit with approval-shaped lines, in a file named like an approval',
    passes: false,
    run: (pair, kit) => {
      const decoy = `notes/${pair.approvalFileName('a')}`;
      pair.edit(decoy, kit.other);
      sealBoth(pair);
      pair.edit(decoy, `${approvalShaped(kit.other)}${approvalCopy(pair, 'decoy-copy')}`);
    },
  },
  {
    // A sealed record deleted after the seals: its text sits inside an approval copy's text value, which a line-based
    // strip of the file's @approval blocks would turn back into the record.
    name: 'a sealed record deleted, its text kept inside an approval',
    passes: false,
    run: (pair, kit) => {
      const decoy = `notes/${pair.approvalFileName('a')}`;
      const gate = kit.plain('seq-gate');
      pair.edit(decoy, `#! ia 1.0\n\n${gate}`);
      sealBoth(pair);
      const copy = approvalCopy(pair, 'decoy-copy').replace(/^ {4}says "[^"\n]*"\n/m, `    says """\n${gate}@approval tail """\n`);
      assert.ok(copy.includes('@approval tail'), "the copy's text value now holds the deleted record");
      pair.edit(decoy, `#! ia 1.0\n\n${copy}`);
    },
  },
  {
    // A record of a local word that declares the approval facet is no approval: an edit to it must be seen.
    name: 'a post-seal edit to a local word that declares the approval facet',
    passes: false,
    run: pair => {
      addMemoSystem(pair, MEMO_SCHEMA);
      const decoy = `notes/${pair.approvalFileName('a')}`;
      pair.edit(decoy, MEMO);
      sealBoth(pair);
      pair.edit(decoy, `${approvalShaped(MEMO)}${approvalCopy(pair, 'decoy-copy')}`);
    },
  },
  {
    // The same local word, now carrying a valid copy of a seal, so no verifier can call it a malformed approval: only
    // counting approval-system's @approval alone as an approval keeps its post-seal edit from being stripped away.
    name: 'a post-seal edit to a local word that declares the approval facet and carries a seal',
    passes: false,
    run: pair => {
      addMemoSystem(pair, SEALABLE_MEMO_SCHEMA);
      const decoy = `notes/${pair.approvalFileName('a')}`;
      pair.edit(decoy, MEMO);
      sealBoth(pair);
      pair.edit(decoy, sealedMemoEdit(pair));
    },
  },
];

for (const [kitName, kit] of Object.entries(KITS)) {
  for (const scenario of SCENARIOS) {
    test(`seal verifiers agree on ${scenario.name} (${kitName})`, { skip: SKIP_CLI }, t => {
      const pair = sequentialSigners(t, { cli: CLI, ...kit });
      scenario.run(pair, kit);
      const result = pair.check();
      const seal = pair.sealReport();
      assert.equal(passes(seal), scenario.passes, `check-seal on ${scenario.name}: ${JSON.stringify(seal.findings)}`);
      if (!scenario.passes) {
        assert.ok(
          seal.findings.some(f => f.name === 'unratified' && f.subject === kit.target),
          `check-seal reports ${kit.target} unratified: ${JSON.stringify(seal.findings)}`,
        );
      }
      assert.equal(result.status, scenario.passes ? 0 : 3, result.output);
      const codes = result.findings.map(f => f.code);
      if (!scenario.passes) assert.ok(codes.includes(kit.unsealed), `${kit.checkName} reports ${kit.unsealed}: ${result.output}`);
      if (scenario.misnamed) assert.ok(codes.includes('APPROVAL_FILE_MISNAMED'), `${kit.checkName} reports APPROVAL_FILE_MISNAMED: ${result.output}`);
    });
  }
}
