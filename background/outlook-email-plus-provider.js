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
  const MAX_CLAIM_RETRIES = 5;

  function normalizeEmailKey(email = '') {
    return String(email || '').trim().toLowerCase();
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
      buildOutlookPayPalAliasEmail,
      normalizeOutlookAliasMaxPerAccount,
      normalizeOutlookEmailPlusUsedEmails,
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
      return typeof normalizeOutlookAliasMaxPerAccount === 'function'
        ? normalizeOutlookAliasMaxPerAccount(state?.outlookAliasMaxPerAccount)
        : 5;
    }

    function isAliasEnabled(state) {
      return state?.outlookEmailPlusAliasEnabled !== false;
    }

    function getUsedEmails(state) {
      return typeof normalizeOutlookEmailPlusUsedEmails === 'function'
        ? normalizeOutlookEmailPlusUsedEmails(state?.outlookEmailPlusUsedEmails)
        : (state?.outlookEmailPlusUsedEmails || {});
    }

    function isEmailUsedGlobally(email, state) {
      const key = normalizeEmailKey(email);
      if (!key) return false;
      const usedEmails = getUsedEmails(state);
      return Boolean(usedEmails[key]);
    }

    async function persistState(patch) {
      await setPersistentSettings(patch);
      await setState(patch);
      broadcast(patch);
    }

    async function markEmailUsedGlobally(email, reason = 'auto', source = 'auto') {
      const key = normalizeEmailKey(email);
      if (!key) return null;
      const state = await getState();
      const usedEmails = getUsedEmails(state);
      const next = {
        ...usedEmails,
        [key]: {
          email: key,
          usedAt: Date.now(),
          reason: String(reason || '').trim(),
          source: String(source || 'auto').trim(),
        },
      };
      await persistState({ outlookEmailPlusUsedEmails: next });
      return next[key];
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
      if (String(state?.outlookEmailPlusManualEmail || '').trim()) {
        return null;
      }
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
      if (String(state?.outlookEmailPlusManualEmail || '').trim()) {
        return null;
      }
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

    function findUnusedAlias(state, account) {
      const max = getMaxAliases(state);
      for (let index = 1; index <= max; index += 1) {
        const alias = buildOutlookPayPalAliasEmail(account.email, index);
        if (!alias) continue;
        if (!isEmailUsedGlobally(alias, state)) {
          return alias;
        }
      }
      return '';
    }

    function isAliasCapacityExhausted(state, account) {
      if (!account) return true;
      if (!isAliasEnabled(state)) {
        return isEmailUsedGlobally(account.email, state);
      }
      return !findUnusedAlias(state, account);
    }

    async function ensureEmailWithAlias(config, state) {
      let account = state.outlookEmailPlusAccount;

      for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt += 1) {
        if (!account) {
          account = await claimNewBaseEmail(config);
        }

        const currentState = await getState();
        const alias = findUnusedAlias(currentState, account);
        if (alias) {
          if (typeof setEmailState === 'function') {
            await setEmailState(alias, { source: 'generated:outlook-email-plus' });
          }
          return { account, email: alias, registrationAliasEmail: alias };
        }

        log(`outlookEmailPlus：${account.email} 的所有别名已用完，切换到下一个基础邮箱。`, 'info');
        await finalizeCurrentAccount('success', '所有别名已用完');
        account = null;
      }

      throw new Error('outlookEmailPlus 无法分配可用别名，请检查上限设置或已使用邮箱列表。');
    }

    async function ensureEmailWithoutAlias(config, state) {
      let account = state.outlookEmailPlusAccount;

      for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt += 1) {
        if (!account) {
          account = await claimNewBaseEmail(config);
        }

        const currentState = await getState();
        if (!isEmailUsedGlobally(account.email, currentState)) {
          if (typeof setEmailState === 'function') {
            await setEmailState(account.email, { source: 'generated:outlook-email-plus' });
          }
          return { account, email: account.email, registrationAliasEmail: account.email };
        }

        log(`outlookEmailPlus：基础邮箱 ${account.email} 已使用，释放并切换。`, 'info');
        await releaseCurrentAccount('邮箱已在已使用列表中');
        account = null;
      }

      throw new Error('outlookEmailPlus 无法分配可用基础邮箱，请检查已使用邮箱列表。');
    }

    async function ensureEmail(options = {}) {
      const state = await getState();
      const manualEmail = String(state?.outlookEmailPlusManualEmail || '').trim();
      if (manualEmail) {
        log(`outlookEmailPlus：使用手动指定邮箱 ${manualEmail}（旁路 pool）。`, 'info');
        if (typeof setEmailState === 'function') {
          await setEmailState(manualEmail, { source: 'manual:outlook-email-plus' });
        }
        return {
          account: null,
          email: manualEmail,
          registrationAliasEmail: manualEmail,
          manual: true,
        };
      }

      const config = normalizeConfigFromState(state);
      if (!config.serverUrl || !config.apiKey) {
        throw new Error('请先在设置面板填写 outlookEmailPlus 的服务端地址与 API Key。');
      }

      if (isAliasEnabled(state)) {
        return ensureEmailWithAlias(config, state);
      }
      return ensureEmailWithoutAlias(config, state);
    }

    async function markAliasUsed(aliasEmail, reason = 'registered') {
      const state = await getState();
      if (String(state?.outlookEmailPlusManualEmail || '').trim()) {
        return null;
      }
      const account = state.outlookEmailPlusAccount;
      if (!account && !aliasEmail) return null;
      return markEmailUsedGlobally(aliasEmail, reason, 'auto');
    }

    async function resetPool() {
      await persistState({ outlookEmailPlusAccount: null });
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
      isEmailUsedGlobally,
      markAliasUsed,
      markEmailUsedGlobally,
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
