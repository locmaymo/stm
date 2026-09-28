package top.locmaymo.stm;

import android.system.ErrnoException;
import android.system.Os;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Unpack the POSIX tar archives scripts/build-android.mjs writes: regular
 * files, symlinks, and PAX records for names too long for the header.
 *
 * Android's own tar is not in every version this app supports, so the few
 * dozen lines it takes are here instead.
 */
final class Tar {
    private Tar() { }

    static void extract(InputStream source, File root) throws IOException, ErrnoException {
        DataInputStream in = new DataInputStream(source);
        root.mkdirs();
        byte[] header = new byte[512];
        Map<String, String> pax = new HashMap<>();
        while (true) {
            try { in.readFully(header); } catch (EOFException end) { return; }
            if (isZero(header)) return;
            long size = Long.parseLong(field(header, 124, 12).trim().isEmpty() ? "0" : field(header, 124, 12).trim(), 8);
            char type = (char) (header[156] == 0 ? '0' : header[156]);
            if (type == 'x') {
                pax = parsePax(readBytes(in, size));
                continue;
            }
            String prefix = field(header, 345, 155);
            String name = pax.containsKey("path") ? pax.get("path") : (prefix.isEmpty() ? field(header, 0, 100) : prefix + "/" + field(header, 0, 100));
            String linkName = pax.containsKey("linkpath") ? pax.get("linkpath") : field(header, 157, 100);
            int mode = Integer.parseInt(field(header, 100, 8).trim().isEmpty() ? "644" : field(header, 100, 8).trim(), 8);
            pax = new HashMap<>();

            // Everything this app unpacks it also built, but a path that climbs
            // out of the target is refused regardless.
            if (name.startsWith("/") || ("/" + name + "/").contains("/../")) {
                throw new IOException("Archive entry outside the target: " + name);
            }
            File target = new File(root, name);
            File parent = target.getParentFile();
            if (parent != null) parent.mkdirs();
            if (type == '0' || type == '7') {
                try (OutputStream out = new FileOutputStream(target)) { copy(in, out, size); }
                skipPadding(in, size);
                target.setReadable(true, true);
                if ((mode & 0100) != 0) target.setExecutable(true, true);
            } else if (type == '2') {
                try { Os.remove(target.getPath()); } catch (ErrnoException ignored) { }
                Os.symlink(linkName, target.getPath());
            } else if (type == '5') {
                target.mkdirs();
            } else {
                skip(in, size);
                skipPadding(in, size);
            }
        }
    }

    private static boolean isZero(byte[] block) {
        for (byte value : block) if (value != 0) return false;
        return true;
    }

    private static String field(byte[] header, int offset, int length) {
        int end = offset;
        while (end < offset + length && header[end] != 0) end++;
        return new String(header, offset, end - offset, StandardCharsets.UTF_8);
    }

    private static byte[] readBytes(DataInputStream in, long size) throws IOException {
        byte[] data = new byte[(int) size];
        in.readFully(data);
        skipPadding(in, size);
        return data;
    }

    private static Map<String, String> parsePax(byte[] data) {
        Map<String, String> records = new HashMap<>();
        String text = new String(data, StandardCharsets.UTF_8);
        int at = 0;
        while (at < text.length()) {
            int space = text.indexOf(' ', at);
            if (space < 0) break;
            int length = Integer.parseInt(text.substring(at, space));
            String record = text.substring(space + 1, at + length - 1);
            int equals = record.indexOf('=');
            if (equals > 0) records.put(record.substring(0, equals), record.substring(equals + 1));
            at += length;
        }
        return records;
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buffer = new byte[1 << 16];
        long left = size;
        while (left > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, left));
            if (read < 0) throw new EOFException("Archive ended inside a file");
            out.write(buffer, 0, read);
            left -= read;
        }
    }

    private static void skip(DataInputStream in, long size) throws IOException {
        long left = size;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped <= 0) { if (in.read() < 0) throw new EOFException(); skipped = 1; }
            left -= skipped;
        }
    }

    private static void skipPadding(DataInputStream in, long size) throws IOException {
        long remainder = size % 512;
        if (remainder != 0) skip(in, 512 - remainder);
    }
}
