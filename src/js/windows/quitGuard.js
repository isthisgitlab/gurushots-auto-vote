/**
 * "Are you sure?" gate on quitting (or closing the main window) while
 * auto-vote is running and is about to boost a challenge.
 *
 * WHY: the cadence chain lives in the main window's renderer, and auto-boost
 * waits until the configured Boost Time before the window closes. Quitting in
 * that gap silently forfeits the boost — e.g. a quit 19 minutes before a
 * boost deadline, relaunched after it has passed.
 *
 * Only boosts due within QUIT_WARN_HORIZON_SEC ask: an open window whose boost
 * is hours or days away (a key-unlocked boost has no expiry of its own) loses
 * nothing if the app is back before then, and a prompt on every quit would
 * just train "Quit anyway". "Due" is the boost row of describeDeadlineActions —
 * the same instant the deadline timeline and notifications show, with the
 * autoBoost / Boost Time 0 = off / turbo-conflict gating already applied.
 *
 * The main process does not poll the API itself; it remembers the last
 * challenge list the renderer fetched through `get-active-challenges` (the
 * cadence chain and the list view both refresh through it). Window expiry is
 * checked against the wall clock at quit time; a boost applied since the last
 * fetch can prompt once more, which is the cheap side to err on.
 *
 * State is module-level for the same reason backgroundActivity's is: one main
 * process, one main window. `resetQuitGuard` runs when that window closes, so
 * a confirmation or a stale list never outlives the session it was about.
 */

const logger = require('../logger');
const votingLogic = require('../services/VotingLogic');
const { openBoostWindows } = require('../voting/boostWindow');
const { formatDuration } = require('../format/duration');

const QUIT_WARN_HORIZON_SEC = 60 * 60;
// A bypass is for the quit already under way; if that quit never lands (a
// cancelled OS shutdown, a failed update install) the guard comes back.
const BYPASS_TTL_MS = 30_000;

// Last successful challenge list from get-active-challenges.
let lastChallenges = [];
let bypassed = false;
let bypassTimer = null;
// A second Cmd+Q while the dialog is up must not stack another dialog.
let prompting = false;

const rememberChallenges = (challenges) => {
    if (Array.isArray(challenges)) lastChallenges = challenges;
};

const clearBypass = () => {
    bypassed = false;
    if (bypassTimer) clearTimeout(bypassTimer);
    bypassTimer = null;
};

// For quits the user did not start from the app (OS shutdown, signals) or
// already confirmed another way (installing an update, logging out), and for
// re-issuing a quit the user just confirmed.
const bypassQuitGuard = () => {
    clearBypass();
    bypassed = true;
    bypassTimer = setTimeout(clearBypass, BYPASS_TTL_MS);
    bypassTimer.unref?.();
};

const resetQuitGuard = () => {
    lastChallenges = [];
    prompting = false;
    clearBypass();
};

/**
 * Open boost windows whose boost auto-vote would apply within the horizon,
 * soonest first.
 *
 * @param {number} now - Unix seconds
 * @param {(challenge: object, now: number) => {actions: Array<{action: string, dueAt: number|null}>}} describe
 * @returns {Array<{title: string, dueIn: number}>}
 */
const imminentBoosts = (now, describe) => {
    const open = new Set(openBoostWindows(lastChallenges, now).map((w) => w.id));
    return lastChallenges
        .filter((c) => open.has(c.id))
        .map((c) => ({ title: c.title, dueAt: describe(c, now)?.actions?.find((a) => a.action === 'boost')?.dueAt }))
        .filter((b) => typeof b.dueAt === 'number' && b.dueAt - now <= QUIT_WARN_HORIZON_SEC)
        .map((b) => ({ title: b.title, dueIn: b.dueAt - now }))
        .sort((a, b) => a.dueIn - b.dueIn);
};

const describeBoost = (b, t) =>
    `• ${b.title} — ${b.dueIn <= 0 ? t('quitGuard.dueNow') : t('quitGuard.dueIn').replace('{time}', formatDuration(b.dueIn))}`;

/**
 * Hold a quit/close that would forfeit an imminent boost, and ask.
 *
 * @param {{ preventDefault: () => void }} event - the before-quit / close event
 * @param {object} deps
 * @param {boolean} deps.autovoteRunning - nothing is lost when auto-vote is stopped
 * @param {{ showMessageBox: Function }} deps.dialog - Electron dialog
 * @param {object|null} deps.parent - window to attach the dialog to, if still alive
 * @param {(key: string) => string} deps.t - translator
 * @param {() => void} deps.proceed - re-issues the quit/close once confirmed
 * @param {number} [deps.now] - Unix seconds
 * @param {Function} [deps.describeDeadlineActions] - test seam
 * @returns {boolean} true when the event was held
 */
const holdQuitForOpenBoosts = (
    event,
    {
        autovoteRunning,
        dialog,
        parent,
        t,
        proceed,
        now = Math.floor(Date.now() / 1000),
        describeDeadlineActions = votingLogic.describeDeadlineActions,
    },
) => {
    if (bypassed || !autovoteRunning) return false;
    let boosts;
    try {
        boosts = imminentBoosts(now, describeDeadlineActions);
    } catch (error) {
        // Runs inside before-quit: a throw here must never make the app unquittable.
        logger.withCategory('ui').error('Quit guard could not read boost state — not asking:', error);
        return false;
    }
    if (boosts.length === 0) return false;

    event.preventDefault();
    if (prompting) return true;
    prompting = true;

    const options = {
        type: 'warning',
        buttons: [t('quitGuard.keepRunning'), t('quitGuard.quitAnyway')],
        defaultId: 0,
        cancelId: 0,
        message: t('quitGuard.title'),
        detail: `${t('quitGuard.detail')}\n\n${boosts.map((b) => describeBoost(b, t)).join('\n')}`,
    };
    const shown =
        parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);

    const confirm = () => {
        bypassQuitGuard();
        proceed();
    };
    // Two-argument then: only a failed dialog lands in the error branch, so
    // `proceed` can never run twice.
    void Promise.resolve(shown).then(
        ({ response }) => {
            prompting = false;
            if (response !== 1) return;
            logger.withCategory('ui').info(`Quit confirmed with ${boosts.length} boost(s) due`, null);
            confirm();
        },
        (error) => {
            // A broken dialog must never make the app unquittable.
            prompting = false;
            logger.withCategory('ui').error('Quit confirmation failed — quitting anyway:', error);
            confirm();
        },
    );
    return true;
};

module.exports = {
    rememberChallenges,
    bypassQuitGuard,
    resetQuitGuard,
    holdQuitForOpenBoosts,
    QUIT_WARN_HORIZON_SEC,
    BYPASS_TTL_MS,
};
