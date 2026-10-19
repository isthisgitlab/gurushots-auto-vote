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
    /** `digest` is the release asset's `sha256:<hex>` (empty when unknown: the plugin then refuses the download). */
    downloadAndInstall?(options: {
        url: string;
        version: string;
        digest: string;
    }): Promise<{ success?: boolean; error?: string } | null>;
    addListener?(
        eventName: 'downloadProgress',
        listener: (data: { percent?: number }) => void,
    ): Promise<{ remove: () => Promise<void> } | null>;
}

/** `@capacitor/browser` as registered on the runtime global. */
interface BrowserPlugin {
    open?(options: { url: string }): Promise<void>;
}

/** Native `AutoVoteBackground` plugin (android/.../AutoVotePlugin.kt). */
export interface AutoVoteBackgroundPlugin {
    start(): Promise<{ running: boolean }>;
    stop(): Promise<{ running: boolean }>;
    getStatus(): Promise<{ running: boolean; cycleCount: number; lastRunAt: number; lastError: string }>;
    /**
     * Saves a side store only if it still holds `expected` (absent or null: nothing was stored). `current` is what is
     * stored when it was not saved. Rejects a key that is not a side store, a value that is not one JSON object within
     * the size cap, and a commit that failed.
     */
    compareAndWrite(options: {
        key: string;
        expected?: string | null;
        value: string;
    }): Promise<{ saved: boolean; current: string | null }>;
    /** Stops the service, cancels its alarms and clears every native store and cache; `ok` when all of it went. */
    wipeLocalData(): Promise<{ ok: boolean }>;
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
 * probe (absent on Electron), and the flag pages/Capacitor.tsx and pages/Web.tsx
 * set before importing App/Login so neither auto-mounts.
 */
export type RendererGlobals = typeof globalThis & {
    Capacitor?: { isNativePlatform?: () => boolean };
    __capacitorBootstrap?: boolean;
};
