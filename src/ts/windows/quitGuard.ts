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
 * State is module-level for the same reason backgroundActivity's is: one main
 * process, one main window. `resetQuitGuard` runs when that window closes, so
 * a confirmation or a stale list never outlives the session it was about.
 */

import * as logger from '../logger';
import * as votingLogic from '../services/VotingLogic';
import { getEntryAgeLedger } from '../apiFactory';
import { formatDuration } from '../format/duration';
import { imminentBoostChallenges, QUIT_WARN_HORIZON_SEC, resetBoostSelection } from '../services/boostGuard/selection';

import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import type { EntryAgeLedger } from '../types/stores';
import type { Translate } from '../translations/translator';
import type { DescribeDeadlineActions } from '../services/boostGuard/selection';

// A bypass is for the quit already under way; if that quit never lands (a
// cancelled OS shutdown, a failed update install) the guard comes back.
const BYPASS_TTL_MS = 30_000;

let bypassed = false;
let bypassTimer: NodeJS.Timeout | null = null;
// A second Cmd+Q while the dialog is up must not stack another dialog.
let prompting = false;

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
    resetBoostSelection();
    prompting = false;
    clearBypass();
};

const imminentBoosts = (
    now: number,
    describe: DescribeDeadlineActions,
    entryAges: EntryAgeLedger | null,
): Array<{ title: string; dueIn: number }> =>
    imminentBoostChallenges(now, describe, QUIT_WARN_HORIZON_SEC, entryAges).map(({ challenge, dueAt }) => ({
        title: challenge.title,
        dueIn: dueAt - now,
    }));

const describeBoost = (b: { title: string; dueIn: number }, t: Translate, locale: string) =>
    `• ${b.title} — ${b.dueIn <= 0 ? t('quitGuard.dueNow') : t('quitGuard.dueIn', { time: formatDuration(b.dueIn, { locale }) })}`;

const quitDialogOptions = (
    boosts: Array<{ title: string; dueIn: number }>,
    t: Translate,
    locale: string,
): MessageBoxOptions => ({
    type: 'warning',
    buttons: [t('quitGuard.keepRunning'), t('quitGuard.quitAnyway')],
    defaultId: 0,
    cancelId: 0,
    message: t('quitGuard.title'),
    detail: `${t('quitGuard.detail')}\n\n${boosts.map((b) => describeBoost(b, t, locale)).join('\n')}`,
});

/**
 * Hold a quit/close that would forfeit an imminent boost, and ask.
 *
 * @param event - the before-quit / close event
 * @param deps.autovoteRunning - nothing is lost when auto-vote is stopped
 * @param deps.dialog - Electron dialog
 * @param deps.parent - window to attach the dialog to, if still alive
 * @param deps.t - translator
 * @param deps.locale - the UI language the time is written in ("lv" writes minutes "min"); default English
 * @param deps.proceed - re-issues the quit/close once confirmed
 * @param deps.now - Unix seconds
 * @param deps.describeDeadlineActions - test seam
 * @returns true when the event was held
 */
const holdQuitForOpenBoosts = (
    event: { preventDefault: () => void },
    {
        autovoteRunning,
        dialog,
        parent,
        t,
        locale = 'en',
        proceed,
        now = Math.floor(Date.now() / 1000),
        describeDeadlineActions = votingLogic.describeDeadlineActions,
    }: {
        autovoteRunning: boolean;
        dialog: Pick<Dialog, 'showMessageBox'>;
        parent: BrowserWindow | null;
        t: Translate;
        locale?: string;
        proceed: () => void;
        now?: number;
        describeDeadlineActions?: DescribeDeadlineActions;
    },
): boolean => {
    if (bypassed || !autovoteRunning) return false;
    let boosts;
    try {
        boosts = imminentBoosts(now, describeDeadlineActions, getEntryAgeLedger());
    } catch (error) {
        // Runs inside before-quit: a throw here must never make the app unquittable.
        logger.withCategory('ui').error('Quit guard could not read boost state — not asking:', error);
        return false;
    }
    if (boosts.length === 0) return false;

    event.preventDefault();
    if (prompting) return true;
    prompting = true;

    const options = quitDialogOptions(boosts, t, locale);
    const confirm = () => {
        bypassQuitGuard();
        try {
            proceed();
        } catch (error) {
            // Runs from a promise nobody awaits: a throw here would be an unhandled rejection, and the quit would fail silently.
            logger.withCategory('ui').error('Quit could not be completed:', error);
        }
    };
    // A broken dialog must never make the app unquittable.
    const dialogFailed = (error: unknown) => {
        prompting = false;
        logger.withCategory('ui').error('Quit confirmation failed — quitting anyway:', error);
        confirm();
    };
    let shown;
    try {
        shown =
            parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    } catch (error) {
        // Not inside the before-quit / close handler that just prevented the default: re-issuing the
        // quit from there nests it in the event being cancelled.
        setImmediate(() => dialogFailed(error));
        return true;
    }
    // Two-argument then: only a failed dialog lands in the error branch, so
    // `proceed` can never run twice.
    void Promise.resolve(shown).then(({ response }) => {
        prompting = false;
        if (response !== 1) return;
        logger.withCategory('ui').info(`Quit confirmed with ${boosts.length} boost(s) due`, null);
        confirm();
    }, dialogFailed);
    return true;
};

export { bypassQuitGuard, resetQuitGuard, holdQuitForOpenBoosts, BYPASS_TTL_MS };
