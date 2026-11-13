"""Maintainer-only: derive runtime byte pins from integrity-checked registry archives.

No package code or lifecycle scripts are executed; archives are never extracted.
Usage: python tools/qualify-runtime-cohort.py <artifact-directory>
"""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'plugins/ia/config/qualified-runtime-3.8.0.json'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    artifacts = Path(sys.argv[1]).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    pending = ['@inventarch/cli']
    packages = {}
    while pending:
        name = pending.pop()
        if name in packages:
            continue
        pin = lock['packages']['node_modules/' + name]
        if name.startswith('@inventarch/'):
            assert pin['version'] == '3.8.0'
        assert pin['resolved'].startswith('https://registry.npmjs.org/')
        archive = artifacts / (name.replace('@', '').replace('/', '-') + '-' + pin['version'] + '.tgz')
        if archive.exists():
            data = archive.read_bytes()
        else:
            with urllib.request.urlopen(pin['resolved'], timeout=120) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            assert len(data) <= 64 * 1024 * 1024
        assert pin['integrity'] == 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
        archive.write_bytes(data)
        files, folded, total, metadata = [], set(), 0, None
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            for entry in tar:
                if entry.isdir():
                    continue
                assert entry.isfile() and entry.name.startswith('package/')
                rel = entry.name[len('package/'):]
                path = PurePosixPath(rel)
                assert rel and not path.is_absolute() and '..' not in path.parts
                assert '\\' not in rel and ':' not in rel and 'node_modules' not in path.parts
                assert rel.casefold() not in folded
                folded.add(rel.casefold())
                total += entry.size
                assert entry.size <= 32 * 1024 * 1024 and total <= 256 * 1024 * 1024 and len(files) < 20000
                content = tar.extractfile(entry).read()
                files.append({'path': rel, 'sha256': sha(content), 'bytes': len(content)})
                if rel == 'package.json':
                    metadata = json.loads(content)
                if name == '@inventarch/cli' and rel == 'assets/bases.json':
                    carried = json.loads(content)
                if name == '@inventarch/cli' and rel == 'dist/main.js':
                    cli_entry = sha(content)
        assert metadata['name'] == name and metadata['version'] == pin['version']
        assert not metadata.get('optionalDependencies') and not metadata.get('peerDependencies')
        dependencies = metadata.get('dependencies', {})
        assert dependencies == pin.get('dependencies', {})
        pending.extend(dependencies)
        files.sort(key=lambda row: row['path'])
        packages[name] = {'version': pin['version'], 'integrity': pin['integrity'], 'registry': pin['resolved'],
                          'sha256': sha(canonical(files).encode()), 'files': len(files), 'bytes': total,
                          'dependencies': dependencies}
    # The CLI carries every published base (assets/bases.json); the cohort is qualified with the one the kits lock.
    pinned = json.loads((ROOT / 'sources.lock.json').read_text())['released']
    selected = [base for base in carried if base['id'] == 'inventarch/language' and base['version'] == pinned['languageVersion']]
    assert len(selected) == 1 and selected[0]['archive'] == pinned['languageArchiveSha256']
    language = selected[0]
    profile = {'format': 'inventarch.runtime-cohort/1', 'node': '22.22.x', 'cliEntrySha256': cli_entry,
               'language': language, 'packages': packages}
    OUT.write_text(json.dumps(profile, sort_keys=True, indent=2) + '\n', encoding='utf-8', newline='\n')
    (artifacts / 'profile-proof.json').write_text(json.dumps({'profileSha256': sha(canonical(profile).encode()),
        'lockSha256': sha((ROOT / 'package-lock.json').read_bytes()), 'packages': len(packages)}, indent=2) + '\n')
    print(f'Qualified archive inventory: {len(packages)} packages')


if __name__ == '__main__':
    main()
