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
    READ_REMOTE_CHANNELS,
    SPEND_REMOTE_CHANNELS,
    classifyRemoteChannel,
    classifyRemoteCommand,
    classifyRemoteOperation,
    scenarioControlTarget,
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

/** The channels P12a added, and what a paired phone may do with each (the plan's remote matrix). */
const READS = [
    'get-scenario-capabilities',
    'get-scenario-snapshot',
    'get-effective-installation-settings',
    'get-effective-presentation',
    'list-simulation-subjects',
    'get-installation-scenario',
    'get-stop-status',
    'get-photo-pools',
    'get-effective-entry-pins',
    'get-scenario-request-status',
];
const EFFECTS = [
    'set-installation-scenario',
    'pause-scenario',
    'resume-scenario',
    'handoff-scenario',
    'clear-scenario-assignment',
    'set-photo-pool',
    'delete-photo-pool',
    'rename-photo-pool',
];
const LOCAL_ONLY = [
    'transfer-installation-scenario-owner',
    'scenario-stop-fence',
    'record-full-stop',
    'arm-autovote',
    'arm-if-allowed',
    'withdraw-installation',
    'rearm-installation',
    'get-account-wake',
    'begin-scenario-request',
    'finish-scenario-request',
];

describe('the scenario channels', () => {
    test.each([...READS, ...EFFECTS])('%s is allowed to a paired phone', (channel) => {
        expect(asAllowed(classifyRemoteChannel(channel))).toBe(true);
    });

    test.each(LOCAL_ONLY)('%s is refused: it is done on the computer', (channel) => {
        const classified = classifyRemoteChannel(channel);
        expect(asRefusal(classified)).toBe(true);
        if (asRefusal(classified)) expect(classified.reason.length).toBeGreaterThan(0);
    });

    test('an owner transfer names the selected computer; the other local routes keep the generic reason', () => {
        expect(classifyRemoteChannel('transfer-installation-scenario-owner')).toEqual({
            kind: 'refused',
            reason: 'Owner transfer is done on the selected computer.',
        });
        expect(classifyRemoteChannel('arm-autovote')).toEqual({
            kind: 'refused',
            reason: 'This is done on the computer.',
        });
    });

    test('the effective projections reach a phone as events only: a peer-to-host event is refused', () => {
        for (const channel of ['effective-settings-changed', 'effective-presentation-changed']) {
            expect(classifyRemoteChannel(channel)).toEqual({
                kind: 'refused',
                reason: 'Events flow from the computer to the phone only.',
            });
        }
    });

    test('no raw controller or lifecycle flag, credential or reset channel became allowed', () => {
        for (const channel of [
            'run-voting-cycle',
            'set-cancel-voting',
            'set-remote-access',
            'reset-remote-pairing',
            'reset-all-settings',
            'reset-all-scenario-state',
            'import-scenario',
            'wipe-local-data',
            'authenticate',
        ]) {
            expect(asRefusal(classifyRemoteChannel(channel))).toBe(true);
        }
    });
});

describe('the operation class', () => {
    test.each(READS)('%s is a read: it may wait for the host and be asked again', (channel) => {
        expect(classifyRemoteOperation(channel)).toBe('read');
    });

    test.each([
        'check-scenario',
        'dry-run-scenario',
        'simulate-scenario',
        'preview-scenario-import',
        'export-scenario',
    ])('%s is a read', (channel) => {
        expect(classifyRemoteOperation(channel)).toBe('read');
    });

    test.each([...EFFECTS, 'save-scenario', 'rename-scenario', 'delete-scenario', 'set-setting', 'save-settings'])(
        '%s is an effect: never queued, never sent again',
        (channel) => {
            expect(classifyRemoteOperation(channel)).toBe('effect');
        },
    );

    test('every spend channel is a spend', () => {
        for (const channel of SPEND_REMOTE_CHANNELS) expect(classifyRemoteOperation(channel)).toBe('spend');
    });

    test('a refused or unknown channel is an effect: nothing about it waits or repeats', () => {
        expect(classifyRemoteOperation('transfer-installation-scenario-owner')).toBe('effect');
        expect(classifyRemoteOperation('a-channel-nobody-listed')).toBe('effect');
    });

    test('every read is a channel the phone may use, and none of them is a spend', () => {
        for (const channel of READ_REMOTE_CHANNELS) {
            expect(classifyRemoteChannel(channel).kind).not.toBe('refused');
            expect(SPEND_REMOTE_CHANNELS.has(channel)).toBe(false);
        }
    });

    test('a Stop is the priority operation; a Start and a re-arm are effects', () => {
        expect(classifyRemoteCommand('stop')).toBe('priority-stop');
        expect(classifyRemoteCommand('start')).toBe('effect');
        expect(classifyRemoteCommand('rearm')).toBe('effect');
    });
});

describe('which calls change a scenario', () => {
    test.each([
        ['set-installation-scenario', ['Plan', 'electron', 0], '@installation'],
        ['pause-scenario', ['123'], '123'],
        ['resume-scenario', [123], '123'],
        ['handoff-scenario', ['@installation', 'Plan', 2], '@installation'],
        ['clear-scenario-assignment', ['123', 1], '123'],
        ['reset-scenario-state', ['123'], '123'],
        ['pause-scenario', [{}], 'subject'],
        ['save-scenario', [{}], 'definitions'],
        ['rename-scenario', ['a', 'b'], 'definitions'],
        ['delete-scenario', ['a'], 'definitions'],
        ['set-photo-pool', ['p', []], 'pools'],
        ['delete-photo-pool', ['p'], 'pools'],
        ['rename-photo-pool', ['p', 'q'], 'pools'],
        ['set-entry-pin', ['1', 'boost', 'x'], 'pins'],
        ['apply-challenge-profile', ['1', 'p'], 'assignments'],
        ['save-challenge-profile', ['p', {}], 'assignments'],
        ['delete-challenge-profile', ['p'], 'assignments'],
        ['set-title-rules', [[]], 'assignments'],
    ])('%s %j is a scenario change with the target %s', (channel, args, target) => {
        expect(scenarioControlTarget(channel, args)).toBe(target);
    });

    test.each([
        'set-setting',
        'reset-setting',
        'set-global-default',
        'reset-global-default',
        'set-challenge-override',
        'remove-challenge-override',
    ])('%s is a scenario change for the scenario key only', (channel) => {
        expect(scenarioControlTarget(channel, ['scenario', 'x'])).toBe('assignments');
        expect(scenarioControlTarget(channel, ['exposure', 'x'])).toBeNull();
    });

    test.each(['save-settings', 'set-challenge-overrides', 'replace-challenge-overrides'])(
        '%s is a scenario change when its arguments carry the scenario key at any depth',
        (channel) => {
            expect(scenarioControlTarget(channel, [{ scenario: 'x' }])).toBe('assignments');
            expect(scenarioControlTarget(channel, ['1', { values: { scenario: 'x' } }])).toBe('assignments');
            expect(scenarioControlTarget(channel, [[{ a: { scenario: 'x' } }]])).toBe('assignments');
            expect(scenarioControlTarget(channel, [{ exposure: 1, nested: { fine: [1, 'two', null] } }])).toBeNull();
            expect(scenarioControlTarget(channel, [])).toBeNull();
        },
    );

    test('an argument nested deeper than the search is treated as carrying the key', () => {
        let deep: unknown = { fine: 1 };
        for (let level = 0; level < 12; level++) deep = { next: deep };
        expect(scenarioControlTarget('save-settings', [deep])).toBe('assignments');
    });

    test.each([
        'get-settings',
        'get-installation-scenario',
        'join-challenge',
        'acknowledge-import-report',
        'a-channel-nobody-listed',
    ])('%s is not a scenario change', (channel) => {
        expect(scenarioControlTarget(channel, [])).toBeNull();
    });
});
