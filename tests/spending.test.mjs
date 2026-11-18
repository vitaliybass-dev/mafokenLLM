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