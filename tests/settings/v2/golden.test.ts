/**
 * The oracle's own output, written down: what the frozen 1.x resolver answers for every hand-written fixture and a
 * fixed set of random files, in `__golden__/oracle.json`. The equivalence harness compares the live code with the
 * oracle; this compares the oracle with itself over time, so it keeps its meaning after the live code stops reading
 * 1.x files (phase B) and nothing else can tell the oracle was changed by accident.
 *
 * To regenerate it after changing an oracle, a fixture or the random generator on purpose:
 *
 *     UPDATE_GOLDEN=1 pnpm jest tests/settings/v2/golden
 *
 * and review the diff: each line of the file is one case.
 */

import { createV1Oracle } from '../../helpers/v1Oracle';
import { parseJson, parseJsonObject } from '../../helpers/parseJson';
import { FIXTURES } from './fixtures';
import { CANDIDATES, CHALLENGES, NOW } from './fixtures/types';
import { randomCase } from './random';
import { diffTrees, OWN_NAMES, snapshot, variantsFor } from './snapshot';

import type { Case } from './random';
import type { Tree } from './snapshot';

const GOLDEN_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const GOLDEN_FILE = `${__dirname}/__golden__/oracle.json`;

const cases: Case[] = [
    ...FIXTURES.filter((fixture) => fixture.golden !== false).map(
        (fixture): Case => ({
            name: fixture.name,
            raw: typeof fixture.blob === 'string' ? fixture.blob : JSON.stringify(fixture.blob),
            challenges: fixture.challenges ?? CHALLENGES,
            offList: fixture.offList ?? [],
            candidates: fixture.candidates ?? CANDIDATES,
        }),
    ),
    ...GOLDEN_SEEDS.map(randomCase),
];

const oracleOutput = (c: Case): unknown => {
    const env = { now: NOW, challenges: c.challenges, ledger: {} };
    const oracle = createV1Oracle(c.raw, env);
    const tree = snapshot(oracle, c, env, variantsFor(oracle, c.challenges), OWN_NAMES, { calls: 0 });
    // What a file holds: the output as JSON, as it was recorded.
    return parseJson(JSON.stringify(tree));
};

// One line per case, so a regenerated file diffs by case.
const format = (output: Tree): string =>
    `{\n${Object.entries(output)
        .map(([name, tree]) => `${JSON.stringify(name)}: ${JSON.stringify(tree)}`)
        .join(',\n')}\n}\n`;

const fs = jest.requireActual<typeof import('node:fs')>('fs');

if (process.env.UPDATE_GOLDEN === '1') {
    test('regenerates the golden output', () => {
        fs.writeFileSync(GOLDEN_FILE, format(Object.fromEntries(cases.map((c) => [c.name, oracleOutput(c)]))));
    });
} else {
    const golden: Tree = parseJsonObject(fs.readFileSync(GOLDEN_FILE, 'utf8'));

    describe('the oracle still answers as it was recorded', () => {
        test('the recorded cases are the current ones', () => {
            expect(Object.keys(golden)).toEqual(cases.map((c) => c.name));
        });

        test.each(cases.map((c) => [c.name, c] as const))('%s', (name, c) => {
            const { mismatches } = diffTrees(golden[name], oracleOutput(c));
            const lines = mismatches.map(
                ({ path, oracle, live }) =>
                    `  ${path}\n    recorded ${JSON.stringify(oracle)}\n    now      ${JSON.stringify(live)}`,
            );
            expect(lines.join('\n')).toBe('');
        });
    });
}
