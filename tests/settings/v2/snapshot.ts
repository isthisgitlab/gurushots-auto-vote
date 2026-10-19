/**
 * Everything a reader (the oracle or the live code) answers for one file and its environment, as one JSON-able tree,
 * and the comparison of two such trees. The tree is built with the same calls whoever answers them, so the oracle's
 * tree is the expected one for the live code and, written down, the golden output.
 *
 * The values a challenge resolves to are stored as what differs from the global read (and a ledger state's values as
 * what differs from no state), which loses nothing when both trees are compared and keeps the golden file readable.
 */

import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';

import type { LedgerEntry, OracleEnv, V1Oracle } from '../../helpers/v1Oracle';
import type { MatchTarget } from '../../helpers/v1Oracle/ruleMatching';
import type { Case } from './random';

type Tree = { [key: string]: unknown };

// Deep equality of two JSON-like values. Not `node:util`'s, which also compares prototypes: the arrays and objects a
// module cloned with `structuredClone` come from another realm than the ones the test made.
const isEqual = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const left = a as Tree;
    const right = b as Tree;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => Object.hasOwn(right, key) && isEqual(left[key], right[key]))
    );
};

/** How a reader spells setting keys: the oracle's own, or the live code's (`liveKey`). */
type Naming = { toReader: (v1Key: string) => string; fromReader: (readerKey: string) => string };

const OWN_NAMES: Naming = { toReader: (key) => key, fromReader: (key) => key };

const KEYS = Object.keys(V1_SETTINGS_SCHEMA);
const TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];
// The keys the join and photo-pick code asks the join resolution for, and the ones with a layer of their own in it.
const JOIN_KEYS = [
    'autoJoin',
    'autoJoinTypes',
    'autoJoinExcludeTypes',
    'autoJoinChallengeTags',
    'autoJoinExcludeChallengeTags',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
    'autoJoinMaxCoins',
    'autoJoinCycleCoinBudget',
    'chosenPhotos',
    'chosenPhotosOnly',
    'chosenPhotosInOrder',
    'manualPhotosOnly',
    'autoFill',
    'fillWithoutTagMatch',
    'mustIncludeTags',
    'shouldIncludeTags',
    'ignoreTitleWords',
    'scenario',
    'exposure',
];

/** The ledger states one challenge is read under, besides having none. */
type Variants = Record<string, Array<{ label: string; entry: LedgerEntry }>>;

/**
 * The ledger states worth reading each challenge under: for a challenge whose assigned scenario the oracle can run,
 * unreadable state of three kinds, a state of another scenario, each phase, a phase that is gone, and the scenario's
 * name in other spellings.
 */
const variantsFor = (oracle: V1Oracle, challenges: MatchTarget[]): Variants => {
    const scenarios = oracle.scenarios();
    const variants: Variants = {};
    for (const challenge of challenges) {
        const id = String(challenge.id);
        const { assigned, scenario } = oracle.scenarioStatus(id);
        const found = scenario === null ? undefined : scenarios[scenario];
        if (!found || scenario === null) continue;
        const state = (name: string, phase: string): LedgerEntry => ({
            corrupt: false,
            state: { scenario: name, phase },
        });
        variants[id] = [
            { label: 'corrupt:file', entry: { corrupt: 'file', state: null } },
            { label: 'corrupt:record', entry: { corrupt: 'record', state: null } },
            { label: 'corrupt:unloaded', entry: { corrupt: 'unloaded', state: null } },
            { label: 'other scenario', entry: state('Some Other Plan', found.start) },
            { label: 'phase gone', entry: state(scenario, 'removed') },
            { label: 'name upper-cased', entry: state(scenario.toUpperCase(), found.start) },
            { label: 'name padded', entry: state(` ${scenario} `, found.start) },
            { label: 'assigned spelling', entry: state(assigned, found.start) },
            ...Object.keys(found.phases).map((phase) => ({ label: `phase ${phase}`, entry: state(scenario, phase) })),
        ];
    }
    return variants;
};

const sparse = (values: Tree, base: Tree): Tree =>
    Object.fromEntries(Object.entries(values).filter(([key, value]) => !isEqual(value, base[key])));

type Counter = { calls: number };

/**
 * Ask a reader everything: the values of every key for the global read, every challenge (under every ledger state)
 * and every target, and each of the other decisions.
 */
const snapshot = (
    reader: V1Oracle,
    c: Case,
    env: OracleEnv,
    variants: Variants,
    naming: Naming,
    counter: Counter,
): Tree => {
    const call = <T>(fn: () => T): T => {
        counter.calls += 1;
        return fn();
    };
    const named = (values: Tree): Tree =>
        Object.fromEntries(Object.entries(values).map(([key, value]) => [naming.fromReader(key), value]));
    const effectiveAll = (id: string | null): Tree =>
        Object.fromEntries(KEYS.map((key) => [key, call(() => reader.effective(naming.toReader(key), id))]));
    const profileOf = (profile: { name: string; values: Tree } | null) =>
        profile ? { name: profile.name, values: named(profile.values) } : null;
    const ruleValues = (target: MatchTarget | string, suppress: boolean) => {
        const info = call(() => reader.ruleValues(target, suppress));
        return { values: named(info.values), sources: named(info.sources), profile: profileOf(info.profile) };
    };
    const tagsOf = (challenge: MatchTarget, values: Tree): Tree => {
        const words = call(() => reader.ignoreTitleWords(challenge));
        return {
            ...Object.fromEntries(
                TAG_KEYS.map((key) => [key, call(() => reader.ruleTags(naming.toReader(key), challenge))]),
            ),
            ignoreTitleWords: isEqual(words, values.ignoreTitleWords) ? 'same as the value' : words,
        };
    };

    const globalValues = effectiveAll(null);
    const tree: Tree = {
        global: {
            values: globalValues,
            anyRuleEnablesAutoJoin: call(() => reader.anyRuleEnablesAutoJoin()),
            autoJoinActive: call(() => reader.autoJoinActive()),
            scenarios: Object.fromEntries(
                Object.entries(call(() => reader.scenarios())).map(([name, found]) => [
                    name,
                    {
                        start: found.start,
                        phases: Object.fromEntries(
                            Object.entries(found.phases).map(([phase, keys]) => [
                                phase,
                                keys.map((key) => naming.fromReader(key)).sort(),
                            ]),
                        ),
                    },
                ]),
            ),
            profiles: Object.fromEntries(
                Object.entries(call(() => reader.profiles())).map(([name, values]) => [name, named(values)]),
            ),
        },
    };

    const challenges: Tree = {};
    for (const challenge of [...c.challenges, ...c.offList.map((id): MatchTarget => ({ id }))]) {
        const id = String(challenge.id);
        if (Object.hasOwn(challenges, id)) continue;
        const title = typeof challenge.title === 'string' ? challenge.title : '';
        const values = effectiveAll(id);
        const record: Tree = {
            title: call(() => reader.titleOf(id)),
            values: sparse(values, globalValues),
            tags: tagsOf(challenge, values),
            overrides: named(call(() => reader.challengeOverrides(id))),
            customization: call(() => reader.customization(id, title)),
            titleProfile: (({ profile, suppressed, ruleValues: rv, inlineValues, ruleSources, inlineSources }) => ({
                profile: profileOf(profile),
                suppressed,
                ruleValues: named(rv),
                inlineValues: named(inlineValues),
                ruleSources: named(ruleSources),
                inlineSources: named(inlineSources),
            }))(call(() => reader.titleProfile(title, id))),
            entryPin: call(() => reader.entryPin(id)),
            scenario: call(() => reader.scenarioStatus(id)),
        };
        const states: Tree = {};
        const noneTags = record.tags as Tree;
        for (const { label, entry } of variants[id] ?? []) {
            env.ledger[id] = entry;
            const underState = effectiveAll(id);
            states[label] = {
                scenario: call(() => reader.scenarioStatus(id)),
                values: sparse(underState, values),
                tags: sparse(tagsOf(challenge, underState), noneTags),
            };
            delete env.ledger[id];
        }
        if (Object.keys(states).length > 0) record.ledger = states;
        challenges[id] = record;
    }
    tree.challenges = challenges;

    const titles = new Set(
        [...c.challenges, ...c.candidates].map((target) => (typeof target.title === 'string' ? target.title : '')),
    );
    const targets: Tree = {};
    const objectTargets: Array<[string, MatchTarget]> = [
        ...c.challenges.map((target): [string, MatchTarget] => [`challenge ${String(target.id)}`, target]),
        ...c.candidates.map((target, index): [string, MatchTarget] => [
            `candidate ${String(target.id ?? index)}`,
            target,
        ]),
    ];
    for (const [label, target] of objectTargets) {
        const joinKeys = [
            ...JOIN_KEYS,
            ...Object.keys(call(() => reader.ruleValues(target)).values).map(naming.fromReader),
        ];
        const join = Object.fromEntries(
            [...new Set(joinKeys)].map((key) => [key, call(() => reader.joinSetting(naming.toReader(key), target))]),
        );
        targets[label] = {
            ruleValues: ruleValues(target, false),
            inlineValues: ruleValues(target, true),
            ruleProfile: profileOf(call(() => reader.ruleProfile(target))),
            joinOptIn: call(() => reader.ruleJoinOptIn(target)),
            join: sparse(join, globalValues),
        };
    }
    for (const title of titles) {
        targets[`title ${JSON.stringify(title)}`] = {
            ruleValues: ruleValues(title, false),
            inlineValues: ruleValues(title, true),
        };
    }
    tree.targets = targets;
    return tree;
};

type Mismatch = { path: string; oracle: unknown; live: unknown };

/**
 * The leaves where two trees differ (at most `limit`), and how many leaves were compared.
 */
const diffTrees = (expected: unknown, actual: unknown, limit = 8): { mismatches: Mismatch[]; compared: number } => {
    const mismatches: Mismatch[] = [];
    let compared = 0;
    const walk = (path: string, a: unknown, b: unknown) => {
        if (mismatches.length >= limit) return;
        const bothObjects = typeof a === 'object' && a !== null && typeof b === 'object' && b !== null;
        if (bothObjects && Array.isArray(a) === Array.isArray(b) && !Array.isArray(a)) {
            const left = a as Tree;
            const right = b as Tree;
            for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
                walk(path ? `${path}.${key}` : key, left[key], right[key]);
            }
            return;
        }
        compared += 1;
        if (!isEqual(a, b)) mismatches.push({ path, oracle: a, live: b });
    };
    walk('', expected, actual);
    return { mismatches, compared };
};

export { diffTrees, OWN_NAMES, snapshot, variantsFor };
export type { Counter, Naming, Tree };
