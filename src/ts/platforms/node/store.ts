/**
 * The node family's storage member: the fs transport of the generic JSON
 * stores and the settings files (Electron, CLI, the web server). `jsonStore`
 * and `settingsFile` build one transport object per store over the real file
 * system: the plain read at the store's file path, the owner-only or atomic
 * write, the stale-temp sweep of the file, and its corrupt backup. There is
 * no cache, no queue and no native bridge, so a change is made and saved in
 * one step (core's writeNow over this transport's own operations), reads
 * cannot fail, and the hydrate and flush members are no-ops: the file is
 * what is stored.
 *
 * Everything wrapped is reached at call time: the node project's setup file
 * loads the test helpers that import this family, so a module graph loaded at
 * import time would land in the setup's registry — the tests/setup.ts
 * fs/path mocks included — before a test file registers its own, and the
 * test's factory would lose to the cached module (platforms/node/index.ts
 * states the reason in full).
 */

import type {
    JsonStoreTransport,
    PlatformStorage,
    SettingsFileTransport,
    SettingsFileWiring,
    SettingsStoreRef,
} from '../../core/platform/port';

type AtomicWriteModule = typeof import('./atomicWrite');
type OwnerOnlyWriteModule = typeof import('./ownerOnlyWrite');
type SettingsFileNodeModule = typeof import('./settingsFileNode');
type StorageModule = typeof import('../../core/settings/storage');
type FsModule = typeof import('node:fs');

// See the header: the wrapped modules, reached at call time.
const atomicWrite = (): AtomicWriteModule => require('./atomicWrite') as AtomicWriteModule;
const ownerOnlyWrite = (): OwnerOnlyWriteModule => require('./ownerOnlyWrite') as OwnerOnlyWriteModule;
const settingsFileNode = (): SettingsFileNodeModule => require('./settingsFileNode') as SettingsFileNodeModule;
// Lazy for both reasons the header names: this file sits in the shell
// platform modules' static chain and the settings graph reaches the logger,
// which reads platform() at load — the install must run first — and a graph
// loaded in the Jest setup's registry would beat a test file's own mocks.
// The public storage facade carries writeNow; the facade's internals are
// private to it.
const storage = (): StorageModule => require('../../core/settings/storage') as StorageModule;
const nodeFs = (): FsModule => require('node:fs') as FsModule;

// The plain read of one store file (jsonStore readRaw / the settings file's readHere on a desktop).
const readStoreFile = (file: string): string | null => {
    const fs = nodeFs();
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
};

// The time a value was set aside, as part of the name it is kept under.
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

// The stale-temp sweep of a store's file, once per file path: before the first read or write for a `read-write`
// store (the atomic createJsonStore rule — only an atomic store sweeps), before the first write only for a
// `write` store (the settings file's rule, never on a read).
const sweeper = () => {
    const swept = new Set<string>();
    return (file: string): void => {
        if (swept.has(file)) return;
        swept.add(file);
        atomicWrite().sweepStaleTemps(file);
    };
};

// The generic JSON store's fs transport. `flags` carries the headless-side
// strictness and sharing, which have no fs answer: a write that fails throws,
// and two processes take the settings file lock.
const jsonStoreTransport = (
    ref: SettingsStoreRef,
    _flags: { strict: boolean; shared: boolean },
): JsonStoreTransport => {
    // The sweep and the atomic replacement ride the same fact: `read-write` is the atomic store's sweep rule.
    const atomic = ref.sweep === 'read-write';
    const sweepOnce = sweeper();
    const readRaw = (): string | null => {
        if (atomic) sweepOnce(ref.filePath());
        return readStoreFile(ref.filePath());
    };
    const writeRaw = (data: string): void => {
        if (ref.sweep !== 'none') sweepOnce(ref.filePath());
        const write = atomic ? atomicWrite().writeAtomicOwnerOnly : ownerOnlyWrite().writeOwnerOnly;
        write(ref.filePath(), data);
    };
    return {
        readRaw,
        writeRaw,
        hydrate: async () => undefined,
        reread: async () => true,
        updateNow: (update) => storage().writeNow(ref.prefKey, { readRaw, writeRaw }, update),
        updateThrough: async (update) => storage().writeNow(ref.prefKey, { readRaw, writeRaw }, update),
        peekStored: async () => readRaw(),
        flush: async () => undefined,
        discard: () => undefined,
    };
};

// The settings file's fs transport. `wiring` carries the Android-side rebase,
// bridge choice and dropped-save reporting, which a plain file has no use for.
const settingsFileTransport = (ref: SettingsStoreRef, _wiring: SettingsFileWiring): SettingsFileTransport => {
    const sweepOnce = sweeper();
    return {
        readRaw: () => readStoreFile(ref.filePath()),
        write: (data) => {
            sweepOnce(ref.filePath());
            atomicWrite().writeAtomicOwnerOnly(ref.filePath(), data);
            return { ok: true };
        },
        writeIfAbsent: (data) => settingsFileNode().writeIfAbsentOnDisk(ref.filePath(), data),
        location: () => ref.filePath(),
        isLoaded: () => true,
        isPersisted: () => true,
        hasQuarantined: () => settingsFileNode().hasQuarantinedOnDisk(ref.filePath),
        quarantineRaw: (_raw) => {
            const file = ref.filePath();
            return settingsFileNode().renameToCorruptBackup(file, `${file}.corrupt-${setAsideStamp()}`);
        },
        hydrate: async () => undefined,
        flush: async () => undefined,
        discard: async () => undefined,
    };
};

const createNodeStorage = (): PlatformStorage => ({
    jsonStore: jsonStoreTransport,
    settingsFile: settingsFileTransport,
    // A desktop read is the file itself: no read can fail, so a store that other work trusts always holds what is saved.
    loaded: () => true,
    // Two processes share the user-data directory, so a change is made under the settings file lock.
    lockPolicy: 'file',
});

export { createNodeStorage };
