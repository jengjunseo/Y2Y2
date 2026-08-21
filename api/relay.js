import {authenticateDevice,cancelJob,claimJob,clearSessionCookie,createOwnerSession,createRegistrationTicket,createUploadTicket,enqueueJobs,finishDownload,getDownloadUrl,getJob,getPresence,homeDeviceId,isOwner,listJobs,registerDevice,relayConfigured,requireOwner,responseError,retryJob,sessionCookie,toPublicJob,touchPresence,updateDeviceJob} from "./_relay.js";

async function jsonBody(request){try{const body=await request.json();return body&&typeof body==="object"?body:{};}catch{return{};}}
function ok(payload,init={}){const headers=new Headers(init.headers||{});headers.set("Cache-Control","no-store");return Response.json(payload,{...init,headers});}

export async function GET(request){
  try{
    const url=new URL(request.url),action=url.searchParams.get("action")||"status";
    if(action==="configured")return ok({configured:relayConfigured(),authenticated:isOwner(request)});
    if(action==="status"){
      requireOwner(request);const deviceId=await homeDeviceId(),presence=await getPresence(deviceId);
      return ok({configured:true,authenticated:true,homeEngine:{registered:Boolean(deviceId),deviceId:deviceId||null,state:deviceId?presence.state:"unregistered",lastSeen:presence.lastSeen}});
    }
    if(action==="jobs"){
      requireOwner(request);const id=url.searchParams.get("id");if(id){const job=await getJob(id);return job?ok(toPublicJob(job)):ok({error:"Job not found",code:"JOB_NOT_FOUND"},{status:404});}
      return ok({items:await listJobs(Number(url.searchParams.get("limit")||50))});
    }
    if(action==="download"){requireOwner(request);return ok(await getDownloadUrl(url.searchParams.get("id")||""));}
    return ok({error:"Unknown relay action"},{status:404});
  }catch(error){return responseError(error);}
}

export async function POST(request){
  try{
    const url=new URL(request.url),action=url.searchParams.get("action")||"",body=await jsonBody(request);
    if(action==="session")return ok({ok:true},{headers:{"Set-Cookie":sessionCookie(createOwnerSession(body.ownerSecret))}});
    if(action==="logout")return ok({ok:true},{headers:{"Set-Cookie":clearSessionCookie()}});
    if(action==="registration-ticket"){requireOwner(request);return ok({ticket:await createRegistrationTicket(),expiresIn:600});}
    if(action==="jobs-create"){
      requireOwner(request);const deviceId=await homeDeviceId();if(!deviceId)return ok({error:"Home Engine is not registered",code:"HOME_ENGINE_UNREGISTERED"},{status:409});
      const presence=await getPresence(deviceId);if(presence.state!=="online")return ok({error:"집 PC가 꺼져 있습니다.",code:"HOME_ENGINE_OFFLINE"},{status:409});
      const kind=body.kind==="inspect"?"inspect":"download",items=kind==="inspect"?[{url:body.url}]:body.items;
      if(!Array.isArray(items)||items.length<1||items.length>100)return ok({error:"items must contain 1..100 jobs",code:"BAD_BATCH"},{status:400});
      const jobs=await enqueueJobs(deviceId,kind,items);return ok(kind==="inspect"?{job:toPublicJob(jobs[0])}:{items:jobs.map(toPublicJob)},{status:201});
    }
    if(action==="retry"){requireOwner(request);return ok(await retryJob(String(body.id||"")));}
    if(action==="cancel"){requireOwner(request);return ok(await cancelJob(String(body.id||"")));}
    if(action==="device-register")return ok(await registerDevice(body),{status:201});
    if(action.startsWith("device-")){
      const {deviceId}=await authenticateDevice(request);await touchPresence(deviceId);
      if(action==="device-poll")return ok({job:await claimJob(deviceId)});
      if(action==="device-progress")return ok(toPublicJob(await updateDeviceJob(deviceId,String(body.id||""),{status:body.status==="processing"?"processing":undefined,stage:String(body.stage||"processing").slice(0,80),progress:String(Math.max(0,Math.min(100,Number(body.progress||0))))})));
      if(action==="device-complete-inspect")return ok(toPublicJob(await updateDeviceJob(deviceId,String(body.id||""),{status:"done",stage:"inspected",progress:"100",result:JSON.stringify(body.result||{})})));
      if(action==="device-fail")return ok(toPublicJob(await updateDeviceJob(deviceId,String(body.id||""),{status:"failed",stage:"failed",error:String(body.error||"Remote Engine failed").slice(-3000)})));
      if(action==="device-upload-ticket")return ok(await createUploadTicket(deviceId,String(body.id||""),String(body.filename||"")));
      if(action==="device-complete-download")return ok(await finishDownload(deviceId,String(body.id||""),{pathname:body.pathname,filename:body.filename,sizeBytes:Number(body.sizeBytes||0)}));
    }
    return ok({error:"Unknown relay action"},{status:404});
  }catch(error){return responseError(error);}
}
