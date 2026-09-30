import { describe, expect, it } from 'vitest';
import { AccountInspector, CodexLoginManager, type AccountGateway, type AccountLoginGateway } from '../src/account.js';

const responses: Record<string, unknown> = {
  'account/read': {
    account: { type: 'chatgpt', email: 'operator@example.com', planType: 'pro' },
    // The current app-server can report this capability flag even with a concrete account.
    requiresOpenaiAuth: true,
  },
  'account/rateLimits/read': {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex', planType: 'pro', normalModelSlug: null,
      primary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1790724263 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null, spendControlReached: false, rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    accountId: 'must-not-leak', rateLimitUpsell: null,
  },
  'account/usage/read': {
    summary: { lifetimeTokens: 1200, peakDailyTokens: 700, longestRunningTurnSec: 40, currentStreakDays: 2, longestStreakDays: 3 },
    dailyUsageBuckets: [{ startDate: '2026-09-23', tokens: 450 }],
  },
};

describe('Codex account inspection', () => {
  it('returns a sanitized ChatGPT account and quota snapshot', async () => {
    const gateway: AccountGateway = { request: async method => responses[method] };
    const snapshot = await new AccountInspector(gateway).read(true);
    expect(snapshot).toMatchObject({
      available: true, authenticated: true, method: 'chatgpt', email: 'o******r@example.com', plan: 'pro',
      quota: { ordinaryUsageAllowed: true, primary: { usedPercent: 37, remainingPercent: 63, windowDurationMins: 10080 } },
      credits: { balance: '0', availableResetCount: 2 },
      tokenUsage: { lifetimeTokens: 1200, daily: [{ date: '2026-09-23', tokens: 450 }] },
    });
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak');
  });

  it('degrades without throwing when account inspection is unavailable', async () => {
    const gateway: AccountGateway = { request: async () => { throw new Error('private transport detail'); } };
    await expect(new AccountInspector(gateway).read()).resolves.toMatchObject({
      available: false, authenticated: false,
      error: { code: 'ACCOUNT_STATUS_UNAVAILABLE', message: 'Codex account status is temporarily unavailable.' },
    });
  });

  it('caches ordinary reads but allows a forced refresh', async () => {
    let calls = 0;
    const gateway: AccountGateway = { request: async method => { calls++; return responses[method]; } };
    const inspector = new AccountInspector(gateway, 60_000);
    await inspector.read();
    await inspector.read();
    expect(calls).toBe(3);
    await inspector.read(true);
    expect(calls).toBe(6);
  });

  it('reports an unsigned-in app server without requiring quota requests', async () => {
    const methods: string[] = [];
    const gateway: AccountGateway = { request: async method => {
      methods.push(method);
      if (method === 'account/read') return { account: null };
      throw new Error('quota requires login');
    } };
    await expect(new AccountInspector(gateway).read()).resolves.toMatchObject({ available: true, authenticated: false });
    expect(methods).toEqual(['account/read']);
  });
});

describe('Codex device login', () => {
  it('starts one device login and recognizes its completion notification', async () => {
    let notify: (method: string, params: unknown) => void = () => {};
    const methods: string[] = [];
    const gateway: AccountLoginGateway = {
      request: async (method, params) => {
        methods.push(method);
        if (method === 'account/login/start') {
          expect(params).toEqual({ type: 'chatgptDeviceCode' });
          return { type: 'chatgptDeviceCode', loginId: 'login-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device' };
        }
        return {};
      },
      subscribe: listener => { notify = listener; return () => {}; },
    };
    const inspector = new AccountInspector({ request: async () => ({ account: null }) });
    const manager = new CodexLoginManager(gateway, inspector);
    expect(await manager.start()).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device' });
    await manager.start();
    expect(methods).toEqual(['account/login/start']);
    notify('account/login/completed', { loginId: 'other', success: true });
    expect(manager.status().status).toBe('pending');
    notify('account/login/completed', { loginId: 'login-1', success: true });
    expect(manager.status()).toMatchObject({ status: 'succeeded' });
    expect(manager.status()).not.toHaveProperty('userCode');
    manager.close();
  });

  it('reports start failures and cancels pending authorization', async () => {
    let fail = true;
    const methods: string[] = [];
    const gateway: AccountLoginGateway = {
      request: async method => {
        methods.push(method);
        if (fail) throw new Error('private auth network detail');
        return method === 'account/login/start'
          ? { type: 'chatgptDeviceCode', loginId: 'login-2', userCode: 'CODE', verificationUrl: 'https://auth.openai.com/codex/device' }
          : {};
      },
      subscribe: () => () => {},
    };
    const manager = new CodexLoginManager(gateway);
    await expect(manager.start()).rejects.toMatchObject({ code: 'CODEX_LOGIN_UNAVAILABLE', httpStatus: 503 });
    expect(JSON.stringify(manager.status())).not.toContain('private auth network detail');
    fail = false;
    await manager.start();
    expect(await manager.cancel()).toMatchObject({ status: 'idle' });
    expect(methods).toContain('account/login/cancel');
    manager.close();
  });
});
