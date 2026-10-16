// Run locally only. Password and secret values never appear in command arguments or output.
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { passwordVerifier } from '../src/auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('Provide an absolute password file path outside this project.');
const path = resolve(destination);
await mkdir(dirname(path), { recursive: true });
const parent = await realpath(dirname(path));
const location = relative(await realpath(root), parent);
if (!location.startsWith('..') && !isAbsolute(location)) throw new Error('Keep the password file outside the project.');
const password = randomBytes(24).toString('base64url');
await writeFile(path, `Kyara Market — Trades password\nhttps://market.kyara-prices.workers.dev/trades\n\n${password}\n\nKeep this file private. A login lasts eight hours.\n`, { flag: 'wx', mode: 0o600 });
const secrets = {
  TRADES_PASSWORD_HASH: await passwordVerifier(password, randomBytes(16).toString('hex')),
  TRADES_SESSION_SECRET: randomBytes(32).toString('hex'),
};
const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
child.stdin.end(JSON.stringify(secrets));
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
if (code !== 0) throw new Error('Cloudflare did not confirm the secret upload. The local file is saved, but that password is not active.');
console.log('Trades access configured. Password saved locally; no password printed.');
