/**
 * Tests for scripts/build-notices.ts — the third-party notices generator.
 *
 * The committed src/assets/THIRD_PARTY_NOTICES.txt must equal what the
 * generator writes from pnpm-lock.yaml and the vendored license data (like the
 * lexicon asset check), the data must cover every shipped package, and the
 * curated Android list must match the Gradle declarations. Parser and error
 * paths run against small fixtures in os.tmpdir().
 */

// tests/setup.ts globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

import { execFileSync, spawnSync } from 'node:child_process';
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import type * as buildNoticesModule from '../../scripts/build-notices';
import type * as fetchVisionModelModule from '../../scripts/fetch-vision-model';
import { invalid } from '../helpers/invalid';
import { isArrayOf, isRecordOf, isShape, isString, parseJsonAs } from '../helpers/parseJson';

const isPackageJson = isShape<{ devDependencies: Record<string, string> }>({
    devDependencies: isRecordOf(isString),
});

const {
    BUNDLED_DEV_DEPENDENCIES,
    NODE_LICENSE_VERSION,
    ONNXRUNTIME_TEXTS_VERSION,
    collectPackages,
    coordinateMatches,
    loadAndroidComponents,
    loadNoticeFiles,
    loadLicenses,
    lookupLicense,
    main,
    parseGradleVariables,
    parseLockfile,
    renderNotices,
} = require('../../scripts/build-notices') as typeof buildNoticesModule;
const { REPOS } = require('../../scripts/fetch-vision-model') as typeof fetchVisionModelModule;

const ROOT = path.join(__dirname, '..', '..');
const COMMITTED = path.join(ROOT, 'src', 'assets', 'THIRD_PARTY_NOTICES.txt');
const LICENSES_DIR = path.join(ROOT, 'scripts', 'licenses');
const read = (...segments: string[]) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

/**
 * The problems with the release each vendored NOTICE was taken from: no android.json component covers the coordinate;
 * a covering component's version variable is undefined in android/variables.gradle or differs from the vendored
 * version; or the vendored version is not the one the release ships (`shipped`, from
 * android/release-runtime-versions.txt), whether or not a covering component has a version variable. Every covering
 * component is checked, not only the first, because the generator renders a vendored NOTICE under each component that
 * covers its coordinate. A coordinate the release does not ship has nothing to compare against here; the test for the
 * shipped artifacts reports it.
 */
const mismatchedNoticeVersions = (
    vendored: Record<string, { version: string }>,
    components: readonly { coordinates: string[]; versionVariable?: string }[],
    variables: Record<string, string>,
    shipped: Record<string, string>,
) => {
    const problems: string[] = [];
    for (const [coordinate, { version }] of Object.entries(vendored)) {
        const covering = components.filter((candidate) =>
            candidate.coordinates.some((pattern) => coordinateMatches(pattern, coordinate)),
        );
        if (covering.length === 0) problems.push(`no component covers ${coordinate}`);
        for (const component of covering) {
            if (!component.versionVariable) continue;
            const built = variables[component.versionVariable];
            if (version !== built) problems.push(`${coordinate} is vendored at ${version} but the build uses ${built}`);
        }
        if (covering.length > 0 && shipped[coordinate] && shipped[coordinate] !== version) {
            problems.push(`${coordinate} is vendored at ${version} but the release ships ${shipped[coordinate]}`);
        }
    }
    return problems;
};

/**
 * The problems with a release runtime version list (`group:artifact:version` lines) held against the artifact list:
 * a malformed line, a module listed more than once (at one version or two), a module that is not an artifact, or an
 * artifact without a version.
 */
const versionListProblems = (lines: readonly string[], artifacts: readonly string[]) => {
    const problems = lines
        .filter((line) => !/^[\w.-]+:[\w.-]+:[\w.+-]+$/.test(line))
        .map((line) => `malformed ${line}`);
    const modules = lines.map((line) => line.split(':').slice(0, 2).join(':'));
    for (const module of new Set(modules)) {
        const versions = lines.filter((line) => line.startsWith(`${module}:`));
        if (versions.length > 1) problems.push(`${module} is listed ${versions.length} times: ${versions.join(', ')}`);
        if (!artifacts.includes(module)) problems.push(`${module} is not a shipped artifact`);
    }
    for (const artifact of artifacts) if (!modules.includes(artifact)) problems.push(`${artifact} has no version`);
    return problems;
};

describe('the committed notices', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-notices-'));
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const generate = () => {
        const outPath = path.join(directory, 'THIRD_PARTY_NOTICES.txt');
        main({ outPath });
        return fs.readFileSync(outPath, 'utf8');
    };

    test('are up to date with pnpm-lock.yaml and the vendored license data (run `pnpm build:notices`)', () => {
        expect(generate()).toBe(fs.readFileSync(COMMITTED, 'utf8'));
    });

    test('are written to src/assets/THIRD_PARTY_NOTICES.txt by default', () => {
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        main();
        expect(writeSpy).toHaveBeenCalledWith(COMMITTED, fs.readFileSync(COMMITTED, 'utf8'));
    });

    test('are generated without reading anything installed in node_modules', () => {
        const readSpy = jest.spyOn(fs, 'readFileSync');
        generate();
        expect(
            readSpy.mock.calls.map((call) => String(call[0])).filter((file) => file.includes('node_modules')),
        ).toEqual([]);
    });

    describe('content', () => {
        const notices = () => fs.readFileSync(COMMITTED, 'utf8');
        const lock = () => parseLockfile(read('pnpm-lock.yaml'));

        test('list every platform variant of sharp and sharp-libvips, with the LGPL notice and source', () => {
            const text = notices();
            const variants = collectPackages(lock()).filter(({ name }) => name.startsWith('@img/sharp-'));
            expect(variants.length).toBeGreaterThanOrEqual(20);
            for (const { name, version } of variants) expect(text).toContain(`${name} ${version}\n`);
            const libvips = variants.filter(({ name }) => name.startsWith('@img/sharp-libvips-'));
            expect(libvips.map(({ name }) => name)).toEqual(
                expect.arrayContaining(['@img/sharp-libvips-darwin-arm64', '@img/sharp-libvips-linux-x64']),
            );
            for (const { name, version } of libvips) {
                expect(text).toContain(
                    `${name} ${version}\n  License: LGPL-3.0-or-later\n` +
                        `  Copyright Lovell Fuller and contributors\n`,
                );
                expect(text).toContain(`Source: https://github.com/lovell/sharp-libvips/tree/v${version}`);
            }
            expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
            expect(text).toContain('GNU GENERAL PUBLIC LICENSE');
        });

        test('carry the project license, Node.js, ONNX Runtime, the SigLIP model and GloVe', () => {
            const text = notices();
            expect(text).toContain(read('LICENSE').trimEnd());
            expect(text).toContain(`LICENSE of Node.js v${NODE_LICENSE_VERSION}`);
            expect(text).toContain('Node.js is licensed for use as follows');
            expect(text).toContain('======== ONNX Runtime LICENSE ========');
            expect(text).toContain('======== ONNX Runtime ThirdPartyNotices ========');
            expect(text).toContain(`ONNX Runtime ${ONNXRUNTIME_TEXTS_VERSION} follow`);
            expect(text).toContain(
                `${REPOS.model.split('/').slice(0, 2).join('/')}, revision ${REPOS.model.split('/')[2]}`,
            );
            expect(text).toContain(
                `${REPOS.tokenizer.split('/').slice(0, 2).join('/')}, revision ${REPOS.tokenizer.split('/')[2]}`,
            );
            expect(text).toContain('modified derivative of the original');
            expect(text).toContain('GloVe 6B');
            expect(text).toContain('Open Data Commons Public Domain Dedication & License (PDDL)');
        });

        test('leave out the app logo', () => {
            expect(notices()).not.toMatch(/logo\.png|app logo/i);
        });

        test('vendor the Node.js LICENSE of the major in .nvmrc', () => {
            expect(NODE_LICENSE_VERSION.split('.')[0]).toBe(read('.nvmrc').trim());
        });

        test('vendor the ONNX Runtime texts of the locked onnxruntime-node', () => {
            expect(collectPackages(lock()).find(({ name }) => name === 'onnxruntime-node')?.version).toBe(
                ONNXRUNTIME_TEXTS_VERSION,
            );
        });

        test('cover every package of the lockfile and keep no entry for a package that is gone', () => {
            const licenses = loadLicenses(path.join(LICENSES_DIR, 'packages.json'));
            const names = collectPackages(lock()).map(({ name }) => name);
            for (const name of names) expect(() => lookupLicense(licenses, name)).not.toThrow();
            const unused = Object.keys(licenses).filter(
                (key) => !names.some((name) => (key.endsWith('*') ? name.startsWith(key.slice(0, -1)) : name === key)),
            );
            expect(unused).toEqual([]);
        });

        test('have a vendored text for every license id the data names', () => {
            const licenses = loadLicenses(path.join(LICENSES_DIR, 'packages.json'));
            const ids = new Set(Object.values(licenses).flatMap((entry) => entry.texts));
            for (const id of ids) {
                expect(fs.existsSync(path.join(LICENSES_DIR, 'texts', `${id}.txt`))).toBe(true);
            }
        });

        test('add the bundled build-time packages the renderer compiles in', () => {
            const devDependencies = parseJsonAs(read('package.json'), isPackageJson).devDependencies;
            for (const name of BUNDLED_DEV_DEPENDENCIES) expect(devDependencies).toHaveProperty(name);
            const css = read('src', 'styles', 'styles.css');
            expect(css).toContain("@import 'tailwindcss'");
            expect(css).toContain('@plugin "daisyui"');
            expect(BUNDLED_DEV_DEPENDENCIES).toEqual(['daisyui', 'tailwindcss']);
        });

        test('account for every devDependency imported from shipped code', () => {
            const devDependencies = Object.keys(parseJsonAs(read('package.json'), isPackageJson).devDependencies);
            const imported = new Set<string>();
            const walk = (dir: string) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(entryPath);
                    else if (/\.tsx?$/.test(entry.name)) {
                        const source = fs.readFileSync(entryPath, 'utf8');
                        for (const match of source.matchAll(
                            /^\s*(?:import|export)\b[^'"\n]*from\s+'([^'./][^']*)'/gm,
                        )) {
                            const specifier = match[1];
                            imported.add(
                                specifier.startsWith('@')
                                    ? specifier.split('/').slice(0, 2).join('/')
                                    : specifier.split('/')[0],
                            );
                        }
                    }
                }
            };
            walk(path.join(ROOT, 'src', 'ts'));
            // electron is the desktop shell itself (section 2 of the notices), not a bundled package.
            const unaccounted = devDependencies.filter(
                (name) => imported.has(name) && !BUNDLED_DEV_DEPENDENCIES.includes(name) && name !== 'electron',
            );
            expect(unaccounted).toEqual([]);
        });
    });
});

describe('the Android component list', () => {
    const components = loadAndroidComponents(path.join(LICENSES_DIR, 'android.json'));
    const covers = (coordinate: string) =>
        components.some((component) => component.coordinates.some((pattern) => coordinateMatches(pattern, coordinate)));

    const appGradle = read('android', 'app', 'build.gradle');
    const declared = [...appGradle.matchAll(/^\s*implementation\s+"([^":]+):([^":]+):/gm)].map(
        ([, group, artifact]) => `${group}:${artifact}`,
    );
    const variables = parseGradleVariables(read('android', 'variables.gradle'));

    test('covers every library the app module declares', () => {
        expect(declared).toEqual(expect.arrayContaining(['com.squareup.okhttp3:okhttp']));
        expect(declared.filter((coordinate) => !covers(coordinate))).toEqual([]);
    });

    test('lists only libraries that are declared, or marked as pulled in by another one', () => {
        const unmatched = components.filter(
            (component) =>
                !component.transitive &&
                !component.coordinates.some((pattern) =>
                    declared.some((coordinate) => coordinateMatches(pattern, coordinate)),
                ),
        );
        expect(unmatched.map((component) => component.name)).toEqual([]);
    });

    test('names the variable of every versioned library that the Gradle build defines', () => {
        for (const component of components) {
            if (component.versionVariable) expect(variables).toHaveProperty(component.versionVariable);
        }
    });

    test('accounts for every version variable: shipped libraries, or test and coverage tooling only', () => {
        const testOnly = [
            'junitVersion',
            'robolectricVersion',
            'androidxTestCoreVersion',
            'mockkVersion',
            'jacocoVersion',
            'androidxJunitVersion',
            'androidxEspressoCoreVersion',
        ];
        const versioned = new Set(components.flatMap((component) => component.versionVariable ?? []));
        const shippedAndroidx = Object.keys(variables).filter(
            (name) => /^(androidx|coreSplashScreen)/.test(name) && !testOnly.includes(name),
        );
        expect(shippedAndroidx.length).toBeGreaterThan(0);
        expect(covers('androidx.core:core')).toBe(true);
        const unaccounted = Object.keys(variables).filter(
            (name) =>
                name.endsWith('Version') &&
                !/^(minSdk|compileSdk|targetSdk)/.test(name) &&
                !testOnly.includes(name) &&
                !shippedAndroidx.includes(name) &&
                !versioned.has(name),
        );
        expect(unaccounted).toEqual([]);
    });

    // What the release APK ships besides the Capacitor projects (npm packages, section 3), as group:artifact:
    // android/release-runtime-artifacts.txt, which scripts/android-verification-metadata.sh writes from
    // `./gradlew :app:dependencies --configuration releaseRuntimeClasspath`.
    const runtimeArtifacts = read('android', 'release-runtime-artifacts.txt').split('\n').filter(Boolean);
    const verified = [
        ...new Set(
            [
                ...read('android', 'gradle', 'verification-metadata.xml').matchAll(
                    /<component group="([^"]+)" name="([^"]+)"/g,
                ),
            ].map(([, group, artifact]) => `${group}:${artifact}`),
        ),
    ];

    test('has a release runtime list that is plausible: sorted, unique, and led by the declared libraries', () => {
        expect(runtimeArtifacts).toEqual([...new Set(runtimeArtifacts)].sort());
        expect(runtimeArtifacts.every((coordinate) => /^[\w.-]+:[\w.-]+$/.test(coordinate))).toBe(true);
        expect(runtimeArtifacts).toEqual(expect.arrayContaining(declared));
    });

    test('covers every artifact of the release runtime classpath, which the verification metadata lists', () => {
        expect(runtimeArtifacts.filter((coordinate) => !verified.includes(coordinate))).toEqual([]);
        expect(runtimeArtifacts.filter((coordinate) => !covers(coordinate))).toEqual([]);
    });

    test('lists no component that matches nothing the release APK ships', () => {
        const stale = components.filter(
            (component) =>
                !component.coordinates.some((pattern) =>
                    runtimeArtifacts.some((coordinate) => coordinateMatches(pattern, coordinate)),
                ),
        );
        expect(stale.map((component) => component.name)).toEqual([]);
    });

    // Anything else the verification metadata lists is the Android Gradle plugin and the build, lint, test and coverage
    // tooling it resolves, which never reaches the APK. The androidx.* component pattern matches some of that tooling
    // by its name; these exact artifacts are the only ones allowed to, each for the reason of its group. A new one has
    // to be listed here (or the component list narrowed), and one that is gone has to be dropped.
    const TOOLING_UNDER_ANDROIDX = [
        // AGP's data binding compiler, resolved by the build only.
        'androidx.databinding:databinding-common',
        'androidx.databinding:databinding-compiler-common',
        // The instrumentation and JVM test libraries (Espresso, the test runner, AndroidX Test core and its monitor).
        'androidx.test.espresso:espresso-core',
        'androidx.test.espresso:espresso-idling-resource',
        'androidx.test.ext:junit',
        'androidx.test.services:storage',
        'androidx.test:core',
        'androidx.test:monitor',
        'androidx.test:runner',
        // A test-classpath companion of androidx.concurrent:concurrent-futures, which does ship.
        'androidx.concurrent:concurrent-futures-ktx',
    ];

    test('leaves a component for every artifact the release APK ships, and none for tooling', () => {
        const tooling = verified.filter((coordinate) => !runtimeArtifacts.includes(coordinate));
        expect(tooling.length).toBeGreaterThan(runtimeArtifacts.length);
        expect(tooling.filter(covers).sort()).toEqual([...TOOLING_UNDER_ANDROIDX].sort());
    });

    // android/release-runtime-notices.txt (scripts/android-runtime-artifacts.sh) names the runtime artifacts whose jar or
    // aar carries a META-INF/NOTICE* file. A NOTICE has to travel with the app (Apache-2.0 section 4(d)), so each one is
    // vendored under scripts/licenses/texts, named by coordinate in scripts/licenses/notices.json, and rendered in
    // section 6 before it is accepted here. (Cordova's NOTICE is vendored from upstream but its aar carries none.)
    const noticeArtifacts = read('android', 'release-runtime-notices.txt').split('\n').filter(Boolean);
    const vendoredNotices = loadNoticeFiles(path.join(LICENSES_DIR, 'notices.json'));
    const noticeText = (coordinate: string) =>
        fs
            .readFileSync(path.join(LICENSES_DIR, 'texts', `${vendoredNotices[coordinate]?.id}.txt`), 'utf8')
            .replace(/\s+$/, '');

    test('lists no artifact with a NOTICE file today', () => {
        expect(noticeArtifacts).toEqual([]);
    });

    test('lists the artifacts with a NOTICE file: sorted, unique, and among those the release APK ships', () => {
        expect(noticeArtifacts).toEqual([...new Set(noticeArtifacts)].sort());
        expect(noticeArtifacts.filter((coordinate) => !runtimeArtifacts.includes(coordinate))).toEqual([]);
    });

    test('has every NOTICE file of a shipped artifact vendored', () => {
        expect(noticeArtifacts.filter((coordinate) => !(coordinate in vendoredNotices))).toEqual([]);
    });

    test('renders the text of every NOTICE file it lists in the committed notices, under section 6', () => {
        const committed = read('src', 'assets', 'THIRD_PARTY_NOTICES.txt');
        const section = committed.slice(
            committed.indexOf('6. Android native libraries'),
            committed.indexOf('7. License texts'),
        );
        for (const coordinate of Object.keys(vendoredNotices)) {
            const indented = noticeText(coordinate)
                .split('\n')
                .map((line) => (line ? `    ${line}` : ''))
                .join('\n');
            expect(section).toContain(`  NOTICE of ${coordinate}:\n\n${indented}\n`);
        }
    });

    test("carries Apache Cordova's own NOTICE for the Cordova Android entry", () => {
        expect(noticeText('org.apache.cordova:framework')).toContain(
            'This product includes software developed at\nThe Apache Software Foundation (http://www.apache.org/).',
        );
    });

    // android/release-runtime-versions.txt (scripts/android-runtime-artifacts.sh) is the release runtime classpath at the
    // versions the release resolves, group:artifact:version; the verification metadata lists the versions of every
    // configuration, so it cannot say what the APK ships.
    const versionLines = read('android', 'release-runtime-versions.txt').split('\n').filter(Boolean);
    const shippedVersions: Record<string, string> = {};
    for (const line of versionLines) {
        const [group, artifact, version] = line.split(':');
        shippedVersions[`${group}:${artifact}`] = version;
    }

    test('has a release runtime version list with one version for each shipped artifact', () => {
        expect(versionListProblems(versionLines, runtimeArtifacts)).toEqual([]);
        expect(Object.keys(shippedVersions).sort()).toEqual(runtimeArtifacts);
    });

    test('reports a module listed at two versions, a stray module, a missing version and a malformed line', () => {
        const artifacts = ['g:a', 'g:b'];
        expect(versionListProblems(['g:a:1', 'g:b:2'], artifacts)).toEqual([]);
        expect(versionListProblems(['g:a:1', 'g:a:2', 'g:b:2'], artifacts)).toEqual([
            'g:a is listed 2 times: g:a:1, g:a:2',
        ]);
        expect(versionListProblems(['g:a:1', 'g:a:1', 'g:b:2'], artifacts)).toEqual([
            'g:a is listed 2 times: g:a:1, g:a:1',
        ]);
        expect(versionListProblems(['g:a:1', 'g:b:2', 'g:c:3'], artifacts)).toEqual(['g:c is not a shipped artifact']);
        expect(versionListProblems(['g:a:1'], artifacts)).toEqual(['g:b has no version']);
        expect(versionListProblems(['g:a:1', 'g:b'], artifacts)).toEqual(['malformed g:b']);
    });

    test('builds each versioned component at the version the release ships, for every artifact it covers', () => {
        for (const component of components) {
            if (!component.versionVariable) continue;
            const covered = Object.entries(shippedVersions).filter(([coordinate]) =>
                component.coordinates.some((pattern) => coordinateMatches(pattern, coordinate)),
            );
            expect({ name: component.name, covers: covered.length > 0 }).toEqual({
                name: component.name,
                covers: true,
            });
            for (const [coordinate, version] of covered) {
                expect({ coordinate, version }).toEqual({ coordinate, version: variables[component.versionVariable] });
            }
        }
    });

    test('vendors only NOTICE files of artifacts the release APK still ships', () => {
        expect(Object.keys(vendoredNotices).filter((coordinate) => !runtimeArtifacts.includes(coordinate))).toEqual([]);
    });

    test('takes each vendored NOTICE from the release the build uses', () => {
        const problems = mismatchedNoticeVersions(vendoredNotices, components, variables, shippedVersions);
        if (problems.length > 0) {
            throw new Error(
                `scripts/licenses/notices.json disagrees with the build: ${problems.join('; ')}. Re-fetch the NOTICE ` +
                    'from the release the build uses, replace the vendored text, and update the version in notices.json.',
            );
        }
        expect(Object.keys(vendoredNotices).length).toBeGreaterThan(0);
    });

    test('compares a vendored NOTICE with the version variable and the shipped version of every covering component, and reports what no component covers', () => {
        const vendored = {
            'org.apache.cordova:framework': { version: '1.0' },
            'androidx.core:core': { version: '2.0' },
            'x:y': { version: '3.0' },
            'z:w': { version: '4.0' },
        };
        const components = [
            { coordinates: ['org.apache.cordova:framework'], versionVariable: 'cordovaVersion' },
            { coordinates: ['androidx.*'] },
            { coordinates: ['androidx.core:*'], versionVariable: 'coreVersion' },
            { coordinates: ['x:y'] },
        ];
        expect(
            mismatchedNoticeVersions(
                vendored,
                components,
                { cordovaVersion: '1.0', coreVersion: '2.0' },
                { 'androidx.core:core': '2.0', 'org.apache.cordova:framework': '1.0' },
            ),
        ).toEqual(['no component covers z:w']);
        expect(
            mismatchedNoticeVersions(
                vendored,
                components,
                { cordovaVersion: '1.1', coreVersion: '2.1' },
                { 'androidx.core:core': '2.2' },
            ),
        ).toEqual([
            'org.apache.cordova:framework is vendored at 1.0 but the build uses 1.1',
            'androidx.core:core is vendored at 2.0 but the build uses 2.1',
            'androidx.core:core is vendored at 2.0 but the release ships 2.2',
            'no component covers z:w',
        ]);
        expect(
            mismatchedNoticeVersions(
                vendored,
                components,
                { cordovaVersion: '1.0', coreVersion: '2.0' },
                { 'org.apache.cordova:framework': '1.1' },
            ),
        ).toEqual([
            'org.apache.cordova:framework is vendored at 1.0 but the release ships 1.1',
            'no component covers z:w',
        ]);
        expect(mismatchedNoticeVersions(vendored, components, {}, {})).toEqual([
            'org.apache.cordova:framework is vendored at 1.0 but the build uses undefined',
            'androidx.core:core is vendored at 2.0 but the build uses undefined',
            'no component covers z:w',
        ]);
    });

    test('accepts a module without a file only when every selected variant is a platform or a redirect', () => {
        const script = read('scripts', 'android-runtime-artifacts.sh');
        expect(script).toContain('!component.variants.isEmpty() && component.variants.every {');
        expect(script).toContain('failures.add("${coordinate} resolves to no file');
    });

    describe("the script's --check-versions mode", () => {
        const script = path.join(ROOT, 'scripts', 'android-runtime-artifacts.sh');
        let directory: string;
        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-artifacts-'));
        });
        afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
        const check = (artifacts: string[], versions: string[]) => {
            const artifactsFile = path.join(directory, 'artifacts.txt');
            const versionsFile = path.join(directory, 'versions.txt');
            fs.writeFileSync(artifactsFile, artifacts.map((line) => `${line}\n`).join(''));
            fs.writeFileSync(versionsFile, versions.map((line) => `${line}\n`).join(''));
            try {
                execFileSync('bash', [script, '--check-versions', artifactsFile, versionsFile], { stdio: 'pipe' });
                return { status: 0, stderr: '' };
            } catch (error) {
                const failure = invalid<{ status: number; stderr: Buffer }>(error);
                return { status: failure.status, stderr: failure.stderr.toString() };
            }
        };

        test('accepts a version list with exactly one version for each artifact', () => {
            expect(check(['g:a', 'g:b'], ['g:a:1', 'g:b:2.0+'])).toEqual({ status: 0, stderr: '' });
        });

        test('refuses a module listed at two versions, naming it', () => {
            const result = check(['g:a', 'g:b'], ['g:a:1', 'g:a:2', 'g:b:3']);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('do not map one-to-one onto its artifacts');
            expect(result.stderr).toContain('    g:a\n');
            expect(result.stderr).not.toContain('g:b');
        });

        test('refuses a module without a version, naming it', () => {
            const result = check(['g:a', 'g:b'], ['g:a:1']);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('    g:b\n');
            expect(result.stderr).not.toContain('g:a');
        });

        test('refuses a version for a module that is not an artifact, naming it', () => {
            const result = check(['g:a'], ['g:a:1', 'g:c:3']);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('    g:c\n');
        });

        test('compares the sorted lists bytewise, under the same collation they were sorted with', () => {
            const text = read('scripts', 'android-runtime-artifacts.sh');
            expect(text).toContain(
                `unversioned=$(LC_ALL=C comm -3 <(cut -d: -f1,2 "$2" | LC_ALL=C sort) <(LC_ALL=C sort "$1") | tr -d '\\t')`,
            );
        });

        test('refuses the wrong number of arguments with a usage message and exit 2', () => {
            const result = spawnSync('bash', [script, '--check-versions', 'only-one'], { encoding: 'utf8' });
            expect(result.status).toBe(2);
            expect(result.stderr).toContain(`usage: ${script} --check-versions <artifacts-file> <versions-file>`);
        });

        test.each([
            ['a missing artifacts file', 'missing-artifacts.txt', 'versions.txt'],
            ['a missing versions file', 'artifacts.txt', 'missing-versions.txt'],
            ['a directory for the artifacts file', '.', 'versions.txt'],
            ['a directory for the versions file', 'artifacts.txt', '.'],
        ])('refuses %s with exit 2, naming the path it cannot read', (_name, artifactsName, versionsName) => {
            fs.writeFileSync(path.join(directory, 'artifacts.txt'), 'g:a\n');
            fs.writeFileSync(path.join(directory, 'versions.txt'), 'g:a:1\n');
            const artifactsPath = path.join(directory, artifactsName);
            const versionsPath = path.join(directory, versionsName);
            const result = spawnSync('bash', [script, '--check-versions', artifactsPath, versionsPath], {
                encoding: 'utf8',
            });
            expect(result.status).toBe(2);
            const unreadable = artifactsName === 'artifacts.txt' ? versionsPath : artifactsPath;
            expect(result.stderr).toBe(`${script}: cannot read ${unreadable}\n`);
        });

        test('the generating flow calls the same check and writes nothing when it fails', () => {
            const text = read('scripts', 'android-runtime-artifacts.sh');
            expect(text).toContain('if ! check_versions "$new_artifacts" "$new_versions"; then');
            expect(text.indexOf('if ! check_versions')).toBeLessThan(text.indexOf('mv "$new_artifacts"'));
        });
    });

    test('keeps the runtime lists current: the Android CI job regenerates and diffs them, and so does the metadata script', () => {
        const workflow = read('.github', 'workflows', 'test.yml');
        expect(workflow).toContain('scripts/android-runtime-artifacts.sh');
        expect(workflow).toMatch(
            /git diff --exit-code -- android\/release-runtime-artifacts\.txt android\/release-runtime-versions\.txt android\/release-runtime-notices\.txt/,
        );
        expect(read('scripts', 'android-verification-metadata.sh')).toContain('scripts/android-runtime-artifacts.sh');
    });

    test('maps every Capacitor Gradle project to an npm package of the lockfile', () => {
        const projects = [...read('android', 'app', 'capacitor.build.gradle').matchAll(/project\(':([^']+)'\)/g)].map(
            ([, project]) => project,
        );
        const packages = collectPackages(parseLockfile(read('pnpm-lock.yaml'))).map(({ name }) => name);
        expect(projects.length).toBeGreaterThan(0);
        for (const project of projects) {
            expect(packages.map((name) => name.replace(/^@/, '').replace('/', '-'))).toContain(project);
        }
    });
});

describe('parseLockfile', () => {
    test('reads the last YAML document, the project lock after the environment lock', () => {
        const lock = parseLockfile(
            [
                '---',
                'importers:',
                "  '.':",
                '    configDependencies: {}',
                '---',
                'importers:',
                "  '.':",
                '    dependencies: {}',
                'snapshots: {}',
            ].join('\n'),
        );
        expect(lock.importer).toEqual({ dependencies: {} });
        expect(lock.snapshots).toEqual({});
    });

    test.each([
        ['not an object', '- a\n- b'],
        ['no importers', 'snapshots: {}'],
        ['no root importer', 'importers:\n  other: {}\nsnapshots: {}'],
        ['no snapshots', "importers:\n  '.': {}"],
    ])('rejects a lockfile that is %s', (_label, text) => {
        expect(() => parseLockfile(text)).toThrow('pnpm-lock.yaml has no root importer or snapshots');
    });
});

describe('collectPackages', () => {
    const lockOf = (importer: object, snapshots: object) => ({
        importer: invalid<Record<string, unknown>>(importer),
        snapshots: invalid<Record<string, unknown>>(snapshots),
    });

    test('follows dependencies and optional dependencies, strips peer suffixes and aliases, and dedupes', () => {
        const lock = lockOf(
            {
                dependencies: { app: { version: '1.0.0(peer@2.0.0)' } },
                optionalDependencies: { native: { version: '3.0.0' } },
                devDependencies: { css: { version: '4.0.0' }, other: { version: '9.9.9' } },
            },
            {
                'app@1.0.0(peer@2.0.0)': {
                    dependencies: { peer: '2.0.0', '@scope/lib': '5.0.0', aliased: 'real-name@6.0.0' },
                    optionalDependencies: { native: '3.0.0' },
                },
                'peer@2.0.0': {},
                '@scope/lib@5.0.0': { dependencies: { peer: '2.0.0' } },
                'real-name@6.0.0': {},
                'native@3.0.0': {},
                'css@4.0.0': {},
            },
        );
        expect(collectPackages(lock, ['css'])).toEqual([
            { name: '@scope/lib', version: '5.0.0' },
            { name: 'app', version: '1.0.0' },
            { name: 'css', version: '4.0.0' },
            { name: 'native', version: '3.0.0' },
            { name: 'peer', version: '2.0.0' },
            { name: 'real-name', version: '6.0.0' },
        ]);
    });

    test('keeps two versions of one package apart', () => {
        const lock = lockOf(
            { dependencies: { a: { version: '1.0.0' }, b: { version: '1.0.0' } } },
            {
                'a@1.0.0': { dependencies: { shared: '1.0.0' } },
                'b@1.0.0': { dependencies: { shared: '2.0.0' } },
                'shared@1.0.0': {},
                'shared@2.0.0': {},
            },
        );
        expect(collectPackages(lock, []).map(({ name, version }) => `${name}@${version}`)).toEqual([
            'a@1.0.0',
            'b@1.0.0',
            'shared@1.0.0',
            'shared@2.0.0',
        ]);
    });

    test('tolerates an importer without devDependencies when no build-time package is bundled', () => {
        expect(collectPackages(lockOf({ dependencies: { a: { version: '1.0.0' } } }, { 'a@1.0.0': {} }), [])).toEqual([
            { name: 'a', version: '1.0.0' },
        ]);
    });

    test('fails on a bundled build-time package that is not a devDependency', () => {
        expect(() => collectPackages(lockOf({ dependencies: {} }, {}), ['css'])).toThrow(
            'css is not a devDependency in pnpm-lock.yaml',
        );
    });

    test('fails on a root dependency without a version', () => {
        expect(() => collectPackages(lockOf({ dependencies: { a: 'link:../a' } }, {}), [])).toThrow(
            "the root importer's a has no version",
        );
    });

    test('fails on a package with no snapshot', () => {
        expect(() => collectPackages(lockOf({ dependencies: { a: { version: '1.0.0' } } }, {}), [])).toThrow(
            'pnpm-lock.yaml has no snapshot for a@1.0.0',
        );
    });
});

describe('lookupLicense', () => {
    const entry = (license: string) => ({ license, texts: [license], copyright: [] });
    const licenses = {
        exact: entry('exact'),
        '@scope/*': entry('scope'),
        '@scope/deep-*': entry('deep'),
    };

    test('prefers the exact name, then the longest prefix', () => {
        expect(lookupLicense(licenses, 'exact').license).toBe('exact');
        expect(lookupLicense(licenses, '@scope/other').license).toBe('scope');
        expect(lookupLicense(licenses, '@scope/deep-one').license).toBe('deep');
    });

    test('fails with the file to edit when nothing matches', () => {
        expect(() => lookupLicense(licenses, 'unknown')).toThrow(
            'No license entry for unknown: add it to scripts/licenses/packages.json',
        );
    });
});

describe('license data files', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-notices-data-'));
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    const write = (name: string, data: unknown) => {
        const file = path.join(directory, name);
        fs.writeFileSync(file, JSON.stringify(data));
        return file;
    };

    test('packages.json must be an object of valid entries', () => {
        expect(
            loadLicenses(write('ok.json', { a: { license: 'MIT', texts: ['MIT'], copyright: ['c'], source: 's' } })),
        ).toHaveProperty('a');
        expect(() => loadLicenses(write('array.json', []))).toThrow('must hold a JSON object');
        for (const bad of [
            { license: 1, texts: [], copyright: [] },
            { license: 'MIT', texts: 'MIT', copyright: [] },
            { license: 'MIT', texts: [], copyright: [1] },
            { license: 'MIT', texts: [], copyright: [], source: 1 },
        ]) {
            expect(() => loadLicenses(write('bad.json', { a: bad }))).toThrow('invalid entry for a');
        }
    });

    test('android.json must be a list of valid components', () => {
        const good = { name: 'n', coordinates: ['g:a'], license: 'Apache-2.0', copyright: 'c', url: 'u' };
        expect(
            loadAndroidComponents(write('ok.json', [{ ...good, versionVariable: 'v', transitive: true }])),
        ).toHaveLength(1);
        expect(() => loadAndroidComponents(write('object.json', {}))).toThrow('invalid component list');
        for (const bad of [
            { ...good, name: 1 },
            { ...good, coordinates: [1] },
            { ...good, license: 1 },
            { ...good, copyright: 1 },
            { ...good, url: 1 },
            { ...good, versionVariable: 1 },
            { ...good, transitive: 'yes' },
        ]) {
            expect(() => loadAndroidComponents(write('bad.json', [bad]))).toThrow('invalid component list');
        }
    });

    test('notices.json must map each coordinate to a text id and the version the text was taken from', () => {
        const good = { id: 'NOTICE-g-a', version: '1.0' };
        expect(loadNoticeFiles(write('ok.json', { 'g:a': good }))).toEqual({ 'g:a': good });
        expect(() => loadNoticeFiles(write('list.json', []))).toThrow('must hold a JSON object');
        for (const bad of [
            'NOTICE-g-a',
            { id: 1, version: '1.0' },
            { id: 'NOTICE-g-a', version: 1 },
            { id: 'NOTICE-g-a' },
        ]) {
            expect(() => loadNoticeFiles(write('bad.json', { 'g:a': bad }))).toThrow('invalid entry for g:a');
        }
    });

    test('notices.json ids start with NOTICE- and are not shared between entries', () => {
        expect(() => loadNoticeFiles(write('prefix.json', { 'g:a': { id: 'g-a', version: '1' } }))).toThrow(
            'the id of g:a must start with NOTICE-',
        );
        expect(() =>
            loadNoticeFiles(
                write('dupe.json', {
                    'g:a': { id: 'NOTICE-g', version: '1' },
                    'g:b': { id: 'NOTICE-g', version: '1' },
                }),
            ),
        ).toThrow('the id NOTICE-g is used by more than one entry');
    });

    test('Gradle variables are read from quoted assignments', () => {
        expect(parseGradleVariables("ext {\n    a = '1'\n    b='2.0'\n    c = 3\n}")).toEqual({ a: '1', b: '2.0' });
    });
});

describe('main failures and rendering', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-notices-main-'));
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const fixture = (onnxruntimeVersion: string | null) => {
        const dir = (...segments: string[]) => {
            const target = path.join(directory, ...segments);
            fs.mkdirSync(target, { recursive: true });
            return target;
        };
        const texts = dir('licenses', 'texts');
        for (const id of [
            'Apache-2.0',
            'PDDL-1.0',
            'MIT',
            'Node.js-LICENSE',
            'onnxruntime-LICENSE',
            'onnxruntime-ThirdPartyNotices',
        ]) {
            fs.writeFileSync(path.join(texts, `${id}.txt`), `text of ${id}\n\n`);
        }
        fs.writeFileSync(
            path.join(directory, 'licenses', 'android.json'),
            JSON.stringify([
                {
                    name: 'Versioned',
                    coordinates: ['g:a'],
                    license: 'Apache-2.0',
                    copyright: 'C1',
                    url: 'u1',
                    versionVariable: 'v',
                },
                { name: 'Plain', coordinates: ['g:b'], license: 'Apache-2.0', copyright: 'C2', url: 'u2' },
            ]),
        );
        fs.writeFileSync(path.join(directory, 'licenses', 'notices.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(directory, 'variables.gradle'), "ext {\n  v = '7.1'\n}\n");
        fs.writeFileSync(path.join(directory, 'LICENSE'), 'ISC License\n\nCopyright (c) test\n\n');
        const dependencies = onnxruntimeVersion
            ? `    dependencies:\n      onnxruntime-node:\n        version: ${onnxruntimeVersion}\n      plain:\n        version: 1.0.0\n`
            : '    dependencies:\n      plain:\n        version: 1.0.0\n';
        const snapshots = `snapshots:\n  plain@1.0.0: {}\n${onnxruntimeVersion ? `  onnxruntime-node@${onnxruntimeVersion}: {}\n` : ''}`;
        fs.writeFileSync(
            path.join(directory, 'pnpm-lock.yaml'),
            `importers:\n  .:\n${dependencies}    devDependencies:\n      daisyui:\n        version: 1.0.0\n      tailwindcss:\n        version: 1.0.0\n${snapshots}  daisyui@1.0.0: {}\n  tailwindcss@1.0.0: {}\n`,
        );
        fs.writeFileSync(
            path.join(directory, 'licenses', 'packages.json'),
            JSON.stringify({
                'onnxruntime-node': { license: 'MIT', texts: ['MIT'], copyright: ['Copyright MS'] },
                plain: {
                    license: 'MIT',
                    texts: ['MIT'],
                    copyright: ['Copyright P'],
                    source: 'https://example.test/{version}',
                },
                daisyui: { license: 'MIT', texts: ['MIT'], copyright: [] },
                tailwindcss: { license: 'MIT', texts: ['MIT'], copyright: [] },
            }),
        );
        return {
            lockPath: path.join(directory, 'pnpm-lock.yaml'),
            licensesDir: path.join(directory, 'licenses'),
            androidVariablesPath: path.join(directory, 'variables.gradle'),
            licensePath: path.join(directory, 'LICENSE'),
            outPath: path.join(directory, 'out.txt'),
        };
    };

    test('renders every section from a small fixture', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        main(options);
        const text = fs.readFileSync(options.outPath, 'utf8');
        expect(text).toMatch(/\n$/);
        expect(text).not.toMatch(/\n\n$/);
        expect(text).toContain('1. GuruShotsAutoVote\n--------------------\n\nISC License\n\nCopyright (c) test\n\n2.');
        expect(text).toContain('3. npm packages (4)');
        expect(text).toContain('plain 1.0.0\n  License: MIT\n  Copyright P\n  Source: https://example.test/1.0.0\n');
        expect(text).toContain('Versioned 7.1\n  License: Apache-2.0\n  C1\n  u1\n');
        expect(text).toContain('Plain\n  License: Apache-2.0\n  C2\n  u2\n');
        expect(text).toContain('======== Node.js LICENSE ========\n\ntext of Node.js-LICENSE\n');
        expect(text).toContain('======== MIT ========\n\ntext of MIT\n');
        const lgpl = text.slice(text.indexOf('4. Libraries under'), text.indexOf('5. Runtimes'));
        expect(lgpl).not.toContain('  plain');
    });

    test('renders the NOTICE files in the texts directory with their components, and no other file there', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        const texts = path.join(options.licensesDir, 'texts');
        fs.writeFileSync(path.join(texts, 'NOTICE-g-a.txt'), 'Notice of A\nline two\n');
        fs.writeFileSync(path.join(texts, 'NOTICE-notes.md'), 'not a notice');
        fs.writeFileSync(
            path.join(options.licensesDir, 'notices.json'),
            JSON.stringify({ 'g:a': { id: 'NOTICE-g-a', version: '1' } }),
        );
        main(options);
        const text = fs.readFileSync(options.outPath, 'utf8');
        expect(text).toContain(
            'Versioned 7.1\n  License: Apache-2.0\n  C1\n  u1\n\n  NOTICE of g:a:\n\n    Notice of A\n    line two\n\nPlain',
        );
        expect(text).not.toContain('not a notice');
    });

    test('fails on a vendored NOTICE file notices.json names no artifact for', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        fs.writeFileSync(path.join(options.licensesDir, 'texts', 'NOTICE-nobody-home.txt'), 'x');
        expect(() => main(options)).toThrow('names no artifact for the vendored NOTICE-nobody-home');
    });

    test('renders the LGPL list only for packages that carry the LGPL text', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        const packages = parseJsonAs(
            fs.readFileSync(path.join(options.licensesDir, 'packages.json'), 'utf8'),
            isRecordOf(isShape<{ texts: string[] }>({ texts: isArrayOf(isString) })),
        );
        packages.plain.texts = ['MIT', 'LGPL-3.0'];
        fs.writeFileSync(path.join(options.licensesDir, 'packages.json'), JSON.stringify(packages));
        fs.writeFileSync(path.join(options.licensesDir, 'texts', 'LGPL-3.0.txt'), 'text of LGPL\n');
        main(options);
        expect(fs.readFileSync(options.outPath, 'utf8')).toContain(
            'A CLI built from a source checkout corresponds to the source of that checkout.\n\n  plain 1.0.0\n',
        );
    });

    test('points the LGPL note at the releases, whatever the version of the project', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        main(options);
        const text = fs.readFileSync(options.outPath, 'utf8');
        expect(text).toContain('the release tag that matches\nthe version the CLI reports');
        expect(text).toContain('https://github.com/isthisgitlab/gurushots-auto-vote/releases.');
        expect(text).toContain('A CLI built from a source checkout corresponds to the source of that checkout.');
        expect(text).not.toContain('/tree/v');
    });

    test('is deterministic', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        main(options);
        const first = fs.readFileSync(options.outPath, 'utf8');
        main(options);
        expect(fs.readFileSync(options.outPath, 'utf8')).toBe(first);
    });

    test('fails when the locked onnxruntime-node is not the release whose texts are vendored', () => {
        expect(() => main(fixture('9.9.9'))).toThrow(
            `The vendored ONNX Runtime texts are for ${ONNXRUNTIME_TEXTS_VERSION}, but the lockfile has 9.9.9`,
        );
    });

    test('fails when the lockfile has no onnxruntime-node', () => {
        expect(() => main(fixture(null))).toThrow('but the lockfile has no onnxruntime-node');
    });

    test('renderNotices fails on a package without a license entry', () => {
        expect(() =>
            renderNotices({
                projectLicense: '',
                packages: [{ name: 'mystery', version: '1.0.0' }],
                licenses: {},
                android: [],
                androidVersions: {},
                onnxruntimeVersion: '1.0.0',
                notices: {},
                readText: () => '',
            }),
        ).toThrow('No license entry for mystery');
    });

    describe('NOTICE files of Android artifacts', () => {
        const withNotices = (
            notices: Record<string, string>,
            noticeText = 'Apache Thing\nCopyright 2012\n\nIncludes more.',
        ) =>
            renderNotices({
                projectLicense: '',
                packages: [],
                licenses: {},
                android: [
                    { name: 'Exact', coordinates: ['com.x:one'], license: 'Apache-2.0', copyright: 'C1', url: 'u1' },
                    {
                        name: 'Pattern',
                        coordinates: ['org.y:*', 'org.z:pre-*'],
                        license: 'Apache-2.0',
                        copyright: 'C2',
                        url: 'u2',
                    },
                ],
                androidVersions: {},
                onnxruntimeVersion: '1.0.0',
                notices,
                readText: (id) => (id.startsWith('NOTICE-') ? noticeText : `text of ${id}`),
            });

        test('renders each vendored NOTICE text with the component it belongs to, indented', () => {
            const text = withNotices({
                'com.x:one': 'NOTICE-com.x-one',
                'org.z:pre-two': 'NOTICE-org.z-pre-two',
            });

            expect(text).toContain(
                'Exact\n  License: Apache-2.0\n  C1\n  u1\n\n' +
                    '  NOTICE of com.x:one:\n\n    Apache Thing\n    Copyright 2012\n\n    Includes more.\n\n' +
                    'Pattern\n  License: Apache-2.0\n  C2\n  u2\n\n' +
                    '  NOTICE of org.z:pre-two:\n\n    Apache Thing\n',
            );
        });

        test('renders no NOTICE block when none is vendored', () => {
            expect(withNotices({})).not.toContain('NOTICE of');
        });

        test('fails on a vendored NOTICE that belongs to no component, so it cannot go unrendered', () => {
            expect(() =>
                withNotices({ 'com.x:one': 'NOTICE-com.x-one', 'com.other:lib': 'NOTICE-com.other-lib' }),
            ).toThrow('No scripts/licenses/android.json component for the vendored NOTICE of com.other:lib');
        });

        test('matches by coordinate, so two coordinates whose names would collide each get their own notice', () => {
            const text = renderNotices({
                projectLicense: '',
                packages: [],
                licenses: {},
                android: [
                    { name: 'First', coordinates: ['com.a-b:c'], license: 'Apache-2.0', copyright: 'C1', url: 'u1' },
                    { name: 'Second', coordinates: ['com.a:b-c'], license: 'Apache-2.0', copyright: 'C2', url: 'u2' },
                ],
                androidVersions: {},
                onnxruntimeVersion: '1.0.0',
                notices: { 'com.a-b:c': 'NOTICE-first', 'com.a:b-c': 'NOTICE-second' },
                readText: (id) => `text of ${id}`,
            });

            expect(text).toContain(
                'First\n  License: Apache-2.0\n  C1\n  u1\n\n  NOTICE of com.a-b:c:\n\n    text of NOTICE-first\n\nSecond',
            );
            expect(text).toContain(
                'Second\n  License: Apache-2.0\n  C2\n  u2\n\n  NOTICE of com.a:b-c:\n\n    text of NOTICE-second\n',
            );
        });
    });
});
