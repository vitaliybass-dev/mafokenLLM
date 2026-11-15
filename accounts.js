"use strict";

let chatgptAccount={available:true,status:"disconnected",sharing:false};
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
  const revision=++accountRevision;
  try {
    const response=await fetch("/api/account");
    if (!response.ok) throw new Error();
    const state=await response.json();
    if (revision===accountRevision) applyChatGPT(state);
  } catch {
    if (revision===accountRevision) applyChatGPT({available:false,status:"disconnected",sharing:false,
      error:"Не удалось проверить вход. Откройте панель ещё раз."});
  }
}

async function accountAction(action) {
  clearTimeout(accountPoll);
  const revision=++accountRevision;
  if (action==="begin") applyChatGPT({...chatgptAccount,status:"connecting",sharing:false,error:""});
  clearTimeout(accountPoll);
  try {
    const state=await localTool("account/"+action,{});
    if (revision===accountRevision) applyChatGPT(state);
  } catch {
    if (revision===accountRevision) applyChatGPT({...chatgptAccount,status:"disconnected",sharing:false,
      error:"Операция не завершилась. Повторите попытку."});
  }
}

function setupChatGPT() {
  $("chatgptSignIn").onclick=()=>accountAction("begin");
  $("chatgptCancel").onclick=()=>accountAction("cancel");
  $("chatgptDisconnect").onclick=()=>accountAction("disconnect");
}
