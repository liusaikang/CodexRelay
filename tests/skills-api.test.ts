import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config.js';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import { DemoRunner } from '../src/runner/demo.js';
import { createHttpApp } from '../src/api/http.js';

let directory: string, service: TaskService, server: Server;
const bearer = 'a-test-token-longer-than-24-characters';
afterEach(async () => {
  if (server) await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
  if (service) await service.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('serves read-only Skill files only to an authenticated console session', async () => {
  directory = await mkdtemp(join(tmpdir(), 'relay-skills-api-'));
  const root = join(directory, 'workspace', '.agents', 'skills', 'sample');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '---\nname: sample\n---\n# Read only', 'utf8');
  const config = await loadConfig(resolve('config/demo.yaml'));
  config.dataDir = join(directory, 'data');
  config.defaultWorkingDirectory = join(directory, 'workspace');
  service = new TaskService(config, new FileStore(config.dataDir), new DemoRunner());
  await service.init();
  server = createHttpApp(service, bearer).listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  expect((await fetch(`${base}/console/skills`)).status).toBe(401);
  expect((await fetch(`${base}/console/skills`, { headers: { Authorization: `Bearer ${bearer}` } })).status).toBe(403);
  expect((await fetch(`${base}/assets/skills.js`)).status).toBe(401);
  expect((await fetch(`${base}/assets/marked.js`)).status).toBe(401);
  expect((await fetch(`${base}/assets/dompurify.js`)).status).toBe(401);
  const login = await fetch(`${base}/console/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(`${base}/assets/skills.js`, { headers: { Cookie: cookie } })).status).toBe(200);
  expect((await fetch(`${base}/assets/marked.js`, { headers: { Cookie: cookie } })).status).toBe(200);
  expect((await fetch(`${base}/assets/dompurify.js`, { headers: { Cookie: cookie } })).status).toBe(200);
  const tree = await (await fetch(`${base}/console/skills`, { headers: { Cookie: cookie } })).json();
  expect(tree.entries[0]).toMatchObject({ name: 'sample', kind: 'directory' });
  const file = await (await fetch(`${base}/console/skills/file?path=sample%2FSKILL.md`, { headers: { Cookie: cookie } })).json();
  expect(file.content).toContain('# Read only');
  expect((await fetch(`${base}/console/skills/file?path=..%2Foutside.md`, { headers: { Cookie: cookie } })).status).toBe(400);
});
