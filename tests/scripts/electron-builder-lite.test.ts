/**
 * Tests for scripts/electron-builder-lite.ts — the lite desktop build config.
 */

import type * as package_jsonModule from '../../package.json';

const { build } = require('../../package.json') as typeof package_jsonModule;
const lite = (require('../../scripts/electron-builder-lite') as typeof import('../../scripts/electron-builder-lite'))
    .default;

describe('scripts/electron-builder-lite.ts', () => {
    test('keeps the full build config apart from what the lite build changes', () => {
        const changed = ['files', 'extraResources', 'asarUnpack', 'directories', 'mac', 'win', 'linux', 'publish'];
        const without = (config: object) =>
            Object.fromEntries(Object.entries(config).filter(([key]) => !changed.includes(key)));
        expect(without(lite)).toEqual(without(build));
        expect(lite.directories).toEqual({ ...build.directories, output: 'build/lite' });
    });

    test('leaves the vision model and its runtime packages out', () => {
        expect(lite.extraResources).toEqual([]);
        expect(lite.asarUnpack).toEqual([]);
        expect(lite.files).toEqual(expect.arrayContaining(build.files));
        for (const name of [
            '@huggingface',
            'onnxruntime-node',
            'onnxruntime-web',
            'onnxruntime-common',
            'sharp',
            '@img',
        ]) {
            expect(lite.files).toContain(`!**/node_modules/${name}\${/*}`);
        }
    });

    test('names every artifact "-lite" and publishes on the lite update channel', () => {
        expect(lite.mac.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}-lite.${ext}');
        expect(lite.win.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}-lite.exe');
        expect(lite.linux.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}-lite.AppImage');
        expect(lite.mac.target).toEqual(build.mac.target);
        expect(lite.publish).toEqual({ ...build.publish, channel: 'lite' });
    });

    test('both builds ship src/assets, which holds the third-party notices, inside the asar', () => {
        const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
        const path = jest.requireActual<typeof import('node:path')>('node:path');
        expect(fs.existsSync(path.join(__dirname, '..', '..', 'src', 'assets', 'THIRD_PARTY_NOTICES.txt'))).toBe(true);
        for (const config of [build, lite]) {
            expect(config.files).toContain('src/assets/**/*');
            expect(config.files.filter((pattern) => pattern.startsWith('!') && pattern.includes('assets'))).toEqual([]);
        }
    });

    test('uses the project app id', () => {
        expect(build.appId).toBe('com.isthisgitlab.gurushotsautovote');
        expect(lite.appId).toBe(build.appId);
        expect(build.productName).toBe('GuruShotsAutoVote');
    });
});
