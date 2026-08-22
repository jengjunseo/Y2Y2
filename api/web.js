import{Innertube,Platform}from"youtubei.js";
import{buildMediaPlans,extractVideoId,isSameOriginBrowserRequest,MAX_RANGE_BYTES,parseByteRange,safeFileName}from"../web/v1-core.js";

Platform.shim.eval=async data=>new Function(data.output)();
let tubePromise;
const getTube=()=>tubePromise||(tubePromise=Innertube.create({generate_session_locally:true,enable_session_cache:true,fast_fail:false}));

function json(payload,init={}){
  const headers=new Headers(init.headers||{});
  headers.set("Cache-Control","no-store");
  headers.set("Cross-Origin-Resource-Policy","same-origin");
  return Response.json(payload,{...init,headers});
}
function fail(message,code="WEB_GATEWAY_ERROR",status=500,detail){
  return json({error:message,code,detail:detail?String(detail).slice(-1200):undefined},{status});
}
function formatRecord(f){
  return{
    itag:Number(f.itag),url:typeof f.url==="string"?f.url:null,width:Number(f.width||0),height:Number(f.height||0),
    bitrate:Number(f.bitrate||f.average_bitrate||0),content_length:Number(f.content_length||0),
    mime_type:String(f.mime_type||""),quality_label:f.quality_label||null,
    has_audio:Boolean(f.has_audio),has_video:Boolean(f.has_video),is_type_otf:Boolean(f.is_type_otf),
    drm_families:Array.isArray(f.drm_families)?f.drm_families:[],is_original:f.is_original,
    is_drc:Boolean(f.is_drc),is_secondary:Boolean(f.is_secondary)
  };
}
function upstreamError(error){
  const text=String(error?.message||error||"");
  if(/sign in to confirm|not a bot|bot/i.test(text))return fail("YouTube가 현재 Web Gateway 요청을 허용하지 않았습니다.","UPSTREAM_BOT_CHECK",502,text);
  if(/private|members|premium|purchase|age.?restricted|login required/i.test(text))return fail("이 콘텐츠는 Web Gateway에서 접근할 수 없습니다.","CONTENT_UNAVAILABLE",403,text);
  return fail("Web Gateway가 YouTube 정보를 가져오지 못했습니다.","UPSTREAM_ERROR",502,text);
}
async function infoFor(videoId){
  const tube=await getTube();
  return tube.getInfo(videoId);
}
async function exactFormat(info,itag){
  const format=info.chooseFormat({itag:Number(itag)});
  if(!format||Number(format.itag)!==Number(itag))throw new Error("Requested format unavailable");
  if(format.is_type_otf)throw new Error("OTF formats are not supported by the Web Gateway");
  if(Array.isArray(format.drm_families)&&format.drm_families.length)throw new Error("DRM formats are not supported");
  return format;
}

export async function HEAD(request){return handleStream(request,true);}
export async function GET(request){
  const url=new URL(request.url),action=url.searchParams.get("action")||"health";
  if(action==="health")return json({ok:true,service:"y2y2-web-native",version:"1.0.0-beta.1",maxRangeBytes:MAX_RANGE_BYTES});
  if(action==="stream")return handleStream(request,false);
  return fail("Unknown Web Gateway action","NOT_FOUND",404);
}
export async function POST(request){
  if(!isSameOriginBrowserRequest(request))return fail("Cross-site requests are not allowed.","ORIGIN_REJECTED",403);
  const url=new URL(request.url),action=url.searchParams.get("action")||"";
  if(action!=="inspect")return fail("Unknown Web Gateway action","NOT_FOUND",404);
  let body={};
  try{body=await request.json();}catch{}
  const videoId=extractVideoId(body.url||body.videoId||"");
  if(!videoId)return fail("올바른 YouTube 링크가 아닙니다.","BAD_URL",400);
  try{
    const info=await infoFor(videoId);
    const status=String(info.playability_status?.status||"");
    if(status&&status!=="OK")return fail("이 영상은 Web Gateway에서 재생 가능한 상태가 아닙니다.","CONTENT_UNAVAILABLE",403,info.playability_status?.reason);
    const streaming=info.streaming_data;
    const formats=[...(streaming?.formats||[]),...(streaming?.adaptive_formats||[])].map(formatRecord);
    const plans=buildMediaPlans(formats);
    if(!plans.audioPlan&&!plans.mp4Plans.length)return fail("사용 가능한 다운로드 스트림을 찾지 못했습니다.","NO_FORMATS",422);
    const basic=info.basic_info||{};
    const thumbs=Array.isArray(basic.thumbnail)?basic.thumbnail:[];
    const thumb=thumbs.sort((a,b)=>(b.width||0)-(a.width||0))[0]?.url||null;
    return json({
      videoId,
      title:safeFileName(basic.title||videoId,videoId),
      duration:Number(basic.duration||0),
      channel:basic.channel?.name||basic.author||null,
      thumbnail:thumb,
      ...plans
    });
  }catch(error){return upstreamError(error);}
}

async function handleStream(request,headOnly){
  if(!isSameOriginBrowserRequest(request))return fail("Cross-site requests are not allowed.","ORIGIN_REJECTED",403);
  const url=new URL(request.url),videoId=extractVideoId(url.searchParams.get("videoId")||"");
  const itag=Number(url.searchParams.get("itag"));
  if(!videoId||!Number.isInteger(itag)||itag<=0)return fail("Invalid stream identity.","BAD_STREAM",400);
  try{
    const info=await infoFor(videoId),format=await exactFormat(info,itag);
    const total=Number(format.content_length||0);
    if(!Number.isFinite(total)||total<=0)return fail("Stream size is unavailable.","UNKNOWN_STREAM_SIZE",422);
    let range;
    try{range=parseByteRange(request.headers.get("range"),total);}catch(error){return fail(error.message,"BAD_RANGE",416);}
    const headers=new Headers({
      "Accept-Ranges":"bytes",
      "Content-Type":String(format.mime_type||"application/octet-stream").split(";")[0],
      "Content-Length":String(range.length),
      "Content-Range":`bytes ${range.start}-${range.end}/${range.total}`,
      "Cache-Control":"private, no-store",
      "Cross-Origin-Resource-Policy":"same-origin",
      "X-Y2Y2-Chunk-Limit":String(MAX_RANGE_BYTES)
    });
    if(headOnly)return new Response(null,{status:206,headers});
    const body=await info.download({itag,range:{start:range.start,end:range.end}});
    return new Response(body,{status:206,headers});
  }catch(error){return upstreamError(error);}
}
