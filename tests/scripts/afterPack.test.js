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

const fs = require('fs');
const os = require('os');
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

    test.each([
        ['darwin', 3, ['GuruShotsAutoVote.app', 'Contents', 'Resources'], 'darwin', ['arm64']],
        ['mas', 4, ['GuruShotsAutoVote.app', 'Contents', 'Resources'], 'darwin', ['arm64', 'x64']],
        ['win32', 1, ['resources'], 'win32', ['x64']],
        ['linux', 3, ['resources'], 'linux', ['arm64']],
    ])('keeps only the %s (arch %i) onnxruntime binaries', async (platform, arch, resourcesPath, keptOs, keptArchs) => {
        const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
        try {
            const bin = path.join(
                appOutDir,
                ...resourcesPath,
                'app.asar.unpacked',
                'node_modules',
                'onnxruntime-node',
                'bin',
                'napi-v6',
            );
            for (const target of ['darwin/arm64', 'darwin/x64', 'linux/x64', 'linux/arm64', 'win32/x64']) {
                fs.mkdirSync(path.join(bin, target), { recursive: true });
                fs.writeFileSync(path.join(bin, target, 'onnxruntime_binding.node'), 'x');
            }
            await afterPack({ ...makeContext(platform), appOutDir, arch });
            expect(fs.readdirSync(bin)).toEqual([keptOs]);
            expect(fs.readdirSync(path.join(bin, keptOs)).sort()).toEqual(keptArchs);
        } finally {
            fs.rmSync(appOutDir, { recursive: true, force: true });
        }
    });

    test('propagates a flipFuses failure so the build fails', async () => {
        flipFuses.mockRejectedValueOnce(new Error('boom'));
        await expect(afterPack(makeContext('linux'))).rejects.toThrow('boom');
    });
});
