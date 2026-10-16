import { useEffect, useState } from 'react';
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
// or none, is worded neutrally.
type Recovery = { code: RecoveryCode; path: string; cause?: string };

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

// Where the settings are not a file the user can open (Android: app-private storage), the notice names no path and
// asks for no step on a file.
const NO_FILE_KEYS: Partial<Record<RecoveryCode, { why: string; next: string }>> = {
    'settings-restored': { why: 'notice.recoveryRestoredWhyAndroid', next: 'notice.recoveryRestoredNextAndroid' },
    'settings-corrupt': { why: 'notice.recoveryCorruptWhyAndroid', next: 'notice.recoveryCorruptNextAndroid' },
    'settings-unreadable': { why: 'notice.recoveryUnreadableWhyAndroid', next: 'notice.recoveryUnreadableNextAndroid' },
    'settings-import-failed': { why: 'notice.recoveryImportWhyAndroid', next: 'notice.recoveryImportNextAndroid' },
};

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
        run: () => Promise<{ success: boolean; error?: string }>;
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

type Outcome = { action: ActionId; ok: boolean };

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
    // A notice that went away and comes back is a new one.
    useEffect(() => {
        if (!recovery) setDismissed(false);
    }, [recovery]);

    const run = async (action: ActionId) => {
        setBusy(action);
        setOutcome(null);
        let ok = false;
        try {
            const result = await ACTIONS[action].run();
            ok = result?.success === true;
            if (!ok)
                void ipc.logRendererWarning(`Settings recovery "${action}" failed: ${result?.error ?? 'no answer'}`);
        } catch (error) {
            void ipc.logRendererError(`Settings recovery "${action}" threw: ${errorMessage(error) || error}`);
        }
        setOutcome({ action, ok });
        setConfirming(null);
        setBusy(null);
        if (ok) await refetch();
    };

    const offered = (recovery && ACTIONS_FOR[recovery.code]) || [];
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
                        <p className="font-semibold">{t(keys.what)}</p>
                        <p className="break-words">{interp(t(keys.why), { path: recovery.path })}</p>
                        <p>{t(keys.next)}</p>
                        {offered.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                                {offered.map((action) => (
                                    <button
                                        key={action}
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
                        {busy && !confirming && (
                            <p role="status" className="text-xs">
                                {t('notice.recoveryWorking')}
                            </p>
                        )}
                    </div>
                    <button type="button" className="btn btn-sm" onClick={() => setDismissed(true)}>
                        {t('errors.dismiss')}
                    </button>
                </div>
            )}
            {outcome && (
                <div
                    role={outcome.ok ? 'status' : 'alert'}
                    className={`alert ${outcome.ok ? 'alert-success' : 'alert-error'} mb-4 text-sm items-start`}
                >
                    <span className="flex-1">
                        {t(outcome.ok ? ACTIONS[outcome.action].done : ACTIONS[outcome.action].failed)}
                    </span>
                    <button type="button" className="btn btn-sm" onClick={() => setOutcome(null)}>
                        {t('errors.dismiss')}
                    </button>
                </div>
            )}
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
                    <p>{t(CONFIRMS[confirming].body)}</p>
                </ConfirmModal>
            )}
        </>
    );
}
