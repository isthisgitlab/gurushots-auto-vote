import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';
import { interp } from '@/utils/interp';
import { errorMessage } from '../../../errorMessage';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { BusyContent } from '@/components/ui/LoadingSpinner';

import type { IpcQueryTools } from '@/api/useIpcQuery';

type RecoveryCode = 'settings-unreadable' | 'settings-corrupt' | 'settings-import-failed' | 'settings-save-dropped';
// `cause` (a save the window gave up only): why the change was dropped — `conflict` (the background service wrote at
// the same time), `too-large` (past the size the store takes) or `storage` (the store refused it). Any other value,
// or none, is worded neutrally. `serial` (a save the window gave up only): which of the saves given up this was, so
// that a repeat of the same cause is a notice of its own. `blocking` (an import failure only): true while saves are
// refused (the file could not be tried just now), false once the defaults were stored in its place (`detail` is the
// reason the file itself cannot be imported).
type Recovery = {
    code: RecoveryCode;
    path: string;
    blocking?: boolean;
    detail?: string;
    cause?: string;
    serial?: number;
};

// What makes a notice the same notice: a dismissal holds for it and for no other (another code, another place, another
// cause, or another save given up).
const noticeKey = ({ code, path, cause, detail, serial }: Recovery): string =>
    JSON.stringify([code, path, cause, detail, serial]);

// The translation keys of each code's what happened / why / what next text.
const RECOVERY_KEYS: Record<RecoveryCode, { what: string; why: string; next: string }> = {
    'settings-unreadable': {
        what: 'notice.recoveryUnreadableWhat',
        why: 'notice.recoveryUnreadableWhy',
        next: 'notice.recoveryUnreadableNext',
    },
    'settings-corrupt': {
        what: 'notice.recoveryCorruptWhat',
        why: 'notice.recoveryCorruptWhy',
        next: 'notice.recoveryCorruptNext',
    },
    'settings-import-failed': {
        what: 'notice.recoveryImportWhat',
        why: 'notice.recoveryImportWhy',
        next: 'notice.recoveryImportNext',
    },
    'settings-save-dropped': {
        what: 'notice.recoveryDroppedWhat',
        why: 'notice.recoveryDroppedWhyUnknown',
        next: 'notice.recoveryDroppedNext',
    },
};

// The settled import failure (the defaults were stored in its place) has its own words, and names the reason.
const SETTLED_IMPORT_KEYS = {
    what: 'notice.recoveryImportSettledWhat',
    next: 'notice.recoveryImportSettledNext',
};

const DROPPED_WHY = new Map([
    ['conflict', 'notice.recoveryDroppedWhyConflict'],
    ['too-large', 'notice.recoveryDroppedWhyTooLarge'],
    ['storage', 'notice.recoveryDroppedWhyStorage'],
]);

// Where the settings are not a file the user can open (Android: app-private storage), the notice names no file and
// asks for no step on one.
const NO_FILE_KEYS: Partial<Record<RecoveryCode, { what?: string; why: string; next: string }>> = {
    'settings-unreadable': { why: 'notice.recoveryUnreadableWhyAndroid', next: 'notice.recoveryUnreadableNextAndroid' },
    'settings-corrupt': {
        what: 'notice.recoveryCorruptWhatAndroid',
        why: 'notice.recoveryCorruptWhyAndroid',
        next: 'notice.recoveryCorruptNextAndroid',
    },
    'settings-import-failed': {
        what: 'notice.recoveryImportWhatAndroid',
        why: 'notice.recoveryImportWhyAndroid',
        next: 'notice.recoveryImportNextAndroid',
    },
};

// The text keys of a notice: its code's, refined by what the platform and the state make true. A dropped save is
// worded by why it was dropped.
const keysFor = (recovery: Recovery, settingsFile: boolean) => {
    const keys = { ...RECOVERY_KEYS[recovery.code] };
    if (!settingsFile) Object.assign(keys, NO_FILE_KEYS[recovery.code]);
    if (recovery.code === 'settings-import-failed' && recovery.blocking === false) {
        // The defaults were stored in its place: saving works, and the notice names the reason.
        keys.what = settingsFile ? SETTLED_IMPORT_KEYS.what : 'notice.recoveryImportSettledWhatAndroid';
        keys.why =
            recovery.detail === 'migration-failed'
                ? 'notice.recoveryImportWhyMigration'
                : 'notice.recoveryImportWhyCorrupt';
        keys.next = settingsFile ? SETTLED_IMPORT_KEYS.next : 'notice.recoveryImportSettledNextAndroid';
    }
    if (recovery.code === 'settings-save-dropped') {
        keys.why = DROPPED_WHY.get(recovery.cause ?? '') ?? 'notice.recoveryDroppedWhyUnknown';
        if (recovery.cause === 'too-large') keys.next = 'notice.recoveryDroppedNextTooLarge';
    }
    return keys;
};

type ActionId = 'retry' | 'start-fresh';

// What each action does and says: `done` and `failed` are the outcome texts (what happened, why, what next).
const ACTIONS: Record<
    ActionId,
    {
        label: string;
        run: () => Promise<{ success: boolean; error?: string; adopted?: boolean }>;
        done: string;
        failed: string;
        primary?: true;
    }
> = {
    retry: {
        label: 'notice.recoveryRetry',
        run: () => ipc.retrySettingsImport(),
        done: 'notice.recoveryRetryDone',
        failed: 'notice.recoveryRetryFailed',
        primary: true,
    },
    'start-fresh': {
        label: 'notice.recoveryStartFresh',
        run: () => ipc.startFreshSettings(),
        done: 'notice.recoveryStartFreshDone',
        failed: 'notice.recoveryStartFreshFailed',
    },
};

// Start fresh gives up the import, so it is asked for first — and offered only while the import is what is blocked.
const CONFIRMS = {
    'start-fresh': {
        title: 'notice.recoveryStartFreshTitle',
        body: 'notice.recoveryStartFreshBody',
        button: 'notice.recoveryStartFresh',
    },
} as const;
type ConfirmedAction = keyof typeof CONFIRMS;
const needsConfirm = (action: ActionId): action is ConfirmedAction => Object.hasOwn(CONFIRMS, action);

// What an action came to: `adopted` when the settings were already in place, so nothing was imported or reset.
type Outcome = { action: ActionId; ok: boolean; adopted?: boolean };

// The actions a notice offers, in order: Retry and Start fresh for an import that blocks saves, nothing for the rest
// (a read that blocks saves tries again on its own, a settled import is told as it is).
const actionsFor = (recovery: Recovery): ActionId[] =>
    recovery.code === 'settings-import-failed' && recovery.blocking === true ? ['retry', 'start-fresh'] : [];

// The outcome texts that name settings.json have a no-file wording where it is not one the user can open.
const NO_FILE_TEXT = new Map([
    ['notice.recoveryRetryDone', 'notice.recoveryRetryDoneAndroid'],
    ['notice.recoveryRetryFailed', 'notice.recoveryRetryFailedAndroid'],
    ['notice.recoveryStartFreshDone', 'notice.recoveryStartFreshDoneAndroid'],
]);

const fetchRecovery = () => ipc.getSettingsRecovery();

// A read that fails, or answers something this build has no wording for, shows nothing: the notice is advice, and
// the settings themselves still work or fail visibly on their own.
const applyRecovery = (
    result: Awaited<ReturnType<typeof fetchRecovery>>,
    { setData }: Pick<IpcQueryTools<Recovery | null, Error>, 'setData'>,
) => {
    const recovery = result?.success ? result.recovery : null;
    setData(recovery && recovery.code in RECOVERY_KEYS ? recovery : null);
};

/**
 * Tells the user when their stored settings are not in use or were set aside: a damaged file moved aside (with where
 * the copy went) and the defaults in its place; a file that cannot be read; a settings.json that could not be imported
 * (saving is off until it can be, or the defaults were stored in its place); or a change the window could not save.
 * What happened, why, what next; dismissable until the notice goes away. The notices that have a way forward offer it:
 * Retry or Start fresh for an import that failed. `returnFocusTo` is the page's own element that takes focus when
 * a dismissed outcome has no button or heading of the notice left to return it to (the page makes it focusable). An action shows that it is working, then says inline what
 * came of it. It reads again on every settings
 * change, which is how a save given up later (or one that lands after) reaches it.
 */
export function SettingsRecoveryNotice({ returnFocusTo }: { returnFocusTo?: RefObject<HTMLElement | null> }) {
    const { t } = useTranslation();
    const { settingsFile } = usePlatformCapabilities();
    const { data: recovery, refetch } = useIpcQuery(fetchRecovery, {
        initialData: null as Recovery | null,
        apply: applyRecovery,
        subscribe: true,
    });
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);
    const [busy, setBusy] = useState<ActionId | null>(null);
    const [confirming, setConfirming] = useState<ConfirmedAction | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    // Where focus goes back to when an outcome is dismissed: the button that ran the action, else the notice's
    // heading, else the page's own place (`returnFocusTo`: the notice is gone, a success took it away).
    const actionButtons = useRef(new Map<ActionId, HTMLButtonElement>());
    const heading = useRef<HTMLParagraphElement>(null);
    // A notice that went away and comes back is a new one.
    useEffect(() => {
        if (!recovery) setDismissedKey(null);
    }, [recovery]);
    const dismissed = recovery !== null && dismissedKey === noticeKey(recovery);

    const run = async (action: ActionId) => {
        setBusy(action);
        setOutcome(null);
        let ok = false;
        let adopted: boolean | undefined;
        try {
            const result = await ACTIONS[action].run();
            ok = result?.success === true;
            if (ok) adopted = result.adopted;
            if (!ok)
                void ipc.logRendererWarning(`Settings recovery "${action}" failed: ${result?.error ?? 'no answer'}`);
        } catch (error) {
            void ipc.logRendererError(`Settings recovery "${action}" threw: ${errorMessage(error) || error}`);
        }
        setOutcome({ action, ok, adopted });
        setConfirming(null);
        setBusy(null);
        if (ok) await refetch();
    };

    const offered = recovery ? actionsFor(recovery) : [];
    // The text of an outcome, in the wording of this platform.
    const worded = (key: string) => t(settingsFile ? key : (NO_FILE_TEXT.get(key) ?? key));
    // What an outcome says: either action found the settings already in place (saved by another writer meanwhile).
    const outcomeText = ({ action, ok, adopted }: Outcome): string => {
        if (!ok) return worded(ACTIONS[action].failed);
        if (adopted) {
            return t(
                action === 'start-fresh' ? 'notice.recoveryStartFreshDoneAdopted' : 'notice.recoveryRetryDoneAdopted',
            );
        }
        return worded(ACTIONS[action].done);
    };
    const dismissOutcome = () => {
        const target =
            (outcome && actionButtons.current.get(outcome.action)) ?? heading.current ?? returnFocusTo?.current;
        setOutcome(null);
        target?.focus();
    };
    const request = (action: ActionId) => {
        if (needsConfirm(action)) setConfirming(action);
        else void run(action);
    };
    const keys = recovery && !dismissed ? keysFor(recovery, settingsFile) : null;
    // The damaged copy cannot be read as settings, so a logout cannot take the sign-in out of it: it may still hold it.
    const keepsSignIn = recovery !== null && recovery.code === 'settings-corrupt';
    // A landmark only while there is something in it: an empty one is noise for a screen reader.
    const hasContent = Boolean(recovery && keys) || Boolean(outcome) || Boolean(busy);
    return (
        <div {...(hasContent ? { role: 'region', 'aria-label': t('notice.recoveryRegion') } : {})}>
            {recovery && keys && (
                <div role="alert" className="alert alert-warning mb-4 text-sm items-start">
                    <div className="flex-1 space-y-2">
                        <p ref={heading} tabIndex={-1} className="font-semibold">
                            {t(keys.what)}
                        </p>
                        <p className="break-words">{interp(t(keys.why), { path: recovery.path })}</p>
                        {keepsSignIn && (
                            <p className="break-words">
                                {t(settingsFile ? 'notice.recoverySignInKept' : 'notice.recoverySignInKeptAndroid')}
                            </p>
                        )}
                        <p className="break-words">{interp(t(keys.next), { path: recovery.path })}</p>
                        {offered.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                                {offered.map((action) => (
                                    <button
                                        key={action}
                                        ref={(button) => {
                                            if (button) actionButtons.current.set(action, button);
                                            else actionButtons.current.delete(action);
                                        }}
                                        type="button"
                                        className={`btn btn-sm max-sm:min-h-10 ${ACTIONS[action].primary ? 'btn-neutral' : 'btn-outline'}`}
                                        onClick={() => request(action)}
                                        disabled={busy !== null}
                                        aria-busy={busy === action}
                                    >
                                        <BusyContent busy={busy === action} label={t(ACTIONS[action].label)} />
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        className="btn btn-sm max-sm:min-h-10"
                        onClick={() => setDismissedKey(noticeKey(recovery))}
                    >
                        {t('errors.dismiss')}
                    </button>
                </div>
            )}
            {/* The outcome. Its live regions are mounted whether or not there is anything to say, so that what appears in
                them is announced: progress and success politely, a failure assertively. The Dismiss button is not in
                either, so that pressing it does not read the message out again. */}
            <div
                className={
                    outcome
                        ? `alert ${outcome.ok ? 'alert-success' : 'alert-error'} mb-4 text-sm items-start`
                        : busy && !confirming
                          ? 'text-xs mb-2'
                          : undefined
                }
            >
                {/* One element for the two regions: a DaisyUI alert is a grid, and an empty region of its own would take a cell of it. */}
                <div className="flex-1">
                    <div role="status" aria-live="polite" aria-atomic="true">
                        {busy && !confirming && t('notice.recoveryWorking')}
                        {outcome?.ok && outcomeText(outcome)}
                    </div>
                    <div aria-live="assertive" aria-atomic="true">
                        {outcome && !outcome.ok && outcomeText(outcome)}
                    </div>
                </div>
                {outcome && (
                    <button type="button" className="btn btn-sm max-sm:min-h-10" onClick={dismissOutcome}>
                        {t('errors.dismiss')}
                    </button>
                )}
            </div>
            {confirming && (
                <ConfirmModal
                    isOpen
                    title={t(CONFIRMS[confirming].title)}
                    working={busy !== null}
                    problem={null}
                    onClose={() => setConfirming(null)}
                    onConfirm={() => void run(confirming)}
                    confirmLabel={CONFIRMS[confirming].button}
                    workingLabel="notice.recoveryWorking"
                >
                    <p className="break-words">
                        {t(settingsFile ? CONFIRMS[confirming].body : 'notice.recoveryStartFreshBodyAndroid')}
                    </p>
                </ConfirmModal>
            )}
        </div>
    );
}
