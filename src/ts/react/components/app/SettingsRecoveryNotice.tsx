import { useEffect, useRef, useState } from 'react';
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
    | 'settings-save-dropped';
// `cause` (a save the window gave up only): why the change was dropped — `conflict` (the background service wrote at
// the same time), `too-large` (past the size the store takes) or `storage` (the store refused it). Any other value,
// or none, is worded neutrally. `settingsSetAside` (a damaged configuration only): where the unusable settings.json
// was kept once a save mirrored over it (a path where there are files, a storage key where there are none).
type Recovery = { code: RecoveryCode; path: string; cause?: string; settingsSetAside?: string };

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
    if (recovery.code === 'settings-save-dropped') {
        keys.why = DROPPED_WHY.get(recovery.cause ?? '') ?? 'notice.recoveryDroppedWhyUnknown';
        if (recovery.cause === 'too-large') keys.next = 'notice.recoveryDroppedNextTooLarge';
    }
    return keys;
};

type ActionId = 'retry' | 'start-fresh' | 'reimport';

// What each action does and says: `done` and `failed` are the outcome texts (what happened, why, what next).
const ACTIONS: Record<
    ActionId,
    {
        label: string;
        run: () => Promise<{ success: boolean; error?: string; keptAt?: string | null }>;
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
    'settings-corrupt': ['reimport'],
};

// Re-import takes the settings from a settings.json the user fixes; where there is no file they can open, it is not offered.
const actionsFor = (code: RecoveryCode, settingsFile: boolean): ActionId[] =>
    (ACTIONS_FOR[code] ?? []).filter((action) => settingsFile || action !== 'reimport');

// `keptAt` (Start fresh only): where settings.json was kept, null when there was none to keep.
type Outcome = { action: ActionId; ok: boolean; keptAt?: string | null };

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
 * damaged configuration with nothing to restore it from. An action shows that it is working, then says inline what
 * came of it. It reads again on every settings
 * change, which is how a save given up later (or one that lands after) reaches it.
 */
export function SettingsRecoveryNotice() {
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
    // Where focus goes back to when an outcome is dismissed: the button that ran the action, else the notice's heading.
    const actionButtons = useRef(new Map<ActionId, HTMLButtonElement>());
    const heading = useRef<HTMLParagraphElement>(null);
    // The outcome's own element is always mounted: where focus falls back to when the notice is gone too.
    const outcomeBox = useRef<HTMLDivElement>(null);
    // A notice that went away and comes back is a new one.
    useEffect(() => {
        if (!recovery) setDismissed(false);
    }, [recovery]);

    const run = async (action: ActionId) => {
        setBusy(action);
        setOutcome(null);
        let ok = false;
        let keptAt: string | null | undefined;
        try {
            const result = await ACTIONS[action].run();
            ok = result?.success === true;
            if (ok) keptAt = result.keptAt;
            if (!ok)
                void ipc.logRendererWarning(`Settings recovery "${action}" failed: ${result?.error ?? 'no answer'}`);
        } catch (error) {
            void ipc.logRendererError(`Settings recovery "${action}" threw: ${errorMessage(error) || error}`);
        }
        setOutcome({ action, ok, keptAt });
        setConfirming(null);
        setBusy(null);
        if (ok) await refetch();
    };

    const offered = recovery ? actionsFor(recovery.code, settingsFile) : [];
    // The text of an outcome or question, in the wording of this platform.
    // (A text with no no-file wording is one of Re-import, which is not offered where there is no file.)
    const worded = (key: string) =>
        t(settingsFile ? key : (NO_FILE_TEXT.get(key) ?? /* istanbul ignore next -- see above */ key));
    // What an outcome says: Start fresh names where settings.json was kept, or says there was none to keep.
    const outcomeText = ({ action, ok, keptAt }: Outcome): string => {
        if (!ok) return worded(ACTIONS[action].failed);
        if (action === 'start-fresh' && keptAt === null) {
            return t(settingsFile ? 'notice.recoveryStartFreshDoneNone' : 'notice.recoveryStartFreshDoneNoneAndroid');
        }
        return interp(worded(ACTIONS[action].done), { path: keptAt });
    };
    const dismissOutcome = () => {
        const target = (outcome && actionButtons.current.get(outcome.action)) ?? heading.current ?? outcomeBox.current;
        setOutcome(null);
        target?.focus();
    };
    const request = (action: ActionId) => {
        if (needsConfirm(action)) setConfirming(action);
        else void run(action);
    };
    const keys = recovery && !dismissed ? keysFor(recovery, settingsFile) : null;
    return (
        <>
            {recovery && keys && (
                <div role="alert" className="alert alert-warning mb-4 text-sm items-start">
                    <div className="flex-1 space-y-2">
                        <p ref={heading} tabIndex={-1} className="font-semibold">
                            {t(keys.what)}
                        </p>
                        <p className="break-words">{interp(t(keys.why), { path: recovery.path })}</p>
                        <p>{t(keys.next)}</p>
                        {recovery.settingsSetAside !== undefined && (
                            <p className="break-words">
                                {settingsFile
                                    ? interp(t('notice.recoveryCorruptAside'), { path: recovery.settingsSetAside })
                                    : t('notice.recoveryCorruptAsideAndroid')}
                            </p>
                        )}
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
                ref={outcomeBox}
                tabIndex={-1}
                className={`focus:outline-none ${
                    outcome
                        ? `alert ${outcome.ok ? 'alert-success' : 'alert-error'} mb-4 text-sm items-start`
                        : busy && !confirming
                          ? 'text-xs mb-2'
                          : ''
                }`}
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
                    <p>{worded(CONFIRMS[confirming].body)}</p>
                </ConfirmModal>
            )}
        </>
    );
}
