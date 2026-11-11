/**
 * electron-builder config for the full desktop build (`build`, `build:<os>`): package.json's `build` block, with
 * the "-dirty" marker a build made outside GitHub Actions carries (core/buildInfo.ts) added to what electron-builder
 * takes from package.json's version: the installer names and, on macOS, the display version in Info.plist
 * (CFBundleShortVersionString, which the About panel and Finder "Get Info" show).
 *
 * The suffix is display only. package.json `version` and `app.getVersion()` stay clean, because electron-updater
 * compares `app.getVersion()` to the GitHub release; `x.y.z-dirty` would sort below `x.y.z` as a prerelease. The
 * build number (CFBundleVersion, `mac.bundleVersion`) is never set, so it stays numeric. The Windows file and
 * product versions must be numeric too, so only the installer name carries the suffix there. The AppImage's embedded
 * X-AppImage-Version also stays clean; only its file name changes.
 *
 * The condition is the one scripts/build-main.ts bakes in. A name without "-dirty" does not prove that GitHub built
 * it, because anyone can set GITHUB_ACTIONS; real provenance comes from the CI build attestation. The variable is
 * read once, when this file loads.
 */

import packageJson from '../package.json';
const { build, version } = packageJson;

const dirty = !process.env.GITHUB_ACTIONS;

// "…-v${version}-${arch}.${ext}" → "…-v${version}-dirty-${arch}.${ext}" (electron-builder fills the macro in).
const dirtyArtifact = (artifactName: string) =>
    dirty ? artifactName.replace(`\${version}`, `\${version}-dirty`) : artifactName;

// Package metadata stays aligned with package.json; this maps the isolated full assembly to the established dist path.
export default {
    ...build,
    files: [
        ...build.files.filter((pattern) => pattern !== 'dist/**/*'),
        {
            from: 'out/assembly/full',
            to: 'dist',
            filter: ['**/*', '!vision-model${/*}', '!ort-wasm-simd-threaded.*'],
        },
    ],
    mac: {
        ...build.mac,
        artifactName: dirtyArtifact(build.mac.artifactName),
        ...(dirty && { bundleShortVersion: `${version}-dirty` }),
    },
    win: { ...build.win, artifactName: dirtyArtifact(build.win.artifactName) },
    linux: { ...build.linux, artifactName: dirtyArtifact(build.linux.artifactName) },
};
