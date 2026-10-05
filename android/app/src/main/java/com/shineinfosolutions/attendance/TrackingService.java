package com.shineinfosolutions.attendance;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps reporting the phone's position to the server while the person is checked in, whether or not
 * the app is on screen. The server decides: outside the office radius (or after office hours) it
 * checks the person out and answers open=false, and this service then stops itself.
 */
public class TrackingService extends Service {
    private static final String TAG = "ShineTracking";
    private static final String CHANNEL = "tracking";
    private static final int NOTIFICATION_ID = 1;
    private static final long UPDATE_MS = 30_000;   // how often we ask for a fix
    private static final long SEND_MS = 30_000;     // how often we report at most
    private static final long WAKE_LOCK_MS = 12 * 60 * 60 * 1000L; // safety cap: longer than any office day

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private LocationManager locations;
    private PowerManager.WakeLock wakeLock;
    private long lastSentAt;
    private boolean listening;
    /** True while this process has a live service reporting location (the web page asks via ShineNative.isTracking). */
    static volatile boolean running;

    static void start(Context context) {
        try {
            context.startForegroundService(new Intent(context, TrackingService.class));
        } catch (RuntimeException e) {
            // e.g. started from boot without background-location permission
            Log.w(TAG, "Could not start tracking: " + e);
        }
    }

    static void stop(Context context) {
        Prefs.clearToken(context);
        context.stopService(new Intent(context, TrackingService.class));
    }

    private final LocationListener listener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            report(location);
        }

        // Explicit overrides: these are abstract on Android 8-10.
        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification());
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Foreground start refused: " + e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (Prefs.token(this) == null || !hasLocationPermission()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        listen();
        return START_STICKY; // if the system kills us, come back
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void listen() {
        if (listening) return;
        try {
            for (String provider : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (locations.getAllProviders().contains(provider)) {
                    locations.requestLocationUpdates(provider, UPDATE_MS, 0f, listener, Looper.getMainLooper());
                }
            }
            listening = true;
            running = true;
        } catch (SecurityException e) {
            Log.w(TAG, "Location permission missing: " + e);
            stopSelf();
            return;
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShineAttendance:tracking");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(WAKE_LOCK_MS);
    }

    private void report(final Location location) {
        long now = System.currentTimeMillis();
        if (now - lastSentAt < SEND_MS) return;
        final String token = Prefs.token(this);
        if (token == null) {
            stopSelf();
            return;
        }
        lastSentAt = now;
        network.execute(new Runnable() {
            @Override
            public void run() {
                send(token, location);
            }
        });
    }

    private void send(String token, Location location) {
        HttpURLConnection con = null;
        try {
            JSONObject body = new JSONObject();
            body.put("lat", location.getLatitude());
            body.put("lng", location.getLongitude());
            if (location.hasAccuracy()) body.put("accuracy", location.getAccuracy());

            con = (HttpURLConnection) new URL(BuildConfig.APP_URL + "/api/attendance/track").openConnection();
            con.setRequestMethod("POST");
            con.setConnectTimeout(15_000);
            con.setReadTimeout(20_000);
            con.setDoOutput(true);
            con.setRequestProperty("content-type", "application/json");
            con.setRequestProperty("authorization", "Bearer " + token);
            try (OutputStream out = con.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            if (code == 401) {
                // Token replaced (logged in on another phone) or account disabled.
                finish();
                return;
            }
            if (code != 200) return; // server trouble: keep trying
            JSONObject answer = new JSONObject(read(con.getInputStream()));
            if (!answer.optBoolean("open", true)) finish(); // checked out (manually, by distance, or office closed)
        } catch (Exception e) {
            Log.w(TAG, "Report failed (will retry): " + e); // offline etc.
        } finally {
            if (con != null) con.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private void finish() {
        Prefs.clearToken(this);
        stopSelf();
    }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_location)
                .setContentTitle(getString(R.string.tracking_title))
                .setContentText(getString(R.string.tracking_text))
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (listening) {
            locations.removeUpdates(listener);
            listening = false;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        network.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
