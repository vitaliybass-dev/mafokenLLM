"use strict";

const $ = id => document.getElementById(id);
let token = "";
let messages = [];
let poll;
let pendingCommand;
let imageURL;

async function call(path, body) {
  const headers = token ? {Authorization:"Bearer " + token} : {};
  const options = {headers, cache:"no-store"};
  if (body !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (!response.ok) {
    const result = await response.json().catch(()=>({}));
    if (response.status === 401 && token) disconnect();
    throw new Error(result.error || "Не удалось связаться с Mac.");
  }
  return response;
}

function disconnect() {
  clearTimeout(poll);
  pendingCommand = null;
  token = "";
  messages = [];
  $("messages").replaceChildren();
  $("message").value = "";
  $("commandStatus").textContent = "";
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
  $("screen").hidden = true;
  $("screen").removeAttribute("src");
  $("pair").hidden = false;
  $("session").hidden = true;
  $("status").textContent = "Введите новый код, показанный на Mac.";
}

$("pair").onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const response = await call("/api/pair", {code:$("code").value.trim()});
    ({token} = await response.json());
    $("code").value = "";
    $("session").hidden = false;
    $("pair").hidden = true;
    $("status").textContent = "iPhone подключён к Mac";
    const result = await (await call("/api/models")).json();
    $("model").replaceChildren(...result.models.map(model=>new Option(model,model)));
    if (result.models.includes(result.default)) $("model").value = result.default;
    $("send").disabled = !result.models.length;
    if (!result.models.length) $("status").textContent = "На Mac нет доступных моделей Ollama.";
  } catch (error) { $("status").textContent = error.message; }
  finally { button.disabled = false; }
};

function show(section) {
  $("chat").hidden = section !== "Chat";
  $("controls").hidden = section !== "Controls";
  for (const name of ["Chat","Controls"]) $("show"+name).setAttribute("aria-pressed", String(section===name));
}
$("showChat").onclick = () => show("Chat");
$("showControls").onclick = () => show("Controls");
$("disconnect").onclick = async () => {
  try { await call("/api/logout", {}); }
  catch { /* Clear the phone session even if the Mac went offline. */ }
  disconnect();
};

function addMessage(role,text) {
  const node = document.createElement("p");
  node.className = role;
  node.textContent = text;
  $("messages").append(node);
  node.scrollIntoView({block:"nearest"});
  return node;
}

$("prompt").onsubmit = async event => {
  event.preventDefault();
  const text = $("message").value.trim();
  if (!token || !text || !$("model").value || $("send").disabled) return;
  $("send").disabled = true;
  const session = token;
  addMessage("user",text);
  $("message").value = "";
  const reply = addMessage("assistant","…");
  let answer = "";
  try {
    const request = [...messages.slice(-38), {role:"user",content:text}];
    const response = await call("/api/chat", {messages:request, model:$("model").value});
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", done = false;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (session !== token) { await reader.cancel(); return; }
      buffer += decoder.decode(item.value,{stream:true});
      let line;
      while ((line=buffer.indexOf("\n"))>=0) {
        const packet = JSON.parse(buffer.slice(0,line));
        buffer = buffer.slice(line+1);
        if (packet.error) throw new Error(packet.error);
        if (packet.delta) { answer += packet.delta; reply.textContent = answer; }
        if (packet.done) done = true;
      }
      reply.scrollIntoView({block:"nearest"});
    }
    if (!done) throw new Error("Связь с Mac прервана.");
    if (answer) messages = [...request,{role:"assistant",content:answer}].slice(-40);
    else reply.textContent = "Модель не вернула текст.";
  } catch (error) {
    if (session === token) { reply.textContent = error.message; $("message").value ||= text; }
  } finally { if (session === token) $("send").disabled = false; }
};

async function commandResult() {
  try {
    const result = await (await call("/api/command")).json();
    if (result.result?.id === pendingCommand) {
      if (result.result.screenshot) {
        const image = await (await call("/api/screenshot")).blob();
        if (imageURL) URL.revokeObjectURL(imageURL);
        imageURL = URL.createObjectURL(image);
        $("screen").src = imageURL;
        $("screen").hidden = false;
      }
      $("commandStatus").textContent = result.result.message;
      pendingCommand = null;
      return;
    }
    if (pendingCommand) poll = setTimeout(commandResult, 1600);
  } catch (error) { $("commandStatus").textContent = error.message; pendingCommand = null; }
}

for (const button of document.querySelectorAll("[data-command]")) {
  button.onclick = async () => {
    if (pendingCommand) return;
    const kind = button.dataset.command;
    if (kind === "volume" && !$("volume").reportValidity()) return;
    button.disabled = true;
    try {
      const response = await call("/api/command", {kind,value:Number($("volume").value)});
      pendingCommand = (await response.json()).id;
      $("commandStatus").textContent = "Ожидает подтверждения на Mac…";
      await commandResult();
    } catch (error) { $("commandStatus").textContent = error.message; }
    finally { button.disabled = false; }
  };
}
