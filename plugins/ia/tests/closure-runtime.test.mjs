import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { attestRuntime } from '../scripts/lib/closure-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const profile = JSON.parse(readFileSync(join(root, 'plugins/ia/config/qualified-runtime-3.6.0.json')));
const refused = { code: 'IA-CORE-RUNTIME-UNQUALIFIED' };

test('exact published runtime bytes and dependency boundaries', async t => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ia-runtime-attestation-'));
  try {
    for (const name of Object.keys(profile.packages)) {
      const destination = join(scratch, 'node_modules', name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, 'node_modules', name), destination, { recursive: true });
    }
    const main = join(scratch, 'node_modules/@inventarch/cli/dist/main.js');
    const cli = { main, version: '3.6.0' };
    await t.test('clean archive-qualified cohort can import public native API', async () => {
      const qualified = await attestRuntime(cli);
      assert.equal(qualified.identity.packages.length, 24);
      assert.equal(qualified.identity.nativeLanguageVersion, '3.2.0');
      assert.match(qualified.identity.nodeBinarySha256, /^[a-f0-9]{64}$/);
      assert.equal(typeof (await qualified.importNative('@inventarch/db/editor')).EditorSnapshot, 'function');
      await assert.rejects(qualified.importNative('node:fs'), refused);
      await assert.rejects(qualified.importNative('@inventarch/db/not-exported'), refused);
    });
    await t.test('metadata version alone cannot qualify tampered transitive bytes', async () => {
      const file = join(scratch, 'node_modules/semver/index.js'), original = readFileSync(file);
      try {
        writeFileSync(file, Buffer.concat([original, Buffer.from('\n// changed\n')]));
        await assert.rejects(attestRuntime(cli), refused);
      } finally { writeFileSync(file, original); }
    });
    await t.test('missing dependency cannot fall through to another installation', async () => {
      const path = join(scratch, 'node_modules/@inventarch/graph');
      renameSync(path, path + '.away');
      try { await assert.rejects(attestRuntime(cli), refused); } finally { renameSync(path + '.away', path); }
    });
    await t.test('wrong CLI entry and npx argv refuse before native import', async () => {
      await assert.rejects(attestRuntime({ ...cli, version: '3.2.0' }), refused);
      await assert.rejects(attestRuntime({ ...cli, main: join(dirname(main), 'program.js') }), refused);
      await assert.rejects(attestRuntime({ argv: [process.execPath, main, '--extra'], version: '3.6.0' }), refused);
    });
    await t.test('post-attestation edits and new resolution shadows refuse', async () => {
      const qualified = await attestRuntime(cli);
      const file = join(scratch, 'node_modules/@inventarch/graph/dist/index.js'), original = readFileSync(file);
      try {
        writeFileSync(file, Buffer.concat([original, Buffer.from('\n// later\n')]));
        await assert.rejects(qualified.importNative('@inventarch/db'), refused);
      } finally { writeFileSync(file, original); }
      const shadow = join(scratch, 'node_modules/@inventarch/db/dist/node_modules');
      mkdirSync(shadow);
      try { await assert.rejects(qualified.importNative('@inventarch/db'), refused); } finally { rmSync(shadow, { recursive: true }); }
    });
    await t.test('ambient module injection refuses', async () => {
      const prior = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = '--import=untrusted.mjs';
      try { await assert.rejects(attestRuntime(cli), refused); } finally {
        if (prior === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prior;
      }
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
