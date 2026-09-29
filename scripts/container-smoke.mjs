// Uses production config and isolated synthetic state; never submits a model task.
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { FileStore } from '../dist/storage.js';
import { TaskService } from '../dist/service.js';
import { createHttpApp } from '../dist/api/http.js';
import { verifyDeployment } from './deployment-smoke.mjs';

const directory = await mkdtemp(join(tmpdir(),'relay-container-check-'));
const token = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex');
Object.assign(process.env, {
  CODEX_MCP_TOKEN:token, CODEX_CONSOLE_USERNAME:'operator', CODEX_CONSOLE_PASSWORD:password,
  CODEX_DATA_DIR:join(directory,'tasks'), CODEX_INVOCATION_LOG_DIR:join(directory,'logs'),
  CODEX_HOME:join(directory,'codex'), CODEX_WORKSPACE:resolve('examples/workspace'),
  CODEX_BIND_HOST:'127.0.0.1', CODEX_PUBLIC_HOST:'localhost', CODEX_PUBLIC_ORIGIN:'http://localhost:8787',
});
let service, server;
const close = async () => {
  if (server) { const current = server; server = undefined; await new Promise((resolve,reject) => { current.close(error => error ? reject(error) : resolve()); current.closeIdleConnections(); }); }
  await service?.close(); service = undefined;
};
try {
  execFileSync(process.execPath,['node_modules/@openai/codex/bin/codex.js','--version'],{stdio:'pipe'});
  const config = await loadConfig('config/production.yaml');
  const forbiddenRunner = {run() { throw new Error('Smoke test must not invoke Codex'); }};
  service = new TaskService(config,new FileStore(config.dataDir),forbiddenRunner);
  await service.init();
  server = createHttpApp(service,token).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal((await fetch(base+'/v1/tasks')).status,401);
  assert.equal((await fetch(base+'/v1/info',{headers:{Authorization:`Bearer ${token}`}})).status,200);
  const login = await fetch(base+'/console/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of ['/','/assets/lucide.js','/assets/settings.js','/assets/invocations.js','/assets/queue.js','/v1/tasks']) {
    assert.equal((await fetch(base+path,{headers:{Cookie:cookie}})).status,200,path);
  }
  const initial = service.getSettings();
  await service.updateSettings({revision:initial.revision,settings:{...initial.settings,maxConcurrent:2}},'smoke');
  await verifyDeployment({base,token,username:'operator',password,phase:'seed'});
  await close();
  service = new TaskService(await loadConfig('config/production.yaml'),new FileStore(config.dataDir),forbiddenRunner);
  await service.init();
  assert.equal(service.info().maxConcurrent,2);
  await access(join(config.dataDir,'runtime-settings.json'));
  server = createHttpApp(service,token).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  await verifyDeployment({base:`http://127.0.0.1:${server.address().port}`,token,username:'operator',password,phase:'restored'});
  console.log('Production config, bundled CLI, HTTP login/assets, queue and persisted settings passed. No model calls.');
} finally { await close(); await rm(directory,{recursive:true,force:true}); }
