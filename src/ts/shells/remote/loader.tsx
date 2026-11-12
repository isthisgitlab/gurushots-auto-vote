/**
 * Remote loader entry. The root URL is a version router, not a transport client: an unversioned
 * loader link is the released v1 page, and a modern versioned page returns with a checked `v`
 * fragment. This prevents a current transport from probing an older desktop.
 */

import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { clearSkipMark, markSkippedTo, skippedTo } from '../../core/remote/linkVersion';
import { PAIRING_KEY_PARAM, parsePairingLink, takePairingKey } from '../../core/remote/pairingKey';
import { LINK_VERSION } from '../../core/remote/protocol';
import { mountRemoteNotice } from '../../react/components/app/RemoteNoticeScreen';
import { phoneRemoteMode } from '../../core/remote/phoneMode';
import { installPhoneDisconnect } from './phoneMode';

type PageDir = string;

const linkVersionDir = (linkVersion: number): PageDir => `v${linkVersion}`;
const versionPage = (dir: PageDir): string => `./${encodeURIComponent(dir)}/index.html`;

/** A reload or history traversal explicitly retries an earlier unavailable target. */
const isRetryNavigation = (): boolean => {
    const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
    if (entry !== undefined) return entry.type === 'reload' || entry.type === 'back_forward';
    const legacy = globalThis.performance?.navigation?.type;
    return legacy === 1 || legacy === 2;
};

/** Only an explicit 404 or 410 says the selected page is absent; all other outcomes still try that page. */
const pageIsPublished = async (dir: PageDir): Promise<boolean | null> => {
    try {
        const response = await fetch(versionPage(dir), { method: 'HEAD' });
        return response.status === 404 || response.status === 410 ? false : null;
    } catch {
        return null;
    }
};

void (async () => {
    let target = parsePairingLink(globalThis.location.href);
    let targetHash = globalThis.location.hash;
    if (target === null) {
        const url = new URL(globalThis.location.href);
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (!fragment.has(PAIRING_KEY_PARAM)) {
            const key = takePairingKey();
            if (key !== null) {
                fragment.set(PAIRING_KEY_PARAM, key);
                url.hash = fragment.toString();
                target = parsePairingLink(url.href);
                targetHash = url.hash;
            }
        }
    }
    if (target === null) {
        setRemoteConnectionState('no-key');
        mountRemoteNotice();
        return;
    }
    installPhoneDisconnect();
    mountRemoteNotice();

    if (phoneRemoteMode() !== null && target.linkVersion !== LINK_VERSION) {
        setRemoteConnectionState(target.linkVersion < LINK_VERSION ? 'older-link' : 'newer-link');
        return;
    }

    if (isRetryNavigation()) clearSkipMark();
    const dir = linkVersionDir(target.linkVersion);
    if (skippedTo(target)) {
        clearSkipMark();
        setRemoteConnectionState('link-changed');
        return;
    }

    // v1 is a known released page: do not ask the network or a current transport before navigating.
    if (target.linkVersion === 1) {
        markSkippedTo(target);
        globalThis.location.replace(`${versionPage(dir)}${targetHash}`);
        return;
    }

    const published = await pageIsPublished(dir);
    if (published === false) {
        setRemoteConnectionState(phoneRemoteMode() === null ? 'unpublished' : 'update-this');
        return;
    }
    // A failed probe is not evidence that a selected page is absent. Navigate only to that page.
    markSkippedTo(target);
    globalThis.location.replace(`${versionPage(dir)}${targetHash}`);
})().catch(() => {
    setRemoteConnectionState('offline');
    mountRemoteNotice();
});
