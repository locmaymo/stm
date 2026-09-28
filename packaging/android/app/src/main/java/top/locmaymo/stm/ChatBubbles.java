package top.locmaymo.stm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Character replies as phone notifications, and as chat bubbles, the way a
 * messenger shows them.
 *
 * SillyTavern tells the app when a character has finished a reply (see
 * chat_bridge.js). Unless the reader is looking at SillyTavern in the app,
 * the reply becomes a conversation notification with the character's avatar;
 * pressing it opens that chat in the app. That is on until the reader turns it
 * off. Bubbles are the reader's choice on top: on Android 11 and later the
 * same notification then floats over other apps, and opening it shows
 * SillyTavern itself, on that character's chat (see {@link BubbleActivity}).
 *
 * Everything here runs on the main thread.
 */
final class ChatBubbles {
    private static final String TAG = "STM";
    static final String CHANNEL = "chats";
    static final String EXTRA_KEY = "top.locmaymo.stm.extra.CONVERSATION";
    static final String EXTRA_CHAT = "top.locmaymo.stm.extra.CHAT";
    private static final String PREFERENCES = "chat-bubbles";
    /** Whether replies float as bubbles. Off until the reader turns it on. */
    private static final String ENABLED = "enabled";
    /** Whether replies are notified at all. On until the reader turns it off. */
    private static final String REPLIES = "replies";
    private static final String SHORTCUT_PREFIX = "chat:";
    private static final int NOTIFICATION = 3;
    /** Messages the notification lists. */
    private static final int NOTIFIED_MESSAGES = 5;
    private static final int MAX_AVATAR_CHARS = 2 * 1024 * 1024;

    static final class Message {
        final boolean user;
        final String name;
        final String text;

        Message(boolean user, String name, String text) {
            this.user = user;
            this.name = name;
            this.text = text;
        }
    }

    /** One character's chat, or one group's, as SillyTavern last reported it. */
    static final class Conversation {
        final String key;
        String chat = "";
        String title = "";
        String name = "";
        boolean group;
        List<Message> history = Collections.emptyList();
        Bitmap avatar;
        String avatarSource = "";

        Conversation(String key) {
            this.key = key;
        }
    }

    private static final Map<String, Conversation> conversations = new HashMap<>();
    /** The conversation an open bubble is showing, so a reply to it does not ring as well. */
    private static String shownKey;

    private ChatBubbles() {}

    static boolean enabled(Context context) {
        return preferences(context).getBoolean(ENABLED, false);
    }

    static void setEnabled(Context context, boolean on) {
        preferences(context).edit().putBoolean(ENABLED, on).apply();
        // The bubbles on screen go; the next reply comes as a plain notification.
        if (!on) cancelAll(context);
    }

    static boolean replies(Context context) {
        return preferences(context).getBoolean(REPLIES, true);
    }

    static void setReplies(Context context, boolean on) {
        preferences(context).edit().putBoolean(REPLIES, on).apply();
        if (on) return;
        // Off means gone: the notifications and bubbles shown, and the conversations behind them.
        cancelAll(context);
        conversations.clear();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ShortcutManager shortcuts = context.getSystemService(ShortcutManager.class);
            List<String> ids = new ArrayList<>();
            for (ShortcutInfo shortcut : shortcuts.getDynamicShortcuts()) {
                if (shortcut.getId().startsWith(SHORTCUT_PREFIX)) ids.add(shortcut.getId());
            }
            if (!ids.isEmpty()) shortcuts.removeLongLivedShortcuts(ids);
        }
    }

    private static void cancelAll(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == NOTIFICATION) manager.cancel(shown.getTag(), NOTIFICATION);
        }
    }

    /** Whether this Android can float a notification as a bubble at all. */
    static boolean bubblesSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
    }

    /** Whether the reader lets this app's conversations bubble, in Android's settings. */
    @SuppressWarnings("deprecation")
    static boolean bubblesAllowed(Context context) {
        if (!bubblesSupported()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return manager.areBubblesEnabled() && manager.getBubblePreference() != NotificationManager.BUBBLE_PREFERENCE_NONE;
        }
        return manager.areBubblesAllowed();
    }

    static void openBubbleSettings(Context context) {
        if (!bubblesSupported()) return;
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            context.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // High, like a messenger's: a reply is what the reader was waiting for.
        NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.channel_chats), NotificationManager.IMPORTANCE_HIGH);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static Conversation conversation(String key) {
        return key == null ? null : conversations.get(key);
    }

    /** The conversation an open bubble shows, or null when none is open. */
    static void shown(String key) {
        shownKey = key;
    }

    /** A character finished a reply; {@code watching} is whether the reader is looking at SillyTavern in the app. */
    static void onReply(Context context, JSONObject data, boolean watching) {
        if (!replies(context)) return;
        String key = data.optString("key", "");
        if (key.isEmpty()) return;
        Conversation conversation = conversations.get(key);
        if (conversation == null) {
            conversation = new Conversation(key);
            conversations.put(key, conversation);
        }
        conversation.chat = data.optString("chat", "");
        conversation.title = data.optString("title", "");
        conversation.name = data.optString("name", conversation.title);
        conversation.group = data.optBoolean("group", false);
        conversation.history = history(data.optJSONArray("history"));
        String avatar = data.optString("avatar", "");
        if (!avatar.equals(conversation.avatarSource)) {
            conversation.avatarSource = avatar;
            conversation.avatar = decode(avatar);
        }
        boolean bubble = bubblesSupported() && enabled(context);
        if (watching) {
            // The reader is looking at the chat itself: what was waiting for them there is read.
            // A bubble stays, since it goes with its notification.
            if (!bubble) context.getSystemService(NotificationManager.class).cancel(key, NOTIFICATION);
            return;
        }
        notify(context, conversation, data.optString("text", ""), bubble);
    }

    private static void notify(Context context, Conversation conversation, String text, boolean bubble) {
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.notify(conversation.key, NOTIFICATION, build(context, conversation, text, bubble));
        } catch (RuntimeException error) {
            Log.w(TAG, "a reply notification could not be shown", error);
        }
    }

    private static Notification build(Context context, Conversation conversation, String text, boolean bubble) {
        Intent open = new Intent(context, MainActivity.class)
                .setData(Uri.fromParts("stm-chat", conversation.key, null))
                .putExtra(EXTRA_KEY, conversation.key)
                .putExtra(EXTRA_CHAT, conversation.chat)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent press = PendingIntent.getActivity(context, conversation.key.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(conversation.name)
                .setContentText(text)
                .setContentIntent(press)
                .setCategory(Notification.CATEGORY_MESSAGE)
                // Its own group, so Android does not fold it under "the manager is running".
                .setGroup(CHANNEL)
                // A bubble lives as long as its notification: pressing it must not take the bubble away.
                .setAutoCancel(!bubble);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            if (conversation.avatar != null) builder.setLargeIcon(circle(conversation.avatar));
            return builder.setStyle(new Notification.BigTextStyle().bigText(text)).build();
        }

        Icon icon = conversation.avatar != null
                ? Icon.createWithAdaptiveBitmap(adaptive(conversation.avatar))
                : Icon.createWithResource(context, R.mipmap.ic_launcher);
        Person reader = new Person.Builder().setName(context.getString(R.string.bubble_you)).build();
        Person character = new Person.Builder().setName(conversation.name).setKey(conversation.key).setIcon(icon).build();
        Notification.MessagingStyle style = new Notification.MessagingStyle(reader);
        if (conversation.group) style.setConversationTitle(conversation.title).setGroupConversation(true);
        List<Message> history = conversation.history;
        long now = System.currentTimeMillis();
        int from = Math.max(0, history.size() - NOTIFIED_MESSAGES);
        for (int i = from; i < history.size(); i++) {
            Message message = history.get(i);
            Person sender = message.user ? null
                    : message.name.equals(conversation.name) ? character
                    : new Person.Builder().setName(message.name).build();
            style.addMessage(new Notification.MessagingStyle.Message(message.text, now - (history.size() - i), sender));
        }
        if (history.isEmpty()) style.addMessage(new Notification.MessagingStyle.Message(text, now, character));
        builder.setStyle(style).addPerson(character);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // A conversation shortcut is what files the notification among Android's conversations.
            String shortcut = SHORTCUT_PREFIX + conversation.key;
            publishShortcut(context, shortcut, conversation, icon, character);
            builder.setShortcutId(shortcut);
        }
        if (bubble) {
            Intent opens = new Intent(context, BubbleActivity.class)
                    .setData(Uri.fromParts("stm-chat", conversation.key, null))
                    .putExtra(EXTRA_KEY, conversation.key)
                    .putExtra(EXTRA_CHAT, conversation.chat);
            // A bubble's intent has to be mutable: Android adds to it when it opens the bubble.
            int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent target = PendingIntent.getActivity(context, conversation.key.hashCode(), opens, mutable | PendingIntent.FLAG_UPDATE_CURRENT);
            float density = context.getResources().getDisplayMetrics().density;
            Notification.BubbleMetadata metadata = new Notification.BubbleMetadata.Builder(target, icon)
                    .setDesiredHeight((int) (600 * density))
                    .setSuppressNotification(conversation.key.equals(shownKey))
                    .build();
            builder.setBubbleMetadata(metadata);
        }
        return builder.build();
    }

    /** Android only lets a conversation bubble when a long-lived shortcut stands for it. */
    private static void publishShortcut(Context context, String id, Conversation conversation, Icon icon, Person character) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        Intent open = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .putExtra(EXTRA_KEY, conversation.key)
                .putExtra(EXTRA_CHAT, conversation.chat);
        ShortcutInfo shortcut = new ShortcutInfo.Builder(context, id)
                .setShortLabel(conversation.group ? conversation.title : conversation.name)
                .setLongLived(true)
                .setIcon(icon)
                .setPerson(character)
                .setIntent(open)
                .build();
        context.getSystemService(ShortcutManager.class).pushDynamicShortcut(shortcut);
    }

    private static List<Message> history(JSONArray items) {
        if (items == null) return Collections.emptyList();
        List<Message> history = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String text = item.optString("text", "");
            if (!text.isEmpty()) history.add(new Message(item.optBoolean("user", false), item.optString("name", ""), text));
        }
        return history;
    }

    /** A {@code data:image/…;base64,…} address, as a picture; null for anything else. */
    private static Bitmap decode(String dataUrl) {
        if (dataUrl.isEmpty() || dataUrl.length() > MAX_AVATAR_CHARS || !dataUrl.startsWith("data:image/")) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0 || !dataUrl.substring(0, comma).endsWith(";base64")) return null;
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * The square of a portrait that shows the face: centred across, and a
     * little below the top, where a character card's face usually is.
     */
    private static Rect faceSquare(Bitmap source) {
        int side = Math.min(source.getWidth(), source.getHeight());
        int left = (source.getWidth() - side) / 2;
        int top = (source.getHeight() - side) / 5;
        return new Rect(left, top, left + side, top + side);
    }

    /**
     * The avatar laid out for an adaptive icon: Android shows only the middle
     * two thirds of one, cut to its own shape, so the face goes there.
     */
    private static Bitmap adaptive(Bitmap source) {
        int size = 216;
        int inset = size / 6;
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        Rect face = faceSquare(source);
        // The same picture, larger, behind it: an edge that moves with the icon shows picture, not a gap.
        canvas.drawBitmap(source, face, new Rect(0, 0, size, size), paint);
        canvas.drawBitmap(source, face, new Rect(inset, inset, size - inset, size - inset), paint);
        return out;
    }

    /** The avatar cut to a circle, for places that draw it as it is. */
    private static Bitmap circle(Bitmap source) {
        int size = 192;
        Rect face = faceSquare(source);
        Bitmap square = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        new Canvas(square).drawBitmap(source, face, new Rect(0, 0, size, size), new Paint(Paint.FILTER_BITMAP_FLAG));
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new BitmapShader(square, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        new Canvas(out).drawOval(new RectF(0, 0, size, size), paint);
        return out;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
