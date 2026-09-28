package top.locmaymo.stm;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The one SillyTavern the app runs.
 *
 * SillyTavern keeps a chat in the page and saves all of it at once, so two
 * pages on one chat overwrite each other, and every extension runs once per
 * page. The app therefore keeps a single page and moves it to wherever the
 * reader is: the app's own screen, or a chat bubble. It belongs to the app
 * rather than to a screen, so it outlives the app being swiped away - the
 * manager's foreground service keeps the process - and a reply still being
 * written carries on.
 *
 * Everything here runs on the main thread.
 */
final class SillyTavernHost {
    private static final String TAG = "STM";
    static final int FILE_CHOOSER = 11;
    private static final String PREFERENCES = "sillytavern";
    private static final String LAST_URL = "url";
    /** The page the tools window serves, with SillyTavern framed inside it. */
    private static final String WINDOW_PATH = "/__stm/window";

    interface Opened {
        /** {@code problem} is empty when the chat is on screen, or says why not. */
        void done(String problem);
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static WebView web;
    private static MutableContextWrapper context;
    private static String url;
    private static Activity owner;
    /** SillyTavern's own frame, once chat_bridge.js has found SillyTavern in it. */
    private static JavaScriptReplyProxy page;
    private static final List<Runnable> whenReady = new ArrayList<>();
    private static final Map<String, Opened> opening = new HashMap<>();
    private static int requests;
    private static ValueCallback<Uri[]> pendingUpload;
    private static boolean waiting;

    private SillyTavernHost() {}

    static boolean isHost(WebView view) {
        return view != null && view == web;
    }

    /** Whether a page is loaded or loading, as opposed to nothing yet. */
    static boolean hasPage() {
        return web != null && url != null;
    }

    static boolean ready() {
        return page != null;
    }

    /** The address to open when nothing has asked for one: where SillyTavern was last. */
    static String lastUrl(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(LAST_URL, null);
    }

    /**
     * Show SillyTavern from {@code next}. A page already running is kept rather
     * than loaded again - its chat, its extensions and a reply still arriving -
     * unless it is the tools window being swapped for SillyTavern alone, or the
     * other way round.
     */
    static void load(Context caller, String next) {
        if (next == null) return;
        create(caller);
        if (url != null && window(url) == window(next)) return;
        url = next;
        page = null;
        caller.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(LAST_URL, next).apply();
        web.loadUrl(next);
    }

    /**
     * Load {@code next} once it answers: after the app was closed for good,
     * the manager starts SillyTavern again and that takes a while.
     */
    static void loadWhenUp(Context caller, String next, Runnable failed) {
        if (next == null || waiting) return;
        waiting = true;
        Context app = caller.getApplicationContext();
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + 120_000;
            boolean up = false;
            while (!up && System.currentTimeMillis() < deadline) {
                up = answers(next);
                if (!up) sleep(1000);
            }
            boolean answered = up;
            main.post(() -> {
                waiting = false;
                if (answered) load(app, next);
                else if (failed != null) failed.run();
            });
        }, "stm-sillytavern-wait").start();
    }

    /** Put the page on {@code activity}'s screen, taking it from wherever it was. */
    static void attach(Activity activity, ViewGroup parent) {
        create(activity);
        owner = activity;
        context.setBaseContext(activity);
        if (web.getParent() == parent) return;
        if (web.getParent() != null) ((ViewGroup) web.getParent()).removeView(web);
        parent.addView(web, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    /** Take the page off {@code activity}'s screen; it keeps running, unseen. */
    static void detach(Activity activity) {
        if (web == null || owner != activity) return;
        owner = null;
        if (web.getParent() != null) ((ViewGroup) web.getParent()).removeView(web);
        context.setBaseContext(activity.getApplicationContext());
    }

    /** Run {@code then} once SillyTavern is up in the page, now if it already is. */
    static void whenReady(Runnable then) {
        if (page != null) then.run();
        else whenReady.add(then);
    }

    /** chat_bridge.js found SillyTavern in the page. */
    static void onReady(JavaScriptReplyProxy frame) {
        page = frame;
        List<Runnable> queued = new ArrayList<>(whenReady);
        whenReady.clear();
        for (Runnable then : queued) then.run();
    }

    /**
     * Switch SillyTavern to one conversation: {@code key} is the character's
     * avatar or the group, {@code chat} the chat file. A reply being written
     * elsewhere is not interrupted; {@code done} hears "busy" then.
     */
    static void openChat(String key, String chat, Opened done) {
        if (page == null || key == null) {
            done.done("unavailable");
            return;
        }
        String id = String.valueOf(++requests);
        opening.put(id, done);
        try {
            page.postMessage(new JSONObject().put("type", "open").put("id", id).put("key", key).put("chat", chat == null ? "" : chat).toString());
        } catch (JSONException | IllegalStateException e) {
            opening.remove(id);
            done.done("unavailable");
        }
    }

    static void onOpened(JSONObject data) {
        Opened done = opening.remove(data.optString("id"));
        if (done != null) done.done(data.optString("problem", ""));
    }

    static void chooseFile(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingUpload != null) pendingUpload.onReceiveValue(null);
        pendingUpload = null;
        if (owner == null) {
            callback.onReceiveValue(null);
            return;
        }
        try {
            owner.startActivityForResult(params.createIntent(), FILE_CHOOSER);
            pendingUpload = callback;
        } catch (android.content.ActivityNotFoundException e) {
            callback.onReceiveValue(null);
        }
    }

    /** Forwarded from whichever screen holds the page. */
    static boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER) return false;
        if (pendingUpload != null) pendingUpload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingUpload = null;
        return true;
    }

    private static void create(Context caller) {
        if (web != null) return;
        Context app = caller.getApplicationContext();
        context = new MutableContextWrapper(app);
        web = new WebView(context);
        Browser.configure(web);
        String fallback = ChatBridge.attach(app, web);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String address, Bitmap favicon) {
                page = null;
            }

            @Override
            public void onPageFinished(WebView view, String address) {
                if (fallback != null && Browser.isLocal(Uri.parse(address))) view.evaluateJavascript(fallback, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                // Not up yet, or gone: the next time it is asked for it is loaded again, not kept.
                if (request.isForMainFrame()) url = null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (Browser.isLocal(uri)) {
                    // The console, reached from SillyTavern: that is the app's own screen.
                    if (uri.getPort() == ManagerService.port) {
                        MainActivity.showConsole();
                        return true;
                    }
                    return false;
                }
                Browser.openOutside(view.getContext(), uri);
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process died - out of memory, most likely. The
                // app lives on; the page is made again the next time it is shown.
                Log.w(TAG, "SillyTavern's page stopped; it will be opened again");
                String last = url;
                destroy();
                if (owner instanceof Host) ((Host) owner).pageLost(last);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                chooseFile(callback, params);
                return true;
            }

            // A page with nowhere to show a dialog must not try to: there is no window for it.
            @Override
            public boolean onJsAlert(WebView view, String address, String message, JsResult result) {
                if (owner != null) return false;
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String address, String message, JsResult result) {
                if (owner != null) return false;
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String address, String message, String value, JsPromptResult result) {
                if (owner != null) return false;
                result.cancel();
                return true;
            }
        });
    }

    /** A screen that shows the page and needs to hear when it had to be made again. */
    interface Host {
        void pageLost(String url);
    }

    private static void destroy() {
        if (web == null) return;
        if (web.getParent() != null) ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        web = null;
        url = null;
        page = null;
        whenReady.clear();
        for (Opened done : opening.values()) done.done("unavailable");
        opening.clear();
    }

    private static boolean window(String address) {
        String path = Uri.parse(address).getPath();
        return path != null && path.startsWith(WINDOW_PATH);
    }

    private static boolean answers(String address) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(3000);
            connection.setInstanceFollowRedirects(false);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code > 0 && code < 500;
        } catch (IOException e) {
            return false;
        }
    }

    private static void sleep(long millis) {
        try { Thread.sleep(millis); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
}
