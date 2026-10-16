package top.locmaymo.stm;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * The downloaded update, readable by Android's installer and nothing else.
 *
 * Android hands another app a file only through a content address it is
 * given leave to read; the installer gets that leave with the intent that
 * opens it (see {@link AppUpdate}). Only files in the update folder of the
 * app's cache are served, and only for reading.
 */
public class UpdateFiles extends ContentProvider {
    private static final String MIME = "application/vnd.android.package-archive";

    static Uri uri(Context context, File apk) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".update").appendPath(apk.getName()).build();
    }

    static File folder(Context context) {
        return new File(context.getCacheDir(), "update");
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read only");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = file(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        cursor.addRow(new Object[] { file.getName(), file.length() });
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return MIME;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    /** The file a content address names, when it is one of the update folder's. */
    private File file(Uri uri) throws FileNotFoundException {
        Context context = getContext();
        String name = uri.getLastPathSegment();
        if (context == null || name == null) throw new FileNotFoundException(String.valueOf(uri));
        try {
            File folder = folder(context).getCanonicalFile();
            File file = new File(folder, name).getCanonicalFile();
            if (!folder.equals(file.getParentFile()) || !file.isFile()) throw new FileNotFoundException(String.valueOf(uri));
            return file;
        } catch (IOException e) {
            throw new FileNotFoundException(String.valueOf(uri));
        }
    }
}
