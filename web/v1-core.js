export const MAX_RANGE_BYTES=3_500_000;
export const MP3_QUALITIES=[128,192,256,320];
export const MP4_TARGETS=[360,720,1080,1440,2160];

export function extractVideoId(value){
  if(typeof value!=="string")return null;
  const text=value.trim();
  if(/^[A-Za-z0-9_-]{11}$/.test(text))return text;
  let url;
  try{url=new URL(text);}catch{return null;}
  const host=url.hostname.toLowerCase().replace(/^www\./,"");
  if(host==="youtu.be"){
    const id=url.pathname.split("/").filter(Boolean)[0]||"";
    return /^[A-Za-z0-9_-]{11}$/.test(id)?id:null;
  }
  if(!["youtube.com","m.youtube.com","music.youtube.com"].includes(host))return null;
  let id=url.searchParams.get("v")||"";
  if(!id){
    const parts=url.pathname.split("/").filter(Boolean);
    if(["shorts","embed","live"].includes(parts[0]))id=parts[1]||"";
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id)?id:null;
}

export function parseByteRange(header,total,maxBytes=MAX_RANGE_BYTES){
  const size=Number(total);
  if(!Number.isFinite(size)||size<=0)throw new RangeError("Unknown stream size");
  let start=0,end=Math.min(size-1,maxBytes-1);
  if(header){
    const match=/^bytes=(\d+)-(\d*)$/i.exec(String(header).trim());
    if(!match)throw new RangeError("Unsupported Range header");
    start=Number(match[1]);
    if(!Number.isSafeInteger(start)||start<0||start>=size)throw new RangeError("Range start out of bounds");
    const asked=match[2]?Number(match[2]):size-1;
    if(!Number.isSafeInteger(asked)||asked<start)throw new RangeError("Range end out of bounds");
    end=Math.min(size-1,asked,start+maxBytes-1);
  }
  return{start,end,length:end-start+1,total:size};
}

export function safeFileName(value,fallback="media"){
  const base=String(value||fallback)
    .replace(/[\u0000-\u001f\u007f]/g," ")
    .replace(/[<>:"/\\|?*]/g," ")
    .replace(/\s+/g," ")
    .trim()
    .replace(/[. ]+$/g,"")
    .slice(0,140);
  const reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return !base||reserved.test(base)?fallback:base;
}

function usable(f){
  return f&&Number.isInteger(Number(f.itag))&&!f.is_type_otf&&!(Array.isArray(f.drm_families)&&f.drm_families.length);
}
function mime(f){return String(f.mime_type||"").toLowerCase();}
function bitrate(f){return Number(f.bitrate||f.average_bitrate||0);}
function qualityScore(f){
  let score=bitrate(f);
  if(mime(f).includes("mp4"))score+=2_000_000_000;
  if(f.is_original!==false)score+=200_000_000;
  if(!f.is_drc)score+=100_000_000;
  if(!f.is_secondary)score+=50_000_000;
  return score;
}
function best(list){return[...list].sort((a,b)=>qualityScore(b)-qualityScore(a))[0]||null;}

export function buildMediaPlans(formats){
  const list=(Array.isArray(formats)?formats:[]).filter(usable).map(f=>({
    ...f,itag:Number(f.itag),height:Number(f.height||0),content_length:Number(f.content_length||0),
    bitrate:Number(f.bitrate||0),has_audio:Boolean(f.has_audio),has_video:Boolean(f.has_video)
  }));
  const audio=best(list.filter(f=>f.has_audio&&!f.has_video));
  const mp4Plans=[];
  for(const quality of MP4_TARGETS){
    const progressive=best(list.filter(f=>f.has_video&&f.has_audio&&f.height===quality&&mime(f).startsWith("video/mp4")));
    if(progressive){
      mp4Plans.push({quality,mode:"direct",itag:progressive.itag,mimeType:progressive.mime_type||"video/mp4",sizeBytes:progressive.content_length||null});
      continue;
    }
    const video=best(list.filter(f=>f.has_video&&!f.has_audio&&f.height===quality));
    if(video&&audio){
      mp4Plans.push({
        quality,mode:"mux",
        video:{itag:video.itag,mimeType:video.mime_type||"video/mp4",sizeBytes:video.content_length||null},
        audio:{itag:audio.itag,mimeType:audio.mime_type||"audio/mp4",sizeBytes:audio.content_length||null}
      });
    }
  }
  return{
    mp3Qualities:[...MP3_QUALITIES],
    audioPlan:audio?{itag:audio.itag,mimeType:audio.mime_type||"audio/mp4",sizeBytes:audio.content_length||null}:null,
    mp4Plans
  };
}

export function isSameOriginBrowserRequest(request){
  const own=new URL(request.url).origin;
  const origin=request.headers.get("origin");
  if(origin&&origin!==own)return false;
  const site=request.headers.get("sec-fetch-site");
  return !site||site==="same-origin"||site==="none";
}
