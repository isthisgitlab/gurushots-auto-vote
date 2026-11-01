import { useEffect, useState } from 'react';
import { remoteConnectionState, subscribeRemoteConnectionState } from '../../../core/remote/connectionState';
import { rendererTranslator } from '../../../core/translations/renderer';

/**
 * The full-screen state the phone page shows when the app itself cannot be shown: no key in
 * the link, or the loader's connecting/offline/update states. Outside the TranslationProvider
 * (there is no bridge to read a language from), so it uses the shared renderer translator's
 * current language.
 */
export function RemoteNoticeScreen() {
    const [state, setState] = useState(remoteConnectionState);
    useEffect(() => subscribeRemoteConnectionState(setState), []);
    const labelKey =
        state === 'no-key'
            ? 'app.remoteNoKey'
            : state === 'network'
              ? 'app.remoteNetwork'
              : state === 'update'
                ? 'app.remoteUpdateNeeded'
                : state === 'offline'
                  ? 'app.remoteOfflineDetail'
                  : 'app.remoteConnecting';
    return (
        <main className="min-h-screen flex items-center justify-center p-6">
            <div className="alert alert-warning text-sm" role="status">
                <span>{rendererTranslator.t(labelKey)}</span>
            </div>
        </main>
    );
}
