import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRooms, cleanCounterPage } from '../src/counter.mjs';
import { TradesCoordinator } from '../src/trades.mjs';
import { loadCounter, counterRows, counterMatchesOwned } from '../public/counter-data.js';
const now = Date.parse('2026-10-19T16:00:00Z'), cutoff = now - 3600000;
const message = (id, room, minutes, tag = 'seek') => ({ id, room, createdAt: new Date(now - minutes * 60000).toISOString(), text: '<script>text</script>', author: { id: 'player-1', pseudo: '<player>', avatar: 'unneeded' }, attachment: { kind: 'card', tag, character: { id: 1, name: 'Card', series: 'Series', rarity: 'M', rank: 0, image: 'unneeded' } } });
test('rooms are discovered dynamically and messages expose only the required public data', () => {
  assert.deepEqual(cleanRooms({ rooms: [{room:17},{room:2},{room:17},{room:0}] }), [2,17]);
  const page = cleanCounterPage({ items: [message('new',17,1),message('old',17,61)], hasMore:true },17,now);
  assert.equal(page.nextBefore,'old'); assert.equal(page.oldestAt,new Date(now-61*60000).toISOString());
  assert.equal(page.items[0].author.avatar,undefined); assert.equal(page.items[0].attachment.character.image,undefined);
  assert.equal(page.items[0].attachment.character.rank,1);
  assert.equal(cleanCounterPage({items:[{...message('bad',17,2),author:null}],hasMore:true},17,now).nextBefore,'bad');
  assert.throws(()=>cleanCounterPage({items:[{}],hasMore:true},17,now));
});
test('owned-card matching means requests, not merely sharing or offering a card you own', () => {
  const seek=message('seek',1,2), trade=message('trade',1,3,'trade');
  const offer={...message('offer',1,4),attachment:{kind:'offer',status:'open',character:{id:3,name:'Other'},wantIds:[1],expiresAt:new Date(now+10000).toISOString()}};
  assert.equal(counterMatchesOwned(seek,new Set([1])),true);
  assert.equal(counterMatchesOwned(trade,new Set([1])),false);
  assert.equal(counterMatchesOwned(offer,new Set([1])),true);
  const closed={...offer,id:'closed',attachment:{...offer.attachment,status:'cancelled'}};
  const old=message('old',1,61);
  assert.deepEqual(counterRows([trade,old,closed,seek,offer],{cutoff,owned:new Set([1]),now}).map(m=>m.id),['seek','offer']);
  assert.equal(counterRows([seek],{cutoff,query:'<player>',room:'1',rarity:'M',now}).length,1);
  assert.equal(counterRows([seek],{cutoff,type:'trade',now}).length,0);
});
test('loader pages each discovered room to the fixed hour cutoff, with recent pages first', async () => {
  const calls=[], coverage=new Map(), messages=new Map();
  const fetcher=async path=>{
    const url=new URL(path,'https://tracker'); calls.push(url.pathname+url.search);
    if(url.pathname.endsWith('/rooms')) return Response.json({rooms:[2,17,25],checkedAt:now});
    const room=Number(url.searchParams.get('room')), older=url.searchParams.has('before');
    const items=[message((older?'old':'new')+room,room,older?65:2)];
    return Response.json({...cleanCounterPage({items,hasMore:room!==25},room,now)});
  };
  await loadCounter({signal:new AbortController().signal,fetcher,onRooms:(rooms,from)=>{assert.deepEqual(rooms,[2,17,25]);assert.equal(from,cutoff);},onPage:page=>page.items.forEach(m=>messages.set(m.id,m)),onRoom:(room,status)=>coverage.set(room,status)});
  assert.deepEqual([...coverage].sort((a,b)=>a[0]-b[0]),[[2,'hour'],[17,'hour'],[25,'end']]);
  assert.ok(calls[3].includes('room=25')); assert.ok(calls[4].includes('before='));
  assert.equal(counterRows(messages.values(),{cutoff,now}).length,3);
});
test('loader reports failed or nonadvancing rooms rather than claiming complete coverage', async () => {
  const coverage=new Map();
  await loadCounter({signal:new AbortController().signal,fetcher:async path=>path.endsWith('/rooms')?Response.json({rooms:[1,20],checkedAt:now}):path.includes('room=20')?Response.json({error:'unavailable'},{status:503}):Response.json({...cleanCounterPage({items:[message('same',1,2)],hasMore:true},1,now)}),onRooms:()=>{},onPage:()=>{},onRoom:(room,status)=>coverage.set(room,status)});
  assert.equal(coverage.get(20),'failed');assert.equal(coverage.get(1),'partial');
});
test('aborting a load prevents more pagination and preserves already-delivered pages', async () => {
  const controller=new AbortController();let pages=0;
  await assert.rejects(loadCounter({signal:controller.signal,fetcher:async path=>path.endsWith('/rooms')?Response.json({rooms:[1],checkedAt:now}):Response.json(cleanCounterPage({items:[message('one',1,1)],hasMore:true},1,now)),onRooms:()=>{},onPage:()=>{pages++;controller.abort();},onRoom:()=>{}}),e=>e.name==='AbortError');
  assert.equal(pages,1);
});
function setup(fetcher) {
  let time=now;
  const coordinator=new TradesCoordinator({waitUntil:()=>{}},{},{fetch:fetcher,now:()=>time,sleep:async ms=>{time+=ms;await new Promise(r=>setTimeout(r,0));}});
  return {coordinator,advance:ms=>time+=ms};
}
test('counter pages share cache, validate room membership/cursors and refresh changing room lists', async () => {
  const calls=[];let rooms=[1,17];
  const {coordinator,advance}=setup(async url=>{calls.push(url);return Response.json(url.endsWith('/rooms')?{rooms:rooms.map(room=>({room}))}:{items:[message('post',17,1)],hasMore:false});});
  const get=path=>coordinator.fetch(new Request('https://tracker/api/trades/counter/'+path));
  const [a,b]=await Promise.all([get('page?room=17'),get('page?room=17')]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(calls.length,2);
  assert.equal((await (await get('page?room=17')).json()).cached,true);
  for(const path of ['page?room=99','page?room=17&before=../x','page?room=17&room=1','page?room=17&url=bad']) assert.equal((await get(path)).status,400);
  assert.equal((await coordinator.fetch(new Request('https://tracker/api/trades/counter/rooms',{method:'POST'}))).status,405);
  rooms=[30];advance(15001);
  assert.deepEqual((await (await get('rooms')).json()).rooms,[30]);
  assert.equal((await get('page?room=17')).status,400);
});
test('counter and trade requests use the same paced queue and counter throttling pauses trades', async () => {
  const starts=[];let throttle=false;
  const {coordinator}=setup(async url=>{starts.push(coordinator.now());return throttle?new Response('',{status:429,headers:{'Retry-After':'3'}}):Response.json(url.endsWith('/rooms')?{rooms:[{room:1}]}:url.includes('/chat?')?{items:[],hasMore:false}:[]);});
  const catalog={knownIds:new Set([1]),mythicals:new Set([1])};
  await Promise.all([coordinator.counterRooms(),coordinator.search(1,catalog)]);
  assert.ok(starts[1]-starts[0]>=100);
  throttle=true;
  const response=await coordinator.fetch(new Request('https://tracker/api/trades/counter/page?room=1'));
  assert.equal(response.status,429);assert.equal((await response.json()).retryAfter,3000);
  await assert.rejects(coordinator.search(2,catalog),e=>e.retryAfter>0);
});
