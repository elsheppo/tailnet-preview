import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'tailnet-preview-portable-'));
const codexHome = join(temporary, 'another-user', 'codex-home');
const stateHome = join(temporary, 'another-user', 'state');
const fakeTailscale = join(temporary, 'tailscale');
const installed = join(codexHome, 'skills', 'tailnet-preview');
const env = { ...process.env, CODEX_HOME: codexHome, XDG_STATE_HOME: stateHome, TAILNET_PREVIEW_TAILSCALE_BIN: fakeTailscale };

try {
  await writeFile(fakeTailscale, `#!/bin/sh
if [ "$1" = status ]; then printf '%s\\n' '{"Self":{"DNSName":"other-laptop.example.ts.net."}}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = status ]; then printf '%s\\n' '{"TCP":{},"Web":{}}'; exit 0; fi
exit 2
`);
  await chmod(fakeTailscale, 0o755);
  await run(process.execPath, [join(root, 'install.mjs')], { env });
  const helper = join(installed, 'scripts', 'preview');
  assert.match(await readFile(join(installed, 'SKILL.md'), 'utf8'), /name: tailnet-preview/);
  assert.match(await readFile(join(installed, 'assets', 'dashboard.html'), 'utf8'), /<footer class="library-footer">/);
  const { stdout } = await run(helper, ['doctor', '--json'], { env });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.machine, 'other-laptop.example.ts.net');
  assert.equal(receipt.registryVersion, 3);
  assert.equal(receipt.projects, 0);

  const registryDir = join(stateHome, 'tailnet-preview');
  await mkdir(registryDir, { recursive: true });
  const registry = JSON.stringify({ version: 3, gateway: null, projects: { kept: { id: 'kept' } } });
  await writeFile(join(registryDir, 'registry.json'), registry);
  await writeFile(join(installed, 'SKILL.md'), 'old release');
  await run(process.execPath, [join(root, 'install.mjs')], { env });
  assert.match(await readFile(join(installed, 'SKILL.md'), 'utf8'), /name: tailnet-preview/);
  assert.equal(await readFile(join(registryDir, 'registry.json'), 'utf8'), registry);

  await assert.rejects(run(helper, ['reload-gateway', '--json'], { env }), error => {
    assert.equal(JSON.parse(error.stderr).code, 'gateway_not_configured');
    return true;
  });
  const unsupported = JSON.stringify({ version: 2, previews: { kept: { id: 'kept' } } });
  await writeFile(join(registryDir, 'registry.json'), unsupported);
  await assert.rejects(run(helper, ['doctor', '--json'], { env }), error => {
    assert.equal(JSON.parse(error.stderr).code, 'invalid_registry');
    return true;
  });
  assert.equal(await readFile(join(registryDir, 'registry.json'), 'utf8'), unsupported);
  console.log('PASS: clean install, host-derived tailnet name, stable update path, preserved state, and absent-gateway recovery.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
