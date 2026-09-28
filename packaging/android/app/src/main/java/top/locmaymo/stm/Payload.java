package top.locmaymo.stm;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the app carries, put where the manager can run it.
 *
 * node, git and cloudflared are installed by Android into the native library
 * directory as lib*.so, the only place an app may start a program from. The
 * libraries they load, npm, and the manager itself ship as tar archives in the
 * assets and are unpacked into the app's own storage - loading a library from
 * there is allowed, starting a program is not. An archive is unpacked again
 * only when the build that shipped it changed.
 */
final class Payload {
    interface Progress { void report(String message); }

    private Payload() { }

    /** Unpack what changed and return the environment the manager runs in. */
    static Map<String, String> prepare(Context context, Progress progress) throws IOException, ErrnoException, org.json.JSONException {
        File files = context.getFilesDir();
        File nativeDir = new File(context.getApplicationInfo().nativeLibraryDir);
        JSONObject bundle = new JSONObject(readAsset(context, "bundle.json"));
        File stampFile = new File(files, "bundle.json");
        JSONObject stamp = stampFile.exists() ? new JSONObject(readFile(stampFile)) : new JSONObject();

        File runtime = new File(files, "runtime");
        File manager = new File(files, "manager");
        for (String[] archive : new String[][] { { "runtime", "runtime.tar" }, { "manager", "manager.tar" } }) {
            File target = new File(files, archive[0]);
            if (!bundle.getString(archive[0]).equals(stamp.optString(archive[0])) || !target.isDirectory()) {
                progress.report(context.getString(R.string.status_unpacking));
                // The stamp goes first, so an unpack cut short is redone next time.
                stamp.remove(archive[0]);
                writeFile(stampFile, stamp.toString());
                deleteTree(target);
                try (InputStream in = new BufferedInputStream(context.getAssets().open(archive[1]), 1 << 16)) {
                    Tar.extract(in, target);
                }
                stamp.put(archive[0], bundle.getString(archive[0]));
                writeFile(stampFile, stamp.toString());
            }
        }

        // The native library directory moves with every update, so the links
        // into it are made again on every start.
        File bin = new File(files, "bin");
        File gitCore = new File(files, "git-core");
        File home = new File(files, "home");
        bin.mkdirs();
        gitCore.mkdirs();
        home.mkdirs();
        link(new File(nativeDir, "libnode.so"), new File(bin, "node"));
        link(new File(nativeDir, "libgit.so"), new File(bin, "git"));
        link(new File(nativeDir, "libcloudflared.so"), new File(bin, "cloudflared"));
        link(new File(nativeDir, "libgit_remote_http.so"), new File(gitCore, "git-remote-http"));
        link(new File(nativeDir, "libgit_remote_http.so"), new File(gitCore, "git-remote-https"));

        File certificates = new File(runtime, "etc/tls/cert.pem");
        Map<String, String> env = new LinkedHashMap<>();
        env.put("PATH", bin.getPath() + ":/system/bin");
        env.put("LD_LIBRARY_PATH", new File(runtime, "lib").getPath());
        env.put("HOME", home.getPath());
        env.put("TMPDIR", context.getCacheDir().getPath());
        env.put("SSL_CERT_FILE", certificates.getPath());
        env.put("GIT_SSL_CAINFO", certificates.getPath());
        env.put("GIT_EXEC_PATH", gitCore.getPath());
        env.put("GIT_CONFIG_NOSYSTEM", "1");
        env.put("STM_NPM_CLI", new File(runtime, "npm/bin/npm-cli.js").getPath());
        env.put("STM_CLOUDFLARED_PATH", new File(bin, "cloudflared").getPath());
        env.put("STM_DATA_DIR", new File(files, "data").getPath());
        env.put("STM_APP_ROOT", manager.getPath());
        env.put("STM_STATIC_ROOT", new File(manager, "panel").getPath());
        env.put("STM_OPEN_BROWSER", "0");
        // Tells the manager it is this app rather than Termux: its Node reports
        // the same platform either way.
        env.put("STM_ANDROID_APP", "1");
        return env;
    }

    static File nodeBinary(Context context) {
        return new File(context.getApplicationInfo().nativeLibraryDir, "libnode.so");
    }

    static File managerEntry(Context context) {
        return new File(context.getFilesDir(), "manager/apps/manager-server/src/main.js");
    }

    private static void link(File target, File link) throws ErrnoException {
        try { Os.remove(link.getPath()); } catch (ErrnoException ignored) { }
        Os.symlink(target.getPath(), link.getPath());
    }

    /** Remove a directory without following the symlinks inside it. */
    static void deleteTree(File file) throws ErrnoException {
        int mode;
        try { mode = Os.lstat(file.getPath()).st_mode; } catch (ErrnoException missing) { return; }
        if (OsConstants.S_ISDIR(mode)) {
            String[] names = file.list();
            if (names != null) for (String name : names) deleteTree(new File(file, name));
        }
        Os.remove(file.getPath());
    }

    private static String readAsset(Context context, String name) throws IOException {
        try (InputStream in = context.getAssets().open(name)) { return readAll(in); }
    }

    private static String readFile(File file) throws IOException {
        try (InputStream in = new java.io.FileInputStream(file)) { return readAll(in); }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static void writeFile(File file, String text) throws IOException {
        File temporary = new File(file.getPath() + ".tmp");
        try (OutputStream out = new FileOutputStream(temporary)) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
        if (!temporary.renameTo(file)) throw new IOException("Could not write " + file);
    }
}
