/**
 * The Android remote mode's entries, installed by the shell whose document can
 * run them: the paste entry ("Control my computer") by the Capacitor app entry,
 * and Disconnect by the bundled remote page. react reads this module — it may
 * not import a shell — and renders an entry only while its function is
 * installed, so a desktop or browser page shows neither. Dependency-free.
 */

/** What entering remote mode came to: switched, or refused and why (a stable code the UI translates). */
export type RemoteModeEntry = {
    success: boolean;
    error?: 'bad-link' | 'update-computer' | 'update-phone' | 'service-stop' | 'settings' | 'storage';
};

/** The actions the Android remote mode's shell has installed, per document. */
export type PhoneRemoteMode = {
    /** Enters remote mode from a pasted pairing link (the app's normal mode). */
    enter?: (link: string) => Promise<RemoteModeEntry>;
    /** Leaves remote mode back to the normal app (the bundled remote page). */
    disconnect?: () => Promise<void>;
};

let installed: PhoneRemoteMode | null = null;

/**
 * Called once per document, by the shell entry, before it mounts anything — so
 * the UI sees the entries from the first render. The two shells run in separate
 * documents, each installing the entry its own document can act on.
 */
export const installPhoneRemoteMode = (parts: PhoneRemoteMode): void => {
    installed = parts;
};

/** The installed entries, or null where this document's shell installed none. */
export const phoneRemoteMode = (): PhoneRemoteMode | null => installed;
