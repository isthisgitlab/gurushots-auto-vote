// @ts-check
/**
 * Pure decision layer for the "deadline action coming up" OS notifications.
 *
 * Shared by every host (Electron renderer, CLI/Node scheduler, Capacitor
 * foreground, Android headless) exactly like voting/boostWindow.js: NO Node,
 * NO settings facade, NO zod — so it is safe in the WebView bundle too. Each
 * host feeds it the per-challenge deadline actions it already has
 * (describeDeadlineActions on the Node side, get-deadline-actions over IPC on
 * the renderer side) and owns delivery; this module only decides WHICH actions
 * are due, dedupes them, and formats the text.
 *
 * CJS on purpose (mirrors boostWindow.js / cadenceChain.js): required directly
 * by the Node hosts and imported by the esbuild-bundled renderer.
 *
 * Security: the `title` here is the raw GuruShots challenge title
 * (src/js/api/challenges.js) — server-supplied and attacker-influenceable, not
 * app-authored. Every string that leaves this module is passed through
 * sanitizeNotificationText first (mirrors logger.sanitizeLogString) so a
 * crafted title cannot forge a multi-line "system" toast, inject notify-send
 * Pango markup, or look like a CLI flag to an argv-based notifier.
 */

/**
 * Action key → translation key for its user-facing label. Owned here (the pure,
 * Node-safe module) rather than in the React DeadlineTimeline so both the
 * timeline and the Node notify path can reuse it without pulling React into a
 * Node/headless bundle. DeadlineTimeline.jsx imports this. Indexed by a dynamic
 * action string (from server data), so typed with a string index.
 * @type {Record<string, string>}
 */
const ACTION_LABEL_KEY = {
    autoFill: 'app.deadlineActionAutoFill',
    boost: 'app.deadlineActionBoost',
    turbo: 'app.deadlineActionTurbo',
    emergencyFill: 'app.deadlineActionEmergencyFill',
};

/**
 * The settings key that gates each action. Indexed by a dynamic action string.
 * @type {Record<string, string>}
 */
const NOTIFY_SETTING_KEYS = {
    autoFill: 'notifyOnAutoFill',
    boost: 'notifyOnBoost',
    turbo: 'notifyOnTurbo',
    emergencyFill: 'notifyOnEmergencyFill',
};

const MAX_TEXT_LEN = 120;

/**
 * Bound an untrusted string before it reaches an OS notifier UI or an argv
 * notifier. All whitespace (incl. CR/LF/TAB) collapses to single spaces so a
 * title cannot forge extra lines; all Unicode "Other" code points (control +
 * format, i.e. remaining control chars, zero-width and RTL-override spoofing
 * chars) are removed; a leading dash run is stripped so the value can never be
 * read as a `--flag`; the result is trimmed and length-capped. Mirrors
 * logger.sanitizeLogString's intent.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
const sanitizeNotificationText = (value, maxLength = MAX_TEXT_LEN) =>
    String(value ?? '')
        // First collapse turns CR/LF/TAB into single spaces (newlines must
        // become a space, not vanish, or words would merge). Then strip the
        // remaining Unicode "Other" code points (non-space controls, zero-width,
        // RTL overrides). A control char sitting between two spaces would leave a
        // double space, so collapse once more afterwards.
        .replace(/\s+/g, ' ')
        .replace(/\p{C}/gu, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s-]+/, '')
        .trim()
        .slice(0, maxLength);

/**
 * Fill `{placeholder}` tokens in a translated template. The app's translation
 * layer (translations/index.js `t()`) does no interpolation of its own, so the
 * templates carry `{minutes}` / `{title}` / `{count}` and we substitute here.
 * Unknown tokens are left intact rather than blanked.
 *
 * @param {unknown} template
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
const interpolate = (template, params) =>
    String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (params[key] != null ? String(params[key]) : match));

/**
 * Decide which upcoming actions are within the notification lead window.
 *
 * @param {Array<{id:*, title:*, actions:*}>} perChallengeActions - one entry per
 *   challenge; `actions` is describeDeadlineActions' output (`[{action, dueAt}]`,
 *   `dueAt` = absolute Unix seconds the action fires, or null/NaN when unknown).
 * @param {number} now - Unix timestamp (seconds)
 * @param {{leadSec:number, enabled:Partial<Record<string, boolean>>}} opts
 * @returns {Array<{fireKey:string, challengeId:string, title:string, action:string, dueAt:number, secondsUntil:number}>}
 */
const computeDueNotifications = (perChallengeActions, now, opts) => {
    /** @type {Array<{fireKey:string, challengeId:string, title:string, action:string, dueAt:number, secondsUntil:number}>} */
    const due = [];
    const leadSec = Number(opts?.leadSec);
    const enabled = opts?.enabled || {};
    // Nothing enabled, or a non-positive lead window → nothing is ever due.
    if (!Array.isArray(perChallengeActions) || !(leadSec > 0)) return due;

    for (const challenge of perChallengeActions) {
        if (!challenge || typeof challenge !== 'object') continue;
        const challengeId = challenge.id != null ? String(challenge.id) : '';
        if (!challengeId) continue;
        const title = sanitizeNotificationText(challenge.title);
        const actions = Array.isArray(challenge.actions) ? challenge.actions : [];

        for (const entry of actions) {
            if (!entry || typeof entry !== 'object') continue;
            const action = entry.action;
            if (enabled[action] !== true) continue;
            const dueAt = Number(entry.dueAt);
            // null/NaN close_time → dueAt non-finite (see describeDeadlineActions
            // JSDoc). Expected input, never a throw.
            if (!Number.isFinite(dueAt)) continue;
            const secondsUntil = dueAt - now;
            // Strictly upcoming and inside the lead window. Past-due (<= 0) is
            // the app's own business, not a "coming up" warning.
            if (secondsUntil <= 0 || secondsUntil > leadSec) continue;

            due.push({
                // dueAt pins the specific window instance: a re-granted boost has
                // a new dueAt → new key → fires again, while the same pending
                // window keeps one stable key and never double-fires.
                fireKey: `${challengeId}:${action}:${dueAt}`,
                challengeId,
                title,
                action,
                dueAt,
                secondsUntil,
            });
        }
    }
    return due;
};

/**
 * In-memory fire-once gate. Keeps a Set of already-fired fireKeys; each call
 * returns only the keys not seen before and prunes keys that are no longer due,
 * so the Set stays bounded to the currently-due set across a long-running
 * session.
 *
 * NOTE (deliberate tradeoff): state is in-memory and per-process. A process
 * restart while a window is still due may re-fire that one notification once,
 * and running two hosts against the same account (e.g. the CLI daemon and the
 * desktop app at once) will each notify independently for the same window —
 * there is no cross-process coordination. Both are accepted; do NOT migrate
 * this to a persisted/shared store without re-litigating the tradeoff, or a
 * stale key could permanently suppress a real warning.
 *
 * @returns {{ filterNew: (due: Array<{fireKey:string}>) => Array<any> }}
 */
const createDedupe = () => {
    /** @type {Set<string>} */
    const fired = new Set();
    return {
        filterNew(due) {
            const list = Array.isArray(due) ? due : [];
            const present = new Set(list.map((d) => d.fireKey));
            for (const key of fired) {
                if (!present.has(key)) fired.delete(key);
            }
            const fresh = [];
            for (const item of list) {
                if (!fired.has(item.fireKey)) {
                    fired.add(item.fireKey);
                    fresh.push(item);
                }
            }
            return fresh;
        },
    };
};

/**
 * Format one OS notification from a batch of freshly-due (already-deduped)
 * entries. A single entry names its challenge + action; multiple entries in the
 * same cycle coalesce into one grouped toast rather than N simultaneous ones.
 * Returns null when there is nothing to show.
 *
 * @param {Array<{title:string, action:string, secondsUntil:number}>} entries
 * @param {(key:string)=>string} translate - returns a raw template (may carry
 *   `{placeholders}`); the host passes its own t()/Node translator.
 * @returns {{title:string, body:string}|null}
 */
const formatNotification = (entries, translate) => {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return null;
    const t = typeof translate === 'function' ? translate : (/** @type {string} */ key) => key;
    const minutesOf = (/** @type {{secondsUntil:number}} */ e) => Math.max(1, Math.round(Number(e.secondsUntil) / 60));

    if (list.length === 1) {
        const e = list[0];
        const actionLabel = t(ACTION_LABEL_KEY[e.action] || '') || e.action;
        return {
            title: sanitizeNotificationText(interpolate(t('app.notifyTitle'), { action: actionLabel })),
            body: sanitizeNotificationText(
                interpolate(t('app.notifyBody'), { title: e.title, action: actionLabel, minutes: minutesOf(e) }),
            ),
        };
    }

    const minMinutes = Math.min(...list.map(minutesOf));
    return {
        title: sanitizeNotificationText(t('app.notifyGroupTitle')),
        body: sanitizeNotificationText(
            interpolate(t('app.notifyGroupBody'), { count: list.length, minutes: minMinutes }),
        ),
    };
};

/**
 * Read the notification config from a settings accessor. Returns the enabled
 * map and lead window in seconds. `anyEnabled` lets a host early-exit before any
 * per-challenge work when the whole feature is off (the default).
 *
 * @param {(key:string)=>*} getSetting
 * @returns {{leadSec:number, enabled:Record<string, boolean>, anyEnabled:boolean}}
 */
const readNotificationConfig = (getSetting) => {
    const get = typeof getSetting === 'function' ? getSetting : () => undefined;
    /** @type {Record<string, boolean>} */
    const enabled = {};
    let anyEnabled = false;
    for (const action of Object.keys(NOTIFY_SETTING_KEYS)) {
        const on = get(NOTIFY_SETTING_KEYS[action]) === true;
        enabled[action] = on;
        if (on) anyEnabled = true;
    }
    const leadMin = Number(get('notifyLeadTime'));
    const leadSec = Number.isFinite(leadMin) && leadMin > 0 ? leadMin * 60 : 0;
    return { leadSec, enabled, anyEnabled };
};

module.exports = {
    ACTION_LABEL_KEY,
    NOTIFY_SETTING_KEYS,
    sanitizeNotificationText,
    interpolate,
    computeDueNotifications,
    createDedupe,
    formatNotification,
    readNotificationConfig,
};
