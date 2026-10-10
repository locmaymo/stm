package top.locmaymo.stm;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * The screen before the first start: what to allow so that Android leaves
 * STM running, one row each, with a button that goes to the right setting.
 *
 * Each row says whether it is done, read again whenever the reader comes back
 * from a setting. Start is ready once all of them are; "Not now" starts
 * anyway and does not ask again.
 */
final class PermissionsScreen extends ScrollView {
    private static final int TEXT = Color.rgb(0xe5, 0xe7, 0xeb);
    private static final int MUTED = Color.rgb(0x9c, 0xa3, 0xaf);
    private static final int DONE = Color.rgb(0x4a, 0xde, 0x80);
    private static final int ACCENT = Color.rgb(0x25, 0x63, 0xeb);
    private static final int CARD = Color.rgb(0x1a, 0x1d, 0x26);

    private final Activity activity;
    private final Runnable onDone;
    private final LinearLayout rows;
    private final Button start;

    PermissionsScreen(Activity activity, Runnable onDone) {
        super(activity);
        this.activity = activity;
        this.onDone = onDone;
        setFillViewport(true);
        setBackgroundColor(Color.rgb(0x0f, 0x11, 0x17));
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_VERTICAL);
        int padding = dp(24);
        column.setPadding(padding, padding, padding, padding);
        addView(column, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        TextView title = text(activity.getString(R.string.permissions_title), 22, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);
        TextView body = text(activity.getString(R.string.permissions_body), 15, MUTED);
        body.setPadding(0, dp(8), 0, dp(16));
        column.addView(body);

        rows = new LinearLayout(activity);
        rows.setOrientation(LinearLayout.VERTICAL);
        column.addView(rows);

        start = new Button(activity);
        start.setText(R.string.permissions_start);
        start.setAllCaps(false);
        start.setOnClickListener((view) -> onDone.run());
        LinearLayout.LayoutParams startLayout = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        startLayout.topMargin = dp(16);
        column.addView(start, startLayout);

        TextView later = text(activity.getString(R.string.permissions_later), 14, MUTED);
        later.setGravity(Gravity.CENTER);
        later.setPadding(0, dp(14), 0, dp(4));
        later.setOnClickListener((view) -> {
            Permissions.skip(activity);
            onDone.run();
        });
        column.addView(later);
        refresh();
    }

    /** Read every row again; called when the reader comes back from a setting. */
    void refresh() {
        rows.removeAllViews();
        if (Build.VERSION.SDK_INT >= 33) {
            row(R.string.permissions_notifications, R.string.permissions_notifications_why, Permissions.notificationsAllowed(activity), R.string.permissions_allow, () -> Permissions.requestNotifications(activity));
        }
        row(R.string.permissions_battery, R.string.permissions_battery_why, Permissions.batteryUnrestricted(activity), R.string.permissions_allow, () -> Permissions.requestBattery(activity));
        if (Permissions.backgroundRestricted(activity)) {
            row(R.string.permissions_background, R.string.permissions_background_why, false, R.string.permissions_open, () -> Permissions.openAppDetails(activity));
        }
        String maker = Permissions.makerName(activity);
        if (maker != null) {
            row(activity.getString(R.string.permissions_maker, maker), activity.getString(R.string.permissions_maker_why), Permissions.makerOpened(activity), activity.getString(R.string.permissions_open), () -> {
                Permissions.openMakerSettings(activity);
                refresh();
            });
        }
        boolean ready = Permissions.allGranted(activity);
        start.setEnabled(ready);
        start.setAlpha(ready ? 1f : 0.5f);
    }

    private void row(int label, int why, boolean done, int action, Runnable onClick) {
        row(activity.getString(label), activity.getString(why), done, activity.getString(action), onClick);
    }

    private void row(String label, String why, boolean done, String action, Runnable onClick) {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(14), dp(12), dp(10), dp(12));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(CARD);
        shape.setCornerRadius(dp(12));
        card.setBackground(shape);

        LinearLayout words = new LinearLayout(activity);
        words.setOrientation(LinearLayout.VERTICAL);
        words.addView(text(label, 16, TEXT));
        TextView detail = text(why, 13, MUTED);
        detail.setPadding(0, dp(2), 0, 0);
        words.addView(detail);
        card.addView(words, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        if (done) {
            TextView mark = text(activity.getString(R.string.permissions_done), 14, DONE);
            mark.setPadding(dp(10), 0, dp(4), 0);
            card.addView(mark);
        } else {
            Button button = new Button(activity);
            button.setText(action);
            button.setAllCaps(false);
            button.setTextColor(Color.WHITE);
            GradientDrawable fill = new GradientDrawable();
            fill.setColor(ACCENT);
            fill.setCornerRadius(dp(8));
            button.setBackground(fill);
            button.setPadding(dp(14), 0, dp(14), 0);
            button.setMinHeight(dp(36));
            button.setMinimumHeight(dp(36));
            button.setOnClickListener((view) -> onClick.run());
            LinearLayout.LayoutParams buttonLayout = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(36));
            buttonLayout.leftMargin = dp(10);
            card.addView(button, buttonLayout);
        }
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        layout.bottomMargin = dp(10);
        rows.addView(card, layout);
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility);
        if (visibility == View.VISIBLE) refresh();
    }
}
