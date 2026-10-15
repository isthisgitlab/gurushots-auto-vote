/**
 * Temporary bridge: the file on disk is still the 1.x `settings.json`, while the code reads and writes the 2.x setting
 * names. B1b replaces this module with the `config.json` import.
 *
 * `toCurrentNames` renames a loaded blob's keys everywhere a setting key can sit (top level, `globalDefaults`, each
 * `perChallenge` set, each profile, each rule, each scenario phase's `settings`); `toStoredNames` maps them back so the
 * file never holds a 2.x name. `withoutCurrentNames` removes the 2.x names a hand-edited file may hold, which 1.x
 * never read.
 */

import { isPlainObject } from '../plainObject';
import { V1_KEY_RENAMES, renameV1ScenarioDocument, renameV1Value } from './importV1/renames';

type KeyMapper = {
    values: (value: unknown) => unknown;
    scenario: (doc: unknown) => unknown;
};

const V1_KEY_OF: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(V1_KEY_RENAMES).map(([v1, current]) => [current, v1]),
);

const storedKeys = (value: unknown): unknown =>
    isPlainObject(value)
        ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [Object.hasOwn(V1_KEY_OF, key) ? V1_KEY_OF[key] : key, item]),
          )
        : value;

const storedScenario = (doc: unknown): unknown => {
    if (!isPlainObject(doc) || !isPlainObject(doc.phases)) return doc;
    const phases = Object.fromEntries(
        Object.entries(doc.phases).map(([name, phase]) => [
            name,
            isPlainObject(phase) && isPlainObject(phase.settings)
                ? { ...phase, settings: storedKeys(phase.settings) }
                : phase,
        ]),
    );
    return { ...doc, phases };
};

const TO_CURRENT: KeyMapper = {
    values: (value) => renameV1Value(value, 'keep-lone-targets'),
    scenario: (doc) => renameV1ScenarioDocument(doc, 'keep-lone-targets'),
};

const TO_STORED: KeyMapper = { values: storedKeys, scenario: storedScenario };

// A 2.x name in a 1.x file is inert: dropped from every map, and from a scenario phase it makes the document refused,
// as 1.x refused it. Renaming with `drop-targets` and back leaves the 1.x names and nothing else changed.
const WITHOUT_CURRENT: KeyMapper = {
    values: (value) => storedKeys(renameV1Value(value, 'drop-targets')),
    scenario: (doc) => storedScenario(renameV1ScenarioDocument(doc, 'drop-targets')),
};

const CURRENT_NAME_IN_TEXT = new RegExp(`"(${Object.values(V1_KEY_RENAMES).join('|')})"`);

const mapEach = (map: unknown, convert: (item: unknown) => unknown): unknown =>
    isPlainObject(map) ? Object.fromEntries(Object.entries(map).map(([key, item]) => [key, convert(item)])) : map;

const mapBlob = <T extends object>(blob: T, mapper: KeyMapper): T => {
    const top = mapper.values(blob);
    if (!isPlainObject(top) || !isPlainObject(top.challengeSettings)) return top as T;
    const challengeSettings: Record<string, unknown> = { ...top.challengeSettings };
    const convert = (field: string, convertField: (value: unknown) => unknown) => {
        if (Object.hasOwn(challengeSettings, field)) challengeSettings[field] = convertField(challengeSettings[field]);
    };
    convert('globalDefaults', mapper.values);
    convert('perChallenge', (value) => mapEach(value, mapper.values));
    convert('titleRules', (value) => (Array.isArray(value) ? value.map(mapper.values) : value));
    convert('profiles', (value) => mapEach(value, mapper.values));
    convert('scenarios', (value) => mapEach(value, mapper.scenario));
    return { ...top, challengeSettings } as T;
};

/** The parsed `settings.json` (the `raw` text it came from) without the 2.x setting names it holds, or itself when none. */
const withoutCurrentNames = <T extends object>(parsed: T, raw: string): T =>
    CURRENT_NAME_IN_TEXT.test(raw) ? mapBlob(parsed, WITHOUT_CURRENT) : parsed;

/** A copy of the blob read from `settings.json` with the 1.x setting keys renamed to their current names. */
const toCurrentNames = <T extends object>(blob: T): T => mapBlob(blob, TO_CURRENT);

/** A copy of the blob with the current setting keys renamed back to the 1.x names `settings.json` holds. */
const toStoredNames = <T extends object>(blob: T): T => mapBlob(blob, TO_STORED);

export { toCurrentNames, toStoredNames, withoutCurrentNames };
