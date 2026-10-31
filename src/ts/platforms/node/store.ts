/**
 * The node family's storage member: the fs transport of the JSON stores
 * (Electron, CLI, the web server). Every member is the body the storage
 * branches select on a desktop — a plain read at the store's file path, the
 * owner-only or atomic write, and the file's corrupt backup. There is no
 * hydrate, no queue and no native bridge, so those members answer null or
 * their no-op, the way the branches do off Capacitor and headless.
 *
 * Everything wrapped is reached at call time: the node project's setup file
 * loads the test helpers that import this family, so a module graph loaded at
 * import time would land in the setup's registry — the tests/setup.ts
 * fs/path mocks included — before a test file registers its own, and the
 * test's factory would lose to the cached module (platforms/node/index.ts
 * states the reason in full). The wrapped settings-side write helpers
 * (settings/atomicWrite, settings/ownerOnlyWrite, settings/settingsFileNode)
 * are part of that graph, and Phase 3 moves their bodies into this family
 * and retires the indirection.
 */

import type { PlatformStorage } from '../../platform/port';

type AtomicWriteModule = typeof import('../../settings/atomicWrite');
type OwnerOnlyWriteModule = typeof import('../../settings/ownerOnlyWrite');
type SettingsFileNodeModule = typeof import('../../settings/settingsFileNode');
type FsModule = typeof import('node:fs');

// See the header: the wrapped modules, reached at call time.
const atomicWrite = (): AtomicWriteModule => require('../../settings/atomicWrite') as AtomicWriteModule;
const ownerOnlyWrite = (): OwnerOnlyWriteModule => require('../../settings/ownerOnlyWrite') as OwnerOnlyWriteModule;
const settingsFileNode = (): SettingsFileNodeModule =>
    require('../../settings/settingsFileNode') as SettingsFileNodeModule;
const nodeFs = (): FsModule => require('node:fs') as FsModule;

// The plain read of one store file (jsonStore readRaw / settingsFileMethods readHere on a desktop).
const readStoreFile = (file: string): string | null => {
    const fs = nodeFs();
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
};

// The time a value was set aside, as part of the name it is kept under (settingsFileMethods setAsideStamp).
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const createNodeStorage = (): PlatformStorage => {
    // The stale-temp sweep of a store's file, once per file path: before the
    // first read or write for a `read-write` store (jsonStore's sweepOnce),
    // before the first write only for a `write` store (the settings file's).
    // Reached at call time with the wrapped helpers.
    const swept = new Set<string>();
    const sweepOnce = (file: string): void => {
        if (swept.has(file)) return;
        swept.add(file);
        atomicWrite().sweepStaleTemps(file);
    };
    return {
        readRaw: (store) => {
            // read-write is the createJsonStore rule: the sweep runs before the first read too. The settings
            // file's rule (`write`) never sweeps on a read.
            if (store.sweep === 'read-write') sweepOnce(store.filePath());
            return readStoreFile(store.filePath());
        },
        writeRaw: (store, data, atomic) => {
            if (store.sweep !== 'none') sweepOnce(store.filePath());
            const write = atomic ? atomicWrite().writeAtomicOwnerOnly : ownerOnlyWrite().writeOwnerOnly;
            write(store.filePath(), data);
        },
        writeIfAbsent: (store, data) => settingsFileNode().writeIfAbsentOnDisk(store.filePath(), data),
        location: (store) => store.filePath(),
        hasQuarantined: (store) => settingsFileNode().hasQuarantinedOnDisk(store.filePath),
        quarantineRaw: (store, _raw) => {
            const file = store.filePath();
            return settingsFileNode().renameToCorruptBackup(file, `${file}.corrupt-${setAsideStamp()}`);
        },
        // A desktop read is the file itself: no boot hydration, no re-read, no read that can fail, no
        // queue to flush, and no native bridge or compare-and-write to reach.
        storedKey: null,
        preferences: null,
        headlessStore: () => undefined,
        cas: null,
        sharedUpdate: null,
        readFailed: () => false,
        loaded: () => true,
        flushed: async () => undefined,
        lockPolicy: 'file',
    };
};

export { createNodeStorage };
