import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string', default: 'config/development.yaml' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: npm run codex:auth -- <login|status> [--config config/production.yaml]');
    return;
  }
  const action = positionals[0] ?? 'status';
  if (positionals.length > 1 || !['login', 'status'].includes(action)) throw new Error('Use login or status');
  const config = await loadConfig(values.config);
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  const command = config.codexPath ?? process.execPath;
  const args = [ ...(config.codexPath ? [] : [cli]), 'login', ...(action === 'login' ? ['--device-auth'] : ['status']) ];
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: config.codexHome };
  delete env[config.tokenEnv];
  delete env.CODEX_CONSOLE_PASSWORD;
  delete env.NODE_OPTIONS;
  console.log(`Configuration: ${resolve(values.config)}`);
  console.log(`Codex home: ${config.codexHome}`);
  const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true, shell: false });
  process.exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code ?? 1));
  });
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Codex authentication command failed'); process.exitCode = 1; });
