const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/paypal-flow.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }
  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') parenDepth += 1;
    else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) signatureEnded = true;
    } else if (char === '{' && signatureEnded) {
      braceStart = index;
      break;
    }
  }
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

function buildCardErrorBanner({ key = 'pageLevelError.cardGenericError', text = "We weren't able to add this card." } = {}) {
  const messageEl = {
    tag: 'p',
    textContent: text,
    getAttribute(name) {
      if (name === 'data-error-key') return key;
      return null;
    },
  };
  const container = {
    id: 'page-level-error-message',
    textContent: text,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 400, height: 40 }),
    getAttribute(name) {
      if (name === 'data-testid') return 'page-level-error-container';
      return null;
    },
    querySelector(selector) {
      if (selector.includes('data-error-key')) return messageEl;
      if (selector.includes('page-level-error-message')) return messageEl;
      return messageEl;
    },
    remove() {
      container.removed = true;
    },
    removed: false,
  };
  return container;
}

function createCardErrorApi({ banner = null } = {}) {
  const document = {
    documentElement: {},
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (banner && (selector.includes('page-level-error-message') || selector.includes('page-level-error-container'))) {
        return [banner];
      }
      return [];
    },
  };
  const window = {
    getComputedStyle(el) {
      return el?.style || { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  return new Function('document', 'window', `
${extractFunction('isVisibleElement')}
${extractFunction('normalizeText')}
${extractFunction('findHostedPageLevelCardError')}
return { findHostedPageLevelCardError };
`)(document, window);
}

function createGuestCheckoutApi({ banner = null, rootScope = {} } = {}) {
  const document = {
    documentElement: {},
    body: { innerText: '' },
    getElementById: () => null,
    querySelectorAll(selector) {
      if (banner && (selector.includes('page-level-error-message') || selector.includes('page-level-error-container'))) {
        return [banner];
      }
      return [];
    },
  };
  const window = rootScope;
  let setTimeoutCalls = 0;
  const sandbox = {
    document,
    window,
    setTimeout: () => { setTimeoutCalls += 1; },
    PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT: 'guest_checkout',
    PAYPAL_HOSTED_DEFAULT_PHONE: '1234567890',
    PAYPAL_HOSTED_GUEST_SUBMIT_SENTINEL: '__SENTINEL__',
    PAYPAL_HOSTED_GUEST_SUBMIT_GENERATION: '__GEN__',
    PAYPAL_HOSTED_GUEST_SUBMIT_INFLIGHT: '__INFLIGHT__',
    waitForDocumentComplete: async () => {},
    throwIfStopped: () => {},
    isStopError: () => false,
    log: () => {},
    normalizeText: (v) => String(v || '').replace(/\s+/g, ' ').trim(),
    findHostedPageLevelCardError: () => {
      if (!banner) return null;
      return { element: banner, errorKey: 'pageLevelError.cardGenericError', text: banner.textContent };
    },
    sleep: async () => {},
    buildHostedVisaCard: () => ({ number: '4111000000000000', expiry: '12 / 30', cvv: '123' }),
    buildHostedRandomEmail: () => 'fallback@example.com',
    buildHostedRandomPassword: () => 'Fallback1!',
    fillHostedInputById: () => true,
    selectHostedOptionByIdText: () => true,
    hasHostedVerificationInputs: () => false,
    startHostedCaptchaCleanupObserver: () => {},
    removeHostedCaptchaArtifacts: () => {},
    clickHostedGenericSubmitButton: async () => ({ clicked: true }),
    getSetTimeoutCalls: () => setTimeoutCalls,
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    `
${extractFunction('fillHostedGuestCheckout')}
return { fillHostedGuestCheckout };
`
  );
  const api = fn(...Object.values(sandbox));
  return { ...api, getSetTimeoutCalls: sandbox.getSetTimeoutCalls };
}

test('findHostedPageLevelCardError detects cardGenericError banner', () => {
  const banner = buildCardErrorBanner();
  const { findHostedPageLevelCardError } = createCardErrorApi({ banner });
  const result = findHostedPageLevelCardError();
  assert.ok(result, 'expected card error to be detected');
  assert.equal(result.errorKey, 'pageLevelError.cardGenericError');
  assert.match(result.text, /add this card/i);
});

test('findHostedPageLevelCardError returns null when no banner present', () => {
  const { findHostedPageLevelCardError } = createCardErrorApi({ banner: null });
  assert.equal(findHostedPageLevelCardError(), null);
});

test('fillHostedGuestCheckout returns cardRefreshRequested and skips submission on first card error', async () => {
  const banner = buildCardErrorBanner();
  const rootScope = { __SENTINEL__: true, __GEN__: 0, __INFLIGHT__: 7 };
  const { fillHostedGuestCheckout, getSetTimeoutCalls } = createGuestCheckoutApi({ banner, rootScope });
  const result = await fillHostedGuestCheckout({});
  assert.equal(result.cardRefreshRequested, true);
  assert.equal(result.cardErrorDetected, true);
  assert.equal(result.submitted, false);
  assert.equal(rootScope.__SENTINEL__, false, 'sentinel must be reset to allow next call');
  assert.equal(rootScope.__GEN__, 1, 'generation must be incremented to invalidate old submissions');
  assert.equal(rootScope.__INFLIGHT__, null, 'inflight must be cleared');
  assert.equal(getSetTimeoutCalls(), 0, 'no submission setTimeout should be scheduled');
});

test('fillHostedGuestCheckout proceeds to submit when cardRefreshed flag is set', async () => {
  const banner = buildCardErrorBanner();
  const rootScope = { __SENTINEL__: false, __GEN__: 5, __INFLIGHT__: null };
  const { fillHostedGuestCheckout, getSetTimeoutCalls } = createGuestCheckoutApi({ banner, rootScope });
  const result = await fillHostedGuestCheckout({
    cardRefreshed: true,
    cardNumber: '4147999988887777',
    cardExpiry: '11 / 31',
    cardCvv: '321',
    address: { street: '1 St', city: 'NYC', state: 'New York', zip: '10001' },
  });
  assert.equal(result.submitted, true);
  assert.equal(result.stage, 'guest_checkout');
  assert.equal(rootScope.__SENTINEL__, true, 'sentinel should be set after scheduling submission');
  assert.equal(rootScope.__GEN__, 6, 'generation should be bumped when retrying after refresh');
  assert.equal(rootScope.__INFLIGHT__, 6, 'inflight should track the new generation');
  assert.equal(getSetTimeoutCalls(), 1, 'submission setTimeout should be scheduled exactly once');
  assert.equal(banner.removed, true, 'banner should be removed before refilling with the refreshed card');
});
