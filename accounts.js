"use strict";

const accountFetch = globalThis.mafokenAccountFetch;
const desktopAccountOnly = "Вход и тариф ChatGPT доступны в приложении mafokenLLM для macOS.";
let chatgptAccount = {available:!!accountFetch,status:"disconnected",sharing:false,
  error:accountFetch ? "" : desktopAccountOnly};
let accountPoll, accountRevision=0;

function renderChatGPT() {
  const state=chatgptAccount;
  const connecting=state.status==="connecting";
  const connected=state.status==="connected";
  $("chatgptState").textContent=connecting ? "Ожидаем вход в браузере…" :
    connected ? (state.account || "Вход выполнен") :
    state.status==="reauth_required" ? "Требуется повторный вход" : "Вход не выполнен";
  $("chatgptNote").textContent=state.error || (state.sharing ? "Тариф подключён. Выберите «Тариф ChatGPT» в чате."
    : connected ? "Войдите повторно и разрешите использование тарифа."
    : "Используйте поддерживаемый тариф ChatGPT без ключа API.");
  $("chatgptSignIn").hidden=connecting || state.sharing;
  $("chatgptSignIn").disabled=!state.available;
  $("chatgptCancel").hidden=!connecting;
  $("chatgptDisconnect").hidden=connecting || !["connected","reauth_required"].includes(state.status);
  if (active?.mode==="plan" && !busy) status();
}

function applyChatGPT(state) {
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
