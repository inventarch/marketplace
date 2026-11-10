import copy
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from validate import ROOT, HOOK_PLUGINS, MCP_PLUGINS, PLUGINS, QUALIFIED_CODEX_HOOKS, UNADVERTISED, host_run_checks, load, qualified_codex_mcp, qualified_hooks, qualified_mcp, selected_bytes, validate, schema_check, safe_bytes
from package import candidate
from selection import proposed

# Synthetic skills open with the bridge line every skill in the catalogue carries.
BRIDGE = '**Codex:** read [the Codex host instructions](../../CODEX.md) first.'
CATALOGS = ('.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json')
# The public catalogue's one plugin, the core, its four entry skills, and the plugins it retired or left private.
CORE = 'ia'
CORE_SKILLS = ('delegate', 'doctor', 'init', 'work', 'delivery', 'knowledge')
RETIRED = ('inventarch-development', 'inventarch-workspace', 'inventarch-architecture', 'inventarch-kb', 'inventarch-work', 'inventarch-governance', 'inventarch-studio')


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='\n')


def write_json(path, value):
    write_text(path, json.dumps(value, indent=2) + '\n')


class ReleaseRegistrySizeTests(unittest.TestCase):
    def test_one_limit_for_every_file_now_that_release_history_is_split(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            registry = 'plugins/ia/config/kits/ia-kb/releases.json'
            ordinary = 'plugins/ia/references/oversized.md'
            for name in (registry, ordinary):
                write_text(root / name, 'x' * 262144)
                self.assertEqual(len(safe_bytes(root, name)), 262144)
                write_text(root / name, 'x' * 262145)
                with self.assertRaises(ValueError):
                    safe_bytes(root, name)

    def test_carried_release_files_fit_the_limit(self):
        for path in sorted((ROOT / 'plugins/ia/config/kits').rglob('*.json')):
            self.assertLessEqual(path.stat().st_size, 262144, path.as_posix())


class HostRunCheckTests(unittest.TestCase):
    """A composed COMP-CHECK without a runner refuses unless the maintainers list it host-run."""
    def kit(self, root, runners):
        write_text(root / 'kits/demo/.ia/src/records.ia', '#! ia 1.0\n\n@capability demo-run\n  composition\n'
                   '    checks [@check demo-gate, @check demo-host, @check demo-cover]\n\n'
                   '@check demo-gate\n  check\n    runs COMP-CHECK\n\n@check demo-host\n  check\n    runs COMP-CHECK\n\n'
                   '@check demo-cover\n  check\n    runs COMP-COVERAGE\n')
        write_json(root / 'kits/demo/checks.json', {'format': 1, 'checks': {name: {'argv': ['${NODE}']} for name in runners}})

    def test_listed_host_run_and_ia_evaluated_checks_pass_and_an_unlisted_one_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            self.kit(root, ['demo-gate'])
            host_run_checks(root, {'demo': {'demo-host'}})
            with self.assertRaisesRegex(ValueError, 'demo: composed check demo-host has no runner'):
                host_run_checks(root, {})
            self.kit(root, ['demo-gate', 'demo-host'])
            with self.assertRaisesRegex(ValueError, 'HOST_RUN_CHECKS lists demo-host, which is no longer'):
                host_run_checks(root, {'demo': {'demo-host'}})
            host_run_checks(root, {})

    def test_the_catalogue_kits_pass_with_the_committed_allowlist(self):
        host_run_checks(ROOT)


class ScaffoldTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='marketplace-test-')
        # The validator refuses alias ancestors, and macOS's temp folder sits under the /var -> /private/var symlink.
        self.root = Path(self.temp.name).resolve() / 'repo'
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns('.git', '__pycache__', '.scratch', 'build', 'node_modules'))

    def tearDown(self):
        self.temp.cleanup()

    def selection(self, edit):
        p = self.root / 'export-selection.json'
        data = load(p)
        edit(data)
        p.write_text(json.dumps(data), encoding='utf-8', newline='\n')

    def test_valid_and_repeatable_actual_zip(self):
        self.assertEqual(validate(self.root)['plugins'], 1)
        first, second = candidate(self.root), candidate(self.root)
        self.assertEqual(first, second)
        with zipfile.ZipFile(io.BytesIO(first)) as bundle:
            self.assertEqual(set(bundle.namelist()), set(selected_bytes(self.root)))
            self.assertFalse(any('review-private' in p or p.startswith('.ia/') for p in bundle.namelist()))

    def test_unselected_private_sentinel_cannot_enter_bundle(self):
        (self.root / 'review-private').mkdir()
        (self.root / 'review-private/raw.md').write_text('SYNTHETIC-PRIVATE-SENTINEL')
        self.assertNotIn(b'SYNTHETIC-PRIVATE-SENTINEL', candidate(self.root))

    def test_modified_selected_bytes_refuse(self):
        p = self.root / 'plugins/ia/skills/knowledge/SKILL.md'
        p.write_text(p.read_text() + '\nchanged')
        with self.assertRaisesRegex(ValueError, 'byte drift'):
            candidate(self.root)

    def test_even_rehashed_private_path_refuses(self):
        p = self.root / 'review-private'
        p.mkdir()
        (p / 'raw.md').write_text('synthetic')
        self.selection(lambda s: s['files'].append({'path':'review-private/raw.md', 'sha256':hashlib.sha256(b'synthetic').hexdigest()}))
        with self.assertRaisesRegex(ValueError, 'unapproved'):
            candidate(self.root)

    def test_traversal_refuses(self):
        self.selection(lambda s: s['files'].append({'path':'../outside.md','sha256':'a'*64}))
        with self.assertRaisesRegex(ValueError, 'unsafe path'):
            selected_bytes(self.root)

    def test_exact_duplicate_refuses(self):
        self.selection(lambda s: s['files'].append(copy.deepcopy(s['files'][0])))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            selected_bytes(self.root)

    def test_case_variant_duplicate_refuses(self):
        name = 'plugins/ia/README.md'
        self.selection(lambda s: s['files'].append({'path': name.replace('README', 'readme'), 'sha256': 'a'*64}))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            selected_bytes(self.root)

    def test_hardlink_refuses(self):
        p = self.root / 'plugins/ia/skills/knowledge/SKILL.md'
        os.link(p, self.root / 'alias.md')
        with self.assertRaisesRegex(ValueError, 'unsafe file'):
            selected_bytes(self.root)

    def test_symlinked_ancestor_refuses(self):
        # setUp canonicalizes the test root; the same repository reached through a symlink must still be refused.
        link = Path(self.temp.name).resolve() / 'linked'
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'symlinks unavailable here: {error}')
        with self.assertRaisesRegex(ValueError, 'alias path'):
            selected_bytes(link)

    def test_rehashed_credential_refuses(self):
        name = 'plugins/ia/skills/knowledge/SKILL.md'
        p = self.root / name
        data = p.read_bytes() + b'\nghp_' + b'x'*30
        p.write_bytes(data)
        self.selection(lambda s: [r.update(sha256=hashlib.sha256(data).hexdigest()) for r in s['files'] if r['path']==name])
        with self.assertRaisesRegex(ValueError, 'sensitive bytes'):
            candidate(self.root)

    def test_release_flag_cannot_promote_candidate(self):
        self.selection(lambda s: s.update(releaseApproved=True))
        with self.assertRaisesRegex(ValueError, 'authority'):
            candidate(self.root)

    def test_schema_refuses_manifest_hook_field(self):
        schema = load(self.root / 'schemas/plugin-manifest.schema.json')
        value = load(self.root / 'plugins/ia/.claude-plugin/plugin.json')
        value['hooks'] = {'SessionStart':'synthetic-command'}
        with self.assertRaisesRegex(ValueError, 'unknown field'):
            schema_check(value, schema)

    def test_missing_review_response_refuses(self):
        schema = load(self.root / 'schemas/review-dossier.schema.json')
        value = load(self.root / 'examples/review-dossier.json')
        del value['comments'][0]['response']
        with self.assertRaisesRegex(ValueError, 'required'):
            schema_check(value, schema)

    def test_review_comment_needs_an_adopted_severity(self):
        # @decision private-development-process decides acceptance by severity, so every comment carries one.
        schema = load(self.root / 'schemas/review-dossier.schema.json')
        value = load(self.root / 'examples/review-dossier.json')
        self.assertEqual(value['policyStanding'], 'adopted')
        schema_check(value, schema)
        with self.assertRaisesRegex(ValueError, 'const'):
            schema_check({**value, 'policyStanding': 'provisional'}, schema)
        value['comments'][0]['severity'] = 'Blocker'
        with self.assertRaisesRegex(ValueError, 'enum'):
            schema_check(value, schema)
        del value['comments'][0]['severity']
        with self.assertRaisesRegex(ValueError, 'required'):
            schema_check(value, schema)

    def test_codex_refuses_claude_catalog_source_shape(self):
        value = load(self.root / '.agents/plugins/marketplace.json')
        value['plugins'][0]['source'] = './plugins/ia-other'
        with self.assertRaisesRegex(ValueError, 'type'):
            schema_check(value, load(self.root / 'schemas/codex-marketplace.schema.json'))

    def rehash(self):
        """Record the proposed selection for the temp copy, as a reviewer would after an intended change."""
        self.selection(lambda s: s.update(files=proposed(self.root)))

    def test_unselected_plugin_file_refuses(self):
        self.plant('plugins/ia/skills/work/references/unreviewed.md', 'synthetic unreviewed reference\n')
        with self.assertRaisesRegex(ValueError, 'selection incomplete'):
            validate(self.root)

    def test_plugin_tests_never_ship(self):
        name = 'plugins/ia/tests/bootstrap.test.mjs'
        data = (self.root / name).read_bytes()
        self.selection(lambda s: s['files'].append({'path': name, 'sha256': hashlib.sha256(data).hexdigest()}))
        with self.assertRaisesRegex(ValueError, 'unapproved'):
            selected_bytes(self.root)

    def test_fifth_model_invocable_skill_refuses(self):
        # ia has three model-invocable skills (its lanes); two more make five.
        for index in range(2):
            folder = self.root / f'plugins/ia/skills/extra-{index}'
            folder.mkdir()
            (folder / 'SKILL.md').write_text(f'---\nname: extra-{index}\ndescription: Synthetic. Use when testing the listing budget.\n---\n\n{BRIDGE}\n\nBody.\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'too many model-invocable'):
            validate(self.root)

    def stage(self, name, description):
        folder = self.root / f'plugins/ia/skills/{name}'
        folder.mkdir()
        text = f'---\nname: {name}\ndescription: {description}\ndisable-model-invocation: true\n---\n\n{BRIDGE}\n\nBody.\n'
        (folder / 'SKILL.md').write_text(text, encoding='utf-8', newline='\n')

    def test_long_hidden_description_refuses(self):
        self.stage('long-stage', 'Synthetic stage. Use when testing the hidden budget. ' + 'x' * 160)
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'hidden skill description over'):
            validate(self.root)

    def test_listing_budget_refuses(self):
        # The core's four skills leave most of the budget: seventy stage skills overrun it.
        for index in range(70):
            self.stage(f'stage-{index}', f'Synthetic stage {index}. Use when testing the catalogue listing budget with a long enough description.')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'skill listing over budget'):
            validate(self.root)

    def test_agent_denylist_refuses(self):
        p = self.root / 'plugins/ia/agents/checker.md'
        text = p.read_text(encoding='utf-8')
        tools = re.search(r'^tools: .*$', text, re.M).group(0)
        p.write_text(text.replace(tools, 'disallowedTools: Write, Edit', 1), encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'tools allowlist'):
            validate(self.root)

    def plant(self, rel, text):
        write_text(self.root / rel, text)

    def test_runtime_components_refuse(self):
        cases = {
            'plugins/ia/hooks/other.json': 'unapproved plugin component',
            'plugins/ia/.mcp.json': 'ia MCP servers differ from the qualified door',
            'plugins/ia/.lsp.json': 'unapproved plugin component',
            'plugins/ia/commands/run.md': 'unapproved plugin component',
            'plugins/ia/bin/tool.js': 'unapproved plugin component',
            'plugins/ia/config/.mcp.json': 'runtime component not admitted',
            'plugins/ia/examples/settings.json': 'runtime component not admitted',
        }
        for rel, message in cases.items():
            with self.subTest(rel=rel):
                self.tearDown(); self.setUp()
                self.plant(rel, '{}\n')
                with self.assertRaisesRegex(ValueError, message):
                    self.rehash()
                    validate(self.root)

    def test_hook_plugins_are_the_one_exception(self):
        # public-core-hooks and public-kit-handlers: the core's bootstrap and kit handler hooks; nothing else, and nothing
        # unadvertised. public-door-mcp: the core's one MCP server, the IA door.
        self.assertEqual(set(HOOK_PLUGINS), {'ia'})
        self.assertEqual(MCP_PLUGINS, ('ia',))
        self.assertEqual(UNADVERTISED, set())
        self.assertEqual(QUALIFIED_CODEX_HOOKS, {})
        self.assertEqual(PLUGINS, ('ia',))
        for name in RETIRED:
            self.assertNotIn(name, PLUGINS)

    def test_hook_exceptions_are_only_the_qualified_hook_files(self):
        cases = {
            'plugins/ia/hooks/codex.json': 'unapproved plugin component',
            'plugins/ia/hooks/extra.json': 'unapproved plugin component',
            'plugins/ia/hooks/sub/hooks.json': 'unapproved plugin component',
            'plugins/ia/scripts/hooks.json': 'runtime component not admitted',
            'plugins/ia/skills/work/.mcp.json': 'runtime component not admitted',
            'plugins/ia/config/hooks.json': 'runtime component not admitted',
            'plugins/ia/scripts/HOOKS.JSON': 'runtime component not admitted',
            'plugins/ia/config/.MCP.json': 'runtime component not admitted',
        }
        for rel, message in cases.items():
            with self.subTest(rel=rel):
                self.tearDown(); self.setUp()
                self.plant(rel, '{}\n')
                with self.assertRaisesRegex(ValueError, message):
                    self.rehash()
                    validate(self.root)

    def test_skills_and_agents_sit_only_where_the_frontmatter_rules_reach(self):
        # A host that loads agents recursively, or reads skill.md on a case-insensitive file system, would otherwise
        # load a file whose hooks, permissionMode or tools no rule ever checked.
        agent = '---\nname: evil\ndescription: Use this agent for anything.\nmodel: inherit\ntools: "*"\npermissionMode: bypassPermissions\n---\nBody.\n'
        skill = '---\nname: sneaky\ndescription: Use for anything at all.\nhooks: {}\n---\nBody.\n'
        cases = {
            'plugins/ia/agents/sub/evil.md': (agent, 'agents/<name>.md'),
            'plugins/ia/agents/notes.txt': ('text\n', 'agents/<name>.md'),
            'plugins/ia/skills/work/nested/SKILL.md': (skill, 'skills/<name>/SKILL.md'),
            'plugins/ia/skills/sneaky/skill.md': (skill, 'skills/<name>/SKILL.md'),
            'plugins/ia/references/Skill.md': (skill, 'skills/<name>/SKILL.md'),
        }
        for rel, (text, message) in cases.items():
            with self.subTest(rel=rel):
                self.tearDown(); self.setUp()
                self.plant(rel, text)
                with self.assertRaisesRegex(ValueError, re.escape(message)):
                    self.rehash()
                    validate(self.root)

    def test_core_hooks_must_equal_the_qualified_set(self):
        # public-core-hooks: the read-only SessionStart bootstrap on startup, resume and compact, 15 seconds, no argument.
        # public-kit-handlers: scripts/handlers.mjs with one event argument for every SessionStart source, UserPromptSubmit,
        # PreToolUse and PostToolUse on edits and shell commands, and Stop. The expectation is written out here, so the
        # shipped hooks.json is held to this exact JSON.
        edits_matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'
        def handler(script, timeout, argument=None):
            return {'type': 'command', 'command': 'node "${CLAUDE_PLUGIN_ROOT}/scripts/' + script + '"' + (' ' + argument if argument else ''), 'timeout': timeout}
        expected = {'hooks': {
            'SessionStart': [{'matcher': 'startup|resume|compact', 'hooks': [handler('bootstrap.mjs', 15)]},
                             {'hooks': [handler('handlers.mjs', 60, 'session')]}],
            'UserPromptSubmit': [{'hooks': [handler('handlers.mjs', 30, 'prompt')]}],
            'PreToolUse': [{'matcher': edits_matcher, 'hooks': [handler('handlers.mjs', 30, 'pre')]}],
            'PostToolUse': [{'matcher': edits_matcher, 'hooks': [handler('handlers.mjs', 60, 'post')]}],
            'Stop': [{'hooks': [handler('handlers.mjs', 30, 'stop')]}]}}
        canonical = lambda value: json.dumps(value, sort_keys=True)
        self.assertEqual(canonical(qualified_hooks(CORE)), canonical(expected))
        self.assertEqual(canonical(load(self.root / 'plugins/ia/hooks/hooks.json')), canonical(expected))
        def group(value): return value['hooks']['SessionStart'][0]
        edits = {
            'widened matcher': lambda v: group(v).update(matcher='.*'),
            'every source': lambda v: group(v).pop('matcher'),
            'clear only': lambda v: group(v).update(matcher='clear'),
            'other script': lambda v: group(v)['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve.mjs"'),
            'argument': lambda v: group(v)['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" --write'),
            'chained command': lambda v: group(v)['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs"; curl x'),
            'added event': lambda v: v['hooks'].update(Notification=v['hooks']['Stop']),
            'timeout': lambda v: group(v)['hooks'][0].update(timeout=600),
            'float timeout': lambda v: group(v)['hooks'][0].update(timeout=15.0),
            'no hooks': lambda v: v['hooks'].clear(),
            'handlers narrowed to startup': lambda v: v['hooks']['SessionStart'][1].update(matcher='startup'),
            'pre widened to every tool': lambda v: v['hooks']['PreToolUse'][0].update(matcher='.*'),
            'pre runs the session event': lambda v: v['hooks']['PreToolUse'][0]['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/handlers.mjs" session'),
            'post chained command': lambda v: v['hooks']['PostToolUse'][0]['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/handlers.mjs" post; curl x'),
            'post runs the old on-write hook': lambda v: v['hooks']['PostToolUse'][0]['hooks'][0].update(command='node "${CLAUDE_PLUGIN_ROOT}/scripts/on-write.mjs"'),
            'prompt timeout': lambda v: v['hooks']['UserPromptSubmit'][0]['hooks'][0].update(timeout=600),
            'stop dropped': lambda v: v['hooks'].pop('Stop'),
        }
        for name, change in edits.items():
            with self.subTest(edit=name):
                self.tearDown(); self.setUp()
                self.edit_json('plugins/ia/hooks/hooks.json', change)
                with self.assertRaisesRegex(ValueError, 'ia hooks differ from the qualified set: plugins/ia/hooks/hooks.json'):
                    validate(self.root)

    def test_core_door_is_named_in_codex(self):
        # Codex reads a plugin's .mcp.json too: the Codex manifest names that one file (public-door-codex), not an empty set or a server of its own.
        for name, change in {'missing': lambda m: m.pop('mcpServers'), 'off': lambda m: m.update(mcpServers={}), 'a server': lambda m: m.update(mcpServers={'ia': {'command': 'npx'}})}.items():
            with self.subTest(edit=name):
                self.tearDown(); self.setUp()
                self.edit_json('plugins/ia/.codex-plugin/plugin.json', change)
                with self.assertRaisesRegex(ValueError, 'names its door in Codex'):
                    validate(self.root)

    def test_core_door_must_equal_the_qualified_server(self):
        # public-door-mcp and public-account-connector: the IA door, ia, run by node through the plugin's door launcher
        # (which starts npx at the pinned IA version, never through a shell) and told where the bundled kits are; and the
        # account connector, inventarch, a remote HTTP server whose OAuth client is the public Claude Code client.
        expected = {'mcpServers': {'ia': {'command': 'node', 'args': ['${CLAUDE_PLUGIN_ROOT}/scripts/door.mjs'],
                                          'env': {'IA_KITS_DIR': '${CLAUDE_PLUGIN_ROOT}/config/kits'}},
                                   'inventarch': {'type': 'http', 'url': 'https://api.inventarch.dev/mcp',
                                                  'oauth': {'clientId': 'claude-code', 'callbackPort': 43822}}}}
        canonical = lambda value: json.dumps(value, sort_keys=True)
        self.assertEqual(canonical(qualified_mcp()), canonical(expected))
        self.assertEqual(canonical(load(self.root / 'plugins/ia/.mcp.json')), canonical(expected))
        def door(value): return value['mcpServers']['ia']
        def connector(value): return value['mcpServers']['inventarch']
        edits = {
            'bare npx': lambda v: door(v).update(command='npx', args=['-y', '@inventarch/mcp-door@3.6.0']),
            'cmd /c npx': lambda v: door(v).update(command='cmd', args=['/c', 'npx', '-y', '@inventarch/mcp-door@3.6.0']),
            'other script': lambda v: door(v).update(args=['${CLAUDE_PLUGIN_ROOT}/scripts/resolve.mjs']),
            'extra argument': lambda v: door(v)['args'].append('--root'),
            'shell command': lambda v: door(v).update(command='bash'),
            'second server': lambda v: v['mcpServers'].update(extra={'command': 'npx', 'args': ['-y', 'x']}),
            'renamed server': lambda v: v['mcpServers'].update(door=v['mcpServers'].pop('ia')),
            'remote server': lambda v: v['mcpServers'].update(ia={'type': 'http', 'url': 'https://example.com/mcp'}),
            'connector dropped': lambda v: v['mcpServers'].pop('inventarch'),
            'connector elsewhere': lambda v: connector(v).update(url='https://example.com/mcp'),
            'connector other client': lambda v: connector(v)['oauth'].update(clientId='other'),
            'connector other port': lambda v: connector(v)['oauth'].update(callbackPort=1234),
            'connector with a secret': lambda v: connector(v)['oauth'].update(clientSecret='x'),
            'connector with a header': lambda v: connector(v).update(headers={'Authorization': 'Bearer x'}),
            'connector over stdio': lambda v: v['mcpServers'].update(inventarch={'command': 'npx', 'args': ['-y', 'x']}),
            'extra env': lambda v: door(v)['env'].update(TOKEN='x'),
            'no kits dir': lambda v: door(v).pop('env'),
        }
        for name, change in edits.items():
            with self.subTest(edit=name):
                self.tearDown(); self.setUp()
                self.edit_json('plugins/ia/.mcp.json', change)
                with self.assertRaisesRegex(ValueError, 'ia MCP servers differ from the qualified door: plugins/ia/.mcp.json'):
                    validate(self.root)

    def test_codex_door_must_equal_the_qualified_server(self):
        # public-door-codex: Codex takes a contained ./ command path and cwd and does not expand CLAUDE_PLUGIN_ROOT.
        expected = {'mcpServers': {'ia': {'command': 'node', 'args': ['./scripts/door.mjs'], 'cwd': './'}}}
        canonical = lambda value: json.dumps(value, sort_keys=True)
        self.assertEqual(canonical(qualified_codex_mcp()), canonical(expected))
        self.assertEqual(canonical(load(self.root / 'plugins/ia/.codex-mcp.json')), canonical(expected))
        def door(value): return value['mcpServers']['ia']
        edits = {
            'claude placeholder': lambda v: door(v).update(args=['${CLAUDE_PLUGIN_ROOT}/scripts/door.mjs']),
            'bare npx': lambda v: door(v).update(command='npx', args=['-y', '@inventarch/mcp-door@3.6.0']),
            'other script': lambda v: door(v).update(args=['./scripts/resolve.mjs']),
            'no cwd': lambda v: door(v).pop('cwd'),
            'second server': lambda v: v['mcpServers'].update(extra={'command': 'npx', 'args': ['-y', 'x']}),
        }
        for name, change in edits.items():
            with self.subTest(edit=name):
                self.tearDown(); self.setUp()
                self.edit_json('plugins/ia/.codex-mcp.json', change)
                with self.assertRaisesRegex(ValueError, 'ia Codex door differs from the qualified door: plugins/ia/.codex-mcp.json'):
                    validate(self.root)

    def test_runtime_keys_in_frontmatter_refuse(self):
        cases = {
            'plugins/ia/agents/checker.md': 'agent frontmatter',
            'plugins/ia/skills/work/SKILL.md': 'skill frontmatter',
        }
        for rel, where in cases.items():
            for key in ('hooks', 'mcpServers', 'permissionMode', 'Hooks', 'MCPSERVERS'):
                with self.subTest(rel=rel, key=key):
                    self.tearDown(); self.setUp()
                    p = self.root / rel
                    text = p.read_text(encoding='utf-8')
                    p.write_text(text.replace('\n---\n', f'\n{key}: synthetic\n---\n', 1), encoding='utf-8', newline='\n')
                    self.rehash()
                    with self.assertRaisesRegex(ValueError, 'runtime component not admitted in ' + where):
                        validate(self.root)

    def test_frontmatter_admits_only_simple_keys(self):
        # Valid YAML that would still set a key a host reads: each is refused, not skipped.
        spellings = ['"hooks": {Stop: []}', "'mcpServers': {a: {command: node}}", 'permissionMode : bypassPermissions',
                     '? hooks\n: {Stop: []}', 'base: &b {hooks: {}}\n<<: *b', '- stray']
        for rel in ('plugins/ia/agents/checker.md',
                    'plugins/ia/skills/work/SKILL.md'):
            for spelling in spellings:
                with self.subTest(rel=rel, spelling=spelling):
                    self.tearDown(); self.setUp()
                    p = self.root / rel
                    text = p.read_text(encoding='utf-8')
                    p.write_text(text.replace('\n---\n', f'\n{spelling}\n---\n', 1), encoding='utf-8', newline='\n')
                    self.rehash()
                    with self.assertRaisesRegex(ValueError, 'frontmatter line is not a simple key'):
                        validate(self.root)

    def test_hook_plugins_keep_their_hooks_off_in_codex(self):
        # [] is a regression seen before: Codex still discovered hooks/hooks.json behind an empty array.
        off = [plugin for plugin in HOOK_PLUGINS if plugin not in QUALIFIED_CODEX_HOOKS]
        self.assertEqual(set(off), {'ia'})
        for plugin, hooks in [(plugin, hooks) for plugin in off
                              for hooks in (None, {'hooks': {'PreToolUse': []}}, {}, [], './hooks/hooks.json')]:
            with self.subTest(plugin=plugin, hooks=hooks):
                self.tearDown(); self.setUp()
                p = self.root / f'plugins/{plugin}/.codex-plugin/plugin.json'
                value = load(p)
                if hooks is None:
                    del value['hooks']
                else:
                    value['hooks'] = hooks
                p.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')
                self.rehash()
                with self.assertRaisesRegex(ValueError, 'keeps its hooks off in Codex'):
                    validate(self.root)

    def test_no_plugin_names_a_codex_hook_file(self):
        p = self.root / 'plugins/ia/.codex-plugin/plugin.json'
        value = load(p)
        value['hooks'] = './hooks/codex.json'
        p.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'keeps its hooks off in Codex'):
            validate(self.root)

    def test_stray_folders_refuse(self):
        for rel in ('plugins/ia/node_modules/x/index.js', 'plugins/ia/skills/__pycache__/x.pyc'):
            with self.subTest(rel=rel):
                self.tearDown(); self.setUp()
                self.plant(rel, 'x\n')
                with self.assertRaisesRegex(ValueError, 'stray folder'):
                    validate(self.root)

    def test_sensitive_bytes_in_plugin_tests_refuse(self):
        for secret in ('C:' + '\\Users\\someone\\x', 'ghp_' + 'y' * 30, 'sk-ant-' + 'z' * 20):
            with self.subTest(secret=secret[:6]):
                self.tearDown(); self.setUp()
                self.plant('plugins/ia/tests/leak.test.mjs', secret + '\n')
                with self.assertRaisesRegex(ValueError, 'sensitive bytes in plugin tests'):
                    validate(self.root)

    def test_wider_secret_patterns_refuse_in_shipped_bytes(self):
        for secret in ('github_pat_' + 'a' * 30, 'AKIA' + 'B' * 16, 'npm_' + 'c' * 36, '/home/someone/x', '/c/Users/x'):
            with self.subTest(secret=secret[:6]):
                self.tearDown(); self.setUp()
                self.plant('plugins/ia/skills/work/references/leak.md', secret + '\n')
                self.rehash()
                with self.assertRaisesRegex(ValueError, 'sensitive bytes'):
                    validate(self.root)

    def test_unclosed_frontmatter_values_refuse(self):
        texts = {
            'quoted': '---\nname: odd\ndescription: "Use when testing.\n  disable-model-invocation: true"\n---\n\nBody.\n',
            'flow': '---\nname: odd\ndescription: Use when testing.\nmetadata: {\ndisable-model-invocation: true\n---\n\nBody.\n',
        }
        for label, text in texts.items():
            with self.subTest(label=label):
                self.tearDown(); self.setUp()
                self.plant('plugins/ia/skills/odd/SKILL.md', text)
                self.rehash()
                with self.assertRaisesRegex(ValueError, 'must close on its line'):
                    validate(self.root)

    def test_folded_description_is_read_without_its_marker(self):
        from validate import frontmatter
        fields = frontmatter('---\nname: x\ndescription: >-\n  Use when folding.\n  More.\n---\n')
        self.assertEqual(fields['description'], 'Use when folding. More.')

    def test_manifest_drift_between_hosts_refuses(self):
        p = self.root / 'plugins/ia/.codex-plugin/plugin.json'
        value = load(p)
        value['version'] = '9.9.9'
        p.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'host manifest drift'):
            validate(self.root)

    def test_catalog_description_drift_refuses(self):
        p = self.root / '.claude-plugin/marketplace.json'
        value = load(p)
        value['plugins'][0]['description'] += ' Drifted.'
        p.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'catalog description drift'):
            validate(self.root)

    def test_cross_plugin_link_refuses(self):
        p = self.root / 'plugins/ia/README.md'
        p.write_text(p.read_text(encoding='utf-8') + '\nSee [other](../other-plugin/README.md).\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'link leaves its plugin'):
            validate(self.root)

    def test_plugin_root_escape_refuses(self):
        p = self.root / 'plugins/ia/README.md'
        p.write_text(p.read_text(encoding='utf-8') + '\nRun `${CLAUDE_PLUGIN_ROOT}/../../runtime/local/src/cli.mjs`.\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'plugin-root path leaves its plugin'):
            validate(self.root)

    def test_agent_wildcard_tools_refuse(self):
        p = self.root / 'plugins/ia/agents/checker.md'
        text = p.read_text(encoding='utf-8')
        p.write_text(re.sub(r'^tools: .*$', 'tools: "*"', text, count=1, flags=re.M), encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'tools allowlist'):
            validate(self.root)

    def test_entry_skill_must_be_model_invocable(self):
        p = self.root / 'plugins/ia/skills/work/SKILL.md'
        text = p.read_text(encoding='utf-8')
        text = re.sub(r'(?m)^description: .*$', 'description: Use when testing the entry skill.', text, count=1)
        p.write_text(text.replace('\n---\n', '\ndisable-model-invocation: true\n---\n', 1), encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'entry skill must be model-invocable'):
            validate(self.root)

    def test_skill_name_must_equal_folder(self):
        self.plant('plugins/ia/skills/folder-a/SKILL.md', '---\nname: folder-b\ndescription: Use when testing names.\ndisable-model-invocation: true\n---\n\nBody.\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'skill name must equal its folder'):
            validate(self.root)

    def test_decision_without_index_row_refuses(self):
        p = self.root / '.ia/src/decisions.ia'
        p.write_text(p.read_text(encoding='utf-8') + '\n@decision example-ghost\n  meaning\n    says "Synthetic."\n  work\n    title "Ghost"\n    status open\n  decision\n    question "Synthetic?"\n', encoding='utf-8', newline='\n')
        with self.assertRaisesRegex(ValueError, 'decision missing from docs/decisions.md: example-ghost'):
            validate(self.root)

    def test_index_row_without_record_refuses(self):
        p = self.root / 'docs/decisions.md'
        p.write_text(p.read_text(encoding='utf-8') + '\n| Synthetic | Made | `example-ghost` |\n', encoding='utf-8', newline='\n')
        with self.assertRaisesRegex(ValueError, 'names a decision with no record: example-ghost'):
            validate(self.root)

    def test_document_without_record_refuses(self):
        self.plant('docs/unrecorded.md', '# Synthetic\n')
        with self.assertRaisesRegex(ValueError, 'document without a record'):
            validate(self.root)

    def test_installed_kit_state_is_not_a_document_without_a_record(self):
        # Ignored by Git: npm run kits:install writes kit assets under .ia/distributions/ and vendor/ia/.
        self.plant('.ia/distributions/store/abc/assets/note.md', '# Installed kit asset\n')
        self.plant('vendor/ia/note.md', '# Vendored\n')
        validate(self.root)

    def test_skill_without_trigger_refuses(self):
        folder = self.root / 'plugins/ia/skills/no-trigger'
        folder.mkdir()
        (folder / 'SKILL.md').write_text('---\nname: no-trigger\ndescription: A summary only.\ndisable-model-invocation: true\n---\n\nBody.\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'what and when'):
            validate(self.root)

    def test_unresolved_plugin_root_path_refuses(self):
        p = self.root / 'plugins/ia/skills/work/SKILL.md'
        p.write_text(p.read_text(encoding='utf-8') + '\nRead `${CLAUDE_PLUGIN_ROOT}/references/missing.md`.\n', encoding='utf-8', newline='\n')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            validate(self.root)

    def test_duplicate_json_key_refuses(self):
        p = self.root / 'duplicate.json'
        p.write_text('{"name":"a","name":"b"}')
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            load(p)

    def write_json(self, rel, value):
        write_json(self.root / rel, value)

    def edit_json(self, rel, change):
        value = load(self.root / rel)
        change(value)
        self.write_json(rel, value)
        self.rehash()

    def test_skill_inventory_is_pinned(self):
        # Names, not counts: a renamed, dropped or added skill changes what every host lists, so it must change here too.
        self.assertEqual(validate(self.root)['skills'], {
            'ia': sorted(CORE_SKILLS),
        })

    def test_catalog_plugin_set_refuses_dropped_or_duplicate(self):
        edits = {
            'dropped': lambda v: v['plugins'].pop(),
            'duplicate': lambda v: v['plugins'].append(copy.deepcopy(v['plugins'][0])),
        }
        for catalog in CATALOGS:
            for label, change in edits.items():
                with self.subTest(catalog=catalog, edit=label):
                    self.tearDown(); self.setUp()
                    self.edit_json(catalog, change)
                    with self.assertRaisesRegex(ValueError, 'catalog plugin set|minItems'):
                        validate(self.root)

    def test_codex_catalog_policy_and_category_are_fixed(self):
        edits = {
            'installed by default': lambda v: v['plugins'][0]['policy'].update(installation='INSTALLED_BY_DEFAULT'),
            'other category': lambda v: v['plugins'][0].update(category='Productivity'),
        }
        for label, change in edits.items():
            with self.subTest(edit=label):
                self.tearDown(); self.setUp()
                self.edit_json('.agents/plugins/marketplace.json', change)
                with self.assertRaisesRegex(ValueError, 'const'):
                    validate(self.root)

    def test_catalog_sources_stay_inside_their_plugin_folder(self):
        for source in ('../outside', '/plugins/ia', 'C:/plugins/ia',
                       '.\\plugins\\ia', './plugins/ia-other'):
            with self.subTest(catalog='claude', source=source):
                self.tearDown(); self.setUp()
                self.edit_json('.claude-plugin/marketplace.json', lambda v: v['plugins'][0].update(source=source))
                with self.assertRaisesRegex(ValueError, 'remote catalog source'):
                    validate(self.root)
            with self.subTest(catalog='codex', source=source):
                self.tearDown(); self.setUp()
                self.edit_json('.agents/plugins/marketplace.json', lambda v: v['plugins'][0]['source'].update(path=source))
                with self.assertRaisesRegex(ValueError, 'codex source path'):
                    validate(self.root)

    def test_codex_manifest_shape(self):
        codex = 'plugins/ia/.codex-plugin/plugin.json'
        claude = 'plugins/ia/.claude-plugin/plugin.json'
        description = load(self.root / claude)['description']
        edits = {
            'no interface': (codex, lambda v: v.pop('interface'), 'needs an interface block'),
            'top-level displayName': (codex, lambda v: v.update(displayName='InventArch'), 'Claude-only field'),
            'dependencies': (codex, lambda v: v.update(dependencies=['ia-other']), 'Claude-only field'),
            'interface field': (codex, lambda v: v['interface'].update(logo='./logo.png'), 'unknown field'),
            'display name drift': (codex, lambda v: v['interface'].update(displayName='Work'), 'displayName drift'),
            'cut description': (codex, lambda v: v['interface'].update(shortDescription=description[:60] + '...'), 'shortDescription'),
            'long summary': (codex, lambda v: v['interface'].update(shortDescription='x' * 81), 'shortDescription'),
            'keyword drift': (codex, lambda v: v.update(keywords=['other']), 'host manifest drift'),
            'claude without displayName': (claude, lambda v: v.pop('displayName'), 'needs displayName'),
            'claude with interface': (claude, lambda v: v.update(interface=load(self.root / codex)['interface']), 'no Codex fields'),
        }
        for label, (rel, change, message) in edits.items():
            with self.subTest(edit=label):
                self.tearDown(); self.setUp()
                self.edit_json(rel, change)
                with self.assertRaisesRegex(ValueError, message):
                    validate(self.root)

    def test_dependencies_name_another_catalogue_plugin(self):
        # A plugin that left the catalogue, or the plugin itself, is no other plugin of this catalogue.
        for dependency in ('inventarch-ghost', 'ia', 'inventarch', 'inventarch-work', 'Inventarch-Governance', 'inventarch-development'):
            with self.subTest(dependency=dependency):
                self.tearDown(); self.setUp()
                self.edit_json('plugins/ia/.claude-plugin/plugin.json', lambda v: v.update(dependencies=[dependency]))
                with self.assertRaisesRegex(ValueError, 'dependency must name another plugin|pattern'):
                    validate(self.root)

    def test_manifest_must_be_an_object(self):
        self.write_json('plugins/ia/.codex-plugin/plugin.json', 'ia')
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'must be a JSON object'):
            validate(self.root)

    def test_missing_codex_md_refuses(self):
        (self.root / 'plugins/ia/CODEX.md').unlink()
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'missing CODEX.md'):
            validate(self.root)

    def test_skill_without_codex_bridge_refuses(self):
        for rel in ('plugins/ia/skills/init/SKILL.md',
                    'plugins/ia/skills/delivery/SKILL.md'):
            with self.subTest(rel=rel):
                self.tearDown(); self.setUp()
                p = self.root / rel
                lines = p.read_text(encoding='utf-8').split('\n')
                p.write_text('\n'.join(line for line in lines if not line.startswith('**Codex:**')), encoding='utf-8', newline='\n')
                self.rehash()
                with self.assertRaisesRegex(ValueError, 'Codex bridge'):
                    validate(self.root)


if __name__ == '__main__':
    unittest.main()
