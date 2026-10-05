package com.shineinfosolutions.attendance;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * The whole app is the Shine Attendance website in a WebView. The only native parts are the permissions
 * (camera, location) and the background location service, which the page controls through `window.ShineNative`.
 */
public class MainActivity extends Activity {
    private static final int REQ_STARTUP = 1;
    private static final int REQ_GEO = 2;
    private static final int REQ_CAMERA = 3;
    private static final int REQ_BACKGROUND = 4;
    private static final int REQ_FILE = 10;

    private static final String HOST = Uri.parse(BuildConfig.APP_URL).getHost();
    private static final String OFFLINE_PAGE = "<html><body style='font-family:sans-serif;text-align:center;padding:48px 24px;color:#141a2a'>"
            + "<h2>No connection</h2><p>Check your internet and try again.</p>"
            + "<p><a href='" + BuildConfig.APP_URL + "' style='display:inline-block;background:#4257e6;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none'>Try again</a></p>"
            + "</body></html>";

    private WebView web;
    private String geoOrigin;
    private GeolocationPermissions.Callback geoCallback;
    private PermissionRequest cameraRequest;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // live camera preview for the check-in photo
        s.setUserAgentString(s.getUserAgentString() + " ShineAttendanceApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "ShineNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.APP_URL);

        requestStartupPermissions();
        // Still checked in from before (app was swiped away or the phone restarted): keep reporting.
        if (Prefs.token(this) != null && !TrackingService.running) TrackingService.start(this);
    }

    // ---------- permissions ----------
    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLocation() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private void requestStartupPermissions() {
        List<String> need = new ArrayList<>();
        if (!hasLocation()) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!granted(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_STARTUP);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_GEO && geoCallback != null) {
            geoCallback.invoke(geoOrigin, hasLocation(), false);
            geoCallback = null;
        } else if (requestCode == REQ_CAMERA && cameraRequest != null) {
            if (granted(Manifest.permission.CAMERA)) cameraRequest.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            else cameraRequest.deny();
            cameraRequest = null;
        } else if (requestCode == REQ_BACKGROUND) {
            askBatteryExemption();
        }
    }

    /** Once, after tracking first starts: "Allow all the time" keeps it working with the app closed and after a restart. */
    private void askBackgroundLocation() {
        if (Prefs.askedBackground(this) || !hasLocation()) return;
        Prefs.setAskedBackground(this);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            askBatteryExemption();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Keep attendance running")
                .setMessage("To check you out automatically when you leave the office, even with the app closed, choose \"Allow all the time\" for Location on the next screen.")
                .setPositiveButton("Continue", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        requestPermissions(new String[] { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, REQ_BACKGROUND);
                    }
                })
                .setNegativeButton("Not now", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        askBatteryExemption();
                    }
                })
                .show();
    }

    /** Battery savers stop background apps; ask to be left alone. */
    private void askBatteryExemption() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            // Some phones don't offer this screen.
        }
    }

    // ---------- page <-> native ----------
    /** Called by the website (LocationGuard). Location is only ever sent to APP_URL, whatever the page passes in. */
    private final class Bridge {
        @JavascriptInterface
        public void startTracking(final String token) {
            if (token == null || token.length() < 20) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!onOurSite()) return;
                    Prefs.setToken(MainActivity.this, token);
                    TrackingService.start(MainActivity.this);
                    askBackgroundLocation();
                }
            });
        }

        @JavascriptInterface
        public void stopTracking() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    TrackingService.stop(MainActivity.this);
                }
            });
        }

        @JavascriptInterface
        public boolean isTracking() {
            return TrackingService.running && Prefs.token(MainActivity.this) != null;
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    private boolean onOurSite() {
        String url = web.getUrl();
        return url != null && HOST.equals(Uri.parse(url).getHost());
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && HOST.equals(uri.getHost())) return false; // stay in the app
            // Everything else (mailto:, tel:, photo links, other sites) opens outside.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                // nothing can open it
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) view.loadDataWithBaseURL(null, OFFLINE_PAGE, "text/html", "UTF-8", null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush(); // keep the login across app restarts
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (hasLocation()) {
                callback.invoke(origin, true, false);
                return;
            }
            geoOrigin = origin;
            geoCallback = callback;
            requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, REQ_GEO);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsCamera = false;
            for (String r : request.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
            if (!wantsCamera || !HOST.equals(request.getOrigin().getHost())) {
                request.deny();
                return;
            }
            if (granted(Manifest.permission.CAMERA)) {
                request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
                return;
            }
            cameraRequest = request;
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAMERA);
        }

        // <input type="file"> (profile photo, CSV import)
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
