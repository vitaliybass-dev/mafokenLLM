"use strict";
const $ = id => document.getElementById(id);
const presets = {
  openai: {name:"OpenAI",kind:"openai",endpoint:"https://api.openai.com/v1/chat/completions",limitField:"max_completion_tokens",usage:true},
  deepseek: {name:"DeepSeek",kind:"openai",endpoint:"https://api.deepseek.com/chat/completions",limitField:"max_tokens",usage:true},
  anthropic: {name:"Claude",kind:"anthropic",endpoint:"https://api.anthropic.com/v1/messages"},
  gemini: {name:"Gemini",kind:"openai",endpoint:"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",limitField:"max_tokens"},
  custom: {name:"Свой API",kind:"openai",endpoint:"",limitField:"max_tokens"}
};
const fresh = preset => ({...presets[preset],model:"",maxTokens:4096});
function read(name, fallback) {
  try { return JSON.parse(localStorage.getItem(name)) ?? fallback; }
  catch { return fallback; }
}
const saved = read("localchat.config", {});
let settings = {preset:"openai",local:"gemma4:12b-backup",providers:{},balanceSnapshots:{},...saved};
let chats = read("localchat.chats", []);
for (const chat of chats) {
  for (const message of chat.messages || []) {
    if (message.inProgress) {
      delete message.inProgress;
      message.error = "Ответ прерван перезагрузкой. Можно повторить запрос.";
    }
  }
}
let active = chats.find(c => c.id === read("localchat.active", null));
let installed = [], modelsLoading = true, busy = false, editing = "", apiKeys = new Map(), controller = null;
let catalogRevision = 0;
const profileDrafts = new Map();
const settingsCatalogs = new Map();
const apiKeyBridge = globalThis.webkit?.messageHandlers?.mafokenAPIKey;
let savedKeysReady = Promise.resolve();
let loadingAPIKeys = false, savingProfile = false, keyEdited = false;

async function restoreAPIKeys() {
  if (!apiKeyBridge) return;
  loadingAPIKeys = true;
  const results = await Promise.allSettled(Object.keys(presets).map(async profile => {
    const endpoint = settings.providers[profile]?.endpoint;
    if (!endpoint) return;
    const key = await apiKeyBridge.postMessage({action:"load",profile,endpoint});
    if (key) apiKeys.set(profile,key);
  }));
  loadingAPIKeys = false;
  sync();
  if (results.some(result=>result.status==="rejected")) {
    notice("Не удалось загрузить некоторые ключи из Связки ключей macOS.");
  }
}
const transientUploads = new WeakMap();
const efforts = {
  brief:"Отвечай кратко, сразу по делу. Дай только необходимые детали.",
  deep:"Разбери задачу подробно: ключевые допущения, варианты, ограничения и способ проверки результата.",
  patch:"Предложи правку как unified diff в блоке Markdown diff, пути относительные к корню проекта. " +
    "Используй точный контекст из предоставленных исходников, минимальный набор изменений. " +
    "Если нужного файла или контекста нет, спроси его вместо выдумывания."
};
const el = (tag, text, css) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (css) element.className = css;
  return element;
};
function save() {
  try {
    localStorage.setItem("localchat.config", JSON.stringify(settings));
    localStorage.setItem("localchat.projects", JSON.stringify(projects));
    if (!active.temp) localStorage.setItem("localchat.active", JSON.stringify(active.id));
    localStorage.setItem("localchat.chats", JSON.stringify(chats));
    return true;
  } catch { storageWarning("Изменения не сохранены на диск. Скопируйте важный текст перед закрытием."); return false; }
}
function newChat(temp = false) {
  const chat = {id:crypto.randomUUID(),title:temp ? "Временный чат" : "Новый чат",
    temp,mode:"auto",allow:false,history:false,messages:[],project:temp ? "" : $("projectFilter").value};
  if (!temp) chats.unshift(chat);
  selectChat(chat);
}
function selectChat(chat, composer = null) {
  active = chat;
  clearNotice();
  void restoreComposer(chat, composer);
  refreshCanvas();
  save();
  render();
  $("draft").focus();
}
async function forkChat(index, edit = false) {
  if (busy || taskBusy || draftLoading || voice) return;
  const original = active;
  const branch = {...original,id:crypto.randomUUID(),title:"Ветка: "+original.title,
    messages:structuredClone(original.messages.slice(0,index + (edit ? 0 : 1))),
    pinned:false,archived:false,cloudCalls:0,canvas:undefined,canvasPrevious:undefined};
  let files = [];
  if (edit) {
    try { files = await messageFiles(original.messages[index]) || []; }
    catch { notice("Не удалось прочитать вложения. Повторите позже."); return; }
    if (original !== active || busy) return;
  }
  if (!branch.temp) chats.unshift(branch);
  const composer = edit ? {text:original.messages[index].content,
    files:[...files]} : null;
  selectChat(branch, composer);
}
function status() {
  connectionButton();
  const p = projectOf(active), cloudCalls = active.cloudCalls || 0;
  $("status").textContent = [
    active.temp ? "Не сохраняется" : p?.name,
    cloudCalls || active.cloudBudget ? "Облачные попытки: "+cloudCalls+(active.cloudBudget ? "/"+active.cloudBudget : "") : ""
  ].filter(Boolean).join(" · ");
  renderRoute();
}
function sync() {
  const lock = busy || taskBusy || draftLoading || !!voice;
  $("title").textContent = active.title;
  $("allow").checked = active.allow;
  $("history").checked = active.history;
  $("shareContext").checked = !!active.shareContext;
  const effectiveMode=currentTarget().mode;
  $("mode").value = effectiveMode;
  $("effort").value = active.effort || "normal";
  for (const id of ["new","temp","settings","connections","projects","prefs","chatMenu","mode","allow",
      "history","shareContext","routeAccounts","pickNextRoute","draft","send","attach","effort","canvasAttach","canvasUndo"])
    $(id).disabled = lock;
  $("history").disabled = lock || !active.allow || effectiveMode === "local";
  $("shareContext").disabled = $("history").disabled;
  $("allow").disabled = lock || effectiveMode === "local";
  $("mic").disabled = !voice && (!voiceReady || lock || !navigator.mediaDevices || !window.MediaRecorder);
  $("stop").hidden = !busy;
  $("send").hidden = busy;
  if (loadingAPIKeys && effectiveMode !== "local" && active.allow) $("send").disabled = true;
  for (const button of $("chats").children) button.disabled = lock;
  status();
}
function inlineMarkdown(target, text) {
  const marker = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\x60([^\x60]+)\x60/g;
  let at = 0;
  for (const m of text.matchAll(marker)) {
    target.append(document.createTextNode(text.slice(at,m.index)));
    if (m[2]) {
      const link=el("a",m[1]);
      link.href=m[2]; link.target="_blank"; link.rel="noopener noreferrer";
      target.append(link);
    } else target.append(el(m[3] ? "strong" : "code",m[3] || m[4]));
    at=m.index+m[0].length;
  }
  target.append(document.createTextNode(text.slice(at)));
}
function markdown(target,text) {
  const lines = text.split("\n"), out = document.createDocumentFragment();
  const cells = line => line.trim().replace(/^\||\|$/g,"").split("|").map(s=>s.trim());
  let i=0;
  while (i<lines.length) {
    const line=lines[i++];
    const fence=line.match(/^\s*\x60{3}([\w+-]*)/);
    const title=line.match(/^(#{1,6})\s+(.*)$/);
    const item=line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.*)$/);
    if (fence) {
      const code=[];
      while(i<lines.length&&!/^\s*\x60{3}/.test(lines[i])) code.push(lines[i++]);
      if (i<lines.length) i++;
      const group=el("div",undefined,"codebox"), bar=el("div",fence[1] || "код","meta");
      const copy=el("button","Копировать");
      copy.onclick=()=>copyText(copy,code.join("\n"));
      bar.append(copy); group.append(bar,el("pre",code.join("\n"))); out.append(group);
    } else if (title) {
      const heading=el("h"+Math.min(4,title[1].length+1));
      inlineMarkdown(heading,title[2]); out.append(heading);
    } else if (item) {
      const list=el(item[2] ? "ol" : "ul");
      if (item[2]) list.start=Number(item[2]);
      let row=item;
      while (row && !!row[2] === !!item[2]) {
        const li=el("li"); inlineMarkdown(li,row[3]); list.append(li);
        row=lines[i]?.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.*)$/);
        if (row && !!row[2] === !!item[2]) i++;
      }
      out.append(list);
    } else if (line.includes("|") && lines[i] && /^\s*\|?\s*:?-{3,}/.test(lines[i]) && lines[i].includes("|")) {
      const table=el("table"), header=el("thead"), body=el("tbody");
      const tr=row=>{const r=el("tr"); for(const cell of cells(row[0])) {
        const x=el(row[1]); inlineMarkdown(x,cell); r.append(x); } return r;};
      header.append(tr([line,"th"])); i++;
      while(i<lines.length&&lines[i].includes("|")) body.append(tr([lines[i++],"td"]));
      table.append(header,body);out.append(table);
    } else {
      const p=el("p"); inlineMarkdown(p,line || "\u00a0"); out.append(p);
    }
  }
  target.replaceChildren(out);
}
async function copyText(button,text) {
  try { await navigator.clipboard.writeText(text); button.textContent="Скопировано"; }
  catch { button.textContent="Не удалось скопировать"; }
}
function messageNode(message) {
  const node=el("article",undefined,"message "+(message.role==="user" ? "user" : ""));
  const meta=el("div",undefined,"meta"), label=el("span");
  meta.append(label);
  const resource=el("div",undefined,"resource-line");
  const pill=el("span"), ownership=el("small"), usage=el("small");
  resource.append(pill,ownership,usage);
  const content=el("div",undefined,"content"), error=el("div",undefined,"error");
  if (!busy) {
    const index=active.messages.indexOf(message);
    const action=(name,fn)=>{const b=el("button",name); b.onclick=()=>{if(!busy&&!taskBusy&&!voice) fn(b);}; meta.append(b);};
    if (message.role==="assistant") {
      if (message.content) {
        action("Копировать",b=>copyText(b,message.content));
        action("Озвучить",()=>speak(message.content));
        action("В редактор",async ()=>{
          const patch = message.content.match(/\x60{3}diff\s*\n([\s\S]*?)\x60{3}/);
          const opened = await canvasOpen(patch ? patch[1] : message.content,patch ? "изменения.patch" : "ответ.md");
          if (opened && patch) $("canvasPreview").click();
        });
        action("Ветка",()=>forkChat(index));
      }
      if (index===active.messages.length-1 && active.messages[index-1]?.role==="user")
        action("Повторить",()=>retry(index));
    } else {
      action("Изменить в ветке",()=>forkChat(index,true));
    }
  }
  const fallback=el("small",undefined,"muted");
  fallback.hidden=true;
  node.append(meta,resource,fallback,content,error);
  function update(parsed = false) {
    label.textContent=message.role==="user" ? "Вы"+(message.files?.length ? " · "+message.files.join(", ") : "") :
      (message.model ? message.source+" · "+message.model : message.error ? "Ответ прерван" : message.status || "Ожидаем ответ…");
    const kind=message.resource || (message.cloud===false ? "local" : message.cloud===true ? "cloud" : "");
    const confirmed=!!message.content;
    const names={local:"Этот Mac · Ollama",api:"Баланс / квота API",plan:"Лимит тарифа ChatGPT",cloud:"Облако · старый ответ"};
    resource.hidden=!kind || message.role!=="assistant";
    pill.className="resource-pill " + (kind==="cloud" ? "api" : kind);
    pill.textContent=confirmed ? names[kind] : (kind==="local" ? "Попытка на Mac" : "Попытка в облако");
    ownership.textContent=kind==="local" ? "Без внешнего API" : message.owner || "Аккаунт не указан";
    const counts=message.usage;
    usage.textContent=counts && (counts.input!=null || counts.output!=null)
      ? "Токены: вход "+(counts.input?.toLocaleString("ru") ?? "н/д")+" · выход "+(counts.output?.toLocaleString("ru") ?? "н/д")
      : (kind==="api" || kind==="plan") && !busy ? "Токены не сообщены" : "";
    if (kind==="api" && !busy) usage.textContent=[usage.textContent,counts?.reportedUSD!=null ? "Сумма от API: "+counts.reportedUSD+" USD" : "Стоимость — в разделе «Расходы»"].filter(Boolean).join(" · ");
    fallback.textContent=message.fallback || "";
    fallback.hidden=!message.fallback;
    error.textContent=message.error || "";
    if (parsed && message.role==="assistant" && message.content) markdown(content,message.content);
    else content.textContent=message.content;
  }
  update(!busy);
  return {node,update};
}
function bottom() { $("messages").scrollTop = $("messages").scrollHeight; }
function renderSidebar() {
  projectChoices($("projectFilter"),"Все чаты",$("projectFilter").value);
  const query = $("chatSearch").value.trim().toLowerCase(), group = $("projectFilter").value;
  const selected = chats.filter(c=>($("showArchive").checked ? c.archived : !c.archived)
    && (!group || c.project===group) && (!query || c.title.toLowerCase().includes(query)
    || c.messages.some(m=>m.content.toLowerCase().includes(query))));
  selected.sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned));
  $("chats").replaceChildren(...selected.map(chat=>{
    const button=el("button",(chat.pinned?"★ ":"")+chat.title);
    button.disabled=busy || taskBusy || !!voice;
    if (chat===active) button.setAttribute("aria-current","true");
    button.onclick=()=>selectChat(chat);
    return button;
  }));
}
function render() {
  renderSidebar();
  if (active.messages.length) $("messages").replaceChildren(...active.messages.map(m => messageNode(m).node));
  else {
    const card = el("div",undefined,"empty");
    card.append(el("h1",active.temp ? "Временный чат" : "Что сегодня соберём?"),
      el("p",active.temp ? "Чат исчезнет при закрытии или смене диалога. Память не используется." :
        "Вставьте код, прикрепите файл или выберите исходники проекта. Модель на Mac работает по умолчанию."));
    $("messages").replaceChildren(card);
  }
  sync();
  renderContextPreview();
  bottom();
}
async function loadModels() {
  try {
    const response = await fetch("/api/models"), info = await response.json();
    installed = info.models || [];
    if (installed.length && !installed.includes(settings.local)) {
      settings.local = installed.includes(info.default) ? info.default : installed[0];
      save();
    }
  } catch { installed = []; }
  modelsLoading=false;
  status();
}
function collect() {
  return {
    name:presets[editing].name,network:editing==="custom" ? $("providerNetwork").value : "",kind:$("kind").value,endpoint:$("endpoint").value.trim(),
    inputPrice:$("inputPrice").value,outputPrice:$("outputPrice").value,priceModel:$("cloudModel").value.trim(),
    model:$("cloudModel").value.trim(),billingLabel:$("billingLabel").value.trim(),maxTokens:Number($("maxTokens").value),
    limitField:$("limitField").value,usage:$("usage").checked
  };
}
function showProvider(preset) {
  editing = preset;
  const draft=profileDrafts.get(preset);
  keyEdited = draft?.keyEdited || false;
  $("profileStatus").textContent=preset===settings.preset ? "Профиль по умолчанию" : "";
  $("makeDefault").hidden=preset===settings.preset;
  $("keychainHint").textContent = apiKeyBridge
    ? "Ключ сохраняется в Связке ключей macOS."
    : "В браузере ключ действует до закрытия или перезагрузки вкладки.";
  $("forgetKey").hidden = !apiKeyBridge;
  resetCatalog();
  const p = draft?.profile || settings.providers[preset] || fresh(preset);
  for (const [id,v] of Object.entries({kind:p.kind,endpoint:p.endpoint,cloudModel:p.model,
    billingLabel:p.billingLabel || "",providerNetwork:p.network || "",inputPrice:p.inputPrice ?? "",outputPrice:p.outputPrice ?? "",maxTokens:p.maxTokens,limitField:p.limitField || "max_tokens",key:draft?.key ?? apiKeys.get(preset) ?? ""})) $(id).value = v;
  $("usage").checked = p.usage === true;
  formatFields();
}
function formatFields() {
  $("providerNetworkField").hidden=editing!=="custom";
  for (const id of ["limitField","usage"]) $(id).closest("label").hidden = $("kind").value === "anthropic";
}
function resetCatalog() {
  catalogRevision++;
  $("fetchCatalog").disabled = false;
  $("catalogStatus").textContent = "";
  $("catalogField").hidden = true;
  $("cloudCatalog").replaceChildren();
}
$("kind").onchange = () => {formatFields(); resetCatalog();};
$("key").oninput = () => {
  keyEdited = true;
  if (apiKeyBridge) $("keychainHint").textContent = "Ключ сохраняется в Связке ключей macOS.";
  resetCatalog();
};
$("forgetKey").onclick = () => {
  $("key").value = "";
  keyEdited = true;
  $("keychainHint").textContent = "Ключ будет удалён из Связки ключей после сохранения профиля.";
  resetCatalog();
};
$("providerNetwork").onchange = resetCatalog;
$("fetchCatalog").onclick = async () => {
  const {endpoint,kind,network} = collect();
  const key = $("key").value.trim();
  if (!key || !endpoint) {
    $("catalogStatus").textContent = "Укажите адрес и ключ API этого провайдера.";
    (!endpoint ? $("endpoint") : $("key")).focus();
    return;
  }
  resetCatalog();
  const revision = catalogRevision;
  $("fetchCatalog").disabled = true;
  $("catalogStatus").textContent = "Загружаем каталог без запроса на генерацию…";
  try {
    const result = await localTool("cloud-models",{endpoint,key,kind,network});
    if (revision !== catalogRevision) return;
    if (result.state !== "verified") {
      $("catalogStatus").textContent = result.message + (editing==="custom" && !network && result.message?.startsWith("Провайдер не ответил")
        ? " Если этот адрес не работает через VPN, проверьте сеть «Напрямую через Wi-Fi»." : "");
      return;
    }
    settingsCatalogs.set(editing,{endpoint,kind,network,key,result});
    const ids = result.models;
    $("catalogStatus").textContent = ids.length
      ? "Моделей в каталоге: " + ids.length + (result.partial ? " · показаны первые страницы." : ".")
        + " Для чата выберите модель с поддержкой формата API выше."
      : "Провайдер не вернул подходящих моделей. Можно ввести ID вручную.";
    $("cloudCatalog").replaceChildren(new Option("Выберите модель",""), ...ids.map(id=>new Option(id,id)));
    $("cloudCatalog").value = ids.includes($("cloudModel").value) ? $("cloudModel").value : "";
    $("catalogField").hidden = !ids.length;
  } catch (error) {
    if (revision === catalogRevision) $("catalogStatus").textContent = error.message;
  } finally {
    if (revision === catalogRevision) $("fetchCatalog").disabled = false;
  }
};
$("cloudCatalog").onchange = () => {
  if ($("cloudCatalog").value) { $("cloudModel").value = $("cloudCatalog").value; $("cloudModel").oninput(); }
};
$("cloudModel").oninput = () => {
  if ($("cloudModel").value.trim() !== settings.providers[editing]?.priceModel) {
    $("inputPrice").value = ""; $("outputPrice").value = "";
  }
  $("cloudCatalog").value = [...$("cloudCatalog").options].some(o => o.value === $("cloudModel").value)
    ? $("cloudModel").value : "";
};
async function openModelSettings(preset = settings.preset) {
  await Promise.all([loadModels(),savedKeysReady]);
  if (busy || $("dialog").open) return;
  $("localModel").replaceChildren(...(installed.length ? installed : [settings.local]).map(m => new Option(m,m)));
  $("localModel").value = settings.local;
  $("preset").value = preset;
  showProvider(preset);
  $("dialog").showModal();
}
$("settings").onclick = () => openModelSettings();
$("preset").onchange = () => {
  profileDrafts.set(editing,{profile:collect(),key:$("key").value,keyEdited});
  showProvider($("preset").value);
};
$("close").onclick = () => { if (!savingProfile) $("dialog").close(); };
$("dialog").oncancel = event => { if (savingProfile) event.preventDefault(); };
$("dialog").onclose = () => { profileDrafts.clear(); settingsCatalogs.clear(); $("key").value = ""; resetCatalog(); };
$("config").onsubmit = async event => {
  event.preventDefault();
  if (savingProfile) return;
  const provider = collect();
  if (provider.endpoint && !provider.endpoint.startsWith("https://")) {
    $("endpoint").setCustomValidity("Адрес должен начинаться с https://");
    $("endpoint").reportValidity();
    return;
  }
  const profile = editing, oldProfile = settings.providers[profile], oldKey = apiKeys.get(profile);
  const key = $("key").value.trim();
  if (event.submitter?.id==="makeDefault" && !(key && provider.endpoint && provider.model)) {
    $("profileStatus").textContent="Чтобы выбрать API по умолчанию, укажите адрес, модель и ключ.";
    return;
  }
  if (apiKeyBridge && (keyEdited || (key && key !== oldKey))) {
    // Freeze the draft while Keychain may be waiting for a macOS prompt.
    savingProfile = true;
    const controls = [...$("config").elements].filter(control=>!control.disabled);
    for (const control of controls) control.disabled = true;
    $("keychainHint").textContent = "Сохраняем изменения в Связке ключей…";
    try {
      await apiKeyBridge.postMessage({action:key ? "save" : "remove",profile,endpoint:provider.endpoint,key});
    } catch (error) {
      $("keychainHint").textContent = error.message || "Не удалось изменить ключ в Связке ключей macOS.";
      return;
    } finally {
      for (const control of controls) control.disabled = false;
      savingProfile = false;
    }
  }
  if (key) apiKeys.set(profile,key);
  else apiKeys.delete(profile);
  settings.providers[profile] = provider;
  if (event.submitter?.id==="makeDefault") settings.preset = profile;
  settings.local = $("localModel").value;
  connectionChanged(profile,oldProfile,oldKey);
  const catalog=settingsCatalogs.get(profile);
  if (catalog && catalog.key===key && catalog.endpoint===provider.endpoint && catalog.kind===provider.kind && catalog.network===provider.network) {
    rememberCatalog(profile,provider.model,catalog.result);
    renderConnections();
  }
  save();
  sync();
  $("dialog").close();
};
$("endpoint").oninput = () => {
  $("endpoint").setCustomValidity("");
  const previous = settings.providers[editing]?.endpoint;
  // A filled key belongs to its previous endpoint and must not be forwarded to a new one.
  if (previous !== $("endpoint").value.trim() && $("key").value.trim() === apiKeys.get(editing)) {
    $("key").value = "";
    keyEdited = false;
    if (apiKeyBridge) $("keychainHint").textContent = "Введите ключ для нового адреса API.";
  }
  resetCatalog();
};
$("mode").onchange = () => {
  clearNotice();
  active.mode = $("mode").value;
  delete active.modelChoice;
  save(); sync();
  if (active.mode === "plan") refreshChatGPT();
};
$("allow").onchange = () => { clearNotice(); active.allow = $("allow").checked; save(); sync(); };
$("history").onchange = () => { clearNotice(); active.history = $("history").checked; save(); sync(); };
$("new").onclick = () => newChat();
$("temp").onclick = () => newChat(true);
$("shareContext").onchange = () => { clearNotice(); active.shareContext=$("shareContext").checked; save(); sync(); };
$("effort").onchange = () => { active.effort=$("effort").value; save(); };
$("stop").onclick = () => controller?.abort();
$("draft").onkeydown = e => {
  if (!e.isComposing && e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("composer").requestSubmit();
};
$("composer").onsubmit = e => { e.preventDefault(); generate(); };
async function messageFiles(message) {
  return transientUploads.get(message) || (message.uploadId ? await readComposerFiles(message.uploadId) : null);
}
async function retry(index) {
  const chat = active;
  const original = active.messages[index-1];
  let attachments;
  try { attachments = await messageFiles(original); }
  catch { notice("Не удалось прочитать вложения. Повторите позже."); return; }
  if (chat !== active || busy) return;
  if (original.files?.length && !attachments?.length) {
    notice("Чтобы повторить с файлами, откройте сообщение в ветке и прикрепите файлы снова.");
    return;
  }
  await generate(index,attachments || []);
}
function fitHistory(before,user) {
  let remaining=185000-user.content.length;
  const trimmed=[];
  for (let i=before.length-1;i>=0&&trimmed.length<98;i--) {
    const m=before[i];
    if (!m.content || m.error) continue;
    if (m.content.length>remaining) break;
    trimmed.unshift({role:m.role,content:m.content});
    remaining-=m.content.length;
  }
  return [...trimmed,{role:"user",content:user.content}];
}
async function* responsePackets(response) {
  if (!response.ok) throw new Error((await response.json()).error || "Запрос отклонён.");
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let buffer="";
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      buffer+=decoder.decode(value,{stream:true});
      let end;
      while ((end=buffer.indexOf("\n"))>=0) {
        const line=buffer.slice(0,end);
        buffer=buffer.slice(end+1);
        if (line.trim()) yield JSON.parse(line);
      }
    }
    buffer+=decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally { reader.releaseLock(); }
}

async function generate(replace, savedFiles) {
  let input = $("draft").value.trim();
  if (busy || taskBusy || draftLoading || voice) return;
  clearNotice();
  const target=currentTarget();
  if (loadingAPIKeys && target.mode !== "local" && active.allow) {
    notice("Загружаем сохранённые ключи API из Связки ключей.");
    return;
  }
  const {profileId,provider}=target, key=apiKeys.get(profileId);
  const attachments = savedFiles || pending;
  if (replace===undefined && !(input || attachments.length)) return;
  const material = localContext(attachments);
  const {context,entries,images,instructions} = material;
  const route=nextRoute(attachments,material,target);
  if (route.kind==="blocked") {notice(route.detail); return;}
  const plan=route.kind==="plan", mayCloud=route.kind!=="local";
  const chargedAccount=plan ? chatgptAccount.account || "Подключённый аккаунт ChatGPT" : apiOwner(provider);
  if (entries.some(item=>item.truncated)) {
    const chat = active;
    renderContextPreview(entries);
    $("contextPreview").open = true;
    if (!await confirmAction("Отправить доступную часть контекста?",
      "Часть материалов сокращена. В предпросмотре видно, какие фрагменты войдут в запрос.",
      "Отправить доступную часть") || active !== chat) return;
  }
  const user=replace===undefined ? {
    role:"user",content:input || "Изучи приложенные материалы и расскажи, что в них.",
    files:attachments.map(f=>f.name)
  } : active.messages[replace-1];
  const before=replace===undefined ? active.messages.slice() : active.messages.slice(0,replace-1);
  const answer={role:"assistant",content:"",inProgress:true};
  busy=true;
  if (replace===undefined && attachments.length && !active.temp) {
    sync();
    user.uploadId="sent/"+crypto.randomUUID();
    if (!await storeComposerFiles(user.uploadId,attachments)) {
      busy=false; sync(); return;
    }
  }
  if (replace===undefined) {
    const previousTitle=active.title;
    if (!active.messages.length && !active.temp && active.title==="Новый чат") active.title=(input || user.files[0]).slice(0,48);
    if (attachments.length) transientUploads.set(user,[...attachments]);
    active.messages.push(user,answer);
    if (!active.temp && !save()) {
      active.messages.splice(-2);
      active.title=previousTitle;
      if (user.uploadId) void storeComposerFiles(user.uploadId,[]);
      busy=false; sync(); return;
    }
    $("draft").value="";
    saveDraftText();
    pending=[];
    showPending(true);
  } else {
    // Keep the previous answer available as a separate conversation.
    const backup=!active.temp && Boolean(active.messages[replace].content);
    if (backup) {
      chats.unshift({...active,id:crypto.randomUUID(),title:"До повтора: "+active.title,
        messages:structuredClone(active.messages),pinned:false,archived:false});
    }
    const [previous]=active.messages.splice(replace,1,answer);
    if (!active.temp && !save()) {
      active.messages[replace]=previous;
      if (backup) chats.shift();
      busy=false; sync(); return;
    }
  }
  controller=new AbortController();
  render();
  const view=messageNode(answer);
  $("messages").lastChild.replaceWith(view.node);
  let cloudAttempt=null, usageRecord=null, complete=false;
  let lastCheckpoint=Date.now();
  try {
    const send = plan ? accountFetch : fetch;
    const response=await send("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},
      signal:controller.signal,body:JSON.stringify({mode:target.mode,model:target.localModel,planModel:plan ? target.planModel : undefined,
        messages:fitHistory(before,user),context,images,instructions,focus:efforts[active.effort] || "",
        allowCloud:mayCloud,shareHistory:active.history,shareContext:active.shareContext,
        provider:mayCloud && !plan ? provider : undefined,key:mayCloud && !plan ? key : undefined})});
    for await (const packet of responsePackets(response)) {
      if (packet.delta) answer.content+=packet.delta;
      if (packet.source) {
        const resource=packet.cloud ? (plan ? "plan" : "api") : "local";
        usageRecord=startUsage(resource,packet.model,profileId,provider,chargedAccount);
        Object.assign(answer,{source:packet.source,model:packet.model,cloud:packet.cloud,resource,
          owner:packet.cloud ? chargedAccount : ""});
        if (packet.cloud && !cloudAttempt) {
          cloudAttempt={resource,model:packet.model};
          active.cloudCalls=(active.cloudCalls || 0)+1;
          save();
        }
      }
      if (packet.status) answer.status=packet.status;
      if (packet.fallback) {
        answer.fallback="API " + apiResource(provider) + " · " + chargedAccount + ": попытка была, списание неизвестно. Ответ продолжен на Mac.";
        delete answer.usage;
      }
      if (packet.usage) { answer.usage={...answer.usage,...packet.usage}; if (usageRecord) writeUsage(usageRecord,packet.usage); }
      if (packet.error) answer.error=packet.error;
      if (packet.done) complete=true;
      if (!active.temp && packet.delta && Date.now()-lastCheckpoint>=2500) { save(); lastCheckpoint=Date.now(); }
      view.update();
      bottom();
    }
    if (!complete && !answer.error) throw new Error("Поток ответа прервался.");
  } catch (err) {
    answer.error=err.name==="AbortError" ? "Ответ остановлен." : err.message || "Не удалось подключиться.";
  } finally {
    if (cloudAttempt) {
      const reply={ok:complete && !answer.error && !!answer.content && answer.resource===cloudAttempt.resource,model:cloudAttempt.model,at:Date.now()};
      if (plan) recordChatGPTReply(chargedAccount,reply);
      else rememberReply(profileId,reply);
    }
    delete answer.inProgress;
    busy=false; controller=null; save(); render(); $("draft").focus();
  }
}
bootWorkspace();
window.addEventListener("pagehide",()=>{ if (busy && !active.temp) save(); });
setupConnections();
setupSpending();
setupNextPicker();
setupChatGPT();
if (!active) newChat(); else selectChat(active);
savedKeysReady = restoreAPIKeys();
loadModels();
refreshChatGPT();
