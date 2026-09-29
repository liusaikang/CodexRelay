import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run only against an isolated acceptance instance: seed changes maxConcurrent.
export async function verifyDeployment({ base, token, username, password, phase }) {
  assert.ok(['seed', 'restored'].includes(phase), 'Use seed or restored');
  assert.ok(token && username && password, 'Acceptance credentials are required');
  const request = (path, options = {}) => fetch(base + path, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/v1/tasks')).status, 401);
  assert.equal((await request('/v1/info', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const login = await request('/console/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200, 'Console login');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Console session cookie');
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  for (const path of ['/', '/assets/lucide.js', '/assets/settings.js', '/assets/invocations.js', '/assets/queue.js', '/v1/tasks']) {
    assert.equal((await request(path, { headers })).status, 200, path);
  }
  const settingsResponse = await request('/console/settings', { headers });
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  if (phase === 'seed') {
    const update = await request('/console/settings', {
      method: 'PUT', headers,
      body: JSON.stringify({ revision: settings.revision, settings: { ...settings.settings, maxConcurrent: 2 } }),
    });
    assert.equal(update.status, 200, 'Save acceptance settings');
  } else {
    assert.equal(settings.settings.maxConcurrent, 2, 'Settings survived recreation');
    assert.ok(settings.revision > 0, 'Persisted settings revision');
  }
  const info = await request('/v1/info', { headers });
  assert.equal((await info.json()).maxConcurrent, 2, 'Effective concurrency');
  console.log(`Deployment ${phase}: health, authentication, assets and effective settings passed. No model calls.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.CODEX_ACCEPTANCE_INSTANCE !== '1') throw new Error('Use an isolated instance and set CODEX_ACCEPTANCE_INSTANCE=1');
  await verifyDeployment({
    base: `http://127.0.0.1:${process.env.CODEX_MCP_PORT || '8787'}`,
    token: process.env.CODEX_MCP_TOKEN,
    username: process.env.CODEX_CONSOLE_USERNAME,
    password: process.env.CODEX_CONSOLE_PASSWORD,
    phase: process.argv[2],
  });
}
