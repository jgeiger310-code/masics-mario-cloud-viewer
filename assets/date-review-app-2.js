async function loadSourceData(force=false){
  if(sourceDataLoaded&&!force){setConnection(`Dropbox connected. ${missingSources.length} missing-file source records loaded.`,true);showCandidates(activeSchedule());return}
  if(!token){await connectDropbox();return}
  setConnection("Dropbox connected. Loading the source-file index and Mario's notes…",true);
  els.connect.disabled=true;els.reload.disabled=true;
  try{
    const [manifestResponse,progressResponse]=await Promise.all([
      dropboxDownload(CFG.manifestId),dropboxDownload(CFG.progressId)
    ]);
    const [manifest,progress]=await Promise.all([manifestResponse.json(),progressResponse.json()]);
    manifestRecords=Array.isArray(manifest.records)?manifest.records:[];
    progressDecisions=progress&&typeof progress.decisions==="object"?progress.decisions:{};
    missingSources=manifestRecords.map(record=>{
      const saved=progressDecisions[record.review_id]||{};
      return Object.assign({},record,{_decision:saved.decision||"",_marioNotes:saved.notes||"",_updatedAt:saved.updatedAt||""});
    }).filter(record=>record._decision==="missing");
    sourceDataLoaded=true;
    setConnection(`Dropbox connected. ${missingSources.length} missing-file source records loaded.`,true);
    els.rematch.disabled=false;
    await showCandidates(activeSchedule(),force);
  }catch(err){
    if(/expired|401/i.test(String(err.message))){token="";sessionStorage.removeItem(TOKEN_KEY)}
    setConnection(err.message||"The source-file index could not be loaded.");
  }finally{
    els.connect.disabled=false;els.reload.disabled=false;
  }
}
const STOP=new Set("a an and are as at be been being by did do does for from had has have in into is it its of on or that the their this to was were will with missing file files document documents provided town franklinville masic masics mario copy record records concerning regarding related".split(" "));
function normalizeText(value){
  return String(value||"").toLowerCase()
    .replace(/\b(missing|provided|document|file|copy)\b/g," ")
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function tokens(value){
  return new Set(normalizeText(value).split(" ").filter(t=>t.length>1&&!STOP.has(t)));
}
function recordSearchText(source){
  const keys=["filename","dropbox_path","relative_path","source_root_folder","ocr_text","extracted_text","search_text","searchable_text","document_text","content_text","text","title","subject"];
  return [source._marioNotes,...keys.map(k=>source[k]||"")].join(" ");
}
function similarity(schedule,source){
  const query=[schedule.mario_description,schedule.legal_draft_description,schedule.final_description,schedule.current_date].join(" ");
  const candidate=recordSearchText(source);
  const q=tokens(query),c=tokens(candidate);
  let overlap=0,weighted=0;
  q.forEach(t=>{if(c.has(t)){overlap++;weighted+=t.length>=7?2.4:t.length>=5?1.7:1}});
  const union=new Set([...q,...c]).size||1;
  let score=(overlap/Math.max(1,q.size))*58+(overlap/union)*18+Math.min(20,weighted*1.4);
  const nq=normalizeText(schedule.mario_description),nc=normalizeText(source._marioNotes);
  if(nq&&nc&&(nc.includes(nq)||nq.includes(nc)))score+=28;
  const years=String(schedule.current_date||"").match(/\b(?:19|20)\d{2}\b/g)||[];
  if(years.some(y=>candidate.includes(y)))score+=7;
  const filename=String(source.filename||"").toLowerCase();
  if(filename&&years.some(y=>filename.includes(y)))score+=4;
  return Math.max(0,Math.min(100,Math.round(score)));
}
function candidatesFor(schedule,force=false){
  const cache=matchCache[schedule.number];
  if(!force&&cache&&Array.isArray(cache.ids)){
    const cached=cache.ids.map(id=>missingSources.find(s=>s.review_id===id)).filter(Boolean);
    if(cached.length)return cached.map((source,i)=>({source,score:cache.scores?.[i]??similarity(schedule,source)}));
  }
  const ranked=missingSources.map(source=>({source,score:similarity(schedule,source)}))
    .sort((a,b)=>b.score-a.score||Number(a.source.queue_number||0)-Number(b.source.queue_number||0)).slice(0,10);
  matchCache[schedule.number]={ids:ranked.map(x=>x.source.review_id),scores:ranked.map(x=>x.score)};
  localStorage.setItem(MATCH_CACHE_KEY,JSON.stringify(matchCache));
  return ranked;
}
async function showCandidates(schedule,force=false){
  if(!schedule)return;
  if(!sourceDataLoaded){
    els.candidate.disabled=true;els.rematch.disabled=true;
    els.candidate.innerHTML="<option>Connect Dropbox to match source files</option>";
    els.candidateMeta.textContent="";
    els.sourceDetails.textContent="No source file selected.";
    showEmptyPreview("Connect Dropbox. The source file for this entry will then be matched and loaded automatically.");
    return;
  }
  const ranked=candidatesFor(schedule,force);
  const savedChoice=editFor(schedule).chosenReviewId;
  let selected=ranked.find(x=>x.source.review_id===savedChoice);
  if(!selected)selected=ranked[0]||null;
  els.candidate.innerHTML=ranked.map(x=>{
    const s=x.source;
    return `<option value="${escapeHtml(s.review_id)}" ${selected&&s.review_id===selected.source.review_id?"selected":""}>${x.score}% match · Queue ${escapeHtml(s.queue_number||"?")} · ${escapeHtml(s.filename||"(unnamed file)")} · ${escapeHtml((s._marioNotes||"").slice(0,95))}</option>`;
  }).join("");
  els.candidate.disabled=!ranked.length;
  if(!selected){
    els.candidateMeta.textContent="No missing-file source record could be matched.";
    showEmptyPreview("No source file match was found for this schedule entry.");
    return;
  }
  saveEdit(schedule,{chosenReviewId:selected.source.review_id});
  showCandidateMeta(selected.source,selected.score);
  await previewSource(selected.source);
}
function selectedSource(){
  return missingSources.find(s=>s.review_id===els.candidate.value)||null;
}
function extractedText(source){
  const keys=["ocr_text","extracted_text","search_text","searchable_text","document_text","content_text","text"];
  return keys.map(k=>String(source[k]||"").trim()).find(Boolean)||"";
}
function showCandidateMeta(source,score){
  const note=source._marioNotes||"(Mario did not enter a note for this source record.)";
  els.candidateMeta.innerHTML=`<span class="match-score">${score}% automatic text match</span> <b>${escapeHtml(source.filename||"(unnamed file)")}</b><br>${escapeHtml(note)}`;
  els.sourceDetails.textContent=[
    `Queue number: ${source.queue_number||"(not stated)"}`,
    `Filename: ${source.filename||"(not stated)"}`,
    `File type: ${source.file_type||source.extension||"(not stated)"}`,
    `Mario note: ${note}`,
    `Dropbox path: ${source.dropbox_path||"(not stated)"}`,
    `Source folder: ${source.source_root_folder||"(not stated)"}`,
    `Review ID: ${source.review_id||"(not stated)"}`
  ].join("\n");
}
function releasePreview(){
  if(previewAbort)previewAbort.abort();previewAbort=null;
  if(activeObjectUrl)URL.revokeObjectURL(activeObjectUrl);activeObjectUrl="";
}
function showEmptyPreview(message,loading=false){
  releasePreview();
  els.preview.innerHTML=`<div class="preview-card">${loading?'<div class="loading-spinner"></div>':""}<div class="empty-preview">${escapeHtml(message)}</div></div>`;
}
function fileExt(source){
  const m=String(source.filename||source.dropbox_path||"").toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return m?m[0]:"";
}
function sanitizeDocx(htmlText){
  const t=document.createElement("template");t.innerHTML=htmlText;
  t.content.querySelectorAll("script,style,iframe,object,embed,form").forEach(n=>n.remove());
  t.content.querySelectorAll("*").forEach(n=>[...n.attributes].forEach(a=>{
    const name=a.name.toLowerCase(),value=a.value.trim().toLowerCase();
    if(name.startsWith("on")||name==="srcdoc"||((name==="href"||name==="src")&&value.startsWith("javascript:")))n.removeAttribute(a.name);
  }));
  return t.content;
}
