// authored in inventarch/ia-authoring-kit 0.1.0: the toolchain probe of the ia-authoring-record system; runnable from the kit folder, it imports the kit's own scratch-capture helper (./lib/scratch.mjs)
// Probe the IA toolchain without touching the real workspace: copy .ia into a scratch directory, drop probe records
// into one system's folder and/or add whole drafted systems, validate, and report what admission said per file.
//
//   node probe.mjs --root <workspace> [--system <existing system> --file <probe.ia> [--file …]]
//                  [--add-system <draft system folder> …] [--requires owner-a,owner-b] [--set NAME=value …]
//                  [--cli <ia main.js>] [--lint] [--json] [--keep]
//
//   --file        records dropped into <system>/probes/ of the copy (with --requires added to that system first)
//   --add-system  a drafted system folder (system.ia, schemas/, records/…) copied in as .ia/src/systems/<folder name>/
//   --set         replaces NAME in every probe file, so one example can target any workspace
//   --lint        also captures the copy and reports governance keys that neither the word's schema declares nor the
//                 compiler consumes: IA refuses unknown fields everywhere except the governance section, where a
//                 misspelled clause is admitted and does nothing. With --lint those count as refusals.
//   --json        one object with a verdict per probe file (how lowered drafts are marked ready or refused)
//   --cli         the IA CLI's entry, @inventarch/cli/dist/main.js (or set IA_CLI_PATH). Without either, the workspace's
//                 own node_modules/@inventarch/cli is used, else @inventarch/cli 3.8.0 through npx; never the `ia` on
//                 the PATH. One line on stderr says which CLI ran; ia capture (with --lint, or when validate bound a
//                 check to a runner that is not built in) adds a warning line when the copy has admission errors.
//
// A check bound to a runner that is not built in is judged by native ia capture of the copy, as the strict readers
// judge it, so that capture must be allowed there: a workspace whose mandates refuse its move gets exit 3.
//
// Exit 0 = every probe file admitted (and lint-clean with --lint), 1 = refused, 2 = usage, 3 = could not probe (the
// CLI is missing, crashed or printed no findings, ia capture wrote no snapshot, or the workspace could not be
// copied). Exits 2 and 3 say nothing
// about the drafts; with --json both print {"status":"error","error":"…"}. Every usage check runs before anything is
// copied. The real workspace is only read; the copy (all of .ia except <root>/.ia/work) is deleted unless --keep is
// given. This is the kit's only copy of the probe; the probing stage (authoring-probing-the-ia-toolchain) runs it.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {copyWorkspace, readArtifact, invokeIa, resolveIa} from './lib/scratch.mjs';
import os from 'node:os';
import path from 'node:path';

const args=process.argv.slice(2),all=k=>args.flatMap((a,i)=>a===k&&args[i+1]?[args[i+1]]:[]),one=k=>all(k)[0];
// The root is canonicalised once, as copyWorkspace does; typedRoot keeps the spelling the person gave.
const typedRoot=path.resolve(one('--root')||process.cwd()),root=fs.existsSync(typedRoot)?fs.realpathSync(typedRoot):typedRoot,system=one('--system'),files=all('--file'),added=all('--add-system');
const requires=(one('--requires')||'').split(',').map(s=>s.trim()).filter(Boolean),keep=args.includes('--keep');
const lint=args.includes('--lint'),asJson=args.includes('--json'),cli=one('--cli')||process.env.IA_CLI_PATH;
const sets=all('--set').map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]});
const USAGE='usage: node probe.mjs --root <ws> [--system <name> --file <probe.ia>…] [--add-system <folder>…] [--requires a,b] [--set N=v] [--cli <main.js>] [--lint] [--json] [--keep]';
// A Stop carries its exit code: 2 for a wrong command line, 3 when the probe could not run. Anything else thrown is a 3.
// Nothing calls process.exit, so the finally that deletes the scratch copy always runs.
class Stop extends Error{constructor(exit,message){super(message);this.exit=exit}}
const usage=m=>{throw new Stop(2,m)},broken=m=>{throw new Stop(3,m)};
const clip=s=>(String(s??'').split(/\r?\n/).map(l=>l.trim()).find(Boolean)||'(nothing)').slice(0,300);
const reason=s=>{const lines=String(s??'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);return (lines.find(l=>/error|not recognized|not found|cannot|denied/i.test(l))||lines[0]||'').slice(0,300)};
const substitute=body=>{for(const [k,v] of sets)body=body.split(k).join(v);return body};
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const isDir=p=>fs.statSync(p,{throwIfNoEntry:false})?.isDirectory()??false,isFile=p=>fs.statSync(p,{throwIfNoEntry:false})?.isFile()??false;

function probe(){
 const systems=path.join(root,'.ia','src','systems');
 if(system&&(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(system)))usage('--system must be a single system name (letters, digits, underscore or hyphen)');
 if(!files.length&&!added.length)usage('nothing to probe: give --file (with --system) or --add-system');
 if(files.length&&!system)usage('--file needs --system <existing system>');
 if(requires.length&&!system)usage('--requires extends the requires block of --system <existing system>; a drafted system declares its own');
 if(system&&!fs.existsSync(path.join(systems,system,'system.ia')))usage(`no system.ia for ${system} under ${root}`);
 if(!isDir(path.join(root,'.ia')))usage(`no .ia folder under ${root}; --root takes an IA workspace`);
 for(const f of files){if(!isFile(path.resolve(f)))usage(`--file ${f} is not a file`);if(!f.endsWith('.ia'))usage(`--file ${f} needs a lowercase .ia extension for native admission`);}
 // Preflight the complete portable destination set before creating scratch.
 const folded=s=>s.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const destinations=new Set(),directories=new Set(),inputs=new Set(),inodes=new Set(),pending=[];
 const substitutionsDigest=hash(JSON.stringify(sets));
 let additionBytes=0,workspaceBytes=0,workspaceFiles=0;
 // Links refuse only below the deepest ancestor an input shares with the root (as given or canonical): copyWorkspace
 // trusts those ancestors already. An input sharing nothing above the filesystem root (another drive) is walked to it.
 const shared=(a,b)=>{const x=a.split(path.sep),y=b.split(path.sep);let i=0;while(i<x.length&&i<y.length&&x[i]===y[i])i++;return i>1?x.slice(0,i).join(path.sep):null};
 const noAlias=p=>{let cursor=path.resolve(p);const stop=[shared(cursor,typedRoot),shared(cursor,root)].filter(Boolean).sort((a,b)=>b.length-a.length)[0]??null;while(cursor!==stop){if(fs.lstatSync(cursor).isSymbolicLink())usage(`alias/symlink input: ${p}`);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}};
 const register=rel=>{const key=folded(rel.split(path.sep).join('/'));if(destinations.has(key))usage(`probe filename collision: ${rel}`);destinations.add(key);};
 const measure=dir=>{noAlias(dir);directories.add(folded(path.relative(root,dir).split(path.sep).join('/')));for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const f=path.join(dir,e.name),rel=path.relative(root,f).split(path.sep).join('/');
  if(rel==='.ia/work'||e.name==='.git'||e.name==='node_modules')continue;
  noAlias(f);if(e.isDirectory())measure(f);else{workspaceBytes+=fs.statSync(f).size;workspaceFiles++;if(workspaceBytes>512*1024*1024||workspaceFiles>20000)usage('workspace copy exceeds 512 MiB or 20000 files');register(rel);}
 }};
 measure(path.join(root,'.ia'));
 const bindingPath=path.join(root,'.ia','workspace.json');
 if(fs.existsSync(bindingPath))for(const entry of JSON.parse(fs.readFileSync(bindingPath,'utf8')).adopted??[]){
  const rel=entry.path;if(typeof rel!=='string'||path.isAbsolute(rel)||rel.split(/[\\/]/).some(x=>!x||x==='..'||x==='.')||/[:\\]/.test(rel))usage('invalid adopted source path');
  if(!rel.startsWith('.ia/'))measure(path.join(root,rel));
 }
 const queue=(input,rel)=>{noAlias(input);const identity=folded(fs.realpathSync(input));if(inputs.has(identity))usage(`repeated input: ${input}`);inputs.add(identity);if(directories.has(folded(rel)))usage(`probe filename collision with directory: ${rel}`);register(rel);
  const stat=fs.statSync(input),inode=`${stat.dev}:${stat.ino}`;if(stat.ino&&inodes.has(inode))usage(`aliased input: ${input}`);inodes.add(inode);const size=stat.size;if(size>16*1024*1024)usage('input exceeds 16 MiB');additionBytes+=size;if(additionBytes>128*1024*1024||pending.length>=256)usage('scratch additions exceed 128 MiB or 256 files');pending.push({input,rel});};
 for(const f of files)queue(path.resolve(f),`.ia/src/systems/${system}/probes/${path.basename(f)}`);
 const existingSystems=new Set(fs.readdirSync(systems).map(folded)),names=new Set();
 for(const folder of added){const src=path.resolve(folder),name=path.basename(src);noAlias(src);
  if(!fs.existsSync(path.join(src,'system.ia')))usage(`${folder} has no system.ia; --add-system takes a drafted system folder`);
  if(existingSystems.has(folded(name)))usage(`${name} already exists in the workspace; probe its new records with --system ${name} --file ...`);
  if(names.has(folded(name)))usage(`two --add-system folders are named ${name}; destinations collide`);names.add(folded(name));
  const visit=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);noAlias(f);if(e.isDirectory())visit(f);else queue(f,`.ia/src/systems/${name}/${path.relative(src,f).split(path.sep).join('/')}`);}};visit(src);
 }
 for(const s of all('--set'))if(s.indexOf('=')<1)usage(`--set ${s} must read NAME=value`);
 // One input read; those exact transformed bytes are copied and verified.
 additionBytes=0;
 for(const item of pending){const raw=fs.readFileSync(item.input);item.inputSha256=hash(raw);item.bytes=item.rel.endsWith('.ia')?Buffer.from(substitute(raw.toString('utf8'))):raw;additionBytes+=item.bytes.length;if(item.bytes.length>16*1024*1024||additionBytes>128*1024*1024)usage('transformed additions exceed byte limits');item.validatedSha256=hash(item.bytes);}
 if(requires.length&&!fs.readFileSync(path.join(systems,system,'system.ia'),'utf8').split(/\r?\n/).some(l=>l.trimEnd()==='  requires'))
  usage(`--requires extends the requires block of ${system}/system.ia, and it has none`);
 if(cli&&!isFile(cli))broken(`the IA CLI is not at ${cli} (--cli or IA_CLI_PATH)`);
 // Resolved from the real workspace, before copying: the copy leaves node_modules out.
 let ia;try{ia=resolveIa(root,cli)}catch(e){broken(e.message)}

 const scratch=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ia-probe-'));
 try{
  // .ia/work holds compiled artifacts and may be large or stale; the probe never needs it. Only <root>/.ia/work is left
  // out: path.relative compares whole paths (case-folded on Windows), so .ia/work-old or a root under ~/.ia/workspaces
  // is copied like anything else.
  copyWorkspace(root,scratch);
  const probes=[];   // {label, rel}: rel is the workspace-relative path findings and records carry
  if(system){
   const systemsCopy=path.join(scratch,'.ia','src','systems');
   const copy=path.resolve(systemsCopy,system);
   if(path.dirname(copy)!==systemsCopy)usage('--system must stay inside the scratch systems directory');
   if(requires.length){
    // Line-based so CRLF and LF checkouts both work; a system already required is not added twice.
    const sys=path.join(copy,'system.ia'),text=fs.readFileSync(sys,'utf8'),eol=text.includes('\r\n')?'\r\n':'\n',lines=text.split(/\r?\n/);
    const at=lines.findIndex(l=>l.trimEnd()==='  requires');
    let end=at+1;while(end<lines.length&&/^    - /.test(lines[end]))end++;
    const present=new Set(lines.slice(at+1,end).map(l=>l.replace(/^    - /,'').trim()));
    lines.splice(end,0,...requires.filter(r=>!present.has(r)).map(r=>`    - ${r}`));
    fs.writeFileSync(sys,lines.join(eol));
   }
   fs.mkdirSync(path.join(copy,'probes'),{recursive:true});
  }
  for(const item of pending){const dest=path.join(scratch,item.rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,item.bytes);if(item.rel.endsWith('.ia'))probes.push({label:item.input,rel:item.rel,inputSha256:item.inputSha256,validatedSha256:item.validatedSha256});}
  const verifyBytes=()=>{for(const item of pending)if(hash(fs.readFileSync(path.join(scratch,item.rel)))!==item.validatedSha256)broken(`scratch destination changed: ${item.rel}`);};
  verifyBytes();
  // A refusal exits 1 with the findings on stdout; empty stdout means the CLI itself failed.
  const run=argv=>{try{return invokeIa(ia,argv,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']})}catch(e){if(e.status===1&&!e.signal&&!e.code&&e.stdout)return e.stdout;broken(`ia ${argv[0]} failed: ${reason(e.stderr)||reason(e.message)||'no output'}`)}};
  const raw=run(['validate','--root',scratch,'--max-findings','100000','--json']);let v;
  try{v=JSON.parse(raw)}catch{broken(`ia validate printed no JSON: ${clip(raw)}`)}
  if(v?.truncated)broken('ia validate diagnostics were truncated');
  if(!Array.isArray(v?.findings))broken(`ia validate printed no findings: ${clip(raw)}`);
  if((v.counts?.errors??0)>v.findings.filter(x=>x.severity==='error').length||(v.counts?.warnings??0)>v.findings.filter(x=>x.severity==='warning').length)broken('ia validate diagnostics were incomplete');
  const ofProbe=p=>probes.find(x=>(p||'').replace(/\\/g,'/')===x.rel);
  let capture;
  const captured=()=>{if(!capture){run(['capture','--root',scratch,'--json']);capture=readArtifact(path.join(scratch,'.ia/work/snapshot/current.json'));if(capture.truncated)broken('ia capture diagnostics were truncated');}return capture;};
  // --lint: IA field-checks every section except governance, whose keys are compiler-consumed clauses admitted under any
  // name; so compare each probe record's governance keys with its schema's governance fields plus the known carriers.
  const GOVERNANCE_CARRIERS=['applies','requires','severity'],undeclared=[];
  if(lint){
   const artifact=captured();
   const records=artifact.records||[],declared=new Map();
   for(const s of records.filter(r=>r.discriminator==='schema')){const gov=new Set();
    for(const f of s.sections?.find(x=>x.name==='fields')?.fields||[]){const m=/^governance\.([\w-]+)\s+as\b/.exec(f.value?.text||'')||/^(?:must|may) have governance\.([\w-]+)\s+as\b/.exec(f.key||'');if(m)gov.add(m[1]);}
    declared.set(s.name,gov);}
   for(const r of records){const pr=ofProbe(r.source?.path);if(!pr||!declared.has(r.discriminator))continue;
    const sec=r.sections?.find(s=>s.name==='governance');if(!sec)continue;
    const known=new Set([...declared.get(r.discriminator),...GOVERNANCE_CARRIERS]);
    for(const f of sec.fields||[])if(f.key&&!known.has(f.key))undeclared.push({rel:pr.rel,line:f.span?.line??r.source.line,record:`@${r.discriminator} ${r.name}`,key:`governance.${f.key}`,known:[...known]});}
  }
  // R3 on IA 3.x: `ia validate` admits a @check whose check.runs names an evaluator that is not built in and binds it
  // (unavailable without a host catalog), while every strict reader (ia capture, ia host, ia project, ia restore) refuses
  // it with IA-COMP-CHECK-UNKNOWN. So a probe file's check that validate bound to such a runner is refused here too.
  const BUILT_IN=new Set(['COMP-PARSE','COMP-SCHEMA','COMP-SYSTEM','COMP-SCHEMA-ENROLLED','COMP-CONSENT-DECLARED','COMP-CONSENT','COMP-IDENTITY','COMP-SELECTOR','COMP-VARIANT','COMP-COVERAGE','COMP-FRAGMENT','COMP-ADOPTION','COMP-KERNEL','COMP-FIXTURES','COMP-STEWARD','COMP-BOOTSTRAP','COMP-CHECK']);
  const strict=[];
  // Native capture parses the full header grammar (including comments and
  // mixed-case names) and resolves strict runners. Source regexes must not
  // decide which parsed checks count. Capture only when validate bound a
  // non-built-in runner, and reuse the capture already made for --lint.
  if((Array.isArray(v.checks?.results)?v.checks.results:[]).some(c=>c.runner&&!BUILT_IN.has(c.runner)))
   for(const d of captured().diagnostics??[]){
    const pr=ofProbe(d.path);
    if(pr&&d.code==='IA-COMP-CHECK-UNKNOWN'&&!v.findings.some(x=>x.code===d.code&&ofProbe(x.path)===pr&&x.line===d.line))strict.push({...d,pr});
   }
  verifyBytes();
  const verdicts=probes.map(pr=>{const errs=[...v.findings.filter(x=>x.severity==='error'&&ofProbe(x.path)===pr),...strict.filter(x=>x.pr===pr)],warns=v.findings.filter(x=>x.severity!=='error'&&ofProbe(x.path)===pr),bad=undeclared.filter(u=>u.rel===pr.rel);
   return {file:pr.label,path:pr.rel,inputPath:pr.label,inputSha256:pr.inputSha256,substitutionsDigest,destinationPath:pr.rel,validatedSha256:pr.validatedSha256,native:{version:ia.version,argv:ia.argv},findings:[...errs,...warns].map(({code,line,message,severity})=>({code,line,message,severity})),admitted:!errs.length&&!bad.length,errors:errs.map(x=>({code:x.code,line:x.line,message:x.message.replace(/^[^ ]+\.ia:\d+: /,'')})),warnings:warns.map(x=>({code:x.code,line:x.line,message:x.message.replace(/^[^ ]+\.ia:\d+: /,'')})),undeclaredGovernance:bad.map(({line,record,key,known})=>({line,record,key,known}))}});
  const others=v.findings.filter(x=>x.severity==='error'&&!ofProbe(x.path));
  const refused=verdicts.some(x=>!x.admitted)||others.length>0;
  if(asJson)console.log(JSON.stringify({status:refused?'refused':'admitted',lint,files:verdicts,otherErrors:others.map(x=>({code:x.code,path:x.path,line:x.line,message:x.message}))},null,2));
  else{
   const errors=(v.counts?.errors??v.findings.filter(x=>x.severity==='error').length)+strict.length,warnings=v.counts?.warnings??v.findings.filter(x=>x.severity!=='error').length;
   console.log(`${refused?'refused':'admitted'}  errors ${errors}  warnings ${warnings}${undeclared.length?`  unchecked governance keys ${undeclared.length}`:''}${v.truncated?'  (findings truncated)':''}`);
   for(const x of verdicts){for(const e of x.errors)console.log(`error   ${e.code}  ${path.basename(x.path)}:${e.line}\n        ${e.message}`);for(const w of x.warnings)console.log(`warning ${w.code}  ${path.basename(x.path)}:${w.line}\n        ${w.message}`);
    for(const u of x.undeclaredGovernance)console.log(`lint    GOVERNANCE-KEY  ${path.basename(x.path)}:${u.line}\n        ${u.record} has ${u.key}, which IA admits but will not use (known here: ${u.known.join(', ')})`);}
   for(const e of others)console.log(`error   ${e.code}  ${e.path}:${e.line}  (not a probe file: the probe broke something else, or the workspace already had errors)\n        ${e.message.replace(/^[^ ]+\.ia:\d+: /,'')}`);
   if(!refused&&!verdicts.some(x=>x.warnings.length))console.log(`no errors, and no warnings from the probe files${lint?'; no unchecked governance keys':''}`);
  }
  process.exitCode=refused?1:0;
 }finally{if(keep)console.error(`scratch workspace kept at ${scratch}`);else fs.rmSync(scratch,{recursive:true,force:true});}
}

try{probe()}catch(e){
 const exit=e instanceof Stop?e.exit:3,message=e instanceof Stop?e.message:clip(e?.message??e);
 if(asJson)console.log(JSON.stringify({status:'error',error:message},null,2));
 console.error(exit===2?`${message}\n${USAGE}`:`could not probe: ${message}`);
 process.exitCode=exit;
}

