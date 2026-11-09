// Native semantics are loaded only through the caller's attested runtime.
import { createHash } from 'node:crypto';

const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = values => [...new Set(values)].sort(order);
const plain = value => JSON.parse(JSON.stringify(value));
function fail(message, code = 'IA-CORE-COMPOSITION-MISSING') {
  throw Object.assign(new Error(message), { code });
}
function field(record, section, key) {
  return record.sections.find(row => row.name === section)?.fields.find(row => row.key === key)?.value;
}
function references(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'ref' || value.kind === 'identity') { visit(value); return; }
  for (const child of Object.values(value)) references(child, visit);
}
async function opened(root, importNative, action) {
  if (typeof importNative !== 'function') fail('An attested native importer is required', 'IA-CORE-CLOSURE-UNSUPPORTED');
  const { openWorkspaceSession } = await importNative('@inventarch/distribution/services');
  const { systemMember } = await importNative('@inventarch/db');
  const session = openWorkspaceSession({ root, checks: 'structural' });
  try {
    const admission = session.admission();
    if (admission.status !== 'admitted') fail(`Native admission refused: ${admission.findings.filter(row => row.severity === 'error').map(row => `${row.code}: ${row.message}`).join('; ')}`);
    const reader = session.reader, records = reader.records();
    const resolve = reference => {
      const result = reader.resolve(reference);
      if (!result.ok || !reader.get(result.identity)) fail(`Required native reference is unavailable: ${JSON.stringify(reference)}`);
      return reader.get(result.identity);
    };
    const system = name => resolve({ kind: 'ref', discriminator: 'system', name });
    const list = (record, section, key) => {
      const value = field(record, section, key);
      if (value === undefined) return [];
      if (value.kind !== 'list' || value.items.some(item => item.kind !== 'ref' && item.kind !== 'identity')) fail(`Expected typed reference list ${record.identity}.${section}.${key}`);
      return unique(value.items.map(item => resolve(item).identity));
    };
    const requirements = record => unique(record.sections.filter(row => row.name === 'requires').flatMap(row => row.fields).filter(row => row.item?.text !== 'floor').map(row => {
      if (typeof row.item?.text !== 'string') fail(`Malformed native system requirement: ${record.identity}`);
      return system(row.item.text).identity;
    }));
    const memberRecords = name => records.filter(record => systemMember(record.source.path)?.name === name);
    const systemRow = record => ({ identity: record.identity, revision: createHash('sha256').update(JSON.stringify(memberRecords(record.name).map(row => ({ digest: row.digest, identity: row.identity })).sort((a, b) => order(a.identity, b.identity)))).digest('hex') });
    return plain(await action({ reader, records, resolve, system, list, requirements, memberRecords, systemRow, systemMember, findings: admission.findings }));
  } finally { session.close(); }
}

export async function inspectMethodGraph({ root, descriptor, nativeManifest, importNative, workspaceContracts = {}, capabilityContracts = {} }) {
  return opened(root, importNative, ({ reader, records, resolve, system, list, memberRecords, systemRow, systemMember, findings }) => {
    if (!nativeManifest?.roots?.length || !Array.isArray(nativeManifest.systems) || !Array.isArray(nativeManifest.files)) fail('Verified native release manifest is required');
    if (descriptor.id !== nativeManifest.id || descriptor.version !== nativeManifest.version) fail('Native manifest release differs from descriptor');
    const distribution = reader.get(descriptor.distribution);
    if (!distribution || distribution.discriminator !== 'distribution') fail('Release distribution is not admitted');
    const distributionRoots = list(distribution, 'distribution', 'records');
    if (JSON.stringify(distributionRoots) !== JSON.stringify(unique(nativeManifest.roots))) fail('Native manifest roots differ from admitted distribution');
    const paths = new Set(nativeManifest.files.filter(row => row.role === 'source').map(row => row.path));
    const names = new Set(nativeManifest.systems.map(row => row.name));
    const retained = records.filter(record => paths.has(record.source.path));
    for (const identity of distributionRoots) if (!retained.some(row => row.identity === identity)) fail(`Distribution root is not retained: ${identity}`);
    for (const name of names) {
      if (!paths.has(system(name).source.path)) fail(`System declaration is not retained: ${name}`);
      for (const record of memberRecords(name)) {
        if (!paths.has(record.source.path)) fail(`System membership is incomplete: ${record.identity}`);
        references(record, resolve);
      }
    }
    const systems = [...names].map(name => systemRow(system(name))).sort((a, b) => order(a.identity, b.identity));
    const packagedWorkspaces = retained.filter(row => row.discriminator === 'workspace').map(record => {
      const contract = workspaceContracts[record.identity];
      if (!contract || typeof contract.workKind !== 'string' || !contract.workKind.trim() || !Array.isArray(contract.boundaryEvidence) || !contract.boundaryEvidence.length || contract.boundaryEvidence.some(value => typeof value !== 'string' || !value.trim())) fail(`Workspace needs qualified work kind and boundary evidence: ${record.identity}`);
      return { identity: record.identity, revision: record.digest, systems: list(record, 'composition', 'systems'), workKind: contract.workKind, boundaryEvidence: unique(contract.boundaryEvidence) };
    }).sort((a, b) => order(a.identity, b.identity));
    for (const identity of Object.keys(workspaceContracts)) if (!packagedWorkspaces.some(row => row.identity === identity)) fail(`Workspace qualification names an unretained workspace: ${identity}`);
    const capabilities = retained.filter(row => row.discriminator === 'capability').map(record => {
      const owner = systemMember(record.source.path);
      if (!owner || !names.has(owner.name)) fail(`Capability has no retained authoring system: ${record.identity}`);
      const playbooks = list(record, 'composition', 'playbooks'), checks = list(record, 'composition', 'checks');
      const profiles = unique(retained.filter(row => row.discriminator === 'agent-profile' && list(row, 'composition', 'capabilities').includes(record.identity)).map(row => row.identity));
      const mode = capabilityContracts[record.identity]?.mode ?? (playbooks.length || checks.length ? 'executable' : null);
      if (!['executable', 'inspection-only'].includes(mode) || (mode === 'executable' && !playbooks.length && !checks.length)) fail(`Capability requires explicit supported execution mode: ${record.identity}`);
      return { identity: record.identity, vocabularyOwner: system(record.system).identity, authoringSystem: system(owner.name).identity, sourcePath: record.source.path, profile: profiles.length === 1 ? profiles[0] : null, profiles, playbooks, checks, mode };
    }).sort((a, b) => order(a.identity, b.identity));
    for (const identity of Object.keys(capabilityContracts)) if (!capabilities.some(row => row.identity === identity)) fail(`Capability qualification names an unretained capability: ${identity}`);
    return { revision: reader.revision, distributionRoots, packagedWorkspaces, systems, capabilities, records: retained, findings };
  });
}

// With no workspace named, the subject is IA's repository default (from IA 3.5.1 the unique workspace in
// .ia/src/workspace.ia), unless a distribution this repository authors packages workspaces: then the default must be
// one of those packaged roots, so a packaged composition is never chosen by accident (public-cli-3-6-0-default-workspace
// C). Adopted distributions (the language base, installed kits) package their own roots, never this repository's.
function defaultWorkspace(reader, records, list) {
  const seat = reader.resolveSeat('').seat;
  const roots = new Set(records.filter(record => record.discriminator === 'distribution' && record.provenance === 'workspace')
    .flatMap(record => list(record, 'distribution', 'records')).filter(identity => reader.get(identity)?.discriminator === 'workspace'));
  return !roots.size || roots.has(seat) ? seat : undefined;
}

export async function resolveConsumerSubject({ root, workspaceIdentity, importNative }) {
  return opened(root, importNative, ({ reader, records, list, requirements, systemRow, findings }) => {
    const identity = workspaceIdentity ?? defaultWorkspace(reader, records, list);
    const workspace = identity && reader.get(identity);
    if (!workspace || workspace.discriminator !== 'workspace') fail('Select an unambiguous admitted consumer native workspace');
    const selected = new Set(list(workspace, 'composition', 'systems')), pending = [...selected];
    while (pending.length) {
      const record = reader.get(pending.shift());
      if (!record || record.discriminator !== 'system') fail('Workspace composition names an unavailable system');
      for (const required of requirements(record)) if (!selected.has(required)) { selected.add(required); pending.push(required); }
    }
    return { identity, revision: reader.revision, systems: [...selected].sort(order).map(id => systemRow(reader.get(id))), records, findings };
  });
}
