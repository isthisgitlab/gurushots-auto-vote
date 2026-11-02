import { useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import {
    remoteConnectionState,
    remoteHostPath,
    subscribeRemoteConnectionState,
    subscribeRemoteHostPath,
} from '../../../core/remote/connectionState';
import { phoneRemoteMode } from '../../../core/remote/phoneMode';

import type { RemoteConnectionState } from '../../../core/remote/connectionState';

/** The sessionStorage flag that offers "Add to Home Screen" once per session. */
const HOME_HINT_FLAG = 'remote-add-home-hint';

/** The badge label of each connection state (the long offline detail and full sentence render in banners, the long unpublished sentence in the notice screen). */
const STATE_LABEL_KEYS: Record<RemoteConnectionState, string> = {
    connecting: 'app.remoteConnecting',
    connected: 'app.remoteConnected',
    offline: 'app.remoteOfflineShort',
    network: 'app.remoteNetwork',
    'old-browser': 'app.remoteOldBrowserShort',
    update: 'app.remoteUpdateNeeded',
    'update-this': 'app.remoteUpdateThis',
    unpublished: 'app.remotePageUnpublished',
    full: 'app.remoteFullShort',
    'no-key': 'app.remoteNoKey',
};

/** Whether the page already runs as an installed Home Screen app (Android/Chrome display mode, or iOS standalone). */
const runsAsInstalledApp = (): boolean =>
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true ||
    (globalThis.navigator as Navigator & { standalone?: boolean }).standalone === true;

const firstVisit = (): boolean => {
    // Already on the Home Screen, or inside the Android app (its Disconnect is installed): nothing to add.
    if (runsAsInstalledApp() || phoneRemoteMode()?.disconnect !== undefined) return false;
    try {
        if (globalThis.sessionStorage?.getItem(HOME_HINT_FLAG) === '1') return false;
        globalThis.sessionStorage?.setItem(HOME_HINT_FLAG, '1');
        return true;
    } catch {
        return false;
    }
};

/**
 * The phone's connection badge: what the pairing connection is doing, translated. The offline
 * state adds the full offline-or-reset explanation and the full state the too-many-phones
 * sentence as banners, and on the session's first connect it offers "Add to Home Screen" once.
 */
export function RemoteStateBadge() {
    const { t } = useTranslation();
    const [state, setState] = useState<RemoteConnectionState>(remoteConnectionState);
    const [hintShown, setHintShown] = useState(false);
    const [path, setPath] = useState(remoteHostPath);
    useLayoutEffect(() => subscribeRemoteConnectionState(setState), []);
    // The desktop can move from the relay to WebRTC while connected: the badge follows.
    useLayoutEffect(() => subscribeRemoteHostPath(setPath), []);
    useEffect(() => {
        if (state === 'connected' && firstVisit()) setHintShown(true);
    }, [state]);

    const tone =
        state === 'connected'
            ? 'badge-success'
            : state === 'connecting'
              ? 'badge-ghost'
              : state === 'update' || state === 'update-this' || state === 'unpublished'
                ? 'badge-warning'
                : 'badge-error';

    return (
        <>
            <span className={`badge ${tone} badge-sm whitespace-nowrap`} role="status">
                {t(state === 'connected' && path === 'relay' ? 'app.remoteConnectedRelay' : STATE_LABEL_KEYS[state])}
            </span>
            {state === 'offline' && (
                <div className="alert alert-warning text-sm fixed bottom-0 inset-x-0 z-50 rounded-none" role="alert">
                    <span>{t('app.remoteOfflineDetail')}</span>
                </div>
            )}
            {state === 'full' && (
                <div className="alert alert-warning text-sm fixed bottom-0 inset-x-0 z-50 rounded-none" role="alert">
                    <span>{t('app.remoteFull')}</span>
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
