"use strict";

const connectionAccounts = new Map([
  ["https://api.deepseek.com/chat/completions", ["https://platform.deepseek.com/usage", true]],
  ["https://api.deepseek.com/v1/chat/completions", ["https://platform.deepseek.com/usage", true]],
  ["https://api.openai.com/v1/chat/completions", ["https://platform.openai.com/settings/organization/billing/overview", false]],
  ["https://api.anthropic.com/v1/messages", ["https://platform.claude.com/settings/billing", false]],
  ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", ["https://aistudio.google.com/billing", false]]
]);
const connectionChecks = new Map();
const connectionReplies = new Map();
const runningProbes = new Set();
function rememberCatalog(id, model, result) {
  const previous=connectionChecks.get(id);
  connectionChecks.set(id,{model,models:result.models,partial:result.partial,automatic:previous?.automatic,
    at:Date.now(),state:result.models.includes(model) ? "verified" : result.partial ? "unsupported" : "not_listed"});
}
function rememberReply(id, reply) {
  if (!connectionReplies.has(id)) connectionReplies.set(id,new Map());
  connectionReplies.get(id).set(reply.model,reply);
}
function displayedProfile(id) {
  const target=currentTarget();
  return target.mode==="cloud" && target.profileId===id ? target.provider : settings.providers[id];
}
function catalogDetail(id,model) {
  const check=connectionChecks.get(id);
  if (check?.pending) return "Каталог проверяется";
  if (check?.models?.includes(model) || (check?.model===model && check.state==="verified" && !check.hasBalance)) return "Модель есть в каталоге";
  if (check?.models && !check.partial || check?.model===model && check.state==="not_listed") return "Модели нет в каталоге";
  return check?.model===model && check.state==="error" ? "Ошибка проверки каталога" : "Каталог не подтверждён";
}
let pickerRevision=0;

function chooseTarget(choice, mode, defaultModel, preset, profiles) {
  const effectiveMode=choice?.mode || mode;
  const profileId=choice?.mode==="cloud" ? choice.profileId : preset;
  const configured=profiles[profileId];
  const provider=choice?.mode==="cloud" && configured
    ? {...configured,model:choice.model || configured.model} : configured;
  return {mode:effectiveMode,profileId,provider,
    localModel:choice?.mode==="local" ? choice.model : defaultModel,
    planModel:choice?.mode==="plan" ? choice.model : ""};
}

function currentTarget() {
  return chooseTarget(active.modelChoice,active.mode,settings.local,settings.preset,settings.providers);
}


function endpointHost(endpoint) {
  try { return new URL(endpoint).hostname; } catch { return ""; }
}

function requestRoute({mode,allow,exhausted,ready,planReady,localReady,localOnly,hasFiles,hasImages,shareContext}) {
  const block = detail => ({kind:"blocked",detail});
  const local = detail => localReady
    ? {kind:"local",detail}
    : block("Выберите установленную локальную модель и убедитесь, что Ollama запущена.");
  if (localOnly && mode !== "local") return block("Для снимка окна выберите «Только Mac».");
  if (mode === "local") return local("Запросы остаются на этом Mac.");
  if (mode === "auto") {
    if (!allow) return local("Облако выключено для этого чата.");
    if (exhausted) return local("Лимит облачных попыток исчерпан.");
    if (!ready) return local("API не настроен для этого сеанса.");
    if (hasFiles && !shareContext) return local("Файлы остаются на Mac: отправка не разрешена.");
    return localReady ? {kind:"auto"} : local("");
  }
  if (exhausted) return block("Лимит облачных попыток исчерпан. Выберите «Только Mac» или измените лимит чата.");
  if (!allow) return block("Разрешите облако в этом чате.");
  if (mode === "plan" && !planReady) return block("Подключите тариф ChatGPT в «Аккаунты и API».");
  if (mode === "cloud" && !ready) return block("Выберите API и введите ключ в «Аккаунты и API».");
  if (mode === "plan" && hasImages) return block("Тариф ChatGPT принимает здесь только текст. Для изображений выберите Mac или API.");
  if (hasFiles && !shareContext) return block("Разрешите отправку файлов или выберите «Только Mac».");
  return {kind:mode === "plan" ? "plan" : "api"};
}

function nextRoute(attachments = pending, data = localContext(attachments), target = currentTarget()) {
  return requestRoute({
    mode:target.mode, allow:active.allow, exhausted:budgetExhausted(),
    ready:!!(target.provider?.model && target.provider?.endpoint && apiKeys.get(target.profileId)),
    planReady:!!accountFetch && chatgptAccount.sharing, localReady:installed.includes(target.localModel),
    localOnly:attachments.some(file=>file.localOnly), hasFiles:!!data.context || data.images.length > 0,
    hasImages:data.images.length > 0, shareContext:active.shareContext
  });
}

function localPickerOptions(model) {
  const selected=model || (installed.includes(settings.local) ? settings.local : installed[0]) || settings.local;
  const unavailable=!installed.includes(selected);
  const options=installed.map(id=>new Option(id,id));
  if (unavailable && selected) options.unshift(new Option(selected+" · не найдена",selected));
  $("nextLocalModel").replaceChildren(...options);
  $("nextLocalModel").value=selected;
}

function updateNextPicker(choice) {
  const revision=++pickerRevision;
  const source=$("nextSource").value;
  const profile=settings.providers[source];
  $("nextLocalField").hidden=source!=="local";
  $("nextApiField").hidden=!(source in presets);
  $("nextCatalogField").hidden=true;
  $("nextCatalog").replaceChildren();
  $("nextLoadCatalog").hidden=!(source==="plan" || source in presets);
  $("nextLoadCatalog").disabled=source==="plan" ? !accountFetch || !chatgptAccount.sharing
    : !profile?.endpoint || !apiKeys.get(source);
  $("nextApiModel").value=choice?.model || profile?.model || "";
  $("nextPickerStatus").textContent=source==="plan"
    ? (chatgptAccount.sharing ? "Без выбора модели будет использована модель тарифа по умолчанию."
      : "Подключите тариф в «Аккаунты и API».")
    : source in presets && (!profile?.endpoint || !apiKeys.get(source))
      ? "Укажите адрес и ключ в «Аккаунты и API»." : "";
  if (source==="local") {
    localPickerOptions(choice?.model);
    const original=$("nextLocalModel").value;
    void loadModels().then(()=>{
      if (revision!==pickerRevision || !$("nextRouteDialog").open) return;
      const current=$("nextLocalModel").value;
      localPickerOptions(choice?.model || current!==original ? current : undefined);
      $("nextPickerStatus").textContent=installed.length ? "" : "Ollama недоступна или нет установленных моделей.";
    });
  }
  if (source==="plan" && choice?.model) {
    $("nextCatalog").replaceChildren(new Option("По умолчанию тарифа",""),new Option(choice.model,choice.model));
    $("nextCatalog").value=choice.model;
    $("nextCatalogField").hidden=false;
  }
}

function setupNextPicker() {
  const dialog=$("nextRouteDialog");
  $("pickNextRoute").onclick=()=>{
    const choice=active.modelChoice;
    const selected=choice?.mode==="cloud" ? choice.profileId : choice?.mode || "default";
    const apiOptions=Object.keys(presets).map(id=>{
      const profile=settings.providers[id];
      return new Option("API · " + presets[id].name + (profile?.model ? " · "+profile.model : "")
        + (apiKeys.get(id) ? "" : " · без ключа"),id);
    });
    $("nextSource").replaceChildren(new Option("По умолчанию для режима чата","default"),new Option("Этот Mac · Ollama","local"),
      ...apiOptions,new Option("Тариф ChatGPT","plan"));
    $("nextSource").value=selected;
    dialog.showModal();
    updateNextPicker(choice);
    $("nextSource").focus();
  };
  $("nextSource").onchange=()=>updateNextPicker();
  $("nextRouteClose").onclick=()=>dialog.close();
  dialog.onclose=()=>{pickerRevision++;};
  $("nextLoadCatalog").onclick=async ()=>{
    const revision=++pickerRevision;
    const source=$("nextSource").value;
    const selected=source==="plan" ? $("nextCatalog").value : $("nextApiModel").value.trim();
    $("nextLoadCatalog").disabled=true;
    $("nextPickerStatus").textContent="Загружаем список моделей без генерации…";
    try {
      const profile=settings.providers[source];
      let result, options;
      if (source==="plan") {
        const response=await accountFetch("/api/account/models");
        result=await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "Не удалось загрузить модели тарифа.");
        options=result.models.map(item=>new Option(item.name,item.id));
      } else {
        result=await localTool("cloud-models",{endpoint:profile.endpoint,key:apiKeys.get(source),kind:profile.kind,network:profile.network});
        if (result.state!=="verified") throw new Error(result.message);
        options=result.models.map(id=>new Option(id,id));
      }
      if (revision!==pickerRevision || !dialog.open) return;
      if (source in presets) rememberCatalog(source,selected,result);
      const actual=options.length;
      if (selected && source==="plan" && !options.some(o=>o.value===selected))
        options.unshift(new Option(selected+" · не найдена",selected));
      $("nextCatalog").replaceChildren(new Option(source==="plan" ? "По умолчанию тарифа" : "Выберите модель",""),...options);
      $("nextCatalog").value=options.some(o=>o.value===selected) ? selected : "";
      $("nextCatalogField").hidden=!options.length;
      $("nextPickerStatus").textContent=actual ? "Моделей в каталоге: "+actual+(result.partial ? " · показаны первые страницы" : "")
        : "Список моделей пуст.";
    } catch (error) {
      if (revision===pickerRevision && dialog.open) $("nextPickerStatus").textContent=error.message;
    } finally {
      if (revision===pickerRevision && dialog.open) $("nextLoadCatalog").disabled=false;
    }
  };
  $("nextCatalog").onchange=()=>{
    if ($("nextSource").value!=="plan" && $("nextCatalog").value) $("nextApiModel").value=$("nextCatalog").value;
  };
  $("nextRouteForm").onsubmit=event=>{
    event.preventDefault();
    const source=$("nextSource").value;
    if (source==="default") delete active.modelChoice;
    else if (source==="local") {
      if (!$("nextLocalModel").value) { $("nextPickerStatus").textContent="Выберите локальную модель."; return; }
      active.modelChoice = {mode:"local",model:$("nextLocalModel").value};
    } else if (source==="plan") {
      active.modelChoice = {mode:"plan",model:$("nextCatalog").value};
    } else {
      const model = $("nextApiModel").value.trim() || settings.providers[source]?.model;
      if (!model) { $("nextPickerStatus").textContent="Укажите ID модели API."; return; }
      active.modelChoice = {mode:"cloud",profileId:source,model};
    }
    save();
    dialog.close();
    clearNotice();
    sync();
  };
}

function budgetExhausted() {
  return !!active.cloudBudget && (active.cloudCalls || 0)>=active.cloudBudget;
}

function apiResource(profile) {
  const host = endpointHost(profile?.endpoint);
  return [profile?.name,host,profile?.network==="wifi" ? "Wi-Fi вне VPN" : ""].filter(Boolean).join(" · ");
}

function apiOwner(profile) {
  return profile?.billingLabel ? "Метка профиля: " + profile.billingLabel : "Аккаунт или проект владельца ключа; имя не подтверждено";
}

function renderRoute() {
  if (!active) return;
  const target=currentTarget();
  const profile=target.provider;
  const route=nextRoute(undefined,undefined,target);
  const account=chatgptAccount.account;
  let title, detail;
  const privacy=[active.history ? "с историей" : "без истории", active.shareContext ? "файлы и настройки разрешены" : "файлы и настройки остаются на Mac"].join(" · ");
  if (busy) {
    title="Запрос выполняется";
    detail="Фактический источник указан у ответа.";
  } else if (route.kind==="blocked") {
    title=modelsLoading && (target.mode==="auto" || target.mode==="local") ? "Проверяем Ollama…" : "Отправка недоступна";
    detail=title==="Проверяем Ollama…" ? "Проверяем список установленных моделей на Mac." : route.detail;
  } else if (route.kind==="local") {
    title="Только этот Mac · Ollama";
    detail=[target.localModel,route.detail,"Внешний API и подписка не используются."].join(" · ");
  } else if (route.kind==="plan") {
    title="Тариф ChatGPT" + (account ? " · " + account : "");
    detail=[target.planModel,privacy].filter(Boolean).join(" · ");
  } else {
    title=route.kind==="auto" ? "Авто · Mac или API " + apiResource(profile) : "API · " + apiResource(profile);
    const last=connectionReplies.get(target.profileId)?.get(profile.model);
    detail=[apiOwner(profile),route.kind==="auto" ? "Mac выбирает маршрут" : profile.model,
      apiKeyBridge ? "Ключ сохранён" : "Ключ в сеансе",catalogDetail(target.profileId,profile.model),
      last ? (last.ok ? "Ответ получен" : "Ошибка генерации") : "Генерация не проверена",privacy].filter(Boolean).join(" · ");
  }
  const choice=active.modelChoice;
  if (choice && !busy && route.kind==="blocked") {
    const requested=choice.mode==="local" ? choice.model : choice.mode==="plan" ? "Тариф ChatGPT"+(target.planModel ? " · "+target.planModel : "")
      : "API · " + (apiResource(profile) || presets[choice.profileId].name) + (profile?.model ? " · "+profile.model : "");
    detail=requested + " — " + detail;
  }
  $("pickNextRoute").dataset.picked=!!choice;
  $("pickNextRoute").textContent=choice ? "Сменить модель" : "Выбрать модель";
  $("routeCard").dataset.tone=busy ? "idle" : route.kind;
  if ($("routeTitle").textContent!==title) $("routeTitle").textContent=title;
  if ($("routeDetail").textContent!==detail) $("routeDetail").textContent=detail;
}

let balanceProfile = "";

function connectionReady(id) {
  const profile = settings.providers[id];
  return Boolean(profile?.endpoint && profile?.model && apiKeys.get(id));
}

function connectionButton() {
  const count = Object.keys(presets).filter(connectionReady).length;
  const answered=Object.keys(presets).filter(id=>connectionReady(id) && connectionReplies.get(id)?.get(displayedProfile(id)?.model)?.ok).length;
  $("connections").textContent = count || chatgptAccount.sharing
    ? "Аккаунты и API · " + [count ? "API: "+count+" · ответили: "+answered : "",chatgptAccount.sharing ? "ChatGPT" : ""].filter(Boolean).join(" + ")
    : "Аккаунты и API";
}

function connectionChanged(id, oldProfile, oldKey) {
  const profile = settings.providers[id];
  const endpointChanged = oldProfile && oldProfile.endpoint !== profile.endpoint;
  if (endpointChanged || (oldKey && apiKeys.get(id) && oldKey !== apiKeys.get(id))) {
    delete settings.balanceSnapshots[id];
  }
  if (endpointChanged || oldProfile?.kind !== profile.kind || oldProfile?.model !== profile.model || (oldProfile?.network || "") !== (profile.network || "") || oldKey !== apiKeys.get(id)) {
    connectionChecks.delete(id);
    connectionReplies.delete(id);
  }
  renderConnections();
}

function displayAmount(amount, currency) {
  // Format the original decimal string so small amounts and large balances stay exact.
  const [whole, fraction] = amount.split(".");
  const grouping = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return grouping + (fraction ? "," + fraction : "") + " " + currency;
}

function displayTime(date) {
  return new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short"}).format(new Date(date));
}

function connectionBadge(profile, key, check) {
  if (!profile?.model || !profile?.endpoint) return ["Не настроен", ""];
  if (!key) return ["Нужен ключ", ""];
  if (check?.pending) return ["Проверяем…", ""];
  if (check?.state === "verified") return [check.hasBalance ? "Баланс получен" : "Модель видна по ключу", "good"];
  if (check?.state === "unsupported") return ["Проверка недоступна", ""];
  if (check?.state === "not_listed") return ["Модель не в каталоге", "warning"];
  if (check?.state === "unavailable") return ["Вызовы недоступны", "warning"];
  if (check?.state === "error") return ["Ошибка проверки", "warning"];
  return ["Ключ есть · не проверен", ""];
}

function balanceLine(profile, check, manual) {
  if (check?.automatic?.balances.length) {
    return [
      check.automatic.balances.map(b => displayAmount(b.amount,b.currency)).join(" · "),
      "DeepSeek · " + displayTime(check.automatic.at)
    ];
  }
  if (manual && manual.endpoint === profile?.endpoint) {
    return [displayAmount(manual.amount,manual.currency), "Ручная запись, не сверена с ключом · " + displayTime(manual.at)];
  }
  if (connectionAccounts.get(profile?.endpoint)?.[1]) return ["Баланс пока не получен", ""];
  if (!profile?.endpoint) return ["Баланс появится после настройки", ""];
  return [connectionAccounts.has(profile.endpoint) ? "Остаток в кабинете провайдера" : "Остаток можно записать вручную", ""];
}

function renderConnections() {
  const localReady=installed.includes(settings.local);
  $("localConnectionState").textContent=localReady ? "Модель установлена" : modelsLoading ? "Проверяем Ollama…" : "Локальная модель недоступна";
  $("localConnectionState").className="connection-status " + (localReady ? "good" : modelsLoading ? "" : "warning");
  $("localConnectionDetail").textContent=localReady ? settings.local : "Запустите Ollama и выберите локальную модель.";
  const list = $("connectionList");
  const order = Object.keys(presets).sort((a,b) =>
    Number(connectionReady(b))-Number(connectionReady(a)) ||
    Number(b===settings.preset)-Number(a===settings.preset));
  list.replaceChildren(...order.map(id => {
    const profile = displayedProfile(id);
    const key = apiKeys.get(id);
    const check = connectionChecks.get(id);
    const account = connectionAccounts.get(profile?.endpoint);
    const reply = connectionReplies.get(id)?.get(profile?.model);
    const [badge, color] = connectionBadge(profile,key,check?.model===profile?.model ? check : null);
    const card = el("article",undefined,"connection-card");
    const top = el("div",undefined,"connection-row");
    const name = el("strong",presets[id].name);
    const tags = el("div",undefined,"connection-tags");
    tags.append(el("span",badge,"connection-status " + color));
    if (id === settings.preset && connectionReady(id)) tags.append(el("span","API по умолчанию","connection-status chosen"));
    if (reply && !check?.pending && (!check?.at || reply.at >= check.at)) {
      tags.append(el("span",reply.ok ? "Ответ получен" : "Последний запрос без ответа","connection-status " + (reply.ok ? "good" : "warning")));
    }
    top.append(name,tags);
    card.append(top);
    if (key) card.append(el("small",(apiKeyBridge ? "Ключ сохранён в macOS" : "Ключ введён для сеанса")+" · "+catalogDetail(id,profile?.model)));
    if (profile?.model) card.append(el("small",profile.model,"connection-model"));
    if (profile?.endpoint) {
      const host=endpointHost(profile.endpoint);
      if (host) card.append(el("small",host,"connection-model"));
      card.append(el("small",apiOwner(profile),"connection-model"));
    }
    if (reply) card.append(el("small","Генерация: " + (reply.ok ? "получен полный ответ" : "полный ответ не подтверждён") + (reply.model ? " · "+reply.model : "") + " · " + displayTime(reply.at)));
    else if (key) card.append(el("small","Генерация в этом сеансе не проверена."));
    if (reply?.error) card.append(el("small",reply.error,"connection-warning"));
    if (check?.at) card.append(el("small","Проверка без генерации · " + displayTime(check.at)));
    const [amount, detail] = balanceLine(profile,check,settings.balanceSnapshots[id]);
    const balance = el("div",undefined,"connection-balance");
    balance.append(el("span",amount));
    if (detail) balance.append(el("small",detail));
    card.append(balance);
    if (check?.message) card.append(el("small",check.message,"connection-warning"));
    const actions = el("div",undefined,"connection-actions");
    if (account) {
      const link = el("a","Кабинет");
      link.href = account[0];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actions.append(link);
    }
    if (profile?.endpoint && !account?.[1]) {
      const manual = el("button",settings.balanceSnapshots[id] ? "Обновить вручную" : "Записать баланс");
      manual.type = "button";
      manual.onclick = () => openBalance(id);
      actions.append(manual);
    }
    if (key && profile?.model) {
      const test=el("button",runningProbes.has(id) ? "Ожидаем ответ…" : "Проверить коротким запросом");
      test.type="button"; test.disabled=runningProbes.has(id);
      test.onclick=()=>probeConnection(id);
      actions.append(test);
    }
    const edit = el("button","Настроить");
    edit.type = "button";
    edit.onclick = () => openModelSettings(id);
    actions.append(edit);
    card.append(actions);
    return card;
  }));
  const inFlight = [...connectionChecks.values()].some(check => check.pending);
  const canCheck = order.some(connectionReady);
  $("refreshConnections").disabled = inFlight || !canCheck;
  $("refreshConnections").textContent = inFlight ? "Проверяем подключения…" : "Проверить подключения";
  connectionButton();
  renderRoute();
}

async function verifyConnections() {
  const checks = Object.keys(presets).filter(connectionReady);
  const jobs = checks.map(async id => {
    const {endpoint,model,kind,network} = displayedProfile(id);
    const key = apiKeys.get(id);
    const current = {pending:true, model, automatic:connectionChecks.get(id)?.automatic};
    connectionChecks.set(id,current);
    try {
      const official=connectionAccounts.has(endpoint);
      const result = official ? await localTool("connection-status",{endpoint,model,key,network})
        : await localTool("cloud-models",{endpoint,kind,key,network});
      if (!official && result.state==="verified" && !result.models.includes(model)) {
        result.state = result.partial ? "unsupported" : "not_listed";
        result.message = result.partial ? "Каталог неполный; доступ к выбранной модели неизвестен." : "Каталог не подтвердил доступ к выбранной модели.";
      }
      current.models=result.models;
      current.partial=result.partial;
      if (result.balances) {
        current.automatic = {balances:result.balances,at:Date.now()};
        const catalog=await localTool("cloud-models",{endpoint,kind,key,network});
        if (catalog.state==="verified") { current.models=catalog.models; current.partial=catalog.partial; }
      }
      current.state = result.state;
      current.message = result.message;
      current.hasBalance=Array.isArray(result.balances);
      if (result.balances) current.automatic = {balances:result.balances,at:Date.now()};
    } catch {
      current.state = "error";
      current.message = "Не удалось выполнить проверку. Повторите позже.";
    } finally {
      current.pending = false;
      current.at = Date.now();
      renderConnections();
    }
  });
  renderConnections();
  await Promise.all(jobs);
}

async function probeConnection(id) {
  const profile=displayedProfile(id), key=apiKeys.get(id);
  if (runningProbes.has(id) || !key || !profile?.model) return;
  const owner=apiOwner(profile);
  const accepted=await confirmAction("Проверить генерацию?",[profile.model,apiResource(profile),owner,
    "Будет отправлен отдельный тест без истории и файлов. Лимит ответа — 128 токенов. Возможны расходы по тарифу API."].join(" · "),"Отправить тест");
  if (!accepted || runningProbes.has(id)) return;
  const configured=settings.providers[id];
  runningProbes.add(id);
  renderConnections();
  let complete=false, text=false, error="", record;
  try {
    const response=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({mode:"cloud",model:"",provider:{...profile,maxTokens:128},key,allowCloud:true,
        messages:[{role:"user",content:"Ответь одним словом: ОК."}]})});
    for await (const packet of responsePackets(response)) {
      if (packet.source && !record) record=startUsage("api",profile.model,id,profile,owner,true);
      if (record && packet.usage) writeUsage(record,packet.usage);
      if (packet.delta) text=true;
      if (packet.error) throw new Error(packet.error);
      if (packet.done) complete=true;
    }
    if (!complete || !text) throw new Error("Провайдер не вернул полный ответ.");
  } catch (failure) { error=failure.message || "Не удалось получить ответ."; }
  finally {
    if (settings.providers[id]===configured && apiKeys.get(id)===key)
      rememberReply(id,{ok:complete && text && !error,model:profile.model,error,at:Date.now()});
    runningProbes.delete(id);
    renderConnections();
  }
}

function openBalance(id) {
  balanceProfile = id;
  const manual = settings.balanceSnapshots[id];
  $("balanceTitle").textContent = "Баланс · " + presets[id].name;
  $("balanceAmount").value = manual?.amount ?? "";
  $("balanceAmount").setCustomValidity("");
  $("balanceCurrency").value = manual?.currency || "USD";
  $("balanceDelete").hidden = !manual;
  $("balanceDialog").showModal();
}

function setupConnections() {
  const open = () => {
    renderConnections();
    $("connectionsDialog").showModal();
    refreshChatGPT();
  };
  $("connections").onclick = $("routeAccounts").onclick = open;
  $("connectionsClose").onclick = () => $("connectionsDialog").close();
  $("refreshConnections").onclick = verifyConnections;
  $("balanceClose").onclick = () => $("balanceDialog").close();
  $("balanceAmount").oninput = () => $("balanceAmount").setCustomValidity("");
  $("balanceForm").onsubmit = event => {
    event.preventDefault();
    const field = $("balanceAmount");
    const amount = field.value.trim().replace(/[ \u00a0\u202f]/g,"").replace(",",".");
    if (!/^-?\d{1,15}(?:\.\d{1,8})?$/.test(amount)) {
      field.setCustomValidity("Введите сумму цифрами, например 12,50.");
      field.reportValidity();
      return;
    }
    settings.balanceSnapshots[balanceProfile] = {
      endpoint:settings.providers[balanceProfile].endpoint,amount,
      currency:$("balanceCurrency").value.toUpperCase(),at:Date.now()
    };
    save();
    $("balanceDialog").close();
    renderConnections();
  };
  $("balanceDelete").onclick = () => {
    delete settings.balanceSnapshots[balanceProfile];
    save();
    $("balanceDialog").close();
    renderConnections();
  };
}
