package dev.y2y2.engine;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.*;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class LocalHttpServer {
    static final int PORT=49272;
    private static final int MAX_BODY=256*1024;
    private final EngineService service;
    private final EngineStore store;
    private final MediaWorker worker;
    private final ExecutorService clients=Executors.newCachedThreadPool();
    private volatile boolean running;
    private ServerSocket server;

    LocalHttpServer(EngineService service, EngineStore store, MediaWorker worker){this.service=service;this.store=store;this.worker=worker;}

    void start() throws Exception {
        server=new ServerSocket(PORT,50, InetAddress.getByName("127.0.0.1")); running=true;
        Thread t=new Thread(()->{ while(running){ try{ Socket s=server.accept(); clients.execute(()->handle(s)); }catch(Exception e){ if(running) service.setError(e.getMessage()); } } },"y2y2-http");
        t.start();
    }
    void stop(){running=false;try{if(server!=null)server.close();}catch(Exception ignored){}clients.shutdownNow();}

    private void handle(Socket socket){
        try(socket){ socket.setSoTimeout(15000); InputStream in=socket.getInputStream(); OutputStream out=socket.getOutputStream();
            Request req=Request.read(in); if(req==null)return;
            try { route(req,out); }
            catch (IllegalArgumentException | JSONException e) { json(out,400,req,null,new JSONObject().put("error",String.valueOf(e.getMessage()))); }
            catch (Exception e) { json(out,500,req,null,new JSONObject().put("error",String.valueOf(e.getMessage()))); }
        }catch(Exception ignored){}
    }

    private void route(Request r,OutputStream out) throws Exception {
        if("OPTIONS".equals(r.method)){ if(!allowedOrigin(r.origin())){json(out,403,r,null,new JSONObject().put("error","Origin not allowed"));return;} empty(out,204,r);return; }
        if("GET".equals(r.method)&&"/v1/health".equals(r.path)){ if(!allowedOrigin(r.origin())){json(out,403,r,null,new JSONObject().put("error","Origin not allowed"));return;} JSONObject h=new JSONObject();h.put("ok",true);h.put("engineVersion","0.3.0");h.put("protocolVersion",1);h.put("platform","android");h.put("engineName",android.os.Build.MODEL);h.put("activeJobs",service.activeJobs());h.put("outputDirectory","Download/Y2Y2");json(out,200,r,null,h);return; }
        if("POST".equals(r.method)&&"/v1/pair".equals(r.path)){ if(!allowedOrigin(r.origin())){json(out,403,r,null,new JSONObject().put("error","Origin not allowed"));return;} JSONObject b=r.json(); if(!constantEquals(store.pairCode(),b.optString("code"))){json(out,403,r,null,new JSONObject().put("error","Pairing code is incorrect"));return;} String token=store.token();store.rotatePairCode();service.notifyPairCodeChanged();json(out,200,r,null,new JSONObject().put("token",token).put("protocolVersion",1));return; }
        if(!authorized(r)){json(out,401,r,"PAIRING_REQUIRED",new JSONObject().put("error","Engine pairing required").put("code","PAIRING_REQUIRED"));return;}
        if("GET".equals(r.method)&&"/v1/auth-check".equals(r.path)){json(out,200,r,null,new JSONObject().put("ok",true));return;}
        if("POST".equals(r.method)&&"/v1/inspect".equals(r.path)){json(out,200,r,null,worker.inspect(r.json().optString("url")));return;}
        if("GET".equals(r.method)&&"/v1/jobs".equals(r.path)){JSONArray a=new JSONArray();for(JSONObject j:store.list())a.put(j);json(out,200,r,null,new JSONObject().put("items",a));return;}
        if("POST".equals(r.method)&&"/v1/jobs".equals(r.path)){JSONObject j=store.create(r.json());service.wakeDispatcher();json(out,201,r,null,j);return;}
        if("POST".equals(r.method)&&"/v1/batch".equals(r.path)){JSONArray items=r.json().optJSONArray("items");if(items==null||items.length()<1||items.length()>100)throw new IllegalArgumentException("items must contain 1..100 jobs");JSONArray jobs=new JSONArray();for(int i=0;i<items.length();i++)jobs.put(store.create(items.getJSONObject(i)));service.wakeDispatcher();json(out,201,r,null,new JSONObject().put("items",jobs));return;}
        Matcher getJob=Pattern.compile("^/v1/jobs/([a-f0-9]{24})$").matcher(r.path);
        if("GET".equals(r.method)&&getJob.matches()){JSONObject j=store.get(getJob.group(1));if(j==null)json(out,404,r,null,new JSONObject().put("error","Job not found"));else json(out,200,r,null,j);return;}
        Matcher action=Pattern.compile("^/v1/jobs/([a-f0-9]{24})/(retry|reveal)$").matcher(r.path);
        if("POST".equals(r.method)&&action.matches()){String id=action.group(1);if("retry".equals(action.group(2))){JSONObject j=store.retry(id);if(j==null)json(out,404,r,null,new JSONObject().put("error","Job not found"));else{service.wakeDispatcher();json(out,200,r,null,j);}}else{JSONObject j=store.get(id);if(j==null)json(out,404,r,null,new JSONObject().put("error","Job not found"));else{worker.reveal(j);json(out,200,r,null,new JSONObject().put("ok",true));}}return;}
        if("DELETE".equals(r.method)&&getJob.reset().matches()){String id=getJob.group(1);worker.cancel(id);JSONObject j=store.get(id);if(j==null)json(out,404,r,null,new JSONObject().put("error","Job not found"));else json(out,200,r,null,j);return;}
        json(out,404,r,null,new JSONObject().put("error","Not found"));
    }

    private boolean authorized(Request r){return allowedOrigin(r.origin())&&constantEquals("Bearer "+store.token(),r.headers.getOrDefault("authorization",""));}
    static boolean allowedOrigin(String o){ if(o==null)return false; if(o.equals("https://y2-y2.vercel.app")||o.equals("http://localhost:3000")||o.equals("http://127.0.0.1:3000"))return true; return o.matches("https://y2-y2-[a-z0-9-]+-wondaes-projects-fe5c826b\\.vercel\\.app"); }
    private static boolean constantEquals(String a,String b){return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8),b.getBytes(StandardCharsets.UTF_8));}

    private void json(OutputStream out,int code,Request r,String ignored,JSONObject obj)throws IOException{byte[] body=obj.toString().getBytes(StandardCharsets.UTF_8);String origin=r.origin();StringBuilder h=new StringBuilder("HTTP/1.1 "+code+" "+reason(code)+"\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "+body.length+"\r\n");cors(h,origin);h.append("\r\n");out.write(h.toString().getBytes(StandardCharsets.UTF_8));out.write(body);out.flush();}
    private void empty(OutputStream out,int code,Request r)throws IOException{StringBuilder h=new StringBuilder("HTTP/1.1 "+code+" "+reason(code)+"\r\nContent-Length: 0\r\nConnection: close\r\n");cors(h,r.origin());h.append("\r\n");out.write(h.toString().getBytes(StandardCharsets.UTF_8));out.flush();}
    private static void cors(StringBuilder h,String origin){if(allowedOrigin(origin)){h.append("Access-Control-Allow-Origin: ").append(origin).append("\r\nVary: Origin\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n");}}
    private static String reason(int c){return switch(c){case 200->"OK";case 201->"Created";case 204->"No Content";case 400->"Bad Request";case 401->"Unauthorized";case 403->"Forbidden";case 404->"Not Found";default->"Error";};}

    static final class Request {
        final String method,path; final Map<String,String> headers; final byte[] body;
        Request(String m,String p,Map<String,String> h,byte[] b){method=m;path=p;headers=h;body=b;}
        String origin(){return headers.get("origin");}
        JSONObject json() throws JSONException{return body.length==0?new JSONObject():new JSONObject(new String(body,StandardCharsets.UTF_8));}
        static Request read(InputStream in)throws Exception{
            ByteArrayOutputStream head=new ByteArrayOutputStream(); int state=0,b;
            while((b=in.read())!=-1){head.write(b); state=(state==0&&b=='\r')?1:(state==1&&b=='\n')?2:(state==2&&b=='\r')?3:(state==3&&b=='\n')?4:0; if(state==4)break; if(head.size()>32768)throw new IOException("Headers too large");}
            if(head.size()==0)return null; String text=head.toString(StandardCharsets.UTF_8); String[] lines=text.split("\r\n"); String[] first=lines[0].split(" "); if(first.length<2)throw new IOException("Bad request");
            Map<String,String> h=new HashMap<>(); for(int i=1;i<lines.length;i++){int x=lines[i].indexOf(':');if(x>0)h.put(lines[i].substring(0,x).trim().toLowerCase(Locale.ROOT),lines[i].substring(x+1).trim());}
            int len=Integer.parseInt(h.getOrDefault("content-length","0")); if(len<0||len>MAX_BODY)throw new IOException("Body too large"); byte[] body=in.readNBytes(len); if(body.length!=len)throw new IOException("Short request body");
            return new Request(first[0],first[1].split("\\?",2)[0],h,body);
        }
    }}
