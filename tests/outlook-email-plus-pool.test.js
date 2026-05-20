const test = require('node:test');
const assert = require('node:assert/strict');

const root = {};
require('../background/outlook-email-plus-pool.js');
const pool = globalThis.OutlookEmailPlusPool;

function makeFetch(handler) {
  return async function fetchStub(url, init) {
    const result = await handler(url, init);
    return {
      ok: result.ok !== false,
      status: result.status || (result.ok === false ? 500 : 200),
      json: async () => result.body,
    };
  };
}

test('normalizeBaseUrl strips trailing slashes and forces https for bare hosts', () => {
  assert.equal(pool.normalizeBaseUrl('mail.example.com'), 'https://mail.example.com');
  assert.equal(pool.normalizeBaseUrl('https://mail.example.com:20443/'), 'https://mail.example.com:20443');
});

test('normalizeConfig rejects empty url or apiKey', () => {
  assert.throws(() => pool.normalizeConfig({ serverUrl: '', apiKey: 'x' }), /服务端地址未配置/);
  assert.throws(() => pool.normalizeConfig({ serverUrl: 'https://x', apiKey: '' }), /API Key 未配置/);
});

test('claimRandomEmail posts task_id and parses returned account', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = makeFetch(async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        data: {
          account_id: 42,
          email: 'foo@example.com',
          email_domain: 'example.com',
          claim_token: 'clm_abc',
          claimed_at: '2024-01-01T00:00:00Z',
          lease_expires_at: '2024-01-01T01:00:00Z',
        },
      },
    };
  });
  try {
    const account = await pool.claimRandomEmail(
      { serverUrl: 'https://api.example.com', apiKey: 'k' },
      { taskId: 't1', projectKey: 'gpt', provider: 'outlook' },
    );
    assert.equal(account.email, 'foo@example.com');
    assert.equal(account.accountId, 42);
    assert.equal(account.claimToken, 'clm_abc');
    assert.equal(account.projectKey, 'gpt');
    assert.match(captured.url, /pool\/claim-random$/);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.task_id, 't1');
    assert.equal(body.project_key, 'gpt');
    assert.equal(body.provider, 'outlook');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestJson surfaces api errors with code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(async () => ({
    ok: false,
    status: 401,
    body: { success: false, code: 'invalid_api_key', message: 'bad key' },
  }));
  try {
    await assert.rejects(
      () => pool.claimRandomEmail(
        { serverUrl: 'https://api.example.com', apiKey: 'k' },
        { taskId: 't1' },
      ),
      (err) => err.code === 'invalid_api_key' && /bad key/.test(err.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchVerificationCode returns trimmed code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(async () => ({
    ok: true,
    status: 200,
    body: { success: true, data: { verification_code: '123456' } },
  }));
  try {
    const result = await pool.fetchVerificationCode(
      { serverUrl: 'https://api.example.com', apiKey: 'k' },
      'foo+1@example.com',
      { timeoutMs: 5000 },
    );
    assert.equal(result.code, '123456');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
