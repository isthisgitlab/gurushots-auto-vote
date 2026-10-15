import { useCallback, useEffect, useState } from 'react';
import { CURRENT_NOTICE_VERSION } from '../../noticeVersion';
import { errorMessage } from '../../errorMessage';
import * as ipc from '../api/ipc';

import type { RendererSettings } from '../../types/settings';

/**
 * What the "unofficial app" notice gate tells its page.
 */
export type NoticeGate = {
    /** the notice must be on screen now */
    open: boolean;
    /** still working out whether it is due: other first-run dialogs wait until this is false */
    pending: boolean;
    /** the user pressed "I understand" */
    acknowledge: () => Promise<void>;
};

/**
 * Decides, once the settings have loaded, whether the "unofficial app" notice is due: it is while the stored
 * `noticeAcknowledgedVersion` is below CURRENT_NOTICE_VERSION (a first run, or an update that changed the notice
 * text materially). It is decided at the page's first settled read, so an auto-login that skips the login page
 * still gets the notice, and once per page — a failed save of the acknowledgement does not bring it back mid-session.
 * Unreadable settings count as not acknowledged.
 *
 * @param settings - the page's settings (null when they could not be read)
 * @param settingsLoading - the first read is still running
 * @param updateSetting - useSettings' writer
 */
export function useNoticeGate(
    settings: RendererSettings | null,
    settingsLoading: boolean,
    updateSetting: (key: 'noticeAcknowledgedVersion', value: number) => Promise<void>,
): NoticeGate {
    const [state, setState] = useState<'checking' | 'open' | 'done'>('checking');
    const acknowledged = settings?.app.noticeAcknowledgedVersion;

    useEffect(() => {
        if (settingsLoading) return;
        setState((current) => {
            if (current !== 'checking') return current;
            return typeof acknowledged === 'number' && acknowledged >= CURRENT_NOTICE_VERSION ? 'done' : 'open';
        });
    }, [settingsLoading, acknowledged]);

    const acknowledge = useCallback(async () => {
        setState('done');
        try {
            await updateSetting('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION);
        } catch (err) {
            await ipc.logRendererError(`Failed to persist noticeAcknowledgedVersion: ${errorMessage(err) || err}`);
        }
    }, [updateSetting]);

    return { open: state === 'open', pending: state !== 'done', acknowledge };
}
