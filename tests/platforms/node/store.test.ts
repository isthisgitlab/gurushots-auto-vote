/**
 * The node family's storage member: the fs transport of the JSON stores. The
 * wrapped write helpers are reached at call time, so the module mocks stand;
 * the reads run over the fs mock tests/setup.ts installs. The no-op members
 * (no hydrate, no queue, no bridge) answer what the storage branches answer
 * off Capacitor and headless.
 */

jest.mock('../../../src/ts/settings/atomicWrite', () => ({
    __esModule: true,
    writeAtomicOwnerOnly: jest.fn(),
    sweepStaleTemps: jest.fn(),
}));
jest.mock('../../../src/ts/settings/ownerOnlyWrite', () => ({
    __esModule: true,
    writeOwnerOnly: jest.fn(),
}));
jest.mock('../../../src/ts/settings/settingsFileNode', () => ({
    __esModule: true,
    hasQuarantinedOnDisk: jest.fn(),
    renameToCorruptBackup: jest.fn(),
    writeIfAbsentOnDisk: jest.fn(),
}));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import atomicWriteModule = require('../../../src/ts/settings/atomicWrite');
const atomicWrite = jest.mocked(atomicWriteModule);
import ownerOnlyWriteModule = require('../../../src/ts/settings/ownerOnlyWrite');
const ownerOnly = jest.mocked(ownerOnlyWriteModule);
import settingsFileNodeModule = require('../../../src/ts/settings/settingsFileNode');
const fileNode = jest.mocked(settingsFileNodeModule);

import { createNodeStorage } from '../../../src/ts/platforms/node/store';

import type { SettingsStoreRef } from '../../../src/ts/platform/port';
import type { WriteIfAbsentResult } from '../../../src/ts/settings/storageTypes';

const store = (file: string, sweep: SettingsStoreRef['sweep'] = 'none'): SettingsStoreRef => ({
    prefKey: 'gs_test',
    filePath: () => file,
    sweep,
});
const storage = createNodeStorage();

describe('readRaw', () => {
    test('it reads the store file', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('{"a":1}');
        expect(storage.readRaw(store('/data/x.json'))).toBe('{"a":1}');
        expect(fs.readFileSync).toHaveBeenCalledWith('/data/x.json', 'utf8');
    });

    test('it answers null for a store never written', () => {
        fs.existsSync.mockReturnValue(false);
        expect(storage.readRaw(store('/data/x.json'))).toBeNull();
    });
});

describe('writeRaw', () => {
    test('an atomic store is replaced by temp file and rename', () => {
        storage.writeRaw(store('/data/x.json'), 'DATA', true);
        expect(atomicWrite.writeAtomicOwnerOnly).toHaveBeenCalledWith('/data/x.json', 'DATA');
        expect(ownerOnly.writeOwnerOnly).not.toHaveBeenCalled();
    });

    test('a store that is not atomic is written in place', () => {
        storage.writeRaw(store('/data/x.json'), 'DATA', false);
        expect(ownerOnly.writeOwnerOnly).toHaveBeenCalledWith('/data/x.json', 'DATA');
    });
});

describe('the stale-temp sweep', () => {
    test.each(['read-write', 'write'] as const)('a first write sweeps the file of a %s store, once', (sweep) => {
        const swept = createNodeStorage();
        fs.existsSync.mockReturnValue(false);
        swept.writeRaw(store('/data/swept.json', sweep), 'DATA', true);
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/swept.json');
        swept.writeRaw(store('/data/swept.json', sweep), 'MORE', true);
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
    });

    test('a read-write store sweeps before its first read, and only once for the path', () => {
        const swept = createNodeStorage();
        fs.existsSync.mockReturnValue(false);
        swept.readRaw(store('/data/rw.json', 'read-write'));
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/rw.json');
        swept.readRaw(store('/data/rw.json', 'read-write'));
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
    });

    test('a write store never sweeps on a read', () => {
        const swept = createNodeStorage();
        fs.existsSync.mockReturnValue(false);
        swept.readRaw(store('/data/w.json', 'write'));
        expect(atomicWrite.sweepStaleTemps).not.toHaveBeenCalled();
    });

    test('a second file path is swept on its own', () => {
        const swept = createNodeStorage();
        fs.existsSync.mockReturnValue(false);
        swept.readRaw(store('/data/one.json', 'read-write'));
        swept.readRaw(store('/data/one.json', 'read-write'));
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(1);
        swept.readRaw(store('/data/two.json', 'read-write'));
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledTimes(2);
        expect(atomicWrite.sweepStaleTemps).toHaveBeenCalledWith('/data/two.json');
    });

    test('a none store never sweeps', () => {
        const swept = createNodeStorage();
        fs.existsSync.mockReturnValue(false);
        swept.readRaw(store('/data/plain.json'));
        swept.writeRaw(store('/data/plain.json'), 'DATA', false);
        expect(atomicWrite.sweepStaleTemps).not.toHaveBeenCalled();
    });
});

describe('the file-backed store methods', () => {
    test('writeIfAbsent delegates to settingsFileNode', () => {
        const saved: WriteIfAbsentResult = { outcome: 'saved' };
        fileNode.writeIfAbsentOnDisk.mockReturnValue(saved);
        expect(storage.writeIfAbsent(store('/data/x.json'), 'IMPORT')).toEqual(saved);
        expect(fileNode.writeIfAbsentOnDisk).toHaveBeenCalledWith('/data/x.json', 'IMPORT');
    });

    test('location answers the file path', () => {
        expect(storage.location(store('/data/x.json'))).toBe('/data/x.json');
    });

    test('hasQuarantined delegates to settingsFileNode', () => {
        const ref = store('/data/x.json');
        fileNode.hasQuarantinedOnDisk.mockReturnValue(true);
        expect(storage.hasQuarantined(ref)).toBe(true);
        expect(fileNode.hasQuarantinedOnDisk).toHaveBeenCalledWith(ref.filePath);
    });

    test('quarantineRaw renames the file to a corrupt backup named with the time it was set aside', () => {
        const ref = store('/data/x.json');
        const quarantined = { ok: true as const, path: '/data/x.json.corrupt-moved' };
        fileNode.renameToCorruptBackup.mockReturnValue(quarantined);
        expect(storage.quarantineRaw(ref, 'UNUSABLE')).toEqual(quarantined);
        expect(fileNode.renameToCorruptBackup).toHaveBeenCalledWith(
            '/data/x.json',
            expect.stringMatching(/^\/data\/x\.json\.corrupt-\d{4}-\d{2}-\d{2}T/),
        );
    });
});

describe('the desktop no-ops', () => {
    test('there is no plugin read, no hydration, no queue and no native bridge', () => {
        expect(storage.storedKey).toBeNull();
        expect(storage.preferences).toBeNull();
        expect(storage.headlessStore()).toBeUndefined();
        expect(storage.cas).toBeNull();
        expect(storage.sharedUpdate).toBeNull();
    });

    test('a read cannot fail, and the file is what is stored', () => {
        expect(storage.readFailed('gs_test')).toBe(false);
        expect(storage.loaded('gs_test')).toBe(true);
    });

    test('flushed resolves at once', async () => {
        await expect(storage.flushed()).resolves.toBeUndefined();
    });

    test('two processes share the directory, so the settings file lock decides', () => {
        expect(storage.lockPolicy).toBe('file');
    });
});
