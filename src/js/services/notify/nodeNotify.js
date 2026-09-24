/**
 * Node-host delivery for the deadline-action OS notifications (the CLI's
 * continuous scheduler). Injected into the shared cadence chain as its
 * onCycleChallenges hook, exactly like the renderer's deadlineNotifier — same
 * pure decision core (services/deadlineNotifications.js), different transport:
 * describeDeadlineActions is called directly (this side HAS the settings facade,
 * unlike the renderer which goes over IPC), and delivery shells out to an OS
 * builtin.
 *
 * Why not node-notifier: the CLI ships as a single SEA binary (esbuild bundle →
 * postject), with no node_modules on disk — node-notifier's bundled helper
 * binary would not resolve at runtime. The OS builtins (`osascript` on macOS,
 * `notify-send` on Linux) need no dependency, ship with the OS, and remove
 * node-notifier's command-injection CVE surface entirely.
 *
 * Security: title/body arrive already sanitized by the decision module (control
 * chars, RTL/zero-width, leading dashes stripped, length-capped). Delivery adds
 * transport-specific hardening on top: execFile (never a shell), AppleScript
 * string-literal escaping, and Pango-markup escaping for notify-send.
 */

const { execFile } = require('node:child_process');
const votingLogic = require('../VotingLogic');
const settings = require('../../settings');
const logger = require('../../logger');
const {
    computeDueNotifications,
    createDedupe,
    formatNotification,
    readNotificationConfig,
} = require('../deadlineNotifications');
const { createTranslator } = require('../../translations/translator');

const notifyTranslator = createTranslator();

/**
 * Resolve a raw i18n template in the user's saved language through the shared
 * translator core (same English fallback as the UI). Returns the key itself
 * when it doesn't resolve to a string, so the notification still shows
 * something.
 * @param {string} key - dotted key, e.g. 'app.notifyBody'
 * @returns {string}
 */
const nodeTranslate = (key) => {
    try {
        const resolved = notifyTranslator.t(String(key), settings.getSetting('language'));
        return typeof resolved === 'string' ? resolved : key;
    } catch {
        return key;
    }
};

// AppleScript string-literal escape: backslash first, then double-quote.
const escapeAppleScript = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// notify-send renders a limited Pango markup subset in the body; escape the
// markup-significant chars so a crafted title can't inject markup. (The
// decision module already stripped control chars / RTL.)
const escapePango = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Deliver one notification via the platform's builtin notifier. macOS →
 * osascript `display notification`; Linux → notify-send. Any other platform (or
 * a missing builtin) is a silent no-op — the callback swallows spawn errors so a
 * missing `notify-send` on a headless box can never bubble into the scheduler.
 *
 * @param {{title:string, body:string}} notification
 */
const deliverOsNotification = ({ title, body }) => {
    try {
        if (process.platform === 'darwin') {
            const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
            execFile('osascript', ['-e', script], () => {});
        } else if (process.platform === 'linux') {
            // '--' guards against any residual leading-dash content being read as
            // an option (belt-and-suspenders; the decision module already strips
            // leading dashes).
            execFile('notify-send', ['--', escapePango(title), escapePango(body)], () => {});
        }
        // win32 / others: no shipped CLI target uses them for notifications.
    } catch {
        /* spawn failure — notifications are best-effort, never fatal */
    }
};

/**
 * Build the Node per-cycle notifier. Holds the dedupe Set + re-entrancy guard,
 * so create ONE instance per scheduler and reuse it across cycles.
 *
 * @param {Object} [deps] - injectable seams (defaults wire the real facade)
 * @param {(challenge:Object, now:number)=>{actions:Array}} [deps.describeDeadlineActions]
 * @param {(key:string)=>*} [deps.getSetting]
 * @param {(key:string)=>string} [deps.translate]
 * @param {(n:{title:string, body:string})=>void} [deps.deliver]
 * @returns {(challenges:Array, now:number)=>Promise<void>}
 */
const createNodeDeadlineNotifier = (deps = {}) => {
    const describeDeadlineActions = deps.describeDeadlineActions || votingLogic.describeDeadlineActions;
    const getSetting = deps.getSetting || ((key) => settings.getSetting(key));
    const translate = deps.translate || nodeTranslate;
    const deliver = deps.deliver || deliverOsNotification;

    const dedupe = createDedupe();
    let running = false;

    return async (challenges, now) => {
        if (running) return;
        running = true;
        try {
            const config = readNotificationConfig(getSetting);
            if (!config.anyEnabled) return; // feature off (default) → zero work

            const list = Array.isArray(challenges) ? challenges : [];
            const perChallengeActions = [];
            for (const challenge of list) {
                try {
                    const { actions } = describeDeadlineActions(challenge, now) || {};
                    perChallengeActions.push({
                        id: challenge?.id,
                        title: challenge?.title,
                        actions: Array.isArray(actions) ? actions : [],
                    });
                } catch {
                    // A single malformed challenge must not sink the batch.
                }
            }

            const due = computeDueNotifications(perChallengeActions, now, config);
            const fresh = dedupe.filterNew(due);
            const notification = formatNotification(fresh, translate);
            if (notification) deliver(notification);
        } catch (error) {
            // Best-effort: notifications must never disturb voting.
            logger.withCategory('voting').debug('deadline notification cycle failed', error?.message ?? String(error));
        } finally {
            running = false;
        }
    };
};

module.exports = {
    createNodeDeadlineNotifier,
    deliverOsNotification,
    nodeTranslate,
    // exported for unit tests
    escapeAppleScript,
    escapePango,
};
