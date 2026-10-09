import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config.js';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import { DemoRunner } from '../src/runner/demo.js';
import { ScheduleService } from '../src/schedules.js';
import { createHttpApp } from '../src/api/http.js';

let directory: string, tasks: TaskService, schedules: ScheduleService, server: Server, base: string;
const bearer = { Authorization: 'Bearer a-test-token-longer-than-24-characters', 'Content-Type': 'application/json' };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'relay-schedule-api-'));
  const config = await loadConfig(resolve('config/demo.yaml'));
  config.dataDir = directory;
  config.maxConcurrent = 4;
  tasks = new TaskService(config, new FileStore(directory), new DemoRunner());
  await tasks.init();
  schedules = new ScheduleService(tasks, { autoStart: false });
  await schedules.init();
  server = createHttpApp(tasks, bearer.Authorization.slice(7), undefined, undefined, schedules).listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await schedules.close();
  await tasks.close();
  await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
  await rm(directory, { recursive: true, force: true });
});

it('limits schedule management to the logged-in console and records runs', async () => {
  expect((await fetch(`${base}/console/schedules`)).status).toBe(401);
  expect((await fetch(`${base}/console/schedules`, { headers: bearer })).status).toBe(403);
  expect((await fetch(`${base}/assets/schedules.js`)).status).toBe(401);
  const login = await fetch(`${base}/console/login`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const browserHeaders = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  expect((await fetch(`${base}/assets/schedules.js`, { headers: { Cookie: cookie } })).status).toBe(200);
  const input = { name: 'Review', question: 'Review records', intervalMinutes: 5, enabled: true };
  expect((await fetch(`${base}/console/schedules`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(input) })).status).toBe(403);
  expect((await fetch(`${base}/console/schedules`, { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ ...input, intervalMinutes: 0 }) })).status).toBe(400);
  const created = await fetch(`${base}/console/schedules`, { method: 'POST', headers: browserHeaders, body: JSON.stringify(input) });
  expect(created.status).toBe(201);
  const rule = await created.json();
  expect(rule).toMatchObject({ name: 'Review', intervalMinutes: 5, sessions: [null,null,null,null] });
  expect((await (await fetch(`${base}/console/schedules`, { headers: browserHeaders })).json()).items[0]).toMatchObject({ id: rule.id, laneLimit: 4 });
  const manual = await fetch(`${base}/console/schedules/${rule.id}/run`, { method: 'POST', headers: browserHeaders });
  expect(manual.status).toBe(202);
  const run = await manual.json();
  expect(run).toMatchObject({ scheduleId: rule.id, state: 'submitted' });
  const rows = await (await fetch(`${base}/console/schedules/${rule.id}/runs`, { headers: browserHeaders })).json();
  expect(rows.items).toHaveLength(1);
  expect(rows.items[0].taskId).toBe(run.taskId);
  const paused = await fetch(`${base}/console/schedules/${rule.id}/enabled`, { method: 'PUT', headers: browserHeaders,
    body: JSON.stringify({ enabled: false }) });
  expect(paused.status).toBe(200);
  expect((await paused.json()).enabled).toBe(false);
});
