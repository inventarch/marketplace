// Repository integrity checks for proposed expectation data, not a conformance evaluator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const baselineFile = new URL('../docs/kit-contract/expectations.json', import.meta.url);
const contextFile = new URL('../docs/kit-contract/context.md', import.meta.url);
// Fixed review inputs; never recomputed from the artifacts by this test.
const semanticDigest = '71e0ed8a712a27d0ff32c8076b033f5cc4880e07a5015212303dad3ce77534f7';
const expectationTextDigest = '99a2bbc49c2575b42ef2d4522d572955af3e1332db54fc87861dbc7e6f726c1e';
const contextDigest = 'c6278e3d61f2773759b176e562b01eee4565ff67098d0ef30c453180f98a6d1d';
const inventory = {
  'kit-conformance-contract': [8, 86],
  'kit-conformance-input-contract': [2, 34],
  'kit-migration-programme-contract': [1, 6],
  'kit-conformance-execution-contract': [3, 37],
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const normalized = text => text.replace(/\r\n/g, '\n');
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function readExpectationText() {
  assert.ok(existsSync(baselineFile), 'the complete proposed public expectation baseline must be supplied');
  return decode(readFileSync(baselineFile));
}
function readBaseline() {
  return JSON.parse(readExpectationText());
}
function readContext() {
  assert.ok(existsSync(contextFile), 'normative context must accompany the cases');
  return decode(readFileSync(contextFile));
}
function assertPinned(data) {
  assert.equal(sha256(canonical(data)), semanticDigest, 'normative expectation drift needs independent review and a versioned delta');
}
function assertTextPinned(text) {
  assert.equal(sha256(normalized(text)), expectationTextDigest, 'expectation text drift');
}
function assertContextPinned(text) {
  assert.equal(sha256(normalized(text)), contextDigest, 'normative context drift');
}

function assertStructure(data) {
  assert.equal(data.format, 1);
  assert.equal(data.standing, 'proposed');
  assert.deepEqual(data.contracts.map(c => c.id).sort(), Object.keys(inventory).sort());
  const ids = new Set();
  for (const contract of data.contracts) {
    assert.equal(contract.kind, 'contract');
    for (const field of ['owner', 'version', 'says']) assert.ok(typeof contract[field] === 'string' && contract[field].trim(), `missing contract ${field}`);
    const [requirements, cases] = inventory[contract.id];
    assert.equal(contract.requirements.length, requirements);
    assert.equal(contract.requirements.flatMap(r => r.cases).length, cases);
    for (const requirement of contract.requirements) {
      assert.ok(typeof requirement.says === 'string' && requirement.says.trim(), 'missing requirement intent');
      assert.ok(!ids.has(requirement.id), `duplicate requirement ${requirement.id}`);
      ids.add(requirement.id);
      assert.equal(requirement.check.evaluator, 'unavailable: checker qualification pending');
      for (const example of requirement.cases) {
        assert.ok(!ids.has(example.id), `duplicate case ${example.id}`);
        ids.add(example.id);
        for (const field of ['id', 'kind', 'given', 'request', 'expected']) {
          assert.equal(typeof example[field], 'string');
          assert.ok(example[field].trim(), `${example.id} requires ${field}`);
        }
        assert.equal(example.evaluator, 'unavailable: checker qualification pending');
        assert.ok(['success', 'refusal', 'resumption', 'escalation'].includes(example.kind), 'unknown case kind');
      }
    }
  }
}
test('baseline integrity: all four contracts retain their requirement and case inventory', () => {
  assertStructure(readBaseline());
});

test('baseline integrity: every normative field and association matches the fixed public semantic pin', () => {
  assertPinned(readBaseline());
});

test('baseline integrity: exact expectation text matches its fixed approval pin', () => {
  assertTextPinned(readExpectationText());
});

test('baseline integrity: the complete normative context matches its fixed text pin', () => {
  // Git may check text out with CRLF; only line-ending representation is normalized.
  assertContextPinned(readContext());
});
test('baseline integrity: exact expectation text rejects hidden duplicate-key semantics', () => {
  const text = readExpectationText();
  assertTextPinned(text);
  const duplicate = text.replace('"expected":', '"expected": "Always pass.", "expected":');
  assert.notEqual(duplicate, text);
  assertPinned(JSON.parse(duplicate)); // Demonstrates why parsed-value identity alone is insufficient.
  assert.throws(() => assertTextPinned(duplicate), /expectation text drift/);
});
test('baseline integrity: CRLF representation preserves both text pins', () => {
  const expectations = normalized(readExpectationText());
  const context = normalized(readContext());
  assertTextPinned(expectations);
  assertContextPinned(context);
  assertTextPinned(expectations.replace(/\n/g, '\r\n'));
  assertContextPinned(context.replace(/\n/g, '\r\n'));
  assert.throws(() => assertTextPinned('\ufeff' + expectations), /expectation text drift/);
  assert.throws(() => assertContextPinned('\ufeff' + context), /normative context drift/);
});
test('baseline integrity: context edits, omissions and trailing-newline loss fail', () => {
  const text = normalized(readContext());
  assertContextPinned(text);
  for (const changed of [text + 'changed', text.slice(1), text.trimEnd(), text.replace(/## Applicability tiers[\s\S]*?## Derivation and completion/, '## Derivation and completion')]) {
    assert.notEqual(changed, text);
    assert.throws(() => assertContextPinned(changed), /normative context drift/);
  }
});
test('baseline integrity: malformed UTF-8 cannot be decoded lossily', () => {
  assert.throws(() => decode(Buffer.from([0xc3, 0x28])), TypeError);
  assert.equal(decode(Buffer.from('valid UTF-8')), 'valid UTF-8');
});
test('baseline integrity: structural checks reject defects independently of pins', () => {
  const data = readBaseline();
  assertStructure(data);
  for (const mutate of [
    value => { value.contracts[0].requirements[0].cases[1].id = value.contracts[0].requirements[0].cases[0].id; },
    value => { delete value.contracts[0].owner; },
    value => { value.contracts[0].requirements[0].says = ''; },
    value => { value.contracts[0].requirements[0].cases[0].kind = 'passed'; },
    value => { value.contracts[0].requirements[0].cases[0].evaluator = 'passed'; },
    value => { value.contracts[0].requirements[1].id = value.contracts[0].requirements[0].id; },
    value => { value.contracts[0].requirements[0].check.evaluator = 'passed'; },
    value => { value.standing = 'accepted'; },
  ]) {
    const broken = structuredClone(data);
    mutate(broken);
    assert.throws(() => assertStructure(broken), assert.AssertionError);
  }
});

const mutations = {
  'missing contract': data => data.contracts.pop(),
  'missing case': data => data.contracts[0].requirements[0].cases.pop(),
  'duplicate case at unchanged count': data => {
    const cases = data.contracts[0].requirements[0].cases;
    cases[1] = structuredClone(cases[0]);
  },
  'reassigned cases at unchanged counts': data => {
    const [a, b] = data.contracts[0].requirements;
    [a.cases[0], b.cases[0]] = [b.cases[0], a.cases[0]];
  },
  'changed given context': data => { data.contracts[0].requirements[0].cases[0].given += ' changed'; },
  'weakened expectation': data => { data.contracts[0].requirements[0].cases[0].expected = 'Always pass.'; },
  'changed requirement intent': data => { data.contracts[0].requirements[0].says = 'Optional.'; },
  'fabricated evaluator': data => { data.contracts[0].requirements[0].check.evaluator = 'passed'; },
  'omitted existing grammar metadata': data => { delete data.contracts[0].requirements[0].cases[0].variantId; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`baseline integrity rejects ${name}`, () => {
    const data = readBaseline();
    assertPinned(data); // Control must pass before the negative example is meaningful.
    mutate(data);
    assert.throws(() => assertPinned(data), /normative expectation drift/);
  });
}
