import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeMetrics, compareTradeRows } from '../public/trades-data.js';

test('gain compares the offered card with the cheapest individual requested card', () => {
  const prices = new Map([[1,{median7d:5000}],[2,{median7d:4000}],[3,{median7d:3000}]]);
  const value = tradeMetrics({characterId:1,wantIds:[2,3]}, prices);
  assert.equal(value.lowest,3000); assert.equal(value.gain,2000);
  assert.ok(Math.abs(value.percent - 66.6666666667) < 1e-6);
});
test('missing or stale requested prices prevent ranking an unreliable cheapest-card comparison', () => {
  for (const extra of [undefined,{median7d:null},{median7d:1,stale:true}]) {
    const prices = new Map([[1,{median7d:5000}],[2,{median7d:3000}],[3,extra]]);
    assert.deepEqual(tradeMetrics({characterId:1,wantIds:[2,3]},prices),{median:5000,lowest:null,gain:null,percent:null});
  }
});
test('zero, losses, stale offered prices, and empty requested lists remain distinct', () => {
  const prices = new Map([[1,{median7d:0}],[2,{median7d:100}],[3,{median7d:500,stale:true}]]);
  assert.deepEqual(tradeMetrics({characterId:1,wantIds:[2]},prices),{median:0,lowest:100,gain:-100,percent:-100});
  assert.deepEqual(tradeMetrics({characterId:2,wantIds:[1]},prices),{median:100,lowest:0,gain:100,percent:null});
  assert.equal(tradeMetrics({characterId:3,wantIds:[2]},prices).gain,null);
  assert.equal(tradeMetrics({characterId:2,wantIds:[]},prices).gain,null);
});
test('all sort modes sort the complete list and keep unavailable values last', () => {
  const rows = [
    {id:'a',metrics:{median:500,gain:100,percent:25}},
    {id:'b',metrics:{median:300,gain:200,percent:200}},
    {id:'c',metrics:{median:null,gain:null,percent:null}},
    {id:'d',metrics:{median:600,gain:-100,percent:-14}},
    {id:'e',metrics:{median:400,gain:0,percent:0}}
  ];
  for (const [mode,expected] of [['median-desc',['d','a','e','b','c']],['median-asc',['b','e','a','d','c']],['gain-desc',['b','a','e','d','c']],['percent-desc',['b','a','e','d','c']]]) {
    assert.deepEqual([...rows].sort((a,b)=>compareTradeRows(a,b,mode)).map(r=>r.id),expected);
  }
});
