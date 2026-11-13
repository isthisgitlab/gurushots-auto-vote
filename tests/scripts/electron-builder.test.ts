/**
 * Tests for scripts/electron-builder.ts — package.json's `build` block plus the "-dirty" marker of a local build.
 */

jest.unmock('fs');
jest.unmock('node:fs');

import type * as package_jsonModule from '../../package.json';

interface FileMatcherInstance {
    createFilter(): (file: string, stat: { isDirectory(): boolean }) => boolean;
}

interface FileMatcherConstructor {
    new (from: string, to: string, macroExpander: (pattern: string) => string, patterns: string[]): FileMatcherInstance;
}

const electronBuilderPath = require.resolve('electron-builder');
const { FileMatcher } = require(
    require.resolve('app-builder-lib/out/fileMatcher.js', { paths: [electronBuilderPath] }),
) as { FileMatcher: FileMatcherConstructor };

const { build, version } = require('../../package.json') as typeof package_jsonModule;
const packagedFiles = [
    ...build.files.filter((pattern) => pattern !== 'dist/**/*'),
    {
        from: 'out/assembly/full',
        to: 'dist',
        filter: ['**/*', '!vision-model${/*}', '!ort-wasm-simd-threaded.*'],
    },
];

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
                files: build.files,
                mac: { ...local.mac, artifactName: build.mac.artifactName, bundleShortVersion: undefined },
                win: { ...local.win, artifactName: build.win.artifactName },
                linux: { ...local.linux, artifactName: build.linux.artifactName },
            }).toEqual(build);
            expect(local.files).toEqual(packagedFiles);
        });

        test('uses the real electron-builder FileSet matcher to retain renderer files but omit browser vision assets', () => {
            const assembly = packagedFiles.find(
                (entry): entry is { from: string; to: string; filter: string[] } => typeof entry !== 'string',
            );
            if (!assembly) throw new Error('full assembly FileSet is missing');
            const from = '/tmp/out/assembly/full';
            const filter = new FileMatcher(
                from,
                '/tmp/package/dist',
                (pattern) => pattern.replace('${/*}', '/**/*'),
                assembly.filter,
            ).createFilter();
            const file = (relative: string) => filter(`${from}/${relative}`, { isDirectory: () => false });

            expect(file('app-bundle.js')).toBe(true);
            expect(file('vision-model/vision.onnx')).toBe(false);
            expect(file('ort-wasm-simd-threaded.wasm')).toBe(false);
        });
    });

    describe('on GitHub Actions (a release build)', () => {
        const release = configFor('true');

        test('keeps package metadata aligned with package.json while using the isolated assembly mapping', () => {
            expect({ ...release, files: build.files }).toEqual(build);
            expect(release.files).toEqual(packagedFiles);
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
