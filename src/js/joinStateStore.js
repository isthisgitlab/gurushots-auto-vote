/**
 * Persisted state for the paid-join flow, plus a cross-process unlock lock.
 *
 * joinStateStore holds "unlocked-but-not-yet-submitted" markers so a submit that
 * fails after a successful coins_unlock never triggers a second (re-charging)
 * unlock on a later cycle. It uses the same platform-aware transport as
 * settings/metadata (fs on Electron/CLI, @capacitor/preferences on Android),
 * so — exactly like metadata — its Capacitor cache MUST be hydrated at boot via
 * initializeJoinStateAsync() (wired in Capacitor.jsx) or the marker is invisible
 * after an app relaunch and a paid retry would double-charge.
 *
 * acquireUnlockLock gives cross-process mutual exclusion around the
 * check→unlock→mark critical section on the real-fs platforms (Electron/CLI),
 * where the same account can be driven by two processes at once (GUI + CLI). It
 * is a best-effort OS lockfile: it blocks a genuinely-held lock, recovers a
 * stale one past a TTL, and fails OPEN on any other lock-infra error (never
 * deadlocks a join). Capacitor/headless are single-process for a given surface,
 * so the lock is a no-op there.
 */

const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');
const logger = require('./logger');
const { createJsonStore, getSettingsPath } = require('./settings/storage');

const joinStateStore = createJsonStore({ fileName: 'joinState.json', prefKey: 'gs_join_state' });

// A held lock older than this is treated as stale (owner crashed) and removed.
const LOCK_TTL_MS = 60_000;

const lockPathFor = (id) => {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(path.dirname(getSettingsPath()), `joinlock-${safeId}.lock`);
};

/**
 * Acquire a cross-process lock for one challenge's unlock critical section.
 * @param {string|number} id
 * @returns {{ok: boolean, release: () => void}} ok=false means another process
 *   holds it right now (caller should treat as busy). release() is always safe.
 */
const acquireUnlockLock = (id) => {
    const noop = { ok: true, release: () => {} };
    // Only the real-fs platforms (Electron/CLI) can run two processes against one
    // account; Capacitor/headless are single-process for a given surface.
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return noop;

    const lockPath = lockPathFor(id);
    try {
        // Reap a stale lock (previous owner crashed without releasing).
        try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > LOCK_TTL_MS) fs.unlinkSync(lockPath);
        } catch {
            // No existing lock (ENOENT) or stat race — nothing to reap.
        }
        const fd = fs.openSync(lockPath, 'wx'); // exclusive create; throws EEXIST if held
        try {
            fs.writeSync(fd, String(process.pid));
        } finally {
            fs.closeSync(fd);
        }
        return {
            ok: true,
            release: () => {
                try {
                    fs.unlinkSync(lockPath);
                } catch {
                    // already gone
                }
            },
        };
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            return { ok: false, release: () => {} };
        }
        // Lock infrastructure failed (permissions, etc.) — fail OPEN rather than
        // block joins forever; the in-process Set + persisted claim still apply.
        logger
            .withCategory('join')
            .warning(`cross-process join lock unavailable for ${id}: ${error?.message || error}`, null);
        return noop;
    }
};

module.exports = {
    joinStateStore,
    initializeJoinStateAsync: joinStateStore.initializeAsync,
    flushJoinStateWrites: joinStateStore.flushPendingWrites,
    acquireUnlockLock,
};
