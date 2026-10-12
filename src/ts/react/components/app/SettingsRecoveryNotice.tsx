import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';
import { interp } from '@/utils/interp';

import type { IpcQueryTools } from '@/api/useIpcQuery';

type RecoveryCode = 'settings-corrupt' | 'settings-unreadable' | 'settings-migration-failed';
type Recovery = { code: RecoveryCode; path: string };

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
    'settings-migration-failed': {
        what: 'notice.recoveryMigrationWhat',
        why: 'notice.recoveryMigrationWhy',
        next: 'notice.recoveryMigrationNext',
    },
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
 * a file that cannot be read or brought up to date (saving is off until it can be). What happened, why, what next;
 * dismissable for the session.
 */
export function SettingsRecoveryNotice() {
    const { t } = useTranslation();
    const { data: recovery } = useIpcQuery(fetchRecovery, {
        initialData: null as Recovery | null,
        apply: applyRecovery,
    });
    const [dismissed, setDismissed] = useState(false);
    if (!recovery || dismissed) return null;
    const keys = RECOVERY_KEYS[recovery.code];
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
