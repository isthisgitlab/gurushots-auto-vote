import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { remoteConnectionState, subscribeRemoteConnectionState } from '../../../core/remote/connectionState';
import { rendererTranslator } from '../../../core/translations/renderer';
import { RemoteDisconnectButton } from './RemoteDisconnectButton';

const NOTICE_MESSAGE_KEYS = {
    connecting: 'app.remoteConnecting',
    connected: 'app.remoteConnecting',
    offline: 'app.remoteOfflineDetail',
    network: 'app.remoteNetwork',
    'old-browser': 'app.remoteOldBrowser',
    update: 'app.remoteUpdateNeeded',
    'update-this': 'app.remoteUpdateThis',
    full: 'app.remoteFull',
    'no-key': 'app.remoteNoKey',
} as const;

/**
 * The full-screen state the phone page shows when the app itself cannot be shown: no key in
 * the link, or the loader's connecting/offline/update states. Outside the TranslationProvider
 * (there is no bridge to read a language from), so it uses the shared renderer translator's
 * current language.
 */
export function RemoteNoticeScreen() {
    const [state, setState] = useState(remoteConnectionState);
    // Subscribed in the commit itself, not after the next paint: the loader changes the state while the room
    // is being joined, and a change between the first paint and a later effect would be lost.
    useLayoutEffect(() => subscribeRemoteConnectionState(setState), []);
    const labelKey = NOTICE_MESSAGE_KEYS[state];
    return (
        <main className="min-h-screen flex items-center justify-center p-6">
            <div className="alert alert-warning text-sm" role="status">
                <span>{rendererTranslator.t(labelKey)}</span>
                {/* On the Android remote mode the notice must still leave: the app opens here until it does */}
                <RemoteDisconnectButton t={(key) => rendererTranslator.t(key)} className="btn btn-outline btn-sm" />
            </div>
        </main>
    );
}

/**
 * Mounts the notice screen into the document's `#root`, once: the screen follows the connection state
 * itself (so a later call is a no-op). The page has no settings to read a language from yet, so the browser's language decides —
 * Latvian when it is, English otherwise.
 */
export function mountRemoteNotice(): void {
    const root = document.getElementById('root');
    if (!root || root.dataset.remoteNotice === 'mounted') return;
    root.dataset.remoteNotice = 'mounted';
    if (globalThis.navigator?.language?.toLowerCase().startsWith('lv') === true) {
        rendererTranslator.setCurrentLanguage('lv');
    }
    root.replaceChildren();
    createRoot(root).render(<RemoteNoticeScreen />);
}
