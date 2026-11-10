// Tests for the scripts of the inventarch/ia-authoring-kit's record-authoring part, run from the kit's bundled copy
// (config/kits/ia-authoring): the governance lint (scripts/field-lint.mjs) and the toolchain probe (scripts/probe.mjs).
// Node 18+ standard library only. The lint is fed small synthetic corpora in the ia.compiled.v1 shape the helper reads
// (records[] with discriminator, name, source.path, sections[{name,fields}]). The probe and the scripts' CLI resolution
// run against a small stand-in CLI (FAKE_IA below), with npx disabled (IA_CLI_NO_NPX), so nothing reaches the network.
// With IA_CORE_TEST_CLI=<path to @inventarch/cli dist/main.js> the probe also runs against the real CLI (native header
// grammar, collisions and exact mappings, the refused and admitted examples). Run from the repository root:
//   node --test plugins/ia/tests/kit-authoring-scripts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PINNED} from '../scripts/lib/cli.mjs';

const KIT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','config','kits','ia-authoring');
const bundled=file=>path.join(KIT,'scripts',file);
const FIELD_LINT=bundled('field-lint.mjs');
const PROBE=bundled('probe.mjs');
const PROBE_EXAMPLES=path.join(KIT,'assets','probe-examples');

const {lintGovernance,GOVERNANCE_CARRIERS}=await import(pathToFileURL(FIELD_LINT).href);

const run=(file,args=[],opts={})=>spawnSync(process.execPath,[file,...args],{encoding:'utf8',maxBuffer:256*1024*1024,...opts});
function withTmp(fn){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ia-authoring-test-'));try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true})}}
const write=(file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body)};
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Compiled-corpus builders, mirroring the value kinds of a real artifact: string, scalar, list.
// ---------------------------------------------------------------------------------------------------------------
const str=text=>({kind:'string',text});
const sc=text=>({kind:'scalar',text});
const list=(...items)=>({kind:'list',items});
const scs=(...texts)=>list(...texts.map(sc));
const section=(name,fields)=>({name,fields:(Array.isArray(fields)?fields:Object.entries(fields)).map(([key,value])=>({key,value}))});
const meaning=(says,answers=`What does this mean: ${says}`)=>section('meaning',{says:str(says),answers:str(answers)});
const LOCAL='.ia/src/systems/';
const INSTALLED='.ia/distributions/store/0000aaaa/.ia/src/systems/';
const SHOP=`${LOCAL}acme-shop-system/`;
function record(discriminator,name,file,{sections=[]}={}){
 return {discriminator,name,provenance:file.startsWith(LOCAL)?'workspace':'methodology',source:{path:file,line:3,endLine:12},head:[],sections,edges:[],requirements:[],
  variants:sections.filter(s=>s.name==='governance').flatMap(s=>s.fields.map(f=>({key:f.key,value:f.value})))};
}

// ---------------------------------------------------------------------------------------------------------------
// field-lint.mjs: governance keys IA admits under any name.
// ---------------------------------------------------------------------------------------------------------------
const LINT_SCHEMAS=[
 record('schema','agent',INSTALLED+'agent-system/schemas/agent.schema.ia',{sections:[section('fields',[['must have',sc('meaning.says as text')],['must have',sc('meaning.answers as text')],['must have',sc('governance.applies as list of id')]])]}),
 record('schema','mandate',INSTALLED+'agent-system/schemas/mandate.schema.ia',{sections:[section('fields',[['must have',sc('meaning.says as text')],['must have',sc('meaning.answers as text')],['may have',sc('execution.contract as id')]])]}),
 record('schema','law',INSTALLED+'governance-system/schemas/law.schema.ia',{sections:[section('fields',[['must have',sc('governance.severity as id')],['may have governance.level as id in',scs('team','org')]])]}),
];
const governed=(kind,name,keys,{file=`${SHOP}records/governance.ia`,extra=[]}={})=>{
 const r=record(kind,name,file,{sections:[meaning(`The ${name} record.`),section('governance',keys.map(k=>[k,list()])),...extra]});
 r.sections[1].fields.forEach((f,i)=>{f.span={line:10+i,endLine:10+i}});
 return r;
};

test('field-lint: a misspelled governance clause on an agent is reported with a suggestion', ()=>{
 const findings=lintGovernance([...LINT_SCHEMAS,governed('agent','acme-shop-steward',['applies','aplies'])]);
 assert.equal(findings.length,1);
 assert.deepEqual(findings[0],{record:'@agent acme-shop-steward',field:'governance.aplies',at:`${SHOP}records/governance.ia:11`,known:['applies','requires','severity'],suggestion:'applies'});
 assert.equal(lintGovernance([...LINT_SCHEMAS,governed('agent','a',['require'])])[0].suggestion,'requires');
 assert.equal(lintGovernance([...LINT_SCHEMAS,governed('law','l',['severty'])])[0].suggestion,'severity');
});

test('field-lint: compiler-consumed clauses (requires, severity) and schema-declared keys are not reported', ()=>{
 assert.deepEqual(GOVERNANCE_CARRIERS,['applies','requires','severity']);
 assert.deepEqual(lintGovernance([...LINT_SCHEMAS,governed('agent','a',['applies','requires','severity'])]),[]);
 // An enum field is declared in the key ("may have governance.level as id in") with the list as its value.
 assert.deepEqual(lintGovernance([...LINT_SCHEMAS,governed('law','l',['severity','level'])]),[]);
});

test('field-lint: sections other than governance are ignored', ()=>{
 const r=governed('agent','a',['applies'],{extra:[section('execution',{sayz:str('x'),'mystery-field':str('y')})]});
 r.sections[0].fields.push({key:'sayz',value:str('typo in meaning')});
 assert.deepEqual(lintGovernance([...LINT_SCHEMAS,r]),[]);
});

test('field-lint: a mandate whose schema declares no governance fields still has unknown governance keys reported', ()=>{
 const findings=lintGovernance([...LINT_SCHEMAS,governed('mandate','shop-stewardship',['applies','scope','aplies'])]);
 assert.deepEqual(findings.map(f=>[f.field,f.suggestion]),[['governance.scope',null],['governance.aplies','applies']]);
 for(const f of findings)assert.deepEqual(f.known,GOVERNANCE_CARRIERS);
});

test('field-lint: only local records whose word has a schema in the corpus are linted', ()=>{
 const installed=governed('agent','public-steward',['aplies'],{file:INSTALLED+'agent-system/system.ia'});
 const unschemed=governed('widget','w',['aplies']);
 assert.deepEqual(lintGovernance([...LINT_SCHEMAS,installed,unschemed]),[]);
 assert.equal(lintGovernance([...LINT_SCHEMAS,installed],{local:()=>true}).length,1);
});

test('field-lint: the CLI reads --artifact, prints JSON and exits 1 on findings', ()=>withTmp(dir=>{
 const bad=path.join(dir,'bad.json'),good=path.join(dir,'good.json');
 write(bad,JSON.stringify({artifact:'ia.compiled.v1',formatVersion:1,records:[...LINT_SCHEMAS,governed('agent','a',['aplies'])]}));
 write(good,JSON.stringify({artifact:'ia.compiled.v1',formatVersion:1,records:[...LINT_SCHEMAS,governed('agent','a',['applies'])]}));
 let p=run(FIELD_LINT,['--artifact',bad,'--json']);
 assert.equal(p.status,1,p.stderr);
 assert.deepEqual(JSON.parse(p.stdout).map(f=>f.field),['governance.aplies']);
 p=run(FIELD_LINT,['--artifact',bad]);
 assert.match(p.stdout,/governance lint: 1 governance key\(s\) IA admitted but will not use:/);
 assert.match(p.stdout,/\(did you mean governance\.applies\?\)/);
 p=run(FIELD_LINT,['--artifact',good]);
 assert.equal(p.status,0,p.stderr);
 assert.match(p.stdout,/every governance key of every local record is declared or a known clause/);
}));

test('field-lint includes authored workspace-root participants',()=>{
 const participant=governed('agent','workspace-participant',['aplies']);
 participant.source.path='.ia/src/participant.ia';
 const findings=lintGovernance([...LINT_SCHEMAS,participant]);
 assert.equal(findings.length,1);
 assert.equal(findings[0].field,'governance.aplies');
});


// ---------------------------------------------------------------------------------------------------------------
// probe.mjs
// ---------------------------------------------------------------------------------------------------------------
test('probe: argument errors exit 2 before anything is copied', ()=>withTmp(dir=>{
 let p=run(PROBE,[],{cwd:dir});
 assert.equal(p.status,2);
 assert.match(p.stderr,/nothing to probe: give --file \(with --system\) or --add-system/);
 assert.match(p.stderr,/usage: node probe\.mjs/);
 p=run(PROBE,['--root',dir,'--file',path.join(PROBE_EXAMPLES,'refused.ia')]);
 assert.equal(p.status,2);
 assert.match(p.stderr,/--file needs --system <existing system>/);
 p=run(PROBE,['--root',dir,'--system','ghost-system','--file',path.join(PROBE_EXAMPLES,'refused.ia')]);
 assert.equal(p.status,2);
 assert.match(p.stderr,/no system\.ia for ghost-system under /);
 assert.equal(p.stdout,'');
}));

// A stand-in for the IA CLI, so the probe's plumbing runs without one: validate refuses every .ia file holding
// REFUSE-ME, capture writes an empty snapshot, and FAKE_IA_LOG records each call's argv, the .ia tree it was given and
// FAKE_IA_TAG (which stand-in ran).
const FAKE_IA=`import fs from 'node:fs';import path from 'node:path';
const argv=process.argv.slice(2),at=k=>argv[argv.indexOf(k)+1],root=at('--root');
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[];
const files=walk(path.join(root,'.ia')).map(f=>path.relative(root,f).split(path.sep).join('/'));
const texts=Object.fromEntries(files.filter(f=>f.endsWith('.ia')).map(f=>[f,fs.readFileSync(path.join(root,f),'utf8')]));
if(process.env.FAKE_IA_LOG)fs.appendFileSync(process.env.FAKE_IA_LOG,JSON.stringify({argv,files,texts,tag:process.env.FAKE_IA_TAG||'fake'})+'\\n');
const mode=process.env.FAKE_IA_MODE||'';
if(mode==='garbage'){console.log('this is not json');process.exit(1)}
if(mode==='nofindings'){console.log(JSON.stringify({error:'no workspace at that root'}));process.exit(1)}
if(argv[0]==='validate'){const findings=Object.keys(texts).filter(f=>texts[f].includes('REFUSE-ME')).map(f=>({severity:'error',code:'IA-FAKE-REFUSED',path:f,line:1,message:f+':1: refused by the fake'}));
 // As IA 3.x validate does, every @check is bound and listed under checks, a runner that is not built in as unavailable.
 const checks=[];for(const t of Object.values(texts)){let name;for(const l of t.split('\\n')){const h=/^@check (\\S+)/.exec(l);if(h)name=h[1];else if(/^@/.test(l))name=undefined;const r=/^    runs (\\S+)/.exec(l);if(name&&r)checks.push({identity:'compliance-system/check/gate/'+name,name,runner:r[1],status:r[1].startsWith('COMP-')?'bound':'unavailable',outcome:'not-evaluated'})}}
 console.log(JSON.stringify({counts:{errors:findings.length,warnings:0},findings,truncated:false,checks:{results:checks}}));process.exitCode=findings.length?1:0}
else if(argv[0]==='capture'){
 const diagnostics=[];
 for(const [file,text] of Object.entries(texts)){let name,line;for(const [i,l] of text.split('\\n').entries()){
  const h=/^@check (\\S+)/.exec(l);if(h){name=h[1];line=i+1}else if(/^@/.test(l))name=undefined;
  const r=/^    runs (\\S+)/.exec(l);if(name&&r&&!r[1].startsWith('COMP-'))diagnostics.push({severity:'error',code:'IA-COMP-CHECK-UNKNOWN',path:file,line,message:file+':'+line+': Unknown check evaluator '+r[1]});
 }}
 const out=path.join(root,'.ia','work','snapshot','current.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({format:'ia-snapshot-1',revision:'fake',records:[],diagnostics,counts:{errors:diagnostics.length}}));console.log('{}')}
`;
const A_SYSTEM='#! ia 1.0\n\n@system acme-a-system\n  provider "local"\n  requires\n    - floor\n';
function probeWorkspace(root){
 write(path.join(root,'.ia','src','systems','acme-a-system','system.ia'),A_SYSTEM);
 write(path.join(root,'.ia','src','systems','acme-b-system','system.ia'),'#! ia 1.0\n\n@system acme-b-system\n  provider "local"\n');
}
// A fake @inventarch/cli package: package.json with the version given and a bin entry that runs FAKE_IA, as npm installs
// it under <dir>/node_modules/@inventarch/cli (a path with a space in the entry name, on purpose).
function fakeCliPackage(dir,version='3.1.1'){
 const pkg=path.join(dir,'node_modules','@inventarch','cli');
 write(path.join(pkg,'package.json'),JSON.stringify({name:'@inventarch/cli',version,bin:{ia:'dist/fake main.js'}}));
 write(path.join(pkg,'dist','fake main.js'),FAKE_IA);
 return pkg;
}
// The probe's environment: its own temp folder, no IA_CLI_PATH unless given, npx disabled so nothing reaches the
// network, and any other overrides (PATH matched case-insensitively, as Windows spells it Path).
function probeEnv(tmp,overrides={}){
 const drop=new Set(['IA_CLI_PATH','IA_CLI_VERSION','IA_CLI_NO_NPX','TMP','TEMP','TMPDIR',...Object.keys(overrides).map(k=>k.toUpperCase())]),env={};
 for(const [k,v] of Object.entries(process.env))if(!drop.has(k.toUpperCase()))env[k]=v;
 return {...env,TMP:tmp,TEMP:tmp,TMPDIR:tmp,IA_CLI_NO_NPX:'1',...overrides};
}
const scratchLeft=tmp=>fs.readdirSync(tmp).filter(n=>n.startsWith('ia-probe-'));

test('probe: every usage error exits 2 before the workspace is copied, and --json reports it', ()=>withTmp(dir=>{
 const ws=path.join(dir,'ws'),tmp=path.join(dir,'tmp'),probeFile=path.join(dir,'p.ia'),draft=(...p)=>path.join(dir,'drafts',...p);
 fs.mkdirSync(tmp);probeWorkspace(ws);write(probeFile,'# probe\n');
 write(draft('no-system','records','r.ia'),'# no system.ia here\n');
 write(draft('acme-a-system','system.ia'),'@system acme-a-system\n');
 for(const side of ['x','y'])write(draft(side,'acme-new-system','system.ia'),'@system acme-new-system\n');
 const cases=[
  [['--root',ws,'--add-system',draft('no-system')],/no-system has no system\.ia; --add-system takes a drafted system folder/],
  [['--root',ws,'--add-system',draft('acme-a-system')],/acme-a-system already exists in the workspace; probe its new records with --system acme-a-system --file/],
  [['--root',ws,'--add-system',draft('x','acme-new-system'),'--add-system',draft('y','acme-new-system')],/two --add-system folders are named acme-new-system/],
  [['--root',ws,'--system','acme-b-system','--file',probeFile,'--requires','agent-system'],/--requires extends the requires block of acme-b-system\/system\.ia, and it has none/],
  [['--root',ws,'--add-system',draft('x','acme-new-system'),'--requires','agent-system'],/--requires extends the requires block of --system <existing system>/],
  [['--root',ws,'--system','acme-a-system','--file',path.join(dir,'missing.ia')],/--file .*missing\.ia is not a file/],
  [['--root',ws,'--system','acme-a-system','--file',probeFile,'--set','NOEQUALS'],/--set NOEQUALS must read NAME=value/],
  [['--root',path.join(dir,'not-a-workspace'),'--add-system',draft('x','acme-new-system')],/no \.ia folder under .*not-a-workspace; --root takes an IA workspace/],
 ];
 for(const [argv,message] of cases){
  let p=run(PROBE,argv,{env:probeEnv(tmp),cwd:dir});
  assert.equal(p.status,2,`${argv.join(' ')}\n${p.stdout}${p.stderr}`);
  assert.match(p.stderr,message);
  assert.match(p.stderr,/usage: node probe\.mjs/);
  assert.equal(p.stdout,'');
  p=run(PROBE,[...argv,'--json'],{env:probeEnv(tmp),cwd:dir});
  assert.equal(p.status,2);
  const out=JSON.parse(p.stdout);
  assert.deepEqual(Object.keys(out),['status','error']);
  assert.equal(out.status,'error');
  assert.match(out.error,message);
 }
 assert.deepEqual(scratchLeft(tmp),[],'no usage error may leave a scratch copy behind');
}));

test('probe: a missing, crashing or silent CLI exits 3, never 1, and leaves no scratch copy', ()=>withTmp(dir=>{
 const ws=path.join(dir,'ws'),tmp=path.join(dir,'tmp'),fake=path.join(dir,'fake-ia.mjs'),crash=path.join(dir,'crash.mjs'),probeFile=path.join(dir,'p.ia');
 fs.mkdirSync(tmp);probeWorkspace(ws);write(fake,FAKE_IA);write(probeFile,'# probe\n');
 write(crash,"console.error('Error: the CLI fell over');process.exit(7);\n");
 const base=['--root',ws,'--system','acme-a-system','--file',probeFile,'--json'],missing=path.join(dir,'nope','main.js');
 const error=p=>{assert.equal(p.status,3,p.stdout+p.stderr);assert.match(p.stderr,/^could not probe: /m);const out=JSON.parse(p.stdout);assert.deepEqual(Object.keys(out),['status','error']);assert.equal(out.status,'error');return out.error};
 // A CLI path that names nothing, by --cli or IA_CLI_PATH, is refused before anything is copied.
 assert.equal(error(run(PROBE,[...base,'--cli',missing],{env:probeEnv(tmp),cwd:dir})),`the IA CLI is not at ${missing} (--cli or IA_CLI_PATH)`);
 assert.equal(error(run(PROBE,base,{env:probeEnv(tmp,{IA_CLI_PATH:missing}),cwd:dir})),`the IA CLI is not at ${missing} (--cli or IA_CLI_PATH)`);
 // Output that is not JSON, JSON without findings, and a crash with nothing on stdout.
 assert.equal(error(run(PROBE,[...base,'--cli',fake],{env:probeEnv(tmp,{FAKE_IA_MODE:'garbage'}),cwd:dir})),'ia validate printed no JSON: this is not json');
 assert.equal(error(run(PROBE,[...base,'--cli',fake],{env:probeEnv(tmp,{FAKE_IA_MODE:'nofindings'}),cwd:dir})),'ia validate printed no findings: {"error":"no workspace at that root"}');
 assert.equal(error(run(PROBE,[...base,'--cli',crash],{env:probeEnv(tmp),cwd:dir})),'ia validate failed: Error: the CLI fell over');
 // No --cli, no IA_CLI_PATH, no workspace install and npx disabled: nothing resolves, and the refusal says what to do.
 const none=error(run(PROBE,base,{env:probeEnv(tmp),cwd:dir}));
 assert.match(none,/^no IA CLI resolved for .*ws \(npx disabled by IA_CLI_NO_NPX\): install @inventarch\/cli exactly in the workspace/);
 assert.match(none,/npm install --save-dev --save-exact @inventarch\/cli@3.6.0/);
 assert.match(none,/the `ia` on the PATH is never used$/);
 // The text form says the same on stderr, after the line naming the CLI that ran, and prints nothing on stdout.
 const p=run(PROBE,base.filter(a=>a!=='--json').concat('--cli',crash),{env:probeEnv(tmp),cwd:dir});
 assert.equal(p.status,3);
 assert.equal(p.stdout,'');
 assert.deepEqual(p.stderr.trim().split(/\r?\n/),[`ia unknown version from explicit entry ${crash}`,'could not probe: ia validate failed: Error: the CLI fell over']);
 assert.deepEqual(scratchLeft(tmp),[],'every failure must delete its scratch copy');
 // --keep keeps the copy even when the probe could not run, and says where on stderr, leaving stdout parseable.
 const kept=run(PROBE,[...base,'--cli',crash,'--keep'],{env:probeEnv(tmp),cwd:dir});
 assert.equal(error(kept),'ia validate failed: Error: the CLI fell over');
 const at=/scratch workspace kept at (.+)/.exec(kept.stderr)?.[1]?.trim();
 assert.ok(at&&fs.existsSync(path.join(at,'.ia','src','systems','acme-a-system','probes','p.ia')),kept.stderr);
}));

test('probe: copies all of .ia except <root>/.ia/work, even for a root under a folder named .ia/workspaces', ()=>withTmp(dir=>{
 const ws=path.join(dir,'home','.ia','workspaces','demo'),tmp=path.join(dir,'tmp'),fake=path.join(dir,'fake-ia.mjs'),log=path.join(dir,'calls.jsonl');
 fs.mkdirSync(tmp);probeWorkspace(ws);write(fake,FAKE_IA);
 write(path.join(ws,'.ia','work','stale.json'),'{}');
 write(path.join(ws,'.ia','work-old','notes.txt'),'kept');
 write(path.join(ws,'.ia','distributions','store','abc','.ia','work','nested.txt'),'kept');
 const good=path.join(dir,'good.ia'),bad=path.join(dir,'bad.ia');write(good,'# PLACEHOLDER\n');write(bad,'# REFUSE-ME\n');
 const probe=(file,extra=[])=>run(PROBE,['--root',ws,'--cli',fake,'--system','acme-a-system','--file',file,'--json',...extra],{env:probeEnv(tmp,{FAKE_IA_LOG:log}),cwd:dir});
 let p=probe(good,['--requires','agent-system,floor','--set','PLACEHOLDER=acme']);
 assert.equal(p.status,0,p.stdout+p.stderr);
 let v=JSON.parse(p.stdout);
 assert.equal(v.status,'admitted');
 assert.deepEqual(v.files.map(f=>[f.path,f.admitted]),[['.ia/src/systems/acme-a-system/probes/good.ia',true]]);
 const seen=JSON.parse(fs.readFileSync(log,'utf8').trim().split('\n')[0]);
 assert.deepEqual(seen.files.sort(),['.ia/distributions/store/abc/.ia/work/nested.txt','.ia/src/systems/acme-a-system/probes/good.ia','.ia/src/systems/acme-a-system/system.ia','.ia/src/systems/acme-b-system/system.ia','.ia/work-old/notes.txt']);
 // --requires adds only what is missing, and --set fills the placeholder; the real workspace is untouched.
 assert.equal(seen.texts['.ia/src/systems/acme-a-system/system.ia'],A_SYSTEM.replace('    - floor\n','    - floor\n    - agent-system\n'));
 assert.equal(seen.texts['.ia/src/systems/acme-a-system/probes/good.ia'],'# acme\n');
 assert.equal(fs.readFileSync(path.join(ws,'.ia','src','systems','acme-a-system','system.ia'),'utf8'),A_SYSTEM);
 assert.ok(fs.existsSync(path.join(ws,'.ia','work','stale.json')));
 assert.ok(!fs.existsSync(path.join(ws,'.ia','src','systems','acme-a-system','probes')));
 // A refusal is exit 1 with the verdict, in both forms.
 p=probe(bad);
 assert.equal(p.status,1,p.stdout+p.stderr);
 v=JSON.parse(p.stdout);
 assert.equal(v.status,'refused');
 assert.deepEqual(v.files[0].errors,[{code:'IA-FAKE-REFUSED',line:1,message:'refused by the fake'}]);
 p=run(PROBE,['--root',ws,'--cli',fake,'--system','acme-a-system','--file',bad],{env:probeEnv(tmp),cwd:dir});
 assert.equal(p.status,1);
 assert.match(p.stdout,/^refused  errors 1  warnings 0/);
 assert.deepEqual(scratchLeft(tmp),[]);
}));

// IA 3.x validate admits a check on a runner that is not built in and binds it; the strict readers refuse it (R3).
test('probe: a probe file\'s check that validate binds to a runner that is not built in is refused as IA-COMP-CHECK-UNKNOWN', ()=>withTmp(dir=>{
 const ws=path.join(dir,'ws'),tmp=path.join(dir,'tmp'),fake=path.join(dir,'fake-ia.mjs');
 fs.mkdirSync(tmp);probeWorkspace(ws);write(fake,FAKE_IA);
 // A check in the workspace itself is not the probe's to judge.
 write(path.join(ws,'.ia','src','systems','acme-b-system','checks.ia'),'#! ia 1.0\n\n@check acme-old-gate\n  check\n    runs old-runner\n');
 const file=path.join(dir,'checks.ia');
 // A header with an inline comment and a mixed-case name parse natively too: the probe must take capture's diagnostics
 // as given, not re-filter them by the header's source text.
 write(file,'#! ia 1.0\n\n@check acme-built-in\n  check\n    runs COMP-COVERAGE\n\n@check acme-gate\n  check\n    runs acme-runner\n\n@check acme-noted # an inline note\n  check\n    runs acme-noted-runner\n\n@check Acme-Mixed\n  check\n    runs acme-mixed-runner\n');
 let p=run(PROBE,['--root',ws,'--cli',fake,'--system','acme-a-system','--file',file,'--json'],{env:probeEnv(tmp),cwd:dir});
 assert.equal(p.status,1,p.stdout+p.stderr);
 const v=JSON.parse(p.stdout);
 assert.equal(v.status,'refused');
 assert.deepEqual(v.otherErrors,[]);
 assert.deepEqual(v.files[0].errors,[{code:'IA-COMP-CHECK-UNKNOWN',line:7,message:'Unknown check evaluator acme-runner'},{code:'IA-COMP-CHECK-UNKNOWN',line:11,message:'Unknown check evaluator acme-noted-runner'},{code:'IA-COMP-CHECK-UNKNOWN',line:15,message:'Unknown check evaluator acme-mixed-runner'}]);
 p=run(PROBE,['--root',ws,'--cli',fake,'--system','acme-a-system','--file',file],{env:probeEnv(tmp),cwd:dir});
 assert.equal(p.status,1);
 assert.match(p.stdout,/^refused  errors 3  warnings 0\nerror   IA-COMP-CHECK-UNKNOWN  checks\.ia:7\n(?:.*\n)*?error   IA-COMP-CHECK-UNKNOWN  checks\.ia:11\n(?:.*\n)*?error   IA-COMP-CHECK-UNKNOWN  checks\.ia:15\n/);
 assert.deepEqual(scratchLeft(tmp),[]);
}));

test("probe and field-lint run the workspace's own @inventarch/cli, never an `ia` on the PATH", ()=>withTmp(dir=>{
 const ws=path.join(dir,'with space','ws'),tmp=path.join(dir,'temp space'),bin=path.join(dir,'bin space'),log=path.join(dir,'calls.jsonl'),trap=path.join(dir,'path-ia-ran.txt');
 fs.mkdirSync(tmp,{recursive:true});probeWorkspace(ws);
 // The workspace's install sits one level above the root, at the repository root (.git), as a hoisted node_modules
 // does: resolution walks up to the repository root and no further.
 fs.mkdirSync(path.join(path.dirname(ws),'.git'),{recursive:true});
 const pkg=fakeCliPackage(path.dirname(ws));
 // A launcher named ia (ia.cmd on Windows) on the PATH, which records that it ran. It must never run.
 const trapScript=path.join(bin,'trap.mjs');write(trapScript,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(trap)},'ran');process.exit(9);\n`);
 if(process.platform==='win32')write(path.join(bin,'ia.cmd'),`@"${process.execPath}" "${trapScript}" %*\r\n`);
 else{write(path.join(bin,'ia'),`#!/bin/sh\nexec "${process.execPath}" "${trapScript}" "$@"\n`);fs.chmodSync(path.join(bin,'ia'),0o755)}
 const env=probeEnv(tmp,{PATH:bin+path.delimiter+process.env.PATH,FAKE_IA_LOG:log}),probeFile=path.join(dir,'with space','probe.ia');
 write(probeFile,'# probe\n');
 const resolved=`ia 3.1.1 from workspace install ${pkg}`;
 let p=run(PROBE,['--root',ws,'--system','acme-a-system','--file',probeFile,'--json'],{env,cwd:dir});
 assert.equal(p.status,0,p.stdout+p.stderr);
 assert.equal(JSON.parse(p.stdout).status,'admitted');
 assert.equal(p.stderr.trim(),resolved);
 p=run(FIELD_LINT,['--root',ws],{env,cwd:dir});
 assert.equal(p.status,0,p.stderr);
 assert.match(p.stdout,/every governance key of every local record is declared or a known clause/);
 assert.equal(p.stderr.trim(),resolved);
 // Each call reached the workspace's CLI with its scratch root as one argument, spaces and all; the PATH ia never ran.
 assert.equal(fs.existsSync(trap),false,'the `ia` on the PATH must never run');
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual(calls.map(c=>c.argv.slice(0,2)),[['validate','--root'],['capture','--root']]);
 for(const c of calls){assert.notEqual(c.argv[2],ws);assert.equal(path.dirname(c.argv[2]),tmp)}
 // Each script captured a scratch copy and removed it.
 assert.equal(fs.existsSync(path.join(ws,'.ia','work')),false,'read-only checks never create live work artifacts');
 assert.deepEqual(scratchLeft(tmp),[]);
 assert.deepEqual(fs.readdirSync(tmp).filter(n=>n.startsWith('ia-plugin-artifact-')),[]);
}));

test('an explicit entry or IA_CLI_PATH wins over the workspace install, and a CLI below 3.x is refused', ()=>withTmp(dir=>{
 const ws=path.join(dir,'a','ws'),tmp=path.join(dir,'tmp'),log=path.join(dir,'calls.jsonl');
 fs.mkdirSync(tmp);probeWorkspace(ws);fs.mkdirSync(path.join(dir,'a','.git'));fakeCliPackage(path.join(dir,'a'));
 const other=fakeCliPackage(path.join(dir,'elsewhere'),'3.2.0'),entry=path.join(other,'dist','fake main.js');
 const tags=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l).tag);
 // --cli names the entry; its version comes from the package.json above it.
 let p=run(FIELD_LINT,['--root',ws,'--cli',entry,'--json'],{env:probeEnv(tmp,{FAKE_IA_LOG:log,FAKE_IA_TAG:'explicit'}),cwd:dir});
 assert.equal(p.status,0,p.stderr);
 assert.equal(p.stderr.trim(),`ia 3.2.0 from explicit entry ${entry}`);
 p=run(FIELD_LINT,['--root',ws,'--json'],{env:probeEnv(tmp,{FAKE_IA_LOG:log,FAKE_IA_TAG:'env',IA_CLI_PATH:entry}),cwd:dir});
 assert.equal(p.status,0,p.stderr);
 assert.equal(p.stderr.trim(),`ia 3.2.0 from IA_CLI_PATH ${entry}`);
 assert.deepEqual(tags(),['explicit','env']);
 // A workspace install of 2.x is refused before anything runs, by the probe (exit 3) and by the lint (exit 2).
 const old=path.join(dir,'old'),oldWs=path.join(old,'ws');probeWorkspace(oldWs);fs.mkdirSync(path.join(old,'.git'));const oldPkg=fakeCliPackage(old,'2.0.0');
 const probeFile=path.join(dir,'p.ia');write(probeFile,'# probe\n');
 p=run(PROBE,['--root',oldWs,'--system','acme-a-system','--file',probeFile,'--json'],{env:probeEnv(tmp,{FAKE_IA_LOG:log}),cwd:dir});
 assert.equal(p.status,3,p.stdout+p.stderr);
 assert.match(JSON.parse(p.stdout).error,new RegExp(`^IA 2\\.x is not supported; workspace install ${oldPkg.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')} is @inventarch/cli 2\\.0\\.0\\. Use @inventarch/cli ${PINNED.replaceAll('.','\\.')}`));
 p=run(FIELD_LINT,['--root',oldWs,'--json'],{env:probeEnv(tmp,{FAKE_IA_LOG:log}),cwd:dir});
 assert.equal(p.status,2,`a refusal is exit 2, never 1 (findings)\n${p.stderr}`);
 assert.equal(p.stdout,'');
 assert.match(p.stderr,/^IA 2\.x is not supported; workspace install /);
 // So is an explicit 2.x entry.
 p=run(FIELD_LINT,['--root',oldWs,'--cli',path.join(oldPkg,'dist','fake main.js'),'--json'],{env:probeEnv(tmp,{FAKE_IA_LOG:log}),cwd:dir});
 assert.match(p.stderr,/IA 2\.x is not supported; explicit entry /);
 assert.deepEqual(tags(),['explicit','env'],'no 2.x CLI ran');
 assert.deepEqual(scratchLeft(tmp),[]);
}));

// The kit carries one probe, one lint and one helper of its own: this holds every script to it and to the kit folder.
const KIT_HELPER=path.join(KIT,'scripts','lib','scratch.mjs');
test("one resolver and one probe: every script that captures imports the kit's own scripts/lib/scratch.mjs", async ()=>{
 const files=[];
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files.push(p);}};
 walk(KIT);
 const named=base=>files.filter(f=>path.basename(f)===base);
 assert.deepEqual(named('workspace-toolchain.mjs'),[],'the kit carries no resolver of its own');
 assert.deepEqual(named('ia.mjs'),[],"the core's scripts/ia.mjs is the launcher");
 assert.deepEqual(named('probe.mjs'),[PROBE]);
 assert.deepEqual(named('ia-rules.md'),[],'the rule sheet is the authoring-ia-rules-* conventions, not a carried body');
 // Static imports: each script that captures a workspace imports exactly the kit's own helper, and nothing else outside the kit.
 const importers=[];
 for(const f of files.filter(f=>f.endsWith('.mjs'))){
  const text=fs.readFileSync(f,'utf8');
  for(const m of text.matchAll(/from\s+'(\.[^']*)'/g)){
   const target=path.resolve(path.dirname(f),m[1]);
   if(target===KIT_HELPER){importers.push(path.relative(KIT,f).split(path.sep).join('/'));continue}
   assert.ok(!path.relative(KIT,target).startsWith('..'),`${path.relative(KIT,f)} imports ${m[1]} from outside the kit`);
  }
 }
 assert.deepEqual(importers.sort(),['scripts/field-lint.mjs','scripts/probe.mjs']);
 // And the helper exports what the scripts import.
 const helper=await import(pathToFileURL(KIT_HELPER).href);
 for(const name of ['copyWorkspace','invokeIa','resolveIa','scratchArtifact','readArtifact'])assert.equal(typeof helper[name],'function',name);
});

// Path selectors are refused before anything is written, inside or outside the workspace.
test('probe refuses path selectors before writing', t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'probe-containment-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'root'),victim=path.join(dir,'victim');
 fs.mkdirSync(path.join(root,'.ia/src/systems'),{recursive:true});
 fs.mkdirSync(victim);
 const original='@system victim\n  requires\n    - floor\n';
 fs.writeFileSync(path.join(victim,'system.ia'),original);
 const probe=path.join(dir,'probe.ia');
 fs.writeFileSync(probe,'@spec example\n');
 for(const selector of ['../../../../victim','..\\..\\..\\..\\victim','.','..',victim,'/victim','C:\\victim','victim/child']){
  const out=spawnSync(process.execPath,[PROBE,'--root',root,'--system',selector,'--file',probe,'--requires','injected-owner','--json'],{encoding:'utf8',timeout:10000,env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir}});
  assert.equal(out.status,2,`${selector}: ${out.stdout} ${out.stderr}`);
  assert.match(JSON.parse(out.stdout).error,/single system name/);
  assert.equal(fs.readFileSync(path.join(victim,'system.ia'),'utf8'),original);
  assert.equal(fs.existsSync(path.join(victim,'probes')),false);
  assert.equal(fs.readdirSync(dir).some(name=>name.startsWith('ia-probe-')),false);
 }
});

// ---------------------------------------------------------------------------------------------------------------
// The probe against the real CLI (opt-in: IA_CORE_TEST_CLI).
// ---------------------------------------------------------------------------------------------------------------
const CLI=process.env.IA_CORE_TEST_CLI;
const CLI_VERSION=CLI?JSON.parse(fs.readFileSync(path.join(path.dirname(CLI),'..','package.json'),'utf8')).version:null;
const realRun=args=>spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:64*1024*1024});
// A fresh ia init workspace with one local system that requires the given owners.
function initWorkspace(dir,requires){
 const root=path.join(dir,'ws');
 const init=realRun([CLI,'init',root,'--host','none','--apply','--yes','--json']);
 assert.equal(init.status,0,init.stdout+init.stderr);
 const system=path.join(root,'.ia/src/systems/probe-local');
 write(path.join(system,'system.ia'),`#! ia 1.0\n\n@system probe-local\n  provider "local"\n  version "0.1.0"\n  describes "A synthetic probe system."\n  steward @agent probe-local-steward\n  requires\n${requires.map(r=>`    - ${r}\n`).join('')}\n@agent probe-local-steward\n  meaning\n    says "Owns the synthetic probes."\n    answers "Who owns these probes?"\n  governance\n    applies []\n`);
 return {root,system};
}

test("real CLI: the kit's probe uses native header grammar for commented and mixed-case checks",{skip:!CLI&&'set IA_CORE_TEST_CLI'},()=>withTmp(dir=>{
 const {root,system}=initWorkspace(dir,['compliance-system','governance-system','agent-system']);
 for(const [header,runner,expected] of [
  ['@check probe-custom # inline comment','unavailable-probe-evaluator',1],
  ['@check Probe-Custom # inline comment','unavailable-probe-evaluator',1],
  ['@check probe-custom','unavailable-probe-evaluator',1],
  ['@check Probe-Builtin # inline comment','COMP-PARSE',0],
 ]){
  const file=path.join(dir,'probe.ia');
  fs.writeFileSync(file,`#! ia 1.0\n\n${header}\n  meaning\n    says "A synthetic evaluator check."\n    answers "Is this evaluator admitted?"\n  check\n    runs ${runner}\n    scope "probe"\n`);
  const result=realRun([PROBE,'--root',root,'--system','probe-local','--file',file,'--cli',CLI,'--json']);
  assert.equal(result.status,expected,header+'\n'+result.stdout+result.stderr);
  const verdict=JSON.parse(result.stdout);
  assert.equal(verdict.files[0].admitted,expected===0);
  if(expected)assert.ok(verdict.files[0].errors.some(e=>e.code==='IA-COMP-CHECK-UNKNOWN'&&e.line===3));
  assert.equal(fs.readFileSync(path.join(system,'system.ia'),'utf8').includes('@check'),false);
 }
}));

test('real CLI: probe collisions refuse and distinct mappings are exact',{skip:!CLI&&'set IA_CORE_TEST_CLI'},()=>withTmp(dir=>{
 const {root,system}=initWorkspace(dir,['agent-system']);
 const good='#! ia 1.0\n\n@agent NAME\n  meaning\n    says "A probe."\n    answers "Who probes?"\n  governance\n    applies []\n';
 const make=(name,bytes)=>{const file=path.join(dir,name);write(file,bytes);return file};
 const valid=make('good/draft.ia',good.replace('NAME','valid-probe'));
 const invalid=make('bad/draft.ia','#! ia 1.0\n\n@not-a-registered-discriminator invalid-probe\n');
 const invoke=(files,extra=[])=>realRun([PROBE,'--root',root,'--system','probe-local',...files.flatMap(f=>['--file',f]),'--cli',CLI,'--json',...extra]);
 for(const files of [[invalid,valid],[valid,invalid],[valid,valid],[valid,make('case/DRAFT.ia',good)]]){
  const result=invoke(files);assert.equal(result.status,2,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).status,'error');
 }
 const bad=invoke([invalid]);assert.equal(bad.status,1,bad.stdout+bad.stderr);
 assert.ok(JSON.parse(bad.stdout).files[0].errors.some(e=>e.code==='IA-LANG-DISCRIMINATOR-UNREGISTERED'));
 for(const extension of ['IA','txt']){
  const result=invoke([make(`invalid.${extension}`,fs.readFileSync(invalid))]);
  assert.equal(result.status,2,result.stdout+result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'error');
  assert.match(result.stdout,/lowercase \.ia extension/);
 }
 const second=make('second.ia',good);
 const success=invoke([valid,second],['--set','NAME=second-probe']);
 assert.equal(success.status,0,success.stdout+success.stderr);
 const receipt=JSON.parse(success.stdout);assert.equal(receipt.files.length,2);
 for(const file of receipt.files){assert.equal(file.admitted,true);assert.equal(file.inputSha256,sha256(fs.readFileSync(file.inputPath)));assert.equal(file.validatedSha256,sha256(fs.readFileSync(file.inputPath,'utf8').replaceAll('NAME','second-probe')));assert.equal(file.native.version,CLI_VERSION)}
 assert.notEqual(receipt.files[0].destinationPath,receipt.files[1].destinationPath);
 fs.mkdirSync(path.join(system,'probes'));fs.writeFileSync(path.join(system,'probes/draft.ia'),'existing');
 assert.equal(invoke([valid]).status,2);
}));

test('real CLI: refused.ia is refused for four reasons and admitted.ia is admitted',{skip:!CLI&&'set IA_CORE_TEST_CLI',timeout:600000},()=>withTmp(dir=>{
 // A domain system that requires compliance-system but not template-system; the contract governs the workspace ia init made.
 const {root}=initWorkspace(dir,['compliance-system','governance-system','agent-system']);
 const workspace=fs.readdirSync(path.join(root,'.ia/src')).filter(f=>f.endsWith('.ia')).map(f=>/^@workspace (\S+)$/m.exec(fs.readFileSync(path.join(root,'.ia/src',f),'utf8'))?.[1]).find(Boolean);
 assert.ok(workspace,'ia init authored a workspace');
 const common=['--root',root,'--cli',CLI,'--system','probe-local','--set','PROBE_TARGET_SYSTEM=probe-local','--set',`PROBE_BOUNDARY_WORKSPACE=${workspace}`,'--json'];
 let p=realRun([PROBE,...common,'--file',path.join(PROBE_EXAMPLES,'refused.ia')]);
 assert.equal(p.status,1,p.stdout+p.stderr);
 let v=JSON.parse(p.stdout);
 assert.equal(v.status,'refused');
 assert.deepEqual(v.otherErrors,[],'the workspace itself must validate cleanly');
 assert.equal(v.files.length,1);
 assert.deepEqual(v.files[0].errors.map(e=>e.code).sort(),['IA-COMP-CHECK-UNKNOWN','IA-COMP-COVERAGE-KIND','IA-COMP-DISCRIMINATOR-FOREIGN','IA-GRAPH-EDGE-UNCONSENTED']);
 p=realRun([PROBE,...common,'--requires','agent-composition-system','--file',path.join(PROBE_EXAMPLES,'admitted.ia')]);
 assert.equal(p.status,0,p.stdout+p.stderr);
 v=JSON.parse(p.stdout);
 assert.equal(v.status,'admitted');
 assert.deepEqual(v.otherErrors,[]);
 assert.equal(v.files[0].admitted,true);
 assert.deepEqual(v.files[0].errors,[]);
}));

test('probe: truncated diagnostics and changed scratch bytes never admit', ()=>withTmp(dir=>{
 const ws=path.join(dir,'ws'),tmp=path.join(dir,'tmp'),file=path.join(dir,'draft.ia');
 fs.mkdirSync(tmp);probeWorkspace(ws);write(file,'# probe\n');
 for(const mode of ['truncated','mutated','incomplete']){
  const entry=path.join(dir,mode+'.mjs');
  write(entry,`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);const root=args[args.indexOf('--root')+1];
${mode==='mutated'?"fs.appendFileSync(path.join(root,'.ia/src/systems/acme-a-system/probes/draft.ia'),'changed');":''}
console.log(JSON.stringify({findings:[],counts:{errors:${mode==='incomplete'?1:0}},truncated:${mode==='truncated'}}));`);
  const result=run(PROBE,['--root',ws,'--system','acme-a-system','--file',file,'--cli',entry,'--json'],{env:probeEnv(tmp)});
  assert.equal(result.status,3,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).status,'error');assert.deepEqual(scratchLeft(tmp),[]);
 }
}));

test('probe: portable NFC, case, added-system and link collisions refuse before scratch creation', ()=>withTmp(dir=>{
 const ws=path.join(dir,'ws'),tmp=path.join(dir,'tmp');fs.mkdirSync(tmp);probeWorkspace(ws);
 const file=(rel,body='# probe\n')=>{const f=path.join(dir,rel);write(f,body);return f;};
 const cases=[['--system','acme-a-system','--file',file('a/caf\u00e9.ia'),'--file',file('b/cafe\u0301.ia')],
 ['--add-system',path.dirname(file('a/NEW/system.ia')),'--add-system',path.dirname(file('b/new/system.ia'))],
 ['--add-system',path.dirname(file('c/ACME-A-SYSTEM/system.ia'))]];
 const target=path.join(dir,'target');fs.mkdirSync(target);file('target/link.ia');const alias=path.join(dir,'alias');fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');cases.push(['--system','acme-a-system','--file',path.join(alias,'link.ia')]);
 for(const args of cases){const result=run(PROBE,['--root',ws,...args,'--json'],{env:probeEnv(tmp)});assert.equal(result.status,2,result.stdout+result.stderr);assert.deepEqual(scratchLeft(tmp),[]);}
}));

test('probe: a link above the ancestor an input shares with the root is trusted, one below it still refuses', ()=>withTmp(dir=>{
 // The macOS /var -> /private/var case: workspace and inputs reached through a linked parent, as the person typed them.
 const real=path.join(dir,'real'),linked=path.join(dir,'linked'),tmp=path.join(dir,'tmp');fs.mkdirSync(tmp);probeWorkspace(path.join(real,'ws'));
 write(path.join(real,'drafts','probe.ia'),'# probe\n');const fake=path.join(dir,'fake-ia.mjs');write(fake,FAKE_IA);fs.symlinkSync(real,linked,process.platform==='win32'?'junction':'dir');
 const ws=path.join(linked,'ws'),probeFile=path.join(linked,'drafts','probe.ia');
 for(const [root,input] of [[ws,probeFile],[ws,path.join(real,'drafts','probe.ia')]]){const result=run(PROBE,['--root',root,'--system','acme-a-system','--file',input,'--cli',fake,'--json'],{env:probeEnv(tmp)});assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).status,'admitted');}
 const inner=path.join(real,'drafts','inner');fs.symlinkSync(path.join(real,'drafts'),inner,process.platform==='win32'?'junction':'dir');
 // Links below the shared ancestor: one inside the drafts, and the linked sibling itself when the root is given canonically.
 for(const [root,input] of [[ws,path.join(linked,'drafts','inner','probe.ia')],[path.join(real,'ws'),probeFile]]){const result=run(PROBE,['--root',root,'--system','acme-a-system','--file',input,'--json'],{env:probeEnv(tmp)});
  assert.equal(result.status,2,result.stdout+result.stderr);assert.match(result.stdout,/alias\/symlink input/);assert.deepEqual(scratchLeft(tmp),[]);}
}));
