// A manual click and an autovote cycle can reach the same mini-game at once.
// Claim the challenge synchronously before either path starts its async work.
const inFlight = new Set<string>();
const lastManualRun = new Map<string, number>();
let manualRunRevision = 0;

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
