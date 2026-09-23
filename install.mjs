#!/usr/bin/env node
// Copy the skill to a stable path. Runtime state lives outside this directory.
import { chmod, copyFile, lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('Tailnet Preview requires Node.js 20 or newer.');
  process.exit(2);
}
const args = process.argv.slice(2);
if (args.length > 2 || (args.length && args[0] !== '--dest')) {
  console.error('Usage: node install.mjs [--dest /path/to/skills/tailnet-preview]');
  process.exit(2);
}
const destination = resolve(args[1] || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'tailnet-preview'));
if (args[0] === '--dest' && !args[1]) {
  console.error('--dest requires a path.');
  process.exit(2);
}
if (destination === source) {
  console.log(`Already installed at ${destination}`);
  process.exit(0);
}
if (destination.startsWith(source + sep)) {
  console.error('The installation destination cannot be inside this repository.');
  process.exit(2);
}
if (basename(destination) !== 'tailnet-preview') {
  console.error('The destination directory must be named tailnet-preview.');
  process.exit(2);
}

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function safeDirectory(path) {
  const stat = await existing(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Refusing to replace ${path}: expected a real directory.`);
  if (!stat) await mkdir(path, { recursive: true, mode: 0o700 });
}
async function copy(relative) {
  const from = join(source, relative);
  const to = join(destination, relative);
  const stat = await lstat(from);
  if (stat.isDirectory()) {
    await safeDirectory(to);
    for (const entry of await readdir(from)) await copy(join(relative, entry));
  } else if (stat.isFile()) {
    const prior = await existing(to);
    if (prior?.isSymbolicLink() || (prior && !prior.isFile())) throw new Error(`Refusing to replace ${to}: expected a regular file.`);
    await safeDirectory(dirname(to));
    const temporary = `${to}.${process.pid}.tmp`;
    await copyFile(from, temporary);
    await chmod(temporary, stat.mode & 0o777);
    await rename(temporary, to);
  } else throw new Error(`Unsupported source entry: ${from}`);
}

await safeDirectory(destination);
for (const entry of ['SKILL.md', 'agents', 'assets', 'scripts']) await copy(entry);
console.log(`Installed Tailnet Preview at ${destination}`);
console.log(`Run ${join(destination, 'scripts', 'preview')} doctor to check this host.`);
console.log('Existing previews retain their state and URLs. Run preview reload-gateway after an update to load the new browser UI.');
