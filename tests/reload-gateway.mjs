import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('SKIP: launchd reload fixture runs on macOS.');
} else {
  const run = promisify(execFile);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const state = await mkdtemp(join(tmpdir(), 'tailnet-preview-reload-'));
  const fakeLaunchctl = join(state, 'launchctl');
  const fakeTailscale = join(state, 'tailscale');
  const pidFile = join(state, 'gateway.pid');
  const server = createServer();
  let gatewayPid;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    await writeFile(fakeLaunchctl, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const file=process.env.MOCK_GATEWAY_PID_FILE,args=process.argv.slice(2);
if(args[0]==='print'){try{process.kill(Number(fs.readFileSync(file,'utf8')),0);process.exit(0)}catch{process.exit(1)}}
if(args[0]==='remove'){try{process.kill(Number(fs.readFileSync(file,'utf8')),'SIGTERM')}catch{}try{fs.unlinkSync(file)}catch{}process.exit(0)}
if(args[0]==='submit'){const index=args.indexOf('--');const child=cp.spawn(args[index+1],args.slice(index+2),{detached:true,stdio:'ignore',env:process.env});child.unref();fs.writeFileSync(file,String(child.pid));process.exit(0)}
process.exit(2);
`);
    await chmod(fakeLaunchctl, 0o755);
    await writeFile(fakeTailscale, `#!/bin/sh
if [ "$1" = status ]; then printf '%s\\n' '{"Self":{"DNSName":"other-laptop.example.ts.net."}}'; exit 0; fi
exit 2
`);
    await chmod(fakeTailscale, 0o755);
    const registry = JSON.stringify({ version: 3, gateway: { localPort: port, httpsPort: 9443, label: 'test.tailnet-preview.gateway' }, projects: {} });
    await writeFile(join(state, 'registry.json'), registry);
    const env = { ...process.env, TAILNET_PREVIEW_STATE_DIR: state, TAILNET_PREVIEW_TAILSCALE_BIN: fakeTailscale, TAILNET_PREVIEW_LAUNCHCTL_BIN: fakeLaunchctl, MOCK_GATEWAY_PID_FILE: pidFile };
    const { stdout } = await run(process.execPath, [join(root, 'scripts', 'preview.mjs'), 'reload-gateway', '--json'], { env, timeout: 15000 });
    assert.equal(JSON.parse(stdout).ok, true);
    gatewayPid = Number(await readFile(pidFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/_tailnet-preview/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 3);
    assert.equal(await readFile(join(state, 'registry.json'), 'utf8'), registry);
    console.log('PASS: gateway reload starts from this installation and preserves registry and port.');
  } finally {
    if (gatewayPid) try { process.kill(gatewayPid, 'SIGTERM'); } catch {}
    await rm(state, { recursive: true, force: true });
  }
}
