/**
 * The join-timing window for one un-joined challenge: the three `0 = off`
 * join-timing settings collapse to the ONE window that governs it, and the
 * after-start clamp read the join pass logs its note from. Pure — no I/O and no
 * settings reads; the caller resolves both. Part of the services/VotingLogic
 * facade; `shouldJoinChallenge` (joinDecision.ts) consumes the window as one
 * veto in its list of vetoes.
 */

// Mirrors MAX_JOIN_PERCENT_ELAPSED in settings/schema/validators.ts (which this
// renderer-bundle-safe module cannot import) — change both together.
const MAX_REACHABLE_PERCENT_ELAPSED = 99;

/**
 * The one clamp both after-start readers share: an offset at or beyond the
 * challenge's own length degrades to the latest REACHABLE point (99% of the
 * run — the seconds form of MAX_REACHABLE_PERCENT_ELAPSED), never to "never
 * join". `joinWindowRefusal` joins against it; `joinAfterStartClamped`
 * reports it, so the join pass can note the reduction.
 */
const clampAfterStartOffsetSec = (offsetSec: number, durationSec: number): number =>
    Math.min(offsetSec, (MAX_REACHABLE_PERCENT_ELAPSED / 100) * durationSec);

/**
 * Collapse the three join-timing settings into the ONE window that governs a
 * candidate.
 *
 * A candidate is never gated by more than one at once. The settings are read in
 * a fixed order — after-start (seconds since the challenge's own `start_time`),
 * then percent elapsed, then hours before end — and the FIRST with a value
 * above 0 applies, each being the more specific instruction than the ones below
 * it. The settings schema resolves the three as one group upstream
 * (`resolveRuleSettingGroup` in settings/titleRules.ts), so no source can
 * contribute a second window on top of the winning one; each sentinel stays
 * `0 = off`.
 *
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 * @param joinWithinSec seconds before close_time to start joining (0 = off)
 * @param percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 */
const resolveJoinWindow = (
    joinAfterSecFromStart: number,
    joinWithinSec: number,
    percentElapsed: number,
): { mode: 'afterStart' | 'percent' | 'hours' | 'off'; value: number } => {
    if (Number.isFinite(joinAfterSecFromStart) && joinAfterSecFromStart > 0) {
        return { mode: 'afterStart', value: joinAfterSecFromStart };
    }
    if (Number.isFinite(percentElapsed) && percentElapsed > 0) {
        // Clamp to the latest REACHABLE fraction. 100% is only true once
        // close_time has passed, and joinWindowRefusal rejects an already-closed
        // candidate before it reads the fraction at all — so a corrupted 100 (or
        // 1000) must degrade to "as late as possible", never to "never join".
        return { mode: 'percent', value: Math.min(percentElapsed, MAX_REACHABLE_PERCENT_ELAPSED) };
    }
    if (Number.isFinite(joinWithinSec) && joinWithinSec > 0) {
        return { mode: 'hours', value: joinWithinSec };
    }
    return { mode: 'off', value: 0 };
};

/**
 * The join-window half of the auto-join decision, kept separate so the main
 * decision reads as one list of vetoes.
 *
 * Returns the refusal reason, or null when the window does not veto — either
 * because no window is set (every sentinel 0 = off: join as soon as seen) or
 * because the candidate is inside it.
 *
 * FAIL-CLOSED: a candidate that cannot prove it is inside the window (no
 * readable `close_time`, no readable clock, or already past its close) is
 * refused. "Join only near the end" must never degrade into "join now" on a
 * payload this could not read. Percent mode reads one field more —
 * `start_time`, to know how long the challenge runs — and is fail-closed on it
 * for the same reason: without a length, a percentage means nothing, and
 * guessing one would spend the entry at exactly the moment the setting exists
 * to avoid. The after-start window anchors on that same `start_time` and is
 * fail-closed on it identically: without it there is nothing to measure the
 * wait against.
 *
 * @param joinWithinSec seconds before close_time to start joining (0 = off)
 * @param nowSec current time in epoch SECONDS (close_time's unit)
 * @param percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 */
const joinWindowRefusal = (
    challenge: { close_time?: number; start_time?: number },
    joinWithinSec: number,
    nowSec: number,
    percentElapsed: number,
    joinAfterSecFromStart: number,
): string | null => {
    const window = resolveJoinWindow(joinAfterSecFromStart, joinWithinSec, percentElapsed);
    if (window.mode === 'off') return null;

    const closeTime = Number(challenge?.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(nowSec) || nowSec <= 0) {
        return 'close-time-unknown';
    }
    const secondsLeft = closeTime - nowSec;
    // Already closed (a stale entry in the open list) — joining would burn a
    // submission on a dead challenge.
    if (secondsLeft <= 0) return 'already-closed';

    if (window.mode === 'afterStart') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no anchor to measure the wait from, so refuse.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp to the latest REACHABLE point — the same ceiling as percent
        // mode: a value at or beyond the challenge's own length must degrade
        // to "as late as possible", never to "never join".
        // Deliberately NO clamp at 0 on the elapsed side: a start_time in the
        // future (clock skew) gives negative elapsed, below any positive
        // offset — 'too-early', never a join.
        const elapsedSec = nowSec - startTime;
        return elapsedSec < clampAfterStartOffsetSec(window.value, durationSec) ? 'too-early' : null;
    }

    if (window.mode === 'percent') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no fraction to compute, so refuse rather than divide.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp below at 0 so a challenge whose start_time is in the future
        // (clock skew) reads as 0% elapsed rather than negative.
        const elapsedPct = (Math.max(0, nowSec - startTime) / durationSec) * 100;
        return elapsedPct < window.value ? 'too-early' : null;
    }

    return secondsLeft > window.value ? 'too-early' : null;
};

/**
 * Whether the clamp reduced the after-start offset — the one boolean the join
 * pass needs to decide its clamp note, read over `joinWindowRefusal`'s exact
 * math, never a second implementation of it (both call
 * `clampAfterStartOffsetSec`).
 *
 * True requires the after-start window to be the active gate — a value above 0
 * IS after-start mode, the first timing key above 0 winning — and the candidate
 * still open: every state where `joinWindowRefusal` refuses before consulting
 * the offset ('close-time-unknown', 'already-closed', 'start-time-unknown')
 * reads as false here, and so does a value the clamp left alone.
 *
 * @param challenge the candidate, read for `close_time`/`start_time` only
 * @param nowSec current time in epoch SECONDS (close_time's unit)
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 */
const joinAfterStartClamped = (
    challenge: { close_time?: number; start_time?: number },
    nowSec: number,
    joinAfterSecFromStart: number,
): boolean => {
    if (!Number.isFinite(joinAfterSecFromStart) || joinAfterSecFromStart <= 0) return false;
    const closeTime = Number(challenge?.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(nowSec) || nowSec <= 0) return false;
    // Already closed: the gate reports 'already-closed' and never reads the offset.
    if (closeTime <= nowSec) return false;
    const startTime = Number(challenge?.start_time);
    if (!Number.isFinite(startTime) || startTime <= 0) return false;
    const durationSec = closeTime - startTime;
    if (durationSec <= 0) return false;
    return clampAfterStartOffsetSec(joinAfterSecFromStart, durationSec) < joinAfterSecFromStart;
};

export { joinWindowRefusal, joinAfterStartClamped };
