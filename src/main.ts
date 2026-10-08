import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FileStore, inspectStoreLock, recoverStoreLock } from './storage.js';
import { TaskService } from './service.js';
import { ProcessRunner } from './runner/process.js';
import { DemoRunner } from './runner/demo.js';
import { createHttpApp } from './api/http.js';
import { createMcpServer } from './api/mcp.js';
import { AccountInspector, CodexAppServerGateway, CodexLoginManager } from './account.js';

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'config/development.yaml' },
  transport: { type: 'string', default: 'http' },
  check: { type: 'boolean', default: false },
  'inspect-lock': { type: 'boolean', default: false },
  'recover-lock': { type: 'boolean', default: false },
  'confirm-workers-stopped': { type: 'boolean', default: false },
} });

async function main() {
  if (!['http', 'stdio'].includes(values.transport!)) throw new Error('transport must be http or stdio');
  const config = await loadConfig(values.config!);
  if ([values.check, values['inspect-lock'], values['recover-lock']].filter(Boolean).length > 1) throw new Error('Choose only one of --check, --inspect-lock or --recover-lock');
  if (values['inspect-lock']) { console.log(JSON.stringify(await inspectStoreLock(config.dataDir), null, 2)); return; }
  if (values['recover-lock']) { console.log(JSON.stringify(await recoverStoreLock(config.dataDir, values['confirm-workers-stopped']!), null, 2)); return; }
  if (values['confirm-workers-stopped']) throw new Error('--confirm-workers-stopped requires --recover-lock');
  const token = process.env[config.tokenEnv] ?? '';
  if (values.transport === 'http' && token.length < 24) throw new Error(`Set ${config.tokenEnv} to a random secret of at least 24 characters`);
  if (values.check) {
    const provider = config.modelProviders?.find(item => item.id === (config.activeProvider ?? 'openai'));
    console.log(JSON.stringify({ valid: true, configFile: resolve(values.config!), dataDir: config.dataDir,
      invocationLog: config.invocationLog?.enabled === true, runner: config.runner, maxConcurrent: config.maxConcurrent, maxQueued: config.maxQueued,
      queueTimeoutSeconds: config.queueTimeoutSeconds, timeoutSeconds: config.timeoutSeconds, sandboxMode: config.sandboxMode,
      defaultWorkingDirectory: config.defaultWorkingDirectory, localConsole: !!config.localConsole, activeProvider: config.activeProvider ?? 'openai',
      modelAuthentication: provider?.envKey ? process.env[provider.envKey] ? 'external-api-key-present-not-validated' : 'not-detected'
        : process.env.CODEX_API_KEY && config.envAllowlist.includes('CODEX_API_KEY') ? 'api-key-present-not-validated'
          : existsSync(join(config.codexHome, 'auth.json')) ? 'auth-file-present-not-validated' : 'not-detected',
      outboundProxyConfigured: !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) }, null, 2));
    return;
  }
  const service = new TaskService(config, new FileStore(config.dataDir), config.runner === 'codex' ? new ProcessRunner() : new DemoRunner());
  const accountGateway = config.runner === 'codex' ? new CodexAppServerGateway({ codexHome: config.codexHome, codexPath: config.codexPath }) : undefined;
  const accountStatus = accountGateway ? new AccountInspector(accountGateway) : undefined;
  const codexLogin = accountGateway ? new CodexLoginManager(accountGateway, accountStatus) : undefined;
  await service.init();
  let closeTransport: () => Promise<void> = async () => {};
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // Stop admission before closing listeners; retain queued tasks for next startup.
    await service.close();
    codexLogin?.close();
    await accountGateway?.close();
    await closeTransport();
  };
  try {
    if (values.transport === 'stdio') {
      const server = createMcpServer(service, 'stdio');
      await server.connect(new StdioServerTransport());
      closeTransport = () => server.close();
      process.stdin.once('end', () => { void shutdown(); });
    } else {
      const app = createHttpApp(service, token, accountStatus, codexLogin);
      const server = app.listen(config.port, config.host);
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      closeTransport = () => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      console.error(`CodexMCP listening on http://${config.host}:${port}/mcp (${config.runner} runner; config: ${resolve(values.config!)})`);
    }
    process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  } catch (error) { await shutdown(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
