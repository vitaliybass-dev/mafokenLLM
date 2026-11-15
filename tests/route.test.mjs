import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const source = readFileSync(new URL("../connections.js",import.meta.url),"utf8");
const requestRoute = vm.runInNewContext(source + "\nrequestRoute;");
const base = {mode:"auto",allow:true,ready:true,planReady:true,localReady:true,shareContext:false};

test("auto names a possible API only if permitted, ready, and allowed to receive files",()=>{
  assert.equal(requestRoute(base).kind,"auto");
  for (const change of [{allow:false},{ready:false},{hasFiles:true},{exhausted:true}]) {
    assert.equal(requestRoute({...base,...change}).kind,"local");
  }
  assert.equal(requestRoute({...base,hasFiles:true,shareContext:true}).kind,"auto");
  assert.equal(requestRoute({...base,localReady:false}).kind,"blocked");
});

test("explicit API and ChatGPT never silently switch payer",()=>{
  assert.equal(requestRoute({...base,mode:"cloud"}).kind,"api");
  assert.equal(requestRoute({...base,mode:"cloud",ready:false}).kind,"blocked");
  assert.equal(requestRoute({...base,mode:"cloud",exhausted:true}).kind,"blocked");
  assert.equal(requestRoute({...base,mode:"plan",ready:false}).kind,"plan");
  assert.equal(requestRoute({...base,mode:"plan",planReady:false}).kind,"blocked");
  assert.equal(requestRoute({...base,mode:"plan",hasImages:true,shareContext:true}).kind,"blocked");
  assert.equal(requestRoute({...base,mode:"local",localOnly:true}).kind,"local");
  assert.equal(requestRoute({...base,mode:"auto",localOnly:true}).kind,"blocked");
});

test("one-shot model and API choices override only the current request target",()=>{
  const chooseTarget=vm.runInNewContext(source + "\nchooseTarget;");
  const profiles={configured:{model:"primary-cloud"},second:{model:"second-default",endpoint:"https://second.example"}};
  const use=choice=>chooseTarget(choice,"auto","primary-local","configured",profiles);
  assert.equal(use({mode:"local",model:"secondary-local"}).localModel,"secondary-local");
  const cloud=use({mode:"cloud",profileId:"second",model:"one-shot-model"});
  assert.equal(cloud.mode,"cloud");
  assert.equal(cloud.profileId,"second");
  assert.equal(cloud.provider.endpoint,"https://second.example");
  assert.equal(cloud.provider.model,"one-shot-model");
  assert.equal(profiles.second.model,"second-default");
  assert.equal(use({mode:"plan",model:"one-shot-slug"}).planModel,"one-shot-slug");
  assert.equal(use(undefined).provider.model,"primary-cloud");
  assert.equal(use(undefined).localModel,"primary-local");
  assert.equal(use(undefined).mode,"auto");
});
