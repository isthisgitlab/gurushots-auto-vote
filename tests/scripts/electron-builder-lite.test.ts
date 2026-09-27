/**
 * Tests for scripts/electron-builder-lite.ts — the lite desktop build config.
 */

import type * as package_jsonModule from '../../package.json';

const { build }: typeof package_jsonModule = require('../../package.json');
const lite = require('../../scripts/electron-builder-lite').default;

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
});
