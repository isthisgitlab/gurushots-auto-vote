package com.isthisgitlab.gurushotsautovote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate so the
        // Capacitor bridge picks them up during plugin initialization.
        registerPlugin(AutoVotePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
