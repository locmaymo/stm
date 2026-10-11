package top.locmaymo.stm;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * A backup zip on the phone, sent to the manager by the app rather than by
 * the console's page.
 *
 * The page sends a file four megabytes at a time, each piece read through the
 * WebView and posted on its own; a ten-gigabyte zip is two and a half thousand
 * round trips. The file is already on this phone, so the app reads it and
 * sends it to the manager here in large pieces, through the same upload the
 * page uses - its session, its CSRF token, its chunks and its finish - and
 * hands the answer back to the page, which then asks how to restore it as it
 * does for any upload. A chunk that breaks off is sent again from where the
 * manager has it, rather than the whole file (see {@link #sendAll}).
 *
 * One import at a time. Everything the page hears arrives as {@code {type:
 * "import", state: ...}}: picked, progress, done with the finish's answer,
 * canceled, or failed.
 */
final class BackupImport {
    private static final String TAG = "STM";
    static final int PICK = 12;
    /** Large enough that round trips stop mattering, small enough for the manager's per-chunk bound. */
    private static final int CHUNK_BYTES = 32 * 1024 * 1024;
    private static final int BUFFER_BYTES = 1024 * 1024;
    private static final long PROGRESS_EVERY_MS = 250;
    /** Tries at a chunk that broke off before the import gives up; the wait doubles from a second. */
    private static final int RETRIES = 5;
    private static final long RETRY_FIRST_MS = 1000;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static JavaScriptReplyProxy page;
    private static String origin;
    private static String csrf;
    private static volatile boolean canceled;
    private static volatile boolean running;

    private BackupImport() {}

    /** The console asked to import a zip: ask the reader which one. */
    static void pick(Activity activity, Uri from, String token, JavaScriptReplyProxy reply) {
        if (running) {
            tell(reply, message("failed", "code", "upload_busy"));
            return;
        }
        page = reply;
        origin = from.getScheme() + "://" + from.getAuthority();
        csrf = token;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/zip", "application/x-zip-compressed", "application/octet-stream" });
        try {
            activity.startActivityForResult(intent, PICK);
        } catch (ActivityNotFoundException e) {
            tell(page, message("failed", "message", "No file picker on this phone"));
        }
    }

    static void cancel() {
        canceled = true;
    }

    /** Forwarded from the activity that started the picker. */
    static boolean onActivityResult(Context context, int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK) return false;
        Uri uri = resultCode == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            tell(page, message("canceled"));
            return true;
        }
        Context app = context.getApplicationContext();
        running = true;
        canceled = false;
        new Thread(() -> {
            try {
                upload(app, uri);
            } finally {
                running = false;
            }
        }, "stm-import").start();
        return true;
    }

    private static void upload(Context app, Uri uri) {
        String name = "backup.zip";
        long size = -1;
        try (Cursor cursor = app.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (!cursor.isNull(0)) name = cursor.getString(0);
                if (!cursor.isNull(1)) size = cursor.getLong(1);
            }
        } catch (RuntimeException ignored) {
            // A provider that will not say: the name stays generic and the size is counted.
        }
        tell(page, message("picked", "name", name, "size", size));
        String uploadId = UUID.randomUUID().toString();
        try {
            long sent = sendAll(app, uri, uploadId, size);
            if (sent == 0) throw new IOException("The file is empty");
            tell(page, message("progress", "sent", sent, "total", size));
            HttpURLConnection finish = open("/api/v1/backups/import/finish", "POST");
            finish.setRequestProperty("content-type", "application/json");
            byte[] body = new JSONObject().put("uploadId", uploadId).put("name", name).put("expectedBytes", sent).toString().getBytes(StandardCharsets.UTF_8);
            finish.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = finish.getOutputStream()) { out.write(body); }
            int status = finish.getResponseCode();
            tell(page, message("done", "status", status, "body", read(finish)));
        } catch (CanceledException e) {
            discard(uploadId);
            tell(page, message("canceled"));
        } catch (IOException | JSONException | SecurityException | UploadException e) {
            Log.w(TAG, "a backup import failed", e);
            discard(uploadId);
            tell(page, e instanceof UploadException
                ? message("failed", "message", e.getMessage(), "status", ((UploadException) e).status, "body", ((UploadException) e).body)
                : message("failed", "message", String.valueOf(e.getMessage())));
        }
    }

    /**
     * Send the whole file, in chunks, and say how many bytes that was.
     *
     * A chunk that breaks off - the file's provider failing a read, the
     * manager restarting - is rolled back by the manager. This asks it where
     * to carry on from, opens the file again at that point and goes on, a few
     * times, waiting longer each time. A refusal is not retried.
     */
    private static long sendAll(Context app, Uri uri, String uploadId, long size) throws IOException, UploadException, CanceledException {
        int failures = 0;
        while (true) {
            try {
                long from = 0;
                int index = 0;
                if (failures > 0) {
                    long[] at = progress(uploadId);
                    index = (int) at[0];
                    from = at[1];
                }
                return sendFrom(app, uri, uploadId, from, index, size);
            } catch (IOException | UploadException e) {
                if (e instanceof UploadException && ((UploadException) e).status < 500) throw e;
                if (++failures > RETRIES) throw e;
                Log.w(TAG, "a backup import broke off; trying again (" + failures + "/" + RETRIES + ")", e);
                pause(RETRY_FIRST_MS << (failures - 1));
            }
        }
    }

    /** Send the file from byte {@code from} on, as chunks numbered from {@code first}. */
    private static long sendFrom(Context app, Uri uri, String uploadId, long from, int first, long size) throws IOException, UploadException, CanceledException {
        long sent = from;
        try (InputStream in = app.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("The file could not be opened");
            skipFully(in, from);
            byte[] buffer = new byte[BUFFER_BYTES];
            // Read a buffer ahead, so the end of the file is known before its last chunk goes.
            int pending = readFully(in, buffer);
            long lastTold = 0;
            for (int index = first; pending > 0; index++) {
                if (canceled) throw new CanceledException();
                HttpURLConnection connection = open("/api/v1/backups/import/chunk?uploadId=" + uploadId + "&index=" + index, "POST");
                connection.setRequestProperty("content-type", "application/octet-stream");
                connection.setChunkedStreamingMode(BUFFER_BYTES);
                int chunk = 0;
                try (OutputStream out = connection.getOutputStream()) {
                    while (pending > 0 && chunk + pending <= CHUNK_BYTES) {
                        if (canceled) throw new CanceledException();
                        out.write(buffer, 0, pending);
                        chunk += pending;
                        sent += pending;
                        pending = readFully(in, buffer);
                        long now = System.currentTimeMillis();
                        if (now - lastTold >= PROGRESS_EVERY_MS) {
                            lastTold = now;
                            tell(page, message("progress", "sent", sent, "total", size));
                        }
                    }
                }
                expectOk(connection);
            }
        }
        return sent;
    }

    /** Where the manager has the upload up to: {next chunk, bytes held}; {0, 0} when it holds none of it. */
    private static long[] progress(String uploadId) throws IOException, UploadException {
        HttpURLConnection connection = open("/api/v1/backups/import/chunk?uploadId=" + uploadId, "GET");
        int status = connection.getResponseCode();
        String body = read(connection);
        if (status == 404) return new long[] { 0, 0 };
        if (status < 200 || status >= 300) throw new UploadException(status, body);
        try {
            JSONObject answer = new JSONObject(body);
            return new long[] { answer.getLong("nextIndex"), answer.getLong("bytes") };
        } catch (JSONException e) {
            throw new IOException("The manager's answer about the upload could not be read", e);
        }
    }

    /** Wait before trying again, as long as nobody stops the import meanwhile. */
    private static void pause(long ms) throws CanceledException {
        long until = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < until) {
            if (canceled) throw new CanceledException();
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new CanceledException();
            }
        }
    }

    /** Move {@code in} on by {@code bytes}, reading through it where it will not skip. */
    private static void skipFully(InputStream in, long bytes) throws IOException {
        long left = bytes;
        byte[] scratch = null;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped > 0) {
                left -= skipped;
                continue;
            }
            if (scratch == null) scratch = new byte[BUFFER_BYTES];
            int read = in.read(scratch, 0, (int) Math.min(scratch.length, left));
            if (read < 0) throw new IOException("The file is shorter than what was already sent");
            left -= read;
        }
    }

    /** Fill {@code buffer} from {@code in} as far as the file goes; 0 at its end. */
    private static int readFully(InputStream in, byte[] buffer) throws IOException {
        int filled = 0;
        while (filled < buffer.length) {
            int read = in.read(buffer, filled, buffer.length - filled);
            if (read < 0) break;
            filled += read;
        }
        return filled;
    }

    /** The page's own sign-in: the session cookie the WebView holds, and its CSRF token. */
    private static HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10 * 60 * 1000);
        String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie != null) connection.setRequestProperty("cookie", cookie);
        if (csrf != null) connection.setRequestProperty("x-csrf-token", csrf);
        connection.setRequestProperty("accept", "application/json");
        // Only a POST has a body; a GET given one is sent as a POST.
        connection.setDoOutput("POST".equals(method));
        return connection;
    }

    private static void expectOk(HttpURLConnection connection) throws IOException, UploadException {
        int status = connection.getResponseCode();
        String body = read(connection);
        if (status < 200 || status >= 300) throw new UploadException(status, body);
    }

    /** Throw away what the manager holds of an upload that will not finish. */
    private static void discard(String uploadId) {
        try {
            HttpURLConnection connection = open("/api/v1/backups/import/chunk?uploadId=" + uploadId, "DELETE");
            connection.getResponseCode();
            connection.disconnect();
        } catch (IOException ignored) {
            // The manager sweeps abandoned uploads at its next start.
        }
    }

    private static String read(HttpURLConnection connection) throws IOException {
        InputStream in = connection.getResponseCode() >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (in == null) return "";
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** {@code {type: "import", state}}, with each name and value of {@code pairs} after it. */
    private static JSONObject message(String state, Object... pairs) {
        try {
            JSONObject message = new JSONObject().put("type", "import").put("state", state);
            for (int index = 0; index + 1 < pairs.length; index += 2) message.put((String) pairs[index], pairs[index + 1]);
            return message;
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Tell the page, on the main thread where its channel lives. */
    private static void tell(JavaScriptReplyProxy reply, JSONObject message) {
        if (reply == null) return;
        String text = message.toString();
        main.post(() -> {
            try {
                reply.postMessage(text);
            } catch (IllegalStateException gone) {
                // The page went away; the import carries on and its zip lands in the library.
            }
        });
    }

    private static final class CanceledException extends Exception {}

    private static final class UploadException extends Exception {
        final int status;
        final String body;

        UploadException(int status, String body) {
            super("The manager refused the upload (" + status + ")");
            this.status = status;
            this.body = body;
        }
    }
}
