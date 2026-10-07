import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Pipeline, signed, digest } from '../src/worker.js';
const secret = 'test-secret-not-a-real-key';
async function signature(raw) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const result = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return 'sha256=' + [...new Uint8Array(result)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function fixture() {
  const data = new Map(); let alarm;
  const storage = { get: async k => structuredClone(data.get(k)), put: async (k,v) => data.set(k, structuredClone(v)), delete: async k => data.delete(k), list: async o => new Map([...data].filter(([k]) => k.startsWith(o.prefix)).map(([k,v]) => [k,structuredClone(v)])), getAlarm: async () => alarm, setAlarm: async x => { alarm = x; }, transaction: async fn => fn(storage) };
  const env = { WRITING_PROVIDER: 'openai', NOTION_WEBHOOK_SECRET: secret, NOTION_WORKSPACE_ID: 'workspace', NOTION_SUBSCRIPTION_ID: 'subscription', DEBOUNCE_SECONDS: '1', NOTION_DATA_SOURCE_ID: 'ds', TAG_PROPERTY: 'Tags', PUBLISH_TAG: 'publish', PUBLISHED_PROPERTY: 'Published', ISSUE_PROPERTY: 'Issue', PUBLISHED_AT_PROPERTY: 'Date' };
  const pipeline = new Pipeline({storage}, env);
  env.PIPELINE = { idFromName: () => 'id', get: () => pipeline };
  return { env, pipeline, data, storage };
}
async function eventRequest(env, body) {
  const raw = JSON.stringify(body);
  return worker.fetch(new Request('https://worker/webhook', { method: 'POST', body: raw, headers: { 'X-Notion-Signature': await signature(raw) } }), env);
}
test('HMAC rejects modified raw bodies and wrong secrets', async () => {
  const raw = '{"id":"a"}'; const sig = await signature(raw);
  assert.equal(await signed(raw,sig,secret),true);
  assert.equal(await signed(raw + ' ',sig,secret),false);
  assert.equal(await signed(raw,sig,'wrong'),false);
  assert.equal(await signed(raw,'bad',secret),false);
});
test('signed webhook is durably deduped; other workspace denied', async () => {
  const f = fixture(); const body = { id:'event1', workspace_id:'workspace', subscription_id:'subscription', type:'page.properties_updated', entity:{id:'page1'} };
  assert.equal((await eventRequest(f.env,body)).status,202);
  assert.equal((await (await eventRequest(f.env,body)).json()).duplicate,true);
  assert.equal((await eventRequest(f.env,{...body,workspace_id:'other'})).status,403);
  assert.equal(f.data.size,2);
});
test('unsigned event cannot enqueue', async () => {
  const f=fixture(); assert.equal((await worker.fetch(new Request('https://worker/webhook',{method:'POST',body:'{}'}),f.env)).status,401);
  assert.equal(f.data.size,0);
});
test('draft creation reserves source; only sent emails mark published', async () => {
  const f=fixture(); let status='draft',creates=0,marks=0;
  f.pipeline.collect=async () => await f.storage.get('note:p1') ? [] : [{id:'p1',revision:'rev1',text:'fact'}];
  f.pipeline.api=async () => ({choices:[{message:{content:JSON.stringify({subject:'Subject',body:'Only source facts.'})}}]});
  f.pipeline.buttondown=async (_path,method,_body,key) => {if(method==='POST'){creates++;assert.ok(key);return{id:'email1'};}return{id:'email1',status,subject:'Subject',body:'Only source facts.'};};
  f.pipeline.notion=async (_path,method,body) => {if(method==='PATCH'){marks++;assert.equal(body.properties.Published.checkbox,true);return{};}return{last_edited_time:'rev1',properties:{Published:{checkbox:false}}};};
  await f.storage.put('dirty',true); await f.pipeline.alarm();
  assert.equal(creates,1);assert.equal(marks,0);assert.ok(await f.storage.get('note:p1'));
  await f.pipeline.alarm();assert.equal(creates,1);assert.equal(marks,0);
  status='sent';await f.pipeline.alarm();assert.equal(marks,1);
  assert.equal([...f.data.values()].find(v=>v?.emailId)?.stage,'complete');
});
test('resume ambiguous create reuses persisted idempotency key',async()=>{
  const f=fixture();const keys=[];let calls=0;
  f.pipeline.api=async()=>({choices:[{message:{content:'{"subject":"S","body":"B"}'}}]});
  f.pipeline.buttondown=async(_p,m,b,key)=>{if(m==='POST'){keys.push(key);if(calls++===0)throw new Error('timeout');return{id:'e'};}return{status:'draft',subject:'S',body:'B'};};
  const job={id:'stable-id',stage:'generate',notes:[{id:'p'}]};await f.storage.put('job:stable-id',job);
  await assert.rejects(()=>f.pipeline.advance(job));
  const resumed=await f.storage.get('job:stable-id');assert.equal(resumed.stage,'create');
  await f.pipeline.advance(resumed);assert.deepEqual(keys,['stable-id','stable-id']);
});
test('send disabled by default; exact content hash required when enabled',async()=>{
  const f=fixture();assert.equal((await f.pipeline.sendReviewed({})).status,403);
  f.env.ALLOW_REVIEWED_SEND='true';await f.storage.put('job:j',{id:'j',emailId:'e',stage:'draft',notes:[]});
  let patches=0;f.pipeline.buttondown=async(_p,m)=>{if(m==='PATCH')patches++;return{status:'draft',subject:'S',body:'B'};};
  assert.equal((await f.pipeline.sendReviewed({job_id:'j',review_hash:'wrong',confirm_audience:'all newsletter subscribers'})).status,409);
  assert.equal(patches,0);
  const review_hash=await digest(JSON.stringify({subject:'S',body:'B'}));
  assert.equal((await f.pipeline.sendReviewed({job_id:'j',review_hash,confirm_audience:'all newsletter subscribers'})).status,202);assert.equal(patches,1);
});
test('bootstrap receipt cannot trigger processing or overwrite token',async()=>{
  const f=fixture(); delete f.env.NOTION_WEBHOOK_SECRET;f.env.NOTION_SETUP_TOKEN='random-secret-route';
  const req=token=>new Request('https://worker/setup/random-secret-route',{method:'POST',body:JSON.stringify({verification_token:token})});
  await worker.fetch(req('first'),f.env);await worker.fetch(req('second'),f.env);
  assert.equal(f.data.get('setup-token'),'first');assert.equal(f.data.get('dirty'),undefined);
});

test('Spiral uses multipart, paid quota and persists a successful draft',async()=>{
 const f=fixture();f.env.WRITING_PROVIDER='spiral';let generates=0;
 f.pipeline.spiral=async(path,options)=>{if(path.includes('quota'))return{remaining:5,plan_tier:'personal'};generates++;assert.equal(options.body.get('mode'),'instant');assert.equal(options.body.get('num_drafts'),'1');return{session_id:'s',status:'complete',drafts:[{title:'Title',content:'Body',url:'https://app.writewithspiral.com/chat/s'}]};};
 const job={id:'j',stage:'generate',notes:[{id:'private',text:'Fact'}]};const draft=await f.pipeline.writeDraft(job);assert.deepEqual(draft,{subject:'Title',body:'Body'});assert.equal(job.spiralSessionId,'s');await f.pipeline.writeDraft(job);assert.equal(generates,1);
});
test('ambiguous Spiral generation cannot be blindly retried',async()=>{
 const f=fixture();f.env.WRITING_PROVIDER='spiral';let generates=0;f.pipeline.spiral=async(path)=>{if(path.includes('quota'))return{remaining:5,plan_tier:'personal'};generates++;throw new Error('timeout');};
 const job={id:'j',stage:'generate',notes:[]};await assert.rejects(()=>f.pipeline.writeDraft(job));await assert.rejects(()=>f.pipeline.writeDraft(job),{code:'spiral_ambiguous_generation'});assert.equal(generates,1);
});
