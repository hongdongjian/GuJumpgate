(function attachOutlookEmailPlusProvider(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OutlookEmailPlusProvider = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function createOutlookEmailPlusProviderModule() {
  const OUTLOOK_EMAIL_PLUS_PROVIDER = 'outlook-email-plus';
  const POOL_PROVIDER_FILTER = 'outlook';

  function normalizeEmailKey(email = '') {
    return String(email || '').trim().toLowerCase();
  }

  function getAliasUsageKey(account = {}) {
    if (!account) return '';
    if (account.accountId !== undefined && account.accountId !== null) {
      return String(account.accountId);
    }
    return normalizeEmailKey(account.email);
  }

  function ensureUsageBucket(usage, key) {
    if (!key) return null;
    if (usage[key]) return usage[key];
    usage[key] = { aliases: {}, updatedAt: 0 };
    return usage[key];
  }

  function normalizeUsage(rawUsage = {}, normalizer) {
    if (typeof normalizer === 'function') {
      return normalizer(rawUsage);
    }
    return rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage) ? { ...rawUsage } : {};
  }

  function countUsedAliases(bucket) {
    if (!bucket || !bucket.aliases) return 0;
    return Object.values(bucket.aliases).filter((entry) => entry?.used).length;
  }

  function generateTaskId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `oep-${crypto.randomUUID()}`;
    }
    return `oep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createProvider(deps = {}) {
    const {
      getState,
      setState,
      setPersistentSettings,
      broadcastDataUpdate,
      addLog,
      setEmailState,
      pool,
      buildOutlookPlusAliasEmail,
      buildOutlookPayPalAliasEmail,
      normalizeOutlookAliasMaxPerAccount,
      normalizeHotmailAliasUsage,
    } = deps;

    if (!getState || !setState || !setPersistentSettings || !pool || !buildOutlookPayPalAliasEmail) {
      throw new Error('OutlookEmailPlusProvider 缺少必要依赖。');
    }

    const log = typeof addLog === 'function' ? addLog : () => {};
    const broadcast = typeof broadcastDataUpdate === 'function' ? broadcastDataUpdate : () => {};

    function normalizeConfigFromState(state) {
      const config = state?.outlookEmailPlusConfig || {};
      return {
        serverUrl: String(config.serverUrl || '').trim(),
        apiKey: String(config.apiKey || '').trim(),
        defaultProjectKey: String(config.defaultProjectKey || '').trim(),
        callerId: String(config.callerId || '').trim() || 'GuJumpgate',
      };
    }

    function getMaxAliases(state) {
      return normalizeOutlookAliasMaxPerAccount(state?.outlookAliasMaxPerAccount);
    }

    async function persistState(patch) {
      await setPersistentSettings(patch);
      await setState(patch);
      broadcast(patch);
    }

    async function setUsageEntry(account, aliasEmail, updates) {
      const accountKey = getAliasUsageKey(account);
      const aliasKey = normalizeEmailKey(aliasEmail);
      if (!accountKey || !aliasKey) return null;
      const state = await getState();
      const usage = normalizeUsage(state.outlookEmailPlusAliasUsage, normalizeHotmailAliasUsage);
      const bucket = ensureUsageBucket(usage, accountKey);
      const previous = bucket.aliases[aliasKey] || {};
      bucket.aliases[aliasKey] = {
        email: String(aliasEmail || previous.email || '').trim(),
        used: Boolean(updates?.used ?? previous.used ?? false),
        lastCheckedAt: Number.isFinite(Number(updates?.lastCheckedAt)) ? Number(updates.lastCheckedAt) : Date.now(),
        reason: String(updates?.reason || previous.reason || '').trim(),
      };
      bucket.updatedAt = Date.now();
      const nextUsage = { ...usage, [accountKey]: bucket };
      await persistState({ outlookEmailPlusAliasUsage: nextUsage });
      return bucket.aliases[aliasKey];
    }

    async function claimNewBaseEmail(config) {
      const taskId = generateTaskId();
      const account = await pool.claimRandomEmail(config, {
        taskId,
        projectKey: config.defaultProjectKey,
        callerId: config.callerId,
        provider: POOL_PROVIDER_FILTER,
      });
      if (!account?.email || !account?.claimToken) {
        throw new Error('outlookEmailPlus 服务端未返回完整的邮箱信息。');
      }
      await persistState({ outlookEmailPlusAccount: account });
      log(`outlookEmailPlus：已申领基础邮箱 ${account.email}（account_id=${account.accountId}）。`, 'info');
      return account;
    }

    async function finalizeCurrentAccount(result = 'success', detail = '') {
      const state = await getState();
      const account = state?.outlookEmailPlusAccount;
      if (!account?.accountId || !account?.claimToken) {
        return null;
      }
      const config = normalizeConfigFromState(state);
      try {
        await pool.claimComplete(config, account, result, detail);
        log(`outlookEmailPlus：已上报 ${account.email} 任务结果 ${result}。`, 'info');
      } catch (error) {
        log(`outlookEmailPlus：上报 ${account.email} 任务结果失败：${error?.message || error}`, 'warn');
      }
      await persistState({ outlookEmailPlusAccount: null });
      return account;
    }

    async function releaseCurrentAccount(reason = '') {
      const state = await getState();
      const account = state?.outlookEmailPlusAccount;
      if (!account?.accountId || !account?.claimToken) {
        return null;
      }
      const config = normalizeConfigFromState(state);
      try {
        await pool.claimRelease(config, account, reason);
        log(`outlookEmailPlus：已释放 ${account.email}（${reason || '无原因'}）。`, 'info');
      } catch (error) {
        log(`outlookEmailPlus：释放 ${account.email} 失败：${error?.message || error}`, 'warn');
      }
      await persistState({ outlookEmailPlusAccount: null });
      return account;
    }

    function isAliasCapacityExhausted(state, account) {
      if (!account) return true;
      const usage = normalizeUsage(state.outlookEmailPlusAliasUsage, normalizeHotmailAliasUsage);
      const bucket = usage[getAliasUsageKey(account)];
      return countUsedAliases(bucket) >= getMaxAliases(state);
    }

    function findUnusedAlias(state, account) {
      const usage = normalizeUsage(state.outlookEmailPlusAliasUsage, normalizeHotmailAliasUsage);
      const bucket = usage[getAliasUsageKey(account)] || { aliases: {} };
      const max = getMaxAliases(state);
      const usedKeys = new Set();
      for (const [key, entry] of Object.entries(bucket.aliases || {})) {
        if (entry?.used) usedKeys.add(key);
      }
      for (let index = 1; index <= max; index += 1) {
        const alias = buildOutlookPayPalAliasEmail(account.email, index);
        if (!alias) continue;
        const aliasKey = normalizeEmailKey(alias);
        if (!usedKeys.has(aliasKey)) {
          return alias;
        }
      }
      return '';
    }

    async function ensureEmail(options = {}) {
      const state = await getState();
      const config = normalizeConfigFromState(state);
      if (!config.serverUrl || !config.apiKey) {
        throw new Error('请先在设置面板填写 outlookEmailPlus 的服务端地址与 API Key。');
      }

      let account = state.outlookEmailPlusAccount;
      if (account && isAliasCapacityExhausted(state, account)) {
        log(`outlookEmailPlus：${account.email} 的别名额度已用完，提交 claim-complete 并切换。`, 'info');
        await finalizeCurrentAccount('success', '所有别名已用完');
        account = null;
      }
      if (!account) {
        account = await claimNewBaseEmail(config);
      }

      let alias = findUnusedAlias(await getState(), account);
      if (!alias) {
        log(`outlookEmailPlus：${account.email} 在本次扫描中未找到可用别名，触发再次切换。`, 'warn');
        await finalizeCurrentAccount('success', '所有别名已用完');
        account = await claimNewBaseEmail(config);
        alias = findUnusedAlias(await getState(), account);
        if (!alias) {
          throw new Error('outlookEmailPlus 无法分配可用别名，请检查上限设置。');
        }
      }

      await setUsageEntry(account, alias, { used: false, reason: 'allocated' });
      if (typeof setEmailState === 'function') {
        await setEmailState(alias, { source: 'generated:outlook-email-plus' });
      }
      return {
        account,
        email: alias,
        registrationAliasEmail: alias,
      };
    }

    async function markAliasUsed(aliasEmail, reason = 'registered') {
      const state = await getState();
      const account = state.outlookEmailPlusAccount;
      if (!account) return null;
      return setUsageEntry(account, aliasEmail, { used: true, reason });
    }

    async function resetPool() {
      await persistState({
        outlookEmailPlusAccount: null,
        outlookEmailPlusAliasUsage: {},
      });
    }

    async function fetchVerificationCode(aliasEmail, options = {}) {
      const state = await getState();
      const config = normalizeConfigFromState(state);
      return pool.fetchVerificationCode(config, aliasEmail, options);
    }

    async function pollVerificationCode(step, state, pollPayload = {}) {
      const latestState = state || await getState();
      const config = normalizeConfigFromState(latestState);
      const targetEmail = String(pollPayload?.targetEmail || latestState?.email || '').trim();
      if (!targetEmail) {
        throw new Error(`步骤 ${step}：outlookEmailPlus 缺少目标邮箱。`);
      }
      log(`步骤 ${step}：通过 outlookEmailPlus 长轮询验证码（${targetEmail}）...`, 'info');
      const timeoutMs = Math.max(15000, Number(pollPayload?.timeoutMs) || 65000);
      const sinceMinutes = Math.max(1, Math.floor(Number(pollPayload?.sinceMinutes) || 10));
      try {
        const result = await pool.fetchVerificationCode(config, targetEmail, {
          codeLength: pollPayload?.codeLength || 6,
          sinceMinutes,
          timeoutMs,
        });
        const code = String(result?.code || '').trim();
        if (!code) {
          throw new Error(`步骤 ${step}：outlookEmailPlus 未返回有效验证码。`);
        }
        log(`步骤 ${step}：outlookEmailPlus 已返回验证码：${code}`, 'ok');
        return {
          ok: true,
          code,
          emailTimestamp: Date.now(),
          mailId: String(result?.raw?.message_id || result?.raw?.id || '').trim(),
        };
      } catch (error) {
        log(`步骤 ${step}：outlookEmailPlus 验证码轮询失败：${error?.message || error}`, 'warn');
        throw error;
      }
    }

    return {
      OUTLOOK_EMAIL_PLUS_PROVIDER,
      ensureEmail,
      fetchVerificationCode,
      finalizeCurrentAccount,
      isAliasCapacityExhausted,
      markAliasUsed,
      pollVerificationCode,
      releaseCurrentAccount,
      resetPool,
    };
  }

  return {
    OUTLOOK_EMAIL_PLUS_PROVIDER,
    POOL_PROVIDER_FILTER,
    createProvider,
  };
});
