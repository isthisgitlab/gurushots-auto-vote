/**
 * Headless background entry point (Android foreground service).
 *
 * Loaded in a bare WebView owned by AutoVoteService — there is NO
 * Capacitor runtime here. `headless.html` sets `window.__GS_HEADLESS__`
 * so runtime.isHeadlessService() is true, which routes the settings and
 * HTTP layers through the native @JavascriptInterface bridges
 * (AndroidHeadlessStore / AndroidHeadlessHttp) instead of
 * @capacitor/preferences / CapacitorHttp.
 *
 * The native service calls `GS.runOneCycle()` on each AlarmManager tick.
 * We run ONE full voting cycle via the existing orchestrator
 * (fetchChallengesAndVote — boost/turbo/auto-fill/vote, i.e. full parity
 * with the desktop scheduler), compute the next cadence with the shared
 * threshold/random-delay helpers, and report {ok, nextDelayMs, ...} back
 * through AndroidHeadlessBridge.onCycleComplete so the service can
 * schedule the next alarm. Reusing the JS keeps a single source of truth
 * rather than re-porting the strategy to Kotlin.
 */

const settings = require('../settings');
const apiFactory = require('../apiFactory');
const logger = require('../logger');
const { getRandomCheckFrequencyMs } = require('../scheduling/randomDelay');
const { isAnyChallengeInThresholdWindow } = require('../scheduling/thresholdWindow');

const log = (msg, data) => logger.withCategory('voting').info(`[headless] ${msg}`, data);

/**
 * Mirror the scheduler's cadence decision for a single tick: fixed
 * last-minute frequency when any challenge is inside its window, else a
 * fresh random delay in [checkFrequencyMin, checkFrequencyMax]. Returned
 * to native so AlarmManager schedules the next cycle accordingly.
 */
const computeNextDelayMs = async (token) => {
    const userSettings = settings.loadSettings();
    try {
        const { challenges } = await apiFactory.getApiStrategy().getActiveChallenges(token);
        const list = challenges || [];
        const now = Math.floor(Date.now() / 1000);
        const resolveThreshold = (id) => settings.getEffectiveSetting('lastMinuteThreshold', id);
        if (await isAnyChallengeInThresholdWindow(list, now, resolveThreshold)) {
            const freq = Number(settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global')) || 1;
            return Math.max(1, freq) * 60_000;
        }
    } catch (err) {
        log('next-delay computation failed; using normal cadence', err.message);
    }
    return getRandomCheckFrequencyMs(userSettings);
};

const reportComplete = (payload) => {
    try {
        globalThis.AndroidHeadlessBridge?.onCycleComplete(JSON.stringify(payload));
    } catch (err) {
        log('onCycleComplete failed', err.message);
    }
};

const fallbackDelay = () => getRandomCheckFrequencyMs(settings.loadSettings());

const runOneCycle = async () => {
    try {
        const token = settings.getSetting('token');
        if (!token) {
            log('no token — skipping cycle (log in via the app first)');
            return reportComplete({ ok: false, error: 'no-token', nextDelayMs: fallbackDelay() });
        }
        if (settings.getSetting('mock')) {
            log('mock mode — headless cycle is a no-op');
            return reportComplete({ ok: true, skipped: 'mock', nextDelayMs: fallbackDelay() });
        }

        log('cycle starting');
        const result = await apiFactory.getApiStrategy().fetchChallengesAndVote(token);
        const ok = result ? result.success !== false : false;
        const nextDelayMs = await computeNextDelayMs(token);
        log('cycle complete', { ok, nextDelayMs });
        reportComplete({ ok, message: (result && (result.message || result.error)) || null, nextDelayMs });
    } catch (err) {
        log('cycle threw', err && err.message);
        reportComplete({ ok: false, error: (err && err.message) || 'cycle-failed', nextDelayMs: fallbackDelay() });
    }
};

globalThis.GS = { runOneCycle };
log('headless bundle loaded');

module.exports = { runOneCycle, computeNextDelayMs };
