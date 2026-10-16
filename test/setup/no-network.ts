/**
 * Vitest setup (vitest.config.ts): no test may reach a real API. Live calls spend money
 * (RULES.md), so the global `fetch` throws. Tests that need HTTP inject a fake `fetchImpl`.
 * Playwright (e2e/) does not load this file.
 */
export const NETWORK_DISABLED = 'real network disabled in tests';

const blocked: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(new Error(`${NETWORK_DISABLED}: fetch ${url}`));
};

globalThis.fetch = blocked;
