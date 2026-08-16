package dev.y2y2.engine;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class EngineStore {
    private static final String PREFS = "y2y2-engine";
    private static final String TOKEN = "token";
    private final Context context;
    private final File jobsFile;
    private final SharedPreferences prefs;
    private final List<JSONObject> jobs = new ArrayList<>();
    private final SecureRandom random = new SecureRandom();
    private String pairCode;

    EngineStore(Context context) {
        this.context = context.getApplicationContext();
        this.jobsFile = new File(context.getFilesDir(), "jobs.json");
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getString(TOKEN, null) == null) {
            prefs.edit().putString(TOKEN, UUID.randomUUID().toString() + UUID.randomUUID()).apply();
        }
        rotatePairCode();
        load();
        recoverInterrupted();
    }

    synchronized String token() { return prefs.getString(TOKEN, ""); }
    synchronized String pairCode() { return pairCode; }
    synchronized void rotatePairCode() { pairCode = String.format(Locale.US, "%06d", random.nextInt(1_000_000)); }

    synchronized JSONObject create(JSONObject payload) throws JSONException {
        validateJob(payload);
        JSONObject job = new JSONObject();
        job.put("id", UUID.randomUUID().toString().replace("-", "").substring(0, 24));
        job.put("url", payload.getString("url"));
        job.put("videoId", payload.optString("videoId", ""));
        job.put("title", payload.optString("title", "media"));
        job.put("mediaType", payload.getString("mediaType"));
        job.put("quality", payload.getInt("quality"));
        job.put("filenamePrefix", payload.optString("filenamePrefix", ""));
        job.put("status", "queued");
        job.put("stage", "queued");
        job.put("progress", 0.0);
        job.put("error", JSONObject.NULL);
        job.put("outputPath", JSONObject.NULL);
        job.put("filename", JSONObject.NULL);
        job.put("sizeBytes", JSONObject.NULL);
        job.put("createdAt", System.currentTimeMillis());
        job.put("updatedAt", System.currentTimeMillis());
        jobs.add(job);
        save();
        return copy(job);
    }

    synchronized List<JSONObject> list() {
        ArrayList<JSONObject> out = new ArrayList<>();
        for (JSONObject j : jobs) out.add(copy(j));
        out.sort((a,b) -> Long.compare(b.optLong("createdAt"), a.optLong("createdAt")));
        return out;
    }

    synchronized JSONObject get(String id) {
        for (JSONObject j : jobs) if (id.equals(j.optString("id"))) return copy(j);
        return null;
    }

    synchronized JSONObject update(String id, String status, String stage, Double progress, String error,
                                   String outputPath, String filename, Long sizeBytes) {
        JSONObject j = raw(id);
        if (j == null) return null;
        try {
            if (status != null) j.put("status", status);
            if (stage != null) j.put("stage", stage);
            if (progress != null) j.put("progress", progress);
            if (error != null) j.put("error", error);
            if (outputPath != null) j.put("outputPath", outputPath);
            if (filename != null) j.put("filename", filename);
            if (sizeBytes != null) j.put("sizeBytes", sizeBytes);
            j.put("updatedAt", System.currentTimeMillis());
            save();
        } catch (JSONException ignored) {}
        return copy(j);
    }

    synchronized JSONObject fail(String id, Throwable error) {
        return update(id, "failed", "failed", null, compactError(error), null, null, null);
    }

    synchronized JSONObject retry(String id) {
        JSONObject j = raw(id);
        if (j == null) return null;
        String status = j.optString("status");
        if (!status.equals("failed") && !status.equals("canceled")) return copy(j);
        try {
            j.put("status", "queued"); j.put("stage", "queued"); j.put("progress", 0.0);
            j.put("error", JSONObject.NULL); j.put("updatedAt", System.currentTimeMillis()); save();
        } catch (JSONException ignored) {}
        return copy(j);
    }

    synchronized JSONObject cancel(String id) {
        JSONObject j = raw(id);
        if (j == null) return null;
        try {
            String s = j.optString("status");
            if (!s.equals("ready")) { j.put("status", "canceled"); j.put("stage", "canceled"); j.put("updatedAt", System.currentTimeMillis()); save(); }
        } catch (JSONException ignored) {}
        return copy(j);
    }

    synchronized JSONObject nextQueued() {
        return jobs.stream().filter(j -> "queued".equals(j.optString("status")))
                .min(Comparator.comparingLong(j -> j.optLong("createdAt"))).map(EngineStore::copy).orElse(null);
    }

    synchronized boolean filenameExists(String name) {
        for (JSONObject j : jobs) if ("ready".equals(j.optString("status")) && name.equals(j.optString("filename"))) return true;
        return false;
    }

    private JSONObject raw(String id) { for (JSONObject j : jobs) if (id.equals(j.optString("id"))) return j; return null; }

    private void validateJob(JSONObject p) throws JSONException {
        MediaWorker.validateUrl(p.getString("url"));
        String type = p.getString("mediaType");
        int q = p.getInt("quality");
        if (!(type.equals("mp3") || type.equals("mp4"))) throw new JSONException("Unsupported media type");
        if (type.equals("mp3") && !(q==128 || q==192 || q==256 || q==320)) throw new JSONException("Unsupported MP3 bitrate");
        if (type.equals("mp4") && !(q==360 || q==720 || q==1080 || q==1440 || q==2160)) throw new JSONException("Unsupported MP4 quality");
    }

    private void recoverInterrupted() {
        boolean changed = false;
        for (JSONObject j : jobs) {
            String s = j.optString("status");
            if (s.equals("queued") || s.equals("processing")) {
                try { j.put("status", "queued"); j.put("stage", "recovered"); j.put("progress", 0.0); changed = true; } catch (JSONException ignored) {}
            }
        }
        if (changed) save();
    }

    private void load() {
        if (!jobsFile.isFile()) return;
        try {
            JSONArray a = new JSONArray(Files.readString(jobsFile.toPath(), StandardCharsets.UTF_8));
            for (int i=0;i<a.length();i++) jobs.add(a.getJSONObject(i));
        } catch (Exception ignored) { jobs.clear(); }
    }

    private synchronized void save() {
        JSONArray a = new JSONArray(); for (JSONObject j : jobs) a.put(j);
        try { Files.writeString(jobsFile.toPath(), a.toString(), StandardCharsets.UTF_8); } catch (Exception ignored) {}
    }

    private static JSONObject copy(JSONObject j) { try { return new JSONObject(j.toString()); } catch (JSONException e) { return new JSONObject(); } }
    private static String compactError(Throwable t) {
        String m = t == null ? "Unknown error" : String.valueOf(t.getMessage());
        if (m.length() > 1200) m = m.substring(m.length()-1200);
        return m;
    }
}
