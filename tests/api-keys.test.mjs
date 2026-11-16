import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const code = readFileSync(new URL("../app.js", import.meta.url),"utf8").split("\nbootWorkspace();")[0];
const endpoint = "https://provider.example/v1";
const fixtureKey = "fixture-api-key";

function loadApp(keychain, storage = new Map()) {
  const fields = new Map();
  const writes = [];
  const field = id => {
    if (!fields.has(id)) fields.set(id, {value:"", hidden:false, disabled:false, elements:[],
      close(){ this.closed = true; }, setCustomValidity(){}, reportValidity(){},
      replaceChildren(){}, closest(){ return {}; }});
    return fields.get(id);
  };
  const env = vm.createContext({
    document:{getElementById:field}, webkit:keychain ? {messageHandlers:{mafokenAPIKey:{
      postMessage:async request => {
        writes.push(request);
        const record = keychain.get(request.profile);
        if (request.action === "load") return record?.endpoint === request.endpoint ? record.key : "";
        if (request.action === "save") keychain.set(request.profile, request);
        else if (request.action === "remove") keychain.delete(request.profile);
        return "";
      }
    }}} : undefined,
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    projects:[], connectionChanged(){}, sync(){}, notice(){}, storageWarning(){}
  });
  const run = source => vm.runInContext(source,env);
  run(code);
  run('sync = () => {}; active = {id:"chat"};');
  return {run,field,writes};
}

test("native keys return after reload, stay bound to the address, and can be removed", async () => {
  const keychain = new Map();
  const storage = new Map();
  let app = loadApp(keychain,storage);
  app.run('showProvider("custom");');
  app.field("endpoint").value = endpoint;
  app.field("key").value = fixtureKey;
  app.field("key").oninput();
  await app.field("config").onsubmit({preventDefault(){}});
  assert.equal(keychain.get("custom").key, fixtureKey);
  assert.ok([...storage.values()].every(value=>!value.includes(fixtureKey)));

  app = loadApp(keychain,storage);
  await app.run('restoreAPIKeys();');
  assert.equal(app.run('apiKeys.get("custom")'), fixtureKey);
  app.run('showProvider("custom");');
  app.field("endpoint").value = "https://another.example";
  app.field("endpoint").oninput();
  assert.equal(app.field("key").value, "");
  await app.field("config").onsubmit({preventDefault(){}});
  assert.equal(keychain.get("custom").endpoint, endpoint);
  assert.equal(app.run('apiKeys.has("custom")'), false);

  app.run('showProvider("custom");');
  app.field("forgetKey").onclick();
  await app.field("config").onsubmit({preventDefault(){}});
  assert.equal(keychain.has("custom"), false);
});
