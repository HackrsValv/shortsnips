// Live, read-only verification of deploy credentials (plan 2026-10-08, KTD1/KTD2/KTD4).
// One free call per service; verdicts ok | invalid | error | missing | skipped; fails closed.
// Tokens come from env only and are never printed: log lines carry service + verdict + reason.

const SERVICES = {
  CLOUDFLARE_API_TOKEN: 'Cloudflare',
  NOTION_TOKEN: 'Notion',
  BUTTONDOWN_API_KEY: 'Buttondown',
  SPIRAL_TOKEN: 'Spiral',
  LLM_API_KEY: 'LLM',
  NOTION_WEBHOOK_SECRET: 'Notion webhook',
};

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

function verdict(service, verdict_, detail) {
  return { service, verdict: verdict_, detail };
}

// R8: invalid/error name the service and HTTP status (or a structural reason); never bodies or tokens.
function httpFail(service, status) {
  const kind = status >= 500 ? 'error' : 'invalid';
  return verdict(service, kind, `${SERVICES[service]}: HTTP ${status}`);
}

async function checkCloudflare(env, fetch) {
  const service = 'CLOUDFLARE_API_TOKEN';
  if (!env[service]) return verdict(service, 'missing', 'Cloudflare: not set');
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  let res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers });
  if (!res.ok) return httpFail(service, res.status);
  const verify = await readJson(res);
  if (verify?.result?.status !== 'active') return verdict(service, 'invalid', 'Cloudflare: token verify did not report active');
  res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers });
  if (!res.ok) return httpFail(service, res.status);
  const accounts = await readJson(res);
  const ids = (accounts?.result ?? []).map(a => a?.id);
  if (!ids.includes(env.CLOUDFLARE_ACCOUNT_ID)) return verdict(service, 'invalid', 'Cloudflare: account not among authorized accounts (HTTP 200)');
  return verdict(service, 'ok', 'Cloudflare: token active, account authorized');
}

async function checkNotion(env, fetch) {
  const service = 'NOTION_TOKEN';
  if (!env[service]) return verdict(service, 'missing', 'Notion: not set');
  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': env.NOTION_VERSION || '2025-09-03' };
  let res = await fetch('https://api.notion.com/v1/users/me', { headers });
  if (!res.ok) return httpFail(service, res.status);
  // R2 second half: the Worker's own query call shape (worker.js:143) proves the data source is retrievable.
  if (!env.NOTION_DATA_SOURCE_ID) return verdict(service, 'missing', 'Notion: NOTION_DATA_SOURCE_ID not set');
  res = await fetch(`https://api.notion.com/v1/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ page_size: 1 }),
  });
  if (!res.ok) return httpFail(service, res.status);
  return verdict(service, 'ok', 'Notion: users/me 200, data source retrievable');
}

async function checkButtondown(env, fetch) {
  const service = 'BUTTONDOWN_API_KEY';
  if (!env[service]) return verdict(service, 'missing', 'Buttondown: not set');
  const res = await fetch('https://api.buttondown.com/v1/subscribers?count=1', {
    headers: { Authorization: `Token ${env.BUTTONDOWN_API_KEY}` },
  });
  if (!res.ok) return httpFail(service, res.status);
  return verdict(service, 'ok', 'Buttondown: subscribers 200');
}

async function checkSpiral(env, fetch) {
  const service = 'SPIRAL_TOKEN';
  if (!env[service]) return verdict(service, 'missing', 'Spiral: not set');
  const base = env.SPIRAL_BASE_URL || 'https://api.writewithspiral.com';
  const res = await fetch(`${base}/api/v1/billing/session-quota`, {
    headers: { Authorization: `Bearer ${env.SPIRAL_TOKEN}` },
  });
  if (!res.ok) return httpFail(service, res.status);
  // R4: 200 proves the token; quota/plan fields stay the Worker's runtime concern.
  return verdict(service, 'ok', 'Spiral: session-quota 200');
}

async function checkLlm(env, fetch) {
  const service = 'LLM_API_KEY';
  if (!env.LLM_API_KEY) return verdict(service, 'skipped', 'LLM: not set, skipped');
  const base = env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${env.LLM_API_KEY}` } });
  if (!res.ok) return httpFail(service, res.status);
  return verdict(service, 'ok', 'LLM: models 200');
}

// NOTION_WEBHOOK_SECRET has no issuer endpoint to ask (shared HMAC secret); presence-only by design.
function checkWebhookSecret(env) {
  const service = 'NOTION_WEBHOOK_SECRET';
  return env.NOTION_WEBHOOK_SECRET
    ? verdict(service, 'skipped', 'Notion webhook: set, presence-only (no issuer endpoint)')
    : verdict(service, 'skipped', 'Notion webhook: not set, skipped');
}

export async function verifyAll({ env, fetch }) {
  const results = [];
  const push = r => results.push(r);
  try { push(await checkCloudflare(env, fetch)); } catch { push(verdict('CLOUDFLARE_API_TOKEN', 'error', 'Cloudflare: network error')); }
  try { push(await checkNotion(env, fetch)); } catch { push(verdict('NOTION_TOKEN', 'error', 'Notion: network error')); }
  try { push(await checkButtondown(env, fetch)); } catch { push(verdict('BUTTONDOWN_API_KEY', 'error', 'Buttondown: network error')); }
  try { push(await checkSpiral(env, fetch)); } catch { push(verdict('SPIRAL_TOKEN', 'error', 'Spiral: network error')); }
  try { push(await checkLlm(env, fetch)); } catch { push(verdict('LLM_API_KEY', 'error', 'LLM: network error')); }
  push(checkWebhookSecret(env));
  return { results, ok: results.every(r => r.verdict === 'ok' || r.verdict === 'skipped') };
}

export async function main({ env = process.env, fetch = globalThis.fetch, log = l => console.log(l) } = {}) {
  const { results, ok } = await verifyAll({ env, fetch });
  for (const r of results) log(`[verify-tokens] ${r.service}: ${r.verdict} — ${r.detail}`);
  if (!ok) log('[verify-tokens] FAILED: deploy aborted before wrangler deploy');
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(await main());
}
