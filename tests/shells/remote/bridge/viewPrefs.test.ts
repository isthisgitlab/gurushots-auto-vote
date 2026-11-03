/**
 * The phone-local view settings (viewPrefs.ts): the four view keys are answered from the
 * device's localStorage and never reach sendInvoke for those keys, every desktop settings
 * object seeds only what is still unset, every challenge id is seeded by ONE combined
 * single-flight seed that forwards the overrides, effective and desktop-global reads
 * together and decides from all three answers — a desktop own override becomes the phone's
 * own, a value differing from the desktop's baseline is inherited rather than an own
 * override, and a failed or non-boolean read stores nothing and passes through — storage
 * that refuses or lies falls back to memory, and a phone write dispatches the bridge's own
 * settings-changed with the phone's values in place. The reads and writes go through the
 * same wrapper apiSurface installs, so a forwarded channel really rides the send double.
 * The last describe runs the flows through the installed peer bridge, where the desktop's
 * settings-changed events are overlaid before the listeners see them.
 */

import { createViewPrefs, VIEW_PREFS_STORAGE } from '../../../../src/ts/shells/remote/bridge/viewPrefs';
import { createPeerBridgeContext } from '../../../../src/ts/shells/remote/bridge/context';
import { installPeerBridge } from '../../../../src/ts/shells/remote/bridge/peer';
import { PAGE_VERSION, PROTOCOL_VERSION } from '../../../../src/ts/core/remote/protocol';
import { setRemoteConnectionState, setRemoteHostPeerId } from '../../../../src/ts/core/remote/connectionState';
import { isPlainObject } from '../../../../src/ts/core/plainObject';
import { TransportStub } from '../../../helpers/remoteTransport';

import type { PeerBridgeContext } from '../../../../src/ts/shells/remote/bridge/context';
import type { InvokePipeline } from '../../../../src/ts/shells/remote/bridge/invokes';
import type { ViewPrefs } from '../../../../src/ts/shells/remote/bridge/viewPrefs';

// ---------------------------------------------------------------- storage doubles (desktopVersion.test.ts style)

const memoryStorage = (): Storage => {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (name) => items.get(name) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (name) => void items.delete(name),
        setItem: (name, value) => void items.set(name, value),
    };
};

const refusingStorage = (): Storage => {
    const refuse = (): never => {
        throw new Error('site data refused');
    };
    return { length: 0, clear: refuse, getItem: refuse, key: refuse, removeItem: refuse, setItem: refuse };
};

const memoryStorageWith = (value: object): Storage => {
    const storage = memoryStorage();
    storage.setItem(VIEW_PREFS_STORAGE, JSON.stringify(value));
    return storage;
};

const setStorage = (value: Storage): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value });
};

const storedRaw = (): string | null =>
    (globalThis.localStorage as Storage | undefined)?.getItem(VIEW_PREFS_STORAGE) ?? null;

/** The persisted store and its overrides map, narrowed by the same guard the production read uses. */
const storedOverrides = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(storedRaw() ?? '{}');
    if (!isPlainObject(parsed)) throw new Error('the persisted store must be an object');
    const overrides = parsed.compactOverrides;
    if (!isPlainObject(overrides)) throw new Error('the persisted overrides map must be an object');
    return overrides;
};

/** The persisted store's inherited map, narrowed the same way. */
const storedInherited = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(storedRaw() ?? '{}');
    if (!isPlainObject(parsed)) throw new Error('the persisted store must be an object');
    const inherited = parsed.compactInherited;
    if (!isPlainObject(inherited)) throw new Error('the persisted inherited map must be an object');
    return inherited;
};

afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
});

// ---------------------------------------------------------------- desktop payloads and the send double

/** A get-settings-shaped desktop payload. */
const desktopSettings = (
    parts: {
        theme?: string;
        language?: string;
        compactCards?: boolean;
        compactCardActions?: boolean;
        challenges?: Record<string, unknown>;
    } = {},
): Record<string, unknown> => ({
    app: { theme: parts.theme ?? 'light', language: parts.language ?? 'en', timezone: 'UTC' },
    defaults: { compactCards: parts.compactCards ?? false, compactCardActions: parts.compactCardActions ?? false },
    challenges: parts.challenges ?? {},
    hasToken: true,
});

type PendingInvoke = {
    channel: string;
    args: unknown[];
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

const makeSend = (): {
    send: InvokePipeline['sendInvoke'];
    sent: Array<{ channel: string; args: unknown[] }>;
    pending: PendingInvoke[];
} => {
    const sent: Array<{ channel: string; args: unknown[] }> = [];
    const pending: PendingInvoke[] = [];
    const send: InvokePipeline['sendInvoke'] = (channel: string, args: unknown[]) =>
        new Promise((resolve, reject) => {
            sent.push({ channel, args });
            pending.push({ channel, args, resolve, reject });
        });
    return { send, sent, pending };
};

const resolveFor = (pending: PendingInvoke[], channel: string, value: unknown): void => {
    const at = pending.findIndex((p) => p.channel === channel);
    if (at < 0) throw new Error(`no pending invoke for ${channel}`);
    const [found] = pending.splice(at, 1);
    found.resolve(value);
};

const rejectFor = (pending: PendingInvoke[], channel: string, error: Error): void => {
    const at = pending.findIndex((p) => p.channel === channel);
    if (at < 0) throw new Error(`no pending invoke for ${channel}`);
    const [found] = pending.splice(at, 1);
    found.reject(error);
};

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** One viewPrefs instance with the apiSurface wrapper over it: a routed answer stays local, everything else sends. */
const makePrefs = (
    storage: Storage = memoryStorage(),
): {
    invoke: (channel: string, args: unknown[]) => Promise<unknown>;
    route: ViewPrefs['route'];
    ingestSettings: (payload: unknown) => unknown;
    sent: Array<{ channel: string; args: unknown[] }>;
    pending: PendingInvoke[];
    seen: unknown[];
    sentFor: (channel: string) => number;
} => {
    setStorage(storage);
    const ctx: PeerBridgeContext = createPeerBridgeContext(new TransportStub('phone'));
    const seen: unknown[] = [];
    ctx.listeners.set('settings-changed', new Set([(payload: unknown) => seen.push(payload)]));
    const { send, sent, pending } = makeSend();
    const prefs = createViewPrefs({ ctx, sendInvoke: send });
    const route = prefs.route.bind(prefs);
    return {
        invoke: (channel, args) => route(channel, args) ?? send(channel, args),
        route,
        ingestSettings: prefs.ingestSettings.bind(prefs),
        sent,
        pending,
        seen,
        sentFor: (channel: string) => sent.filter(({ channel: sentChannel }) => sentChannel === channel).length,
    };
};

/** A factory whose phone store was already seeded from one desktop snapshot. */
const makeSeeded = async (parts?: Parameters<typeof desktopSettings>[0]): Promise<ReturnType<typeof makePrefs>> => {
    const made = makePrefs();
    const snapshot = made.invoke('get-settings', []);
    resolveFor(made.pending, 'get-settings', desktopSettings(parts));
    await snapshot;
    return made;
};

/** A store with `count` own-override entries, for the per-map cap tests. */
const fullOverrideStorage = (count: number): Storage => {
    const entries: Record<string, boolean | null> = {};
    for (let i = 0; i < count; i++) entries[`c${i}`] = true;
    return memoryStorageWith({ compactOverrides: entries });
};

// ---------------------------------------------------------------- routed channels

describe('the routed channels answer from the phone store', () => {
    test('an unseeded get-setting forwards once and seeds; a seeded one never forwards', async () => {
        const { invoke, sent, pending } = makePrefs();
        const unseeded = invoke('get-setting', ['theme']);
        expect(sent).toEqual([{ channel: 'get-setting', args: ['theme'] }]); // forwarded once
        resolveFor(pending, 'get-setting', 'dark');
        await expect(unseeded).resolves.toBe('dark'); // the seeded stored value
        await expect(invoke('get-setting', ['theme'])).resolves.toBe('dark'); // seeded: no second forward
        expect(sent).toHaveLength(1);
        expect(storedRaw()).toContain('dark');

        // A failed read stores nothing and passes through; the next read tries again.
        const failed = invoke('get-setting', ['language']);
        resolveFor(pending, 'get-setting', null);
        await expect(failed).resolves.toBeNull();
        const retry = invoke('get-setting', ['language']);
        expect(sent).toHaveLength(3); // theme's seed, the failed read, the retry
        resolveFor(pending, 'get-setting', 'lv');
        await expect(retry).resolves.toBe('lv');

        // Other keys on the same channel reach the desktop unchanged.
        await expect(invoke('set-setting', ['theme', 'night'])).resolves.toBe(true);
        const foreign = invoke('get-setting', ['mock']);
        expect(sent[sent.length - 1]).toEqual({ channel: 'get-setting', args: ['mock'] });
        resolveFor(pending, 'get-setting', 7);
        await expect(foreign).resolves.toBe(7);
    });

    test('set-setting validates like the desktop handler: an invalid value answers false and stores nothing', async () => {
        const { invoke, seen, sent, pending } = makePrefs();
        await expect(invoke('set-setting', ['theme', 'not-a-theme'])).resolves.toBe(false);
        await expect(invoke('set-setting', ['language', 'xx'])).resolves.toBe(false);
        // The keys are still unseeded after the refused writes: the read forwards and its null passes.
        const theme = invoke('get-setting', ['theme']);
        resolveFor(pending, 'get-setting', null);
        await expect(theme).resolves.toBeNull();
        expect(seen.length).toBe(0); // a refused write dispatches nothing
        expect(sent.every(({ channel }) => channel === 'get-setting')).toBe(true);
    });

    test('set-setting for a foreign key forwards unchanged', async () => {
        const { invoke, sent, pending } = makePrefs();
        const foreign = invoke('set-setting', ['mock', 1]);
        expect(sent).toEqual([{ channel: 'set-setting', args: ['mock', 1] }]);
        resolveFor(pending, 'set-setting', 'desktop-answer');
        await expect(foreign).resolves.toBe('desktop-answer');
    });

    test('the compact globals seed through one forwarded read each, then answer from the store', async () => {
        const { invoke, sent, pending } = makePrefs();
        const unseededCards = invoke('get-global-default', ['compactCards']);
        const unseededActions = invoke('get-global-default', ['compactCardActions']);
        expect(sent.map(({ channel }) => channel)).toEqual(['get-global-default', 'get-global-default']);
        resolveFor(pending, 'get-global-default', true);
        resolveFor(pending, 'get-global-default', false);
        await expect(unseededCards).resolves.toBe(true); // the seeded stored value
        await expect(unseededActions).resolves.toBe(false);

        // Seeded: the reads answer from the store, and the phone write wins over the seed.
        await expect(invoke('set-global-default', ['compactCards', false])).resolves.toBe(true);
        await expect(invoke('get-global-default', ['compactCards'])).resolves.toBe(false);
        await expect(invoke('get-global-default', ['compactCardActions'])).resolves.toBe(false);
        expect(sent).toHaveLength(2); // the two seeding reads only

        // A boolean is the only value a write takes.
        await expect(invoke('set-global-default', ['compactCards', 'yes'])).resolves.toBe(false);
        await expect(invoke('set-global-default', ['compactCardActions', 'yes'])).resolves.toBe(false);

        const foreignGet = invoke('get-global-default', ['mock']);
        const foreignSet = invoke('set-global-default', ['mock', 1]);
        resolveFor(pending, 'get-global-default', 3);
        resolveFor(pending, 'set-global-default', 'desktop-answer');
        await expect(foreignGet).resolves.toBe(3);
        await expect(foreignSet).resolves.toBe('desktop-answer');
    });

    test('get-challenge-override answers the phone own override, null for none, and other keys forward', async () => {
        const { invoke, sent, pending } = makePrefs();
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
        // A missing id argument is no id at all: none.
        await expect(invoke('get-challenge-override', ['compactCards'])).resolves.toBeNull();
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', true])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
        // An id that cannot key the store answers null, the desktop's none.
        await expect(invoke('get-challenge-override', ['compactCards', '__proto__'])).resolves.toBeNull();
        await expect(invoke('get-challenge-override', ['compactCards', '  '])).resolves.toBeNull();

        const foreignGet = invoke('get-challenge-override', ['voteTiming', 'c1']);
        const foreignSet = invoke('set-challenge-override', ['voteTiming', 'c1', 5]);
        expect(sent.map(({ channel }) => channel)).toEqual(['get-challenge-override', 'set-challenge-override']);
        resolveFor(pending, 'get-challenge-override', 'desktop');
        resolveFor(pending, 'set-challenge-override', 'desktop');
        await expect(foreignGet).resolves.toBe('desktop');
        await expect(foreignSet).resolves.toBe('desktop');
    });

    test('set-challenge-override refuses an invalid value and an id that cannot key the store', async () => {
        const { invoke, seen, sent } = makePrefs();
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', 'true'])).resolves.toBe(false);
        await expect(invoke('set-challenge-override', ['compactCards', '__proto__', true])).resolves.toBe(false);
        await expect(invoke('set-challenge-override', ['compactCards', 'constructor', true])).resolves.toBe(false);
        await expect(invoke('set-challenge-override', ['compactCards', '  c1  ', true])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
        expect(seen.length).toBe(1); // one accepted write, one local event
        expect(sent).toEqual([]);
    });

    test('remove-challenge-override sets the own override to none and refuses an unsafe id', async () => {
        const { invoke, sent, pending } = makePrefs();
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', true])).resolves.toBe(true);
        await expect(invoke('remove-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
        await expect(invoke('remove-challenge-override', ['compactCards', '__proto__'])).resolves.toBe(false);
        const foreign = invoke('remove-challenge-override', ['voteTiming', 'c1']);
        expect(sent.map(({ channel }) => channel)).toEqual(['remove-challenge-override']);
        resolveFor(pending, 'remove-challenge-override', 'desktop');
        await expect(foreign).resolves.toBe('desktop');
    });

    test('get-effective-setting for another key forwards unchanged', async () => {
        const { invoke, sent, pending } = makePrefs();
        const foreign = invoke('get-effective-setting', ['voteTiming', 'c1']);
        expect(sent).toEqual([{ channel: 'get-effective-setting', args: ['voteTiming', 'c1'] }]);
        resolveFor(pending, 'get-effective-setting', 9);
        await expect(foreign).resolves.toBe(9);
    });

    test('a channel the phone does not route forwards, and get-settings without an object answer passes through', async () => {
        const { invoke, pending } = makePrefs();
        const foreign = invoke('get-active-challenges', []);
        resolveFor(pending, 'get-active-challenges', []);
        await expect(foreign).resolves.toEqual([]);

        const junk = invoke('get-settings', []);
        resolveFor(pending, 'get-settings', null); // a failed desktop read: null passes through, nothing stored
        await expect(junk).resolves.toBeNull();
        // The unseeded theme read goes out, and its null answer passes through unchanged.
        const theme = invoke('get-setting', ['theme']);
        resolveFor(pending, 'get-setting', null);
        await expect(theme).resolves.toBeNull();
    });

    test('a rejected desktop read on a routed channel passes the rejection through unchanged', async () => {
        const { invoke, pending } = makePrefs();
        const read = invoke('get-settings', []);
        rejectFor(pending, 'get-settings', new Error('desktop down'));
        await expect(read).rejects.toThrow('desktop down');
        // The unseeded theme read forwards, and its null answer passes through unchanged.
        const theme = invoke('get-setting', ['theme']);
        resolveFor(pending, 'get-setting', null);
        await expect(theme).resolves.toBeNull();
    });
});

// ---------------------------------------------------------------- seeding

describe('seeding from every desktop source', () => {
    test('get-settings seeds the four unset globals; a snapshot never seeds per-challenge ids', async () => {
        const { invoke } = await makeSeeded({
            compactCards: true,
            challenges: { c1: { values: { compactCards: true } }, c2: {} },
        });

        // The globals seeded: the reads answer from the store now.
        await expect(invoke('get-setting', ['theme'])).resolves.toBe('light');
        await expect(invoke('get-setting', ['language'])).resolves.toBe('en');
        await expect(invoke('get-global-default', ['compactCards'])).resolves.toBe(true);
        // A challenge id is not seeded by a snapshot: get-challenge-override is a pure store read.
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
    });

    test('a later desktop change to any of the four keys never reaches the phone', async () => {
        const made = await makeSeeded({ compactCards: true });
        // Seed c1 as the phone's own override before the later snapshot.
        const c1 = made.invoke('get-challenge-overrides', ['c1']);
        resolveFor(made.pending, 'get-challenge-overrides', { compactCards: true });
        resolveFor(made.pending, 'get-effective-setting', true);
        resolveFor(made.pending, 'get-global-default', true);
        await expect(c1).resolves.toEqual({ compactCards: true });
        const changed = made.invoke('get-settings', []);
        resolveFor(
            made.pending,
            'get-settings',
            desktopSettings({
                theme: 'dark',
                language: 'lv',
                compactCards: false,
                challenges: { c1: { values: { compactCards: false } }, c3: {} },
            }),
        );
        const overlaid = (await changed) as { challenges: Record<string, unknown> };
        expect(overlaid).toMatchObject({
            app: { theme: 'light', language: 'en' },
            defaults: { compactCards: true },
            challenges: { c1: { values: { compactCards: true } } },
        });
        // The overlay adds no phone-only id; c3 rides as the desktop sent it.
        expect(Object.keys(overlaid.challenges)).toEqual(['c1', 'c3']);
        await expect(made.invoke('get-global-default', ['compactCards'])).resolves.toBe(true);
        await expect(made.invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
    });

    test('the overlay leaves the desktop object untouched: unseeded ids pass through, seeded-none ids drop the key', async () => {
        const made = await makeSeeded({
            challenges: { c1: { values: { compactCards: true, voteTiming: 5 } } },
        });
        // Seed c2 as none before the second read; the desktop object itself was never written.
        const c2 = made.invoke('get-challenge-overrides', ['c2']);
        resolveFor(made.pending, 'get-challenge-overrides', { voteTiming: 5 });
        resolveFor(made.pending, 'get-effective-setting', false);
        resolveFor(made.pending, 'get-global-default', false);
        await expect(c2).resolves.toEqual({ voteTiming: 5 });
        expect(made.sent).toHaveLength(4); // the snapshot, then the seed's three reads

        // A second read: unseeded c1 keeps the desktop's record exactly as it arrived, while
        // seeded-none c2's desktop override is left out — never null.
        const again = made.invoke('get-settings', []);
        resolveFor(
            made.pending,
            'get-settings',
            desktopSettings({
                challenges: {
                    c1: { values: { compactCards: true, voteTiming: 5 } },
                    c2: { values: { compactCards: true } },
                },
            }),
        );
        const overlaid = (await again) as { challenges: Record<string, { values: Record<string, unknown> }> };
        expect(overlaid.challenges.c1.values).toEqual({ compactCards: true, voteTiming: 5 });
        expect(overlaid.challenges.c2.values).toEqual({});
    });

    test('a phone own override shows in the overlay even where the desktop payload has no values container', async () => {
        const made = await makeSeeded({ challenges: { c1: {} } });
        await expect(made.invoke('set-challenge-override', ['compactCards', 'c1', true])).resolves.toBe(true);
        const changed = made.invoke('get-settings', []);
        resolveFor(made.pending, 'get-settings', desktopSettings({ challenges: { c1: {} } }));
        const overlaid = (await changed) as { challenges: Record<string, { values?: Record<string, unknown> }> };
        expect(overlaid.challenges.c1.values).toEqual({ compactCards: true });
    });

    test('a payload with junk entries overlays the rest and stores nothing for them', async () => {
        const made = makePrefs();
        const payload: unknown = JSON.parse(
            '{"challenges":{"__proto__":{"values":{"compactCards":true}},"c1":"junk","c2":{"values":{"voteTiming":5}}}}',
        );
        if (!isPlainObject(payload)) throw new Error('fixture must parse to an object');
        made.ingestSettings(payload);
        // A snapshot seeds no ids at all: the unsafe id and the junk record store nothing, and c2 stays unheld.
        await expect(made.invoke('get-challenge-override', ['compactCards', '__proto__'])).resolves.toBeNull();
        await expect(made.invoke('get-challenge-override', ['compactCards', 'c2'])).resolves.toBeNull();
    });

    test('get-settings-schema seeds the two globals from defaults and the phone values replace theirs', async () => {
        const { invoke, sent, pending } = makePrefs();
        const read = invoke('get-settings-schema', []);
        expect(sent).toEqual([{ channel: 'get-settings-schema', args: [] }]);
        resolveFor(pending, 'get-settings-schema', {
            schema: {
                compactCards: { type: 'boolean', default: true },
                compactCardActions: { type: 'boolean', default: false },
                voteTiming: { type: 'number', default: 60 },
            },
            defaults: { compactCards: true, compactCardActions: false, voteTiming: 30 },
            groups: ['display'],
            tiers: [],
            profileLimits: { maxChallengeProfiles: 5, maxProfileNameLength: 40 },
        });
        const schema = (await read) as Record<string, unknown>;
        // The factory defaults in `schema` pass through untouched; the answer overlays `defaults`.
        expect(schema.schema).toMatchObject({ compactCards: { type: 'boolean', default: true } });
        expect(schema.defaults).toMatchObject({ compactCards: true, compactCardActions: false });

        // Seeded from the current defaults, and replaced in the copy once the phone holds its own.
        await expect(invoke('get-global-default', ['compactCards'])).resolves.toBe(true);
        await expect(invoke('get-global-default', ['compactCardActions'])).resolves.toBe(false);
        await expect(invoke('set-global-default', ['compactCards', false])).resolves.toBe(true);
        const changed = invoke('get-settings-schema', []);
        resolveFor(pending, 'get-settings-schema', {
            schema: { compactCards: { type: 'boolean', default: true } },
            defaults: { compactCards: true, compactCardActions: false },
        });
        const schemaLater = (await changed) as Record<string, unknown>;
        expect(schemaLater.defaults).toEqual({ compactCards: false, compactCardActions: false }); // the phone's value first
    });

    test('the phone global replaces the desktop current default even when the factory default differs', async () => {
        // The phone global seeded false through a snapshot.
        const made = await makeSeeded({ compactCards: false });
        const read = made.invoke('get-settings-schema', []);
        resolveFor(made.pending, 'get-settings-schema', {
            schema: { compactCards: { type: 'boolean', default: true } },
            defaults: { compactCards: true, compactCardActions: false },
        });
        const schema = (await read) as Record<string, unknown>;
        expect(schema.defaults).toEqual({ compactCards: false, compactCardActions: false }); // the phone's compactCards, not the desktop's current
        expect(schema.schema).toEqual({ compactCards: { type: 'boolean', default: true } }); // untouched
    });

    test('a schema answer without a defaults object seeds nothing; non-boolean defaults seed only themselves', async () => {
        const made = makePrefs();
        const failed = made.invoke('get-settings-schema', []);
        resolveFor(made.pending, 'get-settings-schema', null);
        await expect(failed).resolves.toBeNull(); // not an object: passes through
        const junk = made.invoke('get-settings-schema', []);
        resolveFor(made.pending, 'get-settings-schema', {
            schema: { compactCards: 'junk' },
            defaults: 'junk',
        });
        await expect(junk).resolves.toEqual({ schema: { compactCards: 'junk' }, defaults: 'junk' });
        // Both keys are unseeded: each read forwards, and the desktop's null passes through unchanged.
        const cards = made.invoke('get-global-default', ['compactCards']);
        const actions = made.invoke('get-global-default', ['compactCardActions']);
        resolveFor(made.pending, 'get-global-default', null);
        resolveFor(made.pending, 'get-global-default', null);
        await expect(cards).resolves.toBeNull();
        await expect(actions).resolves.toBeNull();

        // A non-boolean defaults entry seeds nothing; the boolean one seeds itself.
        const mixed = made.invoke('get-settings-schema', []);
        resolveFor(made.pending, 'get-settings-schema', {
            schema: { compactCards: { type: 'boolean', default: true } },
            defaults: { compactCards: 'junk', compactCardActions: true },
        });
        await expect(mixed).resolves.toEqual({
            schema: { compactCards: { type: 'boolean', default: true } },
            defaults: { compactCards: 'junk', compactCardActions: true }, // unseeded compactCards passes
        });
        const cardsAgain = made.invoke('get-global-default', ['compactCards']);
        resolveFor(made.pending, 'get-global-default', null);
        await expect(cardsAgain).resolves.toBeNull(); // still unseeded
        await expect(made.invoke('get-global-default', ['compactCardActions'])).resolves.toBe(true); // seeded, no forward

        // Seed compactCards, through a snapshot that lacks the other default.
        made.ingestSettings({ defaults: { compactCards: false } });
        const overlaid = made.invoke('get-settings-schema', []);
        resolveFor(made.pending, 'get-settings-schema', {
            schema: { compactCards: { type: 'boolean', default: true } },
            defaults: { compactCards: true, compactCardActions: false },
            groups: ['display'],
        });
        const schema = (await overlaid) as Record<string, unknown>;
        expect(schema.defaults).toEqual({ compactCards: false, compactCardActions: true }); // seeded false replaces; the phone's true stays
        expect(schema.groups).toEqual(['display']); // the rest of the answer passes untouched
    });

    test('get-challenge-overrides runs the seed and replaces compactCards with the phone own value', async () => {
        const { invoke, sentFor, pending } = makePrefs();
        const read = invoke('get-challenge-overrides', [' c1 ']);
        // The raw first argument rides unchanged; the seed forwards the three reads exactly once.
        expect(sentFor('get-challenge-overrides')).toBe(1);
        expect(sentFor('get-effective-setting')).toBe(1);
        expect(sentFor('get-global-default')).toBe(1);
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 5, compactCards: false });
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        expect(await read).toEqual({ voteTiming: 5, compactCards: false });
        // Seeded from the desktop's own value, then echoed back as the phone's own.
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(false);

        await expect(invoke('set-challenge-override', ['compactCards', 'c1', true])).resolves.toBe(true);
        const changed = invoke('get-challenge-overrides', ['c1']);
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 5 });
        expect(await changed).toEqual({ voteTiming: 5, compactCards: true });
    });

    test('get-challenge-overrides leaves compactCards out when seeded none, and a failed read stores nothing', async () => {
        const { invoke, sentFor, pending } = makePrefs();
        // A no-own, no-rule answer seeds the id as none: the phone's copy has no compactCards key.
        const none = invoke('get-challenge-overrides', ['c2']);
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 5 });
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        expect(await none).toEqual({ voteTiming: 5 }); // no compactCards key at all — never null

        const failed = invoke('get-challenge-overrides', ['c3']);
        resolveFor(pending, 'get-challenge-overrides', null); // a failed read: not an object
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        expect(await failed).toBeNull(); // passes through unchanged, nothing stored
        await expect(invoke('get-challenge-override', ['compactCards', 'c3'])).resolves.toBeNull();
        // The next read seeds again — the failed seed stored nothing.
        const retry = invoke('get-challenge-overrides', ['c3']);
        expect(sentFor('get-challenge-overrides')).toBe(3); // c2's seed, the failed seed, the retry
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 1 });
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        expect(await retry).toEqual({ voteTiming: 1 });

        // A held id with a failed (non-object) answer passes it through unchanged too.
        const heldFailed = invoke('get-challenge-overrides', ['c2']);
        resolveFor(pending, 'get-challenge-overrides', null);
        await expect(heldFailed).resolves.toBeNull();
    });

    test('an unsafe id on a forwarded overrides read seeds nothing and still lists the desktop map', async () => {
        const { invoke, pending } = makePrefs();
        const unsafe = invoke('get-challenge-overrides', ['__proto__']);
        resolveFor(pending, 'get-challenge-overrides', { compactCards: true, voteTiming: 5 });
        // The desktop's own map passes; the phone keeps no slot for it and shows no phone value.
        expect(await unsafe).toEqual({ voteTiming: 5 });
    });

    test('the connect snapshot event seeds the same way a get-settings answer does', async () => {
        const { invoke, ingestSettings, seen } = makePrefs();
        const seeded = ingestSettings(desktopSettings({ theme: 'nord', challenges: { c9: {} } }));
        expect(seeded).toMatchObject({ app: { theme: 'nord' } });
        await expect(invoke('get-setting', ['theme'])).resolves.toBe('nord');
        await expect(invoke('get-challenge-override', ['compactCards', 'c9'])).resolves.toBeNull();
        expect(seen).toEqual([]); // a desktop ingest dispatches no local event
    });

    test('a payload that is not an object passes through untouched', () => {
        const { ingestSettings } = makePrefs();
        expect(ingestSettings('junk')).toBe('junk');
    });

    test('the overlay handles every partial seed of the four keys', () => {
        // Language seeded, theme not: the phone has no theme, so the desktop's passes through.
        const languageOnly = makePrefs();
        languageOnly.ingestSettings({ app: { language: 'lv' } });
        expect(languageOnly.ingestSettings({ app: { theme: 'dark', timezone: 'UTC' } })).toMatchObject({
            app: { theme: 'dark', language: 'lv' },
        });

        // Theme seeded, language not: the desktop's language passes through.
        const themeOnly = makePrefs();
        themeOnly.ingestSettings({ app: { theme: 'dark' } });
        expect(themeOnly.ingestSettings({ app: { theme: 'night', language: 'en' } })).toMatchObject({
            app: { theme: 'dark', language: 'en' },
        });

        // An app or defaults container that is not an object is left alone.
        const junkContainers = makePrefs();
        junkContainers.ingestSettings({ app: { theme: 'dark' }, defaults: { compactCards: false } });
        expect(junkContainers.ingestSettings({ app: 'junk', defaults: 'junk' })).toMatchObject({
            app: 'junk',
            defaults: 'junk',
        });

        // compactCardActions seeded without compactCards: the defaults overlay runs on one key.
        const actionsOnly = makePrefs();
        actionsOnly.ingestSettings({ defaults: { compactCardActions: true } });
        expect(
            actionsOnly.ingestSettings({ defaults: { compactCards: false, compactCardActions: false } }),
        ).toMatchObject({ defaults: { compactCards: false, compactCardActions: true } });
    });

    test('a phone write made during a seed wins over the seed', async () => {
        const made = makePrefs();
        const read = made.invoke('get-settings', []); // the seeding read is in flight
        await expect(made.invoke('set-setting', ['theme', 'sunset'])).resolves.toBe(true);
        resolveFor(made.pending, 'get-settings', desktopSettings({ theme: 'light' }));
        await read;
        await expect(made.invoke('get-setting', ['theme'])).resolves.toBe('sunset'); // the write, not the seed
    });

    test('a seed past the per-map cap stores nothing and the forwarded answer passes through', async () => {
        const made = makePrefs(fullOverrideStorage(500));
        const read = made.invoke('get-challenge-overrides', ['zz']);
        resolveFor(made.pending, 'get-challenge-overrides', { compactCards: true });
        resolveFor(made.pending, 'get-effective-setting', true);
        resolveFor(made.pending, 'get-global-default', false);
        await expect(read).resolves.toEqual({ compactCards: true }); // unchanged: no slot is free, nothing stored
        expect(Object.keys(storedOverrides())).toHaveLength(500);
    });
});

// ---------------------------------------------------------------- the inherited compact value

describe('the inherited compact value', () => {
    test('a rule value differing from the desktop global is inherited, without showing as customized', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;
        // The overrides read runs first and the seed forwards all three reads exactly once.
        const overridesRead = invoke('get-challenge-overrides', ['c1']);
        expect(sentFor('get-challenge-overrides')).toBe(1);
        expect(sentFor('get-effective-setting')).toBe(1);
        expect(sentFor('get-global-default')).toBe(1);
        resolveFor(pending, 'get-challenge-overrides', {}); // no own override
        resolveFor(pending, 'get-effective-setting', true); // a rule set true: differs from the desktop global
        resolveFor(pending, 'get-global-default', false); // the DESKTOP baseline
        expect(await overridesRead).toEqual({}); // own null: no compactCards key

        // The store answer now comes without a desktop call, straight from the inherited slot.
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(true);
        expect(sentFor('get-effective-setting')).toBe(1);

        // A later overrides read still shows no compactCards — inherited is not an own override.
        const later = invoke('get-challenge-overrides', ['c1']);
        resolveFor(pending, 'get-challenge-overrides', { compactCards: false });
        await expect(later).resolves.toEqual({}); // the desktop's own key deleted

        // A snapshot overlay for a seeded-none id without a desktop compactCards key changes nothing.
        const snap = made.ingestSettings({
            challenges: { c1: { values: { voteTiming: 9 } } },
        }) as { challenges: Record<string, { values: Record<string, unknown> }> };
        expect(snap.challenges.c1.values).toEqual({ voteTiming: 9 });

        // The card toggle writes a real own override.
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', false])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(false);
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(false);
        expect(sentFor('get-effective-setting')).toBe(1); // nothing further was sent for this id
    });

    test('a no-rule challenge stays on the phone global even when it differs from the desktop global', async () => {
        const made = await makeSeeded({ compactCards: true }); // the phone global is true
        const { invoke, sentFor, pending } = made;
        const overridesRead = invoke('get-challenge-overrides', ['c1']); // the seed's triple
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', false); // the desktop global is false; no rule: effective false too
        resolveFor(pending, 'get-global-default', false);
        await expect(overridesRead).resolves.toEqual({});
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull(); // no badge
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(true); // the phone global applies
        expect(sentFor('get-effective-setting')).toBe(1); // the seed's read only
        // Also after the phone global changes: the challenge follows it, still with no desktop call.
        await expect(invoke('set-global-default', ['compactCards', false])).resolves.toBe(true);
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(false);
        expect(sentFor('get-effective-setting')).toBe(1);
    });

    test('a value equal to the desktop global stores only the none-seed, and later reads send nothing', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', false); // equals the desktop global
        await expect(effective).resolves.toBe(false);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(false);
        expect(sentFor('get-effective-setting')).toBe(1); // answered from the store
    });

    test('effective read first with a desktop own override: the seed stores it as the phone OWN override', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', { compactCards: true }); // the desktop's own override
        resolveFor(pending, 'get-effective-setting', true); // differs from the desktop global — irrelevant: own wins
        resolveFor(pending, 'get-global-default', false);
        await expect(effective).resolves.toBe(true); // the phone's own override answers first
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true); // OWN, not inherited
        // Not inherited: without the own override the challenge is back on the phone global.
        await expect(invoke('remove-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(false);
    });

    test('a real own override still shows as customized and answers first', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;
        const read = invoke('get-challenge-overrides', ['c1']);
        resolveFor(pending, 'get-challenge-overrides', { compactCards: true }); // the desktop's own override
        resolveFor(pending, 'get-effective-setting', true); // the seed's triple rides with the first read
        resolveFor(pending, 'get-global-default', false);
        expect(await read).toEqual({ compactCards: true });
        await expect(invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(true);
        expect(sentFor('get-effective-setting')).toBe(1); // only the seed's read; the own override answers
    });

    test('the seed is single-flight: concurrent reads on both channels share one triple', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;
        const first = invoke('get-effective-setting', ['compactCards', 'c1']);
        const second = invoke('get-challenge-overrides', ['c1']); // the other channel joins the same seed
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', true);
        await flush();
        expect(sentFor('get-effective-setting')).toBe(1);
        expect(sentFor('get-global-default')).toBe(1);
        expect(sentFor('get-challenge-overrides')).toBe(1);
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toEqual({}); // own null: no compactCards key
    });

    test('a failed or null desktop-global answer classifies nothing and passes the effective answer through', async () => {
        const made = await makeSeeded({ compactCards: true }); // the phone global is true — irrelevant to classification
        const { invoke, sentFor, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', null); // the desktop's failure fallback
        resolveFor(pending, 'get-effective-setting', false);
        await expect(effective).resolves.toBe(false); // the FORWARDED effective answer passes through
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
        // The next read runs the whole triple again and classifies against the desktop baseline.
        const retry = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', false); // equals the desktop global: no rule
        await expect(retry).resolves.toBe(true); // the phone global applies now
        expect(sentFor('get-effective-setting')).toBe(2);
    });

    test('a failed read in each of the three forwarded reads stores nothing, and the next read seeds again', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;

        // 1. The overrides read rejects: nothing is stored, and the effective answer passes through.
        const first = invoke('get-effective-setting', ['compactCards', 'c1']);
        rejectFor(pending, 'get-challenge-overrides', new Error('no answer'));
        resolveFor(pending, 'get-effective-setting', true);
        resolveFor(pending, 'get-global-default', false);
        await expect(first).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();

        // 2. The effective read rejects: the rejection reaches the caller.
        const second = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        rejectFor(pending, 'get-effective-setting', new Error('no answer'));
        resolveFor(pending, 'get-global-default', false);
        await expect(second).rejects.toThrow('no answer');

        // 3. The global read rejects: nothing to classify against, nothing stored.
        const third = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', true);
        rejectFor(pending, 'get-global-default', new Error('no answer'));
        await expect(third).resolves.toBe(true);
        expect(sentFor('get-effective-setting')).toBe(3); // every read ran its own seed again

        // Now a clean seed classifies, and the store answers without a desktop call.
        const fourth = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', true);
        resolveFor(pending, 'get-global-default', false);
        await expect(fourth).resolves.toBe(true);
        expect(sentFor('get-effective-setting')).toBe(4);
    });

    test('a rejected overrides read in the seed rejects the get-challenge-overrides caller', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, pending } = made;
        const read = invoke('get-challenge-overrides', ['c1']);
        rejectFor(pending, 'get-challenge-overrides', new Error('no answer'));
        resolveFor(pending, 'get-effective-setting', true);
        resolveFor(pending, 'get-global-default', false);
        await expect(read).rejects.toThrow('no answer'); // the forwarded rejection reaches the caller
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull(); // nothing stored
        // The next read seeds again, and its clean answer classifies.
        const retry = invoke('get-challenge-overrides', ['c1']);
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 5 });
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        await expect(retry).resolves.toEqual({ voteTiming: 5 }); // own null stored: no compactCards key
    });

    test('a failed or non-boolean read in the triple passes through and stores nothing; the next read tries again', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sentFor, pending } = made;
        const failed = invoke('get-effective-setting', ['compactCards', 'c1']);
        rejectFor(pending, 'get-effective-setting', new Error('no answer'));
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        await expect(failed).rejects.toThrow('no answer'); // the forwarded rejection propagates
        const junk = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', null); // the desktop's failure fallback
        await expect(junk).resolves.toBeNull();
        expect(sentFor('get-effective-setting')).toBe(2); // one triple per try
        const third = invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', true);
        await expect(third).resolves.toBe(true);
        expect(sentFor('get-effective-setting')).toBe(3);
    });

    test('an id that cannot key the store forwards to the desktop as-is', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sent, pending } = made;
        const foreign = invoke('get-effective-setting', ['compactCards', '__proto__']);
        expect(sent[sent.length - 1]).toEqual({
            channel: 'get-effective-setting',
            args: ['compactCards', '__proto__'],
        });
        resolveFor(pending, 'get-effective-setting', 'desktop');
        await expect(foreign).resolves.toBe('desktop');
    });

    test('a phone write during a seed wins, and the seed stores nothing over it', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'c1']); // the seed is in flight
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', false])).resolves.toBe(true);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', true); // the desktop would answer true
        resolveFor(pending, 'get-global-default', false);
        await expect(effective).resolves.toBe(false); // the phone's own write wins
        // The write's value answers the overrides channel too.
        const overridesRead = invoke('get-challenge-overrides', ['c1']);
        resolveFor(pending, 'get-challenge-overrides', { voteTiming: 5 });
        await expect(overridesRead).resolves.toEqual({ voteTiming: 5, compactCards: false });
    });

    test('a seed refused by the per-map cap stores nothing and passes the forwarded answer through', async () => {
        const made = makePrefs(
            ((): Storage => {
                const entries: Record<string, boolean | null> = {};
                for (let i = 0; i < 500; i++) entries[`c${i}`] = null;
                return memoryStorageWith({ compactCards: false, compactOverrides: entries });
            })(),
        );
        const { invoke, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'zz']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', true); // differs from the desktop baseline, but no slot is free
        resolveFor(pending, 'get-global-default', false);
        await expect(effective).resolves.toBe(true); // the FORWARDED effective answer passes through
        expect(Object.keys(storedOverrides())).toHaveLength(500);
    });

    test('a rule-value seed past the compactInherited cap stores nothing and passes the forwarded answer', async () => {
        const inherited: Record<string, boolean> = {};
        for (let i = 0; i < 500; i++) inherited[`i${i}`] = true;
        const made = makePrefs(
            memoryStorageWith({ compactCards: false, compactOverrides: {}, compactInherited: inherited }),
        );
        const { invoke, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'zz']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', true); // differs from the desktop baseline, but no inherited slot is free
        resolveFor(pending, 'get-global-default', false);
        await expect(effective).resolves.toBe(true); // the FORWARDED rule value passes through
        expect(Object.keys(storedOverrides())).toHaveLength(0); // no none-seed that would lose the rule value
        expect(Object.keys(storedInherited())).toHaveLength(500);
    });

    test('a no-rule seed with the compactInherited map full still stores the none-seed', async () => {
        const inherited: Record<string, boolean> = {};
        for (let i = 0; i < 500; i++) inherited[`i${i}`] = true;
        const made = makePrefs(memoryStorageWith({ compactCards: true, compactInherited: inherited }));
        const { invoke, pending } = made;
        const effective = invoke('get-effective-setting', ['compactCards', 'zz']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-effective-setting', false); // equals the desktop baseline: nothing to inherit
        resolveFor(pending, 'get-global-default', false);
        await expect(effective).resolves.toBe(true); // the phone global applies
        await expect(invoke('get-challenge-override', ['compactCards', 'zz'])).resolves.toBeNull();
        expect(Object.keys(storedOverrides())).toHaveLength(1);
    });

    test('a seed never overwrites an id the phone holds only as inherited', async () => {
        const made = makePrefs(
            memoryStorageWith({ compactCards: false, compactOverrides: {}, compactInherited: { c9: true } }),
        );
        const { invoke, pending } = made;
        const read = invoke('get-challenge-overrides', ['c9']);
        resolveFor(pending, 'get-challenge-overrides', { compactCards: false });
        resolveFor(pending, 'get-effective-setting', false);
        resolveFor(pending, 'get-global-default', false);
        await expect(read).resolves.toEqual({ compactCards: false }); // the seed stored nothing: forwarded as is
        expect(storedInherited()).toEqual({ c9: true });
        expect(Object.keys(storedOverrides())).toHaveLength(0);
        await expect(invoke('get-effective-setting', ['compactCards', 'c9'])).resolves.toBe(true);
    });
});

// ---------------------------------------------------------------- replace-challenge-overrides

describe('replace-challenge-overrides keeps the desktop own value and stores only after acceptance', () => {
    test('the desktop keeps its own compactCards value; the phone stores the form value after acceptance', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sent, pending } = made;
        const replace = invoke('replace-challenge-overrides', ['c1', { compactCards: true, voteTiming: 5 }, true]);
        expect(sent[sent.length - 1]).toEqual({ channel: 'get-challenge-overrides', args: ['c1'] }); // the pre-read
        resolveFor(pending, 'get-challenge-overrides', { compactCards: false, chosenPhotos: [] });
        await flush();
        const sentReplace = sent[sent.length - 1];
        expect(sentReplace.channel).toBe('replace-challenge-overrides');
        // The desktop's own compactCards entry rides along; the form's other keys pass.
        expect(sentReplace.args[1]).toEqual({ compactCards: false, voteTiming: 5 });
        resolveFor(pending, 'replace-challenge-overrides', true);
        await expect(replace).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
    });

    test('the desktop with no own override still has none after the replace', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sent, pending } = made;
        const replace = invoke('replace-challenge-overrides', ['c1', { compactCards: true }, false]);
        resolveFor(pending, 'get-challenge-overrides', {});
        await flush();
        expect(sent[sent.length - 1].args[1]).toEqual({}); // the form's compactCards entry is not sent
        resolveFor(pending, 'replace-challenge-overrides', true);
        await expect(replace).resolves.toBe(true);
        // The phone stores the form's value: its own slot now holds it.
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
    });

    test('a failed desktop read answers false and sends nothing', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sent, pending } = made;
        const replace = invoke('replace-challenge-overrides', ['c1', { compactCards: true }, false]);
        resolveFor(pending, 'get-challenge-overrides', null);
        await expect(replace).resolves.toBe(false);
        expect(sent[sent.length - 1].channel).toBe('get-challenge-overrides'); // nothing else went out
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
    });

    test('a refused replace leaves the phone value unchanged, and a rejected one passes through', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, pending } = made;
        const refused = invoke('replace-challenge-overrides', ['c1', { compactCards: true }, false]);
        resolveFor(pending, 'get-challenge-overrides', {});
        await flush();
        resolveFor(pending, 'replace-challenge-overrides', false);
        await expect(refused).resolves.toBe(false);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();

        const rejected = invoke('replace-challenge-overrides', ['c1', { compactCards: true }, false]);
        resolveFor(pending, 'get-challenge-overrides', {});
        await flush();
        rejectFor(pending, 'replace-challenge-overrides', new Error('save failed'));
        await expect(rejected).rejects.toThrow('save failed');
    });

    test('an id the phone cannot key, or a form that is not an object, goes straight to the desktop', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, sent, pending } = made;
        const unsafe = invoke('replace-challenge-overrides', ['__proto__', { compactCards: true }, false]);
        const junkForm = invoke('replace-challenge-overrides', ['c1', 'junk', false]);
        expect(sent.filter(({ channel }) => channel === 'replace-challenge-overrides')).toHaveLength(2);
        resolveFor(pending, 'replace-challenge-overrides', 'desktop-refusal');
        resolveFor(pending, 'replace-challenge-overrides', 'desktop-refusal');
        await expect(unsafe).resolves.toBe('desktop-refusal');
        await expect(junkForm).resolves.toBe('desktop-refusal');
    });

    test('a form without a compactCards entry stores none after acceptance', async () => {
        const made = await makeSeeded({ compactCards: false });
        const { invoke, pending } = made;
        const replace = invoke('replace-challenge-overrides', ['c1', { voteTiming: 5 }, false]);
        resolveFor(pending, 'get-challenge-overrides', {});
        await flush();
        resolveFor(pending, 'replace-challenge-overrides', true);
        await expect(replace).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull(); // none stored
    });

    test('a replace accepted past the per-map cap answers true and stores nothing', async () => {
        const made = makePrefs(fullOverrideStorage(500));
        const { invoke, sent, pending } = made;
        const replace = invoke('replace-challenge-overrides', ['new-id', { compactCards: true }, false]);
        resolveFor(pending, 'get-challenge-overrides', {});
        await flush();
        resolveFor(pending, 'replace-challenge-overrides', true);
        await expect(replace).resolves.toBe(true); // the desktop accepted: that is the answer
        expect(sent).toHaveLength(2);
        expect(Object.keys(storedOverrides())).toHaveLength(500); // nothing was stored
    });
});

// ---------------------------------------------------------------- storage

describe('storage', () => {
    test('a stored store is read once and writes persist back', async () => {
        const storage = memoryStorageWith({
            theme: 'dark',
            language: 'lv',
            compactCards: true,
            compactCardActions: true,
        });
        const { invoke } = makePrefs(storage);
        await expect(invoke('get-setting', ['theme'])).resolves.toBe('dark');
        await expect(invoke('get-setting', ['language'])).resolves.toBe('lv');
        await expect(invoke('get-global-default', ['compactCards'])).resolves.toBe(true);
        await expect(invoke('get-global-default', ['compactCardActions'])).resolves.toBe(true);
        await expect(invoke('set-setting', ['theme', 'forest'])).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({
            theme: 'forest',
            language: 'lv',
            compactCards: true,
            compactCardActions: true,
        });
    });

    test('invalid JSON drops everything', async () => {
        const storage = memoryStorage();
        storage.setItem(VIEW_PREFS_STORAGE, '{not json');
        const { invoke, pending } = makePrefs(storage);
        // Every key is unseeded, so the reads forward and the desktop's null answers pass through.
        const theme = invoke('get-setting', ['theme']);
        const cards = invoke('get-global-default', ['compactCards']);
        resolveFor(pending, 'get-setting', null);
        resolveFor(pending, 'get-global-default', null);
        await expect(theme).resolves.toBeNull();
        await expect(cards).resolves.toBeNull();
    });

    test('a stored value that is not an object drops everything', async () => {
        const { invoke, pending } = makePrefs(memoryStorageWith([1, 2]));
        const theme = invoke('get-setting', ['theme']);
        resolveFor(pending, 'get-setting', null);
        await expect(theme).resolves.toBeNull();
    });

    test('each invalid stored field is dropped one by one', async () => {
        const { invoke, sent, pending } = makePrefs(
            memoryStorageWith({
                theme: 'not-a-theme',
                language: 'xx',
                compactCards: 'yes',
                compactCardActions: 1,
                compactOverrides: { c1: 'yes', c2: 0, ' c3 ': true, c4: null },
                compactInherited: { c5: 'yes', c6: true },
            }),
        );
        // Every global is invalid, so each read forwards and the desktop's null passes through.
        const theme = invoke('get-setting', ['theme']);
        const language = invoke('get-setting', ['language']);
        const cards = invoke('get-global-default', ['compactCards']);
        const actions = invoke('get-global-default', ['compactCardActions']);
        resolveFor(pending, 'get-setting', null);
        resolveFor(pending, 'get-setting', null);
        resolveFor(pending, 'get-global-default', null);
        resolveFor(pending, 'get-global-default', null);
        await expect(theme).resolves.toBeNull();
        await expect(language).resolves.toBeNull();
        await expect(cards).resolves.toBeNull();
        await expect(actions).resolves.toBeNull();
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
        await expect(invoke('get-challenge-override', ['compactCards', 'c2'])).resolves.toBeNull();
        await expect(invoke('get-challenge-override', ['compactCards', 'c3'])).resolves.toBe(true); // trimmed key
        await expect(invoke('get-challenge-override', ['compactCards', 'c4'])).resolves.toBeNull();
        await expect(invoke('get-effective-setting', ['compactCards', 'c6'])).resolves.toBe(true); // inherited kept
        expect(sent.filter(({ channel }) => channel === 'get-effective-setting')).toHaveLength(0);

        // The invalid inherited entry was dropped: c5 is unseeded, so the seed's three reads forward.
        // The effective answer is the desktop's failure fallback, so nothing is stored and it passes through.
        const c5 = invoke('get-effective-setting', ['compactCards', 'c5']);
        resolveFor(pending, 'get-challenge-overrides', {});
        resolveFor(pending, 'get-global-default', false);
        resolveFor(pending, 'get-effective-setting', null);
        await expect(c5).resolves.toBeNull(); // passes through: nothing to resolve it from
    });

    test('unsafe ids in a stored map are dropped', async () => {
        const storage = memoryStorage();
        storage.setItem(
            VIEW_PREFS_STORAGE,
            '{"compactOverrides":{"__proto__":true,"constructor":null,"c7":true},"compactInherited":{"prototype":false,"c8":true}}',
        );
        const { invoke } = makePrefs(storage);
        await expect(invoke('get-challenge-override', ['compactCards', 'c7'])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', '__proto__'])).resolves.toBeNull();
        await expect(invoke('get-challenge-override', ['compactCards', 'constructor'])).resolves.toBeNull();
        await expect(invoke('get-effective-setting', ['compactCards', 'c8'])).resolves.toBe(true);
    });

    test('storage that throws falls back to memory', async () => {
        const { invoke, seen } = makePrefs(refusingStorage());
        await expect(invoke('set-setting', ['theme', 'dark'])).resolves.toBe(true);
        await expect(invoke('get-setting', ['theme'])).resolves.toBe('dark'); // memory kept it
        expect(seen.length).toBe(1);
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', true])).resolves.toBe(true);
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBe(true);
    });

    test('a write with no settings listener is a plain write', async () => {
        setStorage(memoryStorage());
        const ctx: PeerBridgeContext = createPeerBridgeContext(new TransportStub('phone'));
        const { send } = makeSend();
        const prefs = createViewPrefs({ ctx, sendInvoke: send }); // no settings-changed subscriber
        await expect(prefs.route('set-setting', ['theme', 'dark'])).resolves.toBe(true);
        expect(storedRaw()).toContain('dark');
    });

    test('a new id past the per-map cap is refused; an existing id always works', async () => {
        const { invoke } = makePrefs(fullOverrideStorage(500));
        await expect(invoke('set-challenge-override', ['compactCards', 'new', true])).resolves.toBe(false);
        await expect(invoke('remove-challenge-override', ['compactCards', 'new'])).resolves.toBe(false);
        await expect(invoke('set-challenge-override', ['compactCards', 'c1', false])).resolves.toBe(true); // existing
        expect(Object.keys(storedOverrides())).toHaveLength(500);
    });

    test('a stored map with more than 500 entries is cut to 500', async () => {
        const { invoke } = makePrefs(fullOverrideStorage(501));
        await expect(invoke('get-challenge-override', ['compactCards', 'c500'])).resolves.toBeNull(); // dropped
        await expect(invoke('get-challenge-override', ['compactCards', 'c499'])).resolves.toBe(true); // kept
    });

    test('a store without the maps reads as empty ones', async () => {
        const { invoke } = makePrefs(memoryStorageWith({ theme: 'dark' }));
        await expect(invoke('get-challenge-override', ['compactCards', 'c1'])).resolves.toBeNull();
    });

    test('an own override seeded none answers the phone global — one forwarded read seeds it when unset', async () => {
        const withGlobal = makePrefs(memoryStorageWith({ compactCards: true, compactOverrides: { c1: null } }));
        await expect(withGlobal.invoke('get-effective-setting', ['compactCards', 'c1'])).resolves.toBe(true);
        const withoutGlobal = makePrefs(memoryStorageWith({ compactOverrides: { c1: null } }));
        const seeded = withoutGlobal.invoke('get-effective-setting', ['compactCards', 'c1']);
        resolveFor(withoutGlobal.pending, 'get-global-default', false);
        await expect(seeded).resolves.toBe(false); // the forwarded read seeded the phone global
        expect(storedRaw()).toContain('compactCards');
    });
});

// ---------------------------------------------------------------- the local event

describe('the local event a phone write dispatches', () => {
    test('before any desktop object is known it carries only the keys the phone holds', async () => {
        const { invoke, seen } = makePrefs();
        // A write with neither key held dispatches the empty app: the renderer keeps its values.
        await expect(invoke('set-challenge-override', ['compactCards', 'c9', true])).resolves.toBe(true);
        expect(seen[0]).toEqual({ app: {} });
        await expect(invoke('set-setting', ['theme', 'dark'])).resolves.toBe(true);
        expect(seen[1]).toEqual({ app: { theme: 'dark' } }); // no language key — a null would switch it to English
        await expect(invoke('set-setting', ['language', 'lv'])).resolves.toBe(true);
        expect(seen[2]).toEqual({ app: { theme: 'dark', language: 'lv' } });
    });

    test('with a desktop object known it is that object with the phone values overlaid', async () => {
        const made = await makeSeeded({ challenges: { c1: { values: { compactCards: true } } } });
        const { invoke, seen } = made;
        await expect(invoke('set-global-default', ['compactCards', true])).resolves.toBe(true);
        expect(seen).toEqual([
            desktopSettings({ compactCards: true, challenges: { c1: { values: { compactCards: true } } } }),
        ]);
    });

    test('a refused write dispatches nothing', async () => {
        const { invoke, seen } = makePrefs();
        await expect(invoke('set-setting', ['theme', 'junk'])).resolves.toBe(false);
        expect(seen).toEqual([]);
    });
});

// ---------------------------------------------------------------- pruning

describe('pruning the inactive challenges from both per-challenge maps', () => {
    test('cleanup channels forward and prune the ids no longer active', async () => {
        const { invoke, sent, pending } = makePrefs(
            memoryStorageWith({
                compactOverrides: { c1: true, c2: null, c3: false },
                compactInherited: { c1: true, c2: true },
            }),
        );
        const cleanup = invoke('cleanup-stale-challenge-setting', [['c1', 'c3']]);
        expect(sent).toEqual([{ channel: 'cleanup-stale-challenge-setting', args: [['c1', 'c3']] }]);
        resolveFor(pending, 'cleanup-stale-challenge-setting', true);
        await expect(cleanup).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({
            compactOverrides: { c1: true, c3: false },
            compactInherited: { c1: true }, // c2 pruned from the inherited map too
        });

        const metadata = invoke('cleanup-stale-metadata', [['c1']]);
        resolveFor(pending, 'cleanup-stale-metadata', true);
        await expect(metadata).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({
            compactOverrides: { c1: true },
            compactInherited: { c1: true },
        });
    });

    test('an empty or invalid list prunes nothing but still forwards', async () => {
        const { invoke, sent, pending } = makePrefs(
            memoryStorageWith({ compactOverrides: { c1: true }, compactInherited: { c1: true } }),
        );
        const empty = invoke('cleanup-stale-challenge-setting', [[]]);
        resolveFor(pending, 'cleanup-stale-challenge-setting', true);
        await expect(empty).resolves.toBe(true);
        const junk = invoke('cleanup-stale-metadata', ['junk']);
        resolveFor(pending, 'cleanup-stale-metadata', true);
        await expect(junk).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({
            compactOverrides: { c1: true },
            compactInherited: { c1: true },
        });
        expect(sent.map(({ channel }) => channel)).toEqual([
            'cleanup-stale-challenge-setting',
            'cleanup-stale-metadata',
        ]);
    });

    test('an ended rule-set challenge leaves both maps together', async () => {
        const { invoke, pending } = makePrefs(
            memoryStorageWith({
                compactOverrides: { ended: null, active: null },
                compactInherited: { ended: true, active: true },
            }),
        );
        const cleanup = invoke('cleanup-stale-metadata', [['active']]);
        resolveFor(pending, 'cleanup-stale-metadata', true);
        await expect(cleanup).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({
            compactOverrides: { active: null },
            compactInherited: { active: true },
        });
    });

    test('unsafe or blank ids in the active list keep nothing extra, and a keep-all list persists nothing', async () => {
        const { invoke, pending } = makePrefs(memoryStorageWith({ compactOverrides: { c1: true } }));
        const cleanup = invoke('cleanup-stale-challenge-setting', [['c1', '__proto__', '  ']]);
        resolveFor(pending, 'cleanup-stale-challenge-setting', true);
        await expect(cleanup).resolves.toBe(true);
        expect(JSON.parse(storedRaw() ?? '{}')).toMatchObject({ compactOverrides: { c1: true } }); // nothing removed
    });
});

// ---------------------------------------------------------------- through the installed bridge

const LOADER_TARGET = 'https://site.test/remote/index.html#k=the-key';
const hostHello = { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION, host: true };

describe('through the installed peer bridge', () => {
    let host: TransportStub;
    let phone: TransportStub;
    let api: Record<string, (...args: unknown[]) => unknown>;
    // The bridge arms the page lifecycle listeners; the node test environment has no window,
    // so a stub takes them (the tests never fire them).
    let pageListeners: Map<string, Array<(event: { persisted: boolean }) => void>>;

    beforeEach(() => {
        jest.useFakeTimers();
        setStorage(memoryStorage());
        setRemoteConnectionState('connecting');
        pageListeners = new Map();
        Object.defineProperty(globalThis, 'addEventListener', {
            configurable: true,
            writable: true,
            value: (type: string, handler: (event: { persisted: boolean }) => void) => {
                pageListeners.set(type, [...(pageListeners.get(type) ?? []), handler]);
            },
        });
        [host, phone] = TransportStub.pair('host', 'phone');
        installPeerBridge(phone, LOADER_TARGET);
        api = (globalThis as { api?: Record<string, (...args: unknown[]) => unknown> }).api ?? {};
    });

    afterEach(() => {
        jest.useRealTimers();
        setRemoteConnectionState('connecting');
        setRemoteHostPeerId(null);
        delete (globalThis as { addEventListener?: unknown }).addEventListener;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const connect = (): void => {
        phone.emitJoin('host');
        host.receiveFromPeer({ t: 'hello', version: PAGE_VERSION, host: false }, 'phone');
        phone.receiveFromPeer(hostHello, 'host');
    };

    const answerLast = (channel: string, result: unknown): void => {
        const matches = phone.sent.filter(({ message }) => (message as { channel?: string }).channel === channel);
        const last = matches[matches.length - 1];
        phone.receiveFromPeer(
            { t: 'result', id: (last?.message as { id: number } | undefined)?.id, ok: true, result },
            'host',
        );
    };

    test('the desktop settings-changed snapshot seeds the phone, and another one never changes its four keys', async () => {
        connect();
        const seen: unknown[] = [];
        const unsubscribe = api.onSettingsChanged((payload: unknown) => seen.push(payload)) as () => void;
        // The connect snapshot.
        phone.receiveFromPeer(
            { t: 'event', channel: 'settings-changed', payload: desktopSettings({ theme: 'light' }) },
            'host',
        );
        expect(seen).toEqual([desktopSettings({ theme: 'light' })]);
        await expect(api.getSetting('theme')).resolves.toBe('light');
        expect(
            phone.sent.filter(({ message }) => (message as { channel?: string }).channel === 'get-setting'),
        ).toHaveLength(0);

        // A desktop change to the theme does not reach the phone: the payload arrives overlaid.
        phone.receiveFromPeer(
            { t: 'event', channel: 'settings-changed', payload: desktopSettings({ theme: 'dark' }) },
            'host',
        );
        expect(seen[1]).toMatchObject({ app: { theme: 'light' } });
        await expect(api.getSetting('theme')).resolves.toBe('light');
        unsubscribe();
    });

    test('a phone write dispatches the local event to the bridge own listeners and sends nothing', async () => {
        connect();
        const snapshot = api.getSettings() as Promise<unknown>;
        answerLast('get-settings', desktopSettings({ theme: 'light', challenges: { c1: {} } }));
        await expect(snapshot).resolves.toMatchObject({ app: { theme: 'light' } });
        phone.sent.length = 0;
        const seen: unknown[] = [];
        const unsubscribe = api.onSettingsChanged((payload: unknown) => seen.push(payload)) as () => void;
        await expect(api.setSetting('theme', 'forest')).resolves.toBe(true);
        expect(seen).toEqual([desktopSettings({ theme: 'forest', challenges: { c1: {} } })]);
        expect(phone.sent).toHaveLength(0);
        unsubscribe();
    });

    test('a routed read answers from the phone store and a foreign channel still rides the transport', async () => {
        connect();
        const snapshot = api.getSettings() as Promise<unknown>;
        answerLast('get-settings', desktopSettings({ theme: 'light', language: 'lv' }));
        await snapshot;
        phone.sent.length = 0;
        await expect(api.getSetting('language')).resolves.toBe('lv');
        expect(phone.sent).toHaveLength(0);
        const foreign = api.getBankroll() as Promise<unknown>;
        expect(phone.sent).toHaveLength(1);
        answerLast('get-bankroll', { coins: 5 });
        await expect(foreign).resolves.toEqual({ coins: 5 });
    });
});
