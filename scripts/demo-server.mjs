import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const accessFile = new URL('data/demo-access.json', root);
await mkdir(new URL('data/', root), { recursive: true });
let access;
try { access = JSON.parse(await readFile(accessFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  access = { url: 'http://127.0.0.1:8787', token: randomBytes(32).toString('hex') };
  await writeFile(accessFile, JSON.stringify(access, null, 2), { flag: 'wx', mode: 0o600 });
}
if (access.url !== 'http://127.0.0.1:8787' || typeof access.token !== 'string' || access.token.length < 24) throw new Error('Invalid local demo access file');
const token = process.env.CODEX_MCP_TOKEN || access.token;
if (token.length < 24) throw new Error('CODEX_MCP_TOKEN must be at least 24 characters');
process.env.CODEX_MCP_TOKEN = token;
process.argv = [process.execPath, fileURLToPath(new URL('dist/main.js', root)), '--config', fileURLToPath(new URL('config/demo.yaml', root))];
console.error(process.env.CODEX_MCP_TOKEN === access.token
  ? `Local demo token stored at ${fileURLToPath(accessFile)} (do not commit or share).`
  : 'Local demo token loaded from CODEX_MCP_TOKEN.');
await import(new URL('dist/main.js', root).href);
