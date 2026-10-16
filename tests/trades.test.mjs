import test from 'node:test';
import assert from 'node:assert/strict';
import { TradesCoordinator, cleanOffers, retryDelay, tradesResponse } from '../src/trades.mjs';
import { searchOrder, readEvents } from '../public/trades-data.js';

const now = Date.parse('2026-10-16T16:00:00Z');
const offer = (id = 'offer-1', cardId = 1) => ({ id, characterId: cardId, wantIds: [2], status: 'open', user: { id: 'public-user', pseudo: '<Player>' }, createdAt: new Date(now-1000).toISOString(), expiresAt: new Date(now+86400000).toISOString(), counterOk: true });
function setup(fetcher) {
  let time = now;
  const waits = [];
  const coordinator = new TradesCoordinator({ waitUntil: promise => waits.push(promise) }, {}, { fetch: fetcher, now: () => time, sleep: async ms => { time += ms; await new Promise(r => setTimeout(r,0)); } });
  const catalog = { cards: [{ id: 1, rarity: 'M' }, { id: 2, rarity: 'M' }, { id: 3, rarity: 'M' }], mythicals: new Set([1,2,3]), knownIds: new Set([1,2,3]) };
  coordinator.catalog = catalog; coordinator.catalogAt = time;
  return { coordinator, catalog, advance: ms => { time += ms; }, waits };
}
test('offers include only the offered Mythical, exclude closed, expired, malformed and duplicate entries', () => {
  const wantedOnly = { ...offer('wanted',2), wantIds: [1] };
  const values = cleanOffers([offer(),offer(),wantedOnly,{...offer('closed'),status:'accepted'},{...offer('expired'),expiresAt:new Date(now-1).toISOString()},{...offer('bad'),wantIds:[999]}],1,new Set([1,2]),now);
  assert.equal(values.length,1); assert.equal(values[0].user.pseudo,'<Player>'); assert.equal(values[0].user.id,undefined);
});
test('price order uses fresh seven-day prices, breaks ties by wiki rank, and puts missing/stale prices last', () => {
  const cards = [{id:1,rarity:'M',rank:3},{id:2,rarity:'M',rank:1},{id:3,rarity:'M',rank:2},{id:4,rarity:'L',rank:4}];
  assert.deepEqual(searchOrder(cards,new Map([[1,{median7d:100}],[2,{median7d:100}],[3,{median7d:500,stale:true}],[4,{median7d:900}]])).map(c=>c.id),[2,1,3]);
});
test('simultaneous visitors share pending searches and cached results; cache expires after fifteen seconds', async () => {
  let requests = 0;
  const {coordinator,catalog,advance} = setup(async () => { requests++; await new Promise(r=>setTimeout(r,5)); return Response.json([offer()]); });
  const [a,b] = await Promise.all([coordinator.search(1,catalog),coordinator.search(1,catalog)]);
  assert.deepEqual(a,b); assert.equal(requests,1);
  assert.equal((await coordinator.search(1,catalog)).cached,true); assert.equal(requests,1);
  advance(15001); await coordinator.search(1,catalog); assert.equal(requests,2);
});
test('global scheduler spaces searches from multiple callers and does not multiply their request rate', async () => {
  const starts=[]; const {coordinator,catalog} = setup(async url => { starts.push(coordinator.now()); const id=Number(new URL(url).searchParams.get('characterId')); return Response.json([offer('offer-'+id,id)]); });
  await Promise.all([1,2,3].map(id=>coordinator.search(id,catalog)));
  assert.equal(starts.length,3); assert.ok(starts[1]-starts[0]>=100); assert.ok(starts[2]-starts[1]>=100);
});
test('429 pauses all visitors, slows future traffic, and never caches an empty success', async () => {
  let count=0; const {coordinator,catalog,advance}=setup(async()=>{ count++; return new Response('',{status:429,headers:{'Retry-After':'3'}}); });
  await assert.rejects(coordinator.search(1,catalog),e=>e.retryAfter===3000);
  await assert.rejects(coordinator.search(2,catalog),e=>e.retryAfter>0);
  assert.equal(count,1); assert.equal(coordinator.cache.size,0); assert.equal(coordinator.interval,200);
  advance(3001); await assert.rejects(coordinator.search(2,catalog)); assert.equal(count,2);
});
test('Retry-After seconds, dates, and reset countdown are honored', () => {
  assert.equal(retryDelay(new Headers({'Retry-After':'4'}),now),4000);
  assert.equal(retryDelay(new Headers({'Retry-After':new Date(now+5000).toUTCString()}),now),5000);
  assert.equal(retryDelay(new Headers({'x-ratelimit-reset':'60'}),now),60000);
});
test('streamed batches are bounded, validate Mythical IDs, and emit each result independently', async () => {
  const {coordinator}=setup(async url=>{ const id=Number(new URL(url).searchParams.get('characterId')); return Response.json([offer('o-'+id,id)]); });
  const req=ids=>new Request('https://tracker/api/trades/batch',{method:'POST',body:JSON.stringify({ids})});
  assert.equal((await coordinator.fetch(req([999]))).status,400);
  assert.equal((await coordinator.fetch(req([1,1]))).status,400);
  assert.equal((await coordinator.fetch(req(Array.from({length:11},(_,i)=>i+1)))).status,400);
  const response=await coordinator.fetch(req([1,2])); const events=[]; await readEvents(response,e=>events.push(e));
  assert.deepEqual(events.map(e=>e.type),['card','card','done']); assert.deepEqual(events.slice(0,2).map(e=>e.cardId),[1,2]);
});
test('browser stream parser handles split UTF-8 and split lines without waiting for completion', async () => {
  const encoder=new TextEncoder(); const bytes=encoder.encode('{"name":"Shōnen"}\n{"done":true}\n');
  const stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,12));c.enqueue(bytes.slice(12,22));c.enqueue(bytes.slice(22));c.close();}});
  const events=[]; await readEvents(new Response(stream),e=>events.push(e));
  assert.deepEqual(events,[{name:'Shōnen'},{done:true}]);
});
test('trade routing does not permit cross-origin usage or require any KV writes', async () => {
  assert.equal((await tradesResponse(new Request('https://tracker/api/trades/catalog',{headers:{origin:'https://elsewhere'}}),{})).status,403);
  let name; const env={TRADES:{idFromName:n=>(name=n),get:()=>({fetch:()=>Response.json({ok:true})})}};
  assert.equal((await tradesResponse(new Request('https://tracker/api/trades/catalog'),env)).status,200);
  assert.equal(name,'shared-trade-search-v1');
});
test('server permits top-1000 Legendaries while rejecting older ranks and other offered rarities', async () => {
  const raw = [...Array.from({length:200},(_,i)=>({id:i+1,name:'M'+i,rarity:'M',rank:i})),
    {id:500,name:'L in',rarity:'L',rank:999},{id:501,name:'L out',rarity:'L',rank:1000},{id:502,name:'Epic',rarity:'E',rank:300}];
  const {coordinator}=setup(async url=>url.endsWith('/characters')?Response.json(raw):Response.json([offer('legendary',500)]));
  coordinator.catalog=null;
  const req=id=>new Request('https://tracker/api/trades/batch',{method:'POST',body:JSON.stringify({ids:[id]})});
  const response=await coordinator.fetch(req(500)), events=[];
  await readEvents(response,e=>events.push(e));
  assert.equal(events[0].cardId,500);assert.equal(events[0].offers.length,1);
  assert.equal((await coordinator.fetch(req(501))).status,400);
  assert.equal((await coordinator.fetch(req(502))).status,400);
});
