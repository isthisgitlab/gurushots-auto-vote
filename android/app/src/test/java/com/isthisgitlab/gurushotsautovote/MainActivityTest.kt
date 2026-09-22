package com.isthisgitlab.gurushotsautovote

import android.content.pm.PackageInfo
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ServiceWorkerWebSettings
import io.mockk.mockk
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(shadows = [MainActivityTest.ShadowServiceWorkerController::class])
class MainActivityTest {

    /**
     * Robolectric has no WebView provider, so the real
     * ServiceWorkerController.getInstance() (called by Capacitor's Bridge)
     * throws. Hand the bridge an inert controller instead.
     */
    @Implements(ServiceWorkerController::class)
    class ShadowServiceWorkerController {
        companion object {
            @JvmStatic
            @Implementation
            @Suppress("DEPRECATION") // the framework's own constructor is @Deprecated
            fun getInstance(): ServiceWorkerController = object : ServiceWorkerController() {
                override fun getServiceWorkerWebSettings(): ServiceWorkerWebSettings = mockk(relaxed = true)
                override fun setServiceWorkerClient(client: ServiceWorkerClient?) = Unit
            }
        }
    }

    @Test
    fun registersCustomPluginsWithTheBridge() {
        // Capacitor refuses to start on a WebView older than its minimum.
        ShadowWebView.setCurrentWebViewPackage(
            PackageInfo().apply {
                packageName = "com.google.android.webview"
                versionName = "140.0.0.0"
            },
        )
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val activity = controller.setup().get()
            assertNotNull(activity.bridge.getPlugin("AutoVoteBackground"))
            assertNotNull(activity.bridge.getPlugin("ApkInstaller"))
        }
    }
}
