import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createManagement } from '../scripts/management.mjs';
const dir = await mkdtemp(join(tmpdir(), 'preview-management-'));
const helper = join(dir, 'helper.mjs');
await writeFile(helper, `import {appendFile} from 'node:fs/promises';
const [command,id,json]=process.argv.slice(2);await appendFile(process.env.TAILNET_PREVIEW_STATE_DIR+'/calls.jsonl',JSON.stringify([command,id,json])+'\\n');
if(id==='fails'){console.error(JSON.stringify({message:'Fixture startup failed.'}));process.exit(1)}
if(id==='slow')await new Promise(r=>setTimeout(r,400));
console.log(JSON.stringify({ok:true}));`);
const projects = Object.fromEntries(['managed','slow','fails','attached'].map(id=>[id,{id,mode:id==='attached'?'attached':'supervised'}]));
const current={gateway:{httpsPort:443},projects};
const management=createManagement({stateDir:dir,helper,registry:async()=>current,dnsName:'preview.example.ts.net',localPort:0});
const server=createServer((req,res)=>management.handle(req,res,current));server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port;
const post=(body,headers={})=>new Promise((resolve,reject)=>{const req=request(url,{method:'POST',headers:{Host:'localhost',Origin:'http://localhost','Content-Type':'application/json','X-Preview-Token':management.token,...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(text)}))});req.on('error',reject);req.end(JSON.stringify(body))});
try {
 assert.equal(management.allowedHost('evil.example'),false);assert.equal(management.allowedHost('preview.example.ts.net:8443'),false);assert.equal(management.allowedHost('preview.example.ts.net'),true);
 for(const headers of [{'X-Preview-Token':''},{Origin:'https://preview.example.ts.net:8443'},{Origin:'null'},{Host:'attacker.example',Origin:'http://attacker.example'},{Origin:''}])assert.equal((await post({id:'managed',action:'stop'},headers)).status,403);
 assert.equal((await fetch(url)).status,405);
 assert.equal((await post({id:'managed',action:'stop'},{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post({id:'../managed',action:'stop'})).status,400);
 assert.equal((await post({id:'managed',action:'exec'})).status,400);
 assert.equal((await post({id:'missing',action:'stop'})).status,404);
 assert.equal((await post({id:'attached',action:'stop'})).status,409);
 assert.equal((await post({id:'attached',action:'start'})).status,409);
 assert.equal((await post({id:'managed',action:'disconnect'})).status,409);
 for(const [action,command] of [['start','resume'],['stop','sleep'],['restart','restart'],['remove','remove']]){assert.equal((await post({id:'managed',action})).status,200);const calls=(await readFile(join(dir,'calls.jsonl'),'utf8')).trim().split('\n');assert.deepEqual(JSON.parse(calls.at(-1)),[command,'managed','--json'])}
 assert.equal((await post({id:'attached',action:'disconnect'})).status,200);
 const failure=await post({id:'fails',action:'start'});assert.equal(failure.status,502);assert.equal((await failure.json()).error,'Fixture startup failed.');
 const slow=post({id:'slow',action:'restart'});await new Promise(r=>setTimeout(r,80));assert.equal((await post({id:'managed',action:'stop'})).status,409);assert.equal((await slow).status,200);
 assert.equal((await post({id:'managed',action:'stop'})).status,200);
 console.log('PASS: origin and host boundaries, CSRF tokens, methods, input validation, mode restrictions, fixed CLI arguments, failure recovery, and concurrent-action exclusion.');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
