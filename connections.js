"use strict";

const connectionAccounts = new Map([
  ["https://api.deepseek.com/chat/completions", ["https://platform.deepseek.com/usage", true]],
  ["https://api.deepseek.com/v1/chat/completions", ["https://platform.deepseek.com/usage", true]],
  ["https://api.openai.com/v1/chat/completions", ["https://platform.openai.com/settings/organization/billing/overview", false]],
  ["https://api.anthropic.com/v1/messages", ["https://platform.claude.com/settings/billing", false]],
  ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", ["https://aistudio.google.com/billing", false]]
]);
const connectionChecks = new Map();
let balanceProfile = "";

function connectionReady(id) {
  const profile = settings.providers[id];
  return Boolean(profile?.endpoint && profile?.model && apiKeys.get(id));
}

function connectionButton() {
  const count = Object.keys(presets).filter(connectionReady).length;
  $("connections").textContent = count ? "Аккаунты и API · " + count : "Аккаунты и API";
}

function connectionChanged(id, oldProfile, oldKey) {
  const profile = settings.providers[id];
  const endpointChanged = oldProfile && oldProfile.endpoint !== profile.endpoint;
  if (endpointChanged || (oldKey && apiKeys.get(id) && oldKey !== apiKeys.get(id))) {
    delete settings.balanceSnapshots[id];
  }
  if (endpointChanged || oldProfile?.model !== profile.model || oldKey !== apiKeys.get(id)) {
    connectionChecks.delete(id);
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
  if (check?.state === "verified") return ["Ключ принят", "good"];
  if (check?.state === "unavailable") return ["Вызовы недоступны", "warning"];
  if (check?.state === "error") return ["Ошибка проверки", "warning"];
  return ["Ключ добавлен", ""];
}

function balanceLine(profile, check, manual) {
  if (check?.automatic?.balances.length) {
    return [
      check.automatic.balances.map(b => displayAmount(b.amount,b.currency)).join(" · "),
      "DeepSeek · " + displayTime(check.automatic.at)
    ];
  }
  if (manual && manual.endpoint === profile?.endpoint) {
    return [displayAmount(manual.amount,manual.currency), "Введено вручную · " + displayTime(manual.at)];
  }
  if (connectionAccounts.get(profile?.endpoint)?.[1]) return ["Баланс пока не получен", ""];
  if (!profile?.endpoint) return ["Баланс появится после настройки", ""];
  return [connectionAccounts.has(profile.endpoint) ? "Остаток в кабинете провайдера" : "Остаток можно записать вручную", ""];
}

function renderConnections() {
  const list = $("connectionList");
  const order = Object.keys(presets).sort((a,b) =>
    Number(connectionReady(b))-Number(connectionReady(a)) ||
    Number(b===settings.preset)-Number(a===settings.preset));
  list.replaceChildren(...order.map(id => {
    const profile = settings.providers[id];
    const key = apiKeys.get(id);
    const check = connectionChecks.get(id);
    const account = connectionAccounts.get(profile?.endpoint);
    const [badge, color] = connectionBadge(profile,key,check);
    const card = el("article",undefined,"connection-card");
    const top = el("div",undefined,"connection-row");
    const name = el("strong",presets[id].name);
    const tags = el("div",undefined,"connection-tags");
    tags.append(el("span",badge,"connection-status " + color));
    if (id === settings.preset && connectionReady(id)) tags.append(el("span","Выбран","connection-status chosen"));
    top.append(name,tags);
    card.append(top);
    if (profile?.model) card.append(el("small",profile.model,"connection-model"));
    if (profile?.endpoint && !account) {
      let host;
      try { host = new URL(profile.endpoint).hostname; } catch { host = ""; }
      if (host) card.append(el("small",host,"connection-model"));
    }
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
  const canCheck = order.some(id => connectionReady(id) && connectionAccounts.has(settings.providers[id].endpoint));
  $("refreshConnections").disabled = inFlight || !canCheck;
  $("refreshConnections").textContent = inFlight ? "Проверяем подключения…" : "Проверить подключения";
  connectionButton();
}

async function verifyConnections() {
  const checks = Object.keys(presets).filter(id =>
    connectionReady(id) && connectionAccounts.has(settings.providers[id].endpoint));
  const jobs = checks.map(async id => {
    const {endpoint,model} = settings.providers[id];
    const key = apiKeys.get(id);
    const current = {pending:true, automatic:connectionChecks.get(id)?.automatic};
    connectionChecks.set(id,current);
    try {
      const result = await localTool("connection-status",{endpoint,model,key});
      current.state = result.state;
      current.message = result.message;
      if (result.balances) current.automatic = {balances:result.balances,at:Date.now()};
    } catch {
      current.state = "error";
      current.message = "Не удалось выполнить проверку. Повторите позже.";
    } finally {
      current.pending = false;
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
  $("connections").onclick = () => {
    renderConnections();
    $("connectionsDialog").showModal();
    refreshChatGPT();
  };
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
