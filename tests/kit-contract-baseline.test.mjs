// Repository integrity checks for proposed expectation data, not a conformance evaluator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const baselineFile = new URL('../docs/kit-contract/expectations.json', import.meta.url);
const contextFile = new URL('../docs/kit-contract/context.md', import.meta.url);
// Reviewed pins are independent of the file under test. No update-snapshot path.
const semanticDigest = '71e0ed8a712a27d0ff32c8076b033f5cc4880e07a5015212303dad3ce77534f7';
const contextDigest = '2f418a389b2e210cfec972d15a929778bba3f04a4fd4c938549b3418f21959dc';
const inventory = {
  'kit-conformance-contract': [8, 86],
  'kit-conformance-input-contract': [2, 34],
  'kit-migration-programme-contract': [1, 6],
  'kit-conformance-execution-contract': [3, 37],
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function readBaseline() {
  assert.ok(existsSync(baselineFile), 'the complete proposed public expectation baseline must be supplied');
  return JSON.parse(readFileSync(baselineFile, 'utf8'));
}
function assertPinned(data) {
  assert.equal(sha256(canonical(data)), semanticDigest, 'normative expectation drift needs independent review and a versioned delta');
}

test('baseline integrity: all four contracts retain their requirement and case inventory', () => {
  const data = readBaseline();
  assert.equal(data.format, 1);
  assert.equal(data.standing, 'proposed');
  assert.deepEqual(data.contracts.map(c => c.id).sort(), Object.keys(inventory).sort());
  const ids = new Set();
  for (const contract of data.contracts) {
    assert.equal(contract.kind, 'contract');
    const [requirements, cases] = inventory[contract.id];
    assert.equal(contract.requirements.length, requirements);
    assert.equal(contract.requirements.flatMap(r => r.cases).length, cases);
    for (const requirement of contract.requirements) {
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
      }
    }
  }
});

test('baseline integrity: every normative field and association matches the fixed public semantic pin', () => {
  assertPinned(readBaseline());
});

test('baseline integrity: the complete normative context matches its fixed text pin', () => {
  assert.ok(existsSync(contextFile), 'normative context must accompany the cases');
  // Git may check text out with CRLF; only line-ending representation is normalized.
  assert.equal(sha256(readFileSync(contextFile, 'utf8').replace(/\r\n/g, '\n')), contextDigest);
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
  'omitted grammar association': data => { delete data.contracts[0].requirements[0].cases[0].variantId; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`baseline integrity rejects ${name}`, () => {
    const data = readBaseline();
    assertPinned(data); // Control must pass before the negative example is meaningful.
    mutate(data);
    assert.throws(() => assertPinned(data), /normative expectation drift/);
  });
}
