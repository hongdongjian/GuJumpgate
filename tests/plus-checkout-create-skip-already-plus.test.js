const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const gopayUtilsSource = fs.readFileSync('gopay-utils.js', 'utf8');
const globalScope = {};
new Function('self', `${gopayUtilsSource};`)(globalScope);
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

function createExecutorWith({ createResponse, createThrow }) {
  const events = [];
  const sentMessages = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 7 };
        },
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {
      events.push({ type: 'ready' });
    },
    registerTab: async (source, tabId) => {
      events.push({ type: 'register', source, tabId });
    },
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      sentMessages.push({ tabId, source, type: message?.type });
      if (message?.type === 'CREATE_PLUS_CHECKOUT') {
        if (createThrow) throw createThrow;
        return createResponse;
      }
      return {};
    },
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => ({ id: 7, url: 'https://pay.openai.com/c/pay/hosted_cs_live' }),
  });
  return { executor, events, sentMessages };
}

test('local-sub2api-json + alreadyPlus=true 直接完成 plus-checkout-create 并跳过 checkout', async () => {
  const { executor, events } = createExecutorWith({
    createResponse: { alreadyPaid: true, alreadyPlus: true, planType: 'plus', accountId: 'acc-1', userEmail: 'a@b.com' },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' });

  const tabUpdate = events.find((e) => e.type === 'tab-update');
  assert.equal(tabUpdate, undefined, '已是 Plus 时不应跳转到 checkout URL');

  const completion = events.find((e) => e.type === 'complete');
  assert.ok(completion, '必须完成 plus-checkout-create 节点');
  assert.equal(completion.step, 'plus-checkout-create');
  assert.equal(completion.payload?.skippedDueToAlreadyPlus, true);

  const skipState = events.find(
    (e) => e.type === 'set-state' && e.payload?.plusCheckoutSource === 'skipped-already-plus'
  );
  assert.ok(skipState, '必须写入 plusCheckoutSource: skipped-already-plus');
});

test('local-cpa-json-no-rt + alreadyPlus=true 同样跳过 checkout', async () => {
  const { executor, events } = createExecutorWith({
    createResponse: { alreadyPaid: true, alreadyPlus: true, planType: 'plus' },
  });
  await executor.executePlusCheckoutCreate({ panelMode: 'local-cpa-json-no-rt' });
  const completion = events.find((e) => e.type === 'complete');
  assert.equal(completion?.payload?.skippedDueToAlreadyPlus, true);
});

test('普通 cpa 模式 alreadyPlus=true 抛错（无法跳过 checkout）', async () => {
  const { executor } = createExecutorWith({
    createResponse: { alreadyPaid: true, alreadyPlus: true, planType: 'plus' },
  });
  await assert.rejects(
    () => executor.executePlusCheckoutCreate({ panelMode: 'cpa' }),
    /已是 Plus/
  );
});

test('alreadyPaid 但非 Plus（如 pro/team）总是抛错（无法订阅 Plus）', async () => {
  const { executor } = createExecutorWith({
    createResponse: { alreadyPaid: true, alreadyPlus: false, planType: 'pro' },
  });
  await assert.rejects(
    () => executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' }),
    /已订阅其他付费计划/
  );
});

test('alreadyPaid 未返回时按常规流程继续打开 checkout', async () => {
  const { executor, events } = createExecutorWith({
    createResponse: {
      checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live',
      chatgptCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live',
      hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live',
      preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live',
      country: 'US',
      currency: 'USD',
    },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' });

  const tabUpdate = events.find((e) => e.type === 'tab-update');
  assert.ok(tabUpdate, '未跳过时应跳转 checkout URL');
  const skipped = events.find((e) => e.payload?.skippedDueToAlreadyPlus === true);
  assert.equal(skipped, undefined);
});

test('CREATE_PLUS_CHECKOUT 抛 ACCOUNT_DEACTIVATED 时透传错误并打印身份验证日志', async () => {
  const { executor, events } = createExecutorWith({
    createThrow: new Error('ACCOUNT_DEACTIVATED::account_deactivated'),
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' }),
    /ACCOUNT_DEACTIVATED::account_deactivated/
  );

  const errLog = events.find((e) => e.type === 'log' && /身份验证错误/.test(e.message) && e.level === 'error');
  assert.ok(errLog, '应输出身份验证错误日志');
});
