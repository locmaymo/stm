package top.locmaymo.stm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * A newer release of this app, fetched and handed to Android to install,
 * from the console's new-version card.
 *
 * The card used to link to the release page, which left the reader to find
 * the right APK in a list, download it in the browser, find it again in
 * Downloads and open it. Here the app fetches its own APK - the one built for
 * this phone's processor - checks it against the checksum the release
 * publishes beside it, and gives it to Android's installer. Android only
 * replaces an app with one signed by the same key, so nothing but a release
 * of this app can be installed this way.
 *
 * Android still asks before it installs: once, to let STM install apps at
 * all, and then for each update. The manager is stopped first, so SillyTavern
 * is not ended halfway through writing a chat when the old app goes; once the
 * new one is in, {@link UpdateReceiver} starts it again, and the installer's
 * Open button opens the app.
 *
 * Everything the page hears arrives as {@code {type: "appUpdate", state:
 * ...}}: progress, permission (Android's switch is open), installing (the
 * manager is going down and Android is asking), or failed with a {@code
 * code}.
 */
final class AppUpdate {
    private static final String TAG = "STM";
    private static final Pattern VERSION = Pattern.compile("\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final String PREFERENCES = "update";
    /** Set while an install is under way, so the new app starts the manager again. */
    private static final String RESTART = "restart";
    /**
     * The APK downloaded and checked, waiting for the reader to come back
     * from Android's switch that lets STM install apps, and since when.
     *
     * Written down rather than held in memory: turning that switch on ends
     * the app, and it is a fresh one the reader comes back to.
     */
    private static final String WAITING = "waiting";
    private static final String WAITING_SINCE = "waitingSince";
    /** Longer than anybody takes over one switch; an APK left past this is not installed by surprise later. */
    private static final long WAITING_FOR_MS = 30 * 60 * 1000;
    private static final int BUFFER_BYTES = 256 * 1024;
    private static final long PROGRESS_EVERY_MS = 250;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long STOP_WAIT_MS = 25_000;
    private static final int DONE_NOTIFICATION = 3;
    private static final long ANNOUNCE_AFTER_MS = 4000;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static JavaScriptReplyProxy page;
    private static volatile boolean running;
    private static volatile boolean canceled;
    /** The manager is down for the install; the app's splash says so rather than "stopped". */
    static volatile boolean installing;
    /** Android's installer screen is open over the app; see {@link #backFromInstaller}. */
    private static boolean installerOpen;

    private AppUpdate() {}

    /**
     * Fetch {@code version} and install it. A second request while one is
     * running - the console was reloaded, say - only moves the progress to
     * the page that asked.
     */
    static void start(Activity activity, String version, JavaScriptReplyProxy reply) {
        page = reply;
        if (running) return;
        // Asked again by a console reloaded meanwhile: it hears where things are.
        if (waiting(activity) != null) {
            send(stateOrEmpty("permission"));
            return;
        }
        if (installing) {
            send(stateOrEmpty("installing"));
            return;
        }
        if (!VERSION.matcher(version).matches() || compare(version, BuildConfig.VERSION_NAME) <= 0) {
            send(failed("notNewer"));
            return;
        }
        String abi = abi(activity);
        if (abi == null) {
            send(failed("missing"));
            return;
        }
        running = true;
        canceled = false;
        Context app = activity.getApplicationContext();
        new Thread(() -> {
            try {
                File apk = download(app, version, abi);
                if (apk == null) return;
                main.post(() -> install(activity, apk));
            } finally {
                running = false;
            }
        }, "stm-update").start();
    }

    static void cancel() {
        canceled = true;
    }

    /**
     * Back in the app: from Android's switch that lets STM install apps,
     * perhaps - in this process, or in a new one when turning it on ended
     * the last.
     */
    static void resumed(Activity activity) {
        if (backFromInstaller(activity)) return;
        File apk = waiting(activity);
        if (apk == null) return;
        setWaiting(activity, null);
        if (allowed(activity)) {
            install(activity, apk);
        } else {
            apk.delete();
            send(failed("permission"));
        }
    }

    /**
     * Whether a fresh start of the app is the reader coming back with the
     * switch on, so the update goes on instead of the manager starting only
     * to be stopped again.
     */
    static boolean resuming(Context context) {
        return waiting(context) != null && allowed(context);
    }

    private static File waiting(Context context) {
        SharedPreferences preferences = preferences(context.getApplicationContext());
        String path = preferences.getString(WAITING, null);
        if (path == null) return null;
        File apk = new File(path);
        long since = preferences.getLong(WAITING_SINCE, 0);
        if (!apk.isFile() || System.currentTimeMillis() - since > WAITING_FOR_MS) {
            setWaiting(context, null);
            apk.delete();
            return null;
        }
        return apk;
    }

    @SuppressLint("ApplySharedPref")
    private static void setWaiting(Context context, File apk) {
        SharedPreferences.Editor editor = preferences(context.getApplicationContext()).edit();
        if (apk == null) editor.remove(WAITING).remove(WAITING_SINCE);
        else editor.putString(WAITING, apk.getPath()).putLong(WAITING_SINCE, System.currentTimeMillis());
        // Now, not later: the switch this is waiting on ends the app.
        editor.commit();
    }

    /** Negative when {@code a} is the older version, positive when it is the newer; part by part. */
    static int compare(String a, String b) {
        String[] left = a.split("[.-]");
        String[] right = b.split("[.-]");
        for (int i = 0; i < 3; i++) {
            int x = i < left.length ? parse(left[i]) : 0;
            int y = i < right.length ? parse(right[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    private static int parse(String part) {
        try { return Integer.parseInt(part); } catch (NumberFormatException e) { return 0; }
    }

    /**
     * The processor this build of the app is for, as releases name their
     * APKs. Read off the folder Android installed its programs into, so it is
     * the build that is on the phone and not merely one the phone could run.
     */
    private static String abi(Context context) {
        switch (new File(context.getApplicationInfo().nativeLibraryDir).getName()) {
            case "arm64": return "arm64-v8a";
            case "x86_64": return "x86_64";
            default: return null;
        }
    }

    /** The APK in the app's cache, checked; null once the page has been told why not. */
    private static File download(Context app, String version, String abi) {
        String name = "SillyTavernManager-android-" + abi + "-v" + version + ".apk";
        String base = BuildConfig.RELEASES_URL + "/v" + version + "/" + name;
        File folder = new File(app.getCacheDir(), "update");
        File apk = new File(folder, name);
        try {
            String expected = expectedDigest(base + ".sha256");
            if (expected == null) {
                send(failed("missing"));
                return null;
            }
            deleteAll(folder);
            if (!folder.mkdirs() && !folder.isDirectory()) throw new IOException("no room for the update in the cache");
            HttpURLConnection connection = open(base);
            int code = connection.getResponseCode();
            if (code == 404) {
                connection.disconnect();
                send(failed("missing"));
                return null;
            }
            if (code != 200) throw new IOException("HTTP " + code);
            long total = connection.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long received = 0;
            long reported = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                byte[] buffer = new byte[BUFFER_BYTES];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (canceled) {
                        connection.disconnect();
                        apk.delete();
                        send(state("canceled"));
                        return null;
                    }
                    out.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    received += read;
                    long now = System.currentTimeMillis();
                    if (now - reported >= PROGRESS_EVERY_MS) {
                        reported = now;
                        send(state("progress").put("received", received).put("total", total));
                    }
                }
            } finally {
                connection.disconnect();
            }
            send(state("progress").put("received", received).put("total", total));
            if (!expected.equals(hex(digest.digest()))) {
                apk.delete();
                send(failed("checksum"));
                return null;
            }
            return apk;
        } catch (IOException | JSONException | NoSuchAlgorithmException error) {
            Log.w(TAG, "the update could not be downloaded", error);
            apk.delete();
            send(failed("network"));
            return null;
        }
    }

    /** The digest a release publishes beside its APK, in the form `sha256sum` writes. */
    private static String expectedDigest(String url) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            int code = connection.getResponseCode();
            if (code == 404) return null;
            if (code != 200) throw new IOException("HTTP " + code);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                while (bytes.size() < 4096 && (read = in.read(buffer)) > 0) bytes.write(buffer, 0, read);
            }
            String text = new String(bytes.toByteArray(), StandardCharsets.UTF_8).trim();
            String first = text.isEmpty() ? "" : text.split("\\s+")[0].toLowerCase(Locale.ROOT);
            if (!SHA256.matcher(first).matches()) throw new IOException("the release's checksum file is not one");
            return first;
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "STMAndroid/" + BuildConfig.VERSION_NAME);
        return connection;
    }

    private static boolean allowed(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
    }

    /**
     * Hand the APK to Android's installer screen. Where STM may not install
     * apps yet, the reader is taken to the switch first, and this goes on
     * when they are back (see {@link #resumed}).
     *
     * The installer screen rather than an install session the app runs
     * itself: Android ends the app to replace it, and an app may not open
     * itself from the background afterwards, so a session leaves the reader
     * on the home screen. The installer's own screen outlives the app and
     * ends on "App installed" with an Open button.
     */
    private static void install(Activity activity, File apk) {
        if (!allowed(activity)) {
            setWaiting(activity, apk);
            send(stateOrEmpty("permission"));
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
            } catch (RuntimeException error) {
                Log.w(TAG, "Android's install switch could not be opened", error);
                setWaiting(activity, null);
                apk.delete();
                send(failed("permission"));
            }
            return;
        }
        send(stateOrEmpty("installing"));
        installing = true;
        Context app = activity.getApplicationContext();
        preferences(app).edit().putBoolean(RESTART, true).apply();
        // Down before Android ends this app, rather than cut off by it.
        app.startService(new Intent(app, ManagerService.class).setAction(ManagerService.ACTION_STOP));
        new Thread(() -> {
            long until = System.currentTimeMillis() + STOP_WAIT_MS;
            while (ManagerService.running && System.currentTimeMillis() < until) {
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
            main.post(() -> openInstaller(activity, apk));
        }, "stm-install").start();
    }

    @SuppressWarnings("deprecation")
    private static void openInstaller(Activity activity, File apk) {
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                .setData(UpdateFiles.uri(activity, apk))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            installerOpen = true;
            activity.startActivity(intent);
        } catch (RuntimeException error) {
            installerOpen = false;
            Log.w(TAG, "Android's installer could not be opened", error);
            installFailed(activity, String.valueOf(error.getMessage()));
        }
    }

    /**
     * Back from the installer, in the same app: had the update gone in,
     * Android would have ended this one. The reader said no, or the install
     * failed and the installer said why; the manager starts again.
     */
    private static boolean backFromInstaller(Context context) {
        if (!installerOpen) return false;
        installerOpen = false;
        installFailed(context, null);
        return true;
    }

    /** Not installed: the manager starts again, and the reader hears why unless they chose it. */
    private static void installFailed(Context context, String message) {
        installing = false;
        Context app = context.getApplicationContext();
        preferences(app).edit().remove(RESTART).apply();
        deleteAll(new File(app.getCacheDir(), "update"));
        startManager(app);
        if (message != null) Toast.makeText(app, app.getString(R.string.update_failed, message), Toast.LENGTH_LONG).show();
    }

    /**
     * This app was just replaced. When STM did it, the manager it stopped
     * starts again. The installer's Open button is the way back in; for a
     * reader who pressed Done instead, a notification says the update went in
     * and opens the app.
     */
    static void replaced(Context context) {
        Context app = context.getApplicationContext();
        deleteAll(new File(app.getCacheDir(), "update"));
        SharedPreferences preferences = preferences(app);
        if (!preferences.getBoolean(RESTART, false)) return;
        preferences.edit().remove(RESTART).apply();
        startManager(app);
        // Long enough for the app to have come up, if it is coming.
        main.postDelayed(() -> {
            if (!MainActivity.inFront) announce(app);
        }, ANNOUNCE_AFTER_MS);
    }

    private static void announce(Context app) {
        try {
            Intent open = new Intent(app, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent press = PendingIntent.getActivity(app, DONE_NOTIFICATION, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(app, ManagerService.EVENTS_CHANNEL)
                    : new Notification.Builder(app);
            Notification notification = builder
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(app.getString(R.string.update_done, BuildConfig.VERSION_NAME))
                    .setContentText(app.getString(R.string.update_done_open))
                    .setContentIntent(press)
                    .setAutoCancel(true)
                    .build();
            app.getSystemService(NotificationManager.class).notify(DONE_NOTIFICATION, notification);
        } catch (RuntimeException error) {
            Log.w(TAG, "the update could not be announced", error);
        }
    }

    private static void startManager(Context app) {
        ManagerService.failed = false;
        ManagerService.stopped = false;
        Intent service = new Intent(app, ManagerService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(service);
            else app.startService(service);
        } catch (RuntimeException error) {
            // Android would not let it start from here; opening the app will.
            Log.w(TAG, "the manager could not be started after the update", error);
        }
    }

    private static SharedPreferences preferences(Context app) {
        return app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static void deleteAll(File folder) {
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) file.delete();
        folder.delete();
    }

    private static JSONObject state(String state) throws JSONException {
        return new JSONObject().put("type", "appUpdate").put("state", state);
    }

    private static JSONObject stateOrEmpty(String name) {
        try {
            return state(name);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONObject failed(String code) {
        try {
            return state("failed").put("code", code);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static void send(JSONObject message) {
        String text = message.toString();
        main.post(() -> {
            JavaScriptReplyProxy target = page;
            if (target == null) return;
            try {
                target.postMessage(text);
            } catch (IllegalStateException e) {
                // The page that asked is gone; a reloaded console asks again.
                page = null;
            }
        });
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }
}
