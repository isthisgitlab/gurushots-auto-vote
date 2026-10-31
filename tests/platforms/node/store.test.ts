/**
 * The node family's storage member: the fs transport the `jsonStore` and
 * `settingsFile` builders give one store each. The wrapped write helpers are
 * reached at call time, so the module mocks stand; the reads run over the fs
 * mock tests/setup.ts installs.
 */

jest.mock('../../../src/ts/platforms/node/atomicWrite', () => ({
    __esModule: true,
    writeAtomicOwnerOnly: jest.fn(),
    sweepStaleTemps: jest.fn(),
}));
jest.mock('../../../src/ts/platforms/node/ownerOnlyWrite', () => ({
    __esModule: true,
    writeOwnerOnly: jest.fn(),
}));
jest.mock('../../../src/ts/platforms/node/settingsFileNode', () => ({
    __esModule: true,
    hasQuarantinedOnDisk: jest.fn(),
    renameToCorruptBackup: jest.fn(),
    writeIfAbsentOnDisk: jest.fn(),
}));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import atomicWriteModule = require('../../../src/ts/platforms/node/atomicWrite');
const atomicWrite = jest.mocked(atomicWriteModule);
import ownerOnlyWriteModule = require('../../../src/ts/platforms/node/ownerOnlyWrite');
const ownerOnly = jest.mocked(ownerOnlyWriteModule);
import settingsFileNodeModule = require('../../../src/ts/platforms/node/settingsFileNode');
const fileNode = jest.mocked(settingsFileNodeModule);

import { createNodeStorage } from '../../../src/ts/platforms/node/store';

import type { SettingsStoreRef } from '../../../src/ts/core/platform/port';
import type { WriteIfAbsentResult } from '../../../src/ts/core/settings/storageTypes';

const ref = (file: string, sweep: SettingsStoreRef['sweep'] = 'none'): SettingsStoreRef => ({
    prefKey: 'gs_test',
    filePath: () => file,
    sweep,
});
const FLAGS = { strict: false, shared: false };
const WIRING = {
    rebase: (_base: string | null, ours: string, _theirs: string | null) => ours,
    dedicatedBridge: false,
    droppedSaves: null,
};
const storage = createNodeStorage();

describe('the jsonStore transport', () => {
    test('readRaw reads the store file, and answers null for a store never written', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('{"a":1}');
        expect(storage.jsonStore(ref('/data/x.json'), FLAGS).readRaw()).toBe('{"a":1}');
        expect(fs.readFileSync).toHaveBeenCalledWith('/data/x.json', 'utf8');
        fs.existsSync.mockReturnValue(false);
        expect(storage.jsonStore(ref('/data/gone.json'), FLAGS).readRaw()).toBeNull();
    });

    test('an atomic store is replaced by temp file and rename, a plain one is written in place', () => {
        storage.jsonStore(ref('/data/x.json', 'read-write'), FLAGS).writeRaw('DATA');
        expect(atomicWrite.writeAtomicOwnerOnly).toHaveBeenCalledWith('/data/x.json', 'DATA');
        expect(ownerOnly.writeOwnerOnly).not.toHaveBeenCalled();
        storage.jsonStore(ref('/data/y.json'), FLAGS).writeRaw('DATA');
        expect(ownerOnly.writeOwnerOnly).toHaveBeenCalledWith('/data/y.json', 'DATA');
    });

    describe('the stale-temp sweep', () => {
        test('a first write sweeps the file of a read-write store, once', () => {
            const swept = createNodeStorage();
            fs.existsSync.mockReturnValue(false);
            const store = swept.jsonStore(ref('/data/swept.json', 'read-write'), FLAGS);
            store.writeRaw('DATA');
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/swept.json');
            store.writeRaw('MORE');
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
        });

        test('a read-write store sweeps before its first read, and only once for the transport', () => {
            const swept = createNodeStorage();
            fs.existsSync.mockReturnValue(false);
            const store = swept.jsonStore(ref('/data/rw.json', 'read-write'), FLAGS);
            store.readRaw();
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/rw.json');
            store.readRaw();
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
        });

        test('a write store never sweeps on a read', () => {
            const swept = createNodeStorage();
            fs.existsSync.mockReturnValue(false);
            swept.jsonStore(ref('/data/w.json', 'write'), FLAGS).readRaw();
            expect(atomicWrite.sweepStaleTemps).not.toHaveBeenCalled();
        });

        test('a second file path is swept on its own', () => {
            const swept = createNodeStorage();
            fs.existsSync.mockReturnValue(false);
            const one = swept.jsonStore(ref('/data/one.json', 'read-write'), FLAGS);
            one.readRaw();
            one.readRaw();
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
            swept.jsonStore(ref('/data/two.json', 'read-write'), FLAGS).readRaw();
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(2);
            expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/two.json');
        });

        test('a none store never sweeps', () => {
            const swept = createNodeStorage();
            fs.existsSync.mockReturnValue(false);
            const store = swept.jsonStore(ref('/data/plain.json'), FLAGS);
            store.readRaw();
            store.writeRaw('DATA');
            expect(atomicWrite.sweepStaleTemps).not.toHaveBeenCalled();
        });
    });

    describe('a change is made and saved in one step, over this transport', () => {
        test('updateNow writes only if the file still holds what the change was made from', () => {
            const store = storage.jsonStore(ref('/data/x.json'), FLAGS);
            fs.existsSync.mockReturnValue(true);
            // Read (A), made from, read again before the write (still A): written.
            fs.readFileSync.mockReset().mockReturnValueOnce('A').mockReturnValueOnce('A');
            expect(store.updateNow((current) => `${current}+mine`)).toBe('saved');
            expect(ownerOnly.writeOwnerOnly).toHaveBeenCalledWith('/data/x.json', 'A+mine');
            // Read (A), made from, read again before the write (B: changed): the change is made again on B, and B holds.
            fs.readFileSync
                .mockReset()
                .mockReturnValueOnce('A')
                .mockReturnValueOnce('B')
                .mockReturnValueOnce('B')
                .mockReturnValueOnce('B');
            expect(store.updateNow((current) => `${current}+mine`)).toBe('saved');
            expect(ownerOnly.writeOwnerOnly).toHaveBeenLastCalledWith('/data/x.json', 'B+mine');
        });

        test('updateNow gives up on a file that keeps changing, and answers failed on a write that throws', () => {
            const store = storage.jsonStore(ref('/data/x.json'), FLAGS);
            fs.existsSync.mockReturnValue(true);
            let reads = 0;
            fs.readFileSync.mockImplementation(() => `v${reads++}`);
            expect(store.updateNow((current) => `${current}+mine`)).toBe('failed');
            fs.readFileSync.mockReset();
            fs.existsSync.mockReturnValue(false);
            expect(store.updateNow(() => null)).toBe('aborted');
            ownerOnly.writeOwnerOnly.mockImplementationOnce(() => {
                throw new Error('EACCES');
            });
            expect(store.updateNow(() => 'x')).toBe('failed');
        });

        test('updateThrough is the same one-step write, resolved', async () => {
            const store = storage.jsonStore(ref('/data/x.json'), FLAGS);
            fs.existsSync.mockReturnValue(false);
            await expect(store.updateThrough(() => '{"a":1}')).resolves.toBe('saved');
            expect(ownerOnly.writeOwnerOnly).toHaveBeenCalledWith('/data/x.json', '{"a":1}');
        });

        test('peekStored is the plain read, hydrate and flush are no-ops, and discard leaves nothing to do', async () => {
            const store = storage.jsonStore(ref('/data/x.json'), FLAGS);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('{"a":1}');
            await expect(store.peekStored()).resolves.toBe('{"a":1}');
            await expect(store.hydrate()).resolves.toBeUndefined();
            await expect(store.flush()).resolves.toBeUndefined();
            await expect(store.reread()).resolves.toBe(true);
            expect(() => store.discard()).not.toThrow();
        });
    });
});

describe('the settingsFile transport', () => {
    test('write sweeps the file and replaces it atomically', () => {
        fs.existsSync.mockReturnValue(false);
        expect(storage.settingsFile(ref('/data/cfg.json', 'write'), WIRING).write('DATA')).toEqual({ ok: true });
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/cfg.json');
        expect(atomicWrite.writeAtomicOwnerOnly).toHaveBeenCalledWith('/data/cfg.json', 'DATA');
    });

    test('writeIfAbsent delegates to settingsFileNode', () => {
        const saved: WriteIfAbsentResult = { outcome: 'saved' };
        fileNode.writeIfAbsentOnDisk.mockReturnValue(saved);
        expect(storage.settingsFile(ref('/data/cfg.json'), WIRING).writeIfAbsent('IMPORT')).toEqual(saved);
        expect(fileNode.writeIfAbsentOnDisk).toHaveBeenCalledWith('/data/cfg.json', 'IMPORT');
    });

    test('location answers the file path', () => {
        expect(storage.settingsFile(ref('/data/cfg.json'), WIRING).location()).toBe('/data/cfg.json');
    });

    test('hasQuarantined delegates to settingsFileNode', () => {
        const fileRef = ref('/data/cfg.json');
        fileNode.hasQuarantinedOnDisk.mockReturnValue(true);
        expect(storage.settingsFile(fileRef, WIRING).hasQuarantined()).toBe(true);
        expect(fileNode.hasQuarantinedOnDisk).toHaveBeenCalledWith(fileRef.filePath);
    });

    test('quarantineRaw renames the file to a corrupt backup named with the time it was set aside', () => {
        const quarantined = { ok: true as const, path: '/data/cfg.json.corrupt-moved' };
        fileNode.renameToCorruptBackup.mockReturnValue(quarantined);
        expect(storage.settingsFile(ref('/data/cfg.json'), WIRING).quarantineRaw('UNUSABLE')).toEqual(quarantined);
        expect(fileNode.renameToCorruptBackup).toHaveBeenCalledWith(
            '/data/cfg.json',
            expect.stringMatching(/^\/data\/cfg\.json\.corrupt-\d{4}-\d{2}-\d{2}T/),
        );
    });

    test('the file is what is stored: hydrate and flush are no-ops, discard does nothing', async () => {
        const file = storage.settingsFile(ref('/data/cfg.json'), WIRING);
        await expect(file.hydrate()).resolves.toBeUndefined();
        await expect(file.flush()).resolves.toBeUndefined();
        await expect(file.discard()).resolves.toBeUndefined();
        expect(file.isLoaded()).toBe(true);
        expect(file.isPersisted()).toBe(true);
    });
});

describe('the family answers', () => {
    test('a read cannot fail, and the file is what is stored', () => {
        expect(storage.loaded('gs_test')).toBe(true);
    });

    test('two processes share the directory, so the settings file lock decides', () => {
        expect(storage.lockPolicy).toBe('file');
    });
});
