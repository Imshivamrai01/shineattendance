package com.shineinfosolutions.attendance;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart, resume location reporting if the person was still checked in. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (Prefs.token(context) == null) return;
        // Needs "Allow all the time" location; without it the system refuses and tracking resumes when the app is opened.
        TrackingService.start(context);
    }
}
