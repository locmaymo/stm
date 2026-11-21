package top.locmaymo.stm;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentProviderClient;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.OperationCanceledException;
import android.os.RemoteException;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.CookieManager;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

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
 * A zip picked from a cloud drive is not on this phone yet: its provider
 * fetches all of it before the app gets its first byte, which for gigabytes
 * is a long wait with nothing to show. The page is told what was picked as
 * soon as it is, so it can say what the wait is; stopping hands the provider
 * a cancel and answers the page at once, without waiting for the provider to
 * let go.
 *
 * The same upload carries a SillyTavern moved over from Termux, zipped while
 * it is read (see {@link TermuxImport}).
 *
 * One import at a time. Everything the page hears arrives as {@code {type:
 * "import", state: ...}}: picked, progress, and then exactly one of done with
 * the finish's answer, canceled, or failed - with a {@code code} where the
 * page has words for it. Every import ends in one of those three, so the page
 * never waits on one that went quiet.
 */
final class BackupImport {
    private static final String TAG = "STM";
    static final int PICK = 12;
    static final int PICK_TERMUX = 13;
    /** Large enough that round trips stop mattering, small enough for the manager's per-chunk bound. */
    private static final int CHUNK_BYTES = 32 * 1024 * 1024;
    private static final int BUFFER_BYTES = 1024 * 1024;
    private static final long PROGRESS_EVERY_MS = 250;
    /** Tries at a chunk that broke off before the import gives up; the wait doubles from a second. */
    private static final int RETRIES = 5;
    private static final long RETRY_FIRST_MS = 1000;

    private static final Handler main = new Handler(Looper.getMainLooper());
    /** Asked for, with the picker open; it runs once something is picked. */
    private static Job asked;
    /** The import running now, until the page has heard how it ended. */
    private static Job running;

    private BackupImport() {}

    /**
     * One import: the page that asked, with its sign-in, and whether it was
     * stopped. A stopped import's thread may stay stuck in its file's
     * provider for a while; it keeps its own state, so the next import does
     * not inherit it.
     */
    private static final class Job {
        final JavaScriptReplyProxy page;
        final String origin;
        final String csrf;
        /** Handed to the file's provider, which may be fetching the whole file first. */
        final CancellationSignal signal = new CancellationSignal();
        volatile boolean canceled;
        /** Every byte is out and the manager is taking the file in; stopping no longer ends it. */
        volatile boolean finishing;
        private final AtomicBoolean ended = new AtomicBoolean();

        Job(Uri from, String token, JavaScriptReplyProxy reply) {
            page = reply;
            origin = from.getScheme() + "://" + from.getAuthority();
            csrf = token;
        }

        /** Tell the page how far it is, until it has heard how it ended. */
        void tell(JSONObject message) {
            if (!ended.get()) BackupImport.tell(page, message);
        }

        /** Tell the page how it ended, once, and make room for the next import. */
        void end(JSONObject message) {
            if (!ended.compareAndSet(false, true)) return;
            BackupImport.tell(page, message);
            synchronized (BackupImport.class) {
                if (running == this) running = null;
            }
        }
    }

    /**
     * What an import sends: a zip the reader picked, or one made as it is
     * read.
     */
    interface Source {
        /** The name the zip gets in the backup library. */
        String name();

        /** How much {@link #read} will come to; -1 when nobody can say. */
        long size();

        /** The zip from its first byte. */
        InputStream open() throws IOException;

        /**
         * Whether it can be opened again and comes out the same, so a chunk
         * that broke off is sent again from where the manager has it. A zip
         * made while it is read is not: its bytes are only what they were
         * that time.
         */
        boolean resumable();

        /** How far along it is, in the units of {@link #size}, once {@code sent} bytes are out. */
        long read(long sent);
    }

    /** The console asked to import a zip: ask the reader which one. */
    static void pick(Activity activity, Uri from, String token, JavaScriptReplyProxy reply) {
        if (!begin(from, token, reply)) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/zip", "application/x-zip-compressed", "application/octet-stream" });
        try {
            activity.startActivityForResult(intent, PICK);
        } catch (ActivityNotFoundException e) {
            tell(reply, message("failed", "message", "No file picker on this phone"));
        }
    }

    /**
     * The console asked to move a SillyTavern over from Termux: ask the
     * reader for Termux's folder; see {@link TermuxImport}.
     */
    static void pickTermux(Activity activity, Uri from, String token, JavaScriptReplyProxy reply) {
        if (!begin(from, token, reply)) return;
        if (!TermuxImport.present(activity)) {
            tell(reply, message("failed", "code", "termux_missing", "message", "Termux is not on this phone"));
            return;
        }
        try {
            activity.startActivityForResult(TermuxImport.pickIntent(), PICK_TERMUX);
        } catch (ActivityNotFoundException e) {
            tell(reply, message("failed", "message", "No folder picker on this phone"));
        }
    }

    /**
     * An import was asked for where the app cannot run one: no screen to
     * open the picker from, or a page that is not the console. Said rather
     * than left unanswered, so the page does not wait on it.
     */
    static void unavailable(JavaScriptReplyProxy reply) {
        tell(reply, message("failed", "message", "The app cannot import from here"));
    }

    /** Keep the page's channel and sign-in for the import about to start; false while one runs. */
    private static synchronized boolean begin(Uri from, String token, JavaScriptReplyProxy reply) {
        if (running != null) {
            tell(reply, message("failed", "code", "upload_busy"));
            return false;
        }
        asked = new Job(from, token, reply);
        return true;
    }

    /**
     * The page pressed Stop. The page hears it at once and the next import
     * can start; the import's thread notices on its own and throws away what
     * the manager holds of it. Once every byte is out the manager finishes
     * the file anyway, so a stop then changes nothing.
     */
    static void cancel() {
        Job job;
        synchronized (BackupImport.class) {
            job = running;
        }
        if (job == null || job.finishing) return;
        job.canceled = true;
        job.signal.cancel();
        job.end(message("canceled"));
    }

    /** Forwarded from the activity that started the picker. */
    static boolean onActivityResult(Context context, int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK && requestCode != PICK_TERMUX) return false;
        Job job;
        synchronized (BackupImport.class) {
            job = asked;
            asked = null;
            if (job == null) return true;
            if (running != null) {
                tell(job.page, message("failed", "code", "upload_busy"));
                return true;
            }
            Uri uri = resultCode == Activity.RESULT_OK && data != null ? data.getData() : null;
            if (uri == null) {
                tell(job.page, message("canceled"));
                return true;
            }
            running = job;
            start(context.getApplicationContext(), job, uri, requestCode == PICK_TERMUX);
        }
        return true;
    }

    private static void start(Context app, Job job, Uri uri, boolean termux) {
        new Thread(() -> {
            try {
                if (!termux) {
                    upload(job, picked(app, uri, job.signal));
                    return;
                }
                Source source;
                try {
                    source = TermuxImport.source(app, uri, () -> job.canceled);
                } catch (TermuxImport.NotFoundException e) {
                    job.end(message("failed", "code", e.code, "message", String.valueOf(e.getMessage())));
                    return;
                } catch (IOException e) {
                    if (job.canceled) return;
                    Log.w(TAG, "the Termux folder could not be read", e);
                    job.end(message("failed", "message", String.valueOf(e.getMessage())));
                    return;
                }
                if (upload(job, source)) TermuxImport.answerOffer(app);
            } catch (RuntimeException e) {
                // A provider that broke in a way nobody named: the page still hears of it.
                if (!job.canceled) Log.w(TAG, "a backup import stopped", e);
                job.end(job.canceled ? message("canceled") : message("failed", "message", String.valueOf(e.getMessage())));
            } finally {
                // Already told in every way it can end; this only makes sure the slot is free.
                job.end(message("canceled"));
            }
        }, "stm-import").start();
    }

    /**
     * A zip the reader picked: what its provider says it is called and how
     * big it is. Opening it goes through {@code signal}, so a provider still
     * fetching it from a cloud drive is told to stop when the import is.
     */
    private static Source picked(Context app, Uri uri, CancellationSignal signal) {
        String name = "backup.zip";
        long size = -1;
        try (Cursor cursor = app.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null, signal)) {
            if (cursor != null && cursor.moveToFirst()) {
                // By name: a provider may answer with its own columns, in its own order.
                int nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameAt >= 0 && !cursor.isNull(nameAt)) name = cursor.getString(nameAt);
                if (sizeAt >= 0 && !cursor.isNull(sizeAt)) size = cursor.getLong(sizeAt);
            }
        } catch (OperationCanceledException e) {
            throw e;
        } catch (RuntimeException ignored) {
            // A provider that will not say: the name stays generic and the size is counted.
        }
        String shownName = name;
        long shownSize = size;
        return new Source() {
            @Override public String name() { return shownName; }
            @Override public long size() { return shownSize; }
            @Override public InputStream open() throws IOException {
                // Asked of the provider itself: the resolver's own read-only
                // open goes through a typed open that leaves the cancel behind.
                ContentProviderClient client = app.getContentResolver().acquireUnstableContentProviderClient(uri);
                if (client == null) throw new FileNotFoundException("No app holds the file any more");
                boolean handedOver = false;
                try {
                    AssetFileDescriptor file = client.openAssetFile(uri, "r", signal);
                    if (file == null) throw new IOException("The file could not be opened");
                    InputStream in = file.createInputStream();
                    handedOver = true;
                    // The provider stays held while its file is read, as the resolver's open does.
                    return new FilterInputStream(in) {
                        @Override public void close() throws IOException {
                            try { super.close(); } finally { client.close(); }
                        }
                    };
                } catch (RemoteException e) {
                    throw new IOException("The app holding the file stopped", e);
                } finally {
                    if (!handedOver) client.close();
                }
            }
            @Override public boolean resumable() { return true; }
            @Override public long read(long sent) { return sent; }
        };
    }

    /** Send {@code source} and finish the upload; true when the manager took it. */
    private static boolean upload(Job job, Source source) {
        String name = source.name();
        long size = source.size();
        job.tell(message("picked", "name", name, "size", size));
        String uploadId = UUID.randomUUID().toString();
        try {
            long sent = sendAll(job, source, uploadId);
            if (sent == 0) throw new IOException("The file is empty");
            job.tell(message("progress", "sent", source.read(sent), "total", size));
            job.finishing = true;
            if (job.canceled) throw new CanceledException();
            HttpURLConnection finish = open(job, "/api/v1/backups/import/finish", "POST");
            finish.setRequestProperty("content-type", "application/json");
            byte[] body = new JSONObject().put("uploadId", uploadId).put("name", name).put("expectedBytes", sent).toString().getBytes(StandardCharsets.UTF_8);
            finish.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = finish.getOutputStream()) { out.write(body); }
            int status = finish.getResponseCode();
            job.end(message("done", "status", status, "body", read(finish)));
            return status >= 200 && status < 300;
        } catch (CanceledException | OperationCanceledException e) {
            discard(job, uploadId);
            job.end(message("canceled"));
        } catch (IOException | JSONException | SecurityException | UploadException e) {
            discard(job, uploadId);
            // A provider told to stop may say so as a failed read.
            if (job.canceled) {
                job.end(message("canceled"));
                return false;
            }
            Log.w(TAG, "a backup import failed", e);
            job.end(e instanceof UploadException
                ? message("failed", "message", e.getMessage(), "status", ((UploadException) e).status, "body", ((UploadException) e).body)
                : message("failed", "message", String.valueOf(e.getMessage())));
        }
        return false;
    }

    /**
     * Send the whole file, in chunks, and say how many bytes that was.
     *
     * A chunk that breaks off - the file's provider failing a read, the
     * manager restarting - is rolled back by the manager. This asks it where
     * to carry on from, opens the file again at that point and goes on, a few
     * times, waiting longer each time. A refusal is not retried, and neither
     * is a source that would not come out the same a second time.
     */
    private static long sendAll(Job job, Source source, String uploadId) throws IOException, UploadException, CanceledException {
        int failures = 0;
        while (true) {
            try {
                long from = 0;
                int index = 0;
                if (failures > 0) {
                    long[] at = progress(job, uploadId);
                    index = (int) at[0];
                    from = at[1];
                }
                return sendFrom(job, source, uploadId, from, index);
            } catch (IOException | UploadException e) {
                // Stopping a zip made as it is read breaks its pipe on the way out.
                if (job.canceled) throw new CanceledException();
                if (e instanceof UploadException && ((UploadException) e).status < 500) throw e;
                if (!source.resumable() || ++failures > RETRIES) throw e;
                Log.w(TAG, "a backup import broke off; trying again (" + failures + "/" + RETRIES + ")", e);
                pause(job, RETRY_FIRST_MS << (failures - 1));
            }
        }
    }

    /** Send the file from byte {@code from} on, as chunks numbered from {@code first}. */
    private static long sendFrom(Job job, Source source, String uploadId, long from, int first) throws IOException, UploadException, CanceledException {
        long sent = from;
        long size = source.size();
        try (InputStream in = source.open()) {
            if (job.canceled) throw new CanceledException();
            skipFully(in, from);
            byte[] buffer = new byte[BUFFER_BYTES];
            // Read a buffer ahead, so the end of the file is known before its last chunk goes.
            int pending = readFully(in, buffer);
            long lastTold = 0;
            for (int index = first; pending > 0; index++) {
                if (job.canceled) throw new CanceledException();
                HttpURLConnection connection = open(job, "/api/v1/backups/import/chunk?uploadId=" + uploadId + "&index=" + index, "POST");
                connection.setRequestProperty("content-type", "application/octet-stream");
                connection.setChunkedStreamingMode(BUFFER_BYTES);
                int chunk = 0;
                try (OutputStream out = connection.getOutputStream()) {
                    while (pending > 0 && chunk + pending <= CHUNK_BYTES) {
                        if (job.canceled) throw new CanceledException();
                        out.write(buffer, 0, pending);
                        chunk += pending;
                        sent += pending;
                        pending = readFully(in, buffer);
                        long now = System.currentTimeMillis();
                        if (now - lastTold >= PROGRESS_EVERY_MS) {
                            lastTold = now;
                            job.tell(message("progress", "sent", source.read(sent), "total", size));
                        }
                    }
                }
                expectOk(connection);
            }
        }
        return sent;
    }

    /** Where the manager has the upload up to: {next chunk, bytes held}; {0, 0} when it holds none of it. */
    private static long[] progress(Job job, String uploadId) throws IOException, UploadException {
        HttpURLConnection connection = open(job, "/api/v1/backups/import/chunk?uploadId=" + uploadId, "GET");
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
    private static void pause(Job job, long ms) throws CanceledException {
        long until = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < until) {
            if (job.canceled) throw new CanceledException();
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
    private static HttpURLConnection open(Job job, String path, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(job.origin + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10 * 60 * 1000);
        String cookie = CookieManager.getInstance().getCookie(job.origin);
        if (cookie != null) connection.setRequestProperty("cookie", cookie);
        if (job.csrf != null) connection.setRequestProperty("x-csrf-token", job.csrf);
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
    private static void discard(Job job, String uploadId) {
        try {
            HttpURLConnection connection = open(job, "/api/v1/backups/import/chunk?uploadId=" + uploadId, "DELETE");
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
