#!/usr/bin/env node
/**
 * Third-party notices generator (`pnpm build:notices`).
 *
 * Writes src/assets/THIRD_PARTY_NOTICES.txt, the file the desktop app, the CLI
 * binaries and the Android app carry (esbuild strips license headers from the
 * bundles, and several runtimes ship as separate binaries). Everything comes
 * from committed inputs, so the output is the same on every host:
 *
 *   - the package list from pnpm-lock.yaml: the production dependency tree plus
 *     the build-time packages whose output is bundled (BUNDLED_DEV_DEPENDENCIES),
 *     with every platform variant of an optional dependency, never what happens
 *     to be installed here;
 *   - license, copyright and license-text ids per package from
 *     scripts/licenses/packages.json, the texts from scripts/licenses/texts/;
 *   - the Android native libraries from scripts/licenses/android.json;
 *   - the non-npm components (Node.js, ONNX Runtime, the SigLIP model, GloVe).
 *
 * A package with no entry in packages.json fails the build, so a new dependency
 * cannot ship without its notice. CI regenerates the file and diffs it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { isPlainObject } from '../src/ts/plainObject';
import { GLOVE_URL } from './fetch-embeddings/config';
import { REPOS } from './fetch-vision-model';
import { readLicenseText, visionModelNotice } from './lib/licenses';
import { loadAndroidComponents, loadLicenses, loadNoticeFiles } from './lib/noticeData';
import type { AndroidComponent, LicenseEntry } from './lib/noticeData';
import { runIfMain } from './lib/run-if-main';

const ROOT = path.join(__dirname, '..');

const PROJECT_SOURCE_URL = 'https://github.com/isthisgitlab/gurushots-auto-vote';

// The Node.js release whose LICENSE is vendored (scripts/licenses/texts/Node.js-LICENSE.txt),
// and the ONNX Runtime release whose LICENSE and ThirdPartyNotices are.
const NODE_LICENSE_VERSION = '26.10.0';
const ONNXRUNTIME_TEXTS_VERSION = '1.30.0';

// devDependencies whose output ships inside the app: their CSS is compiled into dist/styles.css.
const BUNDLED_DEV_DEPENDENCIES = ['daisyui', 'tailwindcss'];

interface PackageRef {
    name: string;
    version: string;
}

interface Lockfile {
    importer: Record<string, unknown>;
    snapshots: Record<string, unknown>;
}

interface NoticeInputs {
    projectLicense: string;
    packages: PackageRef[];
    licenses: Record<string, LicenseEntry>;
    android: AndroidComponent[];
    androidVersions: Record<string, string>;
    onnxruntimeVersion: string;
    /** The vendored NOTICE file (its text id) of each shipped Android artifact, by `group:artifact`. */
    notices: Record<string, string>;
    readText: (id: string) => string;
}

/** The lockfile's last YAML document: pnpm 12 writes the environment's own lock first. */
const parseLockfile = (text: string): Lockfile => {
    const documents = parseAllDocuments(text).map((document) => document.toJS() as unknown);
    const lock = documents[documents.length - 1];
    const importers = isPlainObject(lock) ? lock.importers : undefined;
    const importer = isPlainObject(importers) ? importers['.'] : undefined;
    const snapshots = isPlainObject(lock) ? lock.snapshots : undefined;
    if (!isPlainObject(importer) || !isPlainObject(snapshots)) {
        throw new Error('pnpm-lock.yaml has no root importer or snapshots');
    }
    return { importer, snapshots };
};

/** `name@1.2.3(peer@4)` → name and version. */
const splitKey = (key: string): PackageRef => {
    const bare = key.replace(/\(.*$/, '');
    const at = bare.lastIndexOf('@');
    return { name: bare.slice(0, at), version: bare.slice(at + 1) };
};

const dependencyEntries = (value: unknown): [string, unknown][] => (isPlainObject(value) ? Object.entries(value) : []);

/** A dependency's snapshot key: a plain version or an `alias: real-name@version` reference. */
const snapshotKey = (name: string, reference: unknown) => {
    const ref = String(reference);
    return /^\d/.test(ref) ? `${name}@${ref}` : ref;
};

/**
 * Every package reachable from the root's dependencies, optional dependencies
 * (all platform variants: the lockfile lists them all) and BUNDLED_DEV_DEPENDENCIES.
 */
const collectPackages = (lock: Lockfile, bundledDev = BUNDLED_DEV_DEPENDENCIES): PackageRef[] => {
    const roots: string[] = [];
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
        for (const [name, spec] of dependencyEntries(lock.importer[field])) {
            if (!isPlainObject(spec)) throw new Error(`pnpm-lock.yaml: the root importer's ${name} has no version`);
            roots.push(snapshotKey(name, spec.version));
        }
    }
    const devDependencies = isPlainObject(lock.importer.devDependencies) ? lock.importer.devDependencies : {};
    for (const name of bundledDev) {
        const spec = devDependencies[name];
        if (!isPlainObject(spec)) throw new Error(`${name} is not a devDependency in pnpm-lock.yaml`);
        roots.push(snapshotKey(name, spec.version));
    }

    const seen = new Set<string>();
    const queue = [...roots];
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
        if (seen.has(key)) continue;
        seen.add(key);
        const snapshot = lock.snapshots[key];
        if (!isPlainObject(snapshot)) throw new Error(`pnpm-lock.yaml has no snapshot for ${key}`);
        for (const field of ['dependencies', 'optionalDependencies']) {
            for (const [name, reference] of dependencyEntries(snapshot[field])) {
                queue.push(snapshotKey(name, reference));
            }
        }
    }

    // Default sort: UTF-16 code-unit order, the same on every host and locale.
    const unique = new Set<string>();
    for (const key of seen) {
        const { name, version } = splitKey(key);
        unique.add(`${name}@${version}`);
    }
    return [...unique].sort().map(splitKey);
};

/** The exact name, else the longest `prefix*` key that matches. */
const lookupLicense = (licenses: Record<string, LicenseEntry>, name: string): LicenseEntry => {
    const exact = licenses[name];
    if (exact) return exact;
    const prefix = Object.keys(licenses)
        .filter((key) => key.endsWith('*') && name.startsWith(key.slice(0, -1)))
        .sort((a, b) => b.length - a.length)[0];
    if (prefix === undefined) {
        throw new Error(`No license entry for ${name}: add it to scripts/licenses/packages.json`);
    }
    return licenses[prefix];
};

const NOTICE_HEADER = [
    'THIRD-PARTY NOTICES',
    '===================',
    '',
    'GuruShotsAutoVote is licensed under the ISC License (section 1). It includes, or is built on, the',
    'third-party software, data and models listed below, each under its own license. The full texts of',
    'those licenses are reproduced in the sections that name them and in section 7.',
    '',
];

const heading = (title: string) => [title, '-'.repeat(title.length), ''];

const rule = (title: string) => ['='.repeat(8) + ` ${title} ` + '='.repeat(8), ''];

/** Section 3 lines plus the packages that ship libvips (section 4 lists them); records each license text it cites. */
const renderNpmPackages = (
    { packages, licenses }: NoticeInputs,
    usedTexts: Set<string>,
): { lines: string[]; libvips: string[] } => {
    const lines: string[] = [
        ...heading(`3. npm packages (${packages.length})`),
        'Shipped in the desktop app, the CLI binaries and the Android app, or compiled into their bundles.',
        '',
    ];
    const libvips: string[] = [];
    for (const { name, version } of packages) {
        const entry = lookupLicense(licenses, name);
        for (const id of entry.texts) usedTexts.add(id);
        lines.push(`${name} ${version}`, `  License: ${entry.license}`);
        for (const line of entry.copyright) lines.push(`  ${line}`);
        if (entry.source) lines.push(`  Source: ${entry.source.replace('{version}', version)}`);
        lines.push('');
        if (entry.texts.includes('LGPL-3.0')) libvips.push(`${name} ${version}`);
    }
    return { lines, libvips };
};

const renderLgplSection = (libvips: string[]) => [
    ...heading('4. Libraries under the GNU Lesser General Public License'),
    'The packages below contain libvips and the libraries it is built from, licensed under the GNU',
    'Lesser General Public License v3.0 or later. The complete texts of the LGPL-3.0 and of the',
    'GPL-3.0 it refers to are in section 7; the source of each version is at the Source URL listed',
    'with it in section 3.',
    '',
    'In the desktop app these libraries are separate files outside the application archive',
    '(app.asar.unpacked/node_modules/@img/) and can be replaced by a compatible build. In the CLI',
    'binaries they are part of the embedded runtime archive, which is extracted to the "vision"',
    "directory of the CLI's data folder and checked against a digest embedded at build time; to use",
    "a modified build of them, rebuild the CLI from this project's source: the release tag that matches",
    'the version the CLI reports (the "Current version" line of its check-updates command) is listed at',
    `${PROJECT_SOURCE_URL}/releases.`,
    'A CLI built from a source checkout corresponds to the source of that checkout.',
    '',
    ...libvips.map((entry) => `  ${entry}`),
    '',
];

const renderRuntimesSection = ({ readText, onnxruntimeVersion }: NoticeInputs) => [
    ...heading('5. Runtimes, models and data'),
    '5.1 Node.js',
    '',
    `The CLI binaries (gurucli-*) embed the Node.js runtime, Copyright Node.js contributors. The`,
    `LICENSE of Node.js v${NODE_LICENSE_VERSION} follows; it also lists the licenses of the third-party`,
    'components bundled in Node.js.',
    '',
    ...rule('Node.js LICENSE'),
    readText('Node.js-LICENSE'),
    '',
    '5.2 ONNX Runtime',
    '',
    `The local photo check runs on ONNX Runtime (onnxruntime-node ${onnxruntimeVersion} in the desktop app and the CLI,`,
    'a development build of the onnxruntime-web 1.31 line as WebAssembly in the Android app),',
    `Copyright (c) Microsoft Corporation, under the MIT license. The LICENSE and ThirdPartyNotices of`,
    `ONNX Runtime ${ONNXRUNTIME_TEXTS_VERSION} follow.`,
    '',
    ...rule('ONNX Runtime LICENSE'),
    readText('onnxruntime-LICENSE'),
    '',
    ...rule('ONNX Runtime ThirdPartyNotices'),
    readText('onnxruntime-ThirdPartyNotices'),
    '',
    '5.3 SigLIP vision model',
    '',
    visionModelNotice(REPOS).split('\n').slice(2).join('\n').trimEnd(),
    '',
    'License: Apache-2.0 (section 7). The model directory of each build carries the same LICENSE and NOTICE.',
    '',
    '5.4 GloVe word vectors',
    '',
    'The semantic lexicon (semantic-vectors.json) used to rank auto-fill photos contains quantized,',
    'mean-centered and retrofitted derivatives of selected vectors of GloVe 6B (glove.6B.100d):',
    'Pennington, J., Socher, R. and Manning, C. D. (2014), GloVe: Global Vectors for Word',
    'Representation, https://nlp.stanford.edu/projects/glove/',
    `Source: ${GLOVE_URL}`,
    'License: Open Data Commons Public Domain Dedication and License v1.0 (PDDL-1.0, section 7).',
    '',
];

const NOTICE_ID_PREFIX = 'NOTICE-';

/** Whether an android.json coordinate (`group:artifact`, or a pattern ending in `*`) names this artifact. */
const coordinateMatches = (pattern: string, coordinate: string) =>
    pattern.endsWith('*') ? coordinate.startsWith(pattern.slice(0, -1)) : coordinate === pattern;

/** Section 6 lines; records each component's license text. Every vendored NOTICE file is rendered with its component. */
const renderAndroidSection = (inputs: NoticeInputs, usedTexts: Set<string>) => {
    const lines: string[] = [
        ...heading('6. Android native libraries'),
        'Compiled into the Android app (Gradle dependencies; Capacitor itself and its plugins are npm',
        'packages listed in section 3).',
        '',
    ];
    const rendered = new Set<string>();
    for (const component of inputs.android) {
        const version = component.versionVariable ? inputs.androidVersions[component.versionVariable] : undefined;
        usedTexts.add(component.license);
        lines.push(
            `${component.name}${version ? ` ${version}` : ''}`,
            `  License: ${component.license}`,
            `  ${component.copyright}`,
            ...(component.attribution ? [`  ${component.attribution}`] : []),
            `  ${component.url}`,
            '',
        );
        for (const [coordinate, id] of Object.entries(inputs.notices).sort(([a], [b]) => a.localeCompare(b))) {
            if (!component.coordinates.some((pattern) => coordinateMatches(pattern, coordinate))) continue;
            rendered.add(coordinate);
            lines.push(
                `  NOTICE of ${coordinate}:`,
                '',
                ...inputs
                    .readText(id)
                    .split('\n')
                    .map((line) => (line ? `    ${line}` : '')),
                '',
            );
        }
    }
    const orphans = Object.keys(inputs.notices).filter((coordinate) => !rendered.has(coordinate));
    if (orphans.length > 0) {
        throw new Error(`No scripts/licenses/android.json component for the vendored NOTICE of ${orphans.join(', ')}`);
    }
    return lines;
};

const renderNotices = (inputs: NoticeInputs) => {
    const usedTexts = new Set<string>(['Apache-2.0', 'PDDL-1.0']);
    const npm = renderNpmPackages(inputs, usedTexts);
    const out: string[] = [
        ...NOTICE_HEADER,
        ...heading('1. GuruShotsAutoVote'),
        inputs.projectLicense,
        '',
        ...heading('2. Desktop shell'),
        "The desktop app is built on Electron. Electron's license (MIT) and the license list of the",
        'Chromium components it contains ship with the app as LICENSE.electron.txt and',
        'LICENSES.chromium.html in its resources directory.',
        '',
        ...npm.lines,
        ...renderLgplSection(npm.libvips),
        ...renderRuntimesSection(inputs),
        ...renderAndroidSection(inputs, usedTexts),
        ...heading('7. License texts'),
    ];
    for (const id of [...usedTexts].sort()) out.push(...rule(id), inputs.readText(id), '');

    return `${out.join('\n').replace(/\n+$/, '')}\n`;
};

/** `name = 'value'` assignments of an ext block (android/variables.gradle). */
const parseGradleVariables = (text: string) => {
    const variables: Record<string, string> = {};
    for (const match of text.matchAll(/^\s*(\w+)\s*=\s*'([^']*)'/gm)) variables[match[1]] = match[2];
    return variables;
};

interface MainOptions {
    lockPath?: string;
    licensesDir?: string;
    androidVariablesPath?: string;
    licensePath?: string;
    outPath?: string;
}

const main = ({
    lockPath = path.join(ROOT, 'pnpm-lock.yaml'),
    licensesDir = path.join(__dirname, 'licenses'),
    androidVariablesPath = path.join(ROOT, 'android', 'variables.gradle'),
    licensePath = path.join(ROOT, 'LICENSE'),
    outPath = path.join(ROOT, 'src', 'assets', 'THIRD_PARTY_NOTICES.txt'),
}: MainOptions = {}) => {
    const packages = collectPackages(parseLockfile(fs.readFileSync(lockPath, 'utf8')));
    const onnxruntime = packages.find((pkg) => pkg.name === 'onnxruntime-node');
    if (!onnxruntime || onnxruntime.version !== ONNXRUNTIME_TEXTS_VERSION) {
        throw new Error(
            `The vendored ONNX Runtime texts are for ${ONNXRUNTIME_TEXTS_VERSION}, but the lockfile has ` +
                `${onnxruntime?.version ?? 'no onnxruntime-node'}: vendor that release's LICENSE and ThirdPartyNotices.`,
        );
    }
    const textsDir = path.join(licensesDir, 'texts');
    const notices = loadNoticeFiles(path.join(licensesDir, 'notices.json'));
    const named = new Set(Object.values(notices));
    const unnamed = fs
        .readdirSync(textsDir)
        .filter((file) => file.startsWith(NOTICE_ID_PREFIX) && file.endsWith('.txt'))
        .map((file) => file.slice(0, -'.txt'.length))
        .filter((id) => !named.has(id));
    if (unnamed.length > 0) {
        throw new Error(`scripts/licenses/notices.json names no artifact for the vendored ${unnamed.join(', ')}`);
    }
    const text = renderNotices({
        projectLicense: fs.readFileSync(licensePath, 'utf8').trimEnd(),
        packages,
        licenses: loadLicenses(path.join(licensesDir, 'packages.json')),
        android: loadAndroidComponents(path.join(licensesDir, 'android.json')),
        androidVersions: parseGradleVariables(fs.readFileSync(androidVariablesPath, 'utf8')),
        onnxruntimeVersion: onnxruntime.version,
        notices,
        readText: (id) => readLicenseText(id, textsDir),
    });
    fs.writeFileSync(outPath, text);
    console.log(`✅ Notices: ${packages.length} npm packages → ${path.relative(ROOT, outPath)}`);
};

runIfMain(require.main, module, main);

export {
    BUNDLED_DEV_DEPENDENCIES,
    NODE_LICENSE_VERSION,
    ONNXRUNTIME_TEXTS_VERSION,
    collectPackages,
    loadAndroidComponents,
    loadLicenses,
    loadNoticeFiles,
    lookupLicense,
    main,
    parseGradleVariables,
    parseLockfile,
    renderNotices,
};
export type { AndroidComponent, LicenseEntry, PackageRef };
