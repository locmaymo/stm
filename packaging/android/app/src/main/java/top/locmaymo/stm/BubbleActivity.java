package top.locmaymo.stm;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * What a chat bubble opens to: SillyTavern itself, on that bubble's chat.
 *
 * It is the app's one SillyTavern page (see {@link SillyTavernHost}), moved in
 * here while the bubble is open and handed back when it closes - the reader's
 * own theme, background and extensions, and a reply still being written, all
 * carry over. Each bubble is one character's chat, or one group's, and
 * opening it switches SillyTavern there. After the app was closed for good the
 * page is opened afresh, once the manager has SillyTavern running again.
 */
public class BubbleActivity extends Activity implements SillyTavernHost.Host {
    private String key;
    private String chat;
    private FrameLayout frame;
    private LinearLayout cover;
    private TextView statusView;
    private ProgressBar spinner;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        read(getIntent());
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.rgb(0x0f, 0x11, 0x17));
        cover = new LinearLayout(this);
        cover.setOrientation(LinearLayout.VERTICAL);
        cover.setGravity(Gravity.CENTER);
        cover.setBackgroundColor(Color.rgb(0x0f, 0x11, 0x17));
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        cover.setPadding(padding, padding, padding, padding);
        spinner = new ProgressBar(this);
        statusView = new TextView(this);
        statusView.setTextColor(Color.rgb(0xd1, 0xd5, 0xdb));
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(0, padding, 0, 0);
        cover.addView(spinner);
        cover.addView(statusView);
        frame.addView(cover, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(frame);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        read(intent);
    }

    private void read(Intent intent) {
        String next = intent.getStringExtra(ChatBubbles.EXTRA_KEY);
        if (next != null) key = next;
        String nextChat = intent.getStringExtra(ChatBubbles.EXTRA_CHAT);
        if (nextChat != null) chat = nextChat;
    }

    @Override
    protected void onResume() {
        super.onResume();
        ChatBubbles.shown(key);
        show();
    }

    @Override
    protected void onPause() {
        ChatBubbles.shown(null);
        // The page goes back to wherever it is wanted next; until then it runs unseen.
        SillyTavernHost.detach(this);
        super.onPause();
    }

    private void show() {
        if (!SillyTavernHost.hasPage()) {
            String url = SillyTavernHost.lastUrl(this);
            if (url == null) {
                // SillyTavern has never been opened in the app: there is no address to open.
                cover(false, R.string.bubble_open_first);
                return;
            }
            startManager();
            cover(true, R.string.bubble_loading);
            SillyTavernHost.loadWhenUp(this, url, () -> cover(false, R.string.sillytavern_unavailable));
        } else if (!SillyTavernHost.ready()) {
            cover(true, R.string.bubble_loading);
        }
        SillyTavernHost.attach(this, frame);
        SillyTavernHost.whenReady(() -> SillyTavernHost.openChat(key, chat, this::opened));
    }

    private void opened(String problem) {
        cover.setVisibility(View.GONE);
        if ("busy".equals(problem)) Toast.makeText(this, R.string.bubble_busy, Toast.LENGTH_LONG).show();
    }

    private void cover(boolean working, int text) {
        cover.setVisibility(View.VISIBLE);
        cover.bringToFront();
        spinner.setVisibility(working ? View.VISIBLE : View.GONE);
        statusView.setText(text);
        cover.setOnClickListener(working ? null : (view) -> startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
    }

    /** SillyTavern is run by the manager, which is not running after the app was stopped. */
    private void startManager() {
        if (ManagerService.running) return;
        Intent intent = new Intent(this, ManagerService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    @Override
    public void pageLost(String url) {
        cover(true, R.string.bubble_loading);
        SillyTavernHost.load(this, url);
        SillyTavernHost.attach(this, frame);
        SillyTavernHost.whenReady(() -> SillyTavernHost.openChat(key, chat, this::opened));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (SillyTavernHost.onActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
}
