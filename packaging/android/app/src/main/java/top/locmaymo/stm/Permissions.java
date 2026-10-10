package top.locmaymo.stm;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.Locale;

/**
 * What the app asks for so that Android leaves it running.
 *
 * A foreground service is what the system promises to keep, but a phone set
 * to save battery stops it anyway: the screen goes off, another app comes to
 * the front, and the manager and its SillyTavern are gone. Three things stop
 * that, and the app asks for them before the first start:
 *
 * <ul>
 *   <li>notifications, without which Android 13 hides the service's
 *       notification and treats the app as one nobody is using;</li>
 *   <li>leave to ignore battery optimisation, the "Unrestricted" battery use
 *       of newer Android;</li>
 *   <li>background running not restricted, a switch some phones turn off;</li>
 * </ul>
 *
 * and, on phones whose maker adds a list of apps allowed to start or run on
 * their own, that list. Nothing can read whether the app is on it, so it
 * counts as done once the reader has been taken there.
 */
final class Permissions {
    static final int NOTIFICATIONS = 1;
    private static final String PREFERENCES = "permissions";
    private static final String SKIPPED = "skipped";
    private static final String MAKER_OPENED = "maker_opened";
    private static final String NOTIFICATIONS_ASKED = "notifications_asked";

    private Permissions() {}

    /** Whether to stop at the permissions screen before starting. */
    static boolean shouldAsk(Context context) {
        if (preferences(context).getBoolean(SKIPPED, false)) return false;
        return !allGranted(context);
    }

    static boolean allGranted(Context context) {
        return notificationsAllowed(context)
            && batteryUnrestricted(context)
            && !backgroundRestricted(context)
            && (makerSettings(context) == null || makerOpened(context));
    }

    /** Asked not to ask again; the screen does not come back on its own. */
    static void skip(Context context) {
        preferences(context).edit().putBoolean(SKIPPED, true).apply();
    }

    static boolean notificationsAllowed(Context context) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Ask for notifications: the system's question the first time, the app's
     * notification settings after that, because a question refused twice is
     * never shown again.
     */
    static void requestNotifications(Activity activity) {
        if (Build.VERSION.SDK_INT < 33) return;
        SharedPreferences preferences = preferences(activity);
        if (!preferences.getBoolean(NOTIFICATIONS_ASKED, false) || activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            preferences.edit().putBoolean(NOTIFICATIONS_ASKED, true).apply();
            activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS);
            return;
        }
        open(activity, new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()), appDetails(activity));
    }

    static boolean batteryUnrestricted(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power == null || power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    @android.annotation.SuppressLint("BatteryLife")
    static void requestBattery(Activity activity) {
        Intent ask = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.getPackageName()));
        open(activity, ask, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
    }

    /** "Background usage" turned off for this app, which stops its service as soon as it is out of sight. */
    static boolean backgroundRestricted(Context context) {
        if (Build.VERSION.SDK_INT < 28) return false;
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        return manager != null && manager.isBackgroundRestricted();
    }

    static void openAppDetails(Activity activity) {
        open(activity, appDetails(activity), null);
    }

    static boolean makerOpened(Context context) {
        return preferences(context).getBoolean(MAKER_OPENED, false);
    }

    /** The maker's name for the reader, when this phone has a list of its own to be on; else null. */
    static String makerName(Context context) {
        return makerSettings(context) == null ? null : capitalized(Build.MANUFACTURER);
    }

    /** Take the reader to the maker's list of apps allowed to start and run on their own. */
    static void openMakerSettings(Activity activity) {
        Intent[] candidates = makerSettings(activity);
        preferences(activity).edit().putBoolean(MAKER_OPENED, true).apply();
        if (candidates == null) return;
        for (Intent candidate : candidates) {
            try {
                activity.startActivity(candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            } catch (ActivityNotFoundException | SecurityException unavailable) {
                // That screen moved in this version of the maker's system; try the next.
            }
        }
        openAppDetails(activity);
    }

    /**
     * Where each maker keeps its own list, newest system first. These are the
     * makers known to stop apps that Android itself would leave running.
     */
    private static Intent[] makerSettings(Context context) {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        switch (maker) {
            case "xiaomi":
            case "redmi":
            case "poco":
                return components(
                    "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity");
            case "oppo":
            case "realme":
            case "oneplus":
                return components(
                    "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                    "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity",
                    "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity",
                    "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity");
            case "vivo":
            case "iqoo":
                return components(
                    "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                    "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity");
            case "huawei":
            case "honor":
                return components(
                    "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                    "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity",
                    "com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity");
            case "asus":
                return components(
                    "com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity",
                    "com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity");
            case "samsung":
                // "Never sleeping apps", in the phone's battery settings.
                return components(
                    "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity",
                    "com.samsung.android.sm", "com.samsung.android.sm.battery.ui.BatteryActivity");
            default:
                return null;
        }
    }

    private static Intent[] components(String... pairs) {
        Intent[] intents = new Intent[pairs.length / 2];
        for (int index = 0; index < intents.length; index++) {
            intents[index] = new Intent().setComponent(new ComponentName(pairs[index * 2], pairs[index * 2 + 1]));
        }
        return intents;
    }

    private static Intent appDetails(Context context) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
    }

    private static void open(Activity activity, Intent first, Intent fallback) {
        try {
            activity.startActivity(first);
        } catch (ActivityNotFoundException | SecurityException unavailable) {
            if (fallback == null) return;
            try {
                activity.startActivity(fallback);
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // Nowhere to send the reader on this phone.
            }
        }
    }

    private static String capitalized(String text) {
        if (text == null || text.isEmpty()) return "";
        return text.substring(0, 1).toUpperCase(Locale.ROOT) + text.substring(1);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
