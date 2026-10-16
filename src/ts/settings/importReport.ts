/**
 * What the live settings refuse of an imported configuration. The importer lists the references that name nothing
 * (a profile or scenario that is not stored); this adds the ones that name something the live validators reject: a
 * rule's profile that fails whole-set validation (so a rule resolves no profile) and a `scenario` value whose stored
 * scenario fails validation (so it resolves no scenario). Both stay as stored and block as they did before the import.
 * Entries are the structured references the importer lists (types/config.ts), marked `invalid`.
 */

import { isPlainObject } from '../plainObject';
import { challengeHolder, profileHolder, refTo, ruleHolder } from './importV1/convert';
import { dropInvalidValues, mergeWithDefaults } from './loadValidation';
import { normalizeProfileName } from './profileStore';
import { profileFromMatches } from './ruleResolution';
import { findStoredScenario } from './scenarioLookup';

import type { ConfigV2, ImportRef, ImportRefHolder, StoredConfigV2 } from '../types/config';

// Two references are the same when they name the same thing in the same place, whether or not it is also invalid.
const sameRef = (a: ImportRef, b: ImportRef): boolean =>
    a.refers === b.refers && a.name === b.name && JSON.stringify(a.holder) === JSON.stringify(b.holder);

/**
 * The references of a converted configuration that its live reading refuses and the importer did not list.
 *
 * @param known - the entries the importer listed already
 * @param titles - the challenge titles the import knew (the title pins), by challenge id
 */
const invalidReferences = (
    converted: StoredConfigV2,
    known: ReadonlyArray<string | ImportRef>,
    titles: Readonly<Record<string, string>>,
): ImportRef[] => {
    // What a load of the stored configuration would hold: filled over the defaults and stripped of invalid values.
    const config: ConfigV2 = mergeWithDefaults(structuredClone(converted));
    dropInvalidValues(config);
    const refs: ImportRef[] = [];
    const add = (ref: ImportRef) => {
        if (![...known, ...refs].some((other) => typeof other !== 'string' && sameRef(other, ref))) refs.push(ref);
    };
    const scenarioOf = (holder: ImportRefHolder, values: unknown) => {
        const name = isPlainObject(values) ? values.scenario : undefined;
        if (typeof name === 'string' && normalizeProfileName(name) !== '' && !findStoredScenario(config, name)) {
            add(refTo(holder, 'scenario', name, true));
        }
    };
    for (const [name, values] of Object.entries(config.profiles)) scenarioOf(profileHolder(name), values);
    config.rules.forEach((rule, index) => {
        const holder = ruleHolder(rule, index);
        scenarioOf(holder, rule);
        const profile = isPlainObject(rule) ? rule.profile : undefined;
        if (
            typeof profile === 'string' &&
            normalizeProfileName(profile) !== '' &&
            !profileFromMatches(config, [rule])
        ) {
            add(refTo(holder, 'profile', profile, true));
        }
    });
    for (const [id, record] of Object.entries(config.challenges))
        scenarioOf(challengeHolder(id, titles), record.values);
    return refs;
};

export { invalidReferences };
