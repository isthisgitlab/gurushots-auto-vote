import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { remoteConnectionState, subscribeRemoteConnectionState } from '../../../core/remote/connectionState';

import type { RemoteConnectionState } from '../../../core/remote/connectionState';

/** The sessionStorage flag that offers "Add to Home Screen" once per session. */
const HOME_HINT_FLAG = 'remote-add-home-hint';

/** The badge label of each connection state (the long offline detail renders in the banner). */
const STATE_LABEL_KEYS: Record<RemoteConnectionState, string> = {
    connecting: 'app.remoteConnecting',
    connected: 'app.remoteConnected',
    offline: 'app.remoteOfflineShort',
    network: 'app.remoteNetwork',
    update: 'app.remoteUpdateNeeded',
    'no-key': 'app.remoteNoKey',
};

const firstVisit = (): boolean => {
    try {
        if (globalThis.sessionStorage?.getItem(HOME_HINT_FLAG) === '1') return false;
        globalThis.sessionStorage?.setItem(HOME_HINT_FLAG, '1');
        return true;
    } catch {
        return false;
    }
};

/**
 * The phone's connection badge: what the pairing connection is doing, translated. While the
 * desktop is unreachable it adds the full offline-or-reset explanation as a banner, and on
 * the session's first connect it offers "Add to Home Screen" once.
 */
export function RemoteStateBadge() {
    const { t } = useTranslation();
    const [state, setState] = useState<RemoteConnectionState>(remoteConnectionState);
    const [hintShown, setHintShown] = useState(false);
    useEffect(() => subscribeRemoteConnectionState(setState), []);
    useEffect(() => {
        if (state === 'connected' && firstVisit()) setHintShown(true);
    }, [state]);

    const tone =
        state === 'connected'
            ? 'badge-success'
            : state === 'connecting'
              ? 'badge-ghost'
              : state === 'update'
                ? 'badge-warning'
                : 'badge-error';

    return (
        <>
            <span className={`badge ${tone} badge-sm whitespace-nowrap`} role="status">
                {t(STATE_LABEL_KEYS[state])}
            </span>
            {state === 'offline' && (
                <div className="alert alert-warning text-sm fixed bottom-0 inset-x-0 z-50 rounded-none" role="alert">
                    <span>{t('app.remoteOfflineDetail')}</span>
                </div>
            )}
            {hintShown && state === 'connected' && (
                <div className="alert alert-info text-sm fixed bottom-0 inset-x-0 z-50 rounded-none" role="status">
                    <span>{t('app.remoteAddToHomeScreen')}</span>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => setHintShown(false)}>
                        {t('common.ok')}
                    </button>
                </div>
            )}
        </>
    );
}
