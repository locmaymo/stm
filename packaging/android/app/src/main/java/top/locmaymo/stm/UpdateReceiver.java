package top.locmaymo.stm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Android saying this app was just replaced, so an update the app installed
 * gets its manager back. See {@link AppUpdate}.
 */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) AppUpdate.replaced(context);
    }
}
