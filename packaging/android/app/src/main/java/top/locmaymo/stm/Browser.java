package top.locmaymo.stm;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the app's two WebViews - the console, and SillyTavern - have in common:
 * how they are set up, what stays in the app and what goes to the phone's
 * browser, and how a download is saved.
 */
final class Browser {
    private Browser() {}

    static void configure(WebView web) {
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
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> download(web.getContext(), url, userAgent, contentDisposition, mimeType));
    }

    static boolean isLocal(Uri uri) {
        String host = uri.getHost();
        return "127.0.0.1".equals(host) || "localhost".equals(host);
    }

    /** Whatever is not served on this phone: a tunnel address, a sign-in, a link in a chat. */
    static void openOutside(Context context, Uri uri) {
        try {
            context.startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException ignored) {
            // Nothing on the phone opens it; stay put.
        }
    }

    /** Backups and exports; saved through the system's downloader with this session's cookie. */
    static void download(Context context, String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) {
            Toast.makeText(context, R.string.download_unsupported, Toast.LENGTH_LONG).show();
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
        ((DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(request);
        Toast.makeText(context, R.string.download_started, Toast.LENGTH_SHORT).show();
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
}
