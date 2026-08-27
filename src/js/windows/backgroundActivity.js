/**
 * Keeps the Electron main process schedulable while auto-vote is running.
 *
 * WHY THIS EXISTS: the GUI's cadence chain
 * (react/contexts/AutovoteContext.jsx -> scheduling/cadenceChain.js) is a
 * recursive `setTimeout` living in the RENDERER. Two OS/Chromium mechanisms
 * can stop that timer dead while the app is merely in the background, with no
 * error and no log line:
 *
 *   1. Chromium's hidden-page timer throttling / page freezing — handled by
 *      `backgroundThrottling: false` on the window (see index.js).
 *   2. macOS App Nap — the OS suspends the whole app. No renderer flag helps;
 *      the process must hold a power assertion.
 *
 * The observed failure was a 51-minute gap between voting cycles on a 3-4
 * minute cadence, which swallowed a challenge's last auto-fill slot AND its
 * emergency-fill window. For an app whose entire job is to act on other
 * people's deadlines, "the timer didn't fire" is a correctness bug, not a
 * power-usage nicety.
 *
 * SCOPE: `prevent-app-suspension` only — it keeps the process running with the
 * display free to sleep. It is deliberately NOT `prevent-display-sleep`: we
 * need CPU time, not the user's screen.
 *
 * The blocker is held ONLY while auto-vote is running, so a stopped session
 * costs nothing. `sync()` is idempotent and never throws: a failure here must
 * degrade to today's behavior (a possibly-napping app), never break startup or
 * the start/stop path.
 */

const { powerSaveBlocker } = require('electron');
const logger = require('../logger');

// The single held assertion id, or null when nothing is held. Module-level for
// the same reason settingsWatcher's debounce handle is: there is exactly one
// main process and exactly one auto-vote session in it.
let blockerId = null;

/**
 * Start/stop the app-suspension blocker to match the auto-vote running flag.
 *
 * @param {boolean} running - is auto-vote currently running?
 * @returns {boolean} whether a blocker is held after this call (for tests /
 *   callers that want to assert state; callers may ignore it)
 */
const syncBackgroundActivity = (running) => {
    try {
        if (running) {
            // isStarted() guards against a stale id: Electron can end a
            // blocker on its own (e.g. teardown), and re-using a dead id
            // would leave us believing we are protected when we are not.
            if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return true;
            blockerId = powerSaveBlocker.start('prevent-app-suspension');
            logger
                .withCategory('voting')
                .debug('backgroundActivity: holding prevent-app-suspension while auto-vote runs', null);
            return true;
        }
        if (blockerId !== null) {
            if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
            blockerId = null;
            logger.withCategory('voting').debug('backgroundActivity: released prevent-app-suspension', null);
        }
        return false;
    } catch (error) {
        // Best-effort by design — see the header. Drop the id so a later sync
        // can try again from a clean slate rather than trusting a half-started
        // assertion.
        blockerId = null;
        logger
            .withCategory('voting')
            .warning(`backgroundActivity: power-save blocker unavailable: ${error?.message || error}`, null);
        return false;
    }
};

module.exports = { syncBackgroundActivity };
