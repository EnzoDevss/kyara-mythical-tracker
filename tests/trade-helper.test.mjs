import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extensions/kyara-trade-helper/helper.js',import.meta.url),'utf8');
function setup(href='https://kyara.games/marche?onglet=offres&trackerCard=27&offre=older-offer', response=Response.json([{id:'older-offer',characterId:27,status:'open'}])) {
  const calls=[];
  const window={location:{href},fetch:async(...args)=>{calls.push(args);return response;}};
  const document={body:null,addEventListener(){}};
  vm.runInNewContext(source,{window,document,URL,Request});
  return {window,calls,response};
}
test('marked links rewrite only the default public offers GET and preserve the response for Kyara',async()=>{
  const {window,calls,response}=setup(); const result=await window.fetch('/api/trades/offers',{headers:{'x-device-id':'unchanged'}});
  assert.equal(calls[0][0],'https://kyara.games/api/trades/offers?characterId=27');
  assert.deepEqual(calls[0][1],{headers:{'x-device-id':'unchanged'}});
  assert.equal(result,response); assert.equal((await result.json())[0].id,'older-offer');
});
test('Request objects retain options when the listing URL is changed',async()=>{
  const {window,calls}=setup(); const request=new Request('https://kyara.games/api/trades/offers',{headers:{'x-device-id':'unchanged'}});
  await window.fetch(request); assert.equal(calls[0][0].headers.get('x-device-id'),'unchanged'); assert.equal(new URL(calls[0][0].url).searchParams.get('characterId'),'27');
});
test('mutations, authentication, other origins, and existing filtered requests remain untouched',async()=>{
  for(const [url,init] of [['/api/trades/offers',{method:'POST',body:'{}'}],['/api/trades/offers/older-offer/accept',{method:'POST'}],['/api/auth/providers',{}],['https://other.test/api/trades/offers',{}],['/api/trades/offers?characterId=1',{}]]){
    const {window,calls}=setup();await window.fetch(url,init);assert.equal(calls[0][0],url);assert.equal(calls[0][1],init);
  }
});
test('ordinary pages, absent markers, invalid IDs, and other tabs remain unmodified',async()=>{
  for(const href of ['https://kyara.games/marche?onglet=offres','https://kyara.games/marche?onglet=acheter&trackerCard=27','https://kyara.games/marche?onglet=offres&trackerCard=0','https://kyara.games/marche?onglet=offres&trackerCard=javascript:alert(1)','https://kyara.games/wiki/27?onglet=offres&trackerCard=27']){
    const {window,calls}=setup(href);await window.fetch('/api/trades/offers');assert.equal(calls[0][0],'/api/trades/offers');
  }
});
