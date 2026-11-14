package top.locmaymo.stm;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A file a page made itself - SillyTavern's exports of presets, prompts, chats
 * and characters are built in the page and handed out as a {@code blob:} link,
 * which Android's downloader cannot read. chat_bridge.js reads the file in the
 * page and sends it here in pieces: "fileStart", then "fileChunk"s of base64,
 * then "fileEnd". It is written to the app's cache as it comes and moved to
 * Downloads at the end.
 */
final class PageDownload {
    private static final String TAG = "STM";
    /** Larger than any export; a page sending more is stopped there. */
    private static final long MAX_BYTES = 512L * 1024 * 1024;
    private static final int MAX_OPEN = 4;

    /** One at a time and in the order sent, off the screen's thread. */
    private static final ExecutorService WRITER = Executors.newSingleThreadExecutor();
    private static final Map<String, Incoming> OPEN = new HashMap<>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private PageDownload() {}

    private static final class Incoming {
        final String name;
        final File part;
        final OutputStream out;
        long size;

        Incoming(String name, File part, OutputStream out) {
            this.name = name;
            this.part = part;
            this.out = out;
        }
    }

    /** Called on the screen's thread with each message; the work is queued. */
    static void receive(Context app, JSONObject data) {
        String type = data.optString("type");
        String id = data.optString("id");
        if (id.isEmpty()) return;
        switch (type) {
            case "fileStart": {
                String name = safeName(data.optString("name"));
                WRITER.execute(() -> start(app, id, name));
                break;
            }
            case "fileChunk": {
                String piece = data.optString("data");
                WRITER.execute(() -> chunk(app, id, piece));
                break;
            }
            case "fileEnd":
                WRITER.execute(() -> end(app, id));
                break;
            default:
                break;
        }
    }

    private static void start(Context app, String id, String name) {
        if (OPEN.containsKey(id)) return;
        if (OPEN.size() >= MAX_OPEN) {
            Log.w(TAG, "too many page downloads at once; one is dropped");
            return;
        }
        File folder = new File(app.getCacheDir(), "page-downloads");
        if (!folder.isDirectory() && !folder.mkdirs()) {
            failed(app, "the download folder could not be made", null);
            return;
        }
        try {
            File part = File.createTempFile("page-", ".part", folder);
            OPEN.put(id, new Incoming(name, part, new FileOutputStream(part)));
            toast(app, app.getString(R.string.download_started));
        } catch (IOException e) {
            failed(app, "a page download could not be started", e);
        }
    }

    private static void chunk(Context app, String id, String piece) {
        Incoming file = OPEN.get(id);
        if (file == null) return;
        try {
            byte[] bytes = Base64.decode(piece, Base64.DEFAULT);
            file.size += bytes.length;
            if (file.size > MAX_BYTES) throw new IOException("larger than " + MAX_BYTES + " bytes");
            file.out.write(bytes);
        } catch (IOException | IllegalArgumentException e) {
            drop(id);
            failed(app, "a page download could not be written", e);
        }
    }

    private static void end(Context app, String id) {
        Incoming file = OPEN.remove(id);
        if (file == null) return;
        try {
            file.out.close();
            save(app, file.part, file.name);
            toast(app, app.getString(R.string.download_saved, file.name));
        } catch (IOException | RuntimeException e) {
            failed(app, "a page download could not be saved", e);
        } finally {
            if (!file.part.delete()) file.part.deleteOnExit();
        }
    }

    private static void drop(String id) {
        Incoming file = OPEN.remove(id);
        if (file == null) return;
        try { file.out.close(); } catch (IOException ignored) { /* deleted below */ }
        if (!file.part.delete()) file.part.deleteOnExit();
    }

    /** Into Downloads under its own name; Android adds " (1)" if that name is taken. */
    private static void save(Context app, File part, String name) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = app.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (target == null) throw new IOException("Downloads would not take the file");
            try (InputStream in = new FileInputStream(part); OutputStream out = resolver.openOutputStream(target)) {
                if (out == null) throw new IOException("Downloads gave nothing to write to");
                copy(in, out);
            } catch (IOException | RuntimeException e) {
                resolver.delete(target, null, null);
                throw e;
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(target, values, null, null);
            return;
        }
        File folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("no Downloads folder");
        File target = unique(folder, name);
        try (InputStream in = new FileInputStream(part); OutputStream out = new FileOutputStream(target)) {
            copy(in, out);
        }
    }

    /**
     * The type Android files it under. The type the page gave is not used: a
     * chat's .jsonl comes as JSON, and Android would rename it to .json. An
     * unknown type keeps the name as it is.
     */
    static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mime == null ? "application/octet-stream" : mime;
    }

    /** The page's name for the file, without folders or anything a file name cannot hold. */
    static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.isEmpty()) clean = "download";
        if (clean.length() > 120) {
            int dot = clean.lastIndexOf('.');
            String extension = dot > 0 && clean.length() - dot <= 16 ? clean.substring(dot) : "";
            clean = clean.substring(0, 120 - extension.length()) + extension;
        }
        return clean;
    }

    private static File unique(File folder, String name) {
        File file = new File(folder, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; file.exists(); n++) file = new File(folder, stem + " (" + n + ")" + extension);
        return file;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
    }

    private static void failed(Context app, String what, Exception error) {
        Log.w(TAG, what, error);
        toast(app, app.getString(R.string.download_failed));
    }

    private static void toast(Context app, String text) {
        MAIN.post(() -> Toast.makeText(app, text, Toast.LENGTH_SHORT).show());
    }
}
