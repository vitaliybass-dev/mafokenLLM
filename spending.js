"use strict";

// Each attempt has its own storage entry so concurrent tabs and copied chats cannot duplicate it.
const spendingPrefix = "mafoken.usage.";
function startUsage(resource, model, profileId, profile, owner, probe=false) {
  const record={id:crypto.randomUUID(),at:Date.now(),resource,model,probe};
  if (resource==="api") {
    Object.assign(record,{profileId,endpoint:profile.endpoint,label:profile.name,owner});
    if (profile.priceModel===model) {
      for (const field of ["inputPrice","outputPrice"]) {
        const raw=profile[field], value=Number(raw);
        if (raw!=null && raw!=="" && Number.isFinite(value) && value>=0) record[field]=value;
      }
    }
  } else if (resource==="plan") record.owner=owner;
  writeUsage(record);
  return record;
}
function writeUsage(record, counts) {
  for (const field of ["input","output"]) {
    const value=counts?.[field];
    if (Number.isSafeInteger(value) && value>=0) record[field]=value;
  }
  try { localStorage.setItem(spendingPrefix+record.id,JSON.stringify(record)); }
  catch { storageWarning("Не удалось сохранить статистику расходов."); }
  if ($("spendingDialog").open) renderSpending();
}
function groupUsage(records, period, now=new Date()) {
  const start=new Date(now.getFullYear(),now.getMonth(),period==="month" ? 1 : now.getDate()).getTime();
  const groups=new Map();
  for (const row of records) {
    if (!row || row.at<start || row.at>now.getTime()) continue;
    const id=JSON.stringify([row.resource,row.profileId,row.endpoint,row.owner,row.model]);
    if (!groups.has(id)) groups.set(id,{...row,calls:0,probes:0,tokensIn:0,tokensOut:0,missing:0,priced:0,cost:0});
    const g=groups.get(id);
    g.calls++; if (row.probe) g.probes++;
    g.tokensIn+=row.input ?? 0; g.tokensOut+=row.output ?? 0;
    if (row.input==null || row.output==null) g.missing++;
    if (row.resource==="api" && row.input!=null && row.output!=null && row.inputPrice!=null && row.outputPrice!=null) {
      g.priced++; g.cost+=(row.input*row.inputPrice+row.output*row.outputPrice)/1e6;
    }
  }
  return [...groups.values()].sort((a,b)=>b.calls-a.calls);
}
function renderSpending() {
  const records=[];
  for (let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if (key?.startsWith(spendingPrefix)) records.push(read(key,null));
  }
  const groups=groupUsage(records,$("spendingPeriod").value);
  const money=value=>value.toLocaleString("ru",{maximumFractionDigits:8})+" USD";
  const calls=groups.reduce((n,g)=>n+g.calls,0);
  const priced=groups.reduce((n,g)=>n+g.priced,0);
  const api=groups.filter(g=>g.resource==="api").reduce((n,g)=>n+g.calls,0);
  $("spendingTotal").textContent=calls ? "Попыток: "+calls+" · API: "+api+(priced
    ? " · оценка "+money(groups.reduce((n,g)=>n+g.cost,0))+" для "+priced+" из "+api
    : api ? " · стоимость неизвестна" : "") : "За этот период запросов пока нет.";
  $("spendingRows").replaceChildren(...groups.map(g=>{
    const card=el("article",undefined,"connection-card");
    const name=g.resource==="local" ? "Этот Mac" : g.resource==="plan" ? "Тариф ChatGPT" : g.label;
    card.append(el("strong",name+" · "+g.model));
    if (g.endpoint || g.owner) card.append(el("small",[endpointHost(g.endpoint),g.owner].filter(Boolean).join(" · ")));
    card.append(el("small","Попыток: "+g.calls+(g.probes ? " · проверок: "+g.probes : "")));
    card.append(el("small","Известные токены: вход "+g.tokensIn+" · выход "+g.tokensOut+
      (g.missing ? " · неполные данные у "+g.missing+" из "+g.calls : "")));
    card.append(el("small",g.resource==="local" ? "Без расходов на внешний API" : g.resource==="plan" ? "Квота подписки"
      : g.priced ? "Оценка "+money(g.cost)+" для "+g.priced+" из "+g.calls+" попыток" : "Стоимость неизвестна"));
    return card;
  }));
}
function setupSpending() {
  $("spending").onclick=()=>{ renderSpending(); $("spendingDialog").showModal(); };
  $("spendingPeriod").onchange=renderSpending;
  $("spendingClose").onclick=()=>$("spendingDialog").close();
}
