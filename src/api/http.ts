import express, { type ErrorRequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z, ZodError } from 'zod';
import { createMcpServer } from './mcp.js';
import { TaskService } from '../service.js';
import { AppError, idSchema, pageSchema } from '../types.js';
import type { AccountStatusProvider } from '../account.js';
import { invocationQuerySchema } from '../invocations.js';

export function createHttpApp(service: TaskService, token: string, accountStatus?: AccountStatusProvider) {
  if (token.length < 24) throw new Error('Service token must be at least 24 characters');
  const app = express();
  app.disable('x-powered-by');
  const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
  const isLoopback = (address?: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
    if (req.method === 'GET' && (req.path === '/' || req.path === '/console')) {
      res.sendFile(fileURLToPath(new URL('../../public/index.html', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/lucide.js') {
      res.sendFile(fileURLToPath(new URL('../../node_modules/lucide/dist/umd/lucide.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/assets/invocations.js') {
      res.sendFile(fileURLToPath(new URL('../../public/invocations.js', import.meta.url))); return;
    }
    if (req.method === 'GET' && req.path === '/favicon.ico') { res.status(204).end(); return; }
    if (req.path === '/healthz' && req.method === 'GET') {
      const ready = service.health().ready;
      res.status(ready ? 200 : 503).json({ ready }); return;
    }
    if (req.path === '/console/session' && req.method === 'GET') {
      const forwarded = Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-') || key === 'x-real-ip');
      if (!service.config.localConsole || !isLoopback(req.socket.remoteAddress) || !['localhost', '127.0.0.1', '[::1]'].includes(host) || forwarded) {
        res.status(403).json({ error: { code: 'LOCAL_CONSOLE_ONLY', message: 'Automatic console authentication is disabled or this is not a direct local connection.' } }); return;
      }
      res.json({ token, runner: service.health().runner }); return;
    }
    const supplied = createHash('sha256').update(req.get('authorization') ?? '').digest();
    if (!timingSafeEqual(supplied, tokenHash)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid bearer token required' } }); return;
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
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
  app.get('/v1/tasks/:id', (req, res) => res.json(service.getTask(idSchema.parse(req.params.id))));
  app.post('/v1/tasks/:id/cancel', async (req, res) => res.json(await service.cancel(idSchema.parse(req.params.id))));
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
    if (error instanceof AppError) { res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof ZodError || error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid request. Check input types, lengths and required fields.' } }); return;
    }
    console.error('HTTP request failed', error.code ?? 'INTERNAL_ERROR');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } });
  };
  app.use(errors);
  return app;
}
