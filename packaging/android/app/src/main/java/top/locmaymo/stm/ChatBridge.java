package top.locmaymo.stm;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;

/**
 * What the pages in the app's WebViews may say to the app, and the one script
 * the app adds to them.
 *
 * Pages get an object named {@code STMApp}. SillyTavern's page, through
 * chat_bridge.js, says when it is up, reports finished replies and switches
 * chats when a bubble asks; the console asks and sets whether replies are
 * notified and whether they bubble, and asks for SillyTavern to be shown.
 * Only pages served on this phone are listened to: a frame from anywhere else
 * - a picture or a video a character card embeds, say - also gets the object,
 * and everything it sends is dropped.
 */
final class ChatBridge {
    private static final String TAG = "STM";
    private static final String NAME = "STMApp";
    /** Every origin: the console, the door and SillyTavern each have a port that is chosen at run time. */
    private static final Set<String> ANY_ORIGIN = Collections.singleton("*");

    private ChatBridge() {}

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    /**
     * Give the WebView the channel and the script, before it loads anything.
     * Returns the script when the WebView cannot add it to every page itself,
     * for the caller to run as each page finishes loading; null otherwise.
     */
    static String attach(Context app, WebView web) {
        if (!supported()) return null;
        WebViewCompat.addWebMessageListener(web, NAME, ANY_ORIGIN, (view, message, origin, mainFrame, reply) -> receive(app, view, message, origin, reply));
        String script = script(app);
        if (script == null) return null;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Every frame too, so SillyTavern inside the tools window is covered.
            WebViewCompat.addDocumentStartJavaScript(web, script, ANY_ORIGIN);
            return null;
        }
        return script;
    }

    private static void receive(Context app, WebView view, WebMessageCompat message, Uri origin, JavaScriptReplyProxy reply) {
        if (!local(origin) || message.getData() == null) return;
        JSONObject data;
        try {
            data = new JSONObject(message.getData());
        } catch (JSONException e) {
            return;
        }
        switch (data.optString("type")) {
            case "ready":
                if (SillyTavernHost.isHost(view)) SillyTavernHost.onReady(reply);
                break;
            case "reply":
                ChatBubbles.onReply(app, data, MainActivity.watching);
                break;
            case "opened":
                SillyTavernHost.onOpened(data);
                break;
            case "open":
                // The console's "open SillyTavern", in the app: the one page, not another.
                Uri target = Uri.parse(data.optString("url", ""));
                if ("http".equals(target.getScheme()) && Browser.isLocal(target)) MainActivity.showSillyTavern(app, target.toString());
                break;
            case "bubbles":
                if (data.has("replies")) {
                    ChatBubbles.setReplies(app, data.optBoolean("replies"));
                } else if (data.has("enabled")) {
                    boolean on = data.optBoolean("enabled");
                    ChatBubbles.setEnabled(app, on);
                    // Turned on where Android keeps bubbles off: the reader is taken to the switch.
                    if (on && ChatBubbles.bubblesSupported() && !ChatBubbles.bubblesAllowed(app)) ChatBubbles.openBubbleSettings(app);
                } else if (data.optBoolean("settings")) {
                    ChatBubbles.openBubbleSettings(app);
                }
                answer(app, reply);
                break;
            default:
                break;
        }
    }

    /** What the console shows beside its switch. */
    private static void answer(Context app, JavaScriptReplyProxy reply) {
        try {
            JSONObject state = new JSONObject()
                    .put("type", "bubbles")
                    .put("replies", ChatBubbles.replies(app))
                    .put("enabled", ChatBubbles.enabled(app))
                    .put("bubbles", ChatBubbles.bubblesSupported())
                    .put("allowed", ChatBubbles.bubblesAllowed(app));
            reply.postMessage(state.toString());
        } catch (JSONException | IllegalStateException e) {
            Log.w(TAG, "the console could not be told about chat bubbles", e);
        }
    }

    private static boolean local(Uri origin) {
        return origin != null && "http".equals(origin.getScheme()) && Browser.isLocal(origin);
    }

    private static String script(Context app) {
        try (InputStream in = app.getResources().openRawResource(R.raw.chat_bridge)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            Log.w(TAG, "the chat bridge script could not be read", e);
            return null;
        }
    }
}
