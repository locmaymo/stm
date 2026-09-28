package top.locmaymo.stm;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The console, in a WebView, once the manager behind it answers.
 *
 * Until then the screen says what the service is doing - unpacking on a first
 * start takes a while - and when the manager stops unexpectedly it says so and
 * starts it again on a tap. Pages the manager serves stay in here; anything
 * else, a tunnel address or a sign-in, opens in the phone's browser.
 */
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 10;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private LinearLayout splash;
    private TextView statusView;
    private ProgressBar spinner;
    private WebView web;
    private ValueCallback<Uri[]> pendingUpload;
    private boolean polling;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
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
        splash.setOnClickListener((view) -> { if (ManagerService.failed) startManager(); });
        root.addView(splash, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        startManager();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) poll();
    }

    @Override
    protected void onPause() {
        polling = false;
        // The session cookie is what keeps the console signed in the next time
        // the app opens; WebView writes cookies to disk only now and then, and
        // an app swiped away before that loses the sign-in.
        CookieManager.getInstance().flush();
        super.onPause();
    }

    private void startManager() {
        ManagerService.failed = false;
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
                if (ManagerService.running && ManagerService.answers(port)) {
                    handler.post(() -> { polling = false; showConsole(port); });
                    return;
                }
                String text = ManagerService.status.isEmpty() ? getString(R.string.status_waiting) : ManagerService.status;
                boolean failed = ManagerService.failed;
                handler.post(() -> {
                    statusView.setText(failed ? text + "\n\n" + getString(R.string.status_restart) : text);
                    spinner.setVisibility(failed ? View.GONE : View.VISIBLE);
                });
                try { Thread.sleep(600); } catch (InterruptedException e) { return; }
            }
        }, "stm-poll").start();
    }

    private void showConsole(int port) {
        if (web != null) return;
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setSupportMultipleWindows(false);
        // The console hands Cloudflare's sign-in to the phone's browser and
        // collects the answer from the manager when it sees this; see
        // inPhoneApp in the panel's oauth.ts.
        settings.setUserAgentString(settings.getUserAgentString() + " STMAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocal(uri)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing on the phone opens it; stay put.
                }
                return true;
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
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> download(url, userAgent, contentDisposition, mimeType));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        splash.setVisibility(View.GONE);
        web.loadUrl("http://127.0.0.1:" + port + "/");
    }

    private static boolean isLocal(Uri uri) {
        String host = uri.getHost();
        return "127.0.0.1".equals(host) || "localhost".equals(host);
    }

    /** Backups and exports the console serves; saved through the system's downloader with this session's cookie. */
    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) {
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show();
            return;
        }
        String name = downloadName(url, contentDisposition, mimeType);
        DownloadManager.Request request = new DownloadManager.Request(uri)
            .setMimeType(mimeType)
            .addRequestHeader("User-Agent", userAgent)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) request.addRequestHeader("Cookie", cookies);
        ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
        Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
    }

    /**
     * The name to save a download under. Android's own guess reads only
     * `filename="…"`; the UTF-8 `filename*` the manager also sends is the real
     * name, so it is read first.
     */
    static String downloadName(String url, String contentDisposition, String mimeType) {
        if (contentDisposition != null) {
            Matcher encoded = Pattern.compile("filename\\*\\s*=\\s*UTF-8''([^;\\s]+)", Pattern.CASE_INSENSITIVE).matcher(contentDisposition);
            if (encoded.find()) {
                try {
                    String name = URLDecoder.decode(encoded.group(1).replace("+", "%2B"), "UTF-8").replaceAll("[/\\\\]", "_").trim();
                    if (!name.isEmpty()) return name;
                } catch (UnsupportedEncodingException | IllegalArgumentException ignored) {
                    // Fall back to Android's guess below.
                }
            }
        }
        return URLUtil.guessFileName(url, contentDisposition, mimeType);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
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
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
