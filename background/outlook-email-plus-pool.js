(function attachOutlookEmailPlusPool(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OutlookEmailPlusPool = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function createOutlookEmailPlusPoolModule() {
  const DEFAULT_CALLER_ID = 'GuJumpgate';
  const DEFAULT_PROJECT_KEY = 'gpt';
  const DEFAULT_ACTION_TIMEOUT_MS = 12000;
  const DEFAULT_FETCH_TIMEOUT_MS = 65000;

  function normalizeBaseUrl(rawUrl = '') {
    const input = String(rawUrl || '').trim();
    if (!input) {
      throw new Error('outlookEmailPlus 服务端地址未配置。');
    }
    const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let parsed;
    try {
      parsed = new URL(withProtocol);
    } catch {
      throw new Error('outlookEmailPlus 服务端地址格式不正确。');
    }
    return parsed.toString().replace(/\/+$/, '');
  }

  function normalizeConfig(config = {}) {
    const serverUrl = normalizeBaseUrl(config?.serverUrl);
    const apiKey = String(config?.apiKey || '').trim();
    if (!apiKey) {
      throw new Error('outlookEmailPlus API Key 未配置。');
    }
    return {
      serverUrl,
      apiKey,
      defaultProjectKey: String(config?.defaultProjectKey || '').trim() || DEFAULT_PROJECT_KEY,
      callerId: String(config?.callerId || DEFAULT_CALLER_ID).trim() || DEFAULT_CALLER_ID,
    };
  }

  function buildHeaders(apiKey, isJson = false) {
    const headers = { 'X-API-Key': apiKey };
    if (isJson) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function buildApiError(body, status) {
    const code = String(body?.code || '').trim() || `HTTP_${status}`;
    const message = String(body?.message || body?.error || '').trim()
      || (status >= 500 ? '服务端内部错误，请稍后再试' : `请求失败 (${status})`);
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.body = body;
    return error;
  }

  async function requestJson(url, init = {}, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await readJsonSafely(response);
      if (!response.ok) {
        throw buildApiError(body, response.status);
      }
      if (body && body.success === false) {
        throw buildApiError(body, response.status);
      }
      return body;
    } catch (err) {
      if (err?.name === 'AbortError') {
        const wrapped = new Error('outlookEmailPlus 请求超时');
        wrapped.code = 'TIMEOUT';
        wrapped.cause = err;
        throw wrapped;
      }
      if (err?.code) {
        throw err;
      }
      const wrapped = new Error(`outlookEmailPlus 网络错误：${err?.message || err}`);
      wrapped.code = 'NETWORK_ERROR';
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getHealth(config) {
    const normalized = normalizeConfig(config);
    const url = `${normalized.serverUrl}/api/external/health`;
    const body = await requestJson(url, {
      method: 'GET',
      headers: buildHeaders(normalized.apiKey),
    });
    return body?.data || {};
  }

  async function claimRandomEmail(config, options = {}) {
    const normalized = normalizeConfig(config);
    const taskId = String(options?.taskId || '').trim();
    if (!taskId) {
      throw new Error('outlookEmailPlus claim-random 缺少 task_id。');
    }
    const payload = {
      caller_id: String(options?.callerId || normalized.callerId).trim() || DEFAULT_CALLER_ID,
      task_id: taskId,
    };
    const projectKey = String(options?.projectKey ?? normalized.defaultProjectKey ?? '').trim();
    if (projectKey) {
      payload.project_key = projectKey;
    }
    const provider = String(options?.provider || '').trim();
    if (provider) {
      payload.provider = provider;
    }
    const url = `${normalized.serverUrl}/api/external/pool/claim-random`;
    const body = await requestJson(url, {
      method: 'POST',
      headers: buildHeaders(normalized.apiKey, true),
      body: JSON.stringify(payload),
    });
    const data = body?.data || {};
    return {
      accountId: data.account_id,
      email: String(data.email || '').trim(),
      emailDomain: String(data.email_domain || '').trim(),
      claimToken: String(data.claim_token || '').trim(),
      claimedAt: String(data.claimed_at || '').trim(),
      leaseExpiresAt: String(data.lease_expires_at || '').trim(),
      callerId: payload.caller_id,
      taskId: payload.task_id,
      projectKey,
    };
  }

  function buildPoolEndpointBody(account, extra = {}) {
    if (!account) {
      throw new Error('outlookEmailPlus 缺少账号上下文。');
    }
    if (!Number.isFinite(Number(account.accountId))) {
      throw new Error('outlookEmailPlus 账号 ID 无效。');
    }
    if (!account.claimToken) {
      throw new Error('outlookEmailPlus claim_token 缺失。');
    }
    if (!account.callerId || !account.taskId) {
      throw new Error('outlookEmailPlus caller_id 或 task_id 缺失。');
    }
    return {
      account_id: Number(account.accountId),
      claim_token: account.claimToken,
      caller_id: account.callerId,
      task_id: account.taskId,
      ...extra,
    };
  }

  async function claimRelease(config, account, reason = '') {
    const normalized = normalizeConfig(config);
    const url = `${normalized.serverUrl}/api/external/pool/claim-release`;
    const payload = buildPoolEndpointBody(account, reason ? { reason: String(reason) } : {});
    const body = await requestJson(url, {
      method: 'POST',
      headers: buildHeaders(normalized.apiKey, true),
      body: JSON.stringify(payload),
    });
    return body?.data || {};
  }

  async function claimComplete(config, account, result = 'success', detail = '') {
    const normalized = normalizeConfig(config);
    const url = `${normalized.serverUrl}/api/external/pool/claim-complete`;
    const extra = { result: String(result || 'success') };
    const projectKey = String(account?.projectKey ?? normalized.defaultProjectKey ?? '').trim();
    if (projectKey) {
      extra.project_key = projectKey;
    }
    if (detail) {
      extra.detail = String(detail);
    }
    const payload = buildPoolEndpointBody(account, extra);
    const body = await requestJson(url, {
      method: 'POST',
      headers: buildHeaders(normalized.apiKey, true),
      body: JSON.stringify(payload),
    });
    return body?.data || {};
  }

  async function fetchVerificationCode(config, email, options = {}) {
    const normalized = normalizeConfig(config);
    const cleanedEmail = String(email || '').trim();
    if (!cleanedEmail) {
      throw new Error('outlookEmailPlus 验证码请求缺少 email。');
    }
    const params = new URLSearchParams();
    params.set('email', cleanedEmail);
    if (options?.codeLength) params.set('code_length', String(options.codeLength));
    if (options?.codeRegex) params.set('code_regex', String(options.codeRegex));
    if (options?.codeSource) params.set('code_source', String(options.codeSource));
    if (options?.sinceMinutes) params.set('since_minutes', String(options.sinceMinutes));
    if (options?.subjectContains) params.set('subject_contains', String(options.subjectContains));
    if (options?.fromContains) params.set('from_contains', String(options.fromContains));
    const url = `${normalized.serverUrl}/api/external/verification-code?${params.toString()}`;
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
    const body = await requestJson(url, {
      method: 'GET',
      headers: buildHeaders(normalized.apiKey),
    }, timeoutMs);
    const data = body?.data || {};
    const code = String(data.verification_code || data.code || '').trim();
    return {
      code,
      raw: data,
    };
  }

  return {
    DEFAULT_ACTION_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
    DEFAULT_PROJECT_KEY,
    claimComplete,
    claimRandomEmail,
    claimRelease,
    fetchVerificationCode,
    getHealth,
    normalizeBaseUrl,
    normalizeConfig,
  };
});
