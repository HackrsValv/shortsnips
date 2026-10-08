import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAll, main } from '../scripts/verify-tokens.mjs';

const env = {
  CLOUDFLARE_API_TOKEN: 'cf-token-secret',
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  NOTION_TOKEN: 'notion-token-secret',
  NOTION_DATA_SOURCE_ID: 'ds-456',
  BUTTONDOWN_API_KEY: 'bd-key-secret',
  SPIRAL_API_KEY: 'spiral-key-secret',
};

// R7: every fetch is mocked; an unmocked URL fails loudly instead of hitting network.
function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    for (const [needle, respond] of routes) if (String(url).includes(needle)) return respond();
    throw new Error('unexpected fetch: ' + url);
  };
  return { fetch, calls };
}
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '<html>not json</html>' : JSON.stringify(body)) });

const happy = [
  ['tokens/verify', () => res(200, { result: { status: 'active' } })],
  ['client/v4/accounts', () => res(200, { result: [{ id: 'acct-123' }] })],
  ['users/me', () => res(200, { object: 'user' })],
  ['subscribers', () => res(200, { results: [{}] })],
  ['session-quota', () => res(200, { remaining: 7, plan_tier: 'pro' })],
];

test('all required services verify ok with correct endpoints and auth shapes', async () => {
  const { fetch, calls } = mockFetch(happy);
  const code = await main({ env: { ...env }, fetch, log: () => {} });
  assert.equal(code, 0);
  const call = needle => calls.find(c => c.url.includes(needle));
  assert.equal(call('tokens/verify').headers.Authorization, 'Bearer cf-token-secret');
  assert.equal(call('client/v4/accounts').headers.Authorization, 'Bearer cf-token-secret');
  assert.equal(call('users/me').headers.Authorization, 'Bearer notion-token-secret');
  assert.equal(call('users/me').headers['Notion-Version'], '2025-09-03');
  assert.equal(call('subscribers').headers.Authorization, 'Token bd-key-secret');
  const spiral = call('session-quota');
  assert.ok(spiral.url.startsWith('https://api.writewithspiral.com/api/v1/billing/'));
  assert.equal(spiral.headers.Authorization, 'Bearer spiral-key-secret');
  assert.equal(calls.length, 5); // one call per check; unset optionals add none
});

test('revoked Buttondown key yields invalid naming service and 401 (AE1, R3)', async () => {
  const { fetch } = mockFetch([...happy.filter(([n]) => n !== 'subscribers'), ['subscribers', () => res(401, { detail: 'bad' })]]);
  const r = await verifyAll({ env: { ...env }, fetch });
  const bd = r.results.find(x => x.service === 'BUTTONDOWN_API_KEY');
  assert.equal(bd.verdict, 'invalid');
  assert.ok(bd.detail.includes('Buttondown') && bd.detail.includes('401'));
  assert.equal(r.ok, false);
});

test('missing required secret fails closed without a network call', async () => {
  const { fetch, calls } = mockFetch([]);
  const partial = { ...env };
  delete partial.BUTTONDOWN_API_KEY;
  const r = await verifyAll({ env: partial, fetch });
  const bd = r.results.find(x => x.service === 'BUTTONDOWN_API_KEY');
  assert.equal(bd.verdict, 'missing');
  assert.equal(r.ok, false);
  assert.equal(calls.filter(c => c.url.includes('subscribers')).length, 0); // Buttondown made no call
  assert.equal(calls.length, 3); // the other three required checks each attempted their one call
});

test('unset optional secrets are skipped with exit 0 (AE2, R5)', async () => {
  const { fetch, calls } = mockFetch(happy);
  const code = await main({ env: { ...env }, fetch, log: () => {} }); // LLM_API_KEY + NOTION_WEBHOOK_SECRET unset
  assert.equal(code, 0);
  assert.equal(calls.filter(c => c.url.includes('/models')).length, 0);
  const sk = (await verifyAll({ env: { ...env }, fetch: mockFetch(happy).fetch })).results;
  assert.equal(sk.find(x => x.service === 'LLM_API_KEY').verdict, 'skipped');
  assert.equal(sk.find(x => x.service === 'NOTION_WEBHOOK_SECRET').verdict, 'skipped');
});

test('Cloudflare account absent from authorized accounts is invalid with structural reason (R1)', async () => {
  const routes = [
    ['tokens/verify', () => res(200, { result: { status: 'active' } })],
    ['client/v4/accounts', () => res(200, { result: [{ id: 'someone-else' }] })],
    ['users/me', () => res(200, {})],
    ['subscribers', () => res(200, {})],
    ['session-quota', () => res(200, {})],
  ];
  const { fetch } = mockFetch(routes);
  const r = await verifyAll({ env: { ...env }, fetch });
  const cf = r.results.find(x => x.service === 'CLOUDFLARE_API_TOKEN');
  assert.equal(cf.verdict, 'invalid');
  assert.ok(cf.detail.includes('authorized accounts'));
  assert.ok(!cf.detail.includes('acct-123')); // config ID not echoed either
});

test('Spiral 200 is ok regardless of quota fields (R4)', async () => {
  const routes = [...happy.filter(([n]) => n !== 'session-quota'), ['session-quota', () => res(200, { remaining: null, plan_tier: 'free' })]];
  const { fetch } = mockFetch(routes);
  const r = await verifyAll({ env: { ...env }, fetch });
  assert.equal(r.results.find(x => x.service === 'SPIRAL_API_KEY').verdict, 'ok');
  assert.equal(r.ok, true);
});

test('non-JSON error body still yields a named verdict (KTD4)', async () => {
  const routes = [...happy.filter(([n]) => n !== 'subscribers'), ['subscribers', () => res(502, undefined)]];
  const { fetch } = mockFetch(routes);
  const r = await verifyAll({ env: { ...env }, fetch });
  const bd = r.results.find(x => x.service === 'BUTTONDOWN_API_KEY');
  assert.equal(bd.verdict, 'error');
  assert.ok(bd.detail.includes('502') && !bd.detail.includes('not json'));
});

test('main() logs service and status only — no token material (R8)', async () => {
  const routes = [...happy.filter(([n]) => n !== 'subscribers'), ['subscribers', () => res(401, { detail: 'nope' })]];
  const { fetch } = mockFetch(routes);
  const lines = [];
  const code = await main({ env: { ...env }, fetch, log: l => lines.push(l) });
  assert.notEqual(code, 0);
  const all = lines.join('\n');
  assert.ok(all.includes('BUTTONDOWN_API_KEY') && all.includes('401'));
  for (const secret of Object.values(env)) assert.ok(!all.includes(secret), 'token material leaked: ' + secret);
});
