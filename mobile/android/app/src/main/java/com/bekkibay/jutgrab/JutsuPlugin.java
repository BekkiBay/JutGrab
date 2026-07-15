package com.bekkibay.jutgrab;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Native bridge: embedded jut.su WebView (auth lives in its CookieManager
 * session — the whole auth story, no passwords), page fetcher with those
 * cookies, download queue (DownloadCore) and library scanning.
 */
@CapacitorPlugin(name = "Jutsu")
public class JutsuPlugin extends Plugin {

    private static JutsuPlugin instance;

    private WebView web;          // embedded jut.su browser
    private FrameLayout fab;      // native download FAB drawn over the WebView
    private TextView fabBadge;
    private boolean browserVisible = false;
    private final ExecutorService io = Executors.newCachedThreadPool();

    private static final Pattern EP_SEASON = Pattern.compile("^/season-(\\d+)/episode-(\\d+)\\.html");

    @Override
    public void load() {
        instance = this;
        DownloadCore core = DownloadCore.get(getContext());
        core.setListener(new DownloadCore.Listener() {
            @Override public void onQueue(JSONArray snap) { emit("dlQueue", wrap("jobs", snap)); }
            @Override public void onProgress(JSONObject p) { emitJson("dlProgress", p); }
            @Override public void onDone(JSONObject info) { emitJson("dlDone", info); }
            @Override public void onError(JSONObject e) { emitJson("dlError", e); }
        });
    }

    private JSObject wrap(String key, Object val) {
        JSObject o = new JSObject();
        o.put(key, val);
        return o;
    }

    private void emit(String name, JSObject data) {
        notifyListeners(name, data);
    }

    private void emitJson(String name, JSONObject data) {
        try { notifyListeners(name, JSObject.fromJSONObject(data)); } catch (Exception ignored) {}
    }

    /** Hardware back: let the embedded browser consume it while visible. */
    public static boolean handleBack() {
        JutsuPlugin p = instance;
        if (p == null || p.web == null || !p.browserVisible) return false;
        if (p.web.canGoBack()) {
            p.web.goBack();
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- browser

    @SuppressLint("SetJavaScriptEnabled")
    private void ensureWeb() {
        if (web != null) return;
        web = new WebView(getActivity());
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        // same desktop UA as the validated desktop app: cookies created here are
        // replayed by fetchPage/DownloadCore under the identical UA
        web.getSettings().setUserAgentString(DownloadCore.UA);
        web.getSettings().setUseWideViewPort(true);
        web.getSettings().setLoadWithOverviewMode(true);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                // browser is locked to jut.su; external links go to the system browser
                if (DownloadCore.isJutsu(url)) return false;
                try {
                    getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                CookieManager.getInstance().flush();
                emitBrowserState();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView v, String title) { emitBrowserState(); }
        });

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(0, 0);
        getActivity().addContentView(web, lp);
        web.setVisibility(View.GONE);
        buildFab();
    }

    private void buildFab() {
        float d = density();
        fab = new FrameLayout(getActivity());

        TextView circle = new TextView(getActivity());
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor("#6C5CE7"));
        circle.setBackground(bg);
        circle.setText("⬇");
        circle.setTextColor(Color.WHITE);
        circle.setTextSize(22);
        circle.setGravity(Gravity.CENTER);
        circle.setElevation(8 * d);
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams((int) (56 * d), (int) (56 * d));
        fab.addView(circle, clp);

        fabBadge = new TextView(getActivity());
        GradientDrawable bbg = new GradientDrawable();
        bbg.setShape(GradientDrawable.OVAL);
        bbg.setColor(Color.parseColor("#FF5C5C"));
        fabBadge.setBackground(bbg);
        fabBadge.setTextColor(Color.WHITE);
        fabBadge.setTextSize(10);
        fabBadge.setTypeface(Typeface.DEFAULT_BOLD);
        fabBadge.setGravity(Gravity.CENTER);
        fabBadge.setElevation(9 * d);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams((int) (18 * d), (int) (18 * d), Gravity.END | Gravity.TOP);
        fab.addView(fabBadge, blp);
        fabBadge.setVisibility(View.GONE);

        fab.setOnClickListener(v -> emit("fabTap", new JSObject()));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams((int) (60 * d), (int) (60 * d));
        getActivity().addContentView(fab, lp);
        fab.setVisibility(View.GONE);
    }

    private float density() {
        return getContext().getResources().getDisplayMetrics().density;
    }

    private void emitBrowserState() {
        if (web == null) return;
        JSObject s = new JSObject();
        s.put("url", web.getUrl());
        s.put("title", web.getTitle());
        s.put("canGoBack", web.canGoBack());
        emit("browserState", s);
    }

    @PluginMethod
    public void browserShow(PluginCall call) {
        final int top = call.getInt("top", 0);
        final int height = call.getInt("height", 0);
        final int fabBottom = call.getInt("fabBottom", 90);
        getActivity().runOnUiThread(() -> {
            ensureWeb();
            float d = density();
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
            lp.width = FrameLayout.LayoutParams.MATCH_PARENT;
            lp.height = (int) (height * d);
            lp.topMargin = (int) (top * d);
            web.setLayoutParams(lp);
            web.setVisibility(View.VISIBLE);

            View parent = (View) fab.getParent();
            FrameLayout.LayoutParams flp = (FrameLayout.LayoutParams) fab.getLayoutParams();
            flp.gravity = Gravity.END | Gravity.BOTTOM;
            flp.rightMargin = (int) (16 * d);
            flp.bottomMargin = (int) (fabBottom * d);
            fab.setLayoutParams(flp);
            fab.setVisibility(View.VISIBLE);
            fab.bringToFront();
            browserVisible = true;
            if (web.getUrl() == null) {
                String start = call.getString("url", DownloadCore.BASE + "/anime/");
                web.loadUrl(start);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void browserHide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (web != null) web.setVisibility(View.GONE);
            if (fab != null) fab.setVisibility(View.GONE);
            browserVisible = false;
            call.resolve();
        });
    }

    @PluginMethod
    public void browserLoad(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !DownloadCore.isJutsu(url)) { call.reject("only jut.su"); return; }
        getActivity().runOnUiThread(() -> {
            ensureWeb();
            web.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void browserReload(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (web != null) web.reload();
            call.resolve();
        });
    }

    @PluginMethod
    public void browserBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean handled = web != null && web.canGoBack();
            if (handled) web.goBack();
            JSObject r = new JSObject();
            r.put("handled", handled);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void browserState(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject s = new JSObject();
            s.put("url", web == null ? null : web.getUrl());
            s.put("title", web == null ? null : web.getTitle());
            s.put("canGoBack", web != null && web.canGoBack());
            call.resolve(s);
        });
    }

    @PluginMethod
    public void setBadge(PluginCall call) {
        final int count = call.getInt("count", 0);
        getActivity().runOnUiThread(() -> {
            if (fabBadge != null) {
                fabBadge.setText(count > 9 ? "9+" : String.valueOf(count));
                fabBadge.setVisibility(count > 0 ? View.VISIBLE : View.GONE);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void nativeToast(PluginCall call) {
        String text = call.getString("text", "");
        getActivity().runOnUiThread(() ->
                Toast.makeText(getContext(), text, Toast.LENGTH_SHORT).show());
        call.resolve();
    }

    // ---------------------------------------------------------------- session

    @PluginMethod
    public void loginStatus(PluginCall call) {
        String cookies = DownloadCore.cookieHeader();
        String userId = null;
        for (String part : cookies.split(";\\s*")) {
            if (part.startsWith("dle_user_id=")) { userId = part.substring("dle_user_id=".length()); break; }
        }
        JSObject r = new JSObject();
        r.put("loggedIn", userId != null && !userId.isEmpty() && !"0".equals(userId));
        r.put("userId", userId);
        call.resolve(r);
    }

    // ---------------------------------------------------------------- fetch

    @PluginMethod
    public void fetchPage(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !DownloadCore.isJutsu(url)) { call.reject("only jut.su"); return; }
        io.execute(() -> {
            try {
                String html = DownloadCore.fetchPage(url);
                JSObject r = new JSObject();
                r.put("html", html);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void fetchHead(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("no url"); return; }
        io.execute(() -> {
            try {
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setRequestMethod("HEAD");
                con.setRequestProperty("User-Agent", DownloadCore.UA);
                con.setRequestProperty("Referer", DownloadCore.BASE + "/");
                con.setConnectTimeout(15000);
                con.setReadTimeout(15000);
                long len = con.getResponseCode() < 400 ? con.getContentLengthLong() : -1;
                con.disconnect();
                JSObject r = new JSObject();
                r.put("length", len);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    // ---------------------------------------------------------------- downloads

    @PluginMethod
    public void dlEnqueue(PluginCall call) {
        requestNotifPermission();
        try {
            JSONArray items = call.getArray("items");
            JSONObject r = DownloadCore.get(getContext()).enqueue(items);
            call.resolve(JSObject.fromJSONObject(r));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void dlState(PluginCall call) {
        call.resolve(wrap("jobs", DownloadCore.get(getContext()).snapshot()));
    }

    @PluginMethod
    public void dlPause(PluginCall call) { DownloadCore.get(getContext()).pause(call.getInt("id", 0)); call.resolve(); }

    @PluginMethod
    public void dlResume(PluginCall call) { DownloadCore.get(getContext()).resume(call.getInt("id", 0)); call.resolve(); }

    @PluginMethod
    public void dlCancel(PluginCall call) { DownloadCore.get(getContext()).cancel(call.getInt("id", 0)); call.resolve(); }

    @PluginMethod
    public void dlCancelAll(PluginCall call) { DownloadCore.get(getContext()).cancelAll(); call.resolve(); }

    @PluginMethod
    public void dlResumeAll(PluginCall call) { DownloadCore.get(getContext()).resumeAll(); call.resolve(); }

    private void requestNotifPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(),
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9001);
        }
    }

    // ---------------------------------------------------------------- library

    private static final Pattern SEASON_DIR = Pattern.compile("^season-(\\d+)$");
    private static final Pattern EP_FILE = Pattern.compile("^episode-(\\d+)\\.mp4$");

    @PluginMethod
    public void libraryList(PluginCall call) {
        io.execute(() -> {
            try {
                DownloadCore core = DownloadCore.get(getContext());
                File root = core.downloadRoot();
                JSONObject animesMeta = core.loadLibrary().optJSONObject("animes");

                // slug -> ("sSeE" -> episode json). Merges two sources: private files
                // on disk (legacy v0.1.0 / API < 29) and episodes saved to the
                // device's shared storage (MediaStore), tracked in library.json.
                Map<String, LinkedHashMap<String, JSONObject>> bySlug = new LinkedHashMap<>();

                // 1) private files on disk
                File[] tops = root.listFiles();
                if (tops != null) {
                    for (File dir : tops) {
                        if (!dir.isDirectory()) continue;
                        String slug = dir.getName();
                        File[] seasonDirs = dir.listFiles();
                        if (seasonDirs == null) continue;
                        for (File sd : seasonDirs) {
                            if (!sd.isDirectory()) continue;
                            Matcher sm = SEASON_DIR.matcher(sd.getName());
                            if (!sm.matches()) continue;
                            int season = Integer.parseInt(sm.group(1));
                            File[] files = sd.listFiles();
                            if (files == null) continue;
                            for (File f : files) {
                                Matcher em = EP_FILE.matcher(f.getName());
                                if (!em.matches()) continue;
                                int episode = Integer.parseInt(em.group(1));
                                JSONObject m = epMeta(animesMeta, slug, season, episode);
                                JSONObject e = new JSONObject();
                                e.put("season", season).put("episode", episode)
                                        .put("title", m != null ? m.optString("title", "Серия " + episode) : "Серия " + episode)
                                        .put("quality", m != null ? m.optString("quality", "") : "")
                                        .put("file", slug + "/season-" + season + "/episode-" + episode + ".mp4")
                                        .put("path", f.getAbsolutePath())
                                        .put("bytes", f.length());
                                putEp(bySlug, slug, season, episode, e);
                            }
                        }
                    }
                }

                // 2) episodes in the device's storage (MediaStore)
                if (animesMeta != null) {
                    Iterator<String> slugs = animesMeta.keys();
                    while (slugs.hasNext()) {
                        String slug = slugs.next();
                        JSONObject a = animesMeta.optJSONObject(slug);
                        JSONObject eps = a != null ? a.optJSONObject("episodes") : null;
                        if (eps == null) continue;
                        Iterator<String> keys = eps.keys();
                        while (keys.hasNext()) {
                            JSONObject m = eps.optJSONObject(keys.next());
                            String uri = m != null ? m.optString("uri", "") : "";
                            if (uri.isEmpty()) continue;              // covered by the disk walk
                            long bytes = core.mediaSize(uri);
                            if (bytes < 0) continue;                  // removed from device storage
                            int season = m.optInt("season"), episode = m.optInt("episode");
                            JSONObject e = new JSONObject();
                            e.put("season", season).put("episode", episode)
                                    .put("title", m.optString("title", "Серия " + episode))
                                    .put("quality", m.optString("quality", ""))
                                    .put("file", slug + "/season-" + season + "/episode-" + episode + ".mp4")
                                    .put("uri", uri)
                                    .put("path", uri)
                                    .put("bytes", bytes);
                            putEp(bySlug, slug, season, episode, e);
                        }
                    }
                }

                // 3) emit merged, sorted animes
                JSONArray animes = new JSONArray();
                long totalBytes = 0;
                for (Map.Entry<String, LinkedHashMap<String, JSONObject>> en : bySlug.entrySet()) {
                    String slug = en.getKey();
                    List<JSONObject> eps = new ArrayList<>(en.getValue().values());
                    if (eps.isEmpty()) continue;
                    eps.sort((a, b) -> {
                        int s = a.optInt("season") - b.optInt("season");
                        return s != 0 ? s : a.optInt("episode") - b.optInt("episode");
                    });
                    long bytes = 0;
                    java.util.Set<Integer> seasons = new java.util.HashSet<>();
                    JSONArray epArr = new JSONArray();
                    for (JSONObject e : eps) { seasons.add(e.optInt("season")); bytes += e.optLong("bytes"); epArr.put(e); }
                    JSONObject meta = animesMeta != null ? animesMeta.optJSONObject(slug) : null;
                    File posterFile = new File(root, slug + "/poster.jpg");
                    JSONObject a = new JSONObject();
                    a.put("slug", slug)
                            .put("title", meta != null ? meta.optString("title", slug) : slug)
                            .put("url", DownloadCore.BASE + "/" + slug + "/")
                            .put("poster", posterFile.exists() ? posterFile.getAbsolutePath() : null)
                            .put("episodes", epArr)
                            .put("count", eps.size())
                            .put("bytes", bytes)
                            .put("seasons", seasons.size());
                    animes.put(a);
                    totalBytes += bytes;
                }

                JSObject r = new JSObject();
                r.put("animes", animes);
                r.put("totalBytes", totalBytes);
                r.put("freeBytes", root.getFreeSpace());
                r.put("diskBytes", root.getTotalSpace());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private static JSONObject epMeta(JSONObject animesMeta, String slug, int season, int episode) {
        if (animesMeta == null) return null;
        JSONObject a = animesMeta.optJSONObject(slug);
        JSONObject eps = a != null ? a.optJSONObject("episodes") : null;
        return eps != null ? eps.optJSONObject("s" + season + "e" + episode) : null;
    }

    private static void putEp(Map<String, LinkedHashMap<String, JSONObject>> bySlug,
                              String slug, int season, int episode, JSONObject e) {
        LinkedHashMap<String, JSONObject> m = bySlug.get(slug);
        if (m == null) { m = new LinkedHashMap<>(); bySlug.put(slug, m); }
        m.putIfAbsent("s" + season + "e" + episode, e);   // a real disk file wins over a stale entry
    }

    @PluginMethod
    public void deleteEpisode(PluginCall call) {
        String rel = call.getString("file");
        String uri = call.getString("uri");
        if (rel == null) { call.reject("no file"); return; }
        try {
            DownloadCore core = DownloadCore.get(getContext());
            // device-storage copy (MediaStore) — remove it from the gallery too
            if (uri != null && !uri.isEmpty()) {
                try { getContext().getContentResolver().delete(Uri.parse(uri), null, null); } catch (Exception ignored) {}
            }
            File root = core.downloadRoot();
            File abs = new File(root, rel).getCanonicalFile();
            // path-traversal guard: stay inside the downloads root
            if (!abs.getPath().startsWith(root.getCanonicalPath() + File.separator)) {
                call.reject("bad path");
                return;
            }
            //noinspection ResultOfMethodCallIgnored
            abs.delete();
            File seasonDir = abs.getParentFile();
            if (seasonDir != null && seasonDir.isDirectory()) {
                String[] left = seasonDir.list();
                if (left != null && left.length == 0) //noinspection ResultOfMethodCallIgnored
                    seasonDir.delete();
            }
            Matcher m = Pattern.compile("^(.+?)/season-(\\d+)/episode-(\\d+)\\.mp4$")
                    .matcher(rel.replace('\\', '/'));
            if (m.matches()) {
                JSONObject lib = core.loadLibrary();
                JSONObject animes = lib.optJSONObject("animes");
                JSONObject a = animes != null ? animes.optJSONObject(m.group(1)) : null;
                JSONObject eps = a != null ? a.optJSONObject("episodes") : null;
                if (eps != null) {
                    eps.remove("s" + m.group(2) + "e" + m.group(3));
                    core.saveLibrary(lib);
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void setAnimeMeta(PluginCall call) {
        String slug = call.getString("slug");
        String title = call.getString("title");
        if (slug == null) { call.reject("no slug"); return; }
        try {
            DownloadCore core = DownloadCore.get(getContext());
            JSONObject lib = core.loadLibrary();
            JSONObject animes = lib.optJSONObject("animes");
            if (animes == null) { animes = new JSONObject(); lib.put("animes", animes); }
            JSONObject a = animes.optJSONObject(slug);
            if (a == null) {
                a = new JSONObject();
                a.put("slug", slug).put("url", DownloadCore.BASE + "/" + slug + "/")
                        .put("episodes", new JSONObject());
                animes.put(slug, a);
            }
            if (title != null && !title.isEmpty()) a.put("title", title);
            core.saveLibrary(lib);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void savePoster(PluginCall call) {
        final String slug = call.getString("slug");
        final String url = call.getString("url");
        if (slug == null || url == null) { call.reject("slug+url required"); return; }
        io.execute(() -> {
            try {
                DownloadCore core = DownloadCore.get(getContext());
                File dir = new File(core.downloadRoot(), DownloadCore.safeSlug(slug));
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File out = new File(dir, "poster.jpg");
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setRequestProperty("User-Agent", DownloadCore.UA);
                // referer only for jut.su-hosted art; no cookies to third parties
                if (DownloadCore.isJutsu(url)) con.setRequestProperty("Referer", DownloadCore.BASE + "/");
                con.setConnectTimeout(15000);
                con.setReadTimeout(20000);
                if (con.getResponseCode() != 200) throw new Exception("HTTP " + con.getResponseCode());
                try (InputStream in = con.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                    byte[] b = new byte[16384];
                    int n;
                    while ((n = in.read(b)) > 0) fo.write(b, 0, n);
                }
                con.disconnect();
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }
}
