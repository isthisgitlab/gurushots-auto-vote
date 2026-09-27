/**
 * The Android runtime globals the shared core reads: the Capacitor runtime's
 * registered plugins (main WebView) and the native bridges of the headless
 * WebView AutoVoteService owns. Type-only: nothing here exists at runtime.
 *
 * A plugin is present only when this build registered it, so every member is
 * optional and each read is guarded.
 */

/** Native `ApkInstaller` plugin (android/.../ApkInstallerPlugin.kt). */
export interface ApkInstallerPlugin {
    downloadAndInstall?(options: {
        url: string;
        version: string;
    }): Promise<{ success?: boolean; error?: string } | null>;
    addListener?(
        eventName: 'downloadProgress',
        listener: (data: { percent?: number }) => void,
    ): Promise<{ remove: () => Promise<void> } | null>;
}

/** `@capacitor/browser` as registered on the runtime global. */
export interface BrowserPlugin {
    open?(options: { url: string }): Promise<void>;
}

/** Native `AutoVoteBackground` plugin (android/.../AutoVotePlugin.kt). */
export interface AutoVoteBackgroundPlugin {
    start(): Promise<{ running: boolean }>;
    stop(): Promise<{ running: boolean }>;
    getStatus(): Promise<{ running: boolean; cycleCount: number; lastRunAt: number; lastError: string }>;
}

export interface CapacitorPlugins {
    ApkInstaller?: ApkInstallerPlugin;
    Browser?: BrowserPlugin;
    AutoVoteBackground?: AutoVoteBackgroundPlugin;
}

/** `globalThis` in the Capacitor WebView. */
export type CapacitorGlobals = typeof globalThis & { Capacitor?: { Plugins?: CapacitorPlugins } };

/** `globalThis` in the headless WebView (android/.../AutoVoteService.kt). */
export type HeadlessGlobals = typeof globalThis & {
    /** The native `@JavascriptInterface` the cycle result is reported through. */
    AndroidHeadlessBridge?: { onCycleComplete(json: string): void };
    /** The entry point the native service calls on each alarm tick. */
    GS?: { runOneCycle: () => Promise<void> };
};

/**
 * `globalThis` as the renderer reads it: the Capacitor runtime's platform
 * probe (absent on Electron), and the flag pages/Capacitor.tsx sets before
 * importing App/Login so neither auto-mounts.
 */
export type RendererGlobals = typeof globalThis & {
    Capacitor?: { isNativePlatform?: () => boolean };
    __capacitorBootstrap?: boolean;
};
