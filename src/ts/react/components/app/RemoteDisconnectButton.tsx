import { useState } from 'react';
import { phoneRemoteMode } from '../../../core/remote/phoneMode';

/**
 * The Android remote mode's "Disconnect": leaves the computer's app for the phone's own
 * (voting off). The bundled remote page installs the action, so a browser tab or the desktop
 * renders nothing. A leave that failed says so — the key could not be cleared, the page stays
 * in remote mode — rather than doing nothing. Takes its translator as a prop because the
 * loader's notice screen sits outside the TranslationProvider.
 */
export function RemoteDisconnectButton({ t, className }: { t: (key: string) => string; className: string }) {
    const disconnect = phoneRemoteMode()?.disconnect;
    const [failed, setFailed] = useState(false);
    if (disconnect === undefined) return null;
    return (
        <>
            {failed && (
                <span className="text-error text-xs" role="alert">
                    {t('errors.remoteDisconnectFailed')}
                </span>
            )}
            <button
                type="button"
                className={className}
                onClick={() => {
                    setFailed(false);
                    disconnect().catch(() => setFailed(true));
                }}
            >
                {t('app.remoteDisconnect')}
            </button>
        </>
    );
}
