package dev.y2y2.engine;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.mapper.VideoFormat;
import com.yausername.youtubedl_android.mapper.VideoInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicBoolean;
import kotlin.Unit;
import kotlin.jvm.functions.Function3;

final class MediaWorker {
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList("youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","youtu.be"));
    private static final Set<Integer> HEIGHTS = new HashSet<>(Arrays.asList(360,720,1080,1440,2160));
    private final Context context;
    private final EngineStore store;
    private final AtomicBoolean initialized = new AtomicBoolean(false);

    MediaWorker(Context context, EngineStore store) { this.context=context.getApplicationContext(); this.store=store; }

    synchronized void init() throws Exception {
        if (initialized.get()) return;
        YoutubeDL.getInstance().init(context);
        FFmpeg.getInstance().init(context);
        initialized.set(true);
    }

    static String validateUrl(String raw) {
        if (raw == null || raw.length() > 2048) throw new IllegalArgumentException("Invalid URL");
        try {
            URI u = new URI(raw.trim());
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            if (!("http".equals(u.getScheme()) || "https".equals(u.getScheme())) || !HOSTS.contains(host)) {
                throw new IllegalArgumentException("Only standard YouTube URLs are supported");
            }
            return raw.trim();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid URL", error);
        }
    }

    JSONObject inspect(String raw) throws Exception {
        init();
        String url = validateUrl(raw);
        YoutubeDLRequest req = new YoutubeDLRequest(url); req.addOption("--no-playlist");
        VideoInfo info = YoutubeDL.getInstance().getInfo(req);
        TreeSet<Integer> heights = new TreeSet<>();
        if (info.getFormats() != null) for (VideoFormat f : info.getFormats()) if (HEIGHTS.contains(f.getHeight()) && f.getVcodec()!=null && !"none".equals(f.getVcodec())) heights.add(f.getHeight());
        JSONObject out = new JSONObject();
        out.put("videoId", info.getId()==null?"":info.getId()); out.put("title", info.getTitle()==null?"Untitled":info.getTitle());
        out.put("duration", info.getDuration()); out.put("thumbnail", info.getThumbnail()==null?"":info.getThumbnail());
        out.put("channel", info.getUploader()==null?"":info.getUploader());
        JSONArray h = new JSONArray(); for (int q : heights) h.put(q); out.put("mp4Qualities", h);
        out.put("mp3Qualities", new JSONArray(Arrays.asList(128,192,256,320)));
        return out;
    }

    void process(JSONObject job) throws Exception {
        init(); String id=job.getString("id");
        if ("canceled".equals(store.get(id).optString("status"))) return;
        store.update(id,"processing","downloading",0.0,null,null,null,null);
        File workRoot = new File(context.getExternalFilesDir(null), "work/"+id); if (!workRoot.exists() && !workRoot.mkdirs()) throw new Exception("Unable to create work directory");
        File template = new File(workRoot, "media.%(ext)s");
        String type=job.getString("mediaType"); int quality=job.getInt("quality");
        YoutubeDLRequest req = new YoutubeDLRequest(job.getString("url")); req.addOption("--no-playlist"); req.addOption("--newline"); req.addOption("-o", template.getAbsolutePath());
        if (type.equals("mp3")) {
            req.addOption("-f","bestaudio/best"); req.addOption("-x"); req.addOption("--audio-format","mp3"); req.addOption("--audio-quality",quality+"K");
        } else {
            String fmt="bv*[height="+quality+"][ext=mp4]+ba[ext=m4a]/b[height="+quality+"][ext=mp4]/bv*[height="+quality+"]+ba/b[height="+quality+"]";
            req.addOption("-f",fmt); req.addOption("--merge-output-format","mp4");
        }
        Function3<Float, Long, String, Unit> callback = (progress, eta, line) -> {
            JSONObject current=store.get(id);
            if (current!=null && "canceled".equals(current.optString("status"))) YoutubeDL.getInstance().destroyProcessById(id);
            store.update(id,null,"downloading",progress.doubleValue(),null,null,null,null);
            return Unit.INSTANCE;
        };
        YoutubeDL.getInstance().execute(req, id, callback);
        JSONObject current=store.get(id); if (current!=null && "canceled".equals(current.optString("status"))) return;
        File output = newestOutput(workRoot, type); if (output==null) throw new Exception("yt-dlp completed without a usable output file");
        store.update(id,null,"publishing",100.0,null,null,null,null);
        String ext=type.equals("mp3")?"mp3":"mp4"; String base=safeFilename(job.optString("filenamePrefix","")+job.optString("title","media"));
        String filename=base+"."+ext; if (store.filenameExists(filename)) filename=base+" - "+id.substring(0,6)+"."+ext;
        Uri uri=publish(output,filename,type.equals("mp3")?"audio/mpeg":"video/mp4");
        store.update(id,"ready","saved",100.0,null,uri.toString(),filename,output.length());
        deleteTree(workRoot);
    }

    void cancel(String id) { YoutubeDL.getInstance().destroyProcessById(id); store.cancel(id); }

    void reveal(JSONObject job) throws Exception {
        String raw=job.optString("outputPath",""); if (!raw.startsWith("content://")) throw new Exception("Output is unavailable");
        Intent i=new Intent(Intent.ACTION_VIEW, Uri.parse(raw)); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_GRANT_READ_URI_PERMISSION); context.startActivity(i);
    }

    private Uri publish(File src,String name,String mime) throws Exception {
        ContentValues v=new ContentValues(); v.put(MediaStore.MediaColumns.DISPLAY_NAME,name); v.put(MediaStore.MediaColumns.MIME_TYPE,mime); v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS+"/Y2Y2"); v.put(MediaStore.MediaColumns.IS_PENDING,1);
        ContentResolver r=context.getContentResolver(); Uri uri=r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,v); if(uri==null) throw new Exception("Unable to create Downloads item");
        try(OutputStream out=r.openOutputStream(uri); FileInputStream in=new FileInputStream(src)){ if(out==null) throw new Exception("Unable to open Downloads item"); byte[] buf=new byte[1024*256]; int n; while((n=in.read(buf))!=-1) out.write(buf,0,n); }
        ContentValues done=new ContentValues(); done.put(MediaStore.MediaColumns.IS_PENDING,0); r.update(uri,done,null,null); return uri;
    }

    static String safeFilename(String input) {
        String s=input==null?"media":input.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_").replaceAll("\\s+"," ").trim();
        while(s.endsWith(".")||s.endsWith(" ")) s=s.substring(0,s.length()-1); if(s.length()>140) s=s.substring(0,140).trim(); return s.isEmpty()?"media":s;
    }
    private static File newestOutput(File root,String type){ File[] fs=root.listFiles((d,n)->n.toLowerCase(Locale.ROOT).endsWith("."+type)); if(fs==null||fs.length==0)return null; Arrays.sort(fs,(a,b)->Long.compare(b.lastModified(),a.lastModified())); return fs[0]; }
    private static void deleteTree(File f){ if(f==null||!f.exists())return; if(f.isDirectory()){File[] c=f.listFiles();if(c!=null)for(File x:c)deleteTree(x);} f.delete(); }
}
