/**
 * Marks a page served by the web shell, so the renderer can tell it apart from the Electron and Android windows
 * (what happens after "Delete all local data" differs) without importing the bridge. Dependency-free.
 */

type WebShellGlobals = typeof globalThis & { webShell?: true };

/** Called by the web bridge when it installs `window.api`. */
const markWebShell = (): void => {
    (globalThis as WebShellGlobals).webShell = true;
};

/** Whether this page was installed by the web bridge. */
const isWebShell = (): boolean => (globalThis as WebShellGlobals).webShell === true;

export { markWebShell, isWebShell };
