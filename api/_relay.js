import { issueSignedToken, presignUrl, del } from "@vercel/blob";
import { start } from "workflow/api";
import crypto from "node:crypto";
import {
  CLAIM_LUA, DAILY_ITEM_LIMIT, ENQUEUE_LUA, MINUTE_CREATE_LIMIT,
  PRESENCE_TTL_SECONDS, RELAY_TTL_MS, RATE_LIMIT_LUA,
  expiresAtFrom, homePresence, publicStatus, randomId, randomToken,
  safeBlobName, sha256, signSession, verifySession,
} from "../relay/core.js";

export const COOKIE = "y2y2_relay_session";

export function relayConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && process.env.Y2Y2_RELAY_OWNER_SECRET);
}
export function requireRelayConfigured() {
  if (!relayConfigured()) throw Object.assign(new Error("Relay is not configured. Local Engine remains available."), { code: "RELAY_NOT_CONFIGURED", status: 503 });
}
export async function redis(command) {
  requireRelayConfigured();
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command), cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw Object.assign(new Error(payload.error || `Redis request failed (${response.status})`), { code: "RELAY_STORE_ERROR", status: 503 });
  return payload.result;
}
export function parseCookies(request) {
  const raw = request.headers.get("cookie") || "";
  return Object.fromEntries(raw.split(";").map(v => v.trim()).filter(Boolean).map(pair => { const i=pair.indexOf("="); return i<0?[pair,""]:[pair.slice(0,i),decodeURIComponent(pair.slice(i+1))]; }));
}
export function sessionCookie(token) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30*24*60*60}`; }
export function clearSessionCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
export function isOwner(request) { return relayConfigured() && verifySession(parseCookies(request)[COOKIE], process.env.Y2Y2_RELAY_OWNER_SECRET); }
export function requireOwner(request) { requireRelayConfigured(); if (!isOwner(request)) throw Object.assign(new Error("Relay owner session required"), { code: "RELAY_AUTH_REQUIRED", status: 401 }); }
export function createOwnerSession(secret) {
  requireRelayConfigured();
  const expected=Buffer.from(process.env.Y2Y2_RELAY_OWNER_SECRET), actual=Buffer.from(String(secret||""));
  if (expected.length!==actual.length || !crypto.timingSafeEqual(expected,actual)) throw Object.assign(new Error("Owner secret is incorrect"), { code:"RELAY_AUTH_FAILED", status:403 });
  return signSession(process.env.Y2Y2_RELAY_OWNER_SECRET);
}
export async function homeDeviceId(){ return await redis(["GET","y2y2:home-device"]); }
export async function getPresence(deviceId){ if(!deviceId)return{state:"offline",lastSeen:null}; const raw=await redis(["GET",`y2y2:presence:${deviceId}`]); return homePresence(raw?Number(raw):0); }
export async function createRegistrationTicket(){ const ticket=randomToken(24); await redis(["SET",`y2y2:registration:${ticket}`,"1","EX","600"]); return ticket; }
export async function registerDevice({ticket,deviceId,secret,name,platform}) {
  if(!/^[a-f0-9]{24}$/.test(deviceId||"")||String(secret||"").length<32) throw Object.assign(new Error("Invalid device identity"),{code:"BAD_DEVICE_IDENTITY",status:400});
  const consumed=await redis(["EVAL","local v=redis.call('GET',KEYS[1]); if not v then return 0 end; redis.call('DEL',KEYS[1]); return 1","1",`y2y2:registration:${ticket||""}`]);
  if(Number(consumed)!==1) throw Object.assign(new Error("Registration ticket expired or already used"),{code:"BAD_REGISTRATION_TICKET",status:403});
  const now=Date.now();
  await redis(["HSET",`y2y2:device:${deviceId}`,"id",deviceId,"secretHash",sha256(secret),"name",String(name||"Home Engine").slice(0,120),"platform",String(platform||"windows").slice(0,32),"registeredAt",String(now)]);
  await redis(["SET","y2y2:home-device",deviceId]); return {ok:true,deviceId};
}
export async function authenticateDevice(request){
  requireRelayConfigured(); const auth=request.headers.get("authorization")||"";
  if(!auth.startsWith("Device ")) throw Object.assign(new Error("Device authorization required"),{code:"DEVICE_AUTH_REQUIRED",status:401});
  const [deviceId,secret]=auth.slice(7).split(":",2);
  if(!/^[a-f0-9]{24}$/.test(deviceId||"")||!secret) throw Object.assign(new Error("Invalid device authorization"),{code:"DEVICE_AUTH_FAILED",status:401});
  const stored=await redis(["HGET",`y2y2:device:${deviceId}`,"secretHash"]), expected=String(stored||""), actual=sha256(secret);
  if(!expected||expected.length!==actual.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) throw Object.assign(new Error("Invalid device authorization"),{code:"DEVICE_AUTH_FAILED",status:401});
  return {deviceId,secret};
}
export async function touchPresence(deviceId){ const now=Date.now(); await redis(["SET",`y2y2:presence:${deviceId}`,String(now),"EX",String(PRESENCE_TTL_SECONDS)]); return now; }
function minuteKey(now=new Date()){return `y2y2:rate:minute:${now.toISOString().slice(0,16)}`;}
function dayKey(now=new Date()){return `y2y2:rate:day:${now.toISOString().slice(0,10)}`;}
export async function rateLimitCreate(itemCount){
  const result=await redis(["EVAL",RATE_LIMIT_LUA,"2",minuteKey(),dayKey(),"1",String(itemCount),String(Number(process.env.Y2Y2_RELAY_CREATE_PER_MINUTE||MINUTE_CREATE_LIMIT)),String(Number(process.env.Y2Y2_RELAY_ITEMS_PER_DAY||DAILY_ITEM_LIMIT))]);
  if(Number(result?.[0]||0)!==1) throw Object.assign(new Error(Number(result?.[3])===2?"Daily relay job limit reached":"Relay job rate limit reached"),{code:"RELAY_RATE_LIMITED",status:429});
}
export function validateRemoteItem(item){
  const url=String(item?.url||"").trim(), parsed=new URL(url), hosts=new Set(["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","youtu.be"]);
  if(!["http:","https:"].includes(parsed.protocol)||!hosts.has(parsed.hostname.toLowerCase())) throw Object.assign(new Error("Only standard YouTube URLs are supported"),{status:400,code:"BAD_SOURCE_URL"});
  const mediaType=String(item?.mediaType||"mp3"),quality=Number(item?.quality||0);
  if(mediaType==="mp3"&&![128,192,256,320].includes(quality))throw Object.assign(new Error("Unsupported MP3 bitrate"),{status:400});
  if(mediaType==="mp4"&&![360,720,1080,1440,2160].includes(quality))throw Object.assign(new Error("Unsupported MP4 quality"),{status:400});
  return {url,videoId:String(item?.videoId||"").slice(0,64),title:String(item?.title||"media").slice(0,200),mediaType,quality,filenamePrefix:String(item?.filenamePrefix||"").slice(0,16)};
}
export async function enqueueJobs(deviceId,kind,items){
  await rateLimitCreate(items.length); const now=Date.now(),created=[];
  for(const raw of items){ const payload=kind==="inspect"?{url:validateRemoteItem({...raw,mediaType:"mp3",quality:256}).url}:validateRemoteItem(raw); const id=randomId(12);
    await redis(["EVAL",ENQUEUE_LUA,"3",`y2y2:job:${id}`,`y2y2:queue:${deviceId}`,"y2y2:owner-jobs",id,deviceId,kind,JSON.stringify(payload),String(now)]); created.push(await getJob(id)); }
  return created;
}
export async function getJob(id){ if(!/^[a-f0-9]{24}$/.test(id||""))return null; const values=await redis(["HGETALL",`y2y2:job:${id}`]); if(!values||!values.length)return null; const out={}; for(let i=0;i<values.length;i+=2)out[values[i]]=values[i+1]; return out; }
export function safeJson(raw,fallback){try{return JSON.parse(raw);}catch{return fallback;}}
export function toPublicJob(job){
  if(!job)return null; const payload=safeJson(job.payload,{}),result=safeJson(job.result,null);
  return {id:job.id,kind:job.kind,url:payload.url,videoId:payload.videoId||result?.videoId||"",title:payload.title||result?.title||"media",mediaType:payload.mediaType||"mp3",quality:Number(payload.quality||256),filenamePrefix:payload.filenamePrefix||"",status:publicStatus(job.status),stage:job.stage||job.status,progress:Number(job.progress||0),error:job.error||null,filename:job.filename||null,sizeBytes:job.sizeBytes?Number(job.sizeBytes):null,outputPath:null,createdAt:Number(job.createdAt||0),updatedAt:Number(job.updatedAt||0),expiresAt:job.expiresAt?Number(job.expiresAt):null,result,downloadAvailable:job.kind==="download"&&job.status==="done"&&Number(job.expiresAt||0)>Date.now()};
}
export async function listJobs(limit=50){const ids=await redis(["ZREVRANGE","y2y2:owner-jobs","0",String(Math.max(0,Math.min(99,limit-1)))]),out=[]; for(const id of ids||[]){const job=await getJob(id);if(job)out.push(toPublicJob(job));}return out;}
export async function claimJob(deviceId){ const id=await redis(["EVAL",CLAIM_LUA,"2",`y2y2:queue:${deviceId}`,`y2y2:leases:${deviceId}`,String(Date.now()),"30000",deviceId,"y2y2:job:"]); if(!id)return null; const job=await getJob(id); return job?{id,kind:job.kind,payload:safeJson(job.payload,{})}:null; }
export async function updateDeviceJob(deviceId,id,fields){
  const job=await getJob(id); if(!job||job.deviceId!==deviceId)throw Object.assign(new Error("Job not found"),{status:404}); const allowed={};
  for(const key of ["status","stage","progress","error","result","blobPath","filename","sizeBytes","uploadedAt","expiresAt"])if(fields[key]!==undefined&&fields[key]!==null)allowed[key]=String(fields[key]); allowed.updatedAt=String(Date.now());
  const command=["HSET",`y2y2:job:${id}`]; for(const [k,v] of Object.entries(allowed))command.push(k,v); await redis(command);
  if(["done","failed","canceled","expired"].includes(String(fields.status||"")))await redis(["ZREM",`y2y2:leases:${deviceId}`,id]); else await redis(["ZADD",`y2y2:leases:${deviceId}`,String(Date.now()+30000),id]); return getJob(id);
}
export async function createUploadTicket(deviceId,id,filename){
  const job=await getJob(id); if(!job||job.deviceId!==deviceId||job.kind!=="download"||!["claimed","processing"].includes(job.status))throw Object.assign(new Error("Job is not uploadable"),{status:409,code:"JOB_NOT_UPLOADABLE"});
  const pathname=`relay/${id}/${safeBlobName(filename||`${id}.bin`)}`; const token=await issueSignedToken({operations:["put"]}); const {presignedUrl}=await presignUrl(token,{pathname,operation:"put",validUntil:Date.now()+15*60*1000}); return {pathname,uploadUrl:presignedUrl};
}
export async function finishDownload(deviceId,id,{pathname,filename,sizeBytes}){
  const job=await getJob(id); if(!job||job.deviceId!==deviceId||job.kind!=="download"||!["claimed","processing"].includes(job.status))throw Object.assign(new Error("Job cannot be completed"),{status:409});
  if(!String(pathname||"").startsWith(`relay/${id}/`))throw Object.assign(new Error("Invalid relay blob path"),{status:400});
  const uploadedAt=Date.now(),expiresAt=expiresAtFrom(uploadedAt,Number(process.env.Y2Y2_RELAY_TTL_MS||RELAY_TTL_MS));
  await updateDeviceJob(deviceId,id,{status:"done",stage:"relay-ready",progress:"100",blobPath:pathname,filename:safeBlobName(filename),sizeBytes:Number(sizeBytes||0),uploadedAt,expiresAt});
  try { const {expireRelayArtifact}=await import("./_relay-workflow.js"); await start(expireRelayArtifact,[id,pathname,expiresAt]); }
  catch(error){ await del(pathname).catch(()=>{}); await updateDeviceJob(deviceId,id,{status:"failed",stage:"cleanup-scheduling-failed",error:String(error?.message||error)}); throw Object.assign(new Error("Unable to guarantee relay TTL cleanup"),{status:503,code:"TTL_SCHEDULING_FAILED"}); }
  return toPublicJob(await getJob(id));
}
export async function getDownloadUrl(id){
  const job=await getJob(id); if(!job||job.kind!=="download")throw Object.assign(new Error("Job not found"),{status:404}); if(job.status!=="done"||!job.blobPath)throw Object.assign(new Error("Result is not ready"),{status:409});
  const expiresAt=Number(job.expiresAt||0); if(!expiresAt||expiresAt<=Date.now())throw Object.assign(new Error("Relay result expired"),{status:410,code:"RESULT_EXPIRED"});
  const token=await issueSignedToken({operations:["get"]}); const {presignedUrl}=await presignUrl(token,{pathname:job.blobPath,operation:"get",validUntil:Math.min(Date.now()+10*60*1000,expiresAt)}); return {url:presignedUrl,filename:job.filename||"download",expiresAt};
}
export async function retryJob(id){const job=await getJob(id);if(!job||!["failed","canceled"].includes(job.status))throw Object.assign(new Error("Job is not retryable"),{status:409});await redis(["HSET",`y2y2:job:${id}`,"status","queued","stage","queued","progress","0","error","","updatedAt",String(Date.now())]);await redis(["RPUSH",`y2y2:queue:${job.deviceId}`,id]);return toPublicJob(await getJob(id));}
export async function cancelJob(id){const job=await getJob(id);if(!job)throw Object.assign(new Error("Job not found"),{status:404});if(!["done","expired"].includes(job.status)){await redis(["HSET",`y2y2:job:${id}`,"status","canceled","stage","canceled","updatedAt",String(Date.now())]);await redis(["ZREM",`y2y2:leases:${job.deviceId}`,id]);}return toPublicJob(await getJob(id));}
export function responseError(error){return Response.json({error:error?.message||String(error),code:error?.code||"RELAY_ERROR"},{status:Number(error?.status||500),headers:{"Cache-Control":"no-store"}});}
