package dev.y2y2.engine;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class EngineService extends Service {
    static final String ACTION_STOP="dev.y2y2.engine.STOP";
    static volatile EngineService instance;
    private EngineStore store;
    private MediaWorker worker;
    private LocalHttpServer http;
    private final ExecutorService dispatcher= Executors.newSingleThreadExecutor();
    private final AtomicBoolean dispatching=new AtomicBoolean(false);
    private volatile String error;

    public static void start(Context c){ Intent i=new Intent(c,EngineService.class); if(Build.VERSION.SDK_INT>=26)c.startForegroundService(i);else c.startService(i); }
    public static void stop(Context c){Intent i=new Intent(c,EngineService.class);i.setAction(ACTION_STOP);c.startService(i);}

    @Override public void onCreate(){super.onCreate();instance=this;createChannel();startForeground(3,notification("Engine 시작 중…"));
        store=new EngineStore(this);worker=new MediaWorker(this,store);
        dispatcher.execute(()->{try{worker.init();http=new LocalHttpServer(this,store,worker);http.start();notifyState();wakeDispatcher();}catch(Exception e){setError(e.getMessage());notifyState();}});
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){if(intent!=null&&ACTION_STOP.equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}return START_STICKY;}
    @Override public void onDestroy(){if(http!=null)http.stop();dispatcher.shutdownNow();instance=null;super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}

    void wakeDispatcher(){ if(!dispatching.compareAndSet(false,true))return; dispatcher.execute(()->{try{while(!Thread.currentThread().isInterrupted()){JSONObject job=store.nextQueued();if(job==null)break;String id=job.optString("id");try{worker.process(job);}catch(Exception e){JSONObject now=store.get(id);if(now!=null&&!"canceled".equals(now.optString("status")))store.fail(id,e);}notifyState();}}finally{dispatching.set(false);if(store.nextQueued()!=null)wakeDispatcher();}}); }
    int activeJobs(){int n=0;for(JSONObject j:store.list())if("queued".equals(j.optString("status"))||"processing".equals(j.optString("status")))n++;return n;}
    String pairCode(){return store==null?"------":store.pairCode();}
    String currentError(){return error;}
    void setError(String value){error=value;}
    void notifyPairCodeChanged(){notifyState();}

    private void createChannel(){if(Build.VERSION.SDK_INT>=26){NotificationChannel c=new NotificationChannel("y2y2","Y2Y2 Engine",NotificationManager.IMPORTANCE_LOW);getSystemService(NotificationManager.class).createNotificationChannel(c);}}
    private Notification notification(String text){Intent open=new Intent(this,MainActivity.class);PendingIntent pi=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);Intent stop=new Intent(this,EngineService.class).setAction(ACTION_STOP);PendingIntent ps=PendingIntent.getService(this,1,stop,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);return new Notification.Builder(this,"y2y2").setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Y2Y2 Engine").setContentText(text).setContentIntent(pi).setOngoing(true).addAction(new Notification.Action.Builder(null,"중지",ps).build()).build();}
    private void notifyState(){String text=error!=null?"오류: "+error:(http==null?"Engine 시작 중…":"Ready · 연결 코드 "+pairCode()+" · "+activeJobs()+" jobs");getSystemService(NotificationManager.class).notify(3,notification(text));}
}
