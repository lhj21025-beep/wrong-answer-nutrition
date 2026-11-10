"use strict";
// Functions for standalone study.html. Deploy only these named functions to preserve analyzeProblemImage.
const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {defineSecret}=require("firebase-functions/params");
const admin=require("firebase-admin");
const crypto=require("node:crypto");
if(!admin.apps.length)admin.initializeApp();
const db=admin.firestore(),bucket=admin.storage().bucket(),key=defineSecret("GEMINI_API_KEY");
const MODEL=process.env.GEMINI_MODEL||"gemini-2.5-flash",REGION="us-central1";
function user(r){if(!r.auth?.uid)throw new HttpsError("unauthenticated","로그인이 필요합니다.");return r.auth.uid;}
function id(x){let s=String(x||"");if(!/^[\w-]{8,100}$/.test(s))throw new HttpsError("invalid-argument","자료 ID 오류");return s;}
function ref(uid,s){return db.doc("users/"+uid+"/studySources/"+id(s));}
function path(uid,s){return "users/"+uid+"/studySources/"+id(s)+"/original";}
function str(x,n=4000){return String(x||"").slice(0,n);}
function norm(x){return String(x||"").replace(/\s+/g," ").trim();}
function parse(x){try{return JSON.parse(x);}catch(e){throw new HttpsError("internal","AI가 올바른 JSON을 반환하지 않았습니다. 다시 시도하세요.");}}
async function ask(parts,opt={}){
  if(!key.value())throw new HttpsError("failed-precondition","GEMINI_API_KEY 시크릿이 필요합니다.");
  let response,body;
  try{
    response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(MODEL)+":generateContent",{
      method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key.value()},
      body:JSON.stringify({contents:[{parts}],generationConfig:{temperature:opt.temp??0.1,maxOutputTokens:opt.max??8192,...(opt.json?{responseMimeType:"application/json"}:{})}}),
      signal:AbortSignal.timeout(110000)
    });body=await response.json();
  }catch(e){throw new HttpsError("unavailable","AI 서버 연결 오류: "+e.message);}
  if(!response.ok){console.error("Gemini",response.status,JSON.stringify(body).slice(0,600));throw new HttpsError("unavailable","Gemini API 오류("+response.status+"): 서버 키·모델·사용량을 확인하세요.");}
  const t=(body.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("").trim();
  if(!t)throw new HttpsError("unavailable","AI 답변이 비어 있습니다.");
  return t;
}
async function sourceText(uid,ids){
  if(!Array.isArray(ids)||ids.length<1||ids.length>25)throw new HttpsError("invalid-argument","파일을 1~25개 선택하세요.");
  const unique=[...new Set(ids.map(id))], result=[];
  for(const key of unique){
    const doc=await ref(uid,key).get();
    if(!doc.exists||doc.data().status!=="ready")throw new HttpsError("failed-precondition","분석이 완료되지 않은 파일이 있습니다.");
    const parts=await doc.ref.collection("parts").orderBy("index").get();
    let text=parts.docs.map(d=>d.data().text||"").join("");
    if(!text.trim())throw new HttpsError("failed-precondition","파일의 추출 텍스트가 없습니다.");
    const limit=Math.max(3500,Math.floor(115000/unique.length));
    if(text.length>limit){const a=Math.floor(limit*.5),b=Math.floor(limit*.25);text=text.slice(0,a)+"\n[중간 발췌]\n"+text.slice(Math.floor(text.length/2)-b,Math.floor(text.length/2)+b)+"\n[마지막 발췌]\n"+text.slice(-b);}
    result.push({id:key,name:str(doc.data().name,150),text});
  }
  return result;
}
function itemClean(x,sources){
  const src=sources.find(s=>s.id===x?.sourceId),q=norm(x?.question),a=norm(x?.answer),e=norm(x?.evidence);
  if(!src||q.length<6||!a||e.length<8||e.length>280||!norm(src.text).includes(e))return null;
  return {sourceId:src.id,sourceName:src.name,question:str(q,500),answer:str(a,1400),
    explanation:str(x.explanation,1500),evidence:e};
}
exports.processStudySource=onCall({region:REGION,secrets:[key],timeoutSeconds:180,memory:"1GiB"},async(r)=>{
  const uid=user(r),s=id(r.data?.sourceId),doc=ref(uid,s);
  if(!(await doc.get()).exists)throw new HttpsError("not-found","파일 정보가 없습니다.");
  const file=bucket.file(path(uid,s));
  try{
    const [meta]=await file.getMetadata(),mime=String(meta.contentType||"").split(";")[0];
    if(!["application/pdf","image/jpeg","image/png","image/webp"].includes(mime)||Number(meta.size)>10*1024*1024)
      throw new HttpsError("invalid-argument","PDF·JPG·PNG·WEBP 10MB 이하만 지원합니다.");
    await doc.set({status:"processing",error:null},{merge:true});
    const [buf]=await file.download();
    const output=await ask([{text:"이 한국어 학습자료 PDF/이미지의 모든 보이는 글자, 표, 필기를 가능한 한 원문 그대로 추출하라. 외부 정보나 임의 해설 추가 금지. 읽을 수 없는 곳은 [판독 불가]로 표시. 가능하면 페이지마다 [페이지] 표시. 전사 텍스트만 반환."},
      {inlineData:{mimeType:mime,data:buf.toString("base64")}}],{max:16000,temp:0});
    if(output.length<20)throw new HttpsError("failed-precondition","읽을 수 있는 내용이 부족합니다.");
    const prev=await doc.collection("parts").get();
    for(let i=0;i<prev.size;i+=400){const b=db.batch();prev.docs.slice(i,i+400).forEach(d=>b.delete(d.ref));await b.commit();}
    const chunks=output.match(/[\s\S]{1,12000}/g)||[];
    for(let i=0;i<chunks.length;i+=100){const b=db.batch();chunks.slice(i,i+100).forEach((t,j)=>b.set(doc.collection("parts").doc(String(i+j).padStart(4,"0")),{index:i+j,text:t}));await b.commit();}
    const warning=output.length>=45000?"긴 문서는 추출이 일부 누락될 수 있습니다. 학습자료를 나누어 업로드하세요.":null;
    await doc.set({status:"ready",error:null,charCount:output.length,partsCount:chunks.length,warning,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return {charCount:output.length,warning};
  }catch(e){await doc.set({status:"error",error:e.message||"분석 실패"},{merge:true});throw e instanceof HttpsError?e:new HttpsError("internal","파일 분석에 실패했습니다.");}
});
exports.generateStudyItems=onCall({region:REGION,secrets:[key],timeoutSeconds:180,memory:"1GiB"},async(r)=>{
  const uid=user(r),count=Number(r.data?.count),kind=r.data?.kind;
  if(!Number.isInteger(count)||count<1||count>30||!["card","question"].includes(kind))throw new HttpsError("invalid-argument","종류·개수를 확인하세요(1~30개).");
  const sources=await sourceText(uid,r.data?.sourceIds);
  const text=sources.map(s=>"SOURCE_ID="+s.id+" 이름="+s.name+"\n"+s.text).join("\n==== 파일 구분 ====\n");
  const prompt="아래 파일의 본문에 존재하는 사실만 이용하여 한국어 영양교사 임용시험 "+(kind==="card"?"암기 플래시카드":"주관식 문제")+" "+count+"개를 작성하라. 파일 밖의 지식, 임의 사실, 추가 숫자를 절대 넣지 마라. 파일마다 고르게 배분, 서로 다른 질문. evidence 필드는 해당 SOURCE_ID의 본문에서 8~200글자 연속 구간을 한 글자도 바꾸지 말고 정확히 복사하라. 정확히 JSON 객체 {\"items\":[{\"sourceId\":\"...\",\"question\":\"...\",\"answer\":\"...\",\"explanation\":\"...\",\"evidence\":\"원문 연속 인용\"}]}만 출력.\n"+text;
  const result=parse(await ask([{text:prompt}],{json:true,max:12000,temp:.25}));
  const seen=new Set(),items=[];
  for(const x of (Array.isArray(result.items)?result.items:[])){
    const v=itemClean(x,sources);if(v&&!seen.has(v.sourceId+v.question)){items.push(v);seen.add(v.sourceId+v.question);}
    if(items.length>=count)break;
  }
  if(!items.length)throw new HttpsError("failed-precondition","원문으로 검증되는 질문이 생성되지 않았습니다. 다시 시도하세요.");
  return {items,requested:count,returned:items.length};
});
exports.transcribeStudyAudio=onCall({region:REGION,secrets:[key],timeoutSeconds:120,memory:"1GiB"},async(r)=>{
  user(r);const mime=String(r.data?.mime||"").split(";")[0],b64=String(r.data?.base64||"");
  if(!["audio/webm","audio/ogg","audio/mp4","audio/mpeg","audio/wav"].includes(mime)||!b64||b64.length>7_000_000||!/^[a-z0-9+/=]+$/i.test(b64))
    throw new HttpsError("invalid-argument","음성 형식/용량 오류(5MB 이하).");
  const transcript=await ask([{text:"한국어 음성의 실제 발화를 그대로 전사하세요. 답변을 만들어내거나 수정하지 마세요. 불확실하면 [불명확]이라 쓰세요. 전사된 글만 출력."},
    {inlineData:{mimeType:mime,data:b64}}],{max:2500,temp:0});
  return {transcript:str(transcript,6000)};
});
function wrongKey(i){return id(i.sourceId)+"_"+crypto.createHash("sha256").update(norm(i.question)).digest("hex").slice(0,24);}
async function validate(uid,x){
  if(!x?.sourceId||!x.question||!x.answer||!x.evidence)throw new HttpsError("invalid-argument","문제 데이터 오류");
  const d=await ref(uid,x.sourceId).get();if(!d.exists)throw new HttpsError("not-found","원본 자료가 없습니다.");
  return {sourceId:id(x.sourceId),sourceName:str(d.data().name,150),question:str(x.question,500),
    answer:str(x.answer,1400),explanation:str(x.explanation,1500),evidence:str(x.evidence,280)};
}
async function legacy(uid,i,answer,feedback){
  try{
    const m=db.doc("users/"+uid+"/data/meta"),n=db.doc("users/"+uid+"/data/notes"),k=wrongKey(i);
    const today=new Date().toISOString().slice(0,10);
    await db.runTransaction(async(tx)=>{
      const [meta,notes]=await tx.getAll(m,n),md=meta.exists?meta.data():{},items=notes.exists?notes.data().items||[]:[];
      const existing=items.find(x=>x.studyWrongKey===k);
      if(existing){existing.wrongCount=(existing.wrongCount||0)+1;existing.wrongReason=str(feedback,500);tx.set(n,{items});return;}
      const newid=Math.max(Number(md.nextNoteId)||0,...items.map(x=>Number(x.id)||0))+1;
      items.push({id:newid,subject:"영양교육 및 상담",unit:"AI 학습 오답",tags:["AI학습","자료기반"],mistakeType:"개념미숙지",
        ocrText:i.question,answer:i.answer,wrongReason:"내 답: "+str(answer,450)+" / "+str(feedback,450),
        correctConcept:i.explanation||i.answer,source:"AI 학습: "+i.sourceName,createdAt:today,nextReviewAt:today,
        masteryLevel:0,reviewCount:1,correctCount:0,wrongCount:1,favorite:false,collectionIds:[],images:[],studyWrongKey:k});
      tx.set(n,{items});tx.set(m,{...md,nextNoteId:newid+1},{merge:true});
    });return true;
  }catch(e){console.error("Legacy sync error",e.message);return false;}
}
async function saveAttempt(uid,i,answer,verdict,feedback,missing){
  const userDoc=db.doc("users/"+uid),wrong=userDoc.collection("studyWrong").doc(wrongKey(i));
  const time=admin.firestore.FieldValue.serverTimestamp();
  await userDoc.collection("studyAttempts").add({item:i,answer:str(answer,6000),verdict,feedback,missing,createdAt:time});
  let legacySynced=true;
  if(verdict==="correct"){
    if((await wrong.get()).exists)await wrong.update({mastered:true,lastVerdict:verdict,lastAnsweredAt:time});
  }else{
    await wrong.set({item:i,mastered:false,lastVerdict:verdict,lastAnswer:str(answer,6000),
      feedback,missing,wrongCount:admin.firestore.FieldValue.increment(1),lastAnsweredAt:time},{merge:true});
    legacySynced=await legacy(uid,i,answer,feedback);
  }
  return {legacySynced};
}
exports.gradeStudyAnswer=onCall({region:REGION,secrets:[key],timeoutSeconds:120},async(r)=>{
  const uid=user(r),i=await validate(uid,r.data?.item),answer=str(r.data?.answer,6000).trim();
  if(!answer)throw new HttpsError("invalid-argument","답안을 입력하세요.");
  const prompt="영양교사 주관식 답을 채점하라. 아래 원문, 모범답안만 근거로 하고 외부 지식 사용 금지. 동의어·유사표현도 의미가 맞으면 정답. 일부 핵심만 맞으면 partial, 핵심 오개념이면 incorrect. JSON {\"verdict\":\"correct|partial|incorrect\",\"feedback\":\"맞은 부분/틀린 부분 근거\",\"missing\":\"필요한 보충 설명\"}만 출력.\n질문:"+i.question+"\n원문:"+i.evidence+"\n모범답안:"+i.answer+"\n설명:"+i.explanation+"\n학습자 답변:"+answer;
  const x=parse(await ask([{text:prompt}],{max:2000,json:true,temp:0}));
  const verdict=["correct","partial","incorrect"].includes(x.verdict)?x.verdict:"incorrect",feedback=str(x.feedback,1200),missing=str(x.missing,1000);
  return {verdict,feedback,missing,...await saveAttempt(uid,i,answer,verdict,feedback,missing)};
});
exports.recordStudyCard=onCall({region:REGION,timeoutSeconds:120},async(r)=>{
  const uid=user(r),i=await validate(uid,r.data?.item);
  if(typeof r.data?.known!=="boolean")throw new HttpsError("invalid-argument","자가 평가가 없습니다.");
  const verdict=r.data.known?"correct":"incorrect";
  return {verdict,...await saveAttempt(uid,i,"[카드 자가평가]",verdict,r.data.known?"암기 완료":"복습 필요","")};
});
exports.deleteStudySource=onCall({region:REGION,timeoutSeconds:120},async(r)=>{
  const uid=user(r),s=id(r.data?.sourceId),d=ref(uid,s);
  if(!(await d.get()).exists)throw new HttpsError("not-found","파일이 없습니다.");
  const parts=await d.collection("parts").get();
  for(let i=0;i<parts.size;i+=400){const b=db.batch();parts.docs.slice(i,i+400).forEach(x=>b.delete(x.ref));await b.commit();}
  await bucket.file(path(uid,s)).delete({ignoreNotFound:true});await d.delete();return {ok:true};
});
