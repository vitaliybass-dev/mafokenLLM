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

function nextRoute(attachments = pending, data = localContext(attachments)) {
  return requestRoute({
    mode:active.mode, allow:active.allow, exhausted:budgetExhausted(), ready:connectionReady(settings.preset),
    planReady:!!accountFetch && chatgptAccount.sharing, localReady:installed.includes(settings.local),
    localOnly:attachments.some(file=>file.localOnly), hasFiles:!!data.context || data.images.length > 0,
    hasImages:data.images.length > 0, shareContext:active.shareContext
  });
}

function budgetExhausted() {
  return !!active.cloudBudget && (active.cloudCalls || 0)>=active.cloudBudget;
}

function apiResource(profile) {
  const host = endpointHost(profile?.endpoint);
  return [profile?.name,host].filter(Boolean).join(" · ");
}

function apiOwner(profile) {
  return profile?.billingLabel ? "Метка профиля: " + profile.billingLabel : "Аккаунт или проект владельца ключа; имя не подтверждено";
}

function renderRoute() {
  if (!active) return;
  const profile=settings.providers[settings.preset];
  const route=nextRoute();
  const account=chatgptAccount.account;
  let title, detail;
  const privacy=[active.history ? "с историей" : "без истории", active.shareContext ? "файлы и настройки разрешены" : "файлы и настройки остаются на Mac"].join(" · ");
  if (busy) {
    title="Запрос выполняется";
    detail="Фактический источник указан у ответа.";
  } else if (route.kind==="blocked") {
    title=modelsLoading && (active.mode==="auto" || active.mode==="local") ? "Проверяем Ollama…" : "Отправка недоступна";
    detail=title==="Проверяем Ollama…" ? "Проверяем список установленных моделей на Mac." : route.detail;
  } else if (route.kind==="local") {
    title="Только этот Mac · Ollama";
    detail=[settings.local,route.detail,"Внешний API и подписка не используются."].join(" · ");
  } else if (route.kind==="plan") {
    title="Тариф ChatGPT" + (account ? " · " + account : "");
    detail=privacy;
  } else {
    title=route.kind==="auto" ? "Авто · Mac или API " + apiResource(profile) : "API · " + apiResource(profile);
    const last=connectionReplies.get(settings.preset);
    const check=connectionChecks.get(settings.preset);
    detail=[apiOwner(profile),route.kind==="auto" ? "Mac выбирает маршрут" : profile.model,
      last?.ok === false ? "последний запрос без ответа" : check?.state === "error" ? "проверка подключения не прошла" : "",privacy].filter(Boolean).join(" · ");
  }
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
  $("connections").textContent = count || chatgptAccount.sharing
    ? "Аккаунты и API · " + [count ? "API: "+count : "",chatgptAccount.sharing ? "ChatGPT" : ""].filter(Boolean).join(" + ")
    : "Аккаунты и API";
}

function connectionChanged(id, oldProfile, oldKey) {
  const profile = settings.providers[id];
  const endpointChanged = oldProfile && oldProfile.endpoint !== profile.endpoint;
  if (endpointChanged || (oldKey && apiKeys.get(id) && oldKey !== apiKeys.get(id))) {
    delete settings.balanceSnapshots[id];
  }
  if (endpointChanged || oldProfile?.model !== profile.model || oldKey !== apiKeys.get(id)) {
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
    const profile = settings.providers[id];
    const key = apiKeys.get(id);
    const check = connectionChecks.get(id);
    const account = connectionAccounts.get(profile?.endpoint);
    const reply = connectionReplies.get(id);
    const [badge, color] = reply && !check ? ["Ключ есть",""] : connectionBadge(profile,key,check);
    const card = el("article",undefined,"connection-card");
    const top = el("div",undefined,"connection-row");
    const name = el("strong",presets[id].name);
    const tags = el("div",undefined,"connection-tags");
    tags.append(el("span",badge,"connection-status " + color));
    if (id === settings.preset && connectionReady(id)) tags.append(el("span","Выбран для API","connection-status chosen"));
    if (reply && !check?.pending && (!check?.at || reply.at >= check.at)) {
      tags.append(el("span",reply.ok ? "Ответ получен" : "Последний запрос без ответа","connection-status " + (reply.ok ? "good" : "warning")));
    }
    top.append(name,tags);
    card.append(top);
    if (profile?.model) card.append(el("small",profile.model,"connection-model"));
    if (profile?.endpoint) {
      const host=endpointHost(profile.endpoint);
      if (host) card.append(el("small",host,"connection-model"));
      card.append(el("small",apiOwner(profile),"connection-model"));
    }
    if (reply) card.append(el("small","Генерация: " + (reply.ok ? "получен полный ответ" : "полный ответ не подтверждён") + " · " + displayTime(reply.at)));
    else if (key) card.append(el("small","Генерация в этом сеансе не проверена."));
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
    const {endpoint,model,kind} = settings.providers[id];
    const key = apiKeys.get(id);
    const current = {pending:true, automatic:connectionChecks.get(id)?.automatic};
    connectionChecks.set(id,current);
    try {
      const official=connectionAccounts.has(endpoint);
      const result = official ? await localTool("connection-status",{endpoint,model,key})
        : await localTool("cloud-models",{endpoint,kind,key});
      if (!official && result.state==="verified" && !result.models.includes(model)) {
        result.state = result.partial ? "unsupported" : "not_listed";
        result.message = result.partial ? "Каталог неполный; доступ к выбранной модели неизвестен." : "Каталог не подтвердил доступ к выбранной модели.";
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
