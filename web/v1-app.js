import{processWebItem}from"./browser-processor.js";

const state={items:[],gateway:"checking",gatewayError:null,submitting:false,history:loadHistory(),wakeLock:null};
const $=s=>document.querySelector(s),queueEl=$("#queue"),inputEl=$("#url-input"),batchButton=$("#batch-button"),retryButton=$("#retry-button");
boot();

async function boot(){
  bindEvents();render();
  try{const r=await fetch("/api/web?action=health",{cache:"no-store"}),data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||"Gateway offline");state.gateway="ready";}
  catch(error){state.gateway="offline";state.gatewayError=error.message;}
  render();if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});
}
function bindEvents(){
  $("#add-button").addEventListener("click",addFromInput);
  $("#paste-button").addEventListener("click",async()=>{try{inputEl.value=await navigator.clipboard.readText();await addFromInput();}catch{toast("클립보드 권한이 없어요. 직접 붙여넣어 주세요.");}});
  inputEl.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addFromInput();}});
  document.querySelectorAll("[data-bulk]").forEach(b=>b.addEventListener("click",()=>applyBulk(b.dataset.bulk)));
  batchButton.addEventListener("click",submitBatch);retryButton.addEventListener("click",retryFailed);
  $("#refresh-history").addEventListener("click",renderHistory);$("#number-prefix").addEventListener("change",renderBatchBar);
}
async function inspectUrl(url){
  const response=await fetch("/api/web?action=inspect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||`분석 실패 (${response.status})`);
  return data;
}
async function addFromInput(){
  const urls=[...new Set(inputEl.value.split(/\s+/).map(x=>x.trim()).filter(Boolean))];if(!urls.length)return;
  inputEl.value="";
  for(const url of urls){const item={localId:crypto.randomUUID(),url,inspectStatus:"loading",mediaType:"mp3",quality:256,jobStatus:"idle",progress:0};state.items.push(item);render();inspectItem(item);}
}
async function inspectItem(item){
  if(state.gateway!=="ready"){item.inspectStatus="failed";item.error=state.gatewayError||"Web Gateway offline";render();return;}
  try{Object.assign(item,await inspectUrl(item.url),{inspectStatus:"ready",error:null});if(item.mediaType==="mp4")item.quality=nearestQuality(item.mp4Plans.map(p=>p.quality),1080);}
  catch(error){item.inspectStatus="failed";item.error=error.message;}render();
}
function applyBulk(type){
  for(const item of state.items){if(item.inspectStatus!=="ready"||item.jobStatus==="processing")continue;item.mediaType=type;item.quality=type==="mp3"?256:nearestQuality(item.mp4Plans.map(p=>p.quality),1080);if(item.jobStatus==="ready")item.jobStatus="idle";}
  render();
}
async function submitBatch(){if(state.submitting||state.gateway!=="ready")return;const items=state.items.filter(i=>i.inspectStatus==="ready"&&!["processing","ready"].includes(i.jobStatus));if(!items.length)return;
  state.submitting=true;await acquireWakeLock();const numbered=$("#number-prefix").checked;
  for(const item of items){
    item.jobStatus="processing";item.jobStage="starting";item.progress=0;item.jobError=null;render();
    try{
      const prefix=numbered?`${String(state.items.indexOf(item)+1).padStart(2,"0")} - `:"";
      const result=await processWebItem(item,{prefix,onProgress:(p,stage)=>{item.progress=p;item.jobStage=stage;renderItem(item.localId);}});
      Object.assign(item,{jobStatus:"ready",progress:100,filename:result.filename,sizeBytes:result.sizeBytes});
      addHistory(item);
    }catch(error){item.jobStatus="failed";item.jobError=error?.name==="AbortError"?"취소됨":friendlyError(error);}
    render();
  }
  state.submitting=false;await releaseWakeLock();render();
}
async function retryFailed(){for(const i of state.items)if(i.jobStatus==="failed")i.jobStatus="idle";render();await submitBatch();}
function resetItem(item){item.jobStatus="idle";item.progress=0;item.jobError=null;item.filename=null;item.sizeBytes=null;}
function render(){
  $("#queue-count").textContent=state.items.length;$("#empty-state").classList.toggle("hidden",state.items.length>0);$("#batch-bar").classList.toggle("hidden",state.items.length===0);
  queueEl.innerHTML=state.items.map(itemTemplate).join("");bindQueueEvents();renderGateway();renderBatchBar();renderHistory();
}
function renderGateway(){
  const ready=state.gateway==="ready";$("#health").textContent=ready?"WEB · ONLINE":state.gateway==="checking"?"WEB · CHECKING":"WEB · OFFLINE";$("#health").classList.toggle("ok",ready);
  $("#engine-name").textContent=ready?"Web-Native Engine":"Web Gateway를 사용할 수 없습니다";
  const badge=$("#engine-badge");badge.textContent=ready?"install-free · ready":"offline";badge.className=`engine-badge ${ready?"ready":"offline"}`;
  $("#engine-detail").textContent=ready?"설치·Pairing·집 PC 없이 브라우저가 직접 MP3/MP4를 완성합니다. 처리 중에는 이 페이지를 열어두세요.":state.gatewayError||"Gateway 상태를 확인하지 못했습니다.";
}
function renderItem(id){const node=queueEl.querySelector(`[data-id="${id}"]`),item=findItem(id);if(!node||!item)return render();const holder=document.createElement("div");holder.innerHTML=itemTemplate(item);node.replaceWith(holder.firstElementChild);bindQueueEvents();renderBatchBar();}
function itemTemplate(item,index=state.items.indexOf(item)){
  const title=item.inspectStatus==="loading"?"분석 중…":item.title||"분석 실패";
  const subtitle=item.inspectStatus==="failed"?(item.error||"분석 실패"):item.inspectStatus==="loading"?item.url:`${formatDuration(item.duration)}${item.channel?` · ${escapeHtml(item.channel)}`:""}`;
  const qualities=item.mediaType==="mp3"?(item.mp3Qualities||[128,192,256,320]):(item.mp4Plans||[]).map(p=>p.quality),suffix=item.mediaType==="mp3"?"k":"p";
  const locked=item.jobStatus==="processing";
  return`<article class="queue-item panel" data-id="${item.localId}">
    <div class="order">${String(index+1).padStart(2,"0")}</div>
    <div class="thumb-wrap">${item.thumbnail?`<img src="${escapeAttr(item.thumbnail)}" alt="" loading="lazy">`:`<div class="thumb-placeholder">Y2</div>`}</div>
    <div class="item-main"><div class="item-title">${escapeHtml(title)}</div><div class="item-subtitle">${subtitle}</div>
      ${item.inspectStatus==="ready"?`<div class="item-controls"><select data-role="type" ${locked?"disabled":""}><option value="mp3" ${item.mediaType==="mp3"?"selected":""}>MP3</option><option value="mp4" ${item.mediaType==="mp4"?"selected":""}>MP4</option></select><select data-role="quality" ${locked?"disabled":""}>${qualities.map(q=>`<option value="${q}" ${Number(q)===Number(item.quality)?"selected":""}>${q}${suffix}</option>`).join("")}</select><span class="status ${item.jobStatus==="failed"?"bad":""}">${statusText(item)}</span></div>`:""}
      ${item.jobError?`<div class="error-line">${escapeHtml(item.jobError)}</div>`:""}${item.filename?`<div class="saved-line">${escapeHtml(item.filename)}</div>`:""}
    </div>
    <div class="item-actions"><button class="icon-button" data-move="-1" ${index===0||locked?"disabled":""}>↑</button><button class="icon-button" data-move="1" ${index===state.items.length-1||locked?"disabled":""}>↓</button><button class="icon-button danger" data-remove ${locked?"disabled":""}>×</button></div>
  </article>`;
}
function bindQueueEvents(){queueEl.querySelectorAll(".queue-item").forEach(node=>{const item=findItem(node.dataset.id);node.querySelector('[data-role="type"]')?.addEventListener("change",e=>{item.mediaType=e.target.value;item.quality=item.mediaType==="mp3"?256:nearestQuality(item.mp4Plans.map(p=>p.quality),1080);resetItem(item);renderItem(item.localId);});node.querySelector('[data-role="quality"]')?.addEventListener("change",e=>{item.quality=Number(e.target.value);resetItem(item);renderItem(item.localId);});node.querySelectorAll("[data-move]").forEach(b=>b.addEventListener("click",()=>moveItem(item.localId,Number(b.dataset.move))));node.querySelector("[data-remove]")?.addEventListener("click",()=>{state.items=state.items.filter(x=>x.localId!==item.localId);render();});});}
function moveItem(id,delta){const i=state.items.findIndex(x=>x.localId===id),to=i+delta;if(i<0||to<0||to>=state.items.length)return;[state.items[i],state.items[to]]=[state.items[to],state.items[i]];render();}
function renderBatchBar(){const ready=state.items.filter(i=>i.inspectStatus==="ready"&&!["processing","ready"].includes(i.jobStatus)).length,active=state.items.filter(i=>i.jobStatus==="processing").length,failed=state.items.filter(i=>i.jobStatus==="failed").length,done=state.items.filter(i=>i.jobStatus==="ready").length;$("#batch-summary").textContent=`${state.items.length}개`;$("#batch-detail").textContent=active?`${active}개 처리 중 · 탭을 닫지 마세요`:ready?`${ready}개 다운로드 준비`:done?`${done}개 완료`:"분석 대기";batchButton.disabled=state.submitting||!ready||state.gateway!=="ready";batchButton.textContent=state.submitting?"와다다 처리 중…":`와다다 다운로드 · ${ready}`;retryButton.classList.toggle("hidden",failed===0);}
function statusText(item){if(item.jobStatus==="processing")return`${stageText(item.jobStage)} · ${Math.floor(item.progress||0)}%`;if(item.jobStatus==="ready")return"완료";if(item.jobStatus==="failed")return"실패";return"준비";}
function stageText(stage){return({starting:"시작",downloading:"다운로드",encoding:"MP3 변환",muxing:"MP4 합치기",ready:"완료"})[stage]||"처리";}
function nearestQuality(list,target){if(!list?.length)return target;return[...list].sort((a,b)=>Math.abs(a-target)-Math.abs(b-target))[0];}
function findItem(id){return state.items.find(x=>x.localId===id);}
function formatDuration(s){s=Number(s||0);if(!s)return"길이 정보 없음";return`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;}
function friendlyError(error){const text=String(error?.message||error||"처리 실패");if(/bot|confirm/i.test(text))return"YouTube가 현재 Gateway 요청을 제한했습니다. 잠시 뒤 다시 시도해 주세요.";return text;}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}function escapeAttr(v){return escapeHtml(v);}
function toast(message,ms=3200){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove("show"),ms);}
function loadHistory(){try{return JSON.parse(localStorage.getItem("y2y2-v1-history")||"[]");}catch{return[];}}
function addHistory(item){state.history=[{title:item.title,mediaType:item.mediaType,quality:item.quality,filename:item.filename,at:Date.now()},...state.history].slice(0,30);localStorage.setItem("y2y2-v1-history",JSON.stringify(state.history));renderHistory();}
function renderHistory(){const el=$("#history");if(!state.history.length){el.innerHTML='<span class="muted">아직 완료한 파일이 없습니다.</span>';return;}el.innerHTML=state.history.slice(0,12).map(x=>`<div class="history-row"><div class="history-main"><strong>${escapeHtml(x.title)}</strong><span>${x.mediaType.toUpperCase()} · ${x.quality}${x.mediaType==="mp3"?"k":"p"} · ${new Date(x.at).toLocaleString()}</span></div></div>`).join("");}
async function acquireWakeLock(){try{if("wakeLock"in navigator)state.wakeLock=await navigator.wakeLock.request("screen");}catch{}}
async function releaseWakeLock(){try{await state.wakeLock?.release();}catch{}state.wakeLock=null;}
