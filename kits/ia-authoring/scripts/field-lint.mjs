// authored in inventarch/ia-authoring-kit 0.1.0: the governance lint of the ia-authoring-record system; runnable from the kit folder, it imports the kit's own scratch-capture helper (./lib/scratch.mjs)
// Governance lint. Closed IA schemas refuse unknown sections (IA-COMP-SECTION-UNKNOWN) and unknown fields inside a
// declared section (IA-COMP-FIELD-UNKNOWN), with one practical exception: keys under `governance` are compiler-consumed
// clauses (the variant `requires`, the `severity` dimension) and are never field-checked, so ANY key there is admitted
// (rule R11, the authoring-ia-rules-schemas-and-ids convention; observed on @agent, @mandate and @law, and re-verified on @law with @inventarch/cli 2.0.0, 3.1.1, 3.2.2, 3.3.0 and 3.4.0).
// A misspelled governance clause, such as `require [...]` beside `applies`, validates and silently does nothing.
// This reports every governance key that is neither declared by the word's @schema nor a known carrier.
//
//   node field-lint.mjs [--root <workspace>] [--cli <ia main.js>] [--artifact <snapshot.json>] [--json]
//
// Writes nothing in the workspace: it captures a temp copy. Without --cli or IA_CLI_PATH the workspace's own
// node_modules/@inventarch/cli runs, else @inventarch/cli 3.8.0 through npx; never the `ia` on the PATH.
import fs from 'node:fs';
import {scratchArtifact, readArtifact} from './lib/scratch.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const GOVERNANCE_CARRIERS=['applies','requires','severity'];
// Edit distance, so a dropped, doubled or swapped letter inside the first four (`aplies`) still finds its clause.
const distance=(a,b)=>{let prev=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){const cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur}return prev[b.length]};
// @schema <word>: section "fields" holds entries keyed "must have"/"may have" whose text is "<section>.<field> as <type>".
// An enum field ("… as id in [a, b]") compiles differently: the declaration moves into the key and the value is the list.
export function lintGovernance(records,{local=r=>(r.source?.path||'').startsWith('.ia/src/')}={}){
 const declared=new Map();
 for(const s of records.filter(r=>r.discriminator==='schema')){
  const bySection=new Map();
  for(const f of s.sections?.find(x=>x.name==='fields')?.fields||[]){
   const m=/^([\w-]+)\.([\w-]+)\s+as\b/.exec(f.value?.text||'')||/^(?:must|may) have ([\w-]+)\.([\w-]+)\s+as\b/.exec(f.key||'');if(!m)continue;
   if(!bySection.has(m[1]))bySection.set(m[1],new Set());bySection.get(m[1]).add(m[2]);
  }
  declared.set(s.name,bySection);
 }
 const findings=[];
 for(const r of records){
  if(!local(r))continue;
  const schema=declared.get(r.discriminator);if(!schema)continue;
  const sec=r.sections?.find(s=>s.name==='governance');if(!sec)continue;
  const known=new Set([...(schema.get('governance')||[]),...GOVERNANCE_CARRIERS]);
  for(const f of sec.fields||[]){if(!f.key||known.has(f.key))continue;
   const near=[...known].find(k=>k.replace(/[^a-z]/g,'')===f.key.replace(/[^a-z]/g,'')||(k.length>3&&(k.startsWith(f.key.slice(0,4))||f.key.startsWith(k.slice(0,4))))||distance(k,f.key)<=2);
   findings.push({record:`@${r.discriminator} ${r.name}`,field:`governance.${f.key}`,at:`${r.source.path}:${f.span?.line??r.source.line}`,known:[...known],suggestion:near??null});}
 }
 return findings;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const args=process.argv.slice(2),one=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined};
const root=path.resolve(one('--root')||process.cwd()),cli=one('--cli');
let artifact;
// A CLI that cannot be resolved (or is below 3.x) is a one-line refusal and exit 2, never exit 1, which means findings.
try{artifact=one('--artifact')?readArtifact(path.resolve(one('--artifact'))):scratchArtifact(root,cli).artifact}
catch(error){console.error(error.message);process.exitCode=2}
if(artifact){

const findings=lintGovernance(artifact.records||[]);
if(args.includes('--json'))console.log(JSON.stringify(findings,null,2));
else{
 if(!findings.length)console.log('governance lint: every governance key of every local record is declared or a known clause');
 else{console.log(`governance lint: ${findings.length} governance key(s) IA admitted but will not use:`);
  for(const f of findings)console.log(`  ${f.at}  ${f.record}  ${f.field}${f.suggestion?`  (did you mean governance.${f.suggestion}?)`:''}\n      known here: ${f.known.join(', ')}`);}
}
process.exitCode=findings.length?1:0;
}
}
