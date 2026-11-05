"""Offline validator for the scaffold's deliberately bounded JSON Schema subset."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
# The public catalogue ships one plugin, ia (decision public-plugin-ia); its kits live under kits/ and are bundled into its config/kits.
PLUGINS = ('ia',)
# A plugin's entry skills: model-invocable, each the router of one lane. Without an entry here a plugin's entry skill is
# the one named after it. ia's are its three lanes; its init and doctor skills are user-invoked.
ENTRY_SKILLS = {'ia': ('work', 'knowledge', 'delivery')}
# Distributable plugin files: every file under plugins/<name>/ except its tests, with a text extension.
PLUGIN_TEXT = ('.md', '.json', '.mjs', '.js', '.cjs', '.ia', '.mmd', '.txt', '.yml', '.yaml', '.html', '.css', '.svg')
MAX_FILES = 1000
MAX_BUNDLE = 8 * 1024 * 1024
ENTRY_SKILL_BYTES = 16000
MODEL_INVOCABLE_PER_PLUGIN = 4
HIDDEN_DESCRIPTION = 160  # stage skills are reached by path; Codex still lists them
LISTING_BUDGET = 7500  # names plus descriptions of every skill in the catalogue; Codex ignores disable-model-invocation
# What a Git install may copy at a plugin's top level. Hooks, MCP and LSP servers, commands, settings, output
# styles, monitors and bin/ are runtime components this catalogue does not admit (decision public-plugin-components),
# apart from the core's qualified hooks (QUALIFIED_HOOKS) and its one MCP server, the IA door (QUALIFIED_MCP).
PLUGIN_TOP = {'.claude-plugin', '.codex-plugin', 'skills', 'agents', 'references', 'templates', 'examples', 'scripts', 'config', 'tests'}
RUNTIME_FILES = {'hooks.json', '.mcp.json', '.lsp.json', 'settings.json', '.app.json', 'monitors.json'}
# The exceptions, each a decision: a plugin listed here ships Claude Code hooks as hooks/hooks.json, exactly as
# qualified. Under Codex it keeps them off with an empty hook configuration, or, where QUALIFIED_CODEX_HOOKS says so,
# runs only the qualified Codex set from the file its Codex manifest names. Every other plugin still refuses hooks, in
# files and in frontmatter.
_EDITS = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'


def _handler(script, argument, timeout, **flags):
    return (script, argument, timeout, flags)


# A qualified set is event -> [(matcher, [(script under scripts/, argument, timeout, flags)])]; the hook file must equal
# exactly this, so a widened matcher, a rewired or dropped handler, an added event, a changed timeout or flag fails.
QUALIFIED_HOOKS = {
    # public-core-hooks: one read-only SessionStart bootstrap at startup, resume and compact that prints the workspace's
    # identity and the resolve instruction, offers an InventArch account once per session at startup (never blocking,
    # suppressible), says once when a repository is governed but no installed kit declares governance handlers, and
    # after a compaction re-injects the current task pin; it reads no credentials and never fetches.
    # public-kit-handlers: scripts/handlers.mjs runs the handlers installed kits declare (handlers.json, and onwrite.json
    # as tool post handlers) for every SessionStart source, UserPromptSubmit, PreToolUse and PostToolUse on edits and
    # shell commands, and Stop; a fast silent no-op when no kit declares one, and a pre block is honoured only in a
    # workspace with .ia/governance.json.
    'ia': {
        'SessionStart': [('startup|resume|compact', [_handler('bootstrap.mjs', None, 15)]),
                         (None, [_handler('handlers.mjs', 'session', 60)])],
        'UserPromptSubmit': [(None, [_handler('handlers.mjs', 'prompt', 30)])],
        'PreToolUse': [(_EDITS, [_handler('handlers.mjs', 'pre', 30)])],
        'PostToolUse': [(_EDITS, [_handler('handlers.mjs', 'post', 60)])],
        'Stop': [(None, [_handler('handlers.mjs', 'stop', 30)])],
    },
}
# public-account-connector (supersedes public-door-mcp): the core ships two MCP servers as .mcp.json at its root, exactly
# these: the IA door and the InventArch account connector, server inventarch (HTTP, ACCOUNT_MCP_URL, OAuth client id
# claude-code on callback port 43822; no secret, no token, the host runs the sign-in). The door is server ia,
# run by node through scripts/door.mjs, which starts npx -y @inventarch/mcp-door at the plugin's IA pin (lib/cli.mjs
# PINNED, held to sources.lock.json by tools/consistency.py) never through a shell (on Windows, where npx is a .cmd shim, it runs npm's npx-cli.js with node); and
# told where the bundled kits are. Claude Code names its tools mcp__plugin_ia_ia__<tool>. No other plugin and no other
# file may declare an MCP server.
ACCOUNT_MCP_URL = 'https://api.inventarch.dev/mcp'


def qualified_mcp():
    return {'mcpServers': {'ia': {'command': 'node', 'args': ['${CLAUDE_PLUGIN_ROOT}/scripts/door.mjs'],
                                  'env': {'IA_KITS_DIR': '${CLAUDE_PLUGIN_ROOT}/config/kits'}},
                           'inventarch': {'type': 'http', 'url': ACCOUNT_MCP_URL,
                                          'oauth': {'clientId': 'claude-code', 'callbackPort': 43822}}}}


MCP_PLUGINS = ('ia',)
CODEX_MCP_DOOR = './.codex-mcp.json'  # public-door-codex: the Codex manifest names the core's one door file


def mcp_file(name):
    return f'plugins/{name}/.mcp.json'


# public-door-codex: Codex does not expand ${CLAUDE_PLUGIN_ROOT} in args and takes a contained ./ command path and cwd
# (Agent Plugins stdio rules, codex-cli 0.164.0), so its manifest names a door file of its own: node ./scripts/door.mjs run from the
# plugin root, where door.mjs sets IA_KITS_DIR to the bundled kits itself.
def codex_mcp_file(name):
    return f'plugins/{name}/.codex-mcp.json'


def qualified_codex_mcp():
    return {'mcpServers': {'ia': {'command': 'node', 'args': ['./scripts/door.mjs'], 'cwd': './'}}}
HOOK_PLUGINS = tuple(QUALIFIED_HOOKS)
CODEX_HOOKS_OFF = {'hooks': {}}
# A plugin may run Codex hooks only from a file its Codex manifest names and this table qualifies; none does yet.
QUALIFIED_CODEX_HOOKS = {}
# A plugin listed here advertises no skill: its router exists but is not model-invocable. None is, today.
UNADVERTISED = set()


def hooks_file(name):
    return f'plugins/{name}/hooks/hooks.json'


def codex_hooks_file(name):
    return f'plugins/{name}/' + QUALIFIED_CODEX_HOOKS[name][0][2:]


def hook_files(name):
    return {hooks_file(name)} | ({codex_hooks_file(name)} if name in QUALIFIED_CODEX_HOOKS else set())
# Codex reads a plugin's display name, short description and category from its manifest's interface block, not from a
# top-level displayName; and it has no plugin dependencies. So a Codex manifest is the Claude manifest without those two
# fields, plus skills and the interface block (and, for a plugin with qualified hooks, the empty hook configuration, or
# the file QUALIFIED_CODEX_HOOKS names).
CLAUDE_ONLY = ('displayName', 'dependencies')
SHORT_DESCRIPTION = 80
# Every skill opens with this bridge, because Codex lists every skill and may load a stage skill directly.
CODEX_BRIDGE = re.compile(r'^\*\*Codex:\*\* .*\]\(\.\./\.\./CODEX\.md\)')
# Frontmatter keys through which a skill or agent would carry hooks, MCP servers or a permission mode (any case).
RUNTIME_KEYS = {'hooks', 'mcpServers', 'permissionMode'}


def runtime_keys(fields):
    return {key for key in fields if key.lower() in {k.lower() for k in RUNTIME_KEYS}}


def render_hooks(table):
    def handler(script, argument, timeout, flags):
        command = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/' + script + '"' + (' ' + argument if argument else '')
        return {'type': 'command', 'command': command, 'timeout': timeout, **flags}
    return {'hooks': {event: [{**({'matcher': matcher} if matcher else {}), 'hooks': [handler(*h) for h in handlers]}
                              for matcher, handlers in groups] for event, groups in table.items()}}


def qualified_hooks(name):
    return render_hooks(QUALIFIED_HOOKS[name])
STRAY_DIRS = {'node_modules', '__pycache__'}
SENSITIVE = re.compile(rb'(?i)(?:[a-z]:[\\/]+users[\\/]+|/[a-z]/users/|/users/[a-z0-9._-]+/|/home/[a-z0-9._-]+/|appdata[\\/]|'
                       rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|'
                       rb'sk-(?:ant|proj)-[a-z0-9_-]{16,}|sk-[a-z0-9]{24,}|akia[0-9a-z]{16}|npm_[a-z0-9]{36})')
TRIGGER = re.compile(r'(?i)\buse (?:this|it|when|for|to|after|before|at|in|on|once|as)\b|\bwhen\b')


def distributable(name):
    """A plugin file that ships: inside a plugin, outside its tests, with a text extension."""
    parts = name.split('/')
    return (len(parts) > 2 and parts[0] == 'plugins' and parts[1] in PLUGINS and
            'tests' not in parts[2:-1] and parts[2] != 'tests' and 'node_modules' not in parts and
            name.lower().endswith(PLUGIN_TEXT))


def frontmatter(text):
    """The simple key: value frontmatter the plugins use; folded (>-) values are joined. Any other top-level line
    (a quoted key, `key :`, `? key`, a `<<:` merge) is refused, so no key reaches a host unread."""
    require(text.startswith('---\n') and '\n---\n' in text[4:], 'frontmatter block')
    block = text[4:text.index('\n---\n', 4)]
    fields, key = {}, None
    for line in block.split('\n'):
        match = re.match(r'^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$', line)
        if match:
            key = match.group(1)
            value = match.group(2).strip()
            if value[:1] in ('"', "'"):
                require(len(value) > 1 and value.endswith(value[0]), 'frontmatter quoted value must close on its line: ' + key)
            if value[:1] in ('{', '['):
                require(value.endswith('}' if value[0] == '{' else ']'), 'frontmatter flow value must close on its line: ' + key)
            fields[key] = '' if value in ('>-', '>', '|', '|-') else value
        elif key and line.startswith((' ', '\t')):
            fields[key] = (fields[key] + ' ' + line.strip()).strip()
        else:
            require(not line.strip() or line.startswith('#'), 'frontmatter line is not a simple key: ' + line[:60])
    for key, value in fields.items():
        fields[key] = value.strip().strip('"').strip("'")
    return fields


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=unique)


def schema_check(value, schema, at='$'):
    """Only the keywords used by the two local schemas; unknown keywords refuse."""
    allowed = {'$schema', 'title', 'description', 'type', 'properties', 'required',
               'additionalProperties', 'items', 'minItems', 'enum', 'const', 'pattern',
               'minLength', 'uniqueItems'}
    require(set(schema) <= allowed, 'unsupported schema keyword')
    types = {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'integer': int}
    if 'type' in schema:
        require(schema['type'] in types, 'unsupported schema type')
        require(type(value) is types[schema['type']], at + ': type')
    if 'const' in schema:
        require(value == schema['const'] and type(value) is type(schema['const']), at + ': const')
    if 'enum' in schema:
        require(any(type(value) is type(v) and value == v for v in schema['enum']), at + ': enum')
    if isinstance(value, dict):
        require(set(schema.get('required', [])) <= set(value), at + ': required')
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            require(set(value) <= set(props), at + ': unknown field')
        for key in value.keys() & props.keys():
            schema_check(value[key], props[key], at + '.' + key)
    if isinstance(value, list):
        require(len(value) >= schema.get('minItems', 0), at + ': minItems')
        if schema.get('uniqueItems'):
            require(len({json.dumps(v, sort_keys=True) for v in value}) == len(value), at + ': duplicates')
        if 'items' in schema:
            for index, item in enumerate(value):
                schema_check(item, schema['items'], at + '[' + str(index) + ']')
    if isinstance(value, str):
        require(len(value) >= schema.get('minLength', 0), at + ': minLength')
        if 'pattern' in schema:
            require(re.search(schema['pattern'], value) is not None, at + ': pattern')


def portable(name):
    return (isinstance(name, str) and 0 < len(name) <= 240 and
            not re.search(r'[\\\x00-\x1f<>:"|?*]', name) and
            all(p not in ('', '.', '..') and not p.endswith(('.', ' ')) and
                not re.match(r'(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', p)
                for p in name.split('/')))


def no_aliases(path):
    for item in (path, *path.parents):
        info = item.lstat()
        require(not item.is_symlink() and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'alias path')


def safe_bytes(root, name):
    require(portable(name), 'unsafe path')
    path = root / name
    no_aliases(path)
    require(path.resolve().is_relative_to(root.resolve()), 'path escapes root')
    # Kit release history is split per version (releases/<version>.json), so every file fits one limit.
    limit = 262144
    with path.open('rb') as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, 'unsafe file')
        data = handle.read(limit + 1)
    require(len(data) <= limit, 'file too large')
    data.decode('utf-8')
    return data


def selected_bytes(root=ROOT):
    selection = load(root / 'export-selection.json')
    require(set(selection) == {'format', 'releaseApproved', 'audience', 'files'}, 'selection fields')
    require(selection['format'] == 1 and selection['releaseApproved'] is False and
            selection['audience'] == 'public-candidate', 'selection authority')
    require(type(selection['files']) is list and 0 < len(selection['files']) <= MAX_FILES, 'selection size')
    result = {}
    seen = set()
    for row in selection['files']:
        require(set(row) == {'path', 'sha256'}, 'selection row fields')
        name = row['path']
        require(portable(name), 'unsafe path')
        allowed = name in ('.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json') or distributable(name)
        require(allowed, 'unapproved packaging surface')
        require(not any(p.lower() in {'review-private', 'internal', '.git', 'node_modules', 'logs', 'artifacts', '.env'} for p in name.split('/')), 'private packaging surface')
        require(name.lower() not in seen, 'duplicate selected path')
        seen.add(name.lower())
        data = safe_bytes(root, name)
        require(re.fullmatch(r'[a-f0-9]{64}', row['sha256']) is not None and
                hashlib.sha256(data).hexdigest() == row['sha256'], 'selected byte drift')
        require(not SENSITIVE.search(data), 'sensitive bytes')
        result[name] = data
    require(sum(map(len, result.values())) <= MAX_BUNDLE, 'bundle too large')
    return result


def plugin_files(root, name):
    """Every file under plugins/<name>/ outside tests/, after refusing what a Git install must never copy.

    A Git-based install copies the whole folder, tests included, so the layout and sensitive-bytes checks cover
    tests/ as well; only the candidate ZIP leaves tests out."""
    base = root / 'plugins' / name
    found = []
    # Sort by case-sensitive parts, as POSIX paths compare: Windows paths compare without case, which reorders the selection.
    for path in sorted(base.rglob('*'), key=lambda p: p.relative_to(root).as_posix().split('/')):
        rel = path.relative_to(root).as_posix()
        parts = rel.split('/')
        require(not path.is_symlink(), 'symlink in plugin: ' + rel)
        require(not STRAY_DIRS.intersection(parts), 'stray folder in plugin: ' + rel)
        hooks_exception = name in HOOK_PLUGINS and parts[2] == 'hooks' and (rel in hook_files(name) or (len(parts) == 3 and path.is_dir()))
        mcp_exception = name in MCP_PLUGINS and rel in (mcp_file(name), codex_mcp_file(name)) and path.is_file()
        require(parts[2] in PLUGIN_TOP or hooks_exception or mcp_exception or (len(parts) == 3 and path.is_file() and rel.endswith('.md')),
                'unapproved plugin component: ' + rel)
        require(parts[-1].lower() not in RUNTIME_FILES or (name in HOOK_PLUGINS and rel == hooks_file(name)) or mcp_exception,
                'runtime component not admitted: ' + rel)
        # The frontmatter rules reach agents/<name>.md and skills/<name>/SKILL.md only, so nothing a host might load as
        # an agent or a skill may sit anywhere else (recursive agent loading, skill.md on a case-insensitive disk).
        require(parts[2] != 'agents' or len(parts) == 3 or (len(parts) == 4 and path.is_file() and rel.endswith('.md')),
                'agents sit directly in agents/<name>.md: ' + rel)
        require(parts[-1].lower() != 'skill.md' or (len(parts) == 5 and parts[2] == 'skills' and parts[-1] == 'SKILL.md'),
                'a skill file sits only at skills/<name>/SKILL.md: ' + rel)
        if not path.is_file():
            continue
        if parts[2] == 'tests':
            require(not SENSITIVE.search(path.read_bytes()), 'sensitive bytes in plugin tests: ' + rel)
            continue
        found.append(rel)
    return found


def git_modes(root):
    """In a Git checkout, every tracked plugin and catalog file must be a regular 100644 blob (no links, no exec bits)."""
    if not (root / '.git').exists():
        return
    import subprocess
    out = subprocess.run(['git', '-C', str(root), 'ls-files', '-s', '--', 'plugins', '.claude-plugin', '.agents'],
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        mode, _sha, _stage, path = line.split(None, 3)
        require(mode == '100644', f'tracked file mode {mode}: {path}')


def record_coverage(root):
    """Every decision has a row in docs/decisions.md, every Record cell names a decision, and every Markdown
    document outside .git and node_modules is a record's source or sits under a spec's covers path."""
    text = '\n'.join(p.read_text(encoding='utf-8') for p in sorted((root / '.ia/src').glob('*.ia')))
    decisions = set(re.findall(r'^@decision ([a-z0-9-]+)$', text, re.M))
    index = (root / 'docs/decisions.md').read_text(encoding='utf-8')
    for decision in sorted(decisions):
        require(f'`{decision}`' in index, 'decision missing from docs/decisions.md: ' + decision)
    for cell in re.findall(r'\| `([a-z0-9-]+)` \|$', index, re.M):
        require(cell in decisions, 'docs/decisions.md names a decision with no record: ' + cell)
    sources = set(re.findall(r'^    source "([^"#]+)', text, re.M))
    covers = [c for line in re.findall(r'^    covers \[(.*)\]$', text, re.M) for c in re.findall(r'"([^"]+)"', line)]
    for path in sorted(root.rglob('*.md')):
        rel = path.relative_to(root).as_posix()
        if {'.git', 'node_modules', '.scratch', 'build', 'review-private'} & set(rel.split('/')):
            continue
        require(rel in sources or any(rel == c or (c.endswith('/') and rel.startswith(c)) for c in covers),
                'document without a record (add a source or covers path): ' + rel)


# Composed COMP-CHECK gates the maintainers keep host-run: the kit's checks.json gives them no runner on purpose.
# Any other composed COMP-CHECK without a runner is a packaging slip that the core's resolve.mjs would only report as check-unavailable, so the validator refuses it.
HOST_RUN_CHECKS = {}


def host_run_checks(root, allowed=HOST_RUN_CHECKS):
    """Every check a kit's capability composes has a runner in the kit's checks.json, is IA-evaluated (its record
    runs a built-in evaluator other than COMP-CHECK), or is listed in HOST_RUN_CHECKS; no listed check is stale."""
    found = {}
    for kit in sorted(p for p in (root / 'kits').iterdir() if (p / '.ia/src').is_dir()):
        runs, composed = {}, set()
        for path in sorted((kit / '.ia/src').rglob('*.ia')):
            text = path.read_text(encoding='utf-8')
            for kind, name, body in re.findall(r'^@([a-z-]+) ([a-z0-9-]+)\n((?:(?: +.*)?\n)*)', text, re.M):
                if kind == 'check':
                    runs[name] = (re.findall(r'^    runs (\S+)$', body, re.M) or [None])[0]
                elif kind == 'capability':
                    composed.update(n for line in re.findall(r'^    checks \[([^]]*)\]', body, re.M) for n in re.findall(r'@check ([a-z0-9-]+)', line))
        checks = kit / 'checks.json'
        runners = set(load(checks)['checks']) if checks.exists() else set()
        found[kit.name] = {n for n in composed if n not in runners and runs.get(n) in (None, 'COMP-CHECK')}
        for name in sorted(found[kit.name] - allowed.get(kit.name, set())):
            require(False, f'{kit.name}: composed check {name} has no runner in checks.json; give it one or list it in HOST_RUN_CHECKS')
    for kit, names in sorted(allowed.items()):
        for name in sorted(names - found.get(kit, set())):
            require(False, f'{kit}: HOST_RUN_CHECKS lists {name}, which is no longer a composed check without a runner; remove it')


def validate(root=ROOT):
    entries = selected_bytes(root)
    git_modes(root)
    schema = load(root / 'schemas/plugin-manifest.schema.json')
    listing = 0
    skills = {name: [] for name in PLUGINS}
    dependencies = {}
    for name in PLUGINS:
        base = f'plugins/{name}'
        manifests = []
        for host in ('claude', 'codex'):
            p = f'{base}/.{host}-plugin/plugin.json'
            require(p in entries, 'missing selected manifest')
            manifest = load(root / p)
            require(isinstance(manifest, dict), 'a manifest must be a JSON object: ' + p)
            if host == 'codex' and name in QUALIFIED_CODEX_HOOKS:
                expected = QUALIFIED_CODEX_HOOKS[name][0]
                require(manifest.pop('hooks', None) == expected, name + ' names its qualified Codex hooks: its Codex manifest needs "hooks": "' + expected + '"')
            elif host == 'codex' and name in HOOK_PLUGINS:
                require(manifest.pop('hooks', None) == CODEX_HOOKS_OFF, name + ' keeps its hooks off in Codex: its Codex manifest needs "hooks": {"hooks": {}}')
            if host == 'codex' and name in MCP_PLUGINS:
                # Codex reads a plugin's .mcp.json too, and expands only ${PLUGIN_ROOT}; the manifest names the Codex door file (decision public-door-codex).
                require(manifest.pop('mcpServers', None) == CODEX_MCP_DOOR, name + ' names its door in Codex: its Codex manifest needs "mcpServers": "./.codex-mcp.json"')
            schema_check(manifest, schema)
            require(manifest['name'] == name, 'plugin identity')
            if host == 'codex':
                require(manifest.get('skills') == './skills/', 'codex skills path')
                require(not set(CLAUDE_ONLY) & set(manifest), 'Claude-only field in the Codex manifest (Codex reads interface.displayName and has no dependencies): ' + p)
                require('interface' in manifest, 'the Codex manifest needs an interface block: ' + p)
            else:
                require(manifest.get('displayName') and 'skills' not in manifest and 'interface' not in manifest, 'the Claude manifest needs displayName and no Codex fields: ' + p)
            manifests.append(manifest)
        claude, codex = manifests
        interface = codex['interface']
        require(interface['displayName'] == claude['displayName'], 'Codex interface displayName drift: ' + name)
        short = interface['shortDescription']
        cut = short.rstrip('.…').rstrip()
        require(len(short) <= SHORT_DESCRIPTION and not claude['description'].startswith(cut), f'Codex shortDescription must be its own summary of at most {SHORT_DESCRIPTION} chars: ' + name)
        shared = {k: v for k, v in claude.items() if k not in CLAUDE_ONLY}
        require({k: v for k, v in codex.items() if k not in ('skills', 'interface')} == shared, 'host manifest drift')
        for dependency in claude.get('dependencies', []):
            require(dependency in PLUGINS and dependency != name, 'a dependency must name another plugin of this catalogue: ' + name + ' -> ' + dependency)
        dependencies[name] = claude.get('dependencies', [])
        require(f'{base}/CODEX.md' in entries, 'missing CODEX.md (the Codex host instructions every skill links): ' + name)
        for entry in ENTRY_SKILLS.get(name, (name,)):
            p = f'{base}/skills/{entry}/SKILL.md'
            require(p in entries, 'missing selected skill')
            text = entries[p].decode()
            require(text.startswith('---\nname: ' + entry + '\n') and '\n---\n' in text, 'skill frontmatter')
            require(len(text.encode()) <= ENTRY_SKILL_BYTES, 'entry skill context budget')
        # The selection is the whole shipped plugin: a Git-based install copies the folder, so nothing may ship unreviewed.
        on_disk = set(plugin_files(root, name))
        selected = {e for e in entries if e.startswith(base + '/')}
        require(on_disk == selected, 'selection incomplete or stale for ' + name + ': ' + ', '.join(sorted(on_disk ^ selected))[:300])
        invocable = []
        for skill in sorted(e for e in selected if re.fullmatch(re.escape(base) + r'/skills/[^/]+/SKILL\.md', e)):
            folder = skill.split('/')[-2]
            fields = frontmatter(entries[skill].decode())
            require(not runtime_keys(fields), 'runtime component not admitted in skill frontmatter: ' + skill)
            require(fields.get('name') == folder, 'skill name must equal its folder: ' + skill)
            description = fields.get('description', '')
            require(0 < len(description) <= 400 and TRIGGER.search(description), 'skill description needs what and when (<=400 chars): ' + skill)
            listing += len(folder) + len(description)
            if fields.get('disable-model-invocation', '').lower() != 'true':
                invocable.append(folder)
            elif not (name in UNADVERTISED and folder == name):
                require(len(description) <= HIDDEN_DESCRIPTION, f'hidden skill description over {HIDDEN_DESCRIPTION} chars: ' + skill)
            text = entries[skill].decode()
            body = text[text.index('\n---\n', 4) + 5:].lstrip('\n')
            require(CODEX_BRIDGE.match(body.split('\n', 1)[0]), 'skill must open with the Codex bridge line linking ../../CODEX.md: ' + skill)
            skills[name].append(folder)
        if name in UNADVERTISED:
            require(name in skills[name] and name not in invocable, 'the entry skill of an unadvertised plugin exists and is not model-invocable (disable-model-invocation: true): ' + name)
        else:
            for entry in ENTRY_SKILLS.get(name, (name,)):
                require(entry in invocable, 'the entry skill must be model-invocable: ' + entry)
        require(len(invocable) <= MODEL_INVOCABLE_PER_PLUGIN, 'too many model-invocable skills in ' + name + ': ' + ', '.join(invocable))
        for agent in sorted(e for e in selected if re.fullmatch(re.escape(base) + r'/agents/[^/]+\.md', e)):
            fields = frontmatter(entries[agent].decode())
            require(not runtime_keys(fields), 'runtime component not admitted in agent frontmatter: ' + agent)
            require(fields.get('name') and fields.get('model'), 'agent needs name and model: ' + agent)
            require(re.search(r'(?i)\buse this agent\b', fields.get('description', '')), 'agent description needs "Use this agent": ' + agent)
            # A denylist still inherits Agent, PowerShell, Skill and every MCP tool, so agents declare an allowlist.
            tools = fields.get('tools', '').strip()
            require(tools and tools not in ('*', '[]') and not fields.get('disallowedTools'), 'agent needs a tools allowlist: ' + agent)
    require(listing <= LISTING_BUDGET, f'skill listing over budget: {listing} > {LISTING_BUDGET} chars of names and descriptions')
    # A dependency cycle would make two plugins each install the other; refuse any.
    def reaches(start, target, seen=()):
        return any(d == target or (d not in seen and reaches(d, target, seen + (d,))) for d in dependencies.get(start, []))
    for name in PLUGINS:
        require(not reaches(name, name), 'dependency cycle through ' + name)
    # Compared as JSON text, so a 30.0 timeout or a reordered handler key is not taken for the qualified 30.
    canonical = lambda value: json.dumps(value, sort_keys=True)
    for name in HOOK_PLUGINS:
        require(canonical(load(root / hooks_file(name))) == canonical(qualified_hooks(name)), name + ' hooks differ from the qualified set: ' + hooks_file(name))
    pins = load(root / 'sources.lock.json')
    for name in MCP_PLUGINS:
        require(mcp_file(name) in entries, name + ' ships the IA door: ' + mcp_file(name) + ' must exist and be selected')
        require(f'plugins/{name}/scripts/door.mjs' in entries, name + ' ships the IA door launcher: plugins/' + name + '/scripts/door.mjs')
        require(canonical(load(root / mcp_file(name))) == canonical(qualified_mcp()),
                name + ' MCP servers differ from the qualified door: ' + mcp_file(name))
        require(codex_mcp_file(name) in entries and canonical(load(root / codex_mcp_file(name))) == canonical(qualified_codex_mcp()),
                name + ' Codex door differs from the qualified door: ' + codex_mcp_file(name))
    for name, (_, table) in QUALIFIED_CODEX_HOOKS.items():
        require(canonical(load(root / codex_hooks_file(name))) == canonical(render_hooks(table)), name + ' Codex hooks differ from the qualified set: ' + codex_hooks_file(name))
    catalog_paths = ('.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json')
    for index, catalog_path in enumerate(catalog_paths):
        require(catalog_path in entries, 'missing catalog')
        catalog = load(root / catalog_path)
        schema_check(catalog, load(root / ('schemas/claude-marketplace.schema.json' if index == 0 else 'schemas/codex-marketplace.schema.json')))
        require([p['name'] for p in catalog['plugins']] == list(PLUGINS), 'catalog plugin set')
        for plugin in catalog['plugins']:
            expected_path = './plugins/' + plugin['name']
            if index == 0:
                require(plugin['source'] == expected_path, 'remote catalog source')
                require(plugin['description'] == load(root / f"plugins/{plugin['name']}/.claude-plugin/plugin.json")['description'], 'catalog description drift')
            else:
                require(plugin['source'] == {'source':'local', 'path':expected_path}, 'codex source path')
    # Every plugin-local relative Markdown link must resolve to another selected file.
    import posixpath
    for name, data in entries.items():
        if not name.endswith('.md'):
            continue
        for href in re.findall(r'\]\(([^)]+)\)', data.decode()):
            if href.startswith(('https://', '#')):
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), href.split('#')[0]))
            if name.startswith('plugins/'):
                own = '/'.join(name.split('/')[:2]) + '/'
                require(target.startswith(own), 'link leaves its plugin (plugins install separately): ' + name + ' -> ' + href)
            folder = target.rstrip('/') + '/'
            require(target in entries or any(e.startswith(folder) for e in entries), 'unselected or broken plugin reference: ' + target)
    # ${CLAUDE_PLUGIN_ROOT}/<path> in shipped text must name a shipped file or folder of the same plugin.
    for name, data in entries.items():
        if not name.startswith('plugins/') or not name.endswith(('.md', '.json', '.mjs', '.js', '.cjs', '.yml', '.yaml', '.txt')):
            continue
        plugin = '/'.join(name.split('/')[:2])
        for ref in re.findall(r'\$\{?CLAUDE_PLUGIN_ROOT\}?/([A-Za-z0-9_./-]+)', data.decode()):
            ref = ref.rstrip('.')
            target = posixpath.normpath(plugin + '/' + ref)
            require(target == plugin or target.startswith(plugin + '/'), 'plugin-root path leaves its plugin: ' + name + ' -> ' + ref)
            if not ref or ref.endswith('/'):
                continue
            require(target in entries or any(e.startswith(target + '/') for e in entries), 'unresolved ${CLAUDE_PLUGIN_ROOT} path: ' + target)
    for record in (root / '.ia/src').glob('*.ia'):
        text = record.read_text()
        require(text.startswith('#! ia 1.0\n'), 'native grammar header')
        for source in re.findall(r'^    source "([^"]+)"', text, re.M):
            safe_bytes(root, source)
    record_coverage(root)
    host_run_checks(root)
    require(pins['released']['cli'] == '3.5.0' and 'pending' not in pins, 'release standing: sources.lock.json pins the released 3.5.0 and no unreleased build')
    schema_check(load(root / 'examples/review-dossier.json'), load(root / 'schemas/review-dossier.schema.json'))
    return {'status':'passed', 'plugins':len(PLUGINS), 'selectedFiles':len(entries), 'skills':skills,
            'hostQualified':False, 'policyRatified':False}


if __name__ == '__main__':
    try:
        print(json.dumps(validate(), sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('Validation refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
