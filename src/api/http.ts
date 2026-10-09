import express, { type ErrorRequestHandler } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z, ZodError } from 'zod';
import { createMcpServer } from './mcp.js';
import { TaskService } from '../service.js';
import { AppError, idSchema, pageSchema, retrySchema } from '../types.js';
import type { AccountStatusProvider, CodexLoginProvider } from '../account.js';
import { invocationQuerySchema } from '../invocations.js';
import { ScheduleService } from '../schedules.js';
import { SkillExplorer } from '../skills.js';

export function createHttpApp(service: TaskService, token: string, accountStatus?: AccountStatusProvider, codexLogin?: CodexLoginProvider, schedules?: ScheduleService) {
  if (token.length < 24) throw new Error('Service token must be at least 24 characters');
  const app = express();
  app.disable('x-powered-by');
  const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
  const consoleSessions = new Map<string, { username: string; expiresAt: number }>();
  const loginFailures = new Map<string, { count: number; until: number }>();
  const cookieName = 'codex_console';
  const sessionLifetimeMs = 8 * 60 * 60 * 1000;
  const secureCookie = !['127.0.0.1', '::1'].includes(service.config.host);
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;
  const credentials = service.config.consoleAuth;
  const skillExplorer = new SkillExplorer(service.config.defaultWorkingDirectory);
  const sessionId = (req: express.Request) => req.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const consoleSession = (req: express.Request) => {
    const id = sessionId(req);
    if (!id) return undefined;
    const session = consoleSessions.get(id);
    if (session && session.expiresAt <= Date.now()) { consoleSessions.delete(id); return undefined; }
    return session;
  };
  const sameOriginPost = (req: express.Request) => {
    const origin = req.get('origin');
    return !!origin && (origin === `${req.protocol}://${req.get('host')}` || service.config.allowedOrigins.includes(origin));
  };
  const matches = (left: string, right: string) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
  app.use((req, res, next) => {
    const host = req.hostname.toLowerCase();
    if (!service.config.allowedHosts.map(value => value.toLowerCase()).includes(host)) {
      res.status(403).json({ error: { code: 'HOST_DENIED', message: 'Host not allowed' } }); return;
    }
    const origin = req.get('origin');
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== sameOrigin && !service.config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed' } }); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'GET' && req.path === '/login') {
      if (consoleSession(req)) { res.redirect('/'); return; }
      res.sendFile(fileURLToPath(new URL('../../public/login.html', import.meta.url))); return;
    }
    if (req.path === '/console/login' && req.method === 'POST') {
      if (!sameOriginPost(req)) { res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return; }
      next(); return;
    }
    if (req.path === '/console/logout' && req.method === 'POST') {
      if (!sameOriginPost(req)) { res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return; }
      const id = sessionId(req);
      if (id) consoleSessions.delete(id);
      res.setHeader('Set-Cookie', `${cookieName}=; ${cookieOptions}; Max-Age=0`);
      res.status(204).end(); return;
    }
    if (req.method === 'GET' && (req.path === '/' || req.path === '/console')) {
      if (!consoleSession(req)) { res.redirect('/login'); return; }
      res.sendFile(fileURLToPath(new URL('../../public/index.html', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/lucide.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../node_modules/lucide/dist/umd/lucide.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/invocations.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../public/invocations.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/settings.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../public/settings.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/queue.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../public/queue.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/schedules.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../public/schedules.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/skills.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.sendFile(fileURLToPath(new URL('../../public/skills.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/marked.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.type('text/javascript').sendFile(fileURLToPath(new URL('../../node_modules/marked/lib/marked.esm.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/dompurify.js') {
      if (!consoleSession(req)) { res.status(401).end(); return; }
      res.type('text/javascript').sendFile(fileURLToPath(new URL('../../node_modules/dompurify/dist/purify.es.mjs', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/favicon.ico') { res.status(204).end(); return; }
    if (req.path === '/healthz' && req.method === 'GET') {
      const ready = service.health().ready;
      res.status(ready ? 200 : 503).json({ ready }); return;
    }
    if (req.path === '/console/session' && req.method === 'GET') {
      const session = consoleSession(req);
      if (!session) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Console login required' } }); return; }
      res.json({ username: session.username, runner: service.health().runner }); return;
    }
    const supplied = createHash('sha256').update(req.get('authorization') ?? '').digest();
    const bearerValid = timingSafeEqual(supplied, tokenHash);
    const browserSession = req.path === '/mcp' ? undefined : consoleSession(req);
    if (!bearerValid && !browserSession) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid bearer token required' } }); return;
    }
    if (!bearerValid && browserSession && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOriginPost(req)) {
      res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return;
    }
    next();
  });
  app.post('/console/login', express.json({ limit: '4kb' }), (req, res) => {
    const input = z.object({ username: z.string(), password: z.string() }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Username and password required' } }); return; }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const attempts = loginFailures.get(ip);
    if (attempts && attempts.until > Date.now() && attempts.count >= 5) {
      res.status(429).json({ error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts. Try again later.' } }); return;
    }
    if (!credentials || !matches(input.data.username, credentials.username) || !matches(input.data.password, credentials.password)) {
      const active = attempts && attempts.until > Date.now() ? attempts : { count: 0, until: Date.now() + 15 * 60 * 1000 };
      active.count++; loginFailures.set(ip, active);
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Username or password incorrect' } }); return;
    }
    loginFailures.delete(ip);
    const id = randomBytes(32).toString('hex');
    consoleSessions.set(id, { username: credentials.username, expiresAt: Date.now() + sessionLifetimeMs });
    res.setHeader('Set-Cookie', `${cookieName}=${id}; ${cookieOptions}; Max-Age=${sessionLifetimeMs / 1000}`);
    res.json({ username: credentials.username });
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/console/settings', (req, res, next) => {
    if (!consoleSession(req)) { res.status(403).json({ error: { code: 'CONSOLE_ONLY', message: 'Console login required' } }); return; }
    if (req.method !== 'GET' && !sameOriginPost(req)) {
      res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return;
    }
    next();
  });
  app.get('/console/settings', (_req, res) => res.json(service.getSettings()));
  app.put('/console/settings', async (req, res) => res.json(await service.updateSettings(req.body, consoleSession(req)!.username)));
  app.use('/console/skills', (req, res, next) => {
    if (!consoleSession(req)) { res.status(403).json({ error: { code: 'CONSOLE_ONLY', message: 'Console login required' } }); return; }
    next();
  });
  app.get('/console/skills', async (_req, res) => res.json(await skillExplorer.tree()));
  app.get('/console/skills/file', async (req, res) => {
    const { path } = z.object({ path: z.string().min(1) }).strict().parse(req.query);
    res.json(await skillExplorer.file(path));
  });
  app.use('/console/schedules', (req, res, next) => {
    if (!consoleSession(req)) { res.status(403).json({ error: { code: 'CONSOLE_ONLY', message: 'Console login required' } }); return; }
    if (req.method !== 'GET' && !sameOriginPost(req)) {
      res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return;
    }
    if (!schedules) { res.status(503).json({ error: { code: 'SCHEDULES_UNAVAILABLE', message: 'Scheduled tasks are unavailable' } }); return; }
    next();
  });
  app.get('/console/schedules', (_req, res) => res.json({ items: schedules!.list() }));
  app.post('/console/schedules', async (req, res) => res.status(201).json(await schedules!.create(req.body)));
  app.get('/console/schedules/:id/runs', (req, res) => res.json({ items: schedules!.runs(req.params.id) }));
  app.put('/console/schedules/:id/enabled', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await schedules!.setEnabled(req.params.id, enabled));
  });
  app.post('/console/schedules/:id/run', async (req, res) => res.status(202).json(await schedules!.runNow(req.params.id)));
  app.use('/console/codex-login', (req, res, next) => {
    if (!consoleSession(req)) { res.status(403).json({ error: { code: 'CONSOLE_ONLY', message: 'Console login required' } }); return; }
    if (req.method !== 'GET' && !sameOriginPost(req)) {
      res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Same-origin request required' } }); return;
    }
    if (!codexLogin) { res.status(409).json({ error: { code: 'CODEX_LOGIN_DISABLED', message: 'Codex runner is not enabled' } }); return; }
    next();
  });
  app.get('/console/codex-login', (_req, res) => res.json(codexLogin!.status()));
  app.post('/console/codex-login/start', async (_req, res) => res.json(await codexLogin!.start()));
  app.post('/console/codex-login/cancel', async (_req, res) => res.json(await codexLogin!.cancel()));
  const pagination = (query: unknown) => {
    const raw = z.object({ offset: z.coerce.number().optional(), limit: z.coerce.number().optional() }).parse(query);
    return pageSchema.parse(raw);
  };
  app.get('/v1/health', (_req, res) => res.json(service.health()));
  app.get('/v1/info', (_req, res) => res.json(service.info()));
  app.get('/v1/admin/invocations/summary', (req, res) => res.json(service.invocations.summary(invocationQuerySchema.parse(req.query))));
  app.get('/v1/admin/invocations', (req, res) => res.json(service.invocations.list(invocationQuerySchema.parse(req.query))));
  app.get('/v1/admin/invocations/:id', (req, res) => res.json(service.invocations.detail(idSchema.parse(req.params.id))));
  app.get('/v1/admin/account', async (_req, res) => res.json(accountStatus
    ? await accountStatus.read()
    : { available: false, authenticated: false, checkedAt: new Date().toISOString() }));
  app.post('/v1/admin/account/refresh', async (_req, res) => res.json(accountStatus
    ? await accountStatus.read(true)
    : { available: false, authenticated: false, checkedAt: new Date().toISOString() }));
  app.post('/v1/tasks', async (req, res) => res.status(202).json(await service.submit(req.body)));
  app.get('/v1/tasks', (req, res) => res.json(service.listTasks(req.query)));
  app.post('/v1/tasks/:id/retry', async (req, res) => {
    const { idempotencyKey } = retrySchema.parse(req.body);
    res.status(202).json(await service.retry(idSchema.parse(req.params.id), idempotencyKey));
  });
  app.get('/v1/tasks/:id', (req, res) => res.json(service.getTask(idSchema.parse(req.params.id))));
  app.post('/v1/tasks/:id/cancel', async (req, res) => res.json(await service.cancel(idSchema.parse(req.params.id))));
  app.post('/v1/sessions/:id/resume', async (req, res) => {
    const { blockedByTaskId } = z.object({ blockedByTaskId: idSchema }).strict().parse(req.body);
    res.json(await service.resumeSession(idSchema.parse(req.params.id), blockedByTaskId));
  });
  app.get('/v1/sessions', (req, res) => { const { offset, limit } = pagination(req.query); res.json(service.listSessions(offset, limit)); });
  app.get('/v1/sessions/:id', (req, res) => {
    const { offset, limit } = pagination(req.query);
    res.json(service.getSession(idSchema.parse(req.params.id), offset, limit));
  });
  app.post('/mcp', async (req, res, next) => {
    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { await server.close().catch(() => {}); next(error); }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use MCP Streamable HTTP POST' } }));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof AppError) {
      if (error.httpStatus === 429) res.set('Retry-After', '5');
      res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } }); return;
    }
    if (error instanceof ZodError || error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid request. Check input types, lengths and required fields.' } }); return;
    }
    console.error('HTTP request failed', error.code ?? 'INTERNAL_ERROR');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } });
  };
  app.use(errors);
  return app;
}
