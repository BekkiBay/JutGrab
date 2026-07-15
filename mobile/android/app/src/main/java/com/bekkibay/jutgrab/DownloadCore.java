package com.bekkibay.jutgrab;

import android.content.Context;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Port of the desktop DownloadManager (app/downloader.js) to Java.
 * Queue engine: resolves the real mp4 URL from a jut.su episode page using the
 * WebView session cookies, then streams the chosen quality to disk with
 * pause/resume/cancel and byte-range continuation of .part files.
 */
public class DownloadCore {

    public static final String BASE = "https://jut.su";
    public static final String UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

    private static final Pattern DATA_PLAYER = Pattern.compile("data-player-(\\d+)\\s*=\\s*\"([^\"]+)\"");
    private static final Pattern SEASON_EP = Pattern.compile("/season-(\\d+)/episode-(\\d+)\\.html");
    private static final Pattern PLAIN_EP = Pattern.compile("/episode-(\\d+)\\.html");

    public interface Listener {
        void onQueue(JSONArray snapshot);
        void onProgress(JSONObject p);
        void onDone(JSONObject info);
        void onError(JSONObject e);
    }

    public static class Job {
        int id;
        String slug, animeTitle, title, sub, pageUrl, quality, resLabel;
        int season, episode;
        File dest;
        volatile String status = "queued"; // queued | active | paused | error
        volatile String intent = null;     // pause | cancel
        volatile long done = 0, total = 0;
        volatile double speed = 0;
        volatile Thread worker = null;
        String error = null;
    }

    private static DownloadCore instance;

    public static synchronized DownloadCore get(Context ctx) {
        if (instance == null) instance = new DownloadCore(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final List<Job> jobs = new ArrayList<>();
    private final AtomicInteger seq = new AtomicInteger(1);
    private final int concurrency = 3;
    private volatile Listener listener;

    private DownloadCore(Context ctx) {
        this.ctx = ctx;
        restoreQueue();
    }

    public void setListener(Listener l) { this.listener = l; }

    public File downloadRoot() {
        File root = new File(ctx.getExternalFilesDir(null), "Anime");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        return root;
    }

    // ---------------------------------------------------------------- helpers

    public static boolean isJutsu(String url) {
        try {
            String h = new URL(url).getHost();
            return h != null && (h.equals("jut.su") || h.endsWith(".jut.su"));
        } catch (Exception e) { return false; }
    }

    public static String safeSlug(String s) {
        String r = (s == null ? "" : s).replaceAll("[^a-zA-Z0-9_-]", "");
        return r.isEmpty() ? "anime" : r;
    }

    public static String slugFromUrl(String url) {
        try {
            String[] parts = new URL(url).getPath().split("/");
            for (String p : parts) if (!p.isEmpty()) return p;
        } catch (Exception ignored) {}
        return "anime";
    }

    public static int[] seasonEpFrom(String url) {
        Matcher m = SEASON_EP.matcher(url);
        if (m.find()) return new int[]{Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2))};
        Matcher p = PLAIN_EP.matcher(url);
        if (p.find()) return new int[]{1, Integer.parseInt(p.group(1))};
        return new int[]{1, 0};
    }

    public static String cookieHeader() {
        String c = CookieManager.getInstance().getCookie(BASE);
        return c == null ? "" : c;
    }

    /** jut.su serves pages in windows-1251 */
    public static String fetchPage(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setRequestProperty("User-Agent", UA);
        con.setRequestProperty("Referer", BASE + "/");
        con.setRequestProperty("Accept-Language", "ru,en;q=0.9");
        con.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
        String cookies = cookieHeader();
        if (!cookies.isEmpty() && isJutsu(url)) con.setRequestProperty("Cookie", cookies);
        con.setConnectTimeout(20000);
        con.setReadTimeout(30000);
        if (con.getResponseCode() != 200) throw new Exception("HTTP " + con.getResponseCode());
        try (InputStream in = con.getInputStream();
             java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream()) {
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            return new String(buf.toByteArray(), Charset.forName("windows-1251"));
        } finally {
            con.disconnect();
        }
    }

    public static Map<Integer, String> extractPlayers(String html) {
        Map<Integer, String> players = new HashMap<>();
        Matcher m = DATA_PLAYER.matcher(html);
        while (m.find()) {
            String url = m.group(2);
            if (url.contains(".mp4") && !url.contains("pixel.png"))
                players.put(Integer.parseInt(m.group(1)), url);
        }
        return players;
    }

    public static int pickQuality(Map<Integer, String> players, String quality) {
        if (players.isEmpty()) return -1;
        List<Integer> keys = new ArrayList<>(players.keySet());
        int max = keys.get(0), min = keys.get(0);
        for (int k : keys) { if (k > max) max = k; if (k < min) min = k; }
        if ("max".equals(quality)) return max;
        if ("min".equals(quality)) return min;
        int want;
        try { want = Integer.parseInt(quality.replace("p", "")); } catch (Exception e) { return max; }
        if (players.containsKey(want)) return want;
        int best = -1;
        for (int k : keys) if (k <= want && k > best) best = k;
        return best > 0 ? best : min;
    }

    // ---------------------------------------------------------------- queue

    public synchronized JSONArray snapshot() {
        JSONArray arr = new JSONArray();
        try {
            for (Job j : jobs) {
                JSONObject o = new JSONObject();
                o.put("id", j.id).put("animeTitle", j.animeTitle).put("slug", j.slug)
                        .put("season", j.season).put("episode", j.episode).put("quality", j.quality)
                        .put("title", j.title).put("sub", j.sub).put("status", j.status)
                        .put("done", j.done).put("total", j.total).put("speed", j.speed)
                        .put("pct", j.total > 0 ? Math.min(100, (int) (j.done * 100 / j.total)) : 0);
                arr.put(o);
            }
        } catch (Exception ignored) {}
        return arr;
    }

    public synchronized JSONObject enqueue(JSONArray items) {
        int queued = 0, skipped = 0;
        try {
            List<String> inQueue = new ArrayList<>();
            for (Job j : jobs) inQueue.add(j.dest.getAbsolutePath());
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                String pageUrl = it.getString("pageUrl");
                if (!isJutsu(pageUrl)) { skipped++; continue; }
                String slug = safeSlug(slugFromUrl(pageUrl));
                int[] se = seasonEpFrom(pageUrl);
                File dest = new File(downloadRoot(), slug + "/season-" + se[0] + "/episode-" + se[1] + ".mp4");
                if (dest.exists() || inQueue.contains(dest.getAbsolutePath())) { skipped++; continue; }
                inQueue.add(dest.getAbsolutePath());
                Job j = new Job();
                j.id = seq.getAndIncrement();
                j.slug = slug;
                j.animeTitle = it.optString("animeTitle", slug);
                j.season = se[0];
                j.episode = se[1];
                j.quality = it.optString("quality", "max");
                j.pageUrl = pageUrl;
                j.dest = dest;
                j.title = it.optString("title", "Серия " + se[1]);
                j.sub = j.animeTitle + " · Сезон " + se[0] + " · Серия " + se[1];
                jobs.add(j);
                queued++;
            }
        } catch (Exception ignored) {}
        emitQueue();
        tick();
        JSONObject r = new JSONObject();
        try { r.put("queued", queued).put("skipped", skipped); } catch (Exception ignored) {}
        return r;
    }

    public synchronized void pause(int id) {
        Job j = find(id);
        if (j == null) return;
        if ("active".equals(j.status)) { j.intent = "pause"; Thread w = j.worker; if (w != null) w.interrupt(); }
        else { j.status = "paused"; emitQueue(); }
    }

    public synchronized void resume(int id) {
        Job j = find(id);
        if (j == null || !("paused".equals(j.status) || "error".equals(j.status))) return;
        j.status = "queued";
        j.error = null;
        emitQueue();
        tick();
    }

    public synchronized void cancel(int id) {
        Job j = find(id);
        if (j == null) return;
        if ("active".equals(j.status)) { j.intent = "cancel"; Thread w = j.worker; if (w != null) w.interrupt(); }
        else {
            jobs.remove(j);
            deletePart(j);
            emitQueue();
        }
    }

    public synchronized void cancelAll() {
        Iterator<Job> it = jobs.iterator();
        while (it.hasNext()) {
            Job j = it.next();
            if ("active".equals(j.status)) { j.intent = "cancel"; Thread w = j.worker; if (w != null) w.interrupt(); }
            else { it.remove(); deletePart(j); }
        }
        emitQueue();
    }

    public synchronized void resumeAll() {
        for (Job j : jobs)
            if ("paused".equals(j.status) || "error".equals(j.status)) { j.status = "queued"; j.error = null; }
        emitQueue();
        tick();
    }

    public synchronized int activeCount() {
        int n = 0;
        for (Job j : jobs) if ("active".equals(j.status) || "queued".equals(j.status)) n++;
        return n;
    }

    private Job find(int id) {
        for (Job j : jobs) if (j.id == id) return j;
        return null;
    }

    private void deletePart(Job j) {
        //noinspection ResultOfMethodCallIgnored
        new File(j.dest.getAbsolutePath() + ".part").delete();
    }

    private synchronized void tick() {
        int active = 0;
        for (Job j : jobs) if ("active".equals(j.status)) active++;
        while (active < concurrency) {
            Job next = null;
            for (Job j : jobs) if ("queued".equals(j.status)) { next = j; break; }
            if (next == null) break;
            next.status = "active";
            next.intent = null;
            final Job job = next;
            Thread t = new Thread(() -> run(job), "dl-" + job.id);
            job.worker = t;
            t.start();
            active++;
        }
        DownloadService.sync(ctx, activeCount());
    }

    // ---------------------------------------------------------------- worker

    private void run(Job job) {
        emitQueue();
        try {
            // resolve real mp4 URL from the episode page (session cookies required)
            String html = fetchPage(job.pageUrl);
            Map<Integer, String> players = extractPlayers(html);
            int res = pickQuality(players, job.quality);
            if (res < 0) throw new AuthException();
            job.resLabel = res + "p";
            download(job, players.get(res));

            synchronized (this) { jobs.remove(job); }
            recordLibrary(job);
            JSONObject info = new JSONObject();
            info.put("id", job.id).put("slug", job.slug).put("animeTitle", job.animeTitle)
                    .put("season", job.season).put("episode", job.episode).put("title", job.title)
                    .put("quality", job.resLabel).put("dest", job.dest.getAbsolutePath())
                    .put("bytes", job.total);
            Listener l = listener;
            if (l != null) l.onDone(info);
        } catch (Throwable err) {
            try {
                if ("cancel".equals(job.intent)) {
                    synchronized (this) { jobs.remove(job); }
                    deletePart(job);
                    emitError(job.id, "cancelled", job.title, null);
                } else if ("pause".equals(job.intent)) {
                    job.status = "paused";
                    job.speed = 0;
                } else if (err instanceof AuthException) {
                    // session gone: pause (no tight retry loop), let user re-login
                    job.status = "paused";
                    job.speed = 0;
                    emitError(job.id, "auth", job.title, null);
                } else {
                    job.status = "error";
                    job.speed = 0;
                    job.error = String.valueOf(err.getMessage());
                    emitError(job.id, "failed", job.title, job.error);
                }
            } catch (Exception ignored) {}
            job.intent = null;
        } finally {
            job.worker = null;
            emitQueue();
            tick();
        }
    }

    private static class AuthException extends Exception {}

    private void download(Job job, String url) throws Exception {
        File part = new File(job.dest.getAbsolutePath() + ".part");
        //noinspection ResultOfMethodCallIgnored
        job.dest.getParentFile().mkdirs();
        long resume = part.exists() ? part.length() : 0;

        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setRequestProperty("User-Agent", UA);
        con.setRequestProperty("Referer", BASE + "/");
        // mp4 lives on a signed CDN URL that authorises itself — never send
        // jut.su session cookies to a non-jut.su host
        if (isJutsu(url)) {
            String cookies = cookieHeader();
            if (!cookies.isEmpty()) con.setRequestProperty("Cookie", cookies);
        }
        if (resume > 0) con.setRequestProperty("Range", "bytes=" + resume + "-");
        con.setConnectTimeout(20000);
        con.setReadTimeout(60000);

        int code = con.getResponseCode();
        if (code == 200) resume = 0;
        else if (code != 206) { con.disconnect(); throw new Exception("HTTP " + code); }

        long len = con.getContentLengthLong();
        job.total = len > 0 ? resume + len : 0;
        job.done = resume;

        long lastEmit = 0, lastBytes = resume, lastTime = System.currentTimeMillis();
        try (InputStream in = con.getInputStream();
             OutputStream out = new FileOutputStream(part, resume > 0)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (Thread.interrupted() || job.intent != null) throw new InterruptedException();
                out.write(buf, 0, n);
                job.done += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 400) {
                    double dt = (now - lastTime) / 1000.0;
                    job.speed = dt > 0 ? (job.done - lastBytes) / dt : 0;
                    lastBytes = job.done;
                    lastTime = now;
                    lastEmit = now;
                    emitProgress(job);
                    DownloadService.progress(ctx, job.title, job.total > 0 ? (int) (job.done * 100 / job.total) : -1);
                }
            }
        } finally {
            con.disconnect();
        }
        if (!part.renameTo(job.dest)) {
            Files.move(part.toPath(), job.dest.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // ---------------------------------------------------------------- library.json

    private File libraryFile() { return new File(downloadRoot(), "library.json"); }

    public synchronized JSONObject loadLibrary() {
        try {
            byte[] b = Files.readAllBytes(libraryFile().toPath());
            return new JSONObject(new String(b, Charset.forName("UTF-8")));
        } catch (Exception e) {
            JSONObject o = new JSONObject();
            try { o.put("animes", new JSONObject()); } catch (Exception ignored) {}
            return o;
        }
    }

    public synchronized void saveLibrary(JSONObject lib) {
        try (FileOutputStream out = new FileOutputStream(libraryFile())) {
            out.write(lib.toString(2).getBytes(Charset.forName("UTF-8")));
        } catch (Exception ignored) {}
    }

    private void recordLibrary(Job job) {
        try {
            JSONObject lib = loadLibrary();
            JSONObject animes = lib.optJSONObject("animes");
            if (animes == null) { animes = new JSONObject(); lib.put("animes", animes); }
            JSONObject a = animes.optJSONObject(job.slug);
            if (a == null) {
                a = new JSONObject();
                a.put("slug", job.slug).put("title", job.animeTitle)
                        .put("url", BASE + "/" + job.slug + "/").put("episodes", new JSONObject());
                animes.put(job.slug, a);
            }
            if (job.animeTitle != null && !job.animeTitle.isEmpty()) a.put("title", job.animeTitle);
            JSONObject eps = a.optJSONObject("episodes");
            if (eps == null) { eps = new JSONObject(); a.put("episodes", eps); }
            JSONObject e = new JSONObject();
            long bytes = job.dest.length();
            e.put("season", job.season).put("episode", job.episode)
                    .put("title", job.title != null ? job.title : "Серия " + job.episode)
                    .put("quality", job.resLabel)
                    .put("file", job.slug + "/season-" + job.season + "/episode-" + job.episode + ".mp4")
                    .put("bytes", bytes);
            eps.put("s" + job.season + "e" + job.episode, e);
            saveLibrary(lib);
        } catch (Exception ignored) {}
    }

    // ---------------------------------------------------------------- persistence

    private File queueFile() { return new File(ctx.getFilesDir(), "queue.json"); }

    private synchronized void persistQueue() {
        try {
            JSONArray arr = new JSONArray();
            for (Job j : jobs) {
                JSONObject o = new JSONObject();
                o.put("id", j.id).put("slug", j.slug).put("animeTitle", j.animeTitle)
                        .put("season", j.season).put("episode", j.episode).put("quality", j.quality)
                        .put("pageUrl", j.pageUrl).put("title", j.title).put("sub", j.sub)
                        .put("status", "active".equals(j.status) ? "queued" : j.status);
                arr.put(o);
            }
            try (FileOutputStream out = new FileOutputStream(queueFile())) {
                out.write(arr.toString().getBytes(Charset.forName("UTF-8")));
            }
        } catch (Exception ignored) {}
    }

    private void restoreQueue() {
        try {
            byte[] b = Files.readAllBytes(queueFile().toPath());
            JSONArray arr = new JSONArray(new String(b, Charset.forName("UTF-8")));
            int maxId = 0;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Job j = new Job();
                j.id = o.optInt("id", seq.get());
                j.slug = o.getString("slug");
                j.animeTitle = o.optString("animeTitle", j.slug);
                j.season = o.optInt("season", 1);
                j.episode = o.optInt("episode", 0);
                j.quality = o.optString("quality", "max");
                j.pageUrl = o.getString("pageUrl");
                j.title = o.optString("title", "Серия " + j.episode);
                j.sub = o.optString("sub", "");
                // restored jobs wait for an explicit resume (no surprise traffic on launch)
                String st = o.optString("status", "paused");
                j.status = "queued".equals(st) ? "paused" : st;
                j.dest = new File(downloadRoot(), j.slug + "/season-" + j.season + "/episode-" + j.episode + ".mp4");
                if (j.dest.exists()) continue;
                jobs.add(j);
                if (j.id > maxId) maxId = j.id;
            }
            seq.set(maxId + 1);
        } catch (Exception ignored) {}
    }

    // ---------------------------------------------------------------- events

    private void emitQueue() {
        persistQueue();
        Listener l = listener;
        if (l != null) l.onQueue(snapshot());
        DownloadService.sync(ctx, activeCount());
    }

    private void emitProgress(Job j) {
        Listener l = listener;
        if (l == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("id", j.id).put("done", j.done).put("total", j.total).put("speed", j.speed)
                    .put("pct", j.total > 0 ? Math.min(100, (int) (j.done * 100 / j.total)) : 0);
            l.onProgress(o);
        } catch (Exception ignored) {}
    }

    private void emitError(int id, String code, String title, String message) {
        Listener l = listener;
        if (l == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("id", id).put("code", code).put("title", title);
            if (message != null) o.put("message", message);
            l.onError(o);
        } catch (Exception ignored) {}
    }
}
