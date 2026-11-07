import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github' / 'workflows' / 'gates.yml'

# Every command CI runs, in order (AGENTS.md); a dropped or reordered gate fails here, not silently in CI.
RUNS = [
    'git config --global user.name "Gates CI"',
    'git config --global user.email "gates-ci@example.invalid"',
    'npm ci',
    'python tools/validate.py',
    'python tools/selection.py --check',
    'node tools/bundle-kits.mjs --check',
    'node tools/kit.mjs index --check',
    'node tools/kit.mjs package --check',
    "python tools/consistency.py --base ${{ github.event.pull_request.base.sha || github.event.before || 'origin/main' }}",
    'node tools/release.mjs check',
    'npm run lint',
    'node tools/check-language.mjs',
    'python -m unittest discover -s tests -v',
    'node --test "tests/*.test.mjs"',
    'node --test "plugins/*/tests/*.test.mjs"',
    'node tools/run-native-tests.mjs --plan >> "$GITHUB_OUTPUT"',
    'git config --global user.name "Gates CI"',
    'git config --global user.email "gates-ci@example.invalid"',
    'npm ci',
    'node tools/run-native-tests.mjs --shard ${{ matrix.shard }}',
    'node tools/run-native-tests.mjs --verify native-reports/*',
]

# Decision public-ci-matrix.
PULL_REQUEST_OS = ['ubuntu-latest']
PUSH_OS = ['ubuntu-latest', 'windows-latest', 'macos-latest']


class GatesWorkflowTests(unittest.TestCase):
    """Reads gates.yml as text: the standard library has no YAML parser, and the checks need only these lines."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding='utf-8')

    def test_triggers_cover_pull_requests_main_pushes_and_the_release_dispatch(self):
        # The release pull request workflow dispatches Gates on release/next (decision public-release-notes).
        self.assertIn("on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n  workflow_dispatch:\n\npermissions:", self.text)

    def test_event_selects_the_operating_systems(self):
        match = re.search(r"os: \$\{\{ github\.event_name == 'push' && fromJSON\('(\[.*?\])'\) \|\| fromJSON\('(\[.*?\])'\) \}\}", self.text)
        self.assertIsNotNone(match, 'the matrix os line has changed shape')
        self.assertEqual(json.loads(match.group(1)), PUSH_OS)
        self.assertEqual(json.loads(match.group(2)), PULL_REQUEST_OS)
        # The native shards and their verify job run on the same operating systems as the gates.
        self.assertEqual(self.text.count(match.group(0)), 3)
        self.assertIn('runs-on: ${{ matrix.os }}', self.text)
        self.assertIn('fail-fast: false', self.text)

    def test_every_gate_is_kept(self):
        self.assertEqual(re.findall(r'^ +run: (.*)$', self.text, re.MULTILINE), RUNS)
        self.assertNotIn('working-directory:', self.text)

    def test_no_gate_may_fail_quietly(self):
        self.assertNotIn('continue-on-error', self.text)
        self.assertEqual(re.findall(r'^ +if: (.*)$', self.text, re.MULTILINE), ['always()', 'always()'])
        self.assertIn('if-no-files-found: error', self.text)

    def test_setup_stays_pinned(self):
        uses = re.findall(r'uses: (\S+)', self.text)
        self.assertEqual(len(uses), 11)
        for action in uses:
            self.assertRegex(action, r'^actions/[a-z-]+@[0-9a-f]{40}$')
        self.assertIn('fetch-depth: 0', self.text)
        self.assertIn("python-version: '3.12'", self.text)
        self.assertIn("node-version: '22.22.0'", self.text)

    def test_native_lane_has_exact_installed_cli(self):
        self.assertIn('IA_CORE_TEST_CLI: ${{ github.workspace }}/node_modules/@inventarch/cli/dist/main.js', self.text)
        inventory = json.loads((ROOT / 'tools/native-inventory.json').read_text(encoding='utf-8'))
        self.assertEqual({case['id'] for case in inventory['cases']}, {'native-releases', 'MI-T04', 'MI-T05', 'native-closure-ownership', 'native-closure-plural-workspaces', 'native-closure-capability-roots', 'native-closure-missing-dependencies', 'native-closure-retention-execution', 'native-closure-executor-refusal', 'native-closure-validation-before-publish', 'native-closure-historical-refusal', 'native-closure-cwd-refusal', 'native-carried-ia-kb', 'native-method-position'})
        self.assertEqual(len({case['id'] for case in inventory['cases']}), len(inventory['cases']))
        for case in inventory['cases']:
            self.assertEqual(case['mode'], 'native')
            self.assertEqual(set(case['platforms']), {'linux', 'win32', 'darwin'})
            self.assertIn(case['shard'], range(1, inventory['shards'] + 1))
        self.assertEqual({case['shard'] for case in inventory['cases']}, set(range(1, inventory['shards'] + 1)))

    def test_checkout_is_lf(self):
        self.assertIn('* text=auto eol=lf', (ROOT / '.gitattributes').read_text(encoding='utf-8').splitlines())


class PublishPublicKitsWorkflowTests(unittest.TestCase):
    """The operator's publish step for @inventarch/public-kits (decision public-kits-package): dispatch only, from main,
    checked against its sources, refusing a published version, and published with provenance under OIDC, no token."""

    def setUp(self):
        self.text = (ROOT / '.github' / 'workflows' / 'publish-public-kits.yml').read_text(encoding='utf-8')

    def test_only_an_operator_starts_it_from_main(self):
        self.assertIn('on:\n  workflow_dispatch:\n\npermissions:', self.text)
        for trigger in ('push:', 'pull_request', 'schedule:', 'workflow_run', 'release:'):
            self.assertNotIn(trigger, self.text)
        self.assertIn('test "$GITHUB_REF" = refs/heads/main', self.text)

    def test_runs_in_the_npm_environment(self):
        # npm trusts the workflow only in this environment, which GitHub deploys from main after its reviewer approves.
        self.assertIn('    runs-on: ubuntu-latest\n    environment:\n      name: npm\n', self.text)
        self.assertEqual(self.text.count('environment:'), 1)

    def test_publishes_with_oidc_and_no_token(self):
        self.assertIn('permissions:\n  contents: read\n  id-token: write\n', self.text)
        self.assertNotIn('secrets.', self.text)
        self.assertNotIn('NODE_AUTH_TOKEN', self.text)
        self.assertNotIn('NPM_TOKEN', self.text)
        runs = re.findall(r'^ +run: (.*)$', self.text, re.MULTILINE)
        self.assertEqual(runs[-1], 'npm publish --provenance --access public')
        self.assertEqual(sum(r.startswith('npm publish') for r in runs), 1)

    def test_checks_refuse_and_build_before_publishing(self):
        runs = re.findall(r'^ +run: (.*)$', self.text, re.MULTILINE)
        order = ['npm ci --ignore-scripts', 'node tools/bundle-kits.mjs --check', 'node tools/kit.mjs index --check',
                 'node tools/kit.mjs package --check', '|', 'node tools/kit.mjs package --build',
                 'node tools/kit.mjs package --check --built', 'npm pack --dry-run --json',
                 'npm publish --provenance --access public']
        self.assertEqual([r for r in runs if r in order], order)
        self.assertIn('is already published', self.text)
        self.assertIn("node-version: '22.22.2'", self.text)
        self.assertNotRegex(self.text, r'(?m)^ +registry-url:')
        self.assertIn('npm@12.2.0', self.text)
        for action in re.findall(r'uses: (\S+)', self.text):
            self.assertRegex(action, r'^actions/[a-z-]+@[0-9a-f]{40}$')
        self.assertNotIn('continue-on-error', self.text)


def pinned_actions(case, text):
    for action in re.findall(r'uses: (\S+)', text):
        case.assertRegex(action, r'^actions/[a-z-]+@[0-9a-f]{40}$')
    case.assertNotIn('continue-on-error', text)


class ReleasePullRequestWorkflowTests(unittest.TestCase):
    """The release pull request (decision public-release-notes): only an operator starts it, from main; it installs
    nothing under its write token, folds the notes, records the selection and dispatches Gates on release/next."""

    def setUp(self):
        self.text = (ROOT / '.github' / 'workflows' / 'release-pr.yml').read_text(encoding='utf-8')

    def test_only_an_operator_starts_it_from_main(self):
        self.assertIn('on:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n', self.text)
        for trigger in ('push:', 'pull_request:', 'schedule:', 'workflow_run:', 'release:'):
            self.assertNotIn(trigger, self.text)
        self.assertIn('test "$GITHUB_REF" = refs/heads/main', self.text)

    def test_writes_only_a_branch_and_a_pull_request(self):
        self.assertIn('permissions:\n      contents: write\n      pull-requests: write\n      actions: write\n', self.text)
        for absent in ('id-token:', 'secrets.', 'npm ci', 'npm install', 'git push origin main', 'gh pr merge', 'git tag'):
            self.assertNotIn(absent, self.text)
        self.assertIn('git push --force origin release/next', self.text)

    def test_folds_records_and_dispatches_gates(self):
        order = ['node tools/release.mjs version --write --pr-body', 'python tools/selection.py --write',
                 'git push --force origin release/next', 'gh workflow run gates.yml --ref release/next']
        self.assertEqual(sorted(order, key=self.text.index), order)
        self.assertIn('Authored by InventArch', self.text)
        self.assertIn("node-version: '22.22.0'", self.text)
        pinned_actions(self, self.text)

    def test_new_release_pull_requests_are_drafts_and_updates_preserve_readiness(self):
        self.assertIn('gh pr create --draft --head release/next --base main', self.text)
        self.assertEqual(self.text.count('gh pr create '), 1)
        self.assertIn('gh pr edit "$number" --title', self.text)
        self.assertNotIn('gh pr ready', self.text)


class ReleaseWorkflowTests(unittest.TestCase):
    """Tagging a merged release (decision public-release-notes): only for a changeset on main, only after Gates passed
    on that exact commit, with a token that can write tags and releases and nothing else."""

    def setUp(self):
        self.text = (ROOT / '.github' / 'workflows' / 'release.yml').read_text(encoding='utf-8')

    def test_starts_on_a_recorded_changeset_or_a_dispatch_from_main(self):
        self.assertIn("on:\n  push:\n    branches: [main]\n    paths: ['releases/changesets/**']\n  workflow_dispatch:\n", self.text)
        for trigger in ('pull_request:', 'schedule:', 'workflow_run:'):
            self.assertNotIn(trigger, self.text)
        self.assertIn("if: github.ref == 'refs/heads/main'", self.text)

    def test_waits_for_gates_then_tags(self):
        self.assertIn('permissions:\n      contents: write\n      actions: read\n', self.text)
        for absent in ('id-token:', 'secrets.', 'npm publish', 'npm ci', '--force'):
            self.assertNotIn(absent, self.text)
        self.assertIn('actions/workflows/gates.yml/runs?head_sha=$RELEASE_SHA&branch=main', self.text)
        order = ['node tools/release.mjs list', 'Wait for Gates', 'gh release create']
        self.assertEqual(sorted(order, key=self.text.index), order)
        self.assertIn('--target "$GITHUB_SHA"', self.text)
        pinned_actions(self, self.text)


if __name__ == '__main__':
    unittest.main()
