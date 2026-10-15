import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';
import { interp } from '@/utils/interp';

import type { IpcQueryTools } from '@/api/useIpcQuery';

type RecoveryCode = 'settings-corrupt' | 'settings-unreadable' | 'settings-import-failed' | 'settings-save-dropped';
// `cause` (a save the window gave up only): why the change was dropped — `conflict` (the background service wrote at
// the same time), `too-large` (past the size the store takes) or `storage` (the store refused it). Any other value,
// or none, is worded neutrally.
type Recovery = { code: RecoveryCode; path: string; cause?: string };

// The translation keys of each code's what happened / why / what next text.
const RECOVERY_KEYS: Record<RecoveryCode, { what: string; why: string; next: string }> = {
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
 * Tells the user when their stored settings are not in use: a damaged file moved aside (with where the copy went), or
 * a file that cannot be read, or 1.x settings that could not be imported (saving is off until they can be), or a change the window could not
 * save. What happened, why, what next; dismissable until the notice goes away. It reads again on every settings
 * change, which is how a save given up later (or one that lands after) reaches it.
 */
export function SettingsRecoveryNotice() {
    const { t } = useTranslation();
    const { settingsFile } = usePlatformCapabilities();
    const { data: recovery } = useIpcQuery(fetchRecovery, {
        initialData: null as Recovery | null,
        apply: applyRecovery,
        subscribe: true,
    });
    const [dismissed, setDismissed] = useState(false);
    // A notice that went away and comes back is a new one.
    useEffect(() => {
        if (!recovery) setDismissed(false);
    }, [recovery]);
    if (!recovery || dismissed) return null;
    const keys = keysFor(recovery, settingsFile);
    return (
        <div role="alert" className="alert alert-warning mb-4 text-sm items-start">
            <div className="flex-1 space-y-1">
                <p className="font-semibold">{t(keys.what)}</p>
                <p className="break-words">{interp(t(keys.why), { path: recovery.path })}</p>
                <p>{t(keys.next)}</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setDismissed(true)}>
                {t('errors.dismiss')}
            </button>
        </div>
    );
}
