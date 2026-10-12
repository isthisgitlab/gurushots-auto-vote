/**
 * createJsonStore — the generic platform-aware JSON store metadata.ts rides
 * (same transport pattern as the settings store): fs on Electron/CLI,
 * hydrate-once cache + ordered write-behind on Capacitor, memory-only on the
 * Android headless service.
 */

import type { GetOptions, GetResult, SetOptions } from '@capacitor/preferences';

const mockPrefSet = jest.fn<Promise<void>, [SetOptions]>(() => Promise.resolve());
const mockPrefGet = jest.fn<Promise<GetResult>, [GetOptions]>(() => Promise.resolve({ value: null }));
jest.mock(
    '@capacitor/preferences',
    () => ({
        Preferences: {
            set: (...a: Parameters<typeof mockPrefSet>) => mockPrefSet(...a),
            get: (...a: Parameters<typeof mockPrefGet>) => mockPrefGet(...a),
        },
    }),
    { virtual: true },
);

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import type * as storageModule from '../../src/ts/settings/storage';
import type * as storeTransportModule from '../../src/ts/settings/storeTransport';
import * as logger from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
    __GS_HEADLESS__?: boolean;
};

describe('createJsonStore', () => {
    // No jest.resetModules(): createJsonStore reads the runtime flags at
    // call time, so fresh store instances per test are enough — and a
    // registry reset would detach the file-top `fs` reference from the
    // instance the store binds to.
    afterEach(() => {
        delete g.Capacitor;
        delete g.__GS_HEADLESS__;
        jest.clearAllMocks();
    });

    describe('fs transport (Electron/CLI)', () => {
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('readRaw returns null when the file does not exist', () => {
            fs.existsSync.mockReturnValue(false);
            expect(store.readRaw()).toBeNull();
        });

        test('readRaw returns the file contents', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('{"a":1}');
            expect(store.readRaw()).toBe('{"a":1}');
        });

        test('writeRaw writes with owner-only mode', () => {
            fs.existsSync.mockReturnValue(true);
            store.writeRaw('{"a":2}');
            expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('metadata.json'), '{"a":2}', {
                encoding: 'utf8',
                mode: 0o600,
            });
        });

        describe('an atomic store replaces its file, never writing into it', () => {
            let atomic: ReturnType<typeof storageModule.createJsonStore>;
            const TEMP = /joinState\.json\.\d+\.[0-9a-f]{8}\.tmp$/;

            beforeEach(() => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                atomic = createJsonStore({ fileName: 'joinState.json', prefKey: 'gs_join_state', atomic: true });
                fs.existsSync.mockReturnValue(true);
                fs.readdirSync.mockReturnValue([]);
            });

            test('the data goes to a temp file next to it (owner-only, exclusive), is flushed to disk, and is renamed over it', () => {
                atomic.writeRaw('{"a":3}');
                const [temp, flag, mode] = invalid<[string, string, number]>(fs.openSync.mock.calls[0]);
                expect(temp).toMatch(TEMP);
                expect([flag, mode]).toEqual(['wx', 0o600]);
                expect(fs.writeFileSync).toHaveBeenCalledWith(3, '{"a":3}');
                expect(fs.fsyncSync).toHaveBeenCalledWith(3);
                expect(fs.closeSync).toHaveBeenCalledWith(3);
                expect(fs.renameSync).toHaveBeenCalledWith(temp, expect.stringMatching(/joinState\.json$/));
                // The data is on disk before the rename makes it the file.
                expect(fs.fsyncSync.mock.invocationCallOrder[0]).toBeLessThan(
                    fs.renameSync.mock.invocationCallOrder[0],
                );
                // Nothing is ever written into the file itself, so a reader never sees it empty or cut off.
                expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
                expect(fs.writeFileSync).not.toHaveBeenCalledWith(
                    expect.stringMatching(/joinState\.json$/),
                    expect.anything(),
                    expect.anything(),
                );
                expect(fs.chmodSync).not.toHaveBeenCalled();
            });

            test('the directory is flushed after the rename, where there are directories to open', () => {
                atomic.writeRaw('{}');
                // The temp file's descriptor, then the directory's.
                expect(fs.openSync).toHaveBeenLastCalledWith(expect.not.stringMatching(/joinState/), 'r');
                expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
                expect(fs.fsyncSync.mock.invocationCallOrder[1]).toBeGreaterThan(
                    fs.renameSync.mock.invocationCallOrder[0],
                );
            });

            test('a directory that cannot be flushed does not fail the write', () => {
                fs.openSync
                    .mockImplementationOnce(() => 3)
                    .mockImplementationOnce(() => {
                        throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
                    });
                expect(() => atomic.writeRaw('{}')).not.toThrow();
                expect(fs.closeSync).toHaveBeenCalledTimes(1);
            });

            test('a directory that was opened is closed even when flushing it fails', () => {
                fs.fsyncSync
                    .mockImplementationOnce(() => undefined)
                    .mockImplementationOnce(() => {
                        throw new Error('EIO');
                    });
                expect(() => atomic.writeRaw('{}')).not.toThrow();
                expect(fs.closeSync).toHaveBeenCalledTimes(2);
            });

            test('Windows cannot open a directory, so it does not try', () => {
                const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
                Object.defineProperty(process, 'platform', { value: 'win32' });
                try {
                    atomic.writeRaw('{}');
                } finally {
                    Object.defineProperty(process, 'platform', platform);
                }
                expect(fs.openSync).toHaveBeenCalledTimes(1);
                expect(fs.renameSync).toHaveBeenCalledTimes(1);
            });

            test('a failed open, write, flush or rename removes the temp file and fails the write', () => {
                fs.openSync.mockImplementationOnce(() => {
                    throw new Error('disk full');
                });
                expect(() => atomic.writeRaw('{}')).toThrow('disk full');
                fs.writeFileSync.mockImplementationOnce(() => {
                    throw new Error('ENOSPC');
                });
                expect(() => atomic.writeRaw('{}')).toThrow('ENOSPC');
                // The descriptor is closed whatever happened to the write.
                expect(fs.closeSync).toHaveBeenCalledTimes(1);
                fs.fsyncSync.mockImplementationOnce(() => {
                    throw new Error('EIO');
                });
                expect(() => atomic.writeRaw('{}')).toThrow('EIO');
                fs.renameSync.mockImplementationOnce(() => {
                    throw new Error('EXDEV');
                });
                expect(() => atomic.writeRaw('{}')).toThrow('EXDEV');
                expect(fs.unlinkSync).toHaveBeenCalledTimes(4);
                expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(TEMP));
            });

            test('a temp file that is not there to remove does not hide the failure', () => {
                fs.writeFileSync.mockImplementationOnce(() => {
                    throw new Error('disk full');
                });
                fs.unlinkSync.mockImplementationOnce(() => {
                    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                });
                expect(() => atomic.writeRaw('{}')).toThrow('disk full');
            });

            test('the directory is created when it is missing', () => {
                fs.existsSync.mockReturnValue(false);
                atomic.writeRaw('{}');
                expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
            });

            describe('the temp files of a write that was cut short are cleared, once, by the first read or write', () => {
                const AGE = 61_000;
                const listing = (...names: string[]) => {
                    fs.readdirSync.mockReturnValue(invalid(names));
                    fs.statSync.mockReturnValue(invalid({ mtimeMs: Date.now() - AGE }));
                };

                test('only names of its own pattern, and only old ones', () => {
                    listing(
                        'joinState.json.4242.0a1b2c3d.tmp',
                        'joinState.json',
                        'joinState.json.4242.0a1b2c3d.tmp.bak',
                        'joinState.json.abc.0a1b2c3d.tmp',
                        'metadata.json.4242.0a1b2c3d.tmp',
                        'joinState.jsonx.4242.0a1b2c3d.tmp',
                        'joinStateXjson.4242.0a1b2c3d.tmp',
                        'x.joinState.json.4242.0a1b2c3d.tmp',
                    );
                    atomic.readRaw();
                    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
                    expect(fs.unlinkSync).toHaveBeenCalledWith(
                        expect.stringMatching(/joinState\.json\.4242\.0a1b2c3d\.tmp$/),
                    );
                });

                test('a temp file of a write that may still be under way is left alone', () => {
                    listing('joinState.json.4242.0a1b2c3d.tmp');
                    fs.statSync.mockReturnValue(invalid({ mtimeMs: Date.now() - 5_000 }));
                    atomic.writeRaw('{}');
                    expect(fs.unlinkSync).not.toHaveBeenCalled();
                });

                test('it happens once per store: the first write clears them, later reads and writes do not look again', () => {
                    listing('joinState.json.4242.0a1b2c3d.tmp');
                    atomic.writeRaw('{}');
                    atomic.readRaw();
                    atomic.writeRaw('{}');
                    expect(fs.readdirSync).toHaveBeenCalledTimes(1);
                });

                test('a directory that cannot be listed, or a file that cannot be removed, does not fail the read', () => {
                    fs.readdirSync.mockImplementationOnce(() => {
                        throw new Error('EACCES');
                    });
                    expect(() => atomic.readRaw()).not.toThrow();
                    const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                    const other = createJsonStore({ fileName: 'joinState.json', prefKey: 'k', atomic: true });
                    listing('joinState.json.4242.0a1b2c3d.tmp');
                    fs.unlinkSync.mockImplementationOnce(() => {
                        throw new Error('EBUSY');
                    });
                    expect(() => other.readRaw()).not.toThrow();
                });

                test('one that vanished before it could be looked at does not stop the others', () => {
                    listing('joinState.json.1.0a1b2c3d.tmp', 'joinState.json.2.0a1b2c3d.tmp');
                    fs.statSync.mockImplementationOnce(() => {
                        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                    });
                    atomic.readRaw();
                    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
                    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/joinState\.json\.2\./));
                });

                test('a store that is not atomic never looks', () => {
                    store.readRaw();
                    store.writeRaw('{}');
                    expect(fs.readdirSync).not.toHaveBeenCalled();
                });
            });
        });

        test('writeRaw chmods the file to 0o600 before writing into it', () => {
            store.writeRaw('{"a":2}');
            expect(fs.chmodSync).toHaveBeenCalledTimes(1);
            expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('metadata.json'), 0o600);
            expect(fs.chmodSync.mock.invocationCallOrder[0]).toBeLessThan(fs.writeFileSync.mock.invocationCallOrder[0]);
        });

        test('writeRaw still creates a file whose chmod finds nothing (ENOENT)', () => {
            fs.chmodSync.mockImplementationOnce(() => {
                throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
            });
            store.writeRaw('{"a":2}');
            expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
            expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('metadata.json'), '{"a":2}', {
                encoding: 'utf8',
                mode: 0o600,
            });
            const warnings = jest
                .mocked(logger.withCategory)
                .mock.results.flatMap((r) => (r.type === 'return' ? jest.mocked(r.value.warning).mock.calls : []));
            expect(warnings).toEqual([]);
        });

        test('the file lives next to settings.json under the userData dir', () => {
            expect(store.getFilePath().endsWith('metadata.json')).toBe(true);
        });
    });

    describe('capacitor transport', () => {
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
            mockPrefGet.mockResolvedValue({ value: '{"persisted":true}' });
            const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('initializeAsync hydrates the cache from Preferences under its own key', async () => {
            await store.initializeAsync();
            expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gurushots-metadata' });
            expect(store.readRaw()).toBe('{"persisted":true}');
        });

        test('writeRaw updates the cache synchronously and write-behinds to Preferences', async () => {
            store.writeRaw('{"x":1}');
            expect(store.readRaw()).toBe('{"x":1}');
            await store.flushPendingWrites();
            expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gurushots-metadata', value: '{"x":1}' });
        });

        describe('a write that did not persist', () => {
            const strictStore = (prefKey = 'gs_scenario_state') => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                return createJsonStore({ fileName: 'scenarioState.json', prefKey, strict: true });
            };
            const failOnce = () => mockPrefSet.mockRejectedValueOnce(new Error('disk full'));

            test('is told by the flush of a strict store, with the error as its cause', async () => {
                const strict = strictStore();
                failOnce();
                strict.writeRaw('{"x":1}');
                const told = strict.flushPendingWrites();
                await expect(told).rejects.toThrow('gs_scenario_state was not persisted');
                await expect(told).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'disk full' }) });
            });

            test('is nothing to tell once a later write persisted what it held', async () => {
                const strict = strictStore();
                failOnce();
                strict.writeRaw('{"x":1}');
                strict.writeRaw('{"x":2}');
                await expect(strict.flushPendingWrites()).resolves.toBeUndefined();
                strict.writeRaw('{"x":3}');
                await expect(strict.flushPendingWrites()).resolves.toBeUndefined();
            });

            test('is told while the latest write is the one that failed, and not after a write that persisted', async () => {
                const strict = strictStore();
                failOnce();
                strict.writeRaw('{"x":1}');
                await expect(strict.flushPendingWrites()).rejects.toThrow('was not persisted');
                await expect(strict.flushPendingWrites()).rejects.toThrow('was not persisted');
                strict.writeRaw('{"x":2}');
                await expect(strict.flushPendingWrites()).resolves.toBeUndefined();
            });

            test('is waited for until the queue is quiet, a write queued meanwhile included', async () => {
                const strict = strictStore();
                let release!: () => void;
                mockPrefSet.mockImplementationOnce(
                    () =>
                        new Promise<void>((resolve) => {
                            release = resolve;
                        }),
                );
                strict.writeRaw('{"x":1}');
                const told = strict.flushPendingWrites();
                await Promise.resolve();
                strict.writeRaw('{"x":2}');
                release();
                await told;
                expect(mockPrefSet).toHaveBeenCalledTimes(2);
                expect(mockPrefSet).toHaveBeenLastCalledWith({ key: 'gs_scenario_state', value: '{"x":2}' });
            });

            test('keeps its value in the cache: it is the record of something done', async () => {
                const strict = strictStore();
                failOnce();
                strict.writeRaw('{"marker":1}');
                await expect(strict.flushPendingWrites()).rejects.toThrow('was not persisted');
                expect(strict.readRaw()).toBe('{"marker":1}');
            });

            test('passes quietly through the flush of any other store, as before, with its value kept', async () => {
                failOnce();
                store.writeRaw('{"x":1}');
                await expect(store.flushPendingWrites()).resolves.toBeUndefined();
                expect(store.readRaw()).toBe('{"x":1}');
            });
        });

        describe('a write that must not show before it is saved (updateThrough)', () => {
            const strictStore = () => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                return createJsonStore({
                    fileName: 'scenarioResets.json',
                    prefKey: 'gs_scenario_resets',
                    strict: true,
                });
            };
            const hold = () => {
                let release!: () => void;
                mockPrefSet.mockImplementationOnce(
                    () =>
                        new Promise<void>((resolve) => {
                            release = resolve;
                        }),
                );
                return () => release();
            };

            test('is in the cache only once Preferences has it', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                const release = hold();
                const saved = strict.updateThrough(() => '{"asked":1}');
                await new Promise((resolve) => setTimeout(resolve, 0));
                expect(mockPrefSet).toHaveBeenCalledWith({ key: 'gs_scenario_resets', value: '{"asked":1}' });
                expect(strict.readRaw()).toBe('{"persisted":true}');
                release();
                await expect(saved).resolves.toBe(true);
                expect(strict.readRaw()).toBe('{"asked":1}');
            });

            test('that was not saved answers false and leaves the cache, and what is read or written next, as they were', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                mockPrefSet.mockRejectedValueOnce(new Error('disk full'));
                await expect(strict.updateThrough(() => '{"asked":1}')).resolves.toBe(false);
                expect(strict.readRaw()).toBe('{"persisted":true}');
                await expect(strict.updateThrough((current) => `${current}!`)).resolves.toBe(true);
                expect(mockPrefSet).toHaveBeenLastCalledWith({
                    key: 'gs_scenario_resets',
                    value: '{"persisted":true}!',
                });
            });

            test('is made from the cache as it is when its turn comes, behind the writes queued before it', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                strict.writeRaw('{"a":1}');
                const first = strict.updateThrough((current) => `${current}1`);
                const second = strict.updateThrough((current) => `${current}2`);
                await Promise.all([first, second]);
                expect(mockPrefSet.mock.calls.map(([{ value }]) => value)).toEqual([
                    '{"a":1}',
                    '{"a":1}1',
                    '{"a":1}12',
                ]);
                expect(strict.readRaw()).toBe('{"a":1}12');
            });

            test('shows to a flush as a write of its own, and fills a cache that was never read', async () => {
                const { isCacheKnown } = require('../../src/ts/settings/storeTransport') as typeof storeTransportModule;
                const strict = strictStore();
                expect(isCacheKnown('gs_scenario_resets')).toBe(false);
                mockPrefSet.mockRejectedValueOnce(new Error('disk full'));
                await strict.updateThrough(() => 'x');
                await expect(strict.flushPendingWrites()).rejects.toThrow('was not persisted');
                expect(isCacheKnown('gs_scenario_resets')).toBe(false);
                await strict.updateThrough(() => '{"a":1}');
                expect(isCacheKnown('gs_scenario_resets')).toBe(true);
            });

            test('off the app window is written before it answers, and false when that write throws', async () => {
                delete g.Capacitor;
                fs.existsSync.mockReturnValue(false);
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                const file = createJsonStore({ fileName: 'scenarioResets.json', prefKey: 'gs_scenario_resets' });
                await expect(file.updateThrough((current) => `${current}!`)).resolves.toBe(true);
                expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('scenarioResets.json'), 'null!', {
                    encoding: 'utf8',
                    mode: 0o600,
                });
                fs.writeFileSync.mockImplementationOnce(() => {
                    throw new Error('EACCES');
                });
                await expect(file.updateThrough(() => '{}')).resolves.toBe(false);
            });
        });

        describe('what a refresh reads while a write is queued', () => {
            const deferredGet = () => {
                let answer!: (value: GetResult) => void;
                mockPrefGet.mockImplementationOnce(
                    () =>
                        new Promise<GetResult>((resolve) => {
                            answer = resolve;
                        }),
                );
                return (value: string | null) => answer({ value });
            };
            const strictStore = () => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                return createJsonStore({ fileName: 'scenarioState.json', prefKey: 'gs_scenario_state', strict: true });
            };
            const inFlight = () => new Promise((resolve) => setTimeout(resolve, 0));

            test('does not take the write’s value out of the cache: the read may predate it', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                const answer = deferredGet();
                const refreshed = strict.refreshAsync();
                await inFlight();
                strict.writeRaw('{"w":1}');
                answer('{"stale":1}');
                await refreshed;
                expect(strict.readRaw()).toBe('{"w":1}');
            });

            test('does not take it out either when the write was one that had to be saved first', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                const answer = deferredGet();
                const refreshed = strict.refreshAsync();
                await inFlight();
                await strict.updateThrough(() => '{"w":1}');
                answer('{"stale":1}');
                await refreshed;
                expect(strict.readRaw()).toBe('{"w":1}');
            });

            test('leaves a write that was not saved out of the cache, whatever the read says', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                const answer = deferredGet();
                const refreshed = strict.refreshAsync();
                await inFlight();
                mockPrefSet.mockRejectedValueOnce(new Error('disk full'));
                await expect(strict.updateThrough(() => '{"w":1}')).resolves.toBe(false);
                answer('{"persisted":true}');
                await refreshed;
                expect(strict.readRaw()).toBe('{"persisted":true}');
            });

            test('takes what it read when nothing was written meanwhile', async () => {
                const strict = strictStore();
                await strict.initializeAsync();
                const answer = deferredGet();
                const refreshed = strict.refreshAsync();
                await inFlight();
                answer('{"fresh":1}');
                await refreshed;
                expect(strict.readRaw()).toBe('{"fresh":1}');
            });
        });

        describe('whether the cache holds something known', () => {
            const known = () =>
                (require('../../src/ts/settings/storeTransport') as typeof storeTransportModule).isCacheKnown(
                    'gs_scenario_state',
                );
            const strictStore = () => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                return createJsonStore({ fileName: 'scenarioState.json', prefKey: 'gs_scenario_state', strict: true });
            };

            test('it does not after a read that failed, and does once a refresh or a write has filled it', async () => {
                const strict = strictStore();
                expect(known()).toBe(false);
                mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
                await strict.initializeAsync();
                expect(known()).toBe(false);
                await strict.refreshAsync();
                expect(known()).toBe(true);
                const another = strictStore();
                mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
                await another.initializeAsync();
                expect(known()).toBe(false);
                another.writeRaw('{"x":1}');
                expect(known()).toBe(true);
            });
        });

        test('writes are serialized in issue order', async () => {
            const persisted: string[] = [];
            let releaseFirst: ((value: void) => void) | undefined;
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            mockPrefSet.mockImplementationOnce((arg) => {
                persisted.push(arg.value);
                return firstGate;
            });
            mockPrefSet.mockImplementation((arg) => {
                persisted.push(arg.value);
                return Promise.resolve();
            });

            store.writeRaw('A');
            store.writeRaw('B');
            await Promise.resolve();
            expect(persisted).toEqual(['A']);

            releaseFirst!();
            await store.flushPendingWrites();
            expect(persisted).toEqual(['A', 'B']);
        });

        test("refreshAsync re-reads Preferences after this context's queued writes drain", async () => {
            let release: ((value: void) => void) | undefined;
            mockPrefSet.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            store.writeRaw('{"mine":1}');
            mockPrefGet.mockResolvedValue({ value: '{"background":2}' });
            const refreshed = store.refreshAsync();
            await Promise.resolve();
            expect(mockPrefGet).not.toHaveBeenCalled();
            release!();
            await refreshed;
            expect(mockPrefGet).toHaveBeenCalledWith({ key: 'gurushots-metadata' });
            expect(store.readRaw()).toBe('{"background":2}');
        });

        test('a failed refresh keeps the cache', async () => {
            store.writeRaw('{"kept":1}');
            mockPrefGet.mockRejectedValueOnce(new Error('bridge down'));
            await expect(store.refreshAsync()).resolves.toBeUndefined();
            expect(store.readRaw()).toBe('{"kept":1}');
        });

        test('a failed Preferences write is absorbed and the cache keeps the latest value', async () => {
            mockPrefSet.mockRejectedValueOnce(new Error('quota'));
            store.writeRaw('{"y":2}');
            await expect(store.flushPendingWrites()).resolves.toBeUndefined();
            expect(store.readRaw()).toBe('{"y":2}');
        });
    });

    describe('headless service (memory-only)', () => {
        let store: ReturnType<typeof storageModule.createJsonStore>;

        beforeEach(() => {
            g.__GS_HEADLESS__ = true;
            const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
            store = createJsonStore({ fileName: 'metadata.json', prefKey: 'gurushots-metadata' });
        });

        test('round-trips in memory without touching fs or Preferences', async () => {
            expect(store.readRaw()).toBeNull();
            store.writeRaw('{"m":1}');
            expect(store.readRaw()).toBe('{"m":1}');
            await store.initializeAsync();
            await store.refreshAsync();
            expect(mockPrefGet).not.toHaveBeenCalled();
            expect(mockPrefSet).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });

        describe('through the native bridge', () => {
            const bridge = (writeKey: (key: string, data: string) => boolean | void) => {
                const native = { read: () => null, write: jest.fn(), readKey: () => null, writeKey: jest.fn(writeKey) };
                (globalThis as typeof globalThis & { AndroidHeadlessStore?: unknown }).AndroidHeadlessStore = native;
                return native;
            };
            afterEach(() => {
                delete (globalThis as typeof globalThis & { AndroidHeadlessStore?: unknown }).AndroidHeadlessStore;
            });
            const strictStore = () => {
                const { createJsonStore } = require('../../src/ts/settings/storage') as typeof storageModule;
                return createJsonStore({ fileName: 'scenarioState.json', prefKey: 'gs_scenario_state', strict: true });
            };

            test('a write the bridge answers true for passes, strict or not', () => {
                const native = bridge(() => true);
                expect(() => strictStore().writeRaw('{"a":1}')).not.toThrow();
                expect(() => store.writeRaw('{"a":1}')).not.toThrow();
                expect(native.writeKey).toHaveBeenCalledTimes(2);
            });

            test('no answer is a write that passes for the others, and one that was not persisted for a strict store', () => {
                bridge(() => undefined);
                expect(() => store.writeRaw('{"a":1}')).not.toThrow();
                expect(() => strictStore().writeRaw('{"a":1}')).toThrow('was not persisted');
                // Nor with no bridge at all.
                delete (globalThis as typeof globalThis & { AndroidHeadlessStore?: unknown }).AndroidHeadlessStore;
                expect(() => strictStore().writeRaw('{"a":1}')).toThrow('was not persisted');
            });

            test('what a write that was not persisted tried to say is never read back', () => {
                bridge(() => false);
                const strict = strictStore();
                expect(() => strict.writeRaw('{"a":1}')).toThrow();
                expect(strict.readRaw()).toBeNull();
                bridge(() => true);
                strict.writeRaw('{"a":2}');
                expect(strict.readRaw()).toBe('{"a":2}');
            });

            test('a write the bridge says it did not persist fails a strict store, and passes quietly for the others', () => {
                bridge(() => false);
                expect(() => strictStore().writeRaw('{"a":1}')).toThrow('Headless gs_scenario_state was not persisted');
                expect(() => store.writeRaw('{"a":1}')).not.toThrow();
            });

            test('a bridge that throws is a write that was not persisted too', () => {
                bridge(() => {
                    throw new Error('bridge down');
                });
                expect(() => strictStore().writeRaw('{"a":1}')).toThrow('was not persisted');
                expect(() => store.writeRaw('{"a":1}')).not.toThrow();
            });
        });
    });
});
