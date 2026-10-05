package com.shineinfosolutions.attendance;

import android.content.Context;
import android.content.SharedPreferences;

/** Small persistent state shared by the screen, the location service and the boot receiver. */
final class Prefs {
    private static final String FILE = "tracking";
    private static final String TOKEN = "token";
    private static final String ASKED_BACKGROUND = "askedBackground";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The tracking token issued by the server at check-in; null when nothing should be tracked. */
    static String token(Context c) {
        return sp(c).getString(TOKEN, null);
    }

    static void setToken(Context c, String token) {
        sp(c).edit().putString(TOKEN, token).apply();
    }

    static void clearToken(Context c) {
        sp(c).edit().remove(TOKEN).apply();
    }

    static boolean askedBackground(Context c) {
        return sp(c).getBoolean(ASKED_BACKGROUND, false);
    }

    static void setAskedBackground(Context c) {
        sp(c).edit().putBoolean(ASKED_BACKGROUND, true).apply();
    }
}
