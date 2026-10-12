package top.locmaymo.stm;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * A SillyTavern that ran in Termux, moved into this app.
 *
 * Termux shares its home folder with other apps through a documents provider,
 * which is how file managers open it. The reader picks that folder once in
 * Android's folder picker; the grant lasts while this app runs, which is as
 * long as the move takes, and is not kept: the move is done once and nothing
 * comes back for more. Nothing in Termux is written to.
 *
 * SillyTavern's {@code data/default-user} is zipped while it is read and sent
 * through {@link BackupImport} like a zip the reader picked, so what follows
 * is the restore question any upload ends in.
 */
final class TermuxImport {
    static final String AUTHORITY = "com.termux.documents";
    /** Termux's home, which is also the id its provider gives that folder. */
    private static final String HOME = "/data/data/com.termux/files/home";
    private static final String USER_DATA = "/data/default-user";
    private static final String PREFERENCES = "termux";
    private static final String OFFER_ANSWERED = "offerAnswered";
    private static final String OFFER_SETTLED = "offerSettled";
    private static final int PIPE_BYTES = 1024 * 1024;
    private static final int BUFFER_BYTES = 64 * 1024;

    private TermuxImport() {}

    /** Whether Termux is on this phone, with the provider that shares its folder. */
    static boolean present(Context context) {
        return context.getPackageManager().resolveContentProvider(AUTHORITY, 0) != null;
    }

    /** Whether the console should offer the move: Termux is here and the offer was never answered. */
    static boolean offer(Context context) {
        return present(context) && !preferences(context).getBoolean(OFFER_ANSWERED, false);
    }

    /**
     * Settle, once, whether this phone gets the offer at all.
     *
     * Only an app starting for the first time does. One updated from a build
     * without the offer belongs to somebody already using it, whose data may
     * well have come over from Termux by hand long ago; offering a move then
     * reads as "your data is not here yet". They keep the Data page's button.
     * Called before the manager starts, while {@code usedBefore} - whether an
     * earlier build already unpacked itself here - still says which this is.
     */
    static void settleOffer(Context context, boolean usedBefore) {
        SharedPreferences stored = preferences(context);
        if (stored.getBoolean(OFFER_SETTLED, false)) return;
        SharedPreferences.Editor editor = stored.edit().putBoolean(OFFER_SETTLED, true);
        if (usedBefore) editor.putBoolean(OFFER_ANSWERED, true);
        editor.apply();
    }

    /** "No thanks", or a move that went through: the offer is not made again. */
    static void answerOffer(Context context) {
        preferences(context).edit().putBoolean(OFFER_ANSWERED, true).apply();
    }

    static Intent pickIntent() {
        return new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildTreeDocumentUri(AUTHORITY, HOME));
    }

    /**
     * The zip of the SillyTavern found in the folder the reader picked.
     *
     * Its files are listed here, before anything is sent, so the upload knows
     * how much is coming; reading them waits until the zip is opened.
     */
    static BackupImport.Source source(Context app, Uri tree, BooleanSupplier canceled) throws IOException, NotFoundException {
        ContentResolver resolver = app.getContentResolver();
        Folder folder = new Folder(resolver, tree);
        String userData = locate(folder, DocumentsContract.getTreeDocumentId(tree));
        String version = version(folder, userData.substring(0, userData.length() - USER_DATA.length()) + "/package.json");
        List<Item> items = new ArrayList<>();
        list(folder, userData, "default-user/", items, canceled);
        long total = 0;
        for (Item item : items) total += Math.max(0, item.size);
        String name = version == null ? "SillyTavern Termux.zip" : "SillyTavern Termux " + version + ".zip";
        long size = total;
        AtomicLong read = new AtomicLong();
        return new BackupImport.Source() {
            @Override public String name() { return name; }
            @Override public long size() { return size; }
            @Override public InputStream open() throws IOException { return zip(resolver, tree, items, read, canceled); }
            @Override public boolean resumable() { return false; }
            @Override public long read(long sent) { return read.get(); }
        };
    }

    /**
     * Where SillyTavern's data is in what was picked: Termux's home with
     * SillyTavern in it, the SillyTavern folder, its {@code data} folder or
     * {@code default-user} itself.
     */
    private static String locate(Folder folder, String picked) throws IOException, NotFoundException {
        if (picked.endsWith(USER_DATA) && folder.isDirectory(picked)) return picked;
        if (folder.isDirectory(picked + USER_DATA)) return picked + USER_DATA;
        if (picked.endsWith("/data") && folder.isDirectory(picked + "/default-user")) return picked + "/default-user";
        // A folder above it: SillyTavern under its usual name first, then any other.
        List<String> candidates = new ArrayList<>();
        for (Item child : folder.children(picked)) {
            if (!child.directory) continue;
            if (child.name.equals("SillyTavern")) candidates.add(0, child.id);
            else candidates.add(child.id);
        }
        for (String candidate : candidates) {
            if (folder.isDirectory(candidate + USER_DATA)) return candidate + USER_DATA;
        }
        // Before 1.12 SillyTavern kept everything under public/, which is not moved.
        if (folder.isDirectory(picked + "/public/characters")) throw new NotFoundException("termux_too_old", "This SillyTavern is too old to move");
        for (String candidate : candidates) {
            if (folder.isDirectory(candidate + "/public/characters")) throw new NotFoundException("termux_too_old", "This SillyTavern is too old to move");
        }
        throw new NotFoundException("termux_not_found", "No SillyTavern in the folder that was picked");
    }

    /** SillyTavern's version from its package.json; null when it cannot be read. */
    private static String version(Folder folder, String packageJson) {
        try (InputStream in = folder.open(packageJson)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
            String version = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8)).optString("version", "");
            // It goes into a file name.
            return version.matches("[0-9A-Za-z.+-]{1,32}") ? version : null;
        } catch (IOException | JSONException | RuntimeException e) {
            return null;
        }
    }

    /** Every file under {@code id}, in name order, as {@code path} plus its name. */
    private static void list(Folder folder, String id, String path, List<Item> into, BooleanSupplier canceled) throws IOException {
        if (canceled.getAsBoolean()) throw new IOException("Canceled");
        for (Item child : folder.children(id)) {
            if (child.directory) list(folder, child.id, path + child.name + "/", into, canceled);
            else into.add(new Item(child.id, path + child.name, false, child.size, child.modified));
        }
    }

    /**
     * The zip, written by a thread of its own as it is read.
     *
     * A file that cannot be read stops the zip as a failure, not as an end:
     * the pipe is closed before anything finishes the archive, and the reader
     * hears why rather than getting a shorter zip that looks whole.
     */
    private static InputStream zip(ContentResolver resolver, Uri tree, List<Item> items, AtomicLong read, BooleanSupplier canceled) throws IOException {
        PipedInputStream in = new PipedInputStream(PIPE_BYTES);
        PipedOutputStream out = new PipedOutputStream(in);
        AtomicReference<Exception> failure = new AtomicReference<>();
        read.set(0);
        Thread writer = new Thread(() -> {
            ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(out, BUFFER_BYTES));
            zip.setLevel(Deflater.BEST_SPEED);
            try {
                byte[] buffer = new byte[BUFFER_BYTES];
                for (Item item : items) {
                    if (canceled.getAsBoolean()) throw new IOException("Canceled");
                    ZipEntry entry = new ZipEntry(item.name);
                    if (item.modified > 0) entry.setTime(item.modified);
                    zip.putNextEntry(entry);
                    try (InputStream file = resolver.openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, item.id))) {
                        if (file == null) throw new IOException("Could not open " + item.name);
                        for (int count; (count = file.read(buffer)) > 0; ) {
                            zip.write(buffer, 0, count);
                            read.addAndGet(count);
                        }
                    }
                    zip.closeEntry();
                }
                zip.close();
            } catch (IOException | RuntimeException e) {
                failure.set(e);
                closeQuietly(out);
                try {
                    zip.close();
                } catch (IOException ignored) {
                    // Only frees the compressor: the pipe is already shut.
                }
            }
        }, "stm-termux-zip");
        writer.start();
        return new FilterInputStream(in) {
            @Override public int read() throws IOException {
                int value = super.read();
                if (value < 0) failIfBroken();
                return value;
            }

            @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                int count = super.read(buffer, offset, length);
                if (count < 0) failIfBroken();
                return count;
            }

            private void failIfBroken() throws IOException {
                Exception broken = failure.get();
                if (broken != null) throw new IOException("Reading Termux's folder failed: " + broken.getMessage(), broken);
            }
        };
    }

    private static void closeQuietly(PipedOutputStream out) {
        try {
            out.close();
        } catch (IOException ignored) {
            // Already shut.
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /** The picked folder, read through the grant on it. */
    private static final class Folder {
        private static final String[] COLUMNS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };
        private final ContentResolver resolver;
        private final Uri tree;

        Folder(ContentResolver resolver, Uri tree) {
            this.resolver = resolver;
            this.tree = tree;
        }

        /** Whether {@code id} is a folder; false when it is anything else or is not there. */
        boolean isDirectory(String id) {
            try (Cursor cursor = resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, id), new String[] { Document.COLUMN_MIME_TYPE }, null, null, null)) {
                return cursor != null && cursor.moveToFirst() && Document.MIME_TYPE_DIR.equals(cursor.getString(0));
            } catch (RuntimeException e) {
                // Not there, or outside what was granted.
                return false;
            }
        }

        /** What is in folder {@code id}, sorted by name so every move lists it the same way. */
        List<Item> children(String id) throws IOException {
            List<Item> children = new ArrayList<>();
            try (Cursor cursor = resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), COLUMNS, null, null, null)) {
                if (cursor == null) throw new IOException("Could not list " + id);
                while (cursor.moveToNext()) {
                    children.add(new Item(cursor.getString(0), cursor.getString(1), Document.MIME_TYPE_DIR.equals(cursor.getString(2)),
                        cursor.isNull(3) ? -1 : cursor.getLong(3), cursor.isNull(4) ? 0 : cursor.getLong(4)));
                }
            } catch (RuntimeException e) {
                throw new IOException("Could not list " + id, e);
            }
            children.sort((a, b) -> a.name.compareTo(b.name));
            return children;
        }

        InputStream open(String id) throws IOException {
            InputStream in = resolver.openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, id));
            if (in == null) throw new IOException("Could not open " + id);
            return in;
        }
    }

    /** A file or folder: its provider's id, its name (or path in the zip), and what the provider says about it. */
    private static final class Item {
        final String id;
        final String name;
        final boolean directory;
        final long size;
        final long modified;

        Item(String id, String name, boolean directory, long size, long modified) {
            this.id = id;
            this.name = name;
            this.directory = directory;
            this.size = size;
            this.modified = modified;
        }
    }

    /** The picked folder holds no SillyTavern this can move; {@code code} is what the console has words for. */
    static final class NotFoundException extends Exception {
        final String code;

        NotFoundException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
