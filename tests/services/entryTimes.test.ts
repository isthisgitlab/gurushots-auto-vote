/**
 * Tests for services/entryTimes.ts — recording when a photo went in (the submit and the swap) and putting the
 * recorded time on each fetched entry. Bookkeeping never changes a result.
 */

import logger = require('../../src/ts/logger');
import type * as entryTimesModule from '../../src/ts/services/entryTimes';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type * as settingsModule from '../../src/ts/settings';
import type { ActionResult, ActiveChallengesResponse, Challenge } from '../../src/ts/types/gurushots';
import type { EntryAgeLedger } from '../../src/ts/types/stores';
import type { ThroughResult } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { isNumber, isRecordOf, isShape, isString, nullable, parseJsonAs } from '../helpers/parseJson';

// The facade rides along real (a partial factory: its exports must be
// replaceable for the consumeChosenPhotos spy), so the wrapped submits drive
// the real consumption over the store planted below.
jest.mock('../../src/ts/settings', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/settings')>('../../src/ts/settings'),
}));

const { annotateEntryTimes, withEntryTimes } = require('../../src/ts/services/entryTimes') as typeof entryTimesModule;
const { createMemoryEntryAgeLedger, createEntryAgeLedger } =
    require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
const settings = require('../../src/ts/settings') as typeof settingsModule;

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
    test('puts the recorded time on each entry: exact for a submit, approximate for a first sighting, and the first fetch that showed an entry of unknown age', async () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['old']), NOW - 100);
        ledger.markSubmitted(1, ['mine'], NOW - 50);
        const response: ActiveChallengesResponse = { challenges: [challenge(1, ['old', 'mine', 'seen'])] };

        await annotateEntryTimes(response, ledger, NOW);

        const entries = response.challenges[0].member?.ranking?.entries ?? [];
        expect(entries.map((entry) => entry.appEntered)).toEqual([
            // There when the first fetch showed the challenge: its age is unknown, and this is its latest time.
            { at: NOW - 100, exact: false },
            { at: NOW - 50, exact: true },
            { at: NOW, exact: false },
        ]);
    });

    test('the field is the app’s own: a server value never shows, even when the ledger fails', async () => {
        const forged = { at: 1, exact: true };
        const fine: ActiveChallengesResponse = { challenges: [challenge(1, ['a'], { appEntered: forged })] };
        await annotateEntryTimes(fine, createMemoryEntryAgeLedger(), NOW);
        expect(fine.challenges[0].member?.ranking?.entries?.[0]?.appEntered).toEqual({ at: NOW, exact: false });

        const failing: ActiveChallengesResponse = { challenges: [challenge(1, ['a'], { appEntered: forged })] };
        await expect(annotateEntryTimes(failing, brokenLedger(), NOW)).resolves.toBeUndefined();
        expect(failing.challenges[0].member?.ranking?.entries?.[0]).not.toHaveProperty('appEntered');
        // The refresh and the observation both failed; each is logged, and the response is as it came.
        expect(warnings()).toEqual(['entry-age ledger not refreshed (Error)', 'entry times not recorded (Error)']);
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

    test('a marked challenge is neither observed nor annotated, but its entries still lose a forged appEntered', async () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['old']), NOW - 100);
        ledger.markSubmitted(1, ['mine'], NOW - 50);
        const marked = invalid<Challenge>({
            id: 1,
            close_time: NOW + 3600,
            dataIssues: ['close_time'],
            member: {
                ranking: {
                    entries: [
                        { id: 'old', appEntered: { at: 1, exact: true } },
                        { id: 'mine', appEntered: { at: 2, exact: true } },
                    ],
                },
            },
        });
        const sibling = challenge(2, ['x']);
        const response: ActiveChallengesResponse = { challenges: [marked, sibling] };
        const observeAll = jest.spyOn(ledger, 'observeAll');

        await annotateEntryTimes(response, ledger, NOW);

        // observeAll saw only the unmarked sibling…
        expect(observeAll).toHaveBeenCalledTimes(1);
        expect(observeAll).toHaveBeenCalledWith([sibling], NOW);
        // …the marked challenge's entries lost the forged field and got nothing
        // back, and its record is untouched.
        expect(marked.member?.ranking?.entries?.[0]).not.toHaveProperty('appEntered');
        expect(marked.member?.ranking?.entries?.[1]).not.toHaveProperty('appEntered');
        expect(ledger.enteredAt(1, 'mine')).toBe(NOW - 50);
        // The sibling is annotated as usual.
        expect(sibling.member?.ranking?.entries?.[0]?.appEntered).toEqual({ at: NOW, exact: false });
    });
});

describe('annotateEntryTimes and a ledger refresh that does not come back', () => {
    const response = (): ActiveChallengesResponse => ({ challenges: [challenge(1, ['a', 'b'])] });
    const timeOf = (r: ActiveChallengesResponse, index: number) =>
        r.challenges[0].member?.ranking?.entries?.[index]?.appEntered;

    // A ledger that holds a record of `a` and `b` (b exact), whose refresh is the one given.
    const ledgerWith = (refreshStore: () => Promise<boolean>) => {
        let raw: string | null = null;
        const ledger = createEntryAgeLedger(
            {
                readRaw: () => raw,
                writeRaw: (data) => {
                    raw = data;
                },
            },
            refreshStore,
        );
        ledger.observe(challenge(1, ['a']), NOW - 100);
        ledger.markSubmitted(1, ['b'], NOW - 50);
        return ledger;
    };

    afterEach(() => {
        jest.useRealTimers();
    });

    test('a refresh that reads nothing (false) still annotates from the cache', async () => {
        const fetched = response();
        await annotateEntryTimes(
            fetched,
            ledgerWith(async () => false),
            NOW,
        );
        expect(timeOf(fetched, 0)).toEqual({ at: NOW - 100, exact: false });
        expect(timeOf(fetched, 1)).toEqual({ at: NOW - 50, exact: true });
    });

    test('a refresh that never settles is given up after 5 s: the fetch goes on with the cache', async () => {
        jest.useFakeTimers();
        const fetched = response();
        const done = annotateEntryTimes(
            fetched,
            ledgerWith(() => new Promise<boolean>(() => {})),
            NOW,
        );

        await jest.advanceTimersByTimeAsync(4999);
        expect(timeOf(fetched, 1)).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        await done;

        expect(timeOf(fetched, 1)).toEqual({ at: NOW - 50, exact: true });
        expect(warnings()).toEqual(['entry-age ledger refresh timed out — using the cached copy']);
    });

    test('a refresh that settles after the fetch went on makes the failed marks again, and the end state is right', async () => {
        jest.useFakeTimers();
        let raw: string | null = null;
        const queued: Array<{ update: (current: string | null) => string | null; settle: (r: ThroughResult) => void }> =
            [];
        const store = {
            readRaw: () => raw,
            writeRaw: jest.fn(),
            updateThrough: (update: (current: string | null) => string | null) =>
                new Promise<ThroughResult>((settle) => queued.push({ update, settle })),
        };
        const land = (index: number, outcome: ThroughResult) => {
            if (outcome === 'saved') raw = queued[index].update(raw) ?? raw;
            queued[index].settle(outcome);
        };
        // The service answers late: the refresh outlives the fetch's wait.
        const ledger = createEntryAgeLedger(
            store,
            () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 6000)),
        );
        ledger.markPending(challenge(1, []), 'p', NOW - 60);
        ledger.clearPending(1, 'p', NOW - 50);
        land(0, 'failed');
        land(1, 'aborted');
        await jest.advanceTimersByTimeAsync(0);
        const fetched = response();

        const done = annotateEntryTimes(fetched, ledger, NOW);
        await jest.advanceTimersByTimeAsync(5000);
        await done;
        // The fetch went on with the cache: its observation is in flight (the third write).
        expect(queued).toHaveLength(3);
        expect(timeOf(fetched, 0)).toEqual({ at: NOW, exact: false });
        await jest.advanceTimersByTimeAsync(1000);
        // The late refresh made both marks again, after the observation.
        expect(queued).toHaveLength(5);
        land(2, 'saved');
        land(3, 'saved');
        land(4, 'saved');
        await jest.advanceTimersByTimeAsync(0);

        expect(ledger.pending(1)).toBeNull();
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        const stored = parseJsonAs(
            raw!,
            isRecordOf(
                isShape<{ pending: string | null; entered: Record<string, number> }>({
                    pending: nullable(isString),
                    entered: isRecordOf(isNumber),
                }),
            ),
        );
        expect(stored['1'].pending).toBeNull();
        expect(Object.keys(stored['1'].entered).sort()).toEqual(['a', 'b', 'p']);
    });

    test('a refresh that settles first clears the timer', async () => {
        jest.useFakeTimers();
        const fetched = response();

        await annotateEntryTimes(
            fetched,
            ledgerWith(async () => true),
            NOW,
        );

        expect(jest.getTimerCount()).toBe(0);
        expect(timeOf(fetched, 1)).toEqual({ at: NOW - 50, exact: true });
        expect(warnings()).toEqual([]);
    });
});

describe('withEntryTimes', () => {
    const ok: ActionResult = { ok: true, raw: { success: true } };
    const notOk: ActionResult = { ok: false, raw: null };

    // The ok submits and swaps run the real chosen-photos consumption through
    // the facade: it reads and writes settings, so every test here sits on the
    // planted store, never the developer's real config.
    beforeEach(() => {
        installHeadlessStore();
    });
    afterEach(() => {
        removeHeadlessStore();
    });

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
        // The kind of error, never its message.
        expect(warnings()).toEqual(['submit time not recorded (not an error)']);
    });

    test('a ledger failure after a landed submit or swap changes nothing about the result', async () => {
        const { submitToChallenge, swapPhoto } = wrapped(ok, ok, brokenLedger());
        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(ok);
        await expect(swapPhoto(7, 'x', 'y', 'tok')).resolves.toBe(ok);
        expect(warnings()).toHaveLength(2);
        expect(warnings()).toEqual(['submit time not recorded (Error)', 'submit time not recorded (Error)']);
    });

    test("an ok submit consumes the entered chosen photos from the challenge's stored list", async () => {
        settings.rememberChallengeTitles([{ id: 7, title: 'Show' }]);
        settings.setChallengeOverride('chosenPhotos', '7', ['a', 'b', 'keep']);
        const ledger = createMemoryEntryAgeLedger();
        const { api, submitToChallenge } = wrapped(ok, ok, ledger);

        await expect(submitToChallenge(7, ['a', 'b'], 'tok')).resolves.toBe(ok);

        expect(api.submitToChallenge).toHaveBeenCalledWith(7, ['a', 'b'], 'tok');
        expect(settings.getChallengeOverrides('7')).toEqual({ chosenPhotos: ['keep'] });
    });

    test('an ok swap-in consumes the photo swapped in, and an emptied list deletes the key', async () => {
        settings.rememberChallengeTitles([{ id: 7, title: 'Show' }]);
        settings.setChallengeOverride('chosenPhotos', '7', ['new']);
        const ledger = createMemoryEntryAgeLedger();
        const { swapPhoto } = wrapped(ok, ok, ledger);

        await expect(swapPhoto(7, 'old', 'new', 'tok')).resolves.toBe(ok);

        expect(settings.getChallengeOverrides('7')).toEqual({});
    });

    test('an unclear or failed submit or swap consumes nothing', async () => {
        const consume = jest.spyOn(settings, 'consumeChosenPhotos');
        const ledger = createMemoryEntryAgeLedger();
        const { submitToChallenge, swapPhoto } = wrapped(notOk, notOk, ledger);
        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(notOk);
        await expect(swapPhoto(7, 'x', 'y', 'tok')).resolves.toBe(notOk);
        expect(consume).not.toHaveBeenCalled();
        consume.mockRestore();
    });

    test('the join-time hold: an id unknown to the facts cache consumes nothing, even with a rule-layer Only planted', async () => {
        // Not seeded: at this site the id is minutes old and a rule cannot be
        // resolved for it yet, so the unknown-id hold fires before Only would.
        settings.setTitleRules([{ title: 'Show', chosenPhotosOnly: true }]);
        settings.setChallengeOverride('chosenPhotos', '999', ['a']);
        const consume = jest.spyOn(settings, 'consumeChosenPhotos');
        const ledger = createMemoryEntryAgeLedger();
        const { submitToChallenge } = wrapped(ok, ok, ledger);

        await expect(submitToChallenge(999, ['a'], 'tok')).resolves.toBe(ok);

        expect(consume).toHaveBeenCalledWith(999, ['a']);
        expect(settings.getChallengeOverrides('999')).toEqual({ chosenPhotos: ['a'] });
        consume.mockRestore();
    });

    test('a rule-layer Only for an id the cache knows holds too: Only resolves through the rule', async () => {
        settings.rememberChallengeTitles([{ id: 555, title: 'Ruled show' }]);
        settings.setTitleRules([{ title: 'Ruled show', chosenPhotosOnly: true }]);
        settings.setChallengeOverride('chosenPhotos', '555', ['a']);
        const ledger = createMemoryEntryAgeLedger();
        const { submitToChallenge } = wrapped(ok, ok, ledger);

        await expect(submitToChallenge(555, ['a'], 'tok')).resolves.toBe(ok);

        expect(settings.getChallengeOverrides('555')).toEqual({ chosenPhotos: ['a'] });
    });

    test('a consumption failure is logged and the submit result is unchanged', async () => {
        const consume = jest.spyOn(settings, 'consumeChosenPhotos').mockImplementation(() => {
            throw new Error('store down');
        });
        const ledger = createMemoryEntryAgeLedger();
        const { submitToChallenge } = wrapped(ok, ok, ledger);

        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(ok);

        expect(consume).toHaveBeenCalledWith(7, ['a']);
        expect(warnings()).toEqual(['chosen photos not consumed (Error)']);
        consume.mockRestore();
    });

    test('a ledger-mark failure does not skip the consumption: the guards are separate', async () => {
        settings.rememberChallengeTitles([{ id: 7, title: 'Show' }]);
        settings.setChallengeOverride('chosenPhotos', '7', ['a', 'keep']);
        const consume = jest.spyOn(settings, 'consumeChosenPhotos');
        const { submitToChallenge } = wrapped(ok, ok, brokenLedger());

        await expect(submitToChallenge(7, ['a'], 'tok')).resolves.toBe(ok);

        expect(warnings()).toEqual(['submit time not recorded (Error)']);
        expect(consume).toHaveBeenCalled();
        expect(settings.getChallengeOverrides('7')).toEqual({ chosenPhotos: ['keep'] });
        consume.mockRestore();
    });
});
