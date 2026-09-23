import assert from 'node:assert/strict';
import{mkdtemp,writeFile,mkdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';import{createServer,request}from'node:http';import{spawn}from'node:child_process';import{once}from'node:events';
const state=await mkdtemp(join(tmpdir(),'tailnet-studio-test-'));
const upstream=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('upstream '+req.url)});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const project={id:'test-app',name:'Test <app> $&',mode:'supervised',state:'healthy',localPort:upstream.address().port,httpsPort:8443,primaryView:'home',views:{home:'/hello?test=1',other:'/other'},updatedAt:new Date().toISOString()};
const registry={version:3,gateway:{httpsPort:443,localPort:port},projects:{'test-app':project,'sleeping-app':{...project,id:'sleeping-app',httpsPort:8444,state:'sleeping'}}};
await writeFile(join(state,'registry.json'),JSON.stringify(registry));await mkdir(join(state,'thumbnails'));await writeFile(join(state,'thumbnails/test-app.json'),JSON.stringify({version:1,view:'home',route:'/hello?test=1',capturedAt:new Date().toISOString(),dataUrl:'data:image/png;base64,aGVsbG8='}));
const processChild=spawn(process.execPath,[new URL('../scripts/gateway-server.mjs',import.meta.url).pathname,'--port',String(port),'--state-dir',state],{stdio:['ignore','pipe','pipe']});
let stderr='';processChild.stderr.on('data',c=>stderr+=c);await Promise.race([once(processChild.stdout,'data'),once(processChild,'exit').then(()=>{throw new Error(stderr)})]);
const get=(path,host='localhost')=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,headers:{host}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({body,status:res.statusCode,headers:res.headers}))});req.on('error',reject);req.end()});
const configOf=body=>JSON.parse(body.match(/const config=(.*);/)[1]);
try{
 let result=await get('/');assert.equal(result.status,200);const dashboard=configOf(result.body);assert.match(dashboard.managementToken,/^[a-f0-9]{64}$/);assert.equal(dashboard.showAuthorCredit,true);assert.match(result.body,/<footer class="library-footer">/);for(const href of ['https://shepbryan.com','https://www.linkedin.com/in/shepbryan','https://github.com/elsheppo'])assert.ok(result.body.includes(`href="${href}"`));assert.equal(dashboard.projects.length,2);assert.equal(dashboard.projects[0].name,project.name);assert.equal(dashboard.projects[0].healthy,true);assert.equal(dashboard.projects[1].healthy,false);assert.ok(dashboard.projects[0].thumbnail);assert.ok(result.headers['content-security-policy'].includes("connect-src 'self'"));
 await writeFile(join(state,'settings.json'),JSON.stringify({showAuthorCredit:false}));assert.equal(configOf((await get('/')).body).showAuthorCredit,false);
 result=await get('/p/test-app/other?viewport=mobile');let view=configOf(result.body);assert.equal(view.route,'/other');assert.equal(view.projects.length,2);assert.equal(view.healthy,true);
 result=await get('/p/sleeping-app/home');assert.equal(configOf(result.body).state,'sleeping');assert.equal(configOf(result.body).healthy,false);
 assert.equal((await get('/p/test-app/missing')).status,404);assert.equal((await get('/registry.json')).status,404);assert.equal((await get('/', 'attacker.example')).status,403);assert.equal((await get('/', 'tailnet.test:8444')).status,403);
 result=await get('/hello?kept=1','tailnet.test:8443');assert.equal(result.body,'upstream /hello?kept=1');
 await writeFile(join(state,'thumbnails/test-app.json'),JSON.stringify({version:1,view:'home',route:'/stale',capturedAt:new Date().toISOString(),dataUrl:'data:image/png;base64,aGVsbG8='}));assert.equal(configOf((await get('/')).body).projects[0].thumbnail,null);
 await writeFile(join(state,'registry.json'),JSON.stringify({version:3,gateway:{httpsPort:443},projects:{}}));assert.equal(configOf((await get('/')).body).projects.length,0);
 console.log('PASS: dashboard, viewer, sleeping state, escaping, private headers, route validation, HTTP proxy, stale snapshots, and empty registry.');
}finally{processChild.kill('SIGTERM');await once(processChild,'exit');upstream.close();await rm(state,{recursive:true,force:true})}
