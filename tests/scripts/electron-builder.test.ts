/**
 * Tests for scripts/electron-builder.ts — package.json's `build` block plus the "-dirty" marker of a local build.
 */

import type * as package_jsonModule from '../../package.json';

const { build, version } = require('../../package.json') as typeof package_jsonModule;

// The config reads GITHUB_ACTIONS once, when it loads, so each case loads a fresh copy under its own value.
const configFor = (githubActions: string | undefined) => {
    const saved = process.env.GITHUB_ACTIONS;
    if (githubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = githubActions;
    try {
        let config!: (typeof import('../../scripts/electron-builder'))['default'];
        jest.isolateModules(() => {
            config = (require('../../scripts/electron-builder') as typeof import('../../scripts/electron-builder'))
                .default;
        });
        return config;
    } finally {
        if (saved === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = saved;
    }
};

describe('scripts/electron-builder.ts', () => {
    describe('outside GitHub Actions (a local build)', () => {
        const local = configFor(undefined);

        test('puts "-dirty" after the version in every installer name', () => {
            expect(local.mac.artifactName).toBe('GuruShotsAutoVote-v${version}-dirty-${arch}.${ext}');
            expect(local.win.artifactName).toBe('GuruShotsAutoVote-v${version}-dirty-${arch}.exe');
            expect(local.linux.artifactName).toBe('GuruShotsAutoVote-v${version}-dirty-${arch}.AppImage');
        });

        test('shows "-dirty" as the macOS display version and leaves the build number alone', () => {
            expect(local.mac.bundleShortVersion).toBe(`${version}-dirty`);
            expect(local.mac).not.toHaveProperty('bundleVersion');
        });

        test('changes nothing else in package.json build', () => {
            // toEqual treats an undefined property as absent.
            expect({
                ...local,
                mac: { ...local.mac, artifactName: build.mac.artifactName, bundleShortVersion: undefined },
                win: { ...local.win, artifactName: build.win.artifactName },
                linux: { ...local.linux, artifactName: build.linux.artifactName },
            }).toEqual(build);
        });
    });

    describe('on GitHub Actions (a release build)', () => {
        const release = configFor('true');

        test('equals package.json build exactly', () => {
            expect(release).toEqual(build);
            expect(release.mac.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}.${ext}');
            expect(release.win.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}.exe');
            expect(release.linux.artifactName).toBe('GuruShotsAutoVote-v${version}-${arch}.AppImage');
        });

        test('sets no macOS display version or build number', () => {
            expect(release.mac).not.toHaveProperty('bundleShortVersion');
            expect(release.mac).not.toHaveProperty('bundleVersion');
        });
    });
});
