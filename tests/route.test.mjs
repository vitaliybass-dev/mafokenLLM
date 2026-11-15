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

test("chat model choices override the default route without changing API profiles",()=>{
  const chooseTarget=vm.runInNewContext(source + "\nchooseTarget;");
  const profiles={configured:{model:"primary-cloud"},second:{model:"second-default",endpoint:"https://second.example"}};
  const use=choice=>chooseTarget(choice,"auto","primary-local","configured",profiles);
  assert.equal(use({mode:"local",model:"secondary-local"}).localModel,"secondary-local");
  const cloud=use({mode:"cloud",profileId:"second",model:"chat-model"});
  assert.equal(cloud.mode,"cloud");
  assert.equal(cloud.profileId,"second");
  assert.equal(cloud.provider.endpoint,"https://second.example");
  assert.equal(cloud.provider.model,"chat-model");
  assert.equal(profiles.second.model,"second-default");
  assert.equal(use({mode:"plan",model:"chat-slug"}).planModel,"chat-slug");
  assert.equal(use(undefined).provider.model,"primary-cloud");
  assert.equal(use(undefined).localModel,"primary-local");
  assert.equal(use(undefined).mode,"auto");
});


test("model picker keeps its choice for consecutive sends and after reloading the chat", async () => {
  const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8").split("\nbootWorkspace();")[0];
  const storage = new Map();
  const requests = [];
  function loadChat() {
    const fields = new Map();
    const getField = id => {
      if (!fields.has(id)) fields.set(id, {value:"",close(){},focus(){},lastChild:{replaceWith(){}}});
      return fields.get(id);
    };
    return vm.createContext({
      document:{getElementById:getField}, localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
      projects:[], pending:[], voice:null, taskBusy:false, draftLoading:false,
      accountFetch:null, chatgptAccount:{}, clearNotice(){}, storageWarning(){},
      localContext:()=>({context:"",entries:[],images:[],instructions:""}),
      saveDraftText(){}, showPending(){}, AbortController, TextDecoder,
      fetch:async (_url, {body})=>{
        requests.push(JSON.parse(body));
        return new Response('{"source":"Test API","model":"selected","cloud":true}\n{"delta":"OK"}\n{"done":true}\n');
      }
    });
  }
  const install = context => vm.runInContext(source + "\n" + appSource + `
    sync = render = bottom = () => {};
    messageNode = () => ({update(){}});
  `, context);

  let context = loadChat();
  install(context);
  vm.runInContext(`
    active = {id:"chat",title:"Test",mode:"auto",allow:true,messages:[]};
    chats = [active];
    settings.providers.custom = {name:"Test API",model:"default",endpoint:"https://test.example/v1"};
    apiKeys.set("custom","test-key");
    setupNextPicker();
    $("nextSource").value = "custom";
    $("nextApiModel").value = "selected";
    $("nextRouteForm").onsubmit({preventDefault(){}});
  `, context);

  for (const draft of ["first","second"]) {
    await vm.runInContext(`$("draft").value = "${draft}"; generate();`, context);
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request=>request.mode === "cloud" && request.provider.model === "selected"));
  assert.ok(![...storage.values()].some(value=>value.includes("test-key")));

  context = loadChat();
  install(context);
  assert.equal(vm.runInContext('currentTarget().provider.model', context), "selected");
  assert.equal(vm.runInContext('currentTarget().mode', context), "cloud");
  vm.runInContext('$("mode").value = "local"; $("mode").onchange();', context);
  assert.equal(vm.runInContext('currentTarget().mode', context), "local");
  assert.equal(JSON.parse(storage.get("localchat.chats"))[0].modelChoice, undefined);
});
