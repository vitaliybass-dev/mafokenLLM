import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const script=readFileSync(new URL("../spending.js",import.meta.url),"utf8");
test("periods, retries, incomplete usage and prices are attributed to the original route",()=>{
  const now=new Date(2026,5,15,12);
  const api={resource:"api",profileId:"custom",endpoint:"https://example.test/v1",owner:"one",model:"x",at:+now};
  const rows=[{...api,input:500000,output:500000,inputPrice:1,outputPrice:3,probe:true},
    {...api,input:8}, {...api,owner:"two"}, {resource:"local",model:"local",at:+now,input:2,output:3},
    {resource:"plan",model:"plan",at:+new Date(2026,5,14)}, {...api,at:+new Date(2026,4,31)}];
  const groups=period=>vm.runInNewContext(script+"\ngroupUsage(rows,period,now)",{rows,period,now});
  const today=groups("day");
  assert.equal(today.length,3);
  assert.deepEqual([today[0].calls,today[0].probes,today[0].missing,today[0].priced,today[0].cost],[2,1,1,1,2]);
  assert.equal(groups("month").length,4);
});
test("backfills the 60/6 probe with the JunAI tariff and keeps a later reported charge separate", async ()=>{
  const now=Date.now(), endpoint="https://agents.ai.atechlab.ru/v1";
  const row={id:"probe",at:now,resource:"api",profileId:"custom",endpoint,model:"jun/ext/gpt-6-sol",input:60,output:6,probe:true};
  const storage=new Map([["mafoken.usage.probe",JSON.stringify(row)]]);
  const context=vm.createContext({row,settings:{providers:{custom:{endpoint,network:"wifi"}}},
    read:key=>JSON.parse(storage.get(key) ?? "null"),localStorage:{setItem:(key,value)=>storage.set(key,value)},
    $:()=>({open:false}),localTool:async (path,body)=>{
      assert.equal(path,"junai-prices"); assert.deepEqual(Object.keys(body),["network"]); assert.equal(body.network,"wifi");
      return {prices:{[row.model]:{inputPrice:5,outputPrice:30}}};
    }});
  const run=code=>vm.runInContext(code,context);
  run(script);
  await run("fillJunRates([row])");
  const group=()=>run('groupUsage([read("mafoken.usage.probe")],"day")[0]');
  assert.equal(group().calls,1); assert.equal(group().cost,0.00048); assert.equal(group().reported,0);
  run("writeUsage(row,{reportedUSD:0})");
  assert.equal(group().reported,1); assert.equal(group().billed,0); assert.equal(group().priced,0);
});
