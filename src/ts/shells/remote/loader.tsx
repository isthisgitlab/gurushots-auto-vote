/** The root remote entry launches the current page without opening a transport. */

import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { takePairingKey } from '../../core/remote/pairingKey';
import { mountRemoteNotice } from '../../react/components/app/RemoteNoticeScreen';
void (() => {
    const key = takePairingKey();
    if (key === null) {
        setRemoteConnectionState('no-key');
        mountRemoteNotice();
        return;
    }
    globalThis.location.replace(`./v2/index.html#k=${encodeURIComponent(key)}`);
})();
