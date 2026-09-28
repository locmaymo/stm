package top.locmaymo.stm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;

/**
 * Keeps the manager running while the app is out of sight.
 *
 * A foreground service with a notification is what Android leaves running
 * after the screen goes off or another app comes to the front; the manager and
 * the SillyTavern it starts are this service's child processes, and a partial
 * wake lock keeps them answering with the screen off. The notification's Stop
 * asks the manager to shut down the way a closed launcher window does, so
 * SillyTavern is put down properly rather than killed mid-write.
 */
public class ManagerService extends Service {
    static final String ACTION_STOP = "top.locmaymo.stm.action.STOP";
    private static final String TAG = "STM";
    private static final String CHANNEL = "manager";
    /** The manager's own notifications, apart from the one saying it runs. */
    private static final String EVENTS_CHANNEL = "events";
    /**
     * How the manager hands this app a notification: one line of its output,
     * this prefix and then the notification in words, as JSON.
     */
    private static final String NOTIFY_PREFIX = "STM-NOTIFY ";
    private static final int NOTIFICATION = 1;
    private static final int EVENT_NOTIFICATION = 2;
    static final int DEFAULT_PORT = 7860;

    /** Read by the activity: where the console is, and what is happening. */
    static volatile int port = DEFAULT_PORT;
    static volatile String status = "";
    static volatile boolean failed = false;
    static volatile boolean running = false;

    private Thread worker;
    private volatile Process process;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
            // Heard, unlike the one above: these are the things somebody wanted to know.
            NotificationChannel events = new NotificationChannel(EVENTS_CHANNEL, getString(R.string.channel_events), NotificationManager.IMPORTANCE_DEFAULT);
            getSystemService(NotificationManager.class).createNotificationChannel(events);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            new Thread(this::stopManager, "stm-stop").start();
            return START_NOT_STICKY;
        }
        // The app asks for the service every time it opens; a manager that is
        // already running keeps saying so rather than going back to "starting".
        boolean alreadyRunning = process != null;
        Notification notification = notification(getString(alreadyRunning ? R.string.notification_running : R.string.notification_starting));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION, notification);
        }
        if (worker == null || !worker.isAlive()) {
            stopping = false;
            failed = false;
            worker = new Thread(this::runManager, "stm-manager");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void runManager() {
        running = true;
        try {
            Map<String, String> env = Payload.prepare(this, this::setStatus);
            stopStaleManager();
            int chosen = freePort(DEFAULT_PORT);
            port = chosen;
            String token = randomToken();
            writeText(new File(getFilesDir(), "shutdown-token"), chosen + "\n" + token);

            setStatus(getString(R.string.status_starting));
            ProcessBuilder builder = new ProcessBuilder(Payload.nodeBinary(this).getPath(), Payload.managerEntry(this).getPath());
            builder.environment().putAll(env);
            builder.environment().put("STM_PORT", String.valueOf(chosen));
            builder.environment().put("STM_SHUTDOWN_TOKEN", token);
            builder.directory(new File(getFilesDir(), "manager"));
            builder.redirectErrorStream(true);
            acquireWakeLock();
            process = builder.start();
            updateNotification(getString(R.string.notification_running));
            pumpOutput(process);
            int code = process.waitFor();
            if (!stopping) {
                failed = true;
                setStatus(getString(R.string.status_failed, "exit code " + code));
                updateNotification(getString(R.string.notification_stopped));
            }
        } catch (Throwable error) {
            Log.e(TAG, "manager failed", error);
            failed = true;
            setStatus(getString(R.string.status_failed, String.valueOf(error.getMessage())));
        } finally {
            running = false;
            process = null;
            releaseWakeLock();
            stopForegroundCompat();
            stopSelf();
        }
    }

    /** Ask the manager to shut down, and make sure it did. */
    private void stopManager() {
        stopping = true;
        Process current = process;
        if (current != null) {
            requestShutdown(port, readToken());
            if (!exited(current, 20_000)) current.destroy();
        }
        stopForegroundCompat();
        stopSelf();
    }

    /**
     * A manager left behind by an app process Android ended is still holding
     * its port and still owns its SillyTavern. It is asked to leave with the
     * token it was started with before a new one starts.
     */
    private void stopStaleManager() {
        File file = new File(getFilesDir(), "shutdown-token");
        if (!file.exists()) return;
        String[] saved = readText(file).split("\n");
        if (saved.length < 2) return;
        int stalePort;
        try { stalePort = Integer.parseInt(saved[0].trim()); } catch (NumberFormatException e) { return; }
        if (!answers(stalePort)) return;
        requestShutdown(stalePort, saved[1].trim());
        for (int i = 0; i < 40 && answers(stalePort); i++) sleep(500);
    }

    private static void requestShutdown(int port, String token) {
        if (token == null || token.isEmpty()) return;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/v1/shutdown").openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-stm-shutdown-token", token);
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(3000);
            connection.setDoOutput(true);
            connection.getOutputStream().close();
            connection.getResponseCode();
            connection.disconnect();
        } catch (IOException ignored) {
            // Already gone, or wedged: the caller falls back to ending the process.
        }
    }

    static boolean answers(int port) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/v1/health").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1500);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code == 200;
        } catch (IOException e) {
            return false;
        }
    }

    /** 7860 unless another program on the phone holds it - Termux's manager, say. */
    private static int freePort(int from) {
        for (int candidate = from; candidate < from + 64; candidate++) {
            try (ServerSocket socket = new ServerSocket(candidate, 1, InetAddress.getByName("127.0.0.1"))) {
                return candidate;
            } catch (IOException taken) {
                // try the next one
            }
        }
        return from;
    }

    /**
     * One of the manager's notifications, as a phone notification.
     *
     * Notifications of one kind share a tag, so a second "SillyTavern stopped"
     * replaces the first rather than stacking under it. A press opens the
     * console, or the page a broadcast points at.
     */
    private void postEvent(String json) {
        try {
            JSONObject event = new JSONObject(json);
            String title = event.optString("title", getString(R.string.app_name));
            String body = event.optString("body", "");
            String tag = event.optString("tag", "event");
            String url = event.isNull("url") ? "" : event.optString("url", "");
            Intent open = url.startsWith("https://")
                    ? new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    : new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent press = PendingIntent.getActivity(this, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, EVENTS_CHANNEL)
                    : new Notification.Builder(this);
            Notification notification = builder
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setContentIntent(press)
                    .setAutoCancel(true)
                    .build();
            getSystemService(NotificationManager.class).notify(tag, EVENT_NOTIFICATION, notification);
        } catch (Exception error) {
            Log.w(TAG, "a notification from the manager could not be shown", error);
        }
    }

    private void pumpOutput(Process child) {
        File log = new File(getFilesDir(), "manager-output.log");
        Thread pump = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8));
                 PrintWriter writer = new PrintWriter(new FileOutputStream(log, false), true)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.startsWith(NOTIFY_PREFIX)) {
                        postEvent(line.substring(NOTIFY_PREFIX.length()));
                        continue;
                    }
                    Log.i(TAG, line);
                    writer.println(line);
                }
            } catch (IOException ignored) {
                // The process ended.
            }
        }, "stm-output");
        pump.setDaemon(true);
        pump.start();
    }

    private void setStatus(String text) {
        status = text;
        Log.i(TAG, "[app] " + text);
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, ManagerService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text)
            .setContentText(getString(R.string.notification_open))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, getString(R.string.action_stop), stopIntent).build())
            .build();
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text));
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    private void acquireWakeLock() {
        if (wakeLock != null) return;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stm:manager");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private String readToken() {
        String[] saved = readText(new File(getFilesDir(), "shutdown-token")).split("\n");
        return saved.length >= 2 ? saved[1].trim() : null;
    }

    private static String randomToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder text = new StringBuilder();
        for (byte value : bytes) text.append(String.format("%02x", value));
        return text.toString();
    }

    private static String readText(File file) {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] data = new byte[(int) file.length()];
            int read = in.read(data);
            return new String(data, 0, Math.max(read, 0), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File file, String text) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
    }

    /** Whether the process ends within the time given. Process.waitFor(timeout) needs Android 8. */
    private static boolean exited(Process child, long millis) {
        long deadline = System.currentTimeMillis() + millis;
        while (System.currentTimeMillis() < deadline) {
            try {
                child.exitValue();
                return true;
            } catch (IllegalThreadStateException stillRunning) {
                sleep(200);
            }
        }
        return false;
    }

    private static void sleep(long millis) {
        try { Thread.sleep(millis); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
}
