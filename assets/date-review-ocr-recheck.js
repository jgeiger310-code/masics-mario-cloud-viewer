(() => {
  "use strict";
  const AUTH = "https://api.dropboxapi.com/2/";
  const CONTENT = "https://content.dropboxapi.com/2/";
  const TOKEN = "masics_access_token";
  const CACHE_KEY = "mario_ocr_recheck_137_v1";
  const SOURCE_FOLDERS = ["/jake Geiger/2nd round discovery mario/", "/jake Geiger/Mario’s Missing Files/", "/jake Geiger/Mario's Missing Files/"];
  const OCR_PATH = "/jake Geiger/Masic Case Master - Working Database/03_OCR_DESCRIPTORS_AND_TRANSCRIPTS";
  const cats = window.MARIO_DATE_REVIEW_CATEGORIES || [];
  const names = window.MARIO_DATE_REVIEW_FILENAMES || {};
  const rawRecords = window.MARIO_DATE_REVIEW_RECORDS || (window.MARIO_DATE_REVIEW_DATA || []).map(x => ({
    number: x[0], category: cats[x[1]] || "", current_date: x[2] || "", date_type: x[3] || "",
    final_description: x[4] || "", mario_description: x[5] || "", legal_draft_description: x[6] || "",
    mario_date: x[7] || "", legal_draft_date: x[8] || ""
  }));
  const records = rawRecords.map(r => ({...r, filename: names[String(r.number)] || ""}));
  const $ = id => document.getElementById(id);
  const el = {
    connect: $("connect"), run: $("runOcr"), exportUnresolved: $("exportUnresolved"), exportResolved: $("exportResolved"),
    status: $("connection"), search: $("search"), dateType: $("dateType"), viewMode: $("viewMode"), counts: $("counts"), list: $("recordList"),
    title: $("recordTitle"), meta: $("recordMeta"), desc: $("recordDescription"), ocr: $("ocrResult"), previewStatus: $("previewStatus"), preview: $("filePreview"),
    suggestedDate: $("suggestedDate"), suggestedDescription: $("suggestedDescription"), reason: $("reason"), original: $("originalWording"), source: $("sourceDetails")
  };
  let token = safeGet(TOKEN);
  let cache = readJson(localStorage.getItem(CACHE_KEY), {});
  let active = records[0]?.number || 0;
  let sourceCache = {};

  const monthMap = new Map(Object.entries({jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12}));
  function safeGet(k){try{return sessionStorage.getItem(k)||""}catch{return ""}}
  function safeSet(k,v){try{sessionStorage.setItem(k,v)}catch{}}
  function readJson(v, f){try{return v?JSON.parse(v):f}catch{return f}}
  function saveCache(){localStorage.setItem(CACHE_KEY, JSON.stringify(cache));}
  function esc(v){return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function normSpaces(v){return String(v || "").replace(/\s+/g, " ").trim();}
  function getResult(r){return cache[String(r.number)] || {status:"unchecked", suggestedDate:"", suggestedDescription:"", reason:"Not checked yet.", dates:[], ocrText:"", ocrPath:""};}
  function isResolved(result){return result.status === "resolved";}
  function statusLabel(result){return result.status === "resolved" ? "resolved" : result.status === "no_ocr" ? "no OCR" : result.status === "ambiguous" ? "ambiguous" : result.status === "unchecked" ? "unchecked" : "unresolved";}
  function setStatus(text, ok=false){el.status.textContent = text; el.status.className = `connection ${ok ? "ok" : "warn"}`;}
  function rpcUrl(endpoint){return AUTH + endpoint;}
  function authHeaders(json=true){const h = {Authorization:`Bearer ${token}`}; if (json) h["Content-Type"] = "application/json"; return h;}
  async function rpc(endpoint, body){const res = await fetch(rpcUrl(endpoint), {method:"POST", headers:authHeaders(true), body:JSON.stringify(body || {})}); if (res.status === 401){try{sessionStorage.removeItem(TOKEN)}catch{} token=""; throw new Error("Dropbox sign-in expired. Press Connect Dropbox again.");} if (!res.ok){let t=""; try{t=await res.text()}catch{} throw new Error(`${endpoint} failed (${res.status}) ${t.slice(0,240)}`);} return res.json();}
  async function downloadText(idOrPath){const res = await fetch(CONTENT + "files/download", {method:"POST", headers:{Authorization:`Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({path:idOrPath})}}); if (!res.ok){let t=""; try{t=await res.text()}catch{} throw new Error(`files/download failed (${res.status}) ${t.slice(0,220)}`);} return res.text();}
  async function tempLink(idOrPath){const data = await rpc("files/get_temporary_link", {path:idOrPath}); if (!data.link) throw new Error("Dropbox did not return a preview link."); return data;}

  function recordByNo(n){return records.find(r => Number(r.number) === Number(n)) || records[0];}
  function filteredRows(){
    const q = el.search.value.trim().toLowerCase(), dt = el.dateType.value, mode = el.viewMode.value;
    return records.filter(r => {
      const res = getResult(r);
      if (mode === "unresolved" && isResolved(res)) return false;
      if (mode === "resolved" && !isResolved(res)) return false;
      if (dt && r.date_type !== dt) return false;
      const hay = [r.number,r.category,r.current_date,r.date_type,r.filename,r.final_description,r.mario_description,r.legal_draft_description,res.suggestedDate,res.suggestedDescription,res.reason,(res.dates||[]).join(" ")].join(" ").toLowerCase();
      return !q || hay.includes(q);
    });
  }
  function counts(){
    let resolved=0, noOcr=0, ambiguous=0, unchecked=0, unresolved=0;
    for (const r of records){const s=getResult(r).status; if(s==="resolved") resolved++; else if(s==="no_ocr") noOcr++; else if(s==="ambiguous") ambiguous++; else if(s==="unchecked") unchecked++; else unresolved++;}
    el.counts.textContent = `${filteredRows().length} showing · ${resolved} auto-resolved · ${records.length-resolved} still left · ${ambiguous} ambiguous · ${noOcr} no OCR · ${unchecked} unchecked`;
  }
  function renderList(){
    const rows = filteredRows();
    if (!rows.length){el.list.innerHTML = `<li><button><div class="line1">No rows match this view.</div><div class="line2">Run the OCR recheck or change the filters.</div></button></li>`; return;}
    el.list.innerHTML = rows.map(r => {
      const res = getResult(r), cls = isResolved(res) ? "confirmed" : res.status === "unchecked" ? "needs" : "edited";
      return `<li><button data-number="${r.number}" class="${Number(r.number)===Number(active)?"active ":""}"><div class="line1"><span><i class="dot ${cls}"></i>No. ${r.number}</span><span>${esc(statusLabel(res))}</span></div><div class="line2">${esc(r.filename || "No filename")} — ${esc(res.suggestedDate || r.current_date || "No date")}</div></button></li>`;
    }).join("");
    el.list.querySelectorAll("button[data-number]").forEach(b => b.onclick = () => select(Number(b.dataset.number)));
  }
  function select(n){
    active = n; const r = recordByNo(n), res = getResult(r);
    el.title.textContent = `No. ${r.number} — ${r.category}`;
    el.meta.textContent = `Original incomplete date: ${r.current_date || "(blank)"} · Type: ${r.date_type || "(blank)"} · File: ${r.filename || "(missing filename)"}`;
    el.desc.textContent = r.final_description || r.mario_description || r.legal_draft_description || "";
    el.suggestedDate.value = res.suggestedDate || "";
    el.suggestedDescription.value = res.suggestedDescription || "";
    el.reason.value = res.reason || "";
    el.ocr.innerHTML = `<b>Status:</b> ${esc(statusLabel(res))}<br><b>OCR dates found:</b> ${esc((res.dates||[]).join("; ") || "none")}<br><b>OCR descriptor:</b> ${esc(res.ocrPath || "not loaded yet")}<br><br><pre>${esc((res.ocrText||"").slice(0,3500))}</pre>`;
    el.original.textContent = [`Current schedule date: ${r.current_date}`, `Mario source date: ${r.mario_date || "(blank)"}`, `Earlier legal-draft date: ${r.legal_draft_date || "(blank)"}`, "", `Final wording: ${r.final_description || ""}`, "", `Mario wording: ${r.mario_description || ""}`, "", `Earlier draft wording: ${r.legal_draft_description || ""}`].join("\n");
    el.source.textContent = `Filename: ${r.filename || "(missing)"}`;
    renderList(); counts(); previewSource(r);
  }

  function from2Year(y){const n=Number(y); if(n < 30) return 2000+n; if(n < 100) return 1900+n; return n;}
  function validDate(y,m,d){if(!y||!m||!d||m<1||m>12||d<1||d>31)return false; const dt = new Date(y, m-1, d); return dt.getFullYear()===y && dt.getMonth()===m-1 && dt.getDate()===d;}
  function fmt(y,m,d){return new Date(y, m-1, d).toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric"});}
  function dateObj(label, y,m,d, context){return {label, y, m, d, text:fmt(y,m,d), context:context||""};}
  function addDate(arr, obj){if(!obj) return; const key = `${obj.y}-${obj.m}-${obj.d}`; if(!arr.some(x => `${x.y}-${x.m}-${x.d}` === key)) arr.push(obj);}
  function extractDates(text, filename){
    const out = [];
    const src = `${filename || ""}\n${text || ""}`;
    for (const m of src.matchAll(/\b(20\d{2})[-_](\d{1,2})[-_](\d{1,2})\b/g)){const y=+m[1], mo=+m[2], d=+m[3]; if(validDate(y,mo,d)) addDate(out,dateObj("filename/iso",y,mo,d,lineAround(src,m.index)));}
    for (const m of src.matchAll(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/g)){const y=+m[1], mo=+m[2], d=+m[3]; if(validDate(y,mo,d)) addDate(out,dateObj("filename yyyymmdd",y,mo,d,lineAround(src,m.index)));}
    for (const m of src.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/g)){const mo=+m[1], d=+m[2], y=from2Year(m[3]); if(validDate(y,mo,d)) addDate(out,dateObj("numeric",y,mo,d,lineAround(src,m.index)));}
    const monthNames = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
    const rx1 = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2}|19\\d{2})\\b`, "gi");
    for (const m of src.matchAll(rx1)){const mo=monthMap.get(m[1].toLowerCase().replace(/\.$/,"")); const d=+m[2], y=+m[3]; if(validDate(y,mo,d)) addDate(out,dateObj("month name",y,mo,d,lineAround(src,m.index)));}
    return out;
  }
  function lineAround(text, idx){const s = Math.max(0, text.lastIndexOf("\n", idx-1)+1); let e = text.indexOf("\n", idx); if(e < 0) e = Math.min(text.length, idx+180); return normSpaces(text.slice(s,e));}
  function monthYearCurrent(s){const m = String(s||"").match(/^([A-Za-z]+)\s+(\d{4})$/); if(!m) return null; const mo=monthMap.get(m[1].toLowerCase()); return mo ? {m:mo, y:+m[2]} : null;}
  function yearCurrent(s){const m=String(s||"").match(/^(19|20)\d{2}$/); return m ? +s : null;}
  function priorityScore(d, record){
    const ctx = d.context.toLowerCase(); let score = 1;
    if (/\b(issue date|issued|sent|date:|hearing held|meeting held|adopted|resolution|filing date|received|created|modified)\b/.test(ctx)) score += 6;
    if (/\b(expires|expiration|exp date|vac exp|vaccination|birth year|prev\.? exp|new exp|dob)\b/.test(ctx)) score -= 4;
    if (record.date_type === "Month and year only"){const my=monthYearCurrent(record.current_date); if(my && d.y===my.y && d.m===my.m) score += 10;}
    const y = yearCurrent(record.current_date); if(y && d.y===y) score += 6;
    return score;
  }
  function chooseDate(record, dates){
    if (!dates.length) return {date:"", reason:"No exact calendar date found in OCR or filename."};
    const currentMY = monthYearCurrent(record.current_date);
    let pool = dates.slice();
    if (currentMY) pool = pool.filter(d => d.y===currentMY.y && d.m===currentMY.m);
    const currentY = yearCurrent(record.current_date);
    if (currentY) pool = pool.filter(d => d.y===currentY);
    if (!pool.length) return {date:"", reason:`OCR found dates, but none clearly match the schedule date '${record.current_date}'. Found: ${dates.map(d=>d.text).join("; ")}`};
    pool.sort((a,b) => priorityScore(b,record)-priorityScore(a,record));
    const topScore = priorityScore(pool[0],record);
    const ties = pool.filter(d => priorityScore(d,record) === topScore);
    if (ties.length > 1 && topScore < 9) return {date:"", reason:`Multiple possible dates were found and the OCR did not make one clearly controlling: ${pool.map(d=>`${d.text} (${d.context})`).join("; ")}`};
    return {date:pool[0].text, reason:`Chosen from OCR/filename context: ${pool[0].context || pool[0].label}`};
  }
  function descriptionFromText(record, text){
    const lower = text.toLowerCase();
    let m;
    if ((m = text.match(/Project Description:\s*([^\n]+)/i))) return `Town of Franklinville building permit — ${normSpaces(m[1])}`;
    if (lower.includes("dog license")) {const dog=(text.match(/Dog Name:\s*([^\n]+)/i)||[])[1]; const owner=(text.match(/\n([A-Z][A-Z' -]+)\n\d{2,5}\s+/)||[])[1]; return `Town of Franklinville dog license${dog?` for ${normSpaces(dog)}`:""}${owner?` / ${normSpaces(owner)}`:""}`;}
    if (lower.includes("in-service training") && lower.includes("code enforcement officer")) return "DOS email about Code Enforcement Officer certification in-service training requirements";
    if (lower.includes("resolution authorizing hancock estabrook")) return "Town resolution authorizing Hancock Estabrook, LLP to commence a declaratory judgment action regarding insurance coverage";
    if (lower.includes("application for dog license")) return "Town of Franklinville application form for dog license";
    if (lower.includes("town recognizes public concern") && lower.includes("ongoing litigation")) return "Town of Franklinville public statement about litigation, back pay, ZBA residency, and conflict-of-interest claims";
    if (lower.includes("c of o") || lower.includes("certificate of occupancy")) return "Text-message thread about certificate of occupancy / C of O";
    if (lower.includes("zoning violation") && lower.includes("code enforcement officer")) return "Text-message thread about zoning violation, permits, and code-enforcement authority";
    if (lower.includes("more than four dogs") && lower.includes("kennel license")) return "Text-message thread warning about dog licensing / kennel-license enforcement";
    if (lower.includes("facebook") || lower.includes("updated her cover photo") || lower.includes("add friend")) return "Facebook screenshot / public social-media post";
    return record.final_description || record.mario_description || record.legal_draft_description || "";
  }
  function unpackDropboxFetch(text){
    let raw = text || "";
    try {const outer = JSON.parse(raw); if (outer && outer.text) return String(outer.text || "");} catch {}
    const marker = '"text":"'; const idx = raw.indexOf(marker);
    if (idx >= 0) { try { const obj = JSON.parse(raw.slice(raw.indexOf('{', Math.max(0, idx-300)), raw.lastIndexOf('}')+1)); if (obj && obj.text) return String(obj.text); } catch {} }
    return raw;
  }
  async function findOcr(record){
    if (!record.filename) return null;
    const q = `${record.filename}.search.txt`;
    const data = await rpc("files/search_v2", {query:q, options:{path:OCR_PATH, filename_only:true, max_results:10, file_status:"active"}});
    let hits = (data.matches||[]).map(m=>m.metadata && m.metadata.metadata).filter(Boolean).filter(m=>m[".tag"]==="file");
    hits = hits.filter(h => String(h.name||"").toLowerCase() === q.toLowerCase() || String(h.path_display||"").toLowerCase().includes(`/${q.toLowerCase()}`));
    hits.sort((a,b) => String(a.name||"").localeCompare(String(b.name||"")));
    return hits[0] || null;
  }
  async function analyzeOne(record){
    const cached = cache[String(record.number)]; if (cached && cached.status !== "unchecked") return cached;
    let ocrHit = null, text = "";
    try {ocrHit = await findOcr(record);} catch (e) {return cache[String(record.number)] = {status:"no_ocr", suggestedDate:"", suggestedDescription:record.final_description||"", reason:`Could not search OCR descriptors: ${e.message}`, dates:[], ocrText:"", ocrPath:""};}
    if (!ocrHit) return cache[String(record.number)] = {status:"no_ocr", suggestedDate:"", suggestedDescription:record.final_description||"", reason:"No OCR/descriptor .search.txt file found for this filename.", dates:[], ocrText:"", ocrPath:""};
    try {text = unpackDropboxFetch(await downloadText(ocrHit.id || ocrHit.path_display || ocrHit.path_lower));} catch (e) {return cache[String(record.number)] = {status:"no_ocr", suggestedDate:"", suggestedDescription:record.final_description||"", reason:`OCR descriptor found but could not download text: ${e.message}`, dates:[], ocrText:"", ocrPath:ocrHit.path_display||ocrHit.id||""};}
    const dates = extractDates(text, record.filename);
    const choice = chooseDate(record, dates);
    const desc = descriptionFromText(record, text);
    const result = {
      status: choice.date ? "resolved" : (dates.length ? "ambiguous" : "unresolved"),
      suggestedDate: choice.date, suggestedDescription: desc, reason: choice.reason,
      dates: dates.map(d=>`${d.text}${d.context ? ` — ${d.context}` : ""}`),
      ocrText: text, ocrPath: ocrHit.path_display || ocrHit.id || ""
    };
    cache[String(record.number)] = result; saveCache(); return result;
  }
  async function runAll(){
    if (!token){setStatus("Dropbox is not connected. Press Connect Dropbox first."); return;}
    el.run.disabled = true; setStatus("OCR recheck running across all 137 incomplete-date records…", true);
    for (let i=0; i<records.length; i++){
      const r = records[i]; el.previewStatus.textContent = `Checking ${i+1} of ${records.length}: No. ${r.number} ${r.filename || ""}`;
      try {await analyzeOne(r);} catch (e) {cache[String(r.number)] = {status:"unresolved", suggestedDate:"", suggestedDescription:r.final_description||"", reason:e.message||"OCR recheck failed.", dates:[], ocrText:"", ocrPath:""}; saveCache();}
      if (i % 3 === 0) {renderList(); counts(); await new Promise(res => setTimeout(res, 40));}
    }
    renderList(); counts(); select(active); setStatus("OCR recheck complete. The left list is now only the records still unresolved.", true); el.run.disabled = false;
  }
  async function resolveSource(record){
    if (sourceCache[record.number]) return sourceCache[record.number];
    if (!record.filename) throw new Error("No filename for this record.");
    let last = null;
    for (const folder of SOURCE_FOLDERS){try{const t = await tempLink(folder + record.filename); return sourceCache[record.number] = {name:record.filename, path:folder + record.filename, link:t.link};}catch(e){last=e;}}
    const data = await rpc("files/search_v2", {query:record.filename, options:{path:"/jake Geiger", filename_only:true, max_results:20, file_status:"active"}});
    const hits = (data.matches||[]).map(m=>m.metadata && m.metadata.metadata).filter(Boolean).filter(m=>m[".tag"]==="file" && String(m.name||"").toLowerCase()===record.filename.toLowerCase());
    for (const h of hits){try{const t = await tempLink(h.id || h.path_display || h.path_lower); return sourceCache[record.number] = {name:h.name || record.filename, path:h.path_display || h.id, link:t.link};}catch(e){last=e;}}
    throw last || new Error("Could not find source file.");
  }
  async function previewSource(record){
    if (!token){el.previewStatus.textContent = "Waiting for Dropbox connection."; return;}
    el.previewStatus.textContent = `Loading source preview for ${record.filename || "file"}…`;
    el.preview.innerHTML = `<div class="preview-card"><div class="loading-spinner"></div><div class="empty-preview">Loading source file preview…</div></div>`;
    try {const src = await resolveSource(record); renderPreview(record, src);} catch(e){el.previewStatus.textContent = "Source file preview not loaded."; el.preview.innerHTML = `<div class="preview-card"><div class="empty-preview">${esc(e.message || "Could not preview source file.")}</div></div>`;}
  }
  function ext(name){return (String(name||"").toLowerCase().match(/\.[a-z0-9]{1,8}$/)||[""])[0];}
  function renderPreview(record, src){
    const e = ext(src.name || record.filename), link = src.link; const card = document.createElement("div"); card.className = "preview-card";
    const actions = document.createElement("div"); actions.className = "file-actions"; actions.innerHTML = `<a href="${esc(link)}" target="_blank" rel="noopener">Open source file</a><a href="${esc(link)}" download="${esc(src.name||record.filename)}">Save copy</a>`; card.appendChild(actions);
    if ([".jpg",".jpeg",".png",".gif",".webp",".bmp",".tif",".tiff"].includes(e)){const img=document.createElement("img"); img.src=link; img.alt=src.name||record.filename; card.appendChild(img);} else if (e===".pdf"){const f=document.createElement("iframe"); f.src=link; f.title=src.name||record.filename; card.appendChild(f);} else if ([".mp4",".mov",".m4v",".webm"].includes(e)){const v=document.createElement("video"); v.controls=true; v.src=link; card.appendChild(v);} else if ([".mp3",".wav",".m4a",".aac",".ogg"].includes(e)){const a=document.createElement("audio"); a.controls=true; a.src=link; card.appendChild(a);} else {const d=document.createElement("div"); d.className="empty-preview"; d.textContent="This file type may not preview in the browser. Use Open source file above."; card.appendChild(d);}
    el.preview.innerHTML=""; el.preview.appendChild(card); el.previewStatus.textContent = `Showing ${src.name || record.filename}.`;
  }
  function csv(v){return `"${String(v??"").replaceAll('"','""')}"`;}
  function exportRows(type){
    const rows = records.filter(r => type === "resolved" ? isResolved(getResult(r)) : !isResolved(getResult(r)));
    const head = ["Schedule No.","Category","Original incomplete date","Date type","Exact filename","OCR status","Suggested exact date","Suggested description/topic","Reason / review issue","OCR dates found","OCR descriptor path","Original schedule description"];
    const lines = [head.map(csv).join(",")];
    for (const r of rows){const res = getResult(r); lines.push([r.number,r.category,r.current_date,r.date_type,r.filename,statusLabel(res),res.suggestedDate,res.suggestedDescription,res.reason,(res.dates||[]).join("; "),res.ocrPath,r.final_description].map(csv).join(","));}
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], {type:"text/csv;charset=utf-8"}); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = type === "resolved" ? "Mario_OCR_Auto_Resolved_Records.csv" : "Mario_OCR_Still_Unresolved_Records.csv"; a.click(); URL.revokeObjectURL(a.href);
  }
  async function connect(){
    token = safeGet(TOKEN);
    if (token){setStatus("Dropbox connected. Run OCR recheck to filter the list.", true); await previewSource(recordByNo(active)); return;}
    safeSet("masics_auth_return_to", "date-review"); safeSet("masics_return_to_date_review", "1"); location.assign("./");
  }
  el.connect.onclick = connect; el.run.onclick = runAll; el.exportUnresolved.onclick = () => exportRows("unresolved"); el.exportResolved.onclick = () => exportRows("resolved");
  el.search.oninput = () => {renderList(); counts();}; el.dateType.onchange = () => {renderList(); counts();}; el.viewMode.onchange = () => {renderList(); counts();};
  renderList(); counts(); select(active);
  if (token) setStatus("Dropbox connected. Press Run OCR recheck.", true); else setStatus("Dropbox is not connected. Press Connect Dropbox, then run the OCR recheck.");
})();
