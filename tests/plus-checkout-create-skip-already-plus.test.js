const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const gopayUtilsSource = fs.readFileSync('gopay-utils.js', 'utf8');
const globalScope = {};
new Function('self', `${gopayUtilsSource};`)(globalScope);
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

function createExecutorWith({ detectResponse }) {
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
      if (message?.type === 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS') {
        return detectResponse;
      }
      return {
        checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live',
        chatgptCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live',
        hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live',
        preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live',
        country: 'US',
        currency: 'USD',
      };
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

test('local-sub2api-json + isPlus=true 直接完成 plus-checkout-create 并跳过 checkout 创建', async () => {
  const { executor, events, sentMessages } = createExecutorWith({
    detectResponse: { found: true, isPlus: true, planText: 'Plus', ariaLabel: 'Karen White Plus' },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' });

  const detectCalls = sentMessages.filter((m) => m.type === 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS');
  assert.equal(detectCalls.length, 1, '应该发送一次 Plus 探测消息');

  const createCalls = sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT');
  assert.equal(createCalls.length, 0, '已是 Plus 时不应继续创建 checkout');

  const tabUpdate = events.find((e) => e.type === 'tab-update');
  assert.equal(tabUpdate, undefined, '已是 Plus 时不应再跳转到 checkout URL');

  const completion = events.find((e) => e.type === 'complete');
  assert.ok(completion, '必须完成 plus-checkout-create 节点');
  assert.equal(completion.step, 'plus-checkout-create');
  assert.equal(completion.payload?.skippedDueToAlreadyPlus, true);

  const skipState = events.find(
    (e) => e.type === 'set-state' && e.payload?.plusCheckoutSource === 'skipped-already-plus'
  );
  assert.ok(skipState, '必须写入 plusCheckoutSource: skipped-already-plus');
});

test('local-cpa-json-no-rt + isPlus=true 同样跳过 checkout', async () => {
  const { executor, sentMessages, events } = createExecutorWith({
    detectResponse: { found: true, isPlus: true, planText: 'Plus' },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-cpa-json-no-rt' });

  assert.equal(sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT').length, 0);
  const completion = events.find((e) => e.type === 'complete');
  assert.equal(completion?.payload?.skippedDueToAlreadyPlus, true);
});

test('普通 cpa 模式即使 isPlus=true 也不跳过 checkout，仍发起探测但按常规流程继续', async () => {
  const { executor, sentMessages, events } = createExecutorWith({
    detectResponse: { found: true, isPlus: true, planText: 'Plus' },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'cpa' });

  const detectCalls = sentMessages.filter((m) => m.type === 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS');
  assert.equal(detectCalls.length, 1, '探测仍应发起（用于 deactivated 检查）');

  const createCalls = sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT');
  assert.equal(createCalls.length, 1, '应继续走常规 checkout 创建');

  const completion = events.find((e) => e.type === 'complete');
  assert.equal(completion?.payload?.skippedDueToAlreadyPlus, undefined);
});

test('isPlus=false 时按常规流程继续，不跳过 checkout', async () => {
  const { executor, sentMessages, events } = createExecutorWith({
    detectResponse: { found: true, isPlus: false },
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' });

  const detectCalls = sentMessages.filter((m) => m.type === 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS');
  assert.equal(detectCalls.length, 1);

  const createCalls = sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT');
  assert.equal(createCalls.length, 1, '未检测到 Plus 时应继续创建 checkout');

  const skipped = events.find((e) => e.payload?.skippedDueToAlreadyPlus === true);
  assert.equal(skipped, undefined);
});

test('探测调用抛错时按常规流程继续（不中断）', async () => {
  const events = [];
  const sentMessages = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async () => ({ id: 9 }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      sentMessages.push({ type: message?.type });
      if (message?.type === 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS') {
        throw new Error('content script unavailable');
      }
      return {
        preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live',
        country: 'US',
        currency: 'USD',
      };
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => ({ id: 9, url: 'https://pay.openai.com/c/pay/hosted_cs_live' }),
  });

  await executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' });

  assert.equal(sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT').length, 1);
  const warnLog = events.find(
    (e) => e.type === 'log' && /账号状态探测失败/.test(e.message) && e.level === 'warn'
  );
  assert.ok(warnLog, '应输出探测失败 warn 日志');
});

test('检测到 account_deactivated 应抛错并不调用 CREATE_PLUS_CHECKOUT', async () => {
  const { executor, sentMessages, events } = createExecutorWith({
    detectResponse: { found: true, accountDeactivated: true, errorCode: 'account_deactivated', isPlus: false },
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({ panelMode: 'local-sub2api-json' }),
    /ACCOUNT_DEACTIVATED::account_deactivated/
  );

  assert.equal(sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT').length, 0, '不应继续创建 checkout');
  const completion = events.find((e) => e.type === 'complete');
  assert.equal(completion, undefined, '不应完成 plus-checkout-create');
  const errLog = events.find((e) => e.type === 'log' && /身份验证错误/.test(e.message));
  assert.ok(errLog, '应记录身份验证错误日志');
});

test('检测到 deactivated 在普通 cpa 模式同样抛错', async () => {
  const { executor, sentMessages } = createExecutorWith({
    detectResponse: { found: true, accountDeactivated: true, errorCode: 'account_deactivated' },
  });
  await assert.rejects(
    () => executor.executePlusCheckoutCreate({ panelMode: 'cpa' }),
    /ACCOUNT_DEACTIVATED/
  );
  assert.equal(sentMessages.filter((m) => m.type === 'CREATE_PLUS_CHECKOUT').length, 0);
});
