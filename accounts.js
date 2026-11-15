"use strict";

const accountFetch = globalThis.mafokenAccountFetch;
const desktopAccountOnly = "Вход и тариф ChatGPT доступны в приложении mafokenLLM для macOS.";
let chatgptAccount = {available:!!accountFetch,status:"disconnected",sharing:false,
  error:accountFetch ? "" : desktopAccountOnly};
let accountPoll, accountRevision=0, chatgptReply;
function recordChatGPTReply(owner, reply) {
  chatgptReply={owner,...reply};
  renderChatGPT();
}

function renderChatGPT() {
  const state=chatgptAccount;
  const connecting=state.status==="connecting";
  const connected=state.status==="connected";
  const ready=connected && state.sharing;
  const badge=$("chatgptState");
  badge.textContent=connecting ? "Ожидаем вход в браузере…" :
    ready ? "Тариф подключён" : connected ? "Нужно разрешение" :
    state.status==="reauth_required" ? "Требуется повторный вход" :
    !state.available ? "Проверка недоступна" : "Вход не выполнен";
  badge.className="connection-status " + (ready ? "good" : state.error ? "warning" : "");
  $("chatgptIdentity").textContent=ready ? "Аккаунт: " + (state.account || "имя не сообщено") : "";
  $("chatgptIdentity").hidden=!ready;
  $("chatgptNote").textContent=state.error || (ready ? "Используется квота подключённого тарифа. Баланс API отдельно."
    : connected ? "Войдите повторно и разрешите использование тарифа."
    : "Без входа приложение не использует подписку.");
  const last=chatgptReply?.owner===(state.account || "Подключённый аккаунт ChatGPT") ? chatgptReply : null;
  $("chatgptLast").hidden=!ready;
  $("chatgptLast").textContent=last
    ? "Генерация: " + (last.ok ? "получен полный ответ" : "полный ответ не подтверждён") + " · " + displayTime(last.at)
    : "Генерация в этом сеансе не проверена. Остаток квоты не предоставлен.";
  $("chatgptSignIn").hidden=connecting || state.sharing;
  $("chatgptSignIn").disabled=!state.available;
  $("chatgptCancel").hidden=!connecting;
  $("chatgptDisconnect").hidden=connecting || !["connected","reauth_required"].includes(state.status);
  if (active && !busy) status();
}

function applyChatGPT(state) {
  if (state.status!=="connected" || state.account!==chatgptAccount.account) chatgptReply=null;
  chatgptAccount=state;
  renderChatGPT();
  clearTimeout(accountPoll);
  if (state.status==="connecting") accountPoll=setTimeout(refreshChatGPT,1500);
}

async function refreshChatGPT() {
  if (!accountFetch) { renderChatGPT(); return; }
  const revision=++accountRevision;
  try {
    const response=await accountFetch("/api/account");
    if (!response.ok) throw new Error();
    const state=await response.json();
    if (revision===accountRevision) applyChatGPT(state);
  } catch {
    if (revision===accountRevision) applyChatGPT({available:false,status:"disconnected",sharing:false,
      error:"Не удалось проверить вход. Откройте панель ещё раз."});
  }
}

async function accountAction(action) {
  if (!accountFetch) return;
  clearTimeout(accountPoll);
  const revision=++accountRevision;
  if (action==="begin") applyChatGPT({...chatgptAccount,status:"connecting",sharing:false,error:""});
  clearTimeout(accountPoll);
  try {
    const response=await accountFetch("/api/account/"+action,{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{}"
    });
    if (!response.ok) throw new Error();
    const state=await response.json();
    if (revision===accountRevision) applyChatGPT(state);
  } catch {
    if (revision===accountRevision) applyChatGPT({...chatgptAccount,status:"disconnected",sharing:false,
      error:"Операция не завершилась. Повторите попытку."});
  }
}

function setupChatGPT() {
  renderChatGPT();
  $("chatgptSignIn").onclick=()=>accountAction("begin");
  $("chatgptCancel").onclick=()=>accountAction("cancel");
  $("chatgptDisconnect").onclick=()=>accountAction("disconnect");
}
