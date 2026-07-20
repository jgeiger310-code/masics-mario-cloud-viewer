async function addFileActions(container,source){
  const actions=document.createElement("div");actions.className="file-actions";
  try{
    const link=await temporaryLink(source);
    const open=document.createElement("a");open.href=link;open.target="_blank";open.rel="noopener";open.textContent="Open original file";
    const save=document.createElement("a");save.href=link;save.download=source.filename||"source-file";save.textContent="Save a copy";
    actions.append(open,save);
  }catch(err){
    const warn=document.createElement("span");warn.className="alert";warn.textContent=err.message;actions.appendChild(warn);
  }
  container.prepend(actions);
}
async function previewSource(source){
  releasePreview();
  if(!source){showEmptyPreview("Choose a source file match above.");return}
  els.previewStatus.textContent=`Loading ${source.filename||"source file"} from Dropbox…`;
  showEmptyPreview("Loading the selected file contents…",true);
  previewAbort=new AbortController();
  const expectedReviewId=source.review_id;
  try{
    const response=await downloadFirst(evidenceLocators(source),previewAbort.signal);
    const blob=await response.blob();
    if(selectedSource()?.review_id!==expectedReviewId)return;
    const ext=fileExt(source),type=blob.type||"";
    activeObjectUrl=URL.createObjectURL(blob);
    const card=document.createElement("div");card.className="preview-card";
    if(type.startsWith("image/")||[".jpg",".jpeg",".png",".gif",".webp",".bmp",".heic",".tif",".tiff"].includes(ext)){
      const img=document.createElement("img");img.alt=source.filename||"Source file";img.src=activeObjectUrl;
      img.onerror=()=>{img.replaceWith(Object.assign(document.createElement("div"),{className:"alert",textContent:"The browser could not display this image format. Use Open original file."}))};
      card.appendChild(img);
    }else if(type==="application/pdf"||ext===".pdf"){
      const frame=document.createElement("iframe");frame.src=activeObjectUrl;frame.title=source.filename||"PDF contents";card.appendChild(frame);
    }else if(ext===".docx"){
      if(!window.mammoth)throw new Error("The DOCX preview component did not load.");
      const result=await window.mammoth.convertToHtml({arrayBuffer:await blob.arrayBuffer()});
      const article=document.createElement("article");article.className="preview-docx";article.appendChild(sanitizeDocx(result.value));card.appendChild(article);
    }else if([".xlsx",".xls"].includes(ext)){
      if(!window.XLSX)throw new Error("The spreadsheet preview component did not load.");
      const book=window.XLSX.read(await blob.arrayBuffer(),{type:"array"});
      const sheet=book.Sheets[book.SheetNames[0]];
      const data=window.XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false}).slice(0,500).map(row=>row.slice(0,50));
      const table=document.createElement("table");table.className="sheet-table";
      data.forEach((row,ri)=>{
        const tr=document.createElement("tr");
        row.forEach(value=>{const cell=document.createElement(ri===0?"th":"td");cell.textContent=String(value);tr.appendChild(cell)});
        table.appendChild(tr);
      });
      const wrap=document.createElement("div");wrap.style.overflow="auto";wrap.appendChild(table);card.appendChild(wrap);
    }else if(type.startsWith("text/")||[".txt",".csv",".json",".md",".html",".htm",".xml",".eml",".log"].includes(ext)){
      const pre=document.createElement("pre");pre.textContent=(await blob.text()).slice(0,500000);card.appendChild(pre);
    }else if(type.startsWith("audio/")||[".mp3",".wav",".m4a",".aac",".ogg"].includes(ext)){
      const media=document.createElement("audio");media.controls=true;media.src=activeObjectUrl;card.appendChild(media);
    }else if(type.startsWith("video/")||[".mp4",".mov",".m4v",".webm"].includes(ext)){
      const media=document.createElement("video");media.controls=true;media.src=activeObjectUrl;card.appendChild(media);
    }else{
      const msg=document.createElement("div");msg.className="empty-preview";
      msg.textContent="This file format cannot be displayed directly inside the browser. Use Open original file below.";
      card.appendChild(msg);
    }
    const text=extractedText(source);
    if(text){
      const box=document.createElement("div");box.className="ocr-box";
      const details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre");
      summary.textContent="Show indexed/OCR text from the source record";pre.textContent=text.slice(0,300000);
      details.append(summary,pre);box.appendChild(details);card.appendChild(box);
    }
    await addFileActions(card,source);
    els.preview.innerHTML="";els.preview.appendChild(card);
    els.previewStatus.textContent=`Showing ${source.filename||"selected source file"}.`;
  }catch(err){
    if(err.name==="AbortError")return;
    showEmptyPreview(err.message||"The selected file could not be previewed.");
    els.previewStatus.textContent="Preview could not be loaded. Try another source-file match.";
  }
}
function csvCell(value){return `"${String(value??"").replaceAll('"','""')}"`}
function exportCsv(){
  persistCurrent(false);
  const head=["Schedule No.","Category","Original incomplete date","Date type","Corrected date","Corrected description","Confirmed","Remove from schedule","Removal reason","Reviewer notes","Selected source queue number","Selected source filename","Selected source Dropbox path","Selected source review ID","Mario source note","Original legal description"];
  const rows=[head.map(csvCell).join(",")];
  SCHEDULE_RECORDS.forEach(r=>{
    const e=editFor(r),s=missingSources.find(x=>x.review_id===e.chosenReviewId)||{};
    rows.push([r.number,r.category,r.current_date,r.date_type,e.correctedDate,e.correctedDescription,e.confirmed?"Yes":"No",e.remove?"Yes":"No",e.removeReason,e.notes,s.queue_number||"",s.filename||"",s.dropbox_path||"",s.review_id||"",s._marioNotes||"",r.final_description].map(csvCell).join(","));
  });
  const blob=new Blob(["\ufeff"+rows.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="Mario_Incomplete_Date_Source_File_Review.csv";a.click();URL.revokeObjectURL(a.href);
}
els.connect.addEventListener("click",connectDropbox);
els.reload.addEventListener("click",()=>loadSourceData(true));
els.export.addEventListener("click",exportCsv);
els.search.addEventListener("input",()=>{renderList();updateCounts()});
els.dateType.addEventListener("change",()=>{renderList();updateCounts()});
els.reviewStatus.addEventListener("change",()=>{renderList();updateCounts()});
els.save.addEventListener("click",()=>persistCurrent(true));
els.next.addEventListener("click",()=>{
  persistCurrent(true);
  const rows=filtered(),idx=rows.findIndex(r=>r.number===activeNumber),next=rows[idx+1]||rows[0];
  if(next)selectSchedule(next.number);
});
els.datePicker.addEventListener("change",()=>{const d=dateFromPicker(els.datePicker.value);if(d)els.correctedDate.value=d});
els.candidate.addEventListener("change",async()=>{
  const r=activeSchedule(),s=selectedSource();if(!r||!s)return;
  saveEdit(r,{chosenReviewId:s.review_id});showCandidateMeta(s,similarity(r,s));await previewSource(s);
});
els.rematch.addEventListener("click",()=>showCandidates(activeSchedule(),true));
[els.correctedDate,els.correctedDescription,els.removeReason,els.reviewNotes].forEach(el=>el.addEventListener("blur",()=>persistCurrent(false)));
[els.confirmed,els.remove].forEach(el=>el.addEventListener("change",()=>persistCurrent(false)));
window.addEventListener("pagehide",()=>{persistCurrent(false);releasePreview()});

renderList();updateCounts();selectSchedule(activeNumber);
if(token)loadSourceData();else setConnection("Dropbox is not connected. Press Connect Dropbox; the selected source file will then load automatically.");
