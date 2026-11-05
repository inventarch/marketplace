import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const agentsDir = new URL('../agents/', import.meta.url);

function tools(name) {
  const text = readFileSync(fileURLToPath(new URL(`${name}.md`, agentsDir)), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('tools:'));
  assert.ok(line, `${name} declares tools`);
  return line
    .slice('tools:'.length)
    .split(',')
    .map((t) => t.trim());
}

// The plugin ships the IA door as its MCP server `ia` (.mcp.json), so Claude Code names its tools
// mcp__plugin_ia_ia__<tool> (plugin ia, server ia); a bare server key such as mcp__ia-workspace never matches them.
const DOOR = ['ia_session', 'ia_catalogue', 'ia_method'].map((t) => `mcp__plugin_ia_ia__${t}`);
const MCP = JSON.parse(readFileSync(fileURLToPath(new URL('../.mcp.json', import.meta.url)), 'utf8'));

test('every agent lists the door tools by their plugin-scoped names, and only door tools', () => {
  // The core also bundles the account connector `inventarch` (decision public-account-connector); only ia:init, in the main session, uses it.
  assert.deepEqual(Object.keys(MCP.mcpServers), ['ia', 'inventarch'], 'the door is named ia, the account connector inventarch');
  for (const name of ['reader', 'checker', 'worker']) {
    const listed = tools(name);
    for (const tool of DOOR) assert.ok(listed.includes(tool), `${name} lists ${tool}`);
    assert.ok(!listed.some((t) => t.startsWith('mcp__plugin_ia_inventarch__')), `${name} lists no account connector tool`);
    for (const tool of listed.filter((t) => t.startsWith('mcp__'))) assert.match(tool, /^mcp__plugin_ia_ia__ia_[a-z_]+$/, `${name}: ${tool}`);
  }
  assert.ok(!tools('checker').includes('mcp__plugin_ia_ia__ia_read'), 'the checker reads no records through the door');
  assert.ok(!tools('reader').includes('Bash') && !tools('reader').includes('Edit'), 'the reader stays read-only');
});
