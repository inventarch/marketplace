"""Repository consistency checks that tools/validate.py does not make (decision public-local-gates).

validate.py guards what ships. This guards the rest of the repository and the facts several files must agree on:
- every tracked file: UTF-8 without a byte-order mark, LF line endings, a final newline, no trailing whitespace
  outside Markdown (two trailing spaces are a Markdown line break), no tab indentation in Python, JSON or YAML, no
  merge-conflict markers, mode 100644;
- every tracked JSON file parses as standard JSON without a duplicate key, and every Python file compiles;
- every relative Markdown link resolves inside the repository, heading anchors included;
- the IA pins agree with sources.lock.json: the root @inventarch/cli dependency and its lockfile integrity, the
  launchers' constants, every qualified-runtime literal (the vendored copies too), tools/verify-native.mjs, every
  kit's language lock, release descriptor and latest release (a format 2 index's latest is its last row), every @inventarch/cli@<version> outside history and
  tests, and the native header of every .ia file;
- each plugin's manifest version equals sources.lock.json's pluginVersion and leads its CHANGELOG.md;
- in a Git checkout: every kit release's source.commit (each .ia/release.json under plugins/) is an ancestor of HEAD,
  so a squash or rebase merge cannot leave a published archive's source unreachable (issue #81);
- with --base <ref>: each plugin whose selected bytes changed since its merge base with <ref> has a higher version or
  a release note under releases/pending/ that is new or changed since that base and names it (decision
  public-release-notes; tools/release.mjs check holds the notes' shape), and every release a kits/ or plugins/ releases.json recorded at that merge base is still there, unchanged, compared
  through one expand() (format 1 passes through; format 2 reads releases/<version>.json), and no releases/<version>.json
  present at the base was removed or changed, and packages/public-kits/package.json, when its ia.kits changed since
  the base, has a higher version (decision public-kits-package).
It reports every problem, not only the first, reads only the working tree and Git, and needs no network.
"""
import argparse
import json
import posixpath
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

from validate import PLUGINS, ROOT

# What .gitignore keeps out, for a copy that is not a Git checkout (the tests).
IGNORED_DIRS = {'.git', 'node_modules', '__pycache__', '.scratch', 'build', 'review-private', '.qualification'}
IGNORED_PATHS = ('.ia/work/', '.ia/distributions/', '.ia/distributions.lock.json', 'vendor/ia/', '.env',
                 'packages/public-kits/index.json', 'packages/public-kits/kits/', 'packages/public-kits/archives/',
                 'packages/public-kits/LICENSE', 'packages/public-kits/NOTICE')
PUBLIC_KITS = 'packages/public-kits/package.json'
PENDING = 'releases/pending'
BINARY = ('.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2')
NO_TABS = ('.py', '.json', '.yml', '.yaml')
CONFLICT = re.compile(r'^(?:<{7}|>{7}|\|{7})(?: |$)')
# Files that record history or test other versions on purpose; the pin sweep skips them.
HISTORY_FILES = {'CHANGELOG.md', 'HISTORY.md', 'MIGRATION.md'}
CLI_REFERENCE = re.compile(r'@inventarch/cli@(\d+\.\d+\.\d+)')
# The qualified-runtime literals of the core's closure modules.
CORE_LIB = 'plugins/ia/scripts/lib/'
CLOSURE_RUNTIME = ((r"qualified-runtime-([0-9.]+)\.json", 'cli'), (r"cli\.version !== '([^']*)'", 'cli'),
                   (r"An exact local CLI ([0-9.]+) entry", 'cli'), (r"\bcliVersion: '([^']*)'", 'cli'))
METHOD_CLOSURE = ((r"native\?\.cliVersion !== '([^']*)'", 'cli'), (r"native\.languageVersion !== '([^']*)'", 'languageVersion'),
                  (r"native: \{ cliVersion: '([^']*)'", 'cli'), (r"languageVersion: '([^']*)', languageArchiveSha256", 'languageVersion'))
# The launchers' and tools' own pin constants: (file, pattern, sources.lock.json key).
PIN_CONSTANTS = (
    ('tools/verify-native.mjs', r"\bcli: '([^']*)'", 'cli'),
    ('tools/verify-native.mjs', r"\blanguage: \{ version: '([^']*)'", 'languageVersion'),
    ('tools/verify-native.mjs', r"\barchive: '([^']*)'", 'languageArchiveSha256'),
    ('tools/run-native-tests.mjs', r"^const CLI_VERSION = '([^']*)';$", 'cli'),
    ('tools/run-native-tests.mjs', r"language: 'inventarch/language ([^']*)'", 'languageVersion'),
    ('plugins/ia/scripts/lib/cli.mjs', r"^export const PINNED = '([^']*)';$", 'cli'),
    *((CORE_LIB + 'closure-runtime.mjs', pattern, key) for pattern, key in CLOSURE_RUNTIME),
    *((CORE_LIB + 'method-closure.mjs', pattern, key) for pattern, key in METHOD_CLOSURE),
)
LANGUAGE = 'inventarch/language'
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
LINK = re.compile(r'\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+(?:"[^"]*"|\'[^\']*\'))?\s*\)')
SCHEME = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
HEADING = re.compile(r'^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$')
HTML_ANCHOR = re.compile(r'<a\s+(?:[^>]*?\s)?(?:id|name)="([^"]+)"')


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True, encoding='utf-8').stdout


def is_checkout(root):
    return (root / '.git').exists()


def tracked(root):
    """Paths Git tracks (staged included) that exist in the working tree; outside Git, the files .gitignore keeps."""
    if is_checkout(root):
        names = [n for n in git(root, 'ls-files', '-z', '--cached').split('\0') if n]
        return sorted(n for n in names if (root / n).is_file())
    names = (p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file())
    return sorted(n for n in names if not IGNORED_DIRS & set(n.split('/')) and not n.startswith(IGNORED_PATHS))


def load_json(text):
    def unique(pairs):
        seen = set()
        for key, _ in pairs:
            if key in seen:
                raise ValueError('duplicate key ' + key)
            seen.add(key)
        return dict(pairs)

    def constant(name):
        raise ValueError('non-standard constant ' + name)
    return json.loads(text, object_pairs_hook=unique, parse_constant=constant)


def read_json(root, name):
    return load_json((root / name).read_text(encoding='utf-8'))


def hygiene(root, files, texts, problems):
    for name in files:
        if name.lower().endswith(BINARY):
            continue
        data = (root / name).read_bytes()
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            problems.append(f'{name}: not UTF-8')
            continue
        texts[name] = text
        if data.startswith(b'\xef\xbb\xbf'):
            problems.append(f'{name}: byte-order mark')
        if b'\r' in data:
            problems.append(f'{name}: CR line endings (the repository is LF only)')
        if data and not data.endswith(b'\n'):
            problems.append(f'{name}: no final newline')
        for number, line in enumerate(text.split('\n'), 1):
            if not name.endswith('.md') and line != line.rstrip(' \t'):
                problems.append(f'{name}:{number}: trailing whitespace')
                break
        if name.endswith(NO_TABS):
            for number, line in enumerate(text.split('\n'), 1):
                if line.startswith('\t'):
                    problems.append(f'{name}:{number}: tab indentation')
                    break
        for number, line in enumerate(text.split('\n'), 1):
            if CONFLICT.match(line):
                problems.append(f'{name}:{number}: merge-conflict marker')
                break


def modes(root, problems):
    if not is_checkout(root):
        return
    for line in git(root, 'ls-files', '-s').splitlines():
        mode, _sha, _stage, name = line.split(None, 3)
        if mode != '100644':
            problems.append(f'{name}: tracked mode {mode} (every tracked file is a regular 100644 blob)')


def languages(texts, problems):
    for name, text in texts.items():
        if name.endswith('.json'):
            try:
                load_json(text)
            except ValueError as error:
                problems.append(f'{name}: invalid JSON: {error}')
        elif name.endswith('.py'):
            try:
                compile(text, name, 'exec')
            except SyntaxError as error:
                problems.append(f'{name}:{error.lineno}: Python syntax: {error.msg}')


def unfenced_lines(text):
    """(line number, line) outside fenced code blocks."""
    fence = None
    for number, line in enumerate(text.split('\n'), 1):
        match = FENCE.match(line)
        if fence:
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence):
                fence = None
            continue
        if match:
            fence = match.group(1)
            continue
        yield number, line


def prose_lines(text):
    """Unfenced lines with inline code spans blanked, so code samples are not links."""
    for number, line in unfenced_lines(text):
        yield number, re.sub(r'(`+)(?:(?!\1).)+?\1', lambda m: ' ' * len(m.group(0)), line)


def slug(heading):
    """GitHub's heading anchor: lower case, markup and punctuation dropped, spaces become hyphens."""
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', heading)
    text = re.sub(r'<[^>]+>', '', text).strip().lower()
    return re.sub(r'[^\w\- ]', '', text).replace(' ', '-')


def anchors(text):
    found, counts = set(), {}
    for _number, line in unfenced_lines(text):
        match = HEADING.match(line)
        if match:
            base = slug(match.group(1))
            count = counts.get(base, 0)
            counts[base] = count + 1
            found.add(base if count == 0 else f'{base}-{count}')
        found.update(HTML_ANCHOR.findall(line))
    return found


def markdown_links(root, files, texts, problems):
    present = set(files)
    folders = {posixpath.dirname(n) for n in files}
    folders |= {f for name in list(folders) for f in _parents(name)} | {'.'}
    cache = {}
    for name in files:
        if not name.endswith('.md') or name not in texts:
            continue
        for number, line in prose_lines(texts[name]):
            for href in LINK.findall(line):
                if SCHEME.match(href) or href.startswith('/'):
                    continue
                path, _, fragment = (unquote(part) for part in href.partition('#'))
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), path)) if path else name
                if target == '..' or target.startswith('../'):
                    problems.append(f'{name}:{number}: link leaves the repository: {href}')
                    continue
                if target not in present and target.rstrip('/') not in folders:
                    problems.append(f'{name}:{number}: broken link {href}')
                    continue
                if fragment and target.endswith('.md') and target in texts:
                    if target not in cache:
                        cache[target] = anchors(texts[target])
                    if fragment not in cache[target]:
                        problems.append(f'{name}:{number}: broken anchor {href}')


def _parents(folder):
    while folder:
        folder = posixpath.dirname(folder)
        if folder:
            yield folder


def caret_admits(range_text, version):
    """Does the caret range ^X.Y.Z admit version? Within a major from 1 up: same major, and not lower."""
    match = re.fullmatch(r'\^(\d+)\.(\d+)\.(\d+)', range_text or '')
    parts = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', version or '')
    if not match or not parts:
        return False
    low, got = tuple(map(int, match.groups())), tuple(map(int, parts.groups()))
    return low[0] >= 1 and got[0] == low[0] and got >= low


def pins(root, files, texts, problems):
    lock = read_json(root, 'sources.lock.json')
    released = lock['released']
    cli, language, archive = released['cli'], released['languageVersion'], released['languageArchiveSha256']
    package = read_json(root, 'package.json')
    declared = package.get('devDependencies', {}).get('@inventarch/cli')
    if declared != cli:
        problems.append(f'package.json: devDependencies @inventarch/cli is {declared}, sources.lock.json pins {cli}')
    locked = read_json(root, 'package-lock.json').get('packages', {}).get('node_modules/@inventarch/cli', {})
    if locked.get('version') != cli:
        problems.append(f'package-lock.json: @inventarch/cli is {locked.get("version")}, sources.lock.json pins {cli}')
    if locked.get('integrity') != released['cliNpmIntegrity']:
        problems.append('package-lock.json: @inventarch/cli integrity differs from sources.lock.json cliNpmIntegrity')
    for name, pattern, key in PIN_CONSTANTS:
        found = re.findall(pattern, texts.get(name, ''), re.M)
        if len(found) != 1:
            problems.append(f'{name}: expected one pin constant matching {pattern}, found {len(found)}')
        elif found[0] != released[key]:
            problems.append(f'{name}: pins {found[0]}, sources.lock.json pins {released[key]}')
    for name in files:
        if not (name.startswith('plugins/') and name.endswith('/.ia/distributions.lock.json')):
            continue
        kit = name[:-len('/.ia/distributions.lock.json')]
        kit_lock = read_json(root, name)
        packages = [p for p in kit_lock.get('packages', []) if p.get('id') == LANGUAGE]
        if len(packages) != 1 or packages[0].get('version') != language or packages[0].get('archive') != archive:
            got = ', '.join(f"{p.get('version')} ({p.get('archive', '')[:12]})" for p in packages) or 'none'
            problems.append(f'{name}: {LANGUAGE} {got}, sources.lock.json pins {language} ({archive[:12]})')
        # A kit declares the minimum base it is proven on (ia floor --verify), which may be lower than the
        # base its lock pins: the range must admit the locked base, and the lock must request the same range.
        release_name = kit + '/.ia/release.json'
        release = read_json(root, release_name) if release_name in texts else {}
        ranges = [d.get('range') for d in release.get('dependencies', []) if d.get('id') == LANGUAGE]
        declared = ranges[0] if len(ranges) == 1 else None
        if declared is None or not caret_admits(declared, language):
            problems.append(f'{release_name}: depends on {LANGUAGE} {ranges}, expected one caret range that admits the locked {language}')
        requests = [r.get('range') for r in kit_lock.get('requests', []) if r.get('id') == LANGUAGE]
        if requests != ranges:
            problems.append(f'{name}: requests {LANGUAGE} {requests}, {release_name} declares {ranges}')
        history_name = kit + '/releases.json'
        if history_name in texts:
            history = read_json(root, history_name)
            latest = (history.get('releases') or [{}])[-1]
            if history.get('format') == 2 and history.get('latest') != latest.get('version'):
                problems.append(f'{history_name}: latest is {history.get("latest")}, its last release is {latest.get("version")}')
            if latest.get('cli') != f'@inventarch/cli {cli}':
                problems.append(f'{history_name}: latest release cli is {latest.get("cli")}, expected @inventarch/cli {cli}')
            if latest.get('language') != f'{LANGUAGE} {declared}':
                problems.append(f'{history_name}: latest release language is {latest.get("language")}, expected {LANGUAGE} {declared}')
            if latest.get('version') != release.get('version'):
                problems.append(f'{history_name}: latest release {latest.get("version")} is not .ia/release.json\'s {release.get("version")}')
    header = lock['nativeHeader'] + '\n'
    for name, text in texts.items():
        if name.endswith('.ia') and not text.startswith(header):
            problems.append(f'{name}: native header is not {lock["nativeHeader"]!r}')
        parts = name.split('/')
        # Recorded release inputs and handoff evidence keep the bytes of the state they record.
        if ('tests' in parts or 'releases' in parts
                or 'retired' in parts or parts[-1] in HISTORY_FILES or name.endswith('-lock.json')):
            continue
        for number, line in enumerate(text.split('\n'), 1):
            for version in CLI_REFERENCE.findall(line):
                if version != cli:
                    problems.append(f'{name}:{number}: @inventarch/cli@{version}, sources.lock.json pins {cli}')


def plugin_versions(root, texts, problems):
    recorded = read_json(root, 'sources.lock.json').get('pluginVersion', {})
    if set(recorded) != set(PLUGINS):
        problems.append(f'sources.lock.json: pluginVersion names {sorted(recorded)}, the catalogue holds {sorted(PLUGINS)}')
    for name in PLUGINS:
        version = read_json(root, f'plugins/{name}/.claude-plugin/plugin.json').get('version')
        if name in recorded and recorded[name] != version:
            problems.append(f'sources.lock.json: pluginVersion {name} is {recorded[name]}, its manifest says {version}')
        changelog = f'plugins/{name}/CHANGELOG.md'
        latest = re.search(r'^## (\S+)', texts.get(changelog, ''), re.M)
        if not latest or latest.group(1) != version:
            problems.append(f'{changelog}: latest entry is {latest.group(1) if latest else "missing"}, the manifest says {version}')


def release_sources(root, files, texts, problems):
    """Each kit release pins the commit its archive was packed from; it has to stay on this branch's history."""
    if not is_checkout(root):
        return  # a copy has no history to hold the commits
    # During a merge the commit being made has MERGE_HEAD as its second parent (the pre-commit hook runs before it exists).
    merging = subprocess.run(['git', '-C', str(root), 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], capture_output=True).returncode == 0
    heads = ['HEAD', 'MERGE_HEAD'] if merging else ['HEAD']
    for name in files:
        if not (name.startswith('plugins/') and name.endswith('/.ia/release.json')):
            continue
        try:
            commit = load_json(texts.get(name) or (root / name).read_text(encoding='utf-8')).get('source', {}).get('commit')
        except (ValueError, AttributeError):
            continue  # languages() reports a release descriptor that does not parse
        if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
            problems.append(f'{name}: source.commit is not a full commit id')
            continue
        present = subprocess.run(['git', '-C', str(root), 'cat-file', '-e', f'{commit}^{{commit}}'], capture_output=True)
        if present.returncode != 0:
            problems.append(f'{name}: source.commit {commit[:12]} is not in this repository')
            continue
        if not any(subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', commit, head], capture_output=True).returncode == 0
                   for head in heads):
            problems.append(f'{name}: source.commit {commit[:12]} is not an ancestor of HEAD '
                            '(merge with a merge commit, or add the commit to the history before releasing)')


def semver(version):
    """Comparable (major, minor, patch, release): a release ranks above its own pre-releases."""
    core, _, pre = version.partition('-')
    return (*(int(part) for part in re.findall(r'\d+', core)[:3]), 0 if pre else 1)


def version_bumps(root, base, problems):
    try:
        merge_base = git(root, 'merge-base', base, 'HEAD').strip()
    except subprocess.CalledProcessError as error:
        problems.append(f'--base {base}: cannot read the base selection ({str(error).strip()[:120]})')
        return
    if git(root, 'ls-tree', '--name-only', merge_base, 'export-selection.json').strip() == '':
        old_selection = {'files': []}
    else:
        try:
            old_selection = load_json(git(root, 'show', f'{merge_base}:export-selection.json'))
        except (subprocess.CalledProcessError, ValueError) as error:
            problems.append(f'--base {base}: cannot read the base selection ({str(error).strip()[:120]})')
            return
    old = {row['path']: row['sha256'] for row in old_selection['files']}
    new = {row['path']: row['sha256'] for row in read_json(root, 'export-selection.json')['files']}
    changed = {p for p in old.keys() | new.keys() if old.get(p) != new.get(p) and p.startswith('plugins/')}
    noted = noted_plugins(root, merge_base)
    for name in sorted({p.split('/')[1] for p in changed}):
        if name not in PLUGINS:
            continue
        manifest = f'plugins/{name}/.claude-plugin/plugin.json'
        try:
            before = load_json(git(root, 'show', f'{merge_base}:{manifest}')).get('version')
        except subprocess.CalledProcessError:
            continue  # a new plugin has no earlier version
        after = read_json(root, manifest).get('version')
        if after == before:
            if name not in noted:
                problems.append(f'{name}: shipped bytes changed since {base} but no new release note names it '
                                f'(node tools/release.mjs note --plugin {name} --bump <patch|minor|major|none> --title … --summary …)')
        elif semver(after) <= semver(before):
            problems.append(f'{name}: version {after} is not above {before}')
    public_kits_bump(root, base, merge_base, problems)


def noted_plugins(root, merge_base):
    """The plugins named by a pending release note that is new or changed since the merge base: a note already pending
    there accounts for an earlier change, not this one."""
    names = set()
    for path in sorted((root / PENDING).glob('*.json')) if (root / PENDING).is_dir() else []:
        rel = path.relative_to(root).as_posix()
        try:
            note = load_json(path.read_text(encoding='utf-8'))
        except ValueError:
            continue  # tools/release.mjs check reports it
        try:
            if git(root, 'show', f'{merge_base}:{rel}') == path.read_text(encoding='utf-8'):
                continue
        except subprocess.CalledProcessError:
            pass  # new since the base
        if isinstance(note, dict) and isinstance(note.get('plugins'), list):
            names.update(p for p in note['plugins'] if isinstance(p, str))
    return names


def public_kits_bump(root, base, merge_base, problems):
    """The package's version rises whenever the kit releases it carries (its ia.kits) change."""
    if not (root / PUBLIC_KITS).exists() or git(root, 'ls-tree', '--name-only', merge_base, PUBLIC_KITS).strip() == '':
        return  # no package, or a new one: nothing published to compare
    before = load_json(git(root, 'show', f'{merge_base}:{PUBLIC_KITS}'))
    after = read_json(root, PUBLIC_KITS)
    if before.get('ia', {}).get('kits') == after.get('ia', {}).get('kits'):
        return
    if after.get('version') == before.get('version'):
        problems.append(f'{PUBLIC_KITS}: the carried kit releases changed since {base} but its version stays '
                        f'{before.get("version")} (bump it)')
    elif semver(after.get('version', '0')) <= semver(before.get('version', '0')):
        problems.append(f'{PUBLIC_KITS}: version {after.get("version")} is not above {before.get("version")}')


def expand(document, read_file):
    """A releases.json as format 1: format 1 passes through; format 2 rows get their per-version file's records back
    where "file" was, after the file's kit, version and archive are checked against the row."""
    if not isinstance(document, dict) or document.get('format') != 2:
        return document
    releases = []
    for row in document.get('releases', []):
        file = read_file(row.get('file', ''))
        if not isinstance(file, dict) or (file.get('kit'), file.get('version'), file.get('archive')) != (document.get('kit'), row.get('version'), row.get('archive')):
            raise ValueError(f"{row.get('file')} does not belong to {document.get('kit')} {row.get('version')}")
        releases.append({('records' if k == 'file' else k): (file.get('records') if k == 'file' else v) for k, v in row.items()})
    return {'kit': document.get('kit'), 'releases': releases}


def published_releases(root, files, base, problems):
    """A release that releases.json held at the base is published: adopters pin its archive, so no tool or hand edit may
    rewrite it. Both sides are compared as format 1 through expand(), so a lossless format 1 -> 2 conversion is clean,
    and a releases/<version>.json present at the base may never be removed or changed."""
    try:
        merge_base = git(root, 'merge-base', base, 'HEAD').strip()
    except subprocess.CalledProcessError as error:
        problems.append(f'--base {base}: cannot find the merge base ({str(error).strip()[:120]})')
        return
    for name in [n for n in git(root, 'ls-tree', '-r', '--name-only', merge_base).split('\n') if n]:
        if re.fullmatch(r'(?:kits|plugins)/.+/releases/[^/]+\.json', name):
            if not (root / name).is_file():
                problems.append(f'{name}: a published release file, recorded at {base}, was removed')
            elif git(root, 'show', f'{merge_base}:{name}').replace('\r\n', '\n') != (root / name).read_text(encoding='utf-8').replace('\r\n', '\n'):
                problems.append(f'{name}: a published release file, recorded at {base}, changed')
    for name in files:
        if not (name.endswith('/releases.json') and name.startswith(('kits/', 'plugins/'))):
            continue
        folder = name[:-len('releases.json')]
        try:
            before = expand(load_json(git(root, 'show', f'{merge_base}:{name}')),
                            lambda rel: load_json(git(root, 'show', f'{merge_base}:{folder}{rel}'))).get('releases', [])
        except subprocess.CalledProcessError:
            continue  # a new kit has nothing published yet
        except (ValueError, AttributeError):
            continue
        try:
            after = {r.get('version'): r for r in expand(read_json(root, name), lambda rel: read_json(root, folder + rel)).get('releases', [])}
        except (ValueError, AttributeError, OSError) as error:
            problems.append(f'{name}: cannot expand the release history ({error})')
            continue
        for old in before:
            version, new = old.get('version'), after.get(old.get('version'))
            if new is None:
                problems.append(f'{name}: release {version}, recorded at {base}, was removed (a published release is never withdrawn)')
                continue
            for field in sorted(old.keys() | new.keys()):
                if old.get(field) != new.get(field):
                    problems.append(f'{name}: release {version}, recorded at {base}, changed its {field} '
                                    '(a published release is never rewritten: bump the version instead)')


def check(root=ROOT, base=None):
    root = Path(root)
    problems, texts = [], {}
    files = tracked(root)
    hygiene(root, files, texts, problems)
    modes(root, problems)
    languages(texts, problems)
    markdown_links(root, files, texts, problems)
    pins(root, files, texts, problems)
    plugin_versions(root, texts, problems)
    release_sources(root, files, texts, problems)
    if base:
        version_bumps(root, base, problems)
        published_releases(root, files, base, problems)
    return problems


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--base', help='also require a version bump for each plugin whose shipped bytes changed since this ref, and refuse a rewritten or removed release recorded there')
    args = parser.parse_args()
    try:
        found = check(base=args.base)
    except (OSError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        print('Consistency check failed to run: ' + str(error), file=sys.stderr)
        sys.exit(2)
    if found:
        print('Consistency refused:\n  ' + '\n  '.join(found), file=sys.stderr)
        sys.exit(1)
    print(json.dumps({'status': 'passed', 'files': len(tracked(ROOT)), 'base': args.base}, sort_keys=True))
