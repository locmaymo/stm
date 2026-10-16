package top.locmaymo.stm;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The console, in a WebView, once the manager behind it answers; and
 * SillyTavern over it when the reader opens it.
 *
 * Before the first start it asks for what keeps the app running in the
 * background; see {@link PermissionsScreen}. Until the console answers the
 * screen says what the service is doing - unpacking on a first start takes a
 * while. When the manager stops - from the notification, or on its own - the
 * console goes with it, because a console with nothing behind it is a page
 * that answers nothing; the screen says so and starts it on a tap, and coming
 * back to the app starts it without one. Pages the manager
 * serves stay in here; anything else, a tunnel address or a sign-in, opens in
 * the phone's browser.
 *
 * SillyTavern is not a page of the console's WebView but the app's one
 * SillyTavern page (see {@link SillyTavernHost}), laid over the console while
 * it is open. Going back to the console leaves it running; opening it again,
 * here or in a chat bubble, shows the same page.
 */
public class MainActivity extends Activity implements SillyTavernHost.Host {
    private static final int FILE_CHOOSER = 10;
    static final String EXTRA_URL = "top.locmaymo.stm.extra.URL";
    /** Whether the reader is looking at SillyTavern in the app; a chat bubble is for when they are not. */
    static volatile boolean watching;
    /** Whether this screen is in front at all. */
    static volatile boolean inFront;
    private static MainActivity current;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private LinearLayout splash;
    private TextView statusView;
    private ProgressBar spinner;
    private WebView web;
    private FrameLayout sillyTavern;
    private boolean showingSillyTavern;
    private boolean resumed;
    private ValueCallback<Uri[]> pendingUpload;
    private boolean polling;
    /** The permissions screen, while it is up; nothing starts until it is done. */
    private PermissionsScreen permissions;
    /** While the app is in front: notice the manager stopping under the console. */
    private final Runnable watch = new Runnable() {
        @Override
        public void run() {
            if (!resumed) return;
            if (web != null && managerDown()) {
                dropConsole();
                poll();
            }
            handler.postDelayed(this, 1500);
        }
    };

    /** Show SillyTavern from {@code url} in the app, opening the app if it is not open. */
    static void showSillyTavern(Context context, String url) {
        if (current != null) {
            current.openSillyTavern(url);
            return;
        }
        context.startActivity(new Intent(context, MainActivity.class).putExtra(EXTRA_URL, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** The console asked for a backup zip from the phone; see {@link BackupImport}. */
    static void importZip(Uri origin, String csrf, androidx.webkit.JavaScriptReplyProxy reply) {
        if (current != null) BackupImport.pick(current, origin, csrf, reply);
    }

    /** The console asked to move a SillyTavern over from Termux; see {@link TermuxImport}. */
    static void importTermux(Uri origin, String csrf, androidx.webkit.JavaScriptReplyProxy reply) {
        if (current != null) BackupImport.pickTermux(current, origin, csrf, reply);
    }

    /** The console asked for a newer release of the app; see {@link AppUpdate}. */
    static void updateApp(String version, androidx.webkit.JavaScriptReplyProxy reply) {
        if (current != null) AppUpdate.start(current, version, reply);
    }

    /**
     * SillyTavern stopped under its page: back to the console, saying so, and
     * the page goes. Opening SillyTavern again loads it fresh once it is up.
     */
    static void sillyTavernStopped() {
        boolean shown = current != null && current.showingSillyTavern;
        if (shown) current.closeSillyTavern();
        SillyTavernHost.reset();
        if (shown) Toast.makeText(current, R.string.sillytavern_stopped, Toast.LENGTH_LONG).show();
    }

    /** Back to the console, from a link in SillyTavern that points at it. */
    static void showConsole() {
        if (current != null) current.closeSillyTavern();
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x0f, 0x11, 0x17));
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        splash.setPadding(padding, padding, padding, padding);
        spinner = new ProgressBar(this);
        statusView = new TextView(this);
        statusView.setTextColor(Color.rgb(0xd1, 0xd5, 0xdb));
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(0, padding, 0, 0);
        splash.addView(spinner);
        splash.addView(statusView);
        splash.setOnClickListener((view) -> { if (!AppUpdate.installing && (ManagerService.failed || managerDown())) startManager(); });
        root.addView(splash, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        sillyTavern = new FrameLayout(this);
        sillyTavern.setBackgroundColor(Color.BLACK);
        sillyTavern.setVisibility(View.GONE);
        root.addView(sillyTavern, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        ChatBubbles.createChannel(this);

        // Back from letting the app install its update, which ended the app:
        // the update goes on from onResume, and the manager is started by the
        // new version instead of here.
        if (AppUpdate.resuming(this)) return;
        // A manager already running was started after this screen was passed.
        if (!ManagerService.running && Permissions.shouldAsk(this)) {
            permissions = new PermissionsScreen(this, this::permissionsDone);
            root.addView(permissions, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            return;
        }
        startManager();
        handle(getIntent());
    }

    private void permissionsDone() {
        root.removeView(permissions);
        permissions = null;
        startManager();
        handle(getIntent());
        // onResume ran while this screen was up, and left the watch to now.
        handler.removeCallbacks(watch);
        if (resumed) handler.postDelayed(watch, 1500);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] names, int[] results) {
        super.onRequestPermissionsResult(requestCode, names, results);
        if (permissions != null) permissions.refresh();
    }

    /** Not running, or stopped from the notification and on its way down. */
    private static boolean managerDown() {
        return !ManagerService.running || ManagerService.stopped;
    }

    /**
     * The manager is gone, so the pages it served are too: the console, and
     * SillyTavern, which it ran. Both are made again once it is back.
     */
    private void dropConsole() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        if (showingSillyTavern) closeSillyTavern();
        SillyTavernHost.reset();
        splash.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    /** Opened for SillyTavern, or for one chat in it: a notification pressed, a conversation shortcut. */
    private void handle(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra(EXTRA_URL);
        String key = intent.getStringExtra(ChatBubbles.EXTRA_KEY);
        if (url == null && key == null) return;
        openSillyTavern(url);
        if (key != null) {
            String chat = intent.getStringExtra(ChatBubbles.EXTRA_CHAT);
            SillyTavernHost.whenReady(() -> SillyTavernHost.openChat(key, chat, this::opened));
        }
    }

    private void opened(String problem) {
        if ("busy".equals(problem)) Toast.makeText(this, R.string.bubble_busy, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        inFront = true;
        if (permissions != null) {
            // Back from one of the settings it opened.
            permissions.refresh();
            return;
        }
        // Back from Android's switch that lets the app install its update.
        AppUpdate.resumed(this);
        // Coming back to the app is asking for it: a manager stopped from the
        // notification, or one that ended on its own, starts again. One still
        // starting - this screen has just asked for it - is left to start, and
        // one stopped for an update is started by the update if it does not go in.
        if (AppUpdate.installing) {
            if (web != null && managerDown()) dropConsole();
            poll();
        } else if (ManagerService.stopped || ManagerService.failed || (web != null && !ManagerService.running)) {
            dropConsole();
            startManager();
        } else if (web == null) {
            poll();
        }
        // Back from a bubble that had SillyTavern: it comes back here.
        if (showingSillyTavern) SillyTavernHost.attach(this, sillyTavern);
        updateWatching();
        handler.removeCallbacks(watch);
        handler.postDelayed(watch, 1500);
    }

    @Override
    protected void onPause() {
        resumed = false;
        handler.removeCallbacks(watch);
        updateWatching();
        polling = false;
        // The session cookie is what keeps the console signed in the next time
        // the app opens; WebView writes cookies to disk only now and then, and
        // an app swiped away before that loses the sign-in.
        CookieManager.getInstance().flush();
        super.onPause();
    }

    private void updateWatching() {
        inFront = resumed;
        watching = resumed && showingSillyTavern;
    }

    /** Lay SillyTavern over the console: {@code url} when the console asked for it, else the page there is. */
    void openSillyTavern(String url) {
        showingSillyTavern = true;
        sillyTavern.setVisibility(View.VISIBLE);
        if (url != null) {
            SillyTavernHost.load(this, url);
        } else if (!SillyTavernHost.hasPage()) {
            SillyTavernHost.loadWhenUp(this, SillyTavernHost.lastUrl(this), () -> {
                Toast.makeText(this, R.string.sillytavern_unavailable, Toast.LENGTH_LONG).show();
                closeSillyTavern();
            });
        }
        SillyTavernHost.attach(this, sillyTavern);
        updateWatching();
    }

    /** Back to the console. SillyTavern keeps running behind it. */
    void closeSillyTavern() {
        showingSillyTavern = false;
        sillyTavern.setVisibility(View.GONE);
        SillyTavernHost.detach(this);
        updateWatching();
    }

    @Override
    public void pageLost(String url) {
        if (showingSillyTavern) openSillyTavern(url);
    }

    private void startManager() {
        ManagerService.failed = false;
        ManagerService.stopped = false;
        Intent intent = new Intent(this, ManagerService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
        spinner.setVisibility(View.VISIBLE);
        poll();
    }

    /** Wait for the console to answer, saying what the service is doing meanwhile. */
    private void poll() {
        if (polling) return;
        polling = true;
        new Thread(() -> {
            while (polling) {
                int port = ManagerService.port;
                // One that was stopped can still answer while it shuts down.
                if (ManagerService.running && !ManagerService.stopped && ManagerService.answers(port)) {
                    handler.post(() -> { polling = false; showConsole(port); });
                    return;
                }
                boolean updating = AppUpdate.installing;
                boolean stopped = ManagerService.stopped && !updating;
                String text = updating ? getString(R.string.status_updating)
                    : stopped ? getString(R.string.status_stopped)
                    : ManagerService.status.isEmpty() ? getString(R.string.status_waiting) : ManagerService.status;
                boolean idle = (ManagerService.failed || stopped) && !updating;
                handler.post(() -> {
                    statusView.setText(idle ? text + "\n\n" + getString(R.string.status_restart) : text);
                    spinner.setVisibility(idle ? View.GONE : View.VISIBLE);
                });
                try { Thread.sleep(600); } catch (InterruptedException e) { return; }
            }
        }, "stm-poll").start();
    }

    private void showConsole(int port) {
        if (web != null) return;
        web = new WebView(this);
        Browser.configure(web);
        // The console asks for chat bubbles and for SillyTavern through this; see ChatBridge.
        String bridgeScript = ChatBridge.attach(getApplicationContext(), web);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // A WebView too old to add the script to every page gets it here, top frame only.
                if (bridgeScript != null && Browser.isLocal(Uri.parse(url))) view.evaluateJavascript(bridgeScript, null);
            }

            /*
             * The pages' shared process died: most often Android taking its
             * memory back while the app was out of sight. Left unhandled, a
             * WebView's renderer dying ends the whole app - and with it the
             * manager and SillyTavern, its child processes. Only the console
             * goes; it is made again when the screen is next shown.
             */
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                android.util.Log.w("STM", "the console's page stopped; it will be opened again");
                if (view == web) {
                    root.removeView(web);
                    web.destroy();
                    web = null;
                    splash.setVisibility(View.VISIBLE);
                    if (resumed) poll();
                }
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!Browser.isLocal(uri)) {
                    Browser.openOutside(MainActivity.this, uri);
                    return true;
                }
                // Anything on this phone but the console is SillyTavern, or the
                // door in front of it: the app's one SillyTavern page shows it.
                if (uri.getPort() != ManagerService.port) {
                    openSillyTavern(uri.toString());
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingUpload != null) pendingUpload.onReceiveValue(null);
                pendingUpload = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    pendingUpload = null;
                    return false;
                }
                return true;
            }
        });
        // Under SillyTavern's layer, which may already be showing.
        root.addView(web, 1, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        splash.setVisibility(View.GONE);
        web.loadUrl("http://127.0.0.1:" + port + "/");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (SillyTavernHost.onActivityResult(requestCode, resultCode, data)) return;
        if (BackupImport.onActivityResult(this, requestCode, resultCode, data)) return;
        if (requestCode == FILE_CHOOSER && pendingUpload != null) {
            pendingUpload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingUpload = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (showingSillyTavern) {
            closeSillyTavern();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // Leaving keeps the manager running; the notification's Stop ends it.
        moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        polling = false;
        // SillyTavern lives on without this screen; only the console goes.
        SillyTavernHost.detach(this);
        if (current == this) current = null;
        watching = false;
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
