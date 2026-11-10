// The exit-evidence report: whether each closed task carries an observation
// that supports closing it (principle method-claims-within-evidence, decision
// public-method-report-gate). The report is advisory: it never blocks.
//
// The principle says three things this report applies:
//   - a failed run outweighs a passing one on the same target and revision;
//   - a verdict covers only the revision it was taken at;
//   - an environment failure leaves the claim unrun, not passed.
//
// A task is closed when its work.status is closed. Its candidate observations
// are the @observation records that name it as evidence.subject, or that its
// work.exit-evidence names. An observation is current when its
// evidence.subject-revision equals the task's own digest, as ia inspect
// reports it. Positions, in this order of precedence:
//
//   refused:      a current refusal. It wins over a success and over an
//                 exemption, and stands even when another candidate could not
//                 be read.
//   unknown:      the task or any candidate could not be read. Not evaluated:
//                 never read it as evidenced.
//   evidenced:    a current success.
//   exempt:       a candidate whose interpretation.basis is nothing-to-run. It
//                 is the author's declaration, not verified, so it is listed
//                 and is not a finding; it needs no currency.
//   inconclusive: a current inconclusive, with no current success.
//   stale:        a success at another revision, or with no revision recorded.
//   no-evidence:  no candidate, or none with a verdict.
//
// A refusal at another revision, or with no revision recorded, is not
// current: it is listed as information and does not make the task refused.
//
// This reading is stricter than ia next in one place: ia next calls a task
// evidenced as soon as one current success exists, whatever else was
// observed; this report reads the current refusal first.
//
// The input is a graph of records as `ia inspect` reports them, where a record
// that could not be read is null:
//   { identity: { word: 'task', status, digest, observations: [identity] }
//             | { word: 'observation', verdict, subjectRevision, basis }
//             | null }

export const NOTHING_TO_RUN = 'nothing-to-run';

// Positions that are findings, in the order the counts line lists them.
const FINDINGS = new Set(['refused', 'inconclusive', 'stale', 'no-evidence']);

export function shortName(identity) {
  return identity.split('/').slice(-2).join('/');
}

const field = (record, section, key) => record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
const isNonEmpty = value => typeof value === 'string' && value.length > 0;

// Reduces one `ia inspect <task> --edges both --json` record and its directed
// rows to the task node above. A row counts when it is the task's own, at
// depth 1, for work.exit-evidence (out) or evidence.subject (in), and its
// counterpart is an observation; the union is deduplicated.
export function taskFromInspect(record, directed = []) {
  const found = new Set();
  for (const row of directed) {
    if (row?.identity !== record.identity || row.depth !== 1) continue;
    const wanted = (row.field === 'work.exit-evidence' && row.direction === 'out') || (row.field === 'evidence.subject' && row.direction === 'in');
    if (!wanted || typeof row.counterpart !== 'string') continue;
    if (row.counterpart.split('/')[2] !== 'observation') continue;
    found.add(row.counterpart);
  }
  return {
    word: record.discriminator,
    status: field(record, 'work', 'status')?.text,
    digest: record.digest,
    observations: [...found],
  };
}

// Reduces one `ia inspect <observation> --depth 0 --json` record.
export function observationFromInspect(record) {
  const text = (section, key) => {
    const value = field(record, section, key)?.text;
    return isNonEmpty(value) ? value : undefined;
  };
  return {
    word: record.discriminator,
    verdict: text('evidence', 'verdict'),
    subjectRevision: text('evidence', 'subject-revision'),
    basis: text('interpretation', 'basis'),
  };
}

function judge(identity, task, graph) {
  const entry = { identity, position: undefined, finding: false, evaluated: true, digest: task?.digest, observations: [], exemptBy: [], unreadable: [], information: [] };
  if (!task || task.word !== 'task') {
    entry.position = 'unknown';
    entry.evaluated = false;
    entry.unreadable.push(identity);
    return entry;
  }
  entry.status = task.status;
  if (task.status !== 'closed') {
    entry.position = 'not-closed';
    return entry;
  }
  for (const id of task.observations ?? []) {
    const node = graph[id];
    if (!node || node.word !== 'observation') { entry.unreadable.push(id); continue; }
    const revision = !node.subjectRevision ? 'none' : node.subjectRevision === task.digest ? 'current' : 'other';
    entry.observations.push({ identity: id, verdict: node.verdict ?? null, basis: node.basis ?? null, subjectRevision: node.subjectRevision ?? null, revision });
  }
  const seen = entry.observations;
  const current = verdict => seen.filter(o => o.verdict === verdict && o.revision === 'current');
  entry.exemptBy = seen.filter(o => o.basis === NOTHING_TO_RUN).map(o => o.identity);
  for (const o of seen) {
    if (o.verdict === 'refusal' && o.revision !== 'current') {
      entry.information.push(`${shortName(o.identity)} is a refusal ${o.revision === 'none' ? 'with no revision recorded' : 'at another revision'}, so it is not current and does not make the task refused`);
    }
  }
  if (current('refusal').length) entry.position = 'refused';
  else if (entry.unreadable.length) { entry.position = 'unknown'; entry.evaluated = false; }
  else if (current('success').length) entry.position = 'evidenced';
  else if (entry.exemptBy.length) entry.position = 'exempt';
  else if (current('inconclusive').length) entry.position = 'inconclusive';
  else if (seen.some(o => o.verdict === 'success')) entry.position = 'stale';
  else entry.position = 'no-evidence';
  entry.finding = FINDINGS.has(entry.position);
  return entry;
}

export function exitEvidenceReport(graph, taskIds) {
  const tasks = taskIds.map(id => judge(id, graph[id], graph));
  const count = p => tasks.filter(t => t.position === p).length;
  return {
    tasks,
    counts: {
      closed: tasks.filter(t => t.status === 'closed').length,
      evidenced: count('evidenced'),
      exempt: count('exempt'),
      refused: count('refused'),
      inconclusive: count('inconclusive'),
      stale: count('stale'),
      noEvidence: count('no-evidence'),
      unknown: count('unknown'),
      notClosed: count('not-closed'),
      findings: tasks.filter(t => t.finding).length,
    },
  };
}

const LABEL = {
  evidenced: 'EVIDENCED',
  exempt: 'EXEMPT',
  refused: 'REFUSED',
  inconclusive: 'INCONCLUSIVE',
  stale: 'STALE',
  'no-evidence': 'NO EVIDENCE',
  unknown: 'UNKNOWN (NOT EVALUATED)',
  'not-closed': 'NOT CLOSED',
};

export const labelOf = position => LABEL[position] ?? position.toUpperCase();

const names = list => list.map(o => shortName(o.identity ?? o)).join(', ');

// One line per task; the first words are the capitalised position, so a
// reader that stops at the first line cannot mistake a finding for a pass.
export function describe(entry) {
  const name = shortName(entry.identity);
  const label = labelOf(entry.position);
  const extra = entry.information.length ? `; note: ${entry.information.join('; ')}` : '';
  const unread = entry.unreadable.length ? `could not read ${names(entry.unreadable)}` : '';
  const by = verdict => names(entry.observations.filter(o => o.verdict === verdict && o.revision === 'current'));
  switch (entry.position) {
    case 'evidenced': return `${label}: ${name}: a current success (${by('success')})${extra}`;
    case 'exempt': return `${label}: ${name}: declared nothing to run by ${names(entry.exemptBy)} (the author's declaration, not verified; not a finding)${extra}`;
    case 'refused': return `${label}: ${name}: a current refusal (${by('refusal')}) outweighs any success at this revision${unread ? `; ${unread}` : ''}${extra}`;
    case 'inconclusive': return `${label}: ${name}: a current inconclusive verdict (${by('inconclusive')}) and no current success${extra}`;
    case 'stale': {
      const successes = entry.observations.filter(o => o.verdict === 'success');
      const why = successes.map(o => `${shortName(o.identity)} ${o.revision === 'none' ? 'records no revision' : 'is for another revision'}`).join(', ');
      return `${label}: ${name}: no success is current (${why}); the task's current digest is ${entry.digest}${extra}`;
    }
    case 'no-evidence': return `${label}: ${name}: closed with no observation that holds a verdict${extra}`;
    case 'unknown': return `${label}: ${name}: ${unread}: do not treat it as evidenced${extra}`;
    default: return `${label}: ${name}: status ${entry.status ?? 'unknown'}; not evaluated`;
  }
}
