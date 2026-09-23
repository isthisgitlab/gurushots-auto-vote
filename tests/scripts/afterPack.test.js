/**
 * Tests for scripts/afterPack.js — the electron-builder afterPack hook that
 * flips Electron fuses. @electron/fuses is mocked so no binary is touched.
 */

// tests/setup.js globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

jest.mock('@electron/fuses', () => ({
    flipFuses: jest.fn(() => Promise.resolve()),
    FuseVersion: { V1: 'v1' },
    FuseV1Options: {
        RunAsNode: 0,
        EnableCookieEncryption: 1,
        EnableNodeOptionsEnvironmentVariable: 2,
        EnableNodeCliInspectArguments: 3,
        OnlyLoadAppFromAsar: 5,
    },
}));

const path = require('path');
const { flipFuses, FuseV1Options } = require('@electron/fuses');
const afterPack = require('../../scripts/afterPack').default;

const makeContext = (electronPlatformName) => ({
    appOutDir: '/out',
    electronPlatformName,
    packager: { appInfo: { productFilename: 'GuruShotsAutoVote' }, executableName: 'gurushots-auto-vote' },
});

describe('afterPack', () => {
    let logSpy;

    beforeEach(() => {
        flipFuses.mockClear();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    test.each([
        ['darwin', path.join('/out', 'GuruShotsAutoVote.app', 'Contents', 'MacOS', 'GuruShotsAutoVote'), true],
        ['mas', path.join('/out', 'GuruShotsAutoVote.app', 'Contents', 'MacOS', 'GuruShotsAutoVote'), true],
        ['win32', path.join('/out', 'GuruShotsAutoVote.exe'), false],
        ['linux', path.join('/out', 'gurushots-auto-vote'), false],
    ])('flips fuses on the %s binary', async (platform, expectedBinary, isMac) => {
        await afterPack(makeContext(platform));
        expect(flipFuses).toHaveBeenCalledTimes(1);
        const [binary, config] = flipFuses.mock.calls[0];
        expect(binary).toBe(expectedBinary);
        expect(config).toEqual({
            version: 'v1',
            resetAdHocDarwinSignature: isMac,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        });
        expect(logSpy).toHaveBeenCalledWith(`[afterPack] Hardened Electron fuses for ${platform}: ${expectedBinary}`);
    });

    test('propagates a flipFuses failure so the build fails', async () => {
        flipFuses.mockRejectedValueOnce(new Error('boom'));
        await expect(afterPack(makeContext('linux'))).rejects.toThrow('boom');
    });
});
