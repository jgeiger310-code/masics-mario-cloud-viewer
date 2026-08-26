(() => {
  "use strict";
  const cfg = window.MASICS_DROPBOX_CONFIG;
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const TOKEN_KEY = "masics_access_token";
  const AUTO_KEY = "masics_auto_export_missing_docx_v2";
  const QUERY_KEY = "export_missing_docx";
  const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.iife.js";
  const VERSION = "20260826-legal-missing-docx-2";
  if (!cfg) return;
  window.MASICS_MISSING_DOCX_EXPORT_VERSION = VERSION;

  const clean = (v) => String(v || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  function unique(values) {
    const seen = new Set();
    return values.flat().map(clean).filter((v) => v && !seen.has(v) && seen.add(v));
  }
  function lookupError(status, detail) { return status === 409 || /not_found|missing|moved|malformed_path|lookup/i.test(String(detail || "")); }
  async function download(locator) {
    const token = sessionStorage.getItem(TOKEN_KEY) || "";
    if (!token) throw new Error("Sign in with Dropbox before exporting.");
    const r = await fetch(DROPBOX_CONTENT + "files/download", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: locator }) } });
    if (r.status === 401) throw new Error("Dropbox authentication expired. Sign in again.");
    if (r.status === 403) throw new Error("Dropbox permission denied for the review files.");
    if (!r.ok) {
      let detail = ""; try { detail = await r.text(); } catch {}
      const e = new Error(`Dropbox download failed: ${r.status}${detail ? ` (${detail.slice(0, 180)})` : ""}`); e.lookupFailure = lookupError(r.status, detail); throw e;
    }
    return r;
  }
  async function jsonFirst(locators) {
    let last = null;
    for (const locator of unique(locators)) {
      try { return await (await download(locator)).json(); }
      catch (e) { last = e; if (!e.lookupFailure) throw e; }
    }
    throw last || new Error("Required Dropbox review data could not be located.");
  }
  async function liveData() {
    const base = clean(cfg.progressDropboxFolder).replace(/\/+$/g, "");
    const alt = (cfg.progressDropboxFolderAlternates || []).map((x) => clean(x).replace(/\/+$/g, ""));
    const [manifest, progress] = await Promise.all([
      jsonFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]),
      jsonFirst([cfg.progressDropboxLatestJsonId, base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "", alt.map((x) => x ? `${x}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "")])
    ]);
    if (!manifest || manifest.queue_identity !== cfg.queueIdentity || !Array.isArray(manifest.records)) throw new Error("Queue manifest identity mismatch.");
    if (!progress || progress.queueIdentity !== cfg.queueIdentity || !progress.decisions) throw new Error("Review progress identity mismatch.");
    return { manifest, progress };
  }
  function splitNotes(value) {
    const text = clean(value); const i = text.search(/\bAI note:/i);
    return i < 0 ? { mario: text, ai: "" } : { mario: text.slice(0, i).trim(), ai: text.slice(i).replace(/^AI note:\s*/i, "").trim() };
  }
  function sourceBates(display, notes) {
    const direct = clean(display.bates_range || display.bates_begin); if (direct) return direct;
    const m = String(notes || "").match(/\bBATES:\s*([^|\n\r]+)/i) || String(notes || "").match(/\bBates\s+([A-Z]{2,}[0-9][A-Z0-9]*(?:\s*[-–]\s*[A-Z]{2,}[0-9][A-Z0-9]*)?)/); return m ? clean(m[1]) : "";
  }
  function derivedCategory(record, display) {
    const outcome = clean(display.missing_discovery_outcomes).toUpperCase(), req = clean(display.mfr_request_ids), titles = clean(display.mfr_request_titles), reason = clean(display.match_reason), root = clean(display.source_root_name || record.source_root_folder || record.source_root_name), type = clean(record.file_type || record.extension).toLowerCase();
    if (req || /\bMFR\b/i.test(reason) || /\bMFR\b/i.test(titles)) return "Discovery request / MFR evidence";
    if (outcome.includes("DEFENSE_PRODUCTION")) return "Defense production evidence";
    if (outcome.includes("PLAINTIFF_EVIDENCE")) return "Plaintiff evidence / missing discovery support";
    if (/franklinville/i.test(root)) return "Franklinville municipal record";
    if (/jpe?g|png|heic|tiff/.test(type)) return "Image / screenshot evidence";
    if (/pdf/.test(type)) return "PDF document evidence";
    if (/mp3|amr|wav|m4a|aac|ogg/.test(type)) return "Audio evidence";
    if (/mp4|mov|m4v|webm/.test(type)) return "Video evidence";
    return "Uncategorized / needs legal review";
  }
  function row(record, saved) {
    const display = record.display || {}, notes = splitNotes(saved.notes), q = Number(record.queue_number) || 0;
    const priority = clean(display.priority_tier), usablePriority = /^[A-Z]$|^\d+$/i.test(priority) || /_|APPEND|BUCKET|UNRANKED|STAGED/i.test(priority) ? "" : priority;
    return {
      queue: q,
      bates: clean(display.viewer_bates || display.control_bates || (q ? `MASICS-${String(q).padStart(5, "0")}` : "")),
      sourceBates: sourceBates(display, saved.notes),
      category: clean(display.category || display.legal_category || usablePriority || derivedCategory(record, display)) || "Uncategorized / needs legal review",
      filename: clean(record.filename), type: clean(record.file_type || record.extension).replace(/^\./, "").toUpperCase(),
      mario: notes.mario, ai: notes.ai || clean(display.ai_note || record.ai_note), reviewId: clean(record.review_id), path: clean(record.dropbox_path),
      request: [clean(display.mfr_request_ids), clean(display.mfr_request_titles)].filter(Boolean).join(" — ")
    };
  }
  function rowsByDecision(manifest, progress, decision) {
    return manifest.records.map((r) => { const s = progress.decisions[r.review_id] || {}; return clean(s.decision).toLowerCase() === decision ? row(r, s) : null; }).filter(Boolean).sort((a,b) => a.queue-b.queue);
  }
  function groups(rows) {
    const map = new Map(); rows.forEach((r) => { if (!map.has(r.category)) map.set(r.category, []); map.get(r.category).push(r); }); return [...map.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  }
  function loadScript(src) {
    if (window.docx && window.docx.Document) return Promise.resolve();
    return new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Unable to load the Word export library.")); document.head.appendChild(s); });
  }
  function itemParas(d, item, number) {
    const out = [new d.Paragraph({ spacing:{before:120,after:35}, children:[new d.TextRun({text:`${number}. ${item.bates} — ${item.filename}`,bold:true,size:21})] })];
    [["Queue #",item.queue],["File type",item.type],["Source Bates / range",item.sourceBates],["Mario's note / missing information",item.mario],["Neutral description",item.ai],["Related request / MFR",item.request],["Review ID",item.reviewId],["Evidence path",item.path]].forEach(([label,value]) => { if (value) out.push(new d.Paragraph({ indent:{left:360}, spacing:{after:20}, children:[new d.TextRun({text:`${label}: `,bold:true,size:18}),new d.TextRun({text:String(value),size:18})] })); });
    return out;
  }
  async function makeDocx(manifest, progress) {
    await loadScript(DOCX_URL); const d = window.docx; if (!d || !d.Document) throw new Error("Word export library loaded without the expected browser API.");
    const missing = rowsByDecision(manifest, progress, "missing"), needs = rowsByDecision(manifest, progress, "needs_review"), total = Number(progress.total || manifest.records.length || 0), reviewed = Number(progress.reviewed || 0), excluded = Number(progress.excluded || 0), pending = Number(progress.pending || 0);
    const body = [];
    body.push(new d.Paragraph({alignment:d.AlignmentType.CENTER,children:[new d.TextRun({text:"MASICS / MARIO REVIEW",bold:true,size:30})]}));
    body.push(new d.Paragraph({alignment:d.AlignmentType.CENTER,spacing:{after:220},children:[new d.TextRun({text:"SCHEDULE OF MATERIALS IDENTIFIED AS MISSING OR UNPRODUCED",bold:true,size:27})]}));
    body.push(new d.Paragraph({alignment:d.AlignmentType.CENTER,spacing:{after:260},children:[new d.TextRun({text:`Live tracker export — ${new Date().toISOString().slice(0,10)}`,italics:true,size:18})]}));
    body.push(new d.Paragraph({heading:d.HeadingLevel.HEADING_1,text:"Review Status and Scope"}));
    body.push(new d.Paragraph({text:`Queue: ${total.toLocaleString()} records; reviewed/retained: ${reviewed.toLocaleString()}; excluded: ${excluded.toLocaleString()}; pending: ${pending.toLocaleString()}; marked Missing: ${missing.length.toLocaleString()}; Needs Further Review: ${needs.length.toLocaleString()}.`}));
    body.push(new d.Paragraph({spacing:{after:160},children:[new d.TextRun({text:"Legal-use qualification: ",bold:true}),new d.TextRun("This schedule reports Mario's review designations and associated database metadata. It does not independently establish that a discovery obligation was violated. Before filing, counsel should tie each asserted omission to the governing demand, order, disclosure duty, or representation and verify any source Bates/page range against the produced set.")]}));
    body.push(new d.Paragraph({heading:d.HeadingLevel.HEADING_1,text:"Schedule A — Records Marked Missing"}));
    let n=1; groups(missing).forEach(([cat,rs])=>{body.push(new d.Paragraph({heading:d.HeadingLevel.HEADING_2,text:`${cat} (${rs.length})`}));rs.forEach(r=>{body.push(...itemParas(d,r,n++));});});
    body.push(new d.Paragraph({pageBreakBefore:true,heading:d.HeadingLevel.HEADING_1,text:"Schedule B — Needs Further Review / Visibility Exceptions"}));
    body.push(new d.Paragraph({text:"These records have a nonblank Needs Further Review decision. They remain exceptions even though the live tracker has zero Pending records."}));
    let x=1; groups(needs).forEach(([cat,rs])=>{body.push(new d.Paragraph({heading:d.HeadingLevel.HEADING_2,text:`${cat} (${rs.length})`}));rs.forEach(r=>{body.push(...itemParas(d,r,x++));});});
    const wordDoc = new d.Document({creator:"MASICS Mario Review Viewer",title:"MASICS Mario Missing / Unproduced Materials Schedule",styles:{default:{document:{run:{font:"Arial",size:20},paragraph:{spacing:{line:276}}}}},sections:[{properties:{page:{margin:{top:720,right:720,bottom:720,left:720}}},footers:{default:new d.Footer({children:[new d.Paragraph({alignment:d.AlignmentType.CENTER,children:[new d.TextRun({text:"MASICS Missing Materials Schedule — Page ",size:16}),d.PageNumber.CURRENT,new d.TextRun({text:" of ",size:16}),d.PageNumber.TOTAL_PAGES]})]})},children:body}]});
    const blob = await d.Packer.toBlob(wordDoc), url = URL.createObjectURL(blob), a = document.createElement("a"), date = new Date().toISOString().slice(0,10), filename=`MASICS_Mario_Missing_Legal_Schedule_${date}_${missing.length}_missing_${needs.length}_needs_review.docx`;
    a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return {filename,missing:missing.length,needs:needs.length};
  }
  function status(text){const el=document.getElementById("status-line");if(el)el.textContent=text;}
  async function exportNow(){const b=document.getElementById("export-missing-docx");if(b)b.disabled=true;status("Building the live legal Missing-materials Word schedule...");try{const {manifest,progress}=await liveData();const r=await makeDocx(manifest,progress);status(`Downloaded ${r.filename}. Includes ${r.missing} Missing records and ${r.needs} Needs Further Review exceptions.`);}finally{if(b)b.disabled=false;}}
  function request(){if(!sessionStorage.getItem(TOKEN_KEY)){sessionStorage.setItem(AUTO_KEY,"1");const s=document.getElementById("sign-in");if(s)s.click();return;}exportNow().catch(e=>status(e.message||"Word export failed."));}
  function wire(){const p=new URLSearchParams(location.search);if(p.get(QUERY_KEY)==="1")sessionStorage.setItem(AUTO_KEY,"1");const b=document.getElementById("export-missing-docx");if(b)b.addEventListener("click",request);let tries=0;const timer=setInterval(()=>{tries++;if(sessionStorage.getItem(AUTO_KEY)!=="1"){clearInterval(timer);return;}if(sessionStorage.getItem(TOKEN_KEY)){sessionStorage.removeItem(AUTO_KEY);clearInterval(timer);exportNow().catch(e=>status(e.message||"Word export failed."));return;}const q=new URLSearchParams(location.search);if(!q.has("code")&&!q.has("state")&&tries===2){const s=document.getElementById("sign-in");if(s&&!s.hidden)s.click();}if(tries>240){clearInterval(timer);status("Dropbox sign-in did not complete. Try the Word export again.");}},500);}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire,{once:true});else wire();
})();
