/**
 * Tests for scripts/afterPack.mts — the electron-builder afterPack hook that
 * flips Electron fuses. @electron/fuses is mocked so no binary is touched.
 */

// tests/setup.ts globally mocks fs and path; this suite needs the real modules.
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
        EnableEmbeddedAsarIntegrityValidation: 4,
        OnlyLoadAppFromAsar: 5,
    },
}));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import type * as fusesModule from '@electron/fuses';
import type afterPackHook from '../../scripts/afterPack.mts';
import type { AfterPackContext } from 'electron-builder';
import { invalid } from '../helpers/invalid';
const { flipFuses, FuseV1Options } = jest.mocked(require('@electron/fuses') as typeof fusesModule);
const afterPack = (require('../../scripts/afterPack') as { default: typeof afterPackHook }).default;

// A partial context: only the fields afterPack reads.
const makeContext = (electronPlatformName: string, extra: { appOutDir?: string; arch?: number } = {}) =>
    invalid<AfterPackContext>({
        appOutDir: '/out',
        electronPlatformName,
        packager: { appInfo: { productFilename: 'GuruShotsAutoVote' }, executableName: 'gurushots-auto-vote' },
        ...extra,
    });

describe('afterPack', () => {
    let logSpy: jest.SpiedFunction<typeof console.log>;

    beforeEach(() => {
        flipFuses.mockClear();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    // electron-builder writes this entry into the packed app's Info.plist before afterPack runs.
    const INTEGRITY_PLIST =
        '<dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>hash</key><string>x</string></dict></dict></dict>';
    const makeMacApp = (plist: string) => {
        const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-mac-'));
        fs.mkdirSync(path.join(appOutDir, 'GuruShotsAutoVote.app', 'Contents'), { recursive: true });
        fs.writeFileSync(path.join(appOutDir, 'GuruShotsAutoVote.app', 'Contents', 'Info.plist'), plist);
        return appOutDir;
    };

    test.each([
        ['darwin', ['GuruShotsAutoVote.app', 'Contents', 'MacOS', 'GuruShotsAutoVote'], true, true],
        ['mas', ['GuruShotsAutoVote.app', 'Contents', 'MacOS', 'GuruShotsAutoVote'], true, true],
        ['win32', ['GuruShotsAutoVote.exe'], false, true],
        ['linux', ['gurushots-auto-vote'], false, false],
    ])('flips fuses on the %s binary', async (platform, binarySegments, isMac, integrityFuse) => {
        const appOutDir = isMac ? makeMacApp(INTEGRITY_PLIST) : '/out';
        try {
            await afterPack(makeContext(platform, { appOutDir }));
            const expectedBinary = path.join(appOutDir, ...binarySegments);
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
                [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrityFuse,
            });
            expect(logSpy).toHaveBeenCalledWith(
                `[afterPack] Hardened Electron fuses for ${platform}: ${expectedBinary}`,
            );
        } finally {
            if (isMac) fs.rmSync(appOutDir, { recursive: true, force: true });
        }
    });

    test.each([
        ['has no ElectronAsarIntegrity key', '<dict><key>CFBundleName</key></dict>'],
        ['lists no Resources/app.asar hash', '<dict><key>ElectronAsarIntegrity</key><dict/></dict>'],
    ])('fails the macOS build when Info.plist %s', async (_label, plist) => {
        const appOutDir = makeMacApp(plist);
        try {
            await expect(afterPack(makeContext('darwin', { appOutDir }))).rejects.toThrow(
                /no ElectronAsarIntegrity entry for Resources\/app\.asar/,
            );
            expect(flipFuses).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(appOutDir, { recursive: true, force: true });
        }
    });

    test.each([
        ['darwin', 3, ['GuruShotsAutoVote.app', 'Contents', 'Resources'], 'darwin', ['arm64']],
        ['mas', 4, ['GuruShotsAutoVote.app', 'Contents', 'Resources'], 'darwin', ['arm64', 'x64']],
        ['win32', 1, ['resources'], 'win32', ['x64']],
        ['linux', 3, ['resources'], 'linux', ['arm64']],
    ])('keeps only the %s (arch %i) onnxruntime binaries', async (platform, arch, resourcesPath, keptOs, keptArchs) => {
        const appOutDir = ['darwin', 'mas'].includes(platform)
            ? makeMacApp(INTEGRITY_PLIST)
            : fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
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
            await afterPack(makeContext(platform, { appOutDir, arch }));
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
