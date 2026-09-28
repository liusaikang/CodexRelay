import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const content = template
  .replace(/^CODEX_MCP_TOKEN=$/m, `CODEX_MCP_TOKEN=${randomBytes(32).toString('hex')}`)
  .replace(/^CODEX_CONSOLE_PASSWORD=$/m, `CODEX_CONSOLE_PASSWORD=${randomBytes(24).toString('hex')}`);
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random service token and production console password. Values are not printed. Configure model authentication before using the Codex runner.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; no credentials or settings were changed.');
}
