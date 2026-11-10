import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from consistency import CORE_LIB, PIN_CONSTANTS, check  # noqa: E402
from selection import proposed  # noqa: E402

PLUGIN_FILE = 'plugins/ia/skills/knowledge/SKILL.md'
RELEASE = 'plugins/ia/config/kits/ia-kb/.ia/release.json'


def next_patch(version):
    major, minor, patch = version.split('-')[0].split('.')
    return f'{major}.{minor}.{int(patch) + 1}'


class ConsistencyTests(unittest.TestCase):
    """Each test copies the repository (without .git) and breaks one fact; check() must name it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='marketplace-consistency-')
        # The validator refuses alias ancestors, and macOS's temp folder sits under the /var -> /private/var symlink.
        self.root = Path(self.temp.name).resolve() / 'repo'
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns('.git', '__pycache__', '.scratch', 'build', 'node_modules'))

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)

    def text(self, name):
        return (self.root / name).read_text(encoding='utf-8')

    def edit(self, name, old, new):
        text = self.text(name)
        self.assertIn(old, text, name)
        self.write(name, text.replace(old, new, 1))

    def json_edit(self, name, change):
        value = json.loads(self.text(name))
        change(value)
        self.write(name, json.dumps(value, indent=2) + '\n')

    def assertProblem(self, pattern, **kwargs):
        problems = check(self.root, **kwargs)
        self.assertTrue(any(re.search(pattern, p) for p in problems), f'no problem matches {pattern!r}: {problems}')

    def git(self, *args):
        # Disposable repositories must not leave background maintenance writing into .git during cleanup.
        return subprocess.run(['git', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
                               '-c', 'gc.autoDetach=false', '-C', str(self.root), *args],
                              capture_output=True, text=True, check=True).stdout

    def commit_all(self, message):
        self.git('add', '-A')
        self.git('-c', 'user.name=Consistency Test', '-c', 'user.email=consistency@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)

    def rehash(self):
        selection = json.loads(self.text('export-selection.json'))
        selection['files'] = proposed(self.root)
        self.write('export-selection.json', json.dumps(selection, indent=2) + '\n')

    def version(self, plugin):
        # Read, never pinned: a release raises it, and the release pull request runs these tests.
        return json.loads(self.text(f'plugins/{plugin}/.claude-plugin/plugin.json'))['version']

    def bump(self, plugin, version):
        for host in ('claude', 'codex'):
            self.json_edit(f'plugins/{plugin}/.{host}-plugin/plugin.json', lambda m: m.update(version=version))
        self.edit(f'plugins/{plugin}/CHANGELOG.md', '# Changelog\n', f'# Changelog\n\n## {version} (2026-10-18)\n\n- A test change.\n')
        self.json_edit('sources.lock.json', lambda s: s['pluginVersion'].update({plugin: version}))

    def init_history(self):
        """A one-branch history in the copy, with every kit release pinned to a commit on it (issue #81's check)."""
        self.git('init', '-q')
        self.commit_all('base')
        base = self.git('rev-parse', 'HEAD').strip()
        for release in sorted((self.root / 'plugins').glob('**/.ia/release.json')):
            self.json_edit(release.relative_to(self.root).as_posix(), lambda r: r['source'].update(commit=base))
        self.rehash()  # the release descriptors ship, so the base's selection must already hold their new bytes
        self.commit_all('pin the kit releases to the base')

    # The repository itself.

    def test_repository_is_consistent(self):
        self.assertEqual(check(self.root), [])

    # Text hygiene, in every file, shipped or not.

    def test_crlf_refuses(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md').replace('\n', '\r\n'))
        self.assertProblem(r'docs/roadmap\.md: CR line endings')

    def test_missing_final_newline_refuses(self):
        self.write('tools/package.py', self.text('tools/package.py').rstrip('\n'))
        self.assertProblem(r'tools/package\.py: no final newline')

    def test_byte_order_mark_refuses(self):
        self.write('README.md', b'\xef\xbb\xbf' + (self.root / 'README.md').read_bytes())
        self.assertProblem(r'README\.md: byte-order mark')

    def test_invalid_utf8_refuses(self):
        self.write('docs/notes.txt', b'caf\xe9\n')
        self.assertProblem(r'docs/notes\.txt: not UTF-8')

    def test_trailing_whitespace_refuses_outside_markdown(self):
        self.edit('tools/package.py', '\n', ' \n')
        self.assertProblem(r'tools/package\.py:1: trailing whitespace')
        self.edit('docs/roadmap.md', '\n', '  \n')  # a Markdown line break
        self.assertFalse(any('docs/roadmap.md' in p for p in check(self.root)))

    def test_tab_indentation_refuses_in_python_json_and_yaml(self):
        self.write('.github/workflows/gates.yml', self.text('.github/workflows/gates.yml') + '\tbad: tab\n')
        self.assertProblem(r'\.github/workflows/gates\.yml:\d+: tab indentation')

    def test_conflict_marker_refuses(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n')
        self.assertProblem(r'docs/roadmap\.md:\d+: merge-conflict marker')

    # Languages: JSON, Python, Markdown.

    def test_duplicate_json_key_refuses_in_unshipped_json(self):
        self.write('docs/verification.json', '{"a": 1, "a": 2}\n')
        self.assertProblem(r'docs/verification\.json: invalid JSON: duplicate key a')

    def test_non_standard_json_constant_refuses(self):
        self.write('tools/spot-check/prompts.json', '{"a": NaN}\n')
        self.assertProblem(r'tools/spot-check/prompts\.json: invalid JSON')

    def test_python_syntax_error_refuses(self):
        self.write('tools/package.py', self.text('tools/package.py') + 'def broken(:\n')
        self.assertProblem(r'tools/package\.py:\d+: Python syntax')

    def test_broken_markdown_link_refuses_outside_plugins(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\nSee [the plan](missing-plan.md).\n')
        self.assertProblem(r'docs/roadmap\.md:\d+: broken link missing-plan\.md')

    def test_links_in_code_are_not_links(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\n`[x](nowhere.md)`\n\n```md\n[y](nowhere.md)\n```\n')
        self.assertEqual(check(self.root), [])

    def test_broken_heading_anchor_refuses(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\nSee [rules](../AGENTS.md#no-such-heading).\n')
        self.assertProblem(r'docs/roadmap\.md:\d+: broken anchor \.\./AGENTS\.md#no-such-heading')

    def test_existing_heading_anchor_resolves(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\nSee [the gates](../AGENTS.md#gates) and [rules](../AGENTS.md#plugin-rules).\n')
        self.assertEqual(check(self.root), [])

    def test_heading_with_code_span_anchor_resolves(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\n## The `work` skill\n\nSee [it](#the-work-skill).\n')
        self.assertEqual(check(self.root), [])

    def test_folder_encoded_and_parenthesised_links_resolve(self):
        self.write('docs/a (b).md', '# A\n')
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\n[root](..) [here](.) [space](a%20(b).md) [paren](a%20(b).md#a)\n')
        self.write('README.md', self.text('README.md') + '\n[dot](.)\n')
        self.assertEqual(check(self.root), [])

    def test_ignored_state_in_a_copy_is_not_checked(self):
        self.write('.ia/distributions/inventarch/language/broken.json', '{"a": 1, "a": 2}\n')
        self.write('.ia/work/scratch.md', 'no final newline')
        self.assertEqual(check(self.root), [])

    def test_vendored_kit_archives_in_a_copy_are_not_checked(self):
        # npm run kits:install vendors gzip archives under vendor/ia/, which .gitignore keeps out.
        path = self.root / 'vendor' / 'ia' / 'kit.ia.tgz'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes([0x1F, 0x8B, 0x08, 0x00, 0xFF, 0xFE]))
        self.assertEqual(check(self.root), [])

    def test_link_leaving_the_repository_refuses(self):
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\nSee [elsewhere](../../kb/README.md).\n')
        self.assertProblem(r'docs/roadmap\.md:\d+: link leaves the repository')

    # The IA pins agree with sources.lock.json.

    def test_launcher_pin_drift_refuses(self):
        self.edit('plugins/ia/scripts/lib/cli.mjs', "export const PINNED = '3.6.0';", "export const PINNED = '3.3.0';")
        self.assertProblem(r'plugins/ia/scripts/lib/cli\.mjs: pins 3\.3\.0, sources\.lock\.json pins 3.6.0')

    def test_every_qualified_runtime_literal_must_match_the_lock(self):
        # The core's closure modules: every literal is moved off the pin at once, and each row must name its own drift.
        rows = [row for row in PIN_CONSTANTS if row[0].startswith((CORE_LIB + 'closure-runtime', CORE_LIB + 'method-closure'))]
        self.assertEqual(len(rows), 8)
        lock = json.loads(self.text('sources.lock.json'))['released']
        for name, pattern, _ in rows:
            match = re.search(pattern, self.text(name), re.M)
            self.write(name, self.text(name)[:match.start(1)] + '9.9.9' + self.text(name)[match.end(1):])
        problems = check(self.root)
        for name, pattern, key in rows:
            with self.subTest(name=name, pattern=pattern):
                self.assertIn(f'{name}: pins 9.9.9, sources.lock.json pins {lock[key]}', problems)

    def test_verify_native_language_drift_refuses(self):
        self.edit('tools/verify-native.mjs', "language: { version: '3.2.0'", "language: { version: '3.1.2'")
        self.assertProblem(r'tools/verify-native\.mjs: pins 3\.1\.2, sources\.lock\.json pins 3\.2\.0')

    def test_root_cli_dependency_drift_refuses(self):
        self.json_edit('package.json', lambda p: p['devDependencies'].update({'@inventarch/cli': '3.2.2'}))
        self.assertProblem(r'package\.json: devDependencies @inventarch/cli is 3\.2\.2')

    def test_root_cli_lock_integrity_drift_refuses(self):
        self.json_edit('package-lock.json', lambda p: p['packages']['node_modules/@inventarch/cli'].update(integrity='sha512-AAAA'))
        self.assertProblem(r'package-lock\.json: @inventarch/cli integrity differs from sources\.lock\.json')

    def test_kit_language_lock_drift_refuses(self):
        name = 'plugins/ia/config/kits/ia-method/.ia/distributions.lock.json'
        self.json_edit(name, lambda lock: lock['packages'][0].update(version='3.1.0'))
        self.assertProblem(r'ia-method/\.ia/distributions\.lock\.json: inventarch/language 3\.1\.0')

    def test_kit_latest_release_must_name_the_pinned_cli(self):
        name = 'plugins/ia/config/kits/ia-kb/releases.json'
        self.json_edit(name, lambda r: r['releases'][-1].update(cli='@inventarch/cli 3.1.0'))
        self.assertProblem(r'ia-kb/releases\.json: latest release cli is @inventarch/cli 3\.1\.0')

    def test_stale_cli_reference_refuses_outside_history(self):
        self.edit(PLUGIN_FILE, '\n# ', '\nRun `npx -y -p @inventarch/cli@3.1.0 -- ia validate`.\n\n# ')
        self.assertProblem(r'knowledge/SKILL\.md:\d+: @inventarch/cli@3\.1\.0, sources\.lock\.json pins 3.6.0')
        self.write('plugins/ia/CHANGELOG.md', self.text('plugins/ia/CHANGELOG.md') + '\nWas `@inventarch/cli@2.0.0`.\n')
        self.assertFalse(any('CHANGELOG' in p for p in check(self.root)))

    def test_native_header_refuses(self):
        self.edit('.ia/src/work.ia', '#! ia 1.0\n', '#! ia 2.0\n')
        self.assertProblem(r'\.ia/src/work\.ia: native header')

    # Plugin versions.

    def test_plugin_version_drift_from_sources_lock_refuses(self):
        self.json_edit('sources.lock.json', lambda s: s['pluginVersion'].update({'ia': '0.0.9'}))
        self.assertProblem(r'sources\.lock\.json: pluginVersion ia is 0\.0\.9, its manifest says')

    def test_changelog_must_lead_with_the_manifest_version(self):
        current = self.version('ia')
        raised = next_patch(current)
        for host in ('claude', 'codex'):
            self.json_edit(f'plugins/ia/.{host}-plugin/plugin.json', lambda m: m.update(version=raised))
        self.json_edit('sources.lock.json', lambda s: s['pluginVersion'].update({'ia': raised}))
        self.assertProblem(rf'plugins/ia/CHANGELOG\.md: latest entry is {re.escape(current)}, the manifest says {re.escape(raised)}')

    # Version bumps against a base (git).

    def test_shipped_change_needs_a_version_bump(self):
        self.init_history()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        self.assertProblem(r'ia: shipped bytes changed since HEAD but no new release note names it', base='HEAD')
        self.bump('ia', next_patch(self.version('ia')))
        self.assertEqual(check(self.root, base='HEAD'), [])

    def note(self, name, plugins=('ia',), bump='patch'):
        self.write(f'releases/pending/{name}.json', json.dumps({
            'format': 'inventarch-marketplace.release-note.v1', 'bump': bump, 'title': 'A shipped change',
            'summary': 'What a user sees.', 'plugins': list(plugins)}, indent=2) + '\n')

    def test_a_new_release_note_stands_in_for_the_bump(self):
        # decision public-release-notes: the release pull request bumps; an ordinary one adds a note.
        self.init_history()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        self.note('a-shipped-change', bump='none')
        self.assertEqual(check(self.root, base='HEAD'), [])

    def test_a_note_already_pending_at_the_base_does_not_count(self):
        self.note('an-earlier-change')
        self.init_history()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        self.assertProblem(r'ia: shipped bytes changed since HEAD but no new release note names it', base='HEAD')
        self.edit('releases/pending/an-earlier-change.json', 'What a user sees.', 'What a user sees, and this change too.')
        self.assertEqual(check(self.root, base='HEAD'), [])

    def test_a_note_for_another_plugin_does_not_count(self):
        self.init_history()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        self.note('another-plugin', plugins=('other',))
        self.assertProblem(r'ia: shipped bytes changed since HEAD but no new release note names it', base='HEAD')

    def test_test_only_change_needs_no_bump(self):
        self.init_history()
        test_file = next((self.root / 'plugins/ia/tests').glob('*.test.mjs'))
        test_file.write_text(test_file.read_text(encoding='utf-8') + '\n// a test-only change\n', encoding='utf-8', newline='\n')
        self.assertEqual(check(self.root, base='HEAD'), [])

    def test_version_must_rise(self):
        self.init_history()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        current = self.version('ia')
        self.bump('ia', '0.9.0')
        self.assertProblem(rf'ia: version 0\.9\.0 is not above {re.escape(current)}', base='HEAD')

    def test_release_ranks_above_its_pre_release(self):
        from consistency import semver
        self.assertGreater(semver('1.0.0'), semver('1.0.0-rc.1'))
        self.assertGreater(semver('1.0.1-rc.1'), semver('1.0.0'))

    def test_public_kits_package_version_rises_with_its_kits(self):
        # decision public-kits-package: a changed ia.kits claim needs a higher package version.
        self.init_history()
        name = 'packages/public-kits/package.json'
        version = json.loads(self.text(name))['version']
        self.json_edit(name, lambda p: p['ia']['kits'][0].update(version='9.9.9'))
        self.assertProblem(r'packages/public-kits/package\.json: the carried kit releases changed since HEAD but its version stays ' + re.escape(version), base='HEAD')
        self.json_edit(name, lambda p: p.update(version='0.9.0'))
        self.assertProblem(r'packages/public-kits/package\.json: version 0\.9\.0 is not above ' + re.escape(version), base='HEAD')
        higher = str(int(version.split('.')[0]) + 1) + '.0.0'
        self.json_edit(name, lambda p: p.update(version=higher))
        self.assertFalse([p for p in check(self.root, base='HEAD') if 'public-kits' in p])

    def test_base_covers_every_commit_since_it(self):
        self.init_history()
        base = self.git('rev-parse', 'HEAD').strip()
        self.write(PLUGIN_FILE, self.text(PLUGIN_FILE) + '\nA shipped change.\n')
        self.rehash()
        self.commit_all('shipped change without a bump')
        self.write('docs/roadmap.md', self.text('docs/roadmap.md') + '\nA later docs change.\n')
        self.commit_all('docs only')
        self.assertProblem(r'ia: shipped bytes changed', base=base)

    # Published kit releases (git): what releases.json held at the base is never rewritten or removed.

    KIT_RELEASES = 'kits/ia-kb/releases.json'

    def test_unchanged_releases_pass(self):
        self.init_history()
        self.assertEqual(check(self.root, base='HEAD'), [])

    def test_rewritten_published_release_refuses(self):
        self.init_history()
        # The row and its file move together, so expand() succeeds and the comparison names the field.
        self.json_edit(self.KIT_RELEASES, lambda r: r['releases'][0].update(archive='0' * 64))
        self.json_edit('kits/ia-kb/releases/0.1.0.json', lambda r: r.update(archive='0' * 64))
        self.assertProblem(r'kits/ia-kb/releases\.json: release 0\.1\.0, recorded at HEAD, changed its archive', base='HEAD')
        # A row that no longer matches its file cannot be expanded at all, which is a problem too.
        self.json_edit('kits/ia-kb/releases/0.1.0.json', lambda r: r.update(archive='1' * 64))
        self.assertProblem(r'kits/ia-kb/releases\.json: cannot expand the release history', base='HEAD')

    def test_removed_published_release_refuses(self):
        self.init_history()
        self.json_edit(self.KIT_RELEASES, lambda r: r.update(releases=r['releases'][1:]))
        self.assertProblem(r'kits/ia-kb/releases\.json: release 0\.1\.0, recorded at HEAD, was removed', base='HEAD')

    def test_a_lossless_format_2_conversion_is_clean(self):
        # The base holds a format 1 history; converting it to an index and per-version files changes no release.
        self.init_history()
        folder = self.root / 'kits/ia-kb'
        index = json.loads(self.text(self.KIT_RELEASES))
        expanded = {'kit': index['kit'], 'releases': [{('records' if k == 'file' else k): (json.loads(self.text('kits/ia-kb/' + v))['records'] if k == 'file' else v)
                                                       for k, v in row.items()} for row in index['releases']]}
        shutil.rmtree(folder / 'releases')
        self.write(self.KIT_RELEASES, json.dumps(expanded, indent=2) + '\n')
        self.commit_all('format 1 history')
        subprocess.run(['node', str(self.root / 'tools/kit.mjs'), 'convert', str(folder)], check=True, capture_output=True)
        self.assertFalse([p for p in check(self.root, base='HEAD') if 'releases' in p])

    def test_changed_or_removed_release_file_refuses(self):
        self.init_history()
        name = 'kits/ia-kb/releases/0.1.0.json'
        self.json_edit(name, lambda r: r['records'].pop())
        self.assertProblem(re.escape(name) + r': a published release file, recorded at HEAD, changed', base='HEAD')
        (self.root / name).unlink()
        self.assertProblem(re.escape(name) + r': a published release file, recorded at HEAD, was removed', base='HEAD')

    def test_a_release_new_since_the_base_may_change(self):
        self.init_history()
        last = json.loads(self.text(self.KIT_RELEASES))['releases'][-1]
        self.write('kits/ia-kb/releases/9.0.0.json', json.dumps(dict(json.loads(self.text('kits/ia-kb/' + last['file'])), version='9.0.0'), indent=2) + '\n')
        self.json_edit(self.KIT_RELEASES, lambda r: (r['releases'].append(dict(last, version='9.0.0', file='releases/9.0.0.json')), r.update(latest='9.0.0')))
        self.commit_all('an unpublished release')
        base = self.git('rev-parse', 'HEAD~1').strip()
        self.json_edit(self.KIT_RELEASES, lambda r: r['releases'][-1].update(archive='1' * 64))
        self.json_edit('kits/ia-kb/releases/9.0.0.json', lambda r: r.update(archive='1' * 64))
        problems = check(self.root, base=base)
        self.assertFalse([p for p in problems if 'releases.json' in p], problems)

    def test_a_base_without_a_selection_counts_everything_as_new(self):
        # A new repository starts from a commit with no catalogue: nothing at the base was published.
        self.init_history()
        run = lambda *a, **k: subprocess.run(['git', *a], cwd=self.root, check=True, capture_output=True, text=True, **k).stdout.strip()
        empty = run('mktree', input='')
        base = run('commit-tree', empty, '-m', 'start', env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'})
        tree = run('rev-parse', 'HEAD^{tree}')
        head = run('commit-tree', tree, '-p', base, '-m', 'the catalogue', env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'})
        run('reset', '-q', '--hard', head)
        problems = check(self.root, base=base)
        self.assertFalse([p for p in problems if 'base selection' in p or 'releases' in p], problems)

    # Kit release sources (git, issue #81).

    def test_release_sources_on_the_history_pass(self):
        self.init_history()
        self.assertEqual(check(self.root), [])

    def test_release_source_off_the_history_refuses(self):
        self.init_history()
        self.git('checkout', '-q', '-b', 'side')
        self.write('docs/side.md', 'A commit only on a side branch.\n')
        self.commit_all('side')
        side = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-q', '-')
        self.json_edit(RELEASE, lambda r: r['source'].update(commit=side))
        self.assertProblem(rf'{re.escape(RELEASE)}: source\.commit {side[:12]} is not an ancestor of HEAD')

    def test_release_source_brought_in_by_an_in_progress_merge_passes(self):
        # The pre-commit hook runs before a merge commit exists: its second parent is MERGE_HEAD.
        self.init_history()
        self.git('checkout', '-q', '-b', 'side')
        self.write('docs/side.md', 'A commit only on a side branch.\n')
        self.commit_all('side')
        side = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-q', '-')
        self.git('-c', 'user.name=Consistency Test', '-c', 'user.email=consistency@example.invalid',
                 'merge', '-q', '--no-ff', '--no-commit', 'side')
        self.json_edit(RELEASE, lambda r: r['source'].update(commit=side))
        self.assertFalse([p for p in check(self.root) if 'source.commit' in p])

    def test_release_source_missing_from_the_repository_refuses(self):
        self.init_history()
        self.json_edit(RELEASE, lambda r: r['source'].update(commit='0' * 40))
        self.assertProblem(rf'{re.escape(RELEASE)}: source\.commit 000000000000 is not in this repository')

    def test_executable_mode_refuses(self):
        self.git('init', '-q')
        self.git('add', '-A')
        self.git('update-index', '--chmod=+x', 'tools/package.py')
        self.assertProblem(r'tools/package\.py: tracked mode 100755')


if __name__ == '__main__':
    unittest.main()
