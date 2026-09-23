import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const execute = promisify(execFile);
export async function machineName() {
  const binary = process.env.TAILNET_PREVIEW_TAILSCALE_BIN || [...(process.env.PATH || '').split(':').filter(Boolean).map(p => join(p, 'tailscale')), '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'].find(existsSync);
  if (!binary) return null;
  try { const { stdout } = await execute(binary, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }); return JSON.parse(stdout).Self?.DNSName?.replace(/\.$/, '').toLowerCase() || null; } catch { return null; }
}
export function createManagement({ stateDir, helper, registry, dnsName, localPort }) {
  const token = randomBytes(32).toString('hex');
  let busy = false;
  function allowedHost(host, gatewayPort = 443) {
    try {
      const url = new URL('http://' + host);
      if (url.host !== host || url.username || url.password) return false;
      return (['localhost', '127.0.0.1'].includes(url.hostname) && (!url.port || Number(url.port) === localPort)) ||
        (url.hostname === dnsName && Number(url.port || 443) === gatewayPort);
    } catch { return false; }
  }
  async function handle(request, response, current) {
    const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(data)); };
    if (request.method !== 'POST') { reply(405, { error: 'Use POST for instance actions.' }); return; }
    const host = request.headers.host || '';
    const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
    const expectedOrigin = new URL(`${local ? 'http' : 'https'}://${host}`).origin;
    const supplied = Buffer.from(String(request.headers['x-preview-token'] || ''));
    if (!allowedHost(host, current.gateway?.httpsPort || 443) || request.headers.origin !== expectedOrigin ||
        supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
      reply(403, { error: 'This page can no longer manage previews. Refresh it and try again.' }); return;
    }
    if (request.headers['content-type'] !== 'application/json') { reply(415, { error: 'Expected JSON.' }); return; }
    let body = '';
    try {
      for await (const chunk of request) { body += chunk; if (body.length > 1024) { reply(413, { error: 'Request is too large.' }); return; } }
      const input = JSON.parse(body);
      if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.id || '') || !['start','stop','restart','disconnect','remove'].includes(input.action)) { reply(400, { error: 'Unknown instance action.' }); return; }
      if (busy) { reply(409, { error: 'Another instance action is still running. Refresh in a moment.' }); return; }
      // Re-read after receiving the body; never act on the page's stale mode or state.
      const latest = await registry();
      const project = latest.projects?.[input.id];
      if (!project) { reply(404, { error: 'This project has already been removed. Refresh the library.' }); return; }
      if ((['start','stop','restart'].includes(input.action) && project.mode !== 'supervised') || (input.action === 'disconnect' && project.mode !== 'attached')) { reply(409, { error: 'This action is not supported for this project. Refresh its details.' }); return; }
      if (busy) { reply(409, { error: 'Another instance action is still running. Refresh in a moment.' }); return; }
      busy = true;
      try {
        const command = { start: 'resume', stop: 'sleep', restart: 'restart', disconnect: 'sleep', remove: 'remove' }[input.action];
        await execute(process.execPath, [helper, command, input.id, '--json'], { env: { ...process.env, TAILNET_PREVIEW_STATE_DIR: stateDir }, timeout: 120000, maxBuffer: 1024 * 1024 });
        reply(200, { ok: true, action: input.action, id: input.id });
      } catch (error) {
        let message = 'The action did not finish. Refresh to check the current state before trying again.';
        try { const failure = JSON.parse(error.stderr); if (typeof failure.message === 'string') message = failure.message.slice(0, 600); } catch {}
        reply(502, { error: message });
      } finally { busy = false; }
    } catch { reply(400, { error: 'Invalid request.' }); }
  }
  return { token, allowedHost, handle };
}
