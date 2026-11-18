"use strict";

// Each attempt has its own storage entry so concurrent tabs and copied chats cannot duplicate it.
const spendingPrefix = "mafoken.usage.";
function startUsage(resource, model, profileId, profile, owner, probe=false) {
  const record={id:crypto.randomUUID(),at:Date.now(),resource,model,probe};
  if (resource==="api") {
    Object.assign(record,{profileId,endpoint:profile.endpoint,label:profile.name,owner});
    if (profile.network==="wifi") record.network="wifi";
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
function hasRate(row) {
  return Number.isFinite(row.inputPrice) && Number.isFinite(row.outputPrice);
}
function needsJunRate(row) {
  return row.resource==="api" && row.reportedUSD==null && !hasRate(row) &&
    /^https:\/\/agents\.ai\.atechlab\.ru\/v1(?:\/chat\/completions)?\/?$/.test(row.endpoint);
}
const catalogCache=new Map();
async function fetchJunRates(network) {
  const entry=catalogCache.get(network);
  if (entry && entry.until>Date.now()) return entry.request;
  const request=localTool("junai-prices",{network}).then(result=>result.prices);
  catalogCache.set(network,{request,until:Date.now()+300000});
  try { return await request; }
  catch (error) { catalogCache.delete(network); throw error; }
}
async function fillJunRates(records) {
  const routes=new Map();
  for (const row of records.filter(needsJunRate)) {
    const profile=settings.providers[row.profileId];
    const network=row.network ?? (row.endpoint===profile?.endpoint ? profile.network : "") ?? "";
    if (!routes.has(network)) routes.set(network,[]);
    routes.get(network).push(row);
  }
  for (const [network,rows] of routes) {
    try {
      const prices=await fetchJunRates(network);
      for (const row of rows) {
        const rate=prices[row.model], key=spendingPrefix+row.id, current=read(key,null);
        if (!rate || !hasRate(rate) || !current || !needsJunRate(current)) continue;
        Object.assign(current,rate,{rateAt:Date.now()});
        localStorage.setItem(key,JSON.stringify(current));
      }
    } catch { if ($("spendingDialog").open) $("rateStatus").textContent="Не удалось получить тариф JunAI. При следующем открытии проверим ещё раз."; }
  }
  if (routes.size && $("spendingDialog").open) renderSpending();
}

function writeUsage(record, counts) {
  for (const field of ["input","output"]) {
    const value=counts?.[field];
    if (Number.isSafeInteger(value) && value>=0) record[field]=value;
  }
  if (Number.isFinite(counts?.reportedUSD) && counts.reportedUSD>=0) record.reportedUSD=counts.reportedUSD;
  const previous=read(spendingPrefix+record.id,null);
  if (previous?.rateAt && !hasRate(record))
    Object.assign(record,{inputPrice:previous.inputPrice,outputPrice:previous.outputPrice,rateAt:previous.rateAt});
  try { localStorage.setItem(spendingPrefix+record.id,JSON.stringify(record)); }
  catch { storageWarning("Не удалось сохранить статистику расходов."); }
  if ($("spendingDialog").open) renderSpending();
  if (counts && needsJunRate(record)) void fillJunRates([record]);
}
function groupUsage(records, period, now=new Date()) {
  const start=new Date(now.getFullYear(),now.getMonth(),period==="month" ? 1 : now.getDate()).getTime();
  const groups=new Map();
  for (const row of records) {
    if (!row || row.at<start || row.at>now.getTime()) continue;
    const id=JSON.stringify([row.resource,row.profileId,row.endpoint,row.owner,row.model]);
    if (!groups.has(id)) groups.set(id,{...row,calls:0,probes:0,tokensIn:0,tokensOut:0,missing:0,priced:0,cost:0,reported:0,billed:0,items:[]});
    const g=groups.get(id);
    g.items.push(row);
    g.calls++; if (row.probe) g.probes++;
    g.tokensIn+=row.input ?? 0; g.tokensOut+=row.output ?? 0;
    if (row.input==null || row.output==null) g.missing++;
    if (row.resource==="api" && Number.isFinite(row.reportedUSD)) {
      g.reported++; g.billed+=row.reportedUSD;
    } else if (row.resource==="api" && row.input!=null && row.output!=null && row.inputPrice!=null && row.outputPrice!=null) {
      g.priced++; g.cost+=(row.input*row.inputPrice+row.output*row.outputPrice)/1e6;
    }
  }
  return [...groups.values()].sort((a,b)=>b.calls-a.calls);
}
function renderSpending(updateRates=false) {
  const records=[];
  for (let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if (key?.startsWith(spendingPrefix)) records.push(read(key,null));
  }
  const groups=groupUsage(records,$("spendingPeriod").value);
  const money=value=>value.toLocaleString("ru",{maximumFractionDigits:8})+" USD";
  const calls=groups.reduce((n,g)=>n+g.calls,0);
  const priced=groups.reduce((n,g)=>n+g.priced,0);
  const reported=groups.reduce((n,g)=>n+g.reported,0);
  const api=groups.filter(g=>g.resource==="api").reduce((n,g)=>n+g.calls,0);
  function totals(priced,cost,count,billed,api) {
    const parts=[];
    if (count) parts.push("сумма от API "+money(billed)+" ("+count+")");
    if (priced) parts.push("оценка "+money(cost)+" ("+priced+")");
    if (count+priced<api) parts.push("без суммы: "+(api-count-priced));
    return parts.join(" · ");
  }
  const summary=totals(priced,groups.reduce((n,g)=>n+g.cost,0),reported,groups.reduce((n,g)=>n+g.billed,0),api);
  $("spendingTotal").textContent=calls ? ["Попыток: "+calls,"API: "+api,summary].filter(Boolean).join(" · ")
    : "За этот период запросов пока нет.";
  $("spendingRows").replaceChildren(...groups.map(g=>{
    const card=el("article",undefined,"connection-card");
    const name=g.resource==="local" ? "Этот Mac" : g.resource==="plan" ? "Тариф ChatGPT" : g.label;
    card.append(el("strong",name+" · "+g.model));
    if (g.endpoint || g.owner) card.append(el("small",[endpointHost(g.endpoint),g.owner].filter(Boolean).join(" · ")));
    card.append(el("small","Попыток: "+g.calls+(g.probes ? " · проверок: "+g.probes : "")));
    card.append(el("small","Известные токены: вход "+g.tokensIn+" · выход "+g.tokensOut+
      (g.missing ? " · неполные данные у "+g.missing+" из "+g.calls : "")));
    card.append(el("small",g.resource==="local" ? "Без расходов на внешний API" : g.resource==="plan" ? "Квота подписки"
      : totals(g.priced,g.cost,g.reported,g.billed,g.calls)));
    if (g.resource==="api") {
      const details=el("details");
      details.open=g.calls===1;
      details.append(el("summary","По запросам"));
      for (const row of g.items.sort((a,b)=>b.at-a.at)) {
        const known=row.input!=null && row.output!=null && hasRate(row);
        const cost=row.reportedUSD!=null ? money(row.reportedUSD)+" · сумма от API"
          : known ? money((row.input*row.inputPrice+row.output*row.outputPrice)/1e6)+" · оценка" : "Стоимость неизвестна";
        const line=el("p",new Date(row.at).toLocaleString("ru")+" · "+(row.probe ? "Проверка" : "Чат")+
          " · вход "+(row.input ?? "н/д")+" · выход "+(row.output ?? "н/д")+" · "+cost);
        details.append(line);
        if (known && row.reportedUSD==null) details.append(el("small",
          (row.rateAt ? "Каталог JunAI от "+new Date(row.rateAt).toLocaleDateString("ru") : "Тариф из настроек")+
          " · USD за 1 млн: вход "+row.inputPrice+", выход "+row.outputPrice));
      }
      card.append(details);
    }
    return card;
  }));
  if (updateRates===true) {
    $("rateStatus").textContent="";
    void fillJunRates(groups.flatMap(g=>g.items));
  }
}
function setupSpending() {
  $("spending").onclick=()=>{ $("spendingDialog").showModal(); renderSpending(true); };
  $("spendingPeriod").onchange=()=>renderSpending(true);
  $("spendingClose").onclick=()=>$("spendingDialog").close();
}
