(function attachOutlookEmailPlusManager(globalScope) {
  function createOutlookEmailPlusManager(context = {}) {
    const {
      state,
      dom,
      helpers,
      runtime,
      constants = {},
    } = context;

    const displayTimeZone = constants.displayTimeZone || 'Asia/Shanghai';
    let listExpanded = false;
    let actionInFlight = false;
    const expandedStorageKey = 'multipage-oep-used-list-expanded';

    function getUsedEmailEntries(currentState = state.getLatestState()) {
      const usedEmails = currentState?.outlookEmailPlusUsedEmails || {};
      return Object.values(usedEmails).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    }

    function formatDateTime(timestamp) {
      const value = Number(timestamp);
      if (!Number.isFinite(value) || value <= 0) {
        return '—';
      }
      return new Date(value).toLocaleString('zh-CN', {
        hour12: false,
        timeZone: displayTimeZone,
      });
    }

    function getSourceLabel(source) {
      return source === 'manual' ? '手动' : '自动';
    }

    function getReasonLabel(reason) {
      const map = {
        submitted: '提交',
        flow_completed: '流程完成',
        manual: '手动添加',
        registered: '注册',
      };
      return map[reason] || reason || '—';
    }

    function updateListViewport(entries) {
      const count = entries.length;
      if (dom.btnToggleOepUsedList) {
        dom.btnToggleOepUsedList.textContent = `${listExpanded ? '收起列表' : '展开列表'}（${count}）`;
        dom.btnToggleOepUsedList.setAttribute('aria-expanded', String(listExpanded));
      }
      if (dom.btnClearOepUsedEmails) {
        dom.btnClearOepUsedEmails.disabled = count === 0;
      }
      if (dom.oepUsedListShell) {
        dom.oepUsedListShell.classList.toggle('is-expanded', listExpanded);
        dom.oepUsedListShell.classList.toggle('is-collapsed', !listExpanded);
      }
    }

    function setListExpanded(expanded, options = {}) {
      const { persist = true } = options;
      listExpanded = Boolean(expanded);
      if (persist) {
        localStorage.setItem(expandedStorageKey, listExpanded ? '1' : '0');
      }
      renderUsedEmails();
    }

    function initExpandedState() {
      const saved = localStorage.getItem(expandedStorageKey);
      setListExpanded(saved === '1', { persist: false });
    }

    function renderUsedEmails(currentState = state.getLatestState()) {
      if (!dom.oepUsedEmailsList) return;
      const entries = getUsedEmailEntries(currentState);
      updateListViewport(entries);

      if (!entries.length) {
        dom.oepUsedEmailsList.innerHTML = '<div class="hotmail-empty">还没有已使用邮箱记录。</div>';
        return;
      }

      dom.oepUsedEmailsList.innerHTML = entries.map((entry) => `
        <div class="hotmail-account-item">
          <div class="hotmail-account-top">
            <div class="hotmail-account-title-row">
              <div class="hotmail-account-email">${helpers.escapeHtml(entry.email || '')}</div>
              <button
                class="hotmail-copy-btn"
                type="button"
                data-oep-action="copy"
                data-oep-email="${helpers.escapeHtml(entry.email || '')}"
                title="复制邮箱"
              >⎘</button>
            </div>
          </div>
          <div class="hotmail-account-meta">
            <span>使用时间：${helpers.escapeHtml(formatDateTime(entry.usedAt))}</span>
            <span>来源：${helpers.escapeHtml(getSourceLabel(entry.source))}</span>
            <span>原因：${helpers.escapeHtml(getReasonLabel(entry.reason))}</span>
          </div>
          <div class="hotmail-account-actions">
            <button class="btn btn-ghost btn-sm" type="button"
              data-oep-action="delete"
              data-oep-email="${helpers.escapeHtml(entry.email || '')}">删除</button>
          </div>
        </div>
      `).join('');
    }

    async function handleAddEmail() {
      if (actionInFlight) return;
      const email = (dom.inputOepAddUsedEmail?.value || '').trim().toLowerCase();
      if (!email) {
        helpers.showToast('请先输入邮箱地址。', 'warn');
        return;
      }

      actionInFlight = true;
      if (dom.btnOepAddUsedEmail) dom.btnOepAddUsedEmail.disabled = true;
      try {
        const response = await runtime.sendMessage({
          type: 'ADD_OUTLOOK_EMAIL_PLUS_USED_EMAIL',
          source: 'sidepanel',
          payload: { email },
        });
        if (response?.error) throw new Error(response.error);
        if (dom.inputOepAddUsedEmail) dom.inputOepAddUsedEmail.value = '';
        helpers.showToast(`已添加 ${email}`, 'success', 1800);
      } catch (err) {
        helpers.showToast(`添加失败：${err.message}`, 'error');
      } finally {
        actionInFlight = false;
        if (dom.btnOepAddUsedEmail) dom.btnOepAddUsedEmail.disabled = false;
      }
    }

    async function handleClearAll() {
      if (actionInFlight) return;
      const entries = getUsedEmailEntries();
      if (!entries.length) {
        helpers.showToast('没有记录可清空。', 'warn');
        return;
      }

      const confirmed = await helpers.openConfirmModal({
        title: '清空已使用邮箱',
        message: `确认清空全部 ${entries.length} 条已使用邮箱记录吗？`,
        confirmLabel: '确认清空',
        confirmVariant: 'btn-danger',
      });
      if (!confirmed) return;

      actionInFlight = true;
      if (dom.btnClearOepUsedEmails) dom.btnClearOepUsedEmails.disabled = true;
      try {
        const response = await runtime.sendMessage({
          type: 'CLEAR_OUTLOOK_EMAIL_PLUS_USED_EMAILS',
          source: 'sidepanel',
          payload: {},
        });
        if (response?.error) throw new Error(response.error);
        helpers.showToast('已使用邮箱列表已清空。', 'success', 1800);
      } catch (err) {
        helpers.showToast(`清空失败：${err.message}`, 'error');
      } finally {
        actionInFlight = false;
      }
    }

    async function handleListClick(event) {
      const btn = event.target.closest('[data-oep-action]');
      if (!btn || actionInFlight) return;

      const action = btn.dataset.oepAction;
      const email = btn.dataset.oepEmail;

      actionInFlight = true;
      btn.disabled = true;
      try {
        if (action === 'copy') {
          await helpers.copyTextToClipboard(email);
          helpers.showToast(`已复制 ${email}`, 'success', 1800);
        } else if (action === 'delete') {
          const response = await runtime.sendMessage({
            type: 'REMOVE_OUTLOOK_EMAIL_PLUS_USED_EMAIL',
            source: 'sidepanel',
            payload: { email },
          });
          if (response?.error) throw new Error(response.error);
          helpers.showToast(`已删除 ${email}`, 'success', 1600);
        }
      } catch (err) {
        helpers.showToast(err.message, 'error');
      } finally {
        actionInFlight = false;
        btn.disabled = false;
      }
    }

    function bindEvents() {
      dom.btnToggleOepUsedList?.addEventListener('click', () => {
        setListExpanded(!listExpanded);
      });

      dom.btnClearOepUsedEmails?.addEventListener('click', async () => {
        try {
          await handleClearAll();
        } catch (err) {
          helpers.showToast(err.message, 'error');
        }
      });

      dom.btnOepAddUsedEmail?.addEventListener('click', handleAddEmail);

      dom.inputOepAddUsedEmail?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          handleAddEmail();
        }
      });

      dom.oepUsedEmailsList?.addEventListener('click', handleListClick);
    }

    return {
      bindEvents,
      initExpandedState,
      renderUsedEmails,
    };
  }

  globalScope.OutlookEmailPlusManager = {
    createOutlookEmailPlusManager,
  };
})(window);
