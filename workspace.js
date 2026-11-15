"use strict";

let projects = [], pending = [], projectDraft, taskBusy = false;
let voice = null, voiceTimer, voiceReady = false;
const maxInbox = 8 * 1024 * 1024;
const contextLimit = 48000;
const composerFiles = new Map();
let draftDatabase;
let draftLoading = false;
let draftRevision = 0;

function storageWarning(text) {
  $("storageNotice").hidden = false;
  $("storageNotice").textContent = text;
}

function draftStore() {
  if (!draftDatabase) {
    draftDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open("mafokenLLM-composer", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return draftDatabase;
}

async function readComposerFiles(id) {
  const db = await draftStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction("files").objectStore("files").get(id);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error);
  });
}

async function storeComposerFiles(id, files) {
  try {
    const db = await draftStore();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("files", "readwrite");
      const store = transaction.objectStore("files");
      if (files.length) store.put(files, id); else store.delete(id);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    storageWarning("Не удалось сохранить вложения на диск. Они доступны до закрытия приложения.");
  }
}

function saveDraftText() {
  if (active?.temp || !active) return;
  try {
    const text = $("draft").value;
    const key = "localchat.draft." + active.id;
    if (text) localStorage.setItem(key, text); else localStorage.removeItem(key);
  } catch { storageWarning("Черновик не сохранён. Скопируйте текст перед закрытием приложения."); }
}

async function restoreComposer(chat, preset = null) {
  const revision = ++draftRevision;
  draftLoading = false;
  pending = preset?.files || composerFiles.get(chat.id) || [];
  try {
    $("draft").value = preset?.text ?? (chat.temp ? "" : localStorage.getItem("localchat.draft." + chat.id) || "");
  } catch { $("draft").value = preset?.text ?? ""; }
  if (preset) {
    saveDraftText();
    showPending(true);
    return;
  }
  showPending();
  if (chat.temp || composerFiles.has(chat.id)) return;

  draftLoading = true;
  try {
    const files = await readComposerFiles(chat.id);
    if (revision !== draftRevision) return;
    pending = files;
    composerFiles.set(chat.id, files);
  } catch {
    if (revision === draftRevision) storageWarning("Сохранённые вложения не удалось прочитать.");
  } finally {
    if (revision === draftRevision) {
      draftLoading = false;
      showPending();
      sync();
      $("draft").focus();
    }
  }
}

function confirmAction(title, detail, accept) {
  const dialog = $("actionDialog");
  if (dialog.open) return Promise.resolve(false);
  $("actionTitle").textContent = title;
  $("actionDetail").textContent = detail;
  $("actionAccept").textContent = accept;
  dialog.returnValue = "";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), {once:true});
    dialog.showModal();
    $("actionCancel").focus();
  });
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type:"text/plain;charset=utf-8"}));
  const link = el("a");
  link.href = url;
  link.download = name.replace(/[\x00-\x1f/\\]/g,"_").slice(0,100) || "mafokenLLM.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function canvasOpen(text, filename) {
  const currentChat = active;
  if (text !== undefined) {
    const incoming = {text:text.slice(0,150000),name:filename || "ответ.md"};
    const current = active.canvas;
    if (current?.text && (current.text !== incoming.text || current.name !== incoming.name)) {
      const accepted = await confirmAction(
        "Открыть ответ в редакторе?", "Текущий текст останется доступен через «Вернуть предыдущий текст».",
        "Открыть ответ");
      if (!accepted || active !== currentChat) return false;
      active.canvasPrevious = current;
    }
    active.canvas = incoming;
    save();
  }
  $("canvasPane").hidden = false;
  refreshCanvas();
  return true;
}
function refreshCanvas() {
  $("canvasName").value = active.canvas?.name || "";
  $("canvasText").value = active.canvas?.text || "";
  $("diffPreview").hidden = true;
  $("canvasUndo").hidden = !active.canvasPrevious;
}
function projectChoices(select, first, selected) {
  select.replaceChildren(new Option(first,""),...projects.map(p => new Option(p.name,p.id)));
  select.value = projects.some(p=>p.id===selected) ? selected : "";
}
function projectOf(chat) { return projects.find(p=>p.id===chat.project); }
function historyMarkdown(chat) {
  return "# " + chat.title + "\n\n" + chat.messages.filter(m=>m.content).map(m =>
    "## " + (m.role==="user" ? "Вы" : (m.model || "mafokenLLM")) + "\n\n" + m.content).join("\n\n");
}
function chatDialog() {
  $("chatName").value = active.title;
  projectChoices($("chatProject"),"Без проекта",active.project);
  $("pinned").checked = !!active.pinned;
  $("archived").checked = !!active.archived;
  $("cloudBudget").value = active.cloudBudget || 0;
  for (const id of ["pinned","archived","chatProject"]) $(id).disabled = !!active.temp;
  $("chatDialog").showModal();
}
function notice(text) { $("scope").textContent = text; }
function renderChips(node, list, remove) {
  node.replaceChildren(...list.map((item,i) => {
    const chip = el("span",undefined,"chip"), button = el("button","×");
    chip.append(el("span", item.name + (item.truncated ? " (сокращено)" : "")),button);
    button.type = "button";
    button.title = "Убрать " + item.name;
    button.onclick = () => remove(i);
    return chip;
  }));
}
function showPending(changed = false) {
  renderChips($("pending"),pending,i=>{
    if (!busy && !taskBusy) { pending.splice(i,1); showPending(true); }
  });
  if (changed && !active.temp) {
    composerFiles.set(active.id, pending);
    void storeComposerFiles(active.id, [...pending]);
  }
  renderContextPreview();
}
function setProjectDraft(id) {
  const p = projects.find(p=>p.id===id);
  projectDraft = p ? structuredClone(p) : {id:crypto.randomUUID(),name:"",instructions:"",files:[]};
  $("projectName").value = projectDraft.name;
  $("projectInstructions").value = projectDraft.instructions;
  $("projectStatus").textContent = "";
  $("folderList").replaceChildren();
  showProjectFiles();
}
function showProjectFiles() {
  renderChips($("projectFiles"),projectDraft.files,i=>{
    if (!taskBusy) { projectDraft.files.splice(i,1); showProjectFiles(); }
  });
}
function asBase64(blob) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",",2)[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function localTool(path, data) {
  const r = await fetch("/api/"+path,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(data)});
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Не удалось выполнить действие.");
  return result;
}
function sensitivePath(name) {
  return name.split("/").some(p=>/^\.(?:env(?:\.|$)|git$|npmrc$|netrc$|ssh$|aws$)/i.test(p)) ||
    /(?:^|\/)(?:credentials(?:\..*)?|secrets(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|key|crt))$/i.test(name);
}
async function addFiles(files, target, report) {
  if (taskBusy || busy) return;
  taskBusy = true;
  for (const id of ["projectEdit","projectAttach","projectFolder"]) $(id).disabled = true;
  sync();
  const errors = [];
  for (const file of Array.from(files).slice(0,12)) {
    const parts = (file.webkitRelativePath || "").split("/");
    const name = parts.length > 1 ? parts.slice(1).join("/") : file.name;
    if (sensitivePath(name)) {
      errors.push(name + ": исключён из контекста");
      continue;
    }
    if (target.length >= 12) {errors.push("Можно добавить до 12 файлов."); break;}
    try {
      const isImage = ["image/png","image/jpeg","image/webp"].includes(file.type);
      if (file.size > (isImage ? 2 * 1024 * 1024 : maxInbox)) throw new Error("Файл слишком большой.");
      report("Читаю " + name + "…");
      const data = await asBase64(file);
      if (isImage) {
        if (target!==pending) throw new Error("Прикрепите изображение к сообщению.");
        if (pending.filter(it=>it.mime).length >= 2) throw new Error("Можно до двух изображений.");
        target.push({name,mime:file.type,data});
      } else {
        const item = await localTool("extract",{name,data});
        const next = target.reduce((sum,f)=>sum+(f.text?.length || 0),0) + item.text.length;
        if (next > 48000) throw new Error("Для этого набора файлов исчерпан объём контекста.");
        target.push(item);
      }
    } catch (error) { errors.push(name + ": " + (error.message || "ошибка чтения")); }
  }
  taskBusy = false;
  for (const id of ["projectEdit","projectAttach","projectFolder"]) $(id).disabled = false;
  if (target===pending) showPending(true); else showProjectFiles();
  sync();
  report(errors.length ? errors.slice(0,3).join(" · ") : "Файлы добавлены.");
}
function folderPicker(files) {
  const supported = /\.(?:md|txt|csv|tsv|js|jsx|ts|tsx|json|yaml|yml|toml|css|html|py|rb|go|rs|swift|java|kt|sql|sh|php|vue|svelte|c|cpp|h|hpp)$/i;
  const candidates = Array.from(files).filter(f=>{
    const name = f.webkitRelativePath.split("/").slice(1).join("/");
    return f.size <= 200000 && !sensitivePath(name) && supported.test(name) &&
      !name.split("/").some(seg=>seg.startsWith(".") || /^(?:node_modules|vendor|dist|build|coverage|__pycache__|venv|target|Pods)$/.test(seg));
  }).sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath));
  $("folderList").replaceChildren();
  const picks = [];
  for (const file of candidates.slice(0,300)) {
    const item = el("label"), check = el("input");
    check.type = "checkbox";
    item.append(check,document.createTextNode(" " + file.webkitRelativePath.split("/").slice(1).join("/")));
    $("folderList").append(item);
    picks.push({file,check});
  }
  if (picks.length) {
    const add = el("button","Добавить выбранные");
    add.type = "button";
    add.onclick = () => {
      const selected = picks.filter(p=>p.check.checked).map(p=>p.file);
      if (selected.length) addFiles(selected,projectDraft.files,t=>{$("projectStatus").textContent=t;});
    };
    $("folderList").prepend(add);
  }
  $("projectStatus").textContent = candidates.length
    ? "Выберите файлы, которые нужны модели. Показано " + Math.min(300,candidates.length) + " из " + candidates.length + "."
    : "В папке не найдено подходящих исходников.";
}
function attachLocalScreenCapture(data) {
  if (busy || taskBusy || draftLoading || voice || pending.length >= 12 ||
      pending.filter(file => file.mime).length >= 2 ||
      typeof data !== "string" || data.length > 2796204) return false;
  pending.push({name:"Снимок окна.jpg",mime:"image/jpeg",data,localOnly:true});
  active.mode = "local";
  save();
  showPending(true);
  sync();
  notice("Снимок приложен. Запрос выполнит модель на Mac.");
  return true;
}

function localContext(attachments = pending) {
  const project = projectOf(active);
  const instructions = [settings.instructions,
    !active.temp && settings.memoryOn && settings.memory ? "Память:\n"+settings.memory : "",
    project?.instructions ? "Инструкции проекта:\n"+project.instructions : ""].filter(Boolean).join("\n\n");
  const sources = [...attachments.map(file => ({file,origin:"Вложение"})),
    ...(project?.files || []).map(file => ({file,origin:"Проект"}))];
  let context = "";
  const entries = sources.map(({file,origin}) => {
    if (file.mime) return {name:file.name,origin,image:true,truncated:false};
    const text = file.text || "";
    const header = (context ? "\n\n" : "") + "Файл: " + file.name + "\n";
    const available = Math.max(0,contextLimit - context.length - header.length);
    // Do not leave half of a UTF-16 surrogate pair at the limit.
    const fragment = text.slice(0, available).replace(/[\uD800-\uDBFF]$/u,"");
    if (fragment) context += header + fragment;
    return {name:file.name,origin,fragment,length:text.length,
      truncated:!!file.truncated || fragment.length < text.length};
  });
  return {context,entries,images:attachments.filter(file=>file.mime),instructions};
}

function renderContextPreview(entries = localContext().entries) {
  $("contextPreview").hidden = !entries.length;
  const truncated = entries.filter(item=>item.truncated).length;
  $("contextSummary").textContent = "Контекст запроса · " + entries.length +
    (truncated ? " · сокращено: " + truncated : "");
  $("contextFiles").replaceChildren(...entries.map(item=>{
    const caption = item.origin + " · " + item.name + " — " + (item.image ? "изображение"
      : !item.fragment ? "не войдёт в запрос"
      : item.fragment.length.toLocaleString("ru") + " знаков" + (item.truncated ? ", только начало" : ""));
    if (!item.fragment) return el("div",caption,"context-entry");
    const details = el("details",undefined,"context-entry");
    details.append(el("summary",caption),el("pre",item.fragment));
    return details;
  }));
  return truncated;
}
async function startVoice() {
  if (voice) {voice.stop(); return;}
  if (!voiceReady || busy || taskBusy) return;
  let stream;
  taskBusy = true;
  sync();
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:true});
    voice = new MediaRecorder(stream);
    const chunks = [];
    voice.ondataavailable = e => chunks.push(e.data);
    voice.onstop = async () => {
      clearTimeout(voiceTimer);
      stream.getTracks().forEach(t=>t.stop());
      voice = null;
      taskBusy = true;
      $("mic").textContent = "🎙";
      sync();
      notice("Распознаю речь на Mac…");
      let failure;
      try {
        const info = await localTool("transcribe",{data:await asBase64(new Blob(chunks))});
        if (!info.text) throw new Error("Речь не распознана.");
        $("draft").value = [$("draft").value,info.text].filter(Boolean).join(" ").slice(0,60000);
        saveDraftText();
      } catch (err) { failure = err.message || "Не удалось распознать запись."; }
      taskBusy = false;
      sync();
      if (failure) notice(failure);
      $("draft").focus();
    };
    voice.start();
    taskBusy = false;
    voiceTimer = setTimeout(()=>{ if (voice?.state==="recording") voice.stop(); },60000);
    $("mic").textContent = "■";
    sync();
    notice("Запись на Mac. Нажмите ■ для остановки (до 60 секунд).");
  } catch {
    stream?.getTracks().forEach(t=>t.stop());
    voice = null;
    taskBusy = false;
    sync();
    notice("Не удалось открыть микрофон. Проверьте разрешение браузера.");
  }
}
function speak(text) {
  if (!window.speechSynthesis) {notice("Озвучивание недоступно в этом браузере."); return;}
  if (speechSynthesis.speaking) {speechSynthesis.cancel(); return;}
  const lang = /[а-яё]/i.test(text) ? "ru" : "en";
  const v = speechSynthesis.getVoices().find(v=>v.localService && v.lang.toLowerCase().startsWith(lang));
  if (!v) {notice("Для этого языка не найден установленный локальный голос macOS."); return;}
  const utterance = new SpeechSynthesisUtterance(text.slice(0,8000));
  utterance.voice=v;
  speechSynthesis.speak(utterance);
}
function bootWorkspace() {
  projects = read("localchat.projects",[]);
  $("chatSearch").oninput = renderSidebar;
  $("projectFilter").onchange = renderSidebar;
  $("showArchive").onchange = renderSidebar;
  $("chatMenu").onclick = chatDialog;
  $("chatExport").onclick = () => downloadText(active.title+".md",historyMarkdown(active));
  $("actionCancel").onclick = () => $("actionDialog").close();
  $("actionAccept").onclick = () => $("actionDialog").close("accept");
  $("chatClose").onclick = () => $("chatDialog").close();
  $("chatDelete").onclick = async () => {
    const target = active;
    if (!await confirmAction("Удалить чат?", "Будут удалены переписка, черновик и текст редактора.", "Удалить чат")
        || active !== target) return;
    chats = chats.filter(chat=>chat!==target);
    if (!target.temp) {
      try { localStorage.removeItem("localchat.draft." + target.id); } catch {}
      composerFiles.delete(target.id);
      void storeComposerFiles(target.id, []);
    }
    $("chatDialog").close();
    if (chats.length) selectChat(chats.find(chat=>!chat.archived) || chats[0]); else newChat();
    notice("Чат удалён.");
  };
  $("chatForm").onsubmit = e => {
    e.preventDefault();
    Object.assign(active,{title:$("chatName").value.trim() || "Чат",project:$("chatProject").value,
      pinned:!active.temp && $("pinned").checked, archived:!active.temp && $("archived").checked,
      cloudBudget:Number($("cloudBudget").value)});
    if (active.archived) $("showArchive").checked = true;
    $("chatDialog").close();
    save(); render();
  };
  $("projects").onclick = () => {
    const id = $("projectFilter").value || active.project;
    projectChoices($("projectEdit"),"＋ Новый проект",id);
    setProjectDraft($("projectEdit").value);
    $("projectDialog").showModal();
    $("projectName").focus();
  };
  $("projectEdit").onchange = () => {
    if (!taskBusy) setProjectDraft($("projectEdit").value);
  };
  $("projectForm").onsubmit = e => {
    e.preventDefault();
    if (taskBusy) return;
    projectDraft.name = $("projectName").value.trim();
    if (!projectDraft.name) return;
    projectDraft.instructions = $("projectInstructions").value.trim();
    const found = projects.findIndex(p=>p.id===projectDraft.id);
    if (found === -1) projects.push(projectDraft); else projects[found] = projectDraft;
    const id = projectDraft.id;
    $("projectDialog").close();
    projectChoices($("projectFilter"),"Все чаты",id);
    if (!active.messages.length && !active.temp) active.project = id;
    save(); render();
  };
  $("projectClose").onclick = () => {if (!taskBusy) $("projectDialog").close();};
  $("projectDialog").oncancel = e=>{if (taskBusy) e.preventDefault();};
  $("projectAttach").onclick = () => $("projectUpload").click();
  $("projectUpload").onchange = e => {
    addFiles(e.target.files,projectDraft.files,t=>{$("projectStatus").textContent=t;});
    e.target.value="";
  };
  $("projectFolder").onclick = () => $("folderUpload").click();
  $("folderUpload").onchange = e => { folderPicker(e.target.files); e.target.value=""; };
  $("prefs").onclick = () => {
    $("memoryOn").checked = !!settings.memoryOn;
    $("memory").value = settings.memory || "";
    $("instructions").value = settings.instructions || "";
    $("prefsDialog").showModal();
  };
  $("prefsClose").onclick = ()=>$("prefsDialog").close();
  $("prefsForm").onsubmit=e=>{
    e.preventDefault();
    Object.assign(settings,{memoryOn:$("memoryOn").checked,memory:$("memory").value.trim(),
      instructions:$("instructions").value.trim()});
    $("prefsDialog").close(); save();
  };
  $("canvas").onclick = () => canvasOpen();
  $("canvasClose").onclick = () => { $("canvasPane").hidden=true; };
  $("canvasUndo").onclick = () => {
    if (!active.canvasPrevious) return;
    [active.canvas, active.canvasPrevious] = [active.canvasPrevious, active.canvas];
    refreshCanvas();
    save();
  };
  $("draft").oninput = saveDraftText;
  for (const id of ["canvasName","canvasText"]) $(id).oninput=()=>{
    active.canvas={name:$("canvasName").value,text:$("canvasText").value};
    $("diffPreview").hidden=true;
    save();
  };
  $("canvasAttach").onclick = () => {
    const text=$("canvasText").value.trim();
    if (!text || pending.length>=12 || busy) return;
    pending.push({name:$("canvasName").value.trim() || "редактор.md",text:text.slice(0,24000),truncated:text.length>24000});
    showPending(true); $("draft").focus();
    if (window.innerWidth<940) $("canvasPane").hidden=true;
  };
  $("canvasPreview").onclick = () => {
    const preview = $("diffPreview");
    preview.hidden = !preview.hidden;
    if (preview.hidden) return;
    preview.replaceChildren(...$("canvasText").value.split("\n").slice(0,1500).map(line =>
      el("span",line+"\n",/^\+/.test(line) ? "addition" : /^-/.test(line) ? "removal" : /^@@/.test(line) ? "hunk" : "")));
  };
  $("canvasDownload").onclick = ()=>downloadText($("canvasName").value || "редактор.md",$("canvasText").value);
  $("attach").onclick=()=>$("upload").click();
  $("upload").onchange=e=>{addFiles(e.target.files,pending,notice); e.target.value="";};
  $("mic").onclick=startVoice;
  fetch("/api/capabilities").then(r=>r.json()).then(x=>{voiceReady=!!x.voice; sync();}).catch(()=>{});
  window.speechSynthesis?.getVoices();
}
