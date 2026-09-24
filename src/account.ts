import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

type QuotaWindow = { usedPercent: number; remainingPercent: number; windowDurationMins: number | null; resetsAt: string | null };
export type AccountSnapshot = {
  available: boolean;
  authenticated: boolean;
  checkedAt: string;
  method?: string;
  email?: string | null;
  plan?: string | null;
  quota?: { ordinaryUsageAllowed: boolean | null; primary: QuotaWindow | null; secondary: QuotaWindow | null };
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null; availableResetCount: number };
  tokenUsage?: {
    lifetimeTokens: number | null; peakDailyTokens: number | null; longestRunningTurnSec: number | null;
    currentStreakDays: number | null; longestStreakDays: number | null; daily: Array<{ date: string; tokens: number }>;
  };
  error?: { code: string; message: string };
};

export interface AccountStatusProvider { read(force?: boolean): Promise<AccountSnapshot> }
export interface AccountGateway { request(method: string, params?: unknown): Promise<unknown> }

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const maskEmail = (value: unknown) => {
  if (typeof value !== 'string' || !value.includes('@')) return null;
  const [name, domain] = value.split('@');
  if (!name || !domain) return null;
  if (name.length < 3) return `${name[0] ?? '*'}***@${domain}`;
  return `${name[0]}${'*'.repeat(Math.min(6, name.length - 2))}${name.at(-1)}@${domain}`;
};
const quotaWindow = (value: unknown): QuotaWindow | null => {
  const raw = record(value);
  const used = finiteNumber(raw.usedPercent);
  if (used === null) return null;
  const reset = finiteNumber(raw.resetsAt);
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    windowDurationMins: finiteNumber(raw.windowDurationMins),
    resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
};

export class AccountInspector implements AccountStatusProvider {
  private cached?: { expiresAt: number; value: AccountSnapshot };
  private pending?: Promise<AccountSnapshot>;
  constructor(private gateway: AccountGateway, private cacheMs = 30_000) {}

  async read(force = false): Promise<AccountSnapshot> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return structuredClone(this.cached.value);
    if (!force && this.pending) return this.pending;
    const pending = this.inspect();
    this.pending = pending;
    try {
      const value = await pending;
      this.cached = { expiresAt: Date.now() + this.cacheMs, value };
      return structuredClone(value);
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private async inspect(): Promise<AccountSnapshot> {
    const checkedAt = new Date().toISOString();
    try {
      const [accountRaw, limitsRaw, usageRaw] = await Promise.all([
        this.gateway.request('account/read', { refreshToken: false }),
        this.gateway.request('account/rateLimits/read', { excludeResetCreditDetails: false }),
        this.gateway.request('account/usage/read', {}),
      ]);
      const accountResponse = record(accountRaw);
      const account = record(accountResponse.account);
      const authenticated = !!accountResponse.account;
      const limits = record(limitsRaw);
      const byId = record(limits.rateLimitsByLimitId);
      const rate = record(byId.codex ?? limits.rateLimits);
      const credits = record(rate.credits);
      const resetCredits = record(limits.rateLimitResetCredits);
      const usage = record(usageRaw);
      const summary = record(usage.summary);
      const daily = Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets.map(item => {
        const bucket = record(item);
        return { date: String(bucket.startDate ?? ''), tokens: finiteNumber(bucket.tokens) ?? 0 };
      }).filter(item => item.date).slice(-30) : [];
      return {
        available: true, authenticated, checkedAt,
        method: authenticated ? String(account.type ?? 'unknown') : undefined,
        email: authenticated && account.type === 'chatgpt' ? maskEmail(account.email) : null,
        plan: authenticated ? String(account.planType ?? rate.planType ?? 'unknown') : null,
        quota: {
          ordinaryUsageAllowed: typeof limits.ordinaryUsageAllowed === 'boolean' ? limits.ordinaryUsageAllowed : null,
          primary: quotaWindow(rate.primary), secondary: quotaWindow(rate.secondary),
        },
        credits: {
          hasCredits: credits.hasCredits === true, unlimited: credits.unlimited === true,
          balance: typeof credits.balance === 'string' ? credits.balance : null,
          availableResetCount: finiteNumber(resetCredits.availableCount) ?? 0,
        },
        tokenUsage: {
          lifetimeTokens: finiteNumber(summary.lifetimeTokens), peakDailyTokens: finiteNumber(summary.peakDailyTokens),
          longestRunningTurnSec: finiteNumber(summary.longestRunningTurnSec), currentStreakDays: finiteNumber(summary.currentStreakDays),
          longestStreakDays: finiteNumber(summary.longestStreakDays), daily,
        },
      };
    } catch {
      return { available: false, authenticated: false, checkedAt, error: { code: 'ACCOUNT_STATUS_UNAVAILABLE', message: 'Codex account status is temporarily unavailable.' } };
    }
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexAppServerGateway implements AccountGateway {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private id = 0;

  constructor(private options: { codexHome: string; codexPath?: string; timeoutMs?: number }) {}

  async request(method: string, params: unknown = {}): Promise<unknown> {
    await this.ensureReady();
    return this.send(method, params);
  }

  async close() {
    const child = this.child;
    this.child = undefined; this.ready = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  private async ensureReady() {
    if (!this.ready) this.ready = this.start();
    try { await this.ready; }
    catch (error) { this.ready = undefined; throw error; }
  }

  private async start() {
    const require = createRequire(import.meta.url);
    const codexPackage = require.resolve('@openai/codex/package.json');
    const defaultBin = join(dirname(codexPackage), 'bin', 'codex.js');
    const command = this.options.codexPath ?? process.execPath;
    const args = this.options.codexPath ? ['app-server', '--listen', 'stdio://'] : [defaultBin, 'app-server', '--listen', 'stdio://'];
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.options.codexHome };
    if (!env.CODEX_API_KEY) delete env.CODEX_API_KEY;
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => this.receive(line));
    child.stderr.resume();
    child.once('error', error => this.fail(error));
    child.once('close', () => this.fail(new Error('Codex app server exited.')));
    await this.send('initialize', { clientInfo: { name: 'codex-relay', title: 'CodexRelay', version: '0.1.0' }, capabilities: null }, child);
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  }

  private send(method: string, params: unknown, target = this.child): Promise<unknown> {
    if (!target?.stdin.writable) return Promise.reject(new Error('Codex app server is not available.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex app server request timed out.'));
      }, this.options.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      target.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item) { clearTimeout(item.timer); this.pending.delete(id); item.reject(error); }
      });
    });
  }

  private receive(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id !== 'number') return;
    const item = this.pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); this.pending.delete(message.id);
    if (message.error) item.reject(new Error('Codex app server rejected the request.'));
    else item.resolve(message.result);
  }

  private fail(error: Error) {
    this.child = undefined; this.ready = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
