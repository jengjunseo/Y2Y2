from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

import requests

DEFAULT_RELAY_BASE="https://y2-y2.vercel.app"
POLL_IDLE_SECONDS=10.0
POLL_ACTIVE_SECONDS=5.0
HTTP_TIMEOUT=(5.0,25.0)

class RelayIdentityStore:
    def __init__(self,root:Path):self.path=root/"relay-identity.json";self._lock=threading.RLock();self.data=self._load()
    def _load(self):
        if not self.path.is_file():return{"active":{}}
        try:
            value=json.loads(self.path.read_text("utf-8"));return value if isinstance(value,dict) else{"active":{}}
        except Exception:return{"active":{}}
    def _save(self):
        self.path.parent.mkdir(parents=True,exist_ok=True);temp=self.path.with_suffix(".tmp");temp.write_text(json.dumps(self.data,ensure_ascii=False,indent=2),"utf-8");temp.replace(self.path)
    @staticmethod
    def _protect(secret:str)->str:
        if os.name!="nt":return"plain:"+base64.urlsafe_b64encode(secret.encode()).decode()
        return"dpapi:"+base64.urlsafe_b64encode(_dpapi(secret.encode(),True)).decode()
    @staticmethod
    def _unprotect(value:str)->str:
        if value.startswith("plain:"):return base64.urlsafe_b64decode(value[6:].encode()).decode()
        if not value.startswith("dpapi:"):raise ValueError("Unsupported relay credential encoding")
        return _dpapi(base64.urlsafe_b64decode(value[6:].encode()),False).decode()
    def credentials(self):
        with self._lock:
            device_id=self.data.get("deviceId");protected=self.data.get("secret");relay_base=self.data.get("relayBase")
            if not device_id or not protected or not relay_base:return None
            try:return str(device_id),self._unprotect(str(protected)),str(relay_base)
            except Exception:return None
    def save_credentials(self,device_id,secret,relay_base):
        with self._lock:self.data["deviceId"]=device_id;self.data["secret"]=self._protect(secret);self.data["relayBase"]=relay_base.rstrip("/");self.data.setdefault("active",{});self._save()
    def active(self):
        with self._lock:value=self.data.get("active");return dict(value) if isinstance(value,dict) else{}
    def map_job(self,remote_id,local_id):
        with self._lock:self.data.setdefault("active",{})[remote_id]=local_id;self._save()
    def unmap_job(self,remote_id):
        with self._lock:self.data.setdefault("active",{}).pop(remote_id,None);self._save()

def _dpapi(data:bytes,protect:bool)->bytes:
    class DATA_BLOB(ctypes.Structure):_fields_=[("cbData",ctypes.wintypes.DWORD),("pbData",ctypes.POINTER(ctypes.c_byte))]
    buffer=ctypes.create_string_buffer(data);incoming=DATA_BLOB(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_byte)));outgoing=DATA_BLOB();crypt32=ctypes.windll.crypt32;kernel32=ctypes.windll.kernel32;flags=0x01
    ok=crypt32.CryptProtectData(ctypes.byref(incoming),None,None,None,None,flags,ctypes.byref(outgoing)) if protect else crypt32.CryptUnprotectData(ctypes.byref(incoming),None,None,None,None,flags,ctypes.byref(outgoing))
    if not ok:raise ctypes.WinError()
    try:return ctypes.string_at(outgoing.pbData,outgoing.cbData)
    finally:kernel32.LocalFree(outgoing.pbData)

class RelayAgent:
    def __init__(self,app,root:Path):
        self.app=app;self.identity=RelayIdentityStore(root);self.session=requests.Session();self.session.headers.update({"User-Agent":"Y2Y2-Engine/0.4"});self.session.mount("https://",requests.adapters.HTTPAdapter(pool_connections=2,pool_maxsize=4,max_retries=0));self.stop_event=threading.Event();self.wake_event=threading.Event();self.thread=None;self.last_error=None
    @property
    def registered(self):return self.identity.credentials() is not None
    def start(self):
        if self.thread and self.thread.is_alive():return
        self.thread=threading.Thread(target=self._run,name="y2y2-relay-agent",daemon=True);self.thread.start()
    def stop(self):self.stop_event.set();self.wake_event.set()
    def register(self,ticket:str):
        if not isinstance(ticket,str) or len(ticket)<20:raise ValueError("Invalid relay registration ticket")
        relay_base=os.getenv("Y2Y2_RELAY_BASE_URL",DEFAULT_RELAY_BASE).rstrip("/")
        if not(relay_base==DEFAULT_RELAY_BASE or relay_base.startswith("http://127.0.0.1:")):raise ValueError("Untrusted relay base URL")
        device_id=secrets.token_hex(12);secret=secrets.token_urlsafe(32);response=self.session.post(relay_base+"/api/relay?action=device-register",json={"ticket":ticket,"deviceId":device_id,"secret":secret,"name":os.getenv("COMPUTERNAME")or"Home PC","platform":"windows"},timeout=HTTP_TIMEOUT);data=_json_response(response);self.identity.save_credentials(device_id,secret,relay_base);self.last_error=None;self.wake_event.set();return data
    def _auth(self):
        creds=self.identity.credentials()
        if not creds:return None
        device_id,secret,relay_base=creds;return device_id,secret,relay_base,{"Authorization":f"Device {device_id}:{secret}"}
    def _post(self,action,body):
        auth=self._auth()
        if not auth:raise RuntimeError("Home Engine is not registered")
        _,_,relay_base,headers=auth;return _json_response(self.session.post(relay_base+f"/api/relay?action={action}",json=body,headers=headers,timeout=HTTP_TIMEOUT))
    def _run(self):
        backoff=2.0
        while not self.stop_event.is_set():
            if not self.registered:self.wake_event.wait(30);self.wake_event.clear();continue
            try:self._sync_active();data=self._post("device-poll",{});job=data.get("job");self._accept(job) if job else None;self.last_error=None;backoff=2.0;wait=POLL_ACTIVE_SECONDS if self.identity.active() else POLL_IDLE_SECONDS
            except Exception as error:self.last_error=str(error);wait=min(60.0,backoff);backoff=min(60.0,backoff*2.0)
            self.wake_event.wait(wait);self.wake_event.clear()
    def _accept(self,remote):
        remote_id=str(remote.get("id")or"");kind=remote.get("kind");payload=remote.get("payload")or{}
        if kind=="inspect":
            try:self._post("device-complete-inspect",{"id":remote_id,"result":self.app.processor.inspect(payload.get("url",""))})
            except Exception as error:self._post("device-fail",{"id":remote_id,"error":str(error)[-3000:]})
            return
        if kind!="download":self._post("device-fail",{"id":remote_id,"error":"Unsupported remote job kind"});return
        local=self.app.store.create_job(payload);self.identity.map_job(remote_id,local["id"]);self._post("device-progress",{"id":remote_id,"status":"processing","stage":"queued-local","progress":0});self.wake_event.set()
    def _sync_active(self):
        for remote_id,local_id in self.identity.active().items():
            job=self.app.store.get_job(local_id)
            if not job:self._post("device-fail",{"id":remote_id,"error":"Local job disappeared"});self.identity.unmap_job(remote_id);continue
            status=job.get("status")
            if status=="ready":self._upload(remote_id,job);self.identity.unmap_job(remote_id)
            elif status in{"failed","canceled"}:self._post("device-fail",{"id":remote_id,"error":job.get("error")or status});self.identity.unmap_job(remote_id)
            else:self._post("device-progress",{"id":remote_id,"status":"processing","stage":job.get("stage")or status or"processing","progress":float(job.get("progress")or 0)})
    def _upload(self,remote_id,local_job):
        output=Path(str(local_job.get("outputPath")or""))
        if not output.is_file():raise RuntimeError("Local output file is missing")
        ticket=self._post("device-upload-ticket",{"id":remote_id,"filename":local_job.get("filename")or output.name,"sizeBytes":output.stat().st_size})
        with output.open("rb") as source:response=self.session.put(ticket["uploadUrl"],data=source,headers={"Content-Type":"application/octet-stream"},timeout=(10.0,300.0))
        if not response.ok:raise RuntimeError(f"Relay upload failed ({response.status_code})")
        self._post("device-complete-download",{"id":remote_id,"pathname":ticket["pathname"],"filename":local_job.get("filename")or output.name,"sizeBytes":output.stat().st_size})

def _json_response(response):
    try:data=response.json()
    except Exception:data={}
    if not response.ok:raise RuntimeError(data.get("error")or f"Relay request failed ({response.status_code})")
    return data
