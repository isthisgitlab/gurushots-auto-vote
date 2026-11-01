/**
 * The remote channel classification: every channel of the manifest — invoke
 * channels, alias targets, send and event channels — is classified exactly
 * once as allowed, refused (with a reason), or host-answered, so a new
 * unclassified channel fails here until someone decides what a paired phone
 * may reach.
 */

import {
    ALLOWED,
    ALLOWED_REMOTE_CHANNELS,
    AUTOVOTE_RUNNING_KEY,
    HOST_ANSWERED,
    REFUSED,
    SPEND_REMOTE_CHANNELS,
    classifyRemoteChannel,
} from '../../src/ts/core/remote/allowlist';

import type {
    RemoteAllowed,
    RemoteChannelClass,
    RemoteHostAnswered,
    RemoteRefusal,
} from '../../src/ts/core/remote/allowlist';

/** Type-level consumers of the classification's three shapes. */
const asRefusal = (classified: RemoteChannelClass): classified is RemoteRefusal => classified.kind === 'refused';
const asAllowed = (classified: RemoteChannelClass): classified is RemoteAllowed => classified.kind === 'allowed';
const asHostAnswered = (classified: RemoteChannelClass): classified is RemoteHostAnswered => classified.kind === 'host';
import { allInvokeChannels, eventMethods, sendMethods } from '../../src/ts/core/ipc/manifest';

/** Every channel the manifest exposes, invokes and alias targets and sends and events. */
const everyChannel = (): string[] => [
    ...allInvokeChannels(),
    ...Object.values(sendMethods),
    ...Object.values(eventMethods),
];

describe('the remote channel classification', () => {
    test('every manifest channel is listed explicitly in exactly one of ALLOWED, REFUSED and HOST_ANSWERED', () => {
        // The fallback refusal in classifyRemoteChannel keeps an unlisted channel safe at runtime, but it must
        // not be what classifies a manifest channel: a new channel fails here until someone lists it.
        const allowed: readonly string[] = ALLOWED;
        const refused = Object.keys(REFUSED);
        const hostAnswered: readonly string[] = HOST_ANSWERED;
        const unlisted: string[] = [];
        const listedTwice: string[] = [];
        for (const channel of new Set(everyChannel())) {
            const lists = [allowed.includes(channel), refused.includes(channel), hostAnswered.includes(channel)];
            const count = lists.filter(Boolean).length;
            if (count === 0) unlisted.push(channel);
            if (count > 1) listedTwice.push(channel);
        }
        expect(unlisted).toEqual([]);
        expect(listedTwice).toEqual([]);
    });

    test('nothing is listed that the manifest does not have', () => {
        const manifest = new Set(everyChannel());
        const stale = [...ALLOWED, ...Object.keys(REFUSED), ...HOST_ANSWERED].filter(
            (channel) => !manifest.has(channel),
        );
        expect(stale).toEqual([]);
    });

    test('a channel outside the manifest is refused by the fallback', () => {
        const classified = classifyRemoteChannel('a-channel-nobody-listed');
        expect(asRefusal(classified)).toBe(true);
        if (asRefusal(classified)) expect(classified.reason).toContain('not part of the remote surface');
    });

    test('every manifest channel is classified exactly once', () => {
        const seen = new Map<string, string>();
        for (const channel of everyChannel()) {
            const classified = classifyRemoteChannel(channel);
            expect(classified.kind === 'allowed' || classified.kind === 'refused' || classified.kind === 'host').toBe(
                true,
            );
            expect(seen.has(channel)).toBe(false);
            seen.set(channel, classified.kind);
        }
        expect(seen.size).toBe(new Set(everyChannel()).size);
        // And nothing outside the manifest is classified: the sets move together.
        for (const channel of ALLOWED_REMOTE_CHANNELS) {
            expect(everyChannel()).toContain(channel);
        }
    });

    test('the allowed set is non-empty and the host-answered set is the log stream and the metadata cleanup', () => {
        expect(ALLOWED_REMOTE_CHANNELS.size).toBeGreaterThan(50);
        expect(asHostAnswered(classifyRemoteChannel('start-log-stream'))).toBe(true);
        expect(asHostAnswered(classifyRemoteChannel('stop-log-stream'))).toBe(true);
        // The phone's challenge list calls it after every refresh: answered, never forwarded.
        expect(asHostAnswered(classifyRemoteChannel('cleanup-stale-metadata'))).toBe(true);
        expect(asAllowed(classifyRemoteChannel('get-log-backlog'))).toBe(true);
    });

    test.each([
        ['authenticate', 'account'],
        [sendMethods.logout, 'account'],
        [sendMethods.login, 'account'],
        ['wipe-local-data', 'local data'],
        ['get-log-file', 'log file'],
        ['get-error-log-file', 'log file'],
        ['get-api-log-file', 'log file'],
        ['download-update', 'update'],
        ['install-update', 'update'],
        ['open-external-url', 'window'],
        ['reload-window', 'window'],
        ['refresh-menu', 'window'],
        ['run-voting-cycle', 'voting'],
        ['set-cancel-voting', 'voting'],
        ['get-remote-access', 'pairing'],
        ['set-remote-access', 'pairing'],
        ['reset-remote-pairing', 'pairing'],
        ['reset-all-settings', 'destructive'],
        ['start-fresh-settings', 'destructive'],
        ['retry-settings-import', 'destructive'],
        ['reset-all-global-defaults', 'destructive'],
        ['reset-all-scenario-state', 'destructive'],
        ['import-scenario', 'destructive'],
        ['log-remote-info', 'log file'],
    ])('refuses %s (%s) with a non-empty reason', (channel, _group) => {
        const classified = classifyRemoteChannel(channel);
        expect(asRefusal(classified)).toBe(true);
        if (asRefusal(classified)) {
            expect(classified.reason.length).toBeGreaterThan(0);
        }
    });

    test('the event channels flow one way only', () => {
        for (const channel of Object.values(eventMethods)) {
            expect(asRefusal(classifyRemoteChannel(channel))).toBe(true);
        }
    });
});

describe('the spend channels', () => {
    test('every channel whose handler can spend currency is in the set, with the turbo alias', () => {
        for (const channel of [
            'join-challenge',
            'key-unlock-boost',
            'swap-entry-photo',
            'swap-back-entry-photo',
            'fill-exposure',
            'apply-turbo-to-entry',
            'play-auto-turbo',
            // A voting pass can run auto-spends, so a lost reply is unclear, not failed.
            'run-voting-cycle-for-challenge',
            'vote-all-challenges-manual',
        ]) {
            expect(SPEND_REMOTE_CHANNELS.has(channel)).toBe(true);
        }
    });

    test('reads and non-spend actions are not spends', () => {
        for (const channel of ['get-settings', 'suggest-photos', 'simulate-scenario', 'get-log-backlog']) {
            expect(SPEND_REMOTE_CHANNELS.has(channel)).toBe(false);
        }
    });
});

describe('the autovoteRunning key guard', () => {
    test('the guarded key is the settings key itself', () => {
        expect(AUTOVOTE_RUNNING_KEY).toBe('autovoteRunning');
    });
});
