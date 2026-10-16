/**
 * Tests for services/entryTimes.ts — recording when a photo went in (the submit and the swap) and putting the
 * recorded time on each fetched entry. Bookkeeping never changes a result.
 */

import logger = require('../../src/ts/logger');
import type * as entryTimesModule from '../../src/ts/services/entryTimes';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { ActionResult, ActiveChallengesResponse, Challenge } from '../../src/ts/types/gurushots';
import type { EntryAgeLedger } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';

const { annotateEntryTimes, withEntryTimes } = require('../../src/ts/services/entryTimes') as typeof entryTimesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;

const NOW = 1_800_000_000;

const challenge = (id: number, entryIds: string[], extra: Record<string, unknown> = {}) =>
    invalid<Challenge>({
        id,
        close_time: NOW + 3600,
        member: { ranking: { entries: entryIds.map((entryId) => ({ id: entryId, ...extra })) } },
    });

// A ledger whose every call fails.
const brokenLedger = (thrown: unknown = new Error('ledger down')): EntryAgeLedger => {
    const fail = () => {
        throw thrown;
    };
    return invalid<EntryAgeLedger>({ refresh: fail, observeAll: fail, markSubmitted: fail });
};

const warnings = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) =>
            jest.mocked(r.value as ReturnType<typeof logger.withCategory>).warning.mock.calls.map((call) => call[0]),
        );

beforeEach(() => {
    jest.clearAllMocks();
});

describe('annotateEntryTimes', () => {
    test('puts the recorded time on each entry: exact for a submit, approximate for a first sighting, none when unknown', async () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['old']), NOW - 100);
        ledger.markSubmitted(1, ['mine'], NOW - 50);
        const response: ActiveChallengesResponse = { challenges: [challenge(1, ['old', 'mine', 'seen'])] };

        await annotateEntryTimes(response, ledger, NOW);

        const entries = response.challenges[0].member?.ranking?.entries ?? [];
        expect(entries.map((entry) => entry.appEntered)).toEqual([
            undefined,
            { at: NOW - 50, exact: true },
            { at: NOW, exact: false },
        ]);
    });

    test('the field is the app’s own: a server value never shows, even when the ledger fails', async () => {
        const forged = { at: 1, exact: true };
        const fine: ActiveChallengesResponse = { challenges: [challenge(1, ['a'], { appEntered: forged })] };
        await annotateEntryTimes(fine, createMemoryEntryAgeLedger(), NOW);
        expect(fine.challenges[0].member?.ranking?.entries?.[0]).not.toHaveProperty('appEntered');

        const failing: ActiveChallengesResponse = { challenges: [challenge(1, ['a'], { appEntered: forged })] };
        await expect(annotateEntryTimes(failing, brokenLedger(), NOW)).resolves.toBeUndefined();
        expect(failing.challenges[0].member?.ranking?.entries?.[0]).not.toHaveProperty('appEntered');
        expect(warnings()).toEqual([expect.stringContaining('ledger down')]);
    });

    test('a failed fetch is left alone, and so is a response without a list', async () => {
        const ledger = createMemoryEntryAgeLedger();
        const observeAll = jest.spyOn(ledger, 'observeAll');
        const failed: ActiveChallengesResponse = {
            challenges: [challenge(1, ['a'], { appEntered: { at: 5, exact: false } })],
            fetchFailed: true,
        };
        await annotateEntryTimes(failed, ledger, NOW);
        expect(failed.challenges[0].member?.ranking?.entries?.[0]).toHaveProperty('appEntered');
        await annotateEntryTimes(invalid<ActiveChallengesResponse>({}), ledger, NOW);
        expect(observeAll).not.toHaveBeenCalled();
    });

    test('tolerates challenges without entries and entries without an id', async () => {
        const response = invalid<ActiveChallengesResponse>({
            challenges: [
                { id: 1, close_time: NOW + 60 },
                { id: 2, close_time: NOW + 60, member: { ranking: { entries: [null, {}] } } },
            ],
        });
        await expect(annotateEntryTimes(response, createMemoryEntryAgeLedger(), NOW)).resolves.toBeUndefined();
    });

    test('times a fetch without a clock argument at the current time', async () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['a']), 1);
        const response: ActiveChallengesResponse = { challenges: [challenge(1, ['a', 'b'])] };
        const before = Math.floor(Date.now() / 1000);
        await annotateEntryTimes(response, ledger);
        const at = response.challenges[0].member?.ranking?.entries?.[1]?.appEntered?.at ?? 0;
        expect(at).toBeGreaterThanOrEqual(before);
    });
});

describe('withEntryTimes', () => {
    const ok: ActionResult = { ok: true, raw: { success: true } };

    const wrapped = (submit: ActionResult, swap: ActionResult, ledger: EntryAgeLedger) => {
        const api = {
            submitToChallenge: jest.fn(async () => submit),
            swapPhoto: jest.fn(async () => swap),
        };
        return { api, ...withEntryTimes(api, ledger) };
    };

    test('a submit that went in is recorded exactly, and the result is returned as it came', async () => {
        const ledger = createMemoryEntryAgeLedger();
        const { api, submitToChallenge } = wrapped(ok, ok, ledger);
        const before = Math.floor(Date.now() / 1000);

        await expect(submitToChallenge(7, ['a', 'b'], 'tok')).resolves.toBe(ok);

        expect(api.submitToChallenge).toHaveBeenCalledWith(7, ['a', 'b'], 'tok');
        expect(ledger.enteredAt(7, 'a')).toBeGreaterThanOrEqual(before);
        expect(ledger.enteredAt(7, 'b')).toBeGreaterThanOrEqual(before);
        const times = ledger.observeAll([challenge(7, ['a', 'b'])], NOW);
        expect(times['7'].a.exact).toBe(true);
    });

    test('a swap that went in records the photo swapped in', async () => {
        const ledger = createMemoryEntryAgeLedger();
        const { api, swapPhoto } = wrapped(ok, ok, ledger);

        await expect(swapPhoto(7, 'old', 'new', 'tok')).resolves.toBe(ok);

        expect(api.swapPhoto).toHaveBeenCalledWith(7, 'old', 'new', 'tok');
        expect(ledger.enteredAt(7, 'new')).not.toBeNull();
        expect(ledger.enteredAt(7, 'old')).toBeNull();
    });

    test.each([
        ['failed', { ok: false, raw: null }],
        ['refused', { ok: false, raw: { success: false } }],
        ['unclear', { ok: false, raw: null, unclear: true }],
    ])('a %s submit or swap is not recorded', async (_name, result) => {
        const ledger = createMemoryEntryAgeLedger();
        const { submitToChallenge, swapPhoto } = wrapped(result, result, ledger);
        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(result);
        await expect(swapPhoto(7, 'x', 'y', 'tok')).resolves.toBe(result);
        expect(ledger.enteredAt(7, 'a')).toBeNull();
        expect(ledger.enteredAt(7, 'y')).toBeNull();
    });

    test('a ledger that throws something that is no error is logged too', async () => {
        const { submitToChallenge } = wrapped(ok, ok, brokenLedger('plain refusal'));
        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(ok);
        expect(warnings()).toEqual([expect.stringContaining('plain refusal')]);
    });

    test('a ledger failure after a landed submit or swap changes nothing about the result', async () => {
        const { submitToChallenge, swapPhoto } = wrapped(ok, ok, brokenLedger());
        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(ok);
        await expect(swapPhoto(7, 'x', 'y', 'tok')).resolves.toBe(ok);
        expect(warnings()).toHaveLength(2);
        expect(warnings().every((line) => line.includes('ledger down') && !line.includes('7'))).toBe(true);
    });
});
