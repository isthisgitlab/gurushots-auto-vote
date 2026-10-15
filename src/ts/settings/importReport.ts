/**
 * What the live settings refuse of an imported configuration. The importer lists the references that name nothing
 * (a profile or scenario that is not stored); this adds the ones that name something the live validators reject: a
 * rule's profile that fails whole-set validation (so a rule resolves no profile) and a `scenario` value whose stored
 * scenario fails validation (so it resolves no scenario). Both stay as stored and block as they did before the import.
 * Entries are paths and names only, in the format the importer documents (types/config.ts).
 */

import { isPlainObject } from '../plainObject';
import { challengePath, quoted } from './importV1/convert';
import { dropInvalidValues, mergeWithDefaults } from './loadValidation';
import { normalizeProfileName } from './profileStore';
import { profileFromMatches } from './ruleResolution';
import { findStoredScenario } from './scenarioLookup';

import type { ConfigV2, StoredConfigV2 } from '../types/config';

/**
 * The references of a converted configuration that its live reading refuses and the importer did not list.
 *
 * @param known - the entries the importer listed already
 */
const invalidReferences = (converted: StoredConfigV2, known: readonly string[]): string[] => {
    // What a load of the stored configuration would hold: filled over the defaults and stripped of invalid values.
    const config: ConfigV2 = mergeWithDefaults(structuredClone(converted));
    dropInvalidValues(config);
    const refs: string[] = [];
    const add = (ref: string) => {
        if (!known.includes(ref) && !refs.includes(ref)) refs.push(ref);
    };
    const scenarioOf = (path: string, values: unknown) => {
        const name = isPlainObject(values) ? values.scenario : undefined;
        if (typeof name === 'string' && normalizeProfileName(name) !== '' && !findStoredScenario(config, name)) {
            add(`${path}.scenario: ${quoted(name)}`);
        }
    };
    for (const [name, values] of Object.entries(config.profiles))
        scenarioOf(`profiles[${JSON.stringify(name)}]`, values);
    config.rules.forEach((rule, index) => {
        scenarioOf(`rules[${index}]`, rule);
        const profile = isPlainObject(rule) ? rule.profile : undefined;
        if (
            typeof profile === 'string' &&
            normalizeProfileName(profile) !== '' &&
            !profileFromMatches(config, [rule])
        ) {
            add(`rules[${index}].profile: ${quoted(profile)}`);
        }
    });
    for (const [id, record] of Object.entries(config.challenges))
        scenarioOf(`${challengePath(id)}.values`, record.values);
    return refs;
};

export { invalidReferences };
