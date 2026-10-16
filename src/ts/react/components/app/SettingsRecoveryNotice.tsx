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

type RecoveryCode =
    | 'settings-restored'
    | 'settings-corrupt'
    | 'settings-unreadable'
    | 'settings-import-failed'
    | 'settings-import-retrying'
    | 'settings-save-dropped';
// `cause` (a save the window gave up only): why the change was dropped — `conflict` (the background service wrote at
// the same time), `too-large` (past the size the store takes) or `storage` (the store refused it). Any other value,
// or none, is worded neutrally. `settingsSetAside` (a damaged configuration only): where the unusable settings.json
// was kept once a save mirrored over it (a path where there are files, a storage key where there are none).
// `reimportSource` (the same, where there are files): the file a Re-import would read. `damagedAt` (a settings.json that
// cannot be read just now, behind a damaged configuration): where the damaged configuration was kept.
type Recovery = {
    code: RecoveryCode;
    path: string;
    cause?: string;
    settingsSetAside?: string;
    reimportSource?: string;
    damagedAt?: string;
    signInKept?: false;
    logoutLost?: true;
};

// The translation keys of each code's what happened / why / what next text.
const RECOVERY_KEYS: Record<RecoveryCode, { what: string; why: string; next: string }> = {
    'settings-restored': {
        what: 'notice.recoveryRestoredWhat',
        why: 'notice.recoveryRestoredWhy',
        next: 'notice.recoveryRestoredNext',
    },
    'settings-corrupt': {
        what: 'notice.recoveryCorruptWhat',
        why: 'notice.recoveryCorruptWhy',
        next: 'notice.recoveryCorruptNext',
    },
    'settings-unreadable': {
        what: 'notice.recoveryUnreadableWhat',
        why: 'notice.recoveryUnreadableWhy',
        next: 'notice.recoveryUnreadableNext',
    },
    'settings-import-failed': {
        what: 'notice.recoveryImportWhat',
        why: 'notice.recoveryImportWhy',
        next: 'notice.recoveryImportNext',
    },
    'settings-import-retrying': {
        what: 'notice.recoveryRetryingWhat',
        why: 'notice.recoveryRetryingWhy',
        next: 'notice.recoveryRetryingNext',
    },
    'settings-save-dropped': {
        what: 'notice.recoveryDroppedWhat',
        why: 'notice.recoveryDroppedWhyUnknown',
        next: 'notice.recoveryDroppedNext',
    },
};

const DROPPED_WHY = new Map([
    ['conflict', 'notice.recoveryDroppedWhyConflict'],
    ['too-large', 'notice.recoveryDroppedWhyTooLarge'],
    ['storage', 'notice.recoveryDroppedWhyStorage'],
]);

// Where the settings are not a file the user can open (Android: app-private storage), the notice names no file and
// asks for no step on one.
const NO_FILE_KEYS: Partial<Record<RecoveryCode, { what?: string; why: string; next: string }>> = {
    'settings-restored': {
        what: 'notice.recoveryRestoredWhatAndroid',
        why: 'notice.recoveryRestoredWhyAndroid',
        next: 'notice.recoveryRestoredNextAndroid',
    },
    'settings-corrupt': {
        what: 'notice.recoveryCorruptWhatAndroid',
        why: 'notice.recoveryCorruptWhyAndroid',
        next: 'notice.recoveryCorruptNextAndroid',
    },
    'settings-unreadable': { why: 'notice.recoveryUnreadableWhyAndroid', next: 'notice.recoveryUnreadableNextAndroid' },
    'settings-import-failed': {
        what: 'notice.recoveryImportWhatAndroid',
        why: 'notice.recoveryImportWhyAndroid',
        next: 'notice.recoveryImportNextAndroid',
    },
    'settings-import-retrying': { why: 'notice.recoveryRetryingWhyAndroid', next: 'notice.recoveryRetryingNext' },
};

// The outcome and question texts that name settings.json, and the wording used where there is no file to name.
const NO_FILE_TEXT = new Map([
    ['notice.recoveryRetryDone', 'notice.recoveryRetryDoneAndroid'],
    ['notice.recoveryRetryFailed', 'notice.recoveryRetryFailedAndroid'],
    ['notice.recoveryStartFreshBody', 'notice.recoveryStartFreshBodyAndroid'],
    ['notice.recoveryStartFreshDone', 'notice.recoveryStartFreshDoneAndroid'],
]);

// The text keys of a notice: its code's, refined by what the platform and the cause make true. A dropped save is
// worded by why it was dropped.
const keysFor = (recovery: Recovery, settingsFile: boolean) => {
    const keys = { ...RECOVERY_KEYS[recovery.code] };
    if (!settingsFile) Object.assign(keys, NO_FILE_KEYS[recovery.code]);
    // Once the unusable settings.json was set aside, the guidance names where it went (it is the file to fix).
    if (recovery.settingsSetAside !== undefined) {
        keys.next = settingsFile ? 'notice.recoveryCorruptNextAside' : 'notice.recoveryCorruptNextAsideAndroid';
    }
    // With no damaged configuration behind it, a settings.json that cannot be read just now is all there is to say.
    if (recovery.code === 'settings-import-retrying' && recovery.damagedAt === undefined) {
        keys.why = settingsFile ? 'notice.recoveryRetryingWhyNoCopy' : 'notice.recoveryRetryingWhyNoCopyAndroid';
    }
    if (recovery.code === 'settings-save-dropped') {
        keys.why = DROPPED_WHY.get(recovery.cause ?? '') ?? 'notice.recoveryDroppedWhyUnknown';
        if (recovery.cause === 'too-large') keys.next = 'notice.recoveryDroppedNextTooLarge';
        // A logout that was not recorded is not a setting that reverts: it has its own words.
        if (recovery.cause === 'logout-lost') {
            keys.what = 'notice.recoveryLogoutLostWhat';
            keys.why = 'notice.recoveryLogoutLostWhy';
            keys.next = 'notice.recoveryLogoutLostNext';
        }
    }
    return keys;
};

type ActionId = 'retry' | 'start-fresh' | 'reimport';

// What each action does and says: `done` and `failed` are the outcome texts (what happened, why, what next).
const ACTIONS: Record<
    ActionId,
    {
        label: string;
        run: () => Promise<{ success: boolean; error?: string; kept?: StartFreshKept; source?: string }>;
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
    reimport: {
        label: 'notice.recoveryReimport',
        run: () => ipc.reimportSettingsFromV1(),
        done: 'notice.recoveryReimportDone',
        failed: 'notice.recoveryReimportFailed',
        primary: true,
    },
};

// The actions that set the current state aside or give up the import ask first: the question's title, text and button.
const CONFIRMS = {
    'start-fresh': {
        title: 'notice.recoveryStartFreshTitle',
        body: 'notice.recoveryStartFreshBody',
        button: 'notice.recoveryStartFresh',
    },
    reimport: {
        title: 'notice.recoveryReimportTitle',
        body: 'notice.recoveryReimportBody',
        button: 'notice.recoveryReimportConfirm',
    },
} as const;
type ConfirmedAction = keyof typeof CONFIRMS;
const needsConfirm = (action: ActionId): action is ConfirmedAction => Object.hasOwn(CONFIRMS, action);

// The actions each code offers, in order.
const ACTIONS_FOR: Partial<Record<RecoveryCode, ActionId[]>> = {
    'settings-import-failed': ['retry', 'start-fresh'],
    // While it may pass by itself, giving up the import is not offered.
    'settings-import-retrying': ['retry'],
    'settings-corrupt': ['reimport'],
};

// Re-import takes the settings from a settings.json the user fixes; where there is no file they can open, it is not offered.
const actionsFor = (code: RecoveryCode, settingsFile: boolean): ActionId[] =>
    (ACTIONS_FOR[code] ?? []).filter((action) => settingsFile || action !== 'reimport');

// What became of settings.json at a fresh start, as the main process answers it (see 'start-fresh-settings': kept at a
// path, kept in the app's own storage, to be kept as soon as it can be written, or there was none).
type StartFreshKept = Extract<
    NonNullable<Awaited<ReturnType<typeof ipc.startFreshSettings>>>,
    { success: true }
>['kept'];

// `kept` (Start fresh only) and `source` (Re-import: the file it read, or would have read when it failed).
type Outcome = { action: ActionId; ok: boolean; kept?: StartFreshKept; source?: string };

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
 * Tells the user when their stored settings are not in use or were restored: a damaged file moved aside (with where
 * the copy went) and the settings restored from settings.json, or, when there was none to restore from, defaults in
 * their place; a file that cannot be read; a settings.json that could not be imported (saving is off until it can
 * be); or a change the window could not save. What happened, why, what next; dismissable until the notice goes away.
 * The notices that have a way forward offer it: Retry or Start fresh for an import that failed, Re-import for a
 * damaged configuration with nothing to restore it from. `returnFocusTo` is the page's own element that takes focus when
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
    const [dismissed, setDismissed] = useState(false);
    const [busy, setBusy] = useState<ActionId | null>(null);
    const [confirming, setConfirming] = useState<ConfirmedAction | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    // Where focus goes back to when an outcome is dismissed: the button that ran the action, else the notice's
    // heading, else the page's own place (`returnFocusTo`: the notice is gone, a success took it away).
    const actionButtons = useRef(new Map<ActionId, HTMLButtonElement>());
    const heading = useRef<HTMLParagraphElement>(null);
    // A notice that went away and comes back is a new one.
    useEffect(() => {
        if (!recovery) setDismissed(false);
    }, [recovery]);

    const run = async (action: ActionId) => {
        setBusy(action);
        setOutcome(null);
        let ok = false;
        let kept: StartFreshKept | undefined;
        let source = recovery?.reimportSource;
        try {
            const result = await ACTIONS[action].run();
            ok = result?.success === true;
            if (ok) {
                kept = result.kept;
                source = result.source ?? source;
            }
            if (!ok)
                void ipc.logRendererWarning(`Settings recovery "${action}" failed: ${result?.error ?? 'no answer'}`);
        } catch (error) {
            void ipc.logRendererError(`Settings recovery "${action}" threw: ${errorMessage(error) || error}`);
        }
        setOutcome({ action, ok, kept, source });
        setConfirming(null);
        setBusy(null);
        if (ok) await refetch();
    };

    const offered = recovery ? actionsFor(recovery.code, settingsFile) : [];
    // The text of an outcome or question, in the wording of this platform.
    // (A text with no no-file wording is one of Re-import, which is not offered where there is no file.)
    const worded = (key: string) =>
        t(settingsFile ? key : (NO_FILE_TEXT.get(key) ?? /* istanbul ignore next -- see above */ key));
    // What an outcome says: Start fresh names where settings.json was kept (or that it is not yet, or there was none);
    // Re-import names the file it read.
    const outcomeText = ({ action, ok, kept, source }: Outcome): string => {
        if (!ok) return interp(worded(ACTIONS[action].failed), { path: source });
        if (action === 'start-fresh' && kept?.kind === 'none') {
            return t(settingsFile ? 'notice.recoveryStartFreshDoneNone' : 'notice.recoveryStartFreshDoneNoneAndroid');
        }
        if (action === 'start-fresh' && kept?.kind === 'adopted') return t('notice.recoveryStartFreshDoneAdopted');
        if (action === 'start-fresh' && kept?.kind === 'unreadable')
            return t('notice.recoveryStartFreshDoneUnreadable');
        if (action === 'start-fresh' && kept?.kind === 'pending')
            return t('notice.recoveryStartFreshDonePendingAndroid');
        return interp(worded(ACTIONS[action].done), { path: kept?.kind === 'path' ? kept.path : source });
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
    // The damaged copy keeps the sign-in it held until a logout takes it out (and says so only until then).
    const keepsSignIn =
        recovery !== null &&
        recovery.signInKept !== false &&
        (recovery.code === 'settings-restored' ||
            recovery.code === 'settings-corrupt' ||
            (recovery.code === 'settings-import-retrying' && recovery.damagedAt !== undefined));
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
                        <p className="break-words">
                            {interp(t(keys.why), { path: recovery.damagedAt ?? recovery.path })}
                        </p>
                        {keepsSignIn && <p className="break-words">{t('notice.recoverySignInKept')}</p>}
                        {recovery.logoutLost && (
                            <p className="break-words font-semibold">
                                {t('notice.recoveryLogoutLostWhat')} {t('notice.recoveryLogoutLostWhy')}{' '}
                                {t('notice.recoveryLogoutLostNext')}
                            </p>
                        )}
                        <p className="break-words">{interp(t(keys.next), { path: recovery.settingsSetAside })}</p>
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
                                        className={`btn btn-sm ${ACTIONS[action].primary ? 'btn-primary' : 'btn-outline'}`}
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
                    <button type="button" className="btn btn-sm" onClick={() => setDismissed(true)}>
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
                    <button type="button" className="btn btn-sm" onClick={dismissOutcome}>
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
                        {interp(worded(CONFIRMS[confirming].body), { path: recovery?.reimportSource })}
                    </p>
                </ConfirmModal>
            )}
        </div>
    );
}
