import{
  ALL_FORMATS,Conversion,Input,Mp3OutputFormat,Mp4OutputFormat,Output,
  StreamTarget,UrlSource,canEncodeAudio
}from"mediabunny";
import{registerMp3Encoder}from"@mediabunny/mp3-encoder";
import{safeFileName}from"./v1-core.js";

const RANGE_BYTES=3_250_000;
let mp3Ready=false;

export function streamUrl(videoId,itag){return`/api/web?action=stream&videoId=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(itag)}`;}

async function opfsFile(filename){
  if(!navigator.storage?.getDirectory)throw new Error("이 브라우저는 대용량 Web-Native 저장소(OPFS)를 지원하지 않습니다.");
  const root=await navigator.storage.getDirectory();
  const dir=await root.getDirectoryHandle("y2y2-v1",{create:true});
  const name=`${Date.now()}-${crypto.randomUUID()}-${safeFileName(filename)}`;
  const handle=await dir.getFileHandle(name,{create:true});
  return{root,dir,name,handle,writable:await handle.createWritable()};
}

export async function triggerBrowserDownload(handle,filename){
  const file=await handle.getFile(),href=URL.createObjectURL(file),a=document.createElement("a");
  a.href=href;a.download=safeFileName(filename);a.style.display="none";document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(href),60_000);
  return{sizeBytes:file.size};
}

async function directToOpfs({videoId,itag,sizeBytes,filename,onProgress,signal}){
  if(!Number.isFinite(Number(sizeBytes))||Number(sizeBytes)<=0)throw new Error("파일 크기를 확인할 수 없습니다.");
  const tmp=await opfsFile(filename),total=Number(sizeBytes);
  try{
    for(let start=0;start<total;start+=RANGE_BYTES){
      if(signal?.aborted)throw new DOMException("Canceled","AbortError");
      const end=Math.min(total-1,start+RANGE_BYTES-1);
      const response=await fetch(streamUrl(videoId,itag),{headers:{Range:`bytes=${start}-${end}`},signal});
      if(response.status!==206)throw new Error(`Gateway range 실패 (${response.status})`);
      const data=new Uint8Array(await response.arrayBuffer());
      await tmp.writable.write({type:"write",position:start,data});
      onProgress?.(Math.min(99,((end+1)/total)*100),"downloading");
    }
    await tmp.writable.close();onProgress?.(100,"ready");return tmp.handle;
  }catch(error){try{await tmp.writable.abort(error);}catch{}throw error;}
}

function inputFrom(videoId,itag){return new Input({formats:ALL_FORMATS,source:new UrlSource(streamUrl(videoId,itag),{maxCacheSize:8*1024*1024})});}

async function ensureMp3(){
  if(mp3Ready)return;
  if(!(await canEncodeAudio("mp3")))registerMp3Encoder();
  mp3Ready=true;
}

async function mp3ToOpfs({videoId,audioItag,quality,filename,onProgress,signal}){
  await ensureMp3();
  const tmp=await opfsFile(filename);
  const input=inputFrom(videoId,audioItag);
  const output=new Output({format:new Mp3OutputFormat(),target:new StreamTarget(tmp.writable,{chunked:true,chunkSize:1024*1024})});
  const conversion=await Conversion.init({
    input,output,video:{discard:true},
    audio:{codec:"mp3",bitrate:Number(quality)*1000,forceTranscode:true}
  });
  if(!conversion.isValid)throw new Error("이 브라우저에서는 MP3 변환을 수행할 수 없습니다.");
  conversion.onProgress=p=>onProgress?.(Math.min(99,p*100),"encoding");
  if(signal?.aborted)throw new DOMException("Canceled","AbortError");
  await conversion.execute();
  onProgress?.(100,"ready");return tmp.handle;
}

async function muxToOpfs({videoId,videoItag,audioItag,filename,onProgress,signal}){
  const tmp=await opfsFile(filename);
  const output=new Output({format:new Mp4OutputFormat({fastStart:"fragmented"}),target:new StreamTarget(tmp.writable,{chunked:true,chunkSize:1024*1024})});
  const video=await Conversion.init({input:inputFrom(videoId,videoItag),output,audio:{discard:true},composable:true});
  const audio=await Conversion.init({input:inputFrom(videoId,audioItag),output,video:{discard:true},composable:true});
  if(!video.isValid||!audio.isValid)throw new Error("이 브라우저에서는 선택한 MP4 스트림을 합칠 수 없습니다.");
  let vp=0,ap=0;video.onProgress=p=>{vp=p;onProgress?.(Math.min(99,((vp+ap)/2)*100),"muxing");};audio.onProgress=p=>{ap=p;onProgress?.(Math.min(99,((vp+ap)/2)*100),"muxing");};
  await output.start();
  for(let until=6;;until+=6){
    if(signal?.aborted){await output.cancel();throw new DOMException("Canceled","AbortError");}
    await Promise.all([video.execute({until}),audio.execute({until})]);
    if(video.state==="done"&&audio.state==="done")break;
  }
  await output.finalize();onProgress?.(100,"ready");return tmp.handle;
}

export async function processWebItem(item,{prefix="",onProgress,signal}={}){
  const title=safeFileName(item.title||item.videoId,item.videoId||"media");
  if(item.mediaType==="mp3"){
    if(!item.audioPlan)throw new Error("사용 가능한 오디오 스트림이 없습니다.");
    const filename=`${prefix}${title}.mp3`;
    const handle=await mp3ToOpfs({videoId:item.videoId,audioItag:item.audioPlan.itag,quality:item.quality,filename,onProgress,signal});
    const result=await triggerBrowserDownload(handle,filename);return{...result,filename,handle};
  }
  const plan=(item.mp4Plans||[]).find(p=>Number(p.quality)===Number(item.quality));
  if(!plan)throw new Error(`${item.quality}p 스트림을 사용할 수 없습니다.`);
  const filename=`${prefix}${title}.mp4`;
  let handle;
  if(plan.mode==="direct")handle=await directToOpfs({videoId:item.videoId,itag:plan.itag,sizeBytes:plan.sizeBytes,filename,onProgress,signal});
  else handle=await muxToOpfs({videoId:item.videoId,videoItag:plan.video.itag,audioItag:plan.audio.itag,filename,onProgress,signal});
  const result=await triggerBrowserDownload(handle,filename);return{...result,filename,handle};
}
