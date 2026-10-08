import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAll, main } from '../scripts/verify-tokens.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = {
  CLOUDFLARE_API_TOKEN: 'cf-token-secret',
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  NOTION_TOKEN: 'notion-token-secret',
  NOTION_DATA_SOURCE_ID: 'ds-456',
  BUTTONDOWN_API_KEY: 'bd-key-secret',
  SPIRAL_TOKEN: 'spiral-key-secret',
};

// R7: every fetch is mocked; an unmocked URL fails loudly instead of hitting network.
function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body ?? null });
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
  ['data_sources', () => res(200, { results: [] })],
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
  const ds = call('data_sources');
  assert.equal(ds.method, 'POST');
  assert.ok(ds.url.includes('/data_sources/ds-456/query'));
  assert.equal(ds.headers.Authorization, 'Bearer notion-token-secret');
  assert.deepEqual(JSON.parse(ds.body), { page_size: 1 });
  assert.equal(call('subscribers').headers.Authorization, 'Token bd-key-secret');
  const spiral = call('session-quota');
  assert.ok(spiral.url.startsWith('https://api.writewithspiral.com/api/v1/billing/'));
  assert.equal(spiral.headers.Authorization, 'Bearer spiral-key-secret'); // repo secret name: SPIRAL_TOKEN
  assert.equal(calls.length, 6); // cf verify+accounts, notion users/me+query, buttondown, spiral; unset optionals add none
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
  assert.equal(r.results.find(x => x.service === 'SPIRAL_TOKEN').verdict, 'ok');
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

test('thrown fetch reports error verdict under the canonical service key', async () => {
  const throwing = async (url) => { if (String(url).includes('session-quota')) throw new TypeError('fetch failed'); return res(200, {}); };
  const r = await verifyAll({ env: { ...env }, fetch: throwing });
  const spiral = r.results.find(x => x.service === 'SPIRAL_TOKEN');
  assert.ok(spiral, 'no result under canonical SPIRAL_TOKEN key');
  assert.equal(spiral.verdict, 'error');
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


// Adversarial-pass gap: a regression that stops the CLI entry guard from firing keeps the
// whole mocked suite green while the workflow gate exits 0 having checked nothing. Spawn the
// script as a real process with no env: every required check is 'missing', so main() must
// log FAILED and exit 1. (POSIX-representative; the Windows argv[1] idiom swap is owner-gated.)
test('CLI entry guard fires: spawned run with empty env exits 1 with FAILED line', () => {
  const { status, stdout } = spawnSync(process.execPath, ['scripts/verify-tokens.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {},
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(status, 1);
  assert.ok(stdout.includes('[verify-tokens] FAILED'), 'expected FAILED line, got: ' + stdout.slice(0, 400));
});

