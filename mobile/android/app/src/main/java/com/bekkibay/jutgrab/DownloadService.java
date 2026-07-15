package com.bekkibay.jutgrab;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps downloads alive while the app is backgrounded.
 * DownloadCore drives it: started while active/queued jobs exist, stopped when
 * the queue drains.
 */
public class DownloadService extends Service {

    private static final String CHANNEL = "downloads";
    private static final int NOTIF_ID = 1;
    private static volatile boolean running = false;

    static void sync(Context ctx, int activeCount) {
        try {
            if (activeCount > 0 && !running) {
                Intent i = new Intent(ctx, DownloadService.class);
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
                else ctx.startService(i);
            } else if (activeCount == 0 && running) {
                ctx.stopService(new Intent(ctx, DownloadService.class));
            }
        } catch (Exception ignored) {}
    }

    static void progress(Context ctx, String title, int pct) {
        if (!running) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, build(ctx, title, pct));
        } catch (Exception ignored) {}
    }

    private static Notification build(Context ctx, String title, int pct) {
        Intent open = new Intent(ctx, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("JutGrab — загрузка")
                .setContentText(title == null ? "Скачивание серий" : title)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (pct >= 0) b.setProgress(100, pct, false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Загрузки",
                    NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = true;
        startForeground(NOTIF_ID, build(this, null, -1));
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
