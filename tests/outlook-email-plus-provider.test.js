const test = require('node:test');
const assert = require('node:assert/strict');

require('../background/outlook-email-plus-provider.js');
const { createProvider } = globalThis.OutlookEmailPlusProvider;

function makeStateBag(initial = {}) {
  let state = { ...initial };
  return {
    getState: async () => state,
    setState: async (patch) => {
      state = { ...state, ...patch };
    },
    setPersistentSettings: async () => {},
    snapshot: () => state,
  };
}

function buildOutlookPayPalAliasEmail(baseEmail, index) {
  if (!baseEmail) return '';
  const [local, domain] = String(baseEmail).split('@');
  if (!local || !domain) return '';
  const n = Math.max(1, Math.floor(Number(index) || 1));
  return `${local}+PayPal${n}@${domain}`;
}

function normalizeOutlookAliasMaxPerAccount(value) {
  const numeric = Math.floor(Number(value) || 0);
  return numeric > 0 ? Math.min(numeric, 50) : 5;
}

function normalizeOutlookEmailPlusUsedEmails(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const email = String(rawEntry?.email || rawKey || '').trim().toLowerCase();
    if (!email) continue;
    normalized[email] = {
      email,
      usedAt: Number.isFinite(Number(rawEntry?.usedAt)) ? Number(rawEntry.usedAt) : 0,
      reason: String(rawEntry?.reason || '').trim(),
      source: String(rawEntry?.source || 'auto').trim(),
    };
  }
  return normalized;
}

function makeProvider({ initialState = {}, claimResults = [] } = {}) {
  const bag = makeStateBag(initialState);
  const claims = [...claimResults];
  const completed = [];
  const released = [];
  const pool = {
    claimRandomEmail: async () => {
      if (!claims.length) throw new Error('no claim mock');
      return claims.shift();
    },
    claimComplete: async (config, account, result, detail) => {
      completed.push({ account, result, detail });
      return {};
    },
    claimRelease: async (config, account, reason) => {
      released.push({ account, reason });
      return {};
    },
    fetchVerificationCode: async () => ({ code: '', raw: {} }),
  };
  const provider = createProvider({
    getState: bag.getState,
    setState: bag.setState,
    setPersistentSettings: bag.setPersistentSettings,
    broadcastDataUpdate: () => {},
    addLog: () => {},
    setEmailState: async () => {},
    pool,
    buildOutlookPayPalAliasEmail,
    normalizeOutlookAliasMaxPerAccount,
    normalizeOutlookEmailPlusUsedEmails,
  });
  return { provider, bag, completed, released };
}

const baseConfig = {
  outlookEmailPlusConfig: {
    serverUrl: 'https://api.example.com',
    apiKey: 'k',
    defaultProjectKey: 'gpt',
    callerId: 'GuJumpgate',
  },
  outlookEmailPlusUsedEmails: {},
  outlookEmailPlusAliasEnabled: true,
};

test('ensureEmail claims a new base when no current account', async () => {
  const { provider, bag } = makeProvider({
    initialState: { ...baseConfig },
    claimResults: [{ accountId: 7, email: 'foo@hotmail.com', claimToken: 'clm', callerId: 'GuJumpgate', taskId: 't1', projectKey: 'gpt' }],
  });
  const result = await provider.ensureEmail();
  assert.equal(result.email, 'foo+PayPal1@hotmail.com');
  assert.equal(result.account.accountId, 7);
  assert.equal(bag.snapshot().outlookEmailPlusAccount.email, 'foo@hotmail.com');
});

test('ensureEmail skips already-used aliases and assigns next', async () => {
  const usedEmails = {
    'foo+paypal1@hotmail.com': { email: 'foo+paypal1@hotmail.com', usedAt: 1, reason: 'registered', source: 'auto' },
    'foo+paypal2@hotmail.com': { email: 'foo+paypal2@hotmail.com', usedAt: 1, reason: 'registered', source: 'auto' },
  };
  const { provider } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusUsedEmails: usedEmails,
      outlookEmailPlusAccount: { accountId: 7, email: 'foo@hotmail.com', claimToken: 'c', callerId: 'GuJumpgate', taskId: 't' },
    },
  });
  const result = await provider.ensureEmail();
  assert.equal(result.email, 'foo+PayPal3@hotmail.com');
});

test('ensureEmail rotates to new base when aliases exhausted', async () => {
  const usedEmails = Object.fromEntries(
    [1, 2, 3, 4, 5].map((i) => {
      const k = `foo+paypal${i}@hotmail.com`;
      return [k, { email: k, usedAt: 1, reason: 'registered', source: 'auto' }];
    }),
  );
  const { provider, completed } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusUsedEmails: usedEmails,
      outlookEmailPlusAccount: { accountId: 7, email: 'foo@hotmail.com', claimToken: 'c', callerId: 'GuJumpgate', taskId: 't' },
    },
    claimResults: [{ accountId: 8, email: 'bar@hotmail.com', claimToken: 'c2', callerId: 'GuJumpgate', taskId: 't2', projectKey: 'gpt' }],
  });
  const result = await provider.ensureEmail();
  assert.equal(result.account.accountId, 8);
  assert.equal(result.email, 'bar+PayPal1@hotmail.com');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].account.accountId, 7);
  assert.equal(completed[0].result, 'success');
});

test('markAliasUsed writes email to outlookEmailPlusUsedEmails', async () => {
  const { provider, bag } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusAccount: { accountId: 9, email: 'baz@hotmail.com', claimToken: 'c', callerId: 'GuJumpgate', taskId: 't' },
    },
  });
  await provider.markAliasUsed('baz+PayPal1@hotmail.com', 'registered');
  const usedEmails = bag.snapshot().outlookEmailPlusUsedEmails;
  const entry = usedEmails['baz+paypal1@hotmail.com'];
  assert.ok(entry, '条目应存在');
  assert.equal(entry.reason, 'registered');
  assert.equal(entry.source, 'auto');
});

test('isAliasCapacityExhausted respects per-account max', async () => {
  const { provider } = makeProvider({
    initialState: { ...baseConfig, outlookAliasMaxPerAccount: 2 },
  });
  const account = { accountId: 10, email: 'x@hotmail.com' };
  const usedState = {
    outlookEmailPlusUsedEmails: {
      'x+paypal1@hotmail.com': { email: 'x+paypal1@hotmail.com', usedAt: 1, reason: 'r', source: 'auto' },
      'x+paypal2@hotmail.com': { email: 'x+paypal2@hotmail.com', usedAt: 1, reason: 'r', source: 'auto' },
    },
    outlookAliasMaxPerAccount: 2,
    outlookEmailPlusAliasEnabled: true,
  };
  assert.equal(provider.isAliasCapacityExhausted(usedState, account), true);
});

test('manual email mode 旁路 pool：ensureEmail 返回手动邮箱不调 claim', async () => {
  const { provider, bag, completed, released } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusManualEmail: 'user@example.com',
    },
  });
  const result = await provider.ensureEmail();
  assert.equal(result.email, 'user@example.com');
  assert.equal(result.manual, true);
  assert.equal(result.account, null);
  assert.equal(completed.length, 0);
  assert.equal(released.length, 0);
  assert.equal(bag.snapshot().outlookEmailPlusAccount, undefined);
});

test('manual email mode：即使遗留 pool account，markAliasUsed/finalize/release 全部 no-op', async () => {
  const staleAccount = { accountId: 99, email: 'stale@hotmail.com', claimToken: 'tok' };
  const { provider, completed, released } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusManualEmail: 'manual@example.com',
      outlookEmailPlusAccount: staleAccount,
    },
  });

  const markResult = await provider.markAliasUsed('manual@example.com', 'flow_completed');
  assert.equal(markResult, null, 'markAliasUsed 必须 no-op');

  const finalizeResult = await provider.finalizeCurrentAccount('success', 'done');
  assert.equal(finalizeResult, null, 'finalizeCurrentAccount 必须 no-op');
  assert.equal(completed.length, 0, '不应触发 claim-complete');

  const releaseResult = await provider.releaseCurrentAccount('test');
  assert.equal(releaseResult, null, 'releaseCurrentAccount 必须 no-op');
  assert.equal(released.length, 0, '不应触发 claim-release');
});

test('非 manual mode：markAliasUsed 写入 outlookEmailPlusUsedEmails', async () => {
  const account = { accountId: 11, email: 'base@hotmail.com', claimToken: 'tk' };
  const { provider, bag } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusAccount: account,
    },
  });
  const result = await provider.markAliasUsed('base+PayPal1@hotmail.com', 'registered');
  assert.ok(result, '应返回 alias entry');
  assert.equal(result.reason, 'registered');
  const usedEmails = bag.snapshot().outlookEmailPlusUsedEmails;
  assert.ok(usedEmails['base+paypal1@hotmail.com'], '应在 usedEmails 中存在');
  assert.equal(usedEmails['base+paypal1@hotmail.com'].reason, 'registered');
});

test('alias disabled：ensureEmail 使用 base 邮箱，已使用则重新领取', async () => {
  const usedEmails = {
    'first@hotmail.com': { email: 'first@hotmail.com', usedAt: 1, reason: 'registered', source: 'auto' },
  };
  const { provider, released } = makeProvider({
    initialState: {
      ...baseConfig,
      outlookEmailPlusAliasEnabled: false,
      outlookEmailPlusUsedEmails: usedEmails,
      outlookEmailPlusAccount: { accountId: 1, email: 'first@hotmail.com', claimToken: 'c1', callerId: 'GuJumpgate', taskId: 't1' },
    },
    claimResults: [
      { accountId: 2, email: 'second@hotmail.com', claimToken: 'c2', callerId: 'GuJumpgate', taskId: 't2', projectKey: 'gpt' },
    ],
  });
  const result = await provider.ensureEmail();
  assert.equal(result.email, 'second@hotmail.com');
  assert.equal(result.account.accountId, 2);
  assert.equal(released.length, 1, 'first 邮箱已使用，应触发 release');
  assert.equal(released[0].account.accountId, 1);
});

test('markEmailUsedGlobally 手动添加持久化记录', async () => {
  const { provider, bag } = makeProvider({ initialState: { ...baseConfig } });
  await provider.markEmailUsedGlobally('test@outlook.com', 'manual', 'manual');
  const usedEmails = bag.snapshot().outlookEmailPlusUsedEmails;
  assert.ok(usedEmails['test@outlook.com'], '应在 usedEmails 中存在');
  assert.equal(usedEmails['test@outlook.com'].source, 'manual');
  assert.equal(usedEmails['test@outlook.com'].reason, 'manual');
});
