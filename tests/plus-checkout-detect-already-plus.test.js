const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const plusCheckoutSource = fs.readFileSync('content/plus-checkout.js', 'utf8');

function createDomHarness(html) {
  let listener = null;

  function parseSimple(rootHtml) {
    return rootHtml;
  }

  const fakeDocument = (() => {
    const elements = parseSimpleDom(html);
    const metadataNodes = html?.deactivated
      ? [{ textContent: '错误代码：account_deactivated' }]
      : [];
    const bodyText = html?.deactivated
      ? '身份验证错误 账户已被删除或停用 account_deactivated'
      : '';
    return {
      readyState: 'complete',
      body: { textContent: bodyText },
      documentElement: { getAttribute() { return null; }, setAttribute() {} },
      querySelector(selector) {
        if (selector === '[data-testid="accounts-profile-button"]') {
          return html?.hasButton === false ? null : elements.button;
        }
        return null;
      },
      querySelectorAll(selector) {
        const text = String(selector || '');
        if (text.includes('_metadataLine_') || text.includes('metadataLine')) {
          return metadataNodes;
        }
        return [];
      },
      getElementById() { return null; },
    };
  })();

  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: { href: 'https://chatgpt.com/' },
    window: {},
    document: fakeDocument,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    resetStopState() {},
    isStopError() { return false; },
    throwIfStopped() {},
    sleep() { return Promise.resolve(); },
    log() {},
    Event: class TestEvent { constructor(type) { this.type = type; } },
    MouseEvent: class TestMouseEvent { constructor(type) { this.type = type; } },
    PointerEvent: class TestPointerEvent { constructor(type) { this.type = type; } },
    CSS: { escape: (value) => String(value) },
    CodexOperationDelay: { async performOperationWithDelay(_, op) { return op(); } },
  };
  context.window = context;
  context.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

  vm.createContext(context);
  vm.runInContext(plusCheckoutSource, context);
  assert.equal(typeof listener, 'function');
  return async function send(message) {
    return await new Promise((resolve) => {
      listener(message, {}, resolve);
    });
  };
}

function parseSimpleDom({ ariaLabel = '', userName = '', planBadgeText = '', deactivated = false }) {
  const planSpans = planBadgeText
    ? [{ textContent: planBadgeText }]
    : [];
  const wrapperSpan = {
    getAttribute() { return 'auto'; },
    textContent: planBadgeText,
    querySelectorAll(selector) {
      if (selector === 'span') return planSpans;
      return [];
    },
  };
  const button = {
    getAttribute(name) {
      if (name === 'aria-label') return ariaLabel;
      return null;
    },
    textContent: `${userName} ${planBadgeText}`.trim(),
    querySelector(selector) {
      if (selector === 'span[dir="auto"] span') {
        return planSpans[0] || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'span[dir="auto"] span') return planSpans;
      if (selector === 'span[dir="auto"]') return [wrapperSpan];
      return [];
    },
  };
  return { button };
}

function makeProbe(opts) {
  return createDomHarness(opts);
}

test('badge 文本恰为 "Plus" → isPlus=true', async () => {
  const send = makeProbe({ ariaLabel: 'Karen White Plus，打开"个人资料"菜单', userName: 'Karen White', planBadgeText: 'Plus' });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.isPlus, true);
  assert.equal(result.planText, 'Plus');
});

test('用户名包含 Plus 但没有 plan badge → isPlus=false（避免假阳）', async () => {
  const send = makeProbe({ ariaLabel: 'Plus User Name，打开"个人资料"菜单', userName: 'Plus User Name', planBadgeText: '' });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.isPlus, false);
  assert.equal(result.planText, '');
});

test('badge 是 "Pro" 不是 Plus → isPlus=false', async () => {
  const send = makeProbe({ ariaLabel: 'Karen White Pro', userName: 'Karen White', planBadgeText: 'Pro' });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.isPlus, false);
  assert.equal(result.planText, 'Pro');
});

test('找不到 profile button → found=false', async () => {
  const send = createDomHarness({ hasButton: false });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.found, false);
  assert.equal(result.isPlus, false);
  assert.equal(result.accountDeactivated, false);
});

test('页面出现 account_deactivated 元信息 → accountDeactivated=true', async () => {
  const send = makeProbe({ deactivated: true });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.accountDeactivated, true);
  assert.equal(result.isPlus, false);
  assert.equal(result.errorCode, 'account_deactivated');
});

test('正常页面 → accountDeactivated=false', async () => {
  const send = makeProbe({ planBadgeText: 'Plus' });
  const result = await send({ type: 'PLUS_CHECKOUT_DETECT_ACCOUNT_PLUS', payload: { buttonWaitMs: 100, badgeWaitAfterButtonMs: 50 } });
  assert.equal(result.accountDeactivated, false);
});
