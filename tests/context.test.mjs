import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const workspace = readFileSync(new URL("../workspace.js",import.meta.url),"utf8");

function contextFor(attachments,projectFiles) {
  const sandbox = {attachments,projectFiles,active:{project:"test-project"},settings:{}};
  return vm.runInNewContext(workspace + '\nprojects=[{id:"test-project",files:projectFiles}]; localContext(attachments);',sandbox);
}

test("preview shows the exact partial and excluded files when the combined budget is exhausted",()=>{
  const {context,entries} = contextFor([{name:"a",text:"A".repeat(24000)}], [
    {name:"b",text:"B".repeat(23990)+"TAIL_MARKER"},
    {name:"c",text:"excluded"}
  ]);
  assert.equal(context.length,48000);
  assert.equal(entries[0].truncated,false);
  assert.equal(entries[1].truncated,true);
  assert.equal(entries[2].fragment,"");
  assert.equal(entries[2].truncated,true);
  assert.equal(context.includes("TAIL_MARKER"),false);
  assert.equal(context.includes("Файл: c"),false);
  assert.equal(context,"Файл: a\n"+entries[0].fragment+"\n\nФайл: b\n"+entries[1].fragment);
});

test("already shortened source is flagged and images remain separate",()=>{
  const result = contextFor([{name:"image.jpg",mime:"image/jpeg"},{name:"doc",text:"first part",truncated:true}],[]);
  assert.equal(result.context,"Файл: doc\nfirst part");
  assert.equal(result.entries[0].image,true);
  assert.equal(result.entries[1].truncated,true);
  assert.equal(result.images[0].name,"image.jpg");
});
