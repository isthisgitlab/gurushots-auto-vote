/**
 * The resolver older builds ran and the live code must agree. For every fixture file and every seeded random file, the oracle (a
 * frozen copy of that resolver, tests/helpers/v1Oracle) and the live code are asked the same questions: the value of
 * every setting for the global read and for every challenge, under every state of the scenario ledger (none, each
 * phase of the assigned scenario, unreadable, another scenario's, a phase that is gone), the rules, profile and
 * join decisions for every challenge and candidate, the photo tags, the customization badges, the scenario status and
 * the pins. The live code upgrades from the file the way the app does (`liveFromV1Raw`: the format-1 file where
 * `settings.json` lives, no `config.json`, the one-time import on the first read), which proves the import loses
 * nothing resolution depends on. Linked exposure is a current resolver policy change. The exact differences for
 * these fixtures are checked separately against the frozen resolver.
 *
 * `V2_SEEDS` overrides the random files for local exploration: a comma list of seeds and ranges, e.g.
 * `V2_SEEDS=7,100-140 pnpm jest tests/settings/v2/equivalence`. A failure names the seed.
 */

import { TOP_LEVEL_ONLY_KEYS } from '../../../src/ts/core/settings/importV1/convert';
import { V1_SETTINGS_SCHEMA } from '../../../src/ts/core/settings/importV1/schema';
import { createV1Oracle } from '../../helpers/v1Oracle';
import { FIXTURES } from './fixtures';
import { liveFromV1Raw, liveKey, releaseLive } from './liveAdapter';
import { parseSeeds, randomCase } from './random';
import { diffTrees, OWN_NAMES, snapshot, variantsFor } from './snapshot';
import { CANDIDATES, CHALLENGES, NOW } from './fixtures/types';

import type { OracleEnv } from '../../helpers/v1Oracle';
import type { Case } from './random';
import type { Fixture } from './fixtures/types';
import type { Counter, Naming, Tree } from './snapshot';

const DEFAULT_SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);

/** The file the oracle reads for a fixture: the file itself, or with the zone the fixture names for it. */
const oracleRawOf = (fixture: Fixture): string =>
    typeof fixture.blob === 'string'
        ? fixture.blob
        : JSON.stringify(
              fixture.oracleTimezone === undefined
                  ? fixture.blob
                  : { ...fixture.blob, timezone: fixture.oracleTimezone },
          );

const fixtureCases: Case[] = FIXTURES.map((fixture) => ({
    name: fixture.name,
    raw: typeof fixture.blob === 'string' ? fixture.blob : JSON.stringify(fixture.blob),
    oracleRaw: oracleRawOf(fixture),
    challenges: fixture.challenges ?? CHALLENGES,
    offList: fixture.offList ?? [],
    candidates: fixture.candidates ?? CANDIDATES,
}));
const randomCases: Case[] = parseSeeds(process.env.V2_SEEDS, DEFAULT_SEEDS).map(randomCase);

const KEY_OF_LIVE: Record<string, string> = Object.fromEntries(
    Object.keys(V1_SETTINGS_SCHEMA).map((key) => [liveKey(key), key]),
);
const LIVE_NAMES: Naming = { toReader: liveKey, fromReader: (key) => KEY_OF_LIVE[key] ?? key };

/**
 * A tree without the global reads of the app-state keys format 1 kept at the top level (`autovoteRunning`,
 * `skipUpdateVersion`, ...). It read each from there alone; the copy among the global defaults that the oracle still
 * resolves was never read by anything, so the import does not carry it and the live code resolves the schema default.
 * Everything else is compared as it is.
 */
const withoutAppState = (tree: Tree): Tree => {
    const global = tree.global as Tree;
    // Sound to skip: no code resolves these keys through the resolver (they are read from `app`), so the copy is dead.
    const values = Object.fromEntries(
        Object.entries(global.values as Tree).filter(([key]) => !TOP_LEVEL_ONLY_KEYS.has(key)),
    );
    return { ...tree, global: { ...global, values } };
};

const environment = (c: Case): OracleEnv => ({ now: NOW, challenges: c.challenges, ledger: {} });

const totals = { comparisons: 0, leaves: 0, startedAt: Date.now() };

const linkedProfileDifferences = (): Tree => {
    const differences: Tree = {
        'global.profiles.BadPair.exposureTarget': 50,
        'challenges.101.values.exposure': 90,
        'challenges.101.values.exposureTarget': 90,
        'challenges.102.values.exposure': 80,
    };
    const profiles = [
        { name: 'Conflict', title: 'Macro World', index: 1, challenge: 101, candidate: 901, values: { exposure: 90 } },
        {
            name: 'BadPair',
            title: 'Night Sky',
            index: 2,
            challenge: 102,
            candidate: 903,
            values: { exposure: 80, exposureTarget: 50 },
        },
    ];
    for (const { name, title, index, challenge, candidate, values } of profiles) {
        const profile = { name, values };
        const source = { title, index, viaProfile: true };
        const challengePath = `challenges.${challenge}`;
        differences[`${challengePath}.customization`] = 'profile';
        differences[`${challengePath}.titleProfile.profile`] = profile;
        for (const [key, value] of Object.entries(values)) {
            differences[`${challengePath}.titleProfile.ruleValues.${key}`] = value;
            differences[`${challengePath}.titleProfile.ruleSources.${key}`] = source;
        }
        const targets = [`challenge ${challenge}`, `candidate ${candidate}`];
        for (const target of [...targets, `title "${title}"`, ...(index === 2 ? ['title "night sky"'] : [])]) {
            const targetPath = `targets.${target}`;
            differences[`${targetPath}.ruleValues.profile`] = profile;
            for (const [key, value] of Object.entries(values)) {
                differences[`${targetPath}.ruleValues.values.${key}`] = value;
                differences[`${targetPath}.ruleValues.sources.${key}`] = source;
            }
        }
        for (const target of targets) {
            differences[`targets.${target}.ruleProfile`] = profile;
            differences[`targets.${target}.joinOptIn`] = true;
            for (const [key, value] of Object.entries(values)) differences[`targets.${target}.join.${key}`] = value;
        }
    }
    return differences;
};

const linkedExposureDifferences: Record<string, Tree> = {
    'both sentinel families': { 'challenges.104.values.finalWindowExposure': 30 },
    'profiles that fail as a whole: a conflict with an inherited value, a bad pair, a bad value, a big one':
        linkedProfileDifferences(),
    'seed 9': { 'challenges.201.values.exposure': 79 },
    'seed 13': Object.fromEntries(
        [200, 201, 202, 203, 290, 291, 299].map((id) => [`challenges.${id}.values.exposureTarget`, 100]),
    ),
    'seed 21': { 'global.profiles.day.exposureTarget': 22 },
    'seed 30': { 'challenges.202.values.exposure': 6 },
};

const equivalence = (c: Case) => {
    const oracleEnv = environment(c);
    const oracle = createV1Oracle(c.oracleRaw ?? c.raw, oracleEnv);
    const variants = variantsFor(oracle, c.challenges);
    const expected = snapshot(oracle, c, oracleEnv, variants, OWN_NAMES, { calls: 0 });
    const liveEnv = environment(c);
    const counter: Counter = { calls: 0 };
    const actual = snapshot(liveFromV1Raw(c.raw, liveEnv), c, liveEnv, variants, LIVE_NAMES, counter);
    const expectedDifferences = linkedExposureDifferences[c.name] ?? {};
    const { mismatches, compared } = diffTrees(
        withoutAppState(expected),
        withoutAppState(actual),
        Object.keys(expectedDifferences).length + 8,
    );
    totals.comparisons += counter.calls;
    totals.leaves += compared;
    expect(Object.fromEntries(mismatches.map(({ path, live }) => [path, live]))).toStrictEqual(expectedDifferences);
};

describe('the live resolver against the frozen oracle', () => {
    test('the tree comparison reports a missing key even when its value was undefined', () => {
        expect(diffTrees({ field: undefined }, {})).toStrictEqual({
            mismatches: [{ path: 'field', oracle: undefined, live: undefined }],
            compared: 1,
        });
    });
    afterAll(() => {
        releaseLive();
        process.stdout.write(
            `\nequivalence: ${totals.comparisons} reader calls compared in ${totals.leaves} leaves, ${Date.now() - totals.startedAt} ms\n`,
        );
    });

    describe('hand-written fixtures', () => {
        test.each(fixtureCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
            equivalence(c);
        });
    });

    describe('seeded random files', () => {
        test.each(randomCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
            equivalence(c);
        });
    });
});

describe('the hand-written fixtures exercise what they claim', () => {
    test.each(FIXTURES.filter((fixture) => fixture.check))('%s', (fixture) => {
        const env: OracleEnv = { now: NOW, challenges: fixture.challenges ?? CHALLENGES, ledger: {} };
        fixture.check?.(createV1Oracle(oracleRawOf(fixture), env));
    });
});
