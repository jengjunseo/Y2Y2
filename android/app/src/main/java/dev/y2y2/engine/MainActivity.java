package dev.y2y2.engine;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.*;

public class MainActivity extends Activity {
    private TextView status, code;
    @Override public void onCreate(Bundle b){super.onCreate(b);render();if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},4);EngineService.start(this);}
    @Override protected void onResume(){super.onResume();refresh();}
    private void render(){
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(24),dp(32),dp(24),dp(24));root.setGravity(Gravity.CENTER_HORIZONTAL);root.setBackgroundColor(Color.rgb(10,10,11));
        TextView title=text("Y2Y2 Engine",26,Color.WHITE);root.addView(title);
        status=text("Engine 시작 중…",15,Color.LTGRAY);status.setPadding(0,dp(12),0,dp(8));root.addView(status);
        code=text("------",42,Color.WHITE);code.setLetterSpacing(.16f);code.setGravity(Gravity.CENTER);root.addView(code,new LinearLayout.LayoutParams(-1,dp(88)));
        TextView hint=text("y2-y2.vercel.app의 Local Engine 연결 칸에 이 6자리 코드를 입력하세요. 실제 MP3/MP4 처리는 이 Android 기기에서 수행됩니다.",14,Color.GRAY);hint.setGravity(Gravity.CENTER);root.addView(hint);
        Button open=button("Y2Y2 열기");open.setOnClickListener(v->startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://y2-y2.vercel.app"))));root.addView(open,params());
        Button restart=button("Engine 다시 시작");restart.setOnClickListener(v->{EngineService.stop(this);v.postDelayed(()->EngineService.start(this),600);v.postDelayed(this::refresh,1200);});root.addView(restart,params());
        Button settings=button("배터리 설정 열기");settings.setOnClickListener(v->{try{startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));}catch(Exception ignored){}});root.addView(settings,params());
        TextView rights=text("본인이 다운로드 권한을 가진 콘텐츠에만 사용하세요. Y2Y2는 로그인/DRM/접근 통제 우회를 구현하지 않습니다.",12,Color.DKGRAY);rights.setGravity(Gravity.CENTER);rights.setPadding(0,dp(20),0,0);root.addView(rights);
        setContentView(root);root.postDelayed(new Runnable(){public void run(){refresh();root.postDelayed(this,1000);}},600);
    }
    private void refresh(){EngineService s=EngineService.instance;if(s==null){status.setText("Engine 꺼짐");code.setText("------");return;}String e=s.currentError();status.setText(e==null?"● Ready · localhost:49272":"오류 · "+e);code.setText(s.pairCode());}
    private TextView text(String s,int sp,int c){TextView v=new TextView(this);v.setText(s);v.setTextSize(sp);v.setTextColor(c);return v;}
    private Button button(String s){Button b=new Button(this);b.setText(s);return b;}
    private LinearLayout.LayoutParams params(){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(52));p.topMargin=dp(12);return p;}
    private int dp(int v){return Math.round(v*getResources().getDisplayMetrics().density);}
}
