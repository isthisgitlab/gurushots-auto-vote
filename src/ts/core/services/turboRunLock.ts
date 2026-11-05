// A manual click and an autovote cycle can reach the same mini-game at once.
// Claim the challenge synchronously before either path starts its async work.
const inFlight = new Set<string>();
const lastManualRun = new Map<string, number>();
const snapAutoCooldownUntil = new Map<string, number>();
let manualRunRevision = 0;

export const SNAP_AUTO_COOLDOWN_MS = 15 * 60 * 1000;

export const turboRunSnapshot = (): number => manualRunRevision;

export const wasManualTurboRunSince = (challengeId: string | number, snapshot: number): boolean =>
    (lastManualRun.get(String(challengeId)) ?? 0) > snapshot;

export const claimTurboRun = (challengeId: string | number): boolean => {
    const key = String(challengeId);
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    return true;
};

export const releaseTurboRun = (challengeId: string | number, source: 'manual' | 'automatic'): void => {
    const key = String(challengeId);
    if (source === 'manual') lastManualRun.set(key, ++manualRunRevision);
    inFlight.delete(key);
};

// Challenges whose Snap game turned out not to be playable (no longer offered, an unreadable question, a dead
// session): the bot leaves this challenge's turbo alone for the rest of the process. A manual run ignores the
// marker, so the user can retry.
const snapUnavailable = new Set<string>();

export const markSnapUnavailable = (challengeId: string | number): void => {
    snapUnavailable.add(String(challengeId));
};

export const isSnapUnavailable = (challengeId: string | number): boolean => snapUnavailable.has(String(challengeId));

/** Delay automatic Snap play after repeated transient failures. Manual play does not check this state. */
export const startSnapAutoCooldown = (challengeId: string | number, nowMs: number): void => {
    snapAutoCooldownUntil.set(String(challengeId), nowMs + SNAP_AUTO_COOLDOWN_MS);
};

export const isSnapAutoCoolingDown = (challengeId: string | number, now = Date.now()): boolean => {
    const key = String(challengeId);
    const until = snapAutoCooldownUntil.get(key);
    if (until === undefined) return false;
    if (until <= now) {
        snapAutoCooldownUntil.delete(key);
        return false;
    }
    return true;
};

export const clearSnapAutoCooldown = (challengeId: string | number): void => {
    snapAutoCooldownUntil.delete(String(challengeId));
};

export const __resetSnapUnavailableForTests = (): void => {
    snapUnavailable.clear();
    snapAutoCooldownUntil.clear();
};
