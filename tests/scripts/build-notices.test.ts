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
    loadAndroidComponents,
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
    const matches = (pattern: string, coordinate: string) =>
        pattern.endsWith('*') ? coordinate.startsWith(pattern.slice(0, -1)) : pattern === coordinate;
    const covers = (coordinate: string) =>
        components.some((component) => component.coordinates.some((pattern) => matches(pattern, coordinate)));

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
                !component.coordinates.some((pattern) => declared.some((coordinate) => matches(pattern, coordinate))),
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
                    runtimeArtifacts.some((coordinate) => matches(pattern, coordinate)),
                ),
        );
        expect(stale.map((component) => component.name)).toEqual([]);
    });

    // Anything else the verification metadata lists is the Android Gradle plugin and the build, lint, test and coverage
    // tooling it resolves, which never reaches the APK.
    test('leaves a component for every artifact the release APK ships, and none for tooling', () => {
        const tooling = verified.filter((coordinate) => !runtimeArtifacts.includes(coordinate));
        expect(tooling.length).toBeGreaterThan(runtimeArtifacts.length);
        expect(tooling.filter((coordinate) => covers(coordinate) && !coordinate.startsWith('androidx.'))).toEqual([]);
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
            'A CLI built from a source checkout corresponds to the source of that\ncheckout.\n\n  plain 1.0.0\n',
        );
    });

    test('points the LGPL note at the releases, whatever the version of the project', () => {
        const options = fixture(ONNXRUNTIME_TEXTS_VERSION);
        main(options);
        const text = fs.readFileSync(options.outPath, 'utf8');
        expect(text).toContain('the release tag that matches\nthe version the CLI reports');
        expect(text).toContain('https://github.com/isthisgitlab/gurushots-auto-vote/releases.');
        expect(text).toContain('A CLI built from a source checkout corresponds to the source of that\ncheckout.');
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
                readText: () => '',
            }),
        ).toThrow('No license entry for mystery');
    });
});
