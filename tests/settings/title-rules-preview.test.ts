/**
 * The settings facade's title-rules dry-run (`previewTitleRules`): everything
 * `setTitleRules` checks before saving — the array check, the cap, the
 * sanitize pass and the profile-conflict check — answered without saving, by
 * the same pipeline the write runs, so the preview cannot drift from the
 * write. Drives the in-memory headless-store seam the other settings tests
 * use, so loadSettings/saveSettings round-trip without touching fs.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/settings');

jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

const cat = invalid<{
    __cat: { [K in 'info' | 'error' | 'debug' | 'success' | 'warning']: jest.MockedFunction<CategoryLogger[K]> };
}>(require('../../src/ts/logger')).__cat;

const HOUR = 3600;
const START = 1_700_000_000;

// A stored configuration: global defaults, per-challenge values, profiles, rules.
const seed = (
    over: { profiles?: Record<string, unknown>; challenges?: Record<string, Record<string, unknown>> } = {},
) => {
    const ids = Object.keys(over.challenges ?? {});
    store.value = JSON.stringify({
        version: 2,
        defaults: {},
        challenges: Object.fromEntries(ids.map((id) => [id, { values: over.challenges?.[id] }])),
        profiles: over.profiles ?? {},
        rules: [],
        scenarios: {},
    });
    settings.loadSettings();
    store.write.mockClear();
};

// A challenge payload as the API sends it — the fields the facts cache keeps.
const challenge = () => ({
    id: 'c1',
    title: 'Seaside',
    tags: [],
    type: 'default',
    max_photo_submits: 4,
    start_time: START,
    close_time: START + 24 * HOUR,
});

let store: MemoryStore;

beforeEach(() => {
    store = installHeadlessStore();
    settings.rememberChallengeTitles([]);
    jest.clearAllMocks();
});

afterAll(() => {
    removeHeadlessStore();
});

describe('previewTitleRules — the dry-run of setTitleRules', () => {
    test('a valid list previews the rules the write stores, and saves nothing', () => {
        seed();
        const input = [
            { title: '  Seaside  ', mustIncludeTags: [' sea '], shouldIncludeTags: [], autoJoin: true },
            { title: 'Noop', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'Seaside', mustIncludeTags: ['other'] },
        ];
        const preview = settings.previewTitleRules(input);
        expect(preview).toEqual({
            ok: true,
            rules: [{ title: 'Seaside', mustIncludeTags: ['other'], shouldIncludeTags: [] }],
            dropped: [
                {
                    index: 2,
                    label: 'Noop',
                    reason: 'the rule matches but sets nothing (no tags, profile or overrides)',
                },
            ],
            collapsed: [
                {
                    index: 3,
                    label: 'Seaside',
                    reason: 'same match condition as rule 1 ("Seaside") — the later values win, at the first one\'s position',
                },
            ],
        });
        expect(store.write).not.toHaveBeenCalled();
        expect(settings.getTitleRules()).toEqual([]);
        expect(cat.error).not.toHaveBeenCalled();
    });

    test("a collapse keeps the last rule's values at the first one's position, in the preview and the write", () => {
        seed();
        const input = [
            { title: 'A', mustIncludeTags: ['x'] },
            { title: 'A', mustIncludeTags: ['y'] },
        ];
        const preview = settings.previewTitleRules(input);
        expect(preview).toEqual({
            ok: true,
            rules: [{ title: 'A', mustIncludeTags: ['y'], shouldIncludeTags: [] }],
            dropped: [],
            collapsed: [expect.objectContaining({ index: 2, label: 'A' })],
        });
        expect(settings.setTitleRules(input)).toBe(true);
        expect(settings.getTitleRules()).toEqual((preview as { rules: unknown[] }).rules);
    });

    test('three identical conditions: every later rule cites the first one, and the third is stored', () => {
        seed();
        const input = [
            { title: 'A', mustIncludeTags: ['x'] },
            { title: 'A', mustIncludeTags: ['y'] },
            { title: 'A', mustIncludeTags: ['z'] },
        ];
        const preview = settings.previewTitleRules(input);
        expect(preview).toEqual({
            ok: true,
            rules: [{ title: 'A', mustIncludeTags: ['z'], shouldIncludeTags: [] }],
            dropped: [],
            collapsed: [
                {
                    index: 2,
                    label: 'A',
                    reason: 'same match condition as rule 1 ("A") — the later values win, at the first one\'s position',
                },
                {
                    index: 3,
                    label: 'A',
                    reason: 'same match condition as rule 1 ("A") — the later values win, at the first one\'s position',
                },
            ],
        });
        expect(settings.setTitleRules(input)).toBe(true);
        expect(settings.getTitleRules()).toEqual((preview as { rules: unknown[] }).rules);
    });

    test('titles that differ only in case collapse, and every note cites the first rule and its label', () => {
        seed();
        const input = [
            { title: 'Sunset', mustIncludeTags: ['x'] },
            { title: 'SUNSET', mustIncludeTags: ['y'] },
            { title: 'sunset', mustIncludeTags: ['z'] },
        ];
        const preview = settings.previewTitleRules(input);
        expect(preview).toEqual({
            ok: true,
            rules: [{ title: 'sunset', mustIncludeTags: ['z'], shouldIncludeTags: [] }],
            dropped: [],
            collapsed: [
                {
                    index: 2,
                    label: 'SUNSET',
                    reason: 'same match condition as rule 1 ("Sunset") — the later values win, at the first one\'s position',
                },
                {
                    index: 3,
                    label: 'sunset',
                    reason: 'same match condition as rule 1 ("Sunset") — the later values win, at the first one\'s position',
                },
            ],
        });
        expect(settings.setTitleRules(input)).toBe(true);
        expect(settings.getTitleRules()).toEqual((preview as { rules: unknown[] }).rules);
    });

    test('the preview matches what the write stores, for the same input', () => {
        seed({ profiles: { Tactic: { exposure: 80 } } });
        const input = [
            { title: 'Seaside', profile: 'Tactic' },
            { type: 'flash', pics: 4, autoJoin: true },
            { title: '   ', mustIncludeTags: [] },
            { title: 'Seaside', mustIncludeTags: ['sea'] },
        ];
        const preview = settings.previewTitleRules(input);
        expect(preview.ok).toBe(true);
        expect(settings.setTitleRules(input)).toBe(true);
        expect(settings.getTitleRules()).toEqual((preview as { rules: unknown[] }).rules);
        expect((preview as { dropped: unknown[] }).dropped).toEqual([
            { index: 3, label: '(untitled rule)', reason: 'the rule has no match condition and sets nothing' },
        ]);
    });

    test("a non-array is rejected with the write's wording", () => {
        seed();
        expect(settings.previewTitleRules('nope')).toEqual({ ok: false, error: 'setTitleRules expects an array' });
        expect(settings.previewTitleRules(null)).toEqual({ ok: false, error: 'setTitleRules expects an array' });
    });

    test("an over-cap list is rejected with the write's wording", () => {
        seed();
        const rules = Array.from({ length: 201 }, () => ({ title: 'A', mustIncludeTags: ['x'] }));
        expect(settings.previewTitleRules(rules)).toEqual({
            ok: false,
            error: 'setTitleRules rejected: 201 rules exceeds the 200 cap',
        });
    });

    test("a rejected rule returns the write's reason, and saves nothing", () => {
        seed();
        // An invalid inline value rejects the rule; a non-array tag list is an
        // empty one by design (it must not reject).
        const preview = settings.previewTitleRules([{ title: 'A', autoJoin: 'yes' }]);
        expect(preview).toEqual({ ok: false, error: 'Title rule rejected for "A": invalid or over-length values' });
        expect(store.write).not.toHaveBeenCalled();
    });

    test('an unknown profile reference is rejected with its name', () => {
        seed();
        expect(settings.previewTitleRules([{ title: 'A', profile: 'Ghost', mustIncludeTags: ['x'] }])).toEqual({
            ok: false,
            error: 'Title rule rejected for "A": unknown profile "Ghost"',
        });
    });

    test('a rule whose profile conflicts with a stored override is rejected, before any save', () => {
        seed({ profiles: { P: { exposure: 70 } }, challenges: { c1: { exposureTarget: 60 } } });
        settings.rememberChallengeTitles([challenge()]);
        const input = [{ pics: 4, profile: 'P' }];
        expect(settings.previewTitleRules(input)).toEqual({
            ok: false,
            error: 'Title profile conflicts with manual overrides for "(untitled rule)"',
        });
        expect(store.write).not.toHaveBeenCalled();
        expect(settings.setTitleRules(input)).toBe(false);
    });
});
