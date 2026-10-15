/**
 * The 1.x resolver and the live code must agree. For every fixture file and every seeded random file, the oracle (a
 * frozen copy of the 1.x resolver, tests/helpers/v1Oracle) and the live code are asked the same questions: the value of
 * every setting for the global read and for every challenge, under every state of the scenario ledger (none, each
 * phase of the assigned scenario, unreadable, another scenario's, a phase that is gone), the rules, profile and
 * join decisions for every challenge and candidate, the photo tags, the customization badges, the scenario status and
 * the pins. The live code reads the file twice: as it is (`liveFromV1Raw`) and as `importV1Settings` made it
 * (`liveViaImporter`), which proves the importer loses nothing resolution depends on.
 *
 * `V2_SEEDS` overrides the random files for local exploration: a comma list of seeds and ranges, e.g.
 * `V2_SEEDS=7,100-140 pnpm jest tests/settings/v2/equivalence`. A failure names the seed.
 */

import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';
import { createV1Oracle } from '../../helpers/v1Oracle';
import { FIXTURES } from './fixtures';
import { liveFromV1Raw, liveKey, liveViaImporter, releaseLive } from './liveAdapter';
import { parseSeeds, randomCase } from './random';
import { diffTrees, OWN_NAMES, snapshot, variantsFor } from './snapshot';
import { CANDIDATES, CHALLENGES, NOW } from './fixtures/types';

import type { OracleEnv, V1Oracle } from '../../helpers/v1Oracle';
import type { Case } from './random';
import type { Counter, Naming } from './snapshot';

const DEFAULT_SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);

const fixtureCases: Case[] = FIXTURES.map((fixture) => ({
    name: fixture.name,
    raw: typeof fixture.blob === 'string' ? fixture.blob : JSON.stringify(fixture.blob),
    challenges: fixture.challenges ?? CHALLENGES,
    offList: fixture.offList ?? [],
    candidates: fixture.candidates ?? CANDIDATES,
}));
const randomCases: Case[] = parseSeeds(process.env.V2_SEEDS, DEFAULT_SEEDS).map(randomCase);

const KEY_OF_LIVE: Record<string, string> = Object.fromEntries(
    Object.keys(V1_SETTINGS_SCHEMA).map((key) => [liveKey(key), key]),
);
const LIVE_NAMES: Naming = { toReader: liveKey, fromReader: (key) => KEY_OF_LIVE[key] ?? key };

const environment = (c: Case): OracleEnv => ({ now: NOW, challenges: c.challenges, ledger: {} });

const CONSTRUCTORS: Array<[string, (raw: string, env: OracleEnv) => V1Oracle]> = [
    ['live code reading the file', liveFromV1Raw],
    ['live code reading what the importer made of it', liveViaImporter],
];

const totals = { comparisons: 0, leaves: 0, startedAt: Date.now() };

const equivalence = (c: Case) => {
    const oracleEnv = environment(c);
    const oracle = createV1Oracle(c.raw, oracleEnv);
    const variants = variantsFor(oracle, c.challenges);
    const expected = snapshot(oracle, c, oracleEnv, variants, OWN_NAMES, { calls: 0 });
    for (const [label, construct] of CONSTRUCTORS) {
        const liveEnv = environment(c);
        const counter: Counter = { calls: 0 };
        const actual = snapshot(construct(c.raw, liveEnv), c, liveEnv, variants, LIVE_NAMES, counter);
        const { mismatches, compared } = diffTrees(expected, actual);
        totals.comparisons += counter.calls;
        totals.leaves += compared;
        if (mismatches.length > 0) {
            const lines = mismatches.map(
                ({ path, oracle: want, live }) =>
                    `  ${path}\n    oracle ${JSON.stringify(want)}\n    live   ${JSON.stringify(live)}`,
            );
            throw new Error(
                `${c.name} (${label}) differs from the oracle:\n${lines.join('\n')}\nfile: ${c.raw.slice(0, 600)}`,
            );
        }
    }
};

describe('the live resolver against the frozen 1.x oracle', () => {
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
        const raw = typeof fixture.blob === 'string' ? fixture.blob : JSON.stringify(fixture.blob);
        fixture.check?.(createV1Oracle(raw, env));
    });
});
