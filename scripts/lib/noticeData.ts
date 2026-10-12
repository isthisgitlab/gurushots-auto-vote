/**
 * The curated license data the notices generator reads (`scripts/licenses/packages.json` and `android.json`), with
 * the shape each entry must have: a file that does not match fails the build instead of rendering a partial notice.
 */

import fs from 'node:fs';
import { isPlainObject } from '../../src/ts/plainObject';

/** One packages.json entry: the SPDX expression shown, the vendored text ids that apply, copyright lines. */
interface LicenseEntry {
    license: string;
    texts: string[];
    copyright: string[];
    /** Where the source of this version lives; `{version}` is replaced. */
    source?: string;
}

/** One android.json entry: a native library group the Android app ships. */
interface AndroidComponent {
    name: string;
    /** `group:artifact`, or a pattern ending in `*` for every coordinate that starts with the rest (`androidx.*`, `group:prefix-*`). */
    coordinates: string[];
    license: string;
    copyright: string;
    /** An attribution line the library's license asks to travel with it, shown after the copyright. */
    attribution?: string;
    url: string;
    /** The android/variables.gradle variable holding the version. */
    versionVariable?: string;
    /** Pulled in by another library rather than declared by the app. */
    transitive?: boolean;
}

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const isLicenseEntry = (value: unknown): value is LicenseEntry =>
    isPlainObject(value) &&
    typeof value.license === 'string' &&
    isStringArray(value.texts) &&
    isStringArray(value.copyright) &&
    (value.source === undefined || typeof value.source === 'string');

const isAndroidComponent = (value: unknown): value is AndroidComponent =>
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    isStringArray(value.coordinates) &&
    typeof value.license === 'string' &&
    typeof value.copyright === 'string' &&
    (value.attribution === undefined || typeof value.attribution === 'string') &&
    typeof value.url === 'string' &&
    (value.versionVariable === undefined || typeof value.versionVariable === 'string') &&
    (value.transitive === undefined || typeof value.transitive === 'boolean');

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Reads and validates scripts/licenses/packages.json. */
const loadLicenses = (file: string): Record<string, LicenseEntry> => {
    const data = readJson(file);
    if (!isPlainObject(data)) throw new Error(`${file} must hold a JSON object`);
    const licenses: Record<string, LicenseEntry> = {};
    for (const [name, entry] of Object.entries(data)) {
        if (!isLicenseEntry(entry)) throw new Error(`${file}: invalid entry for ${name}`);
        licenses[name] = entry;
    }
    return licenses;
};

/** Reads and validates scripts/licenses/android.json. */
const loadAndroidComponents = (file: string): AndroidComponent[] => {
    const data = readJson(file);
    if (!Array.isArray(data) || !data.every(isAndroidComponent)) throw new Error(`${file}: invalid component list`);
    return data;
};

export { loadAndroidComponents, loadLicenses };
export type { AndroidComponent, LicenseEntry };
