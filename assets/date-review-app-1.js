"use strict";

const SCHEDULE_RECORDS=(window.MARIO_DATE_REVIEW_DATA||[]).map(x=>({
  number:x[0],category:(window.MARIO_DATE_REVIEW_CATEGORIES||[])[x[1]]||"",current_date:x[2]||"",date_type:x[3]||"",
  final_description:x[4]||"",mario_description:x[5]||"",legal_draft_description:x[6]||"",mario_date:x[7]||"",legal_draft_date:x[8]||""
}));
const CFG = Object.freeze({
  appKey: "1p4bbydzkh0wblg",
  redirectUri: "https://jgeiger310-code.github.io/masics-mario-cloud-viewer/",
  manifestId: "id:PzJJcyLjOoMAAAAAAAIkaw",
  progressId: "id:PzJJcyLjOoMAAAAAAAH0Ww"
});
const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
const STORAGE_KEY = "mario_date_description_remove_review_v2";
const MATCH_CACHE_KEY = "mario_incomplete_date_source_matches_v1";
const TOKEN_KEY = "masics_access_token";

let token = sessionStorage.getItem(TOKEN_KEY) || "";
let manifestRecords = [];
let progressDecisions = {};
let missingSources = [];
let edits = readJson(localStorage.getItem(STORAGE_KEY), {});
let matchCache = readJson(localStorage.getItem(MATCH_CACHE_KEY), {});
let activeNumber = SCHEDULE_RECORDS[0]?.number || 0;
let activeObjectUrl = "";
let previewAbort = null;
let sourceDataLoaded = false;

const $ = id => document.getElementById(id);
const els = {
  connection:$("connection"), connect:$("connect"), reload:$("reload"), export:$("export"),
  search:$("search"), dateType:$("dateType"), reviewStatus:$("reviewStatus"), counts:$("counts"),
  list:$("recordList"), title:$("recordTitle"), meta:$("recordMeta"), description:$("recordDescription"),
  candidate:$("candidateSelect"), rematch:$("rematch"), candidateMeta:$("candidateMeta"),
  previewStatus:$("previewStatus"), preview:$("filePreview"),
  correctedDate:$("correctedDate"), datePicker:$("datePicker"),
  correctedDescription:$("correctedDescription"), confirmed:$("confirmed"), remove:$("remove"),
  removeReason:$("removeReason"), reviewNotes:$("reviewNotes"), originalWording:$("originalWording"),
  sourceDetails:$("sourceDetails"), save:$("saveRecord"), next:$("nextRecord"), saved:$("savedMessage")
};

function readJson(value, fallback){
  try{return value ? JSON.parse(value) : fallback}catch{return fallback}
}
function escapeHtml(value){
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function unique(values){
  const seen=new Set();
  return values.flat(Infinity).map(v=>String(v||"").trim()).filter(v=>v&&!seen.has(v)&&seen.add(v));
}
function activeSchedule(){return SCHEDULE_RECORDS.find(r=>Number(r.number)===Number(activeNumber))||SCHEDULE_RECORDS[0]}
function defaultEdit(r){
  return {
    correctedDate:"",
    correctedDescription:r.final_description||"",
    confirmed:false,remove:false,removeReason:"",notes:"",
    chosenReviewId:""
  };
}
function editFor(r){return Object.assign(defaultEdit(r), edits[r.number]||{})}
function saveEdit(r, patch){
  edits[r.number]=Object.assign(editFor(r),patch);
  localStorage.setItem(STORAGE_KEY,JSON.stringify(edits));
  renderList();updateCounts();
}
function statusFor(r){
  const e=editFor(r);
  if(e.remove)return"removed";
  if(e.confirmed)return"confirmed";
  if(e.correctedDate.trim()||e.correctedDescription.trim()!==(r.final_description||"").trim()||e.notes.trim())return"edited";
  return"needs";
}
function filtered(){
  const q=els.search.value.trim().toLowerCase(), dt=els.dateType.value, st=els.reviewStatus.value;
  return SCHEDULE_RECORDS.filter(r=>{
    if(dt&&r.date_type!==dt)return false;
    if(st&&statusFor(r)!==st)return false;
    const e=editFor(r);
    const hay=[r.number,r.category,r.current_date,r.final_description,r.mario_description,r.legal_draft_description,e.correctedDate,e.correctedDescription,e.notes].join(" ").toLowerCase();
    return !q||hay.includes(q);
  });
}
function renderList(){
  const rows=filtered();
  els.list.innerHTML=rows.map(r=>{
    const st=statusFor(r), e=editFor(r);
    return `<li><button data-number="${r.number}" class="${Number(r.number)===Number(activeNumber)?"active ":""}${st==="removed"?"removed":""}">
      <div class="line1"><span><i class="dot ${st}"></i>No. ${r.number}</span><span>${escapeHtml(e.correctedDate||r.current_date)}</span></div>
      <div class="line2">${escapeHtml(e.correctedDescription||r.final_description)}</div>
    </button></li>`;
  }).join("");
  els.list.querySelectorAll("button[data-number]").forEach(b=>b.addEventListener("click",()=>selectSchedule(Number(b.dataset.number))));
}
function updateCounts(){
  const counts={needs:0,edited:0,confirmed:0,removed:0};
  SCHEDULE_RECORDS.forEach(r=>counts[statusFor(r)]++);
  els.counts.textContent=`${filtered().length} showing · ${counts.needs} need review · ${counts.edited} edited · ${counts.confirmed} confirmed · ${counts.removed} remove`;
}
function fillEditFields(r){
  const e=editFor(r);
  els.correctedDate.value=e.correctedDate;
  els.correctedDescription.value=e.correctedDescription;
  els.confirmed.checked=!!e.confirmed;
  els.remove.checked=!!e.remove;
  els.removeReason.value=e.removeReason;
  els.reviewNotes.value=e.notes;
  els.originalWording.textContent=[
    `Current date: ${r.current_date}`,
    `Mario source date: ${r.mario_date||"(blank)"}`,
    `Earlier legal-draft date: ${r.legal_draft_date||"(blank)"}`,
    "",
    `Mario wording: ${r.mario_description||"(blank)"}`,
    "",
    `Earlier legal-draft wording: ${r.legal_draft_description||"(blank)"}`
  ].join("\n");
}
function currentFieldPatch(){
  return {
    correctedDate:els.correctedDate.value.trim(),
    correctedDescription:els.correctedDescription.value.trim(),
    confirmed:els.confirmed.checked,
    remove:els.remove.checked,
    removeReason:els.removeReason.value.trim(),
    notes:els.reviewNotes.value.trim(),
    chosenReviewId:els.candidate.value||editFor(activeSchedule()).chosenReviewId||""
  };
}
function persistCurrent(showMessage=true){
  const r=activeSchedule(); if(!r)return;
  saveEdit(r,currentFieldPatch());
  if(showMessage){
    els.saved.textContent="Saved";
    setTimeout(()=>els.saved.textContent="",1200);
  }
}
function selectSchedule(number){
  if(activeNumber)persistCurrent(false);
  activeNumber=number;
  const r=activeSchedule();
  els.title.textContent=`No. ${r.number} — ${r.category}`;
  els.meta.textContent=`Current incomplete date: ${r.current_date} · ${r.date_type}`;
  els.description.textContent=r.final_description;
  fillEditFields(r);
  renderList();updateCounts();
  showCandidates(r);
}
function dateFromPicker(value){
  if(!value)return"";
  const [y,m,d]=value.split("-").map(Number);
  return new Date(y,m-1,d).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
}
function randomBase64Url(bytes=32){
  const data=new Uint8Array(bytes);crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
async function sha256Base64Url(text){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function setConnection(message,ok=false){
  els.connection.textContent=message;els.connection.className=`connection ${ok?"ok":"warn"}`;
}
async function connectDropbox(){
  if(token){await loadSourceData();return}
  setConnection("Opening Dropbox sign-in…");
  const state=randomBase64Url(24),verifier=randomBase64Url(64),challenge=await sha256Base64Url(verifier);
  const popup=window.open("about:blank","masicsDropboxLogin","width=760,height=780");
  if(!popup){setConnection("The browser blocked the Dropbox sign-in window. Allow pop-ups for this page and press Connect Dropbox again.");return}
  try{
    popup.sessionStorage.setItem("masics_oauth_state",state);
    popup.sessionStorage.setItem("masics_pkce_verifier",verifier);
  }catch(err){
    popup.close();setConnection("The sign-in window could not be initialized. Open the main Mario viewer, sign in, then return to this page in the same tab.");return;
  }
  const params=new URLSearchParams({
    client_id:CFG.appKey,response_type:"code",redirect_uri:CFG.redirectUri,state,
    code_challenge:challenge,code_challenge_method:"S256",token_access_type:"online",
    scope:"files.metadata.read files.content.read files.content.write"
  });
  popup.location.href=`${DROPBOX_AUTH}?${params.toString()}`;
  const started=Date.now();
  const timer=setInterval(async()=>{
    if(popup.closed){clearInterval(timer);if(!token)setConnection("Dropbox sign-in window was closed before connection completed.");return}
    if(Date.now()-started>180000){clearInterval(timer);popup.close();setConnection("Dropbox sign-in timed out. Press Connect Dropbox and try again.");return}
    try{
      if(popup.location.origin!==location.origin)return;
      const popupToken=popup.sessionStorage.getItem(TOKEN_KEY);
      if(!popupToken)return;
      clearInterval(timer);token=popupToken;sessionStorage.setItem(TOKEN_KEY,token);popup.close();
      await loadSourceData();
    }catch{}
  },500);
}
async function dropboxDownload(locator,signal=null){
  const response=await fetch(DROPBOX_CONTENT+"files/download",{
    method:"POST",signal,headers:{"Authorization":`Bearer ${token}`,"Dropbox-API-Arg":JSON.stringify({path:locator})}
  });
  if(response.status===401)throw new Error("Dropbox sign-in expired. Press Connect Dropbox again.");
  if(response.status===403)throw new Error("Dropbox permission was denied for this file.");
  if(response.status===409)throw new Error(`Dropbox could not find this file at ${locator}`);
  if(!response.ok)throw new Error(`Dropbox file request failed (${response.status}).`);
  return response;
}
async function downloadFirst(locators,signal=null){
  let last=null;
  for(const locator of unique(locators)){
    try{return await dropboxDownload(locator,signal)}catch(err){
      last=err;if(!/find|missing|moved|409/i.test(String(err.message)))throw err;
    }
  }
  throw last||new Error("No Dropbox file locator is available.");
}
async function temporaryLink(record){
  let last=null;
  for(const locator of evidenceLocators(record)){
    try{
      const response=await fetch(DROPBOX_RPC+"files/get_temporary_link",{
        method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
        body:JSON.stringify({path:locator})
      });
      if(!response.ok)throw new Error(`Temporary-link request failed (${response.status}).`);
      const data=await response.json();if(data.link)return data.link;
    }catch(err){last=err}
  }
  throw last||new Error("Could not create an original-file link.");
}
function evidenceLocators(record){
  return unique([record?.dropbox_file_id,record?.dropbox_path_alternates||[],record?.dropbox_path,record?.path]);
}
