/**
 * `list-photos`: what it prints for each handler outcome, with everything the
 * server sent stripped of terminal control characters.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: string }[] = [];
    const rec = (level: string) => (msg: string) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), warning: rec('warning'), debug: rec('debug') };
    // The terminal-only writer: what it receives is never a log line.
    return { __calls: calls, withCategory: jest.fn(() => cat), printLine: rec('stdout') };
});
jest.mock('../../src/ts/cli/guards', () => ({
    ensureAuthenticated: jest.fn(() => true),
    INVALID_ID_TEXT: 'Invalid challenge or image id.',
}));
jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = { 'get-library-photos': jest.fn(), 'suggest-photos': jest.fn(), 'search-photo-tags': jest.fn() };
    return { __handlers: handlers, buildHandlers: jest.fn(() => handlers) };
});

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const calls = invalid<{ __calls: { level: string; msg: string }[] }>(loggerModule).__calls;
import guardsModule = require('../../src/ts/cli/guards');
const guards = jest.mocked(guardsModule);
import handlersModule = require('../../src/ts/ipc/actions.handlers');
const handlers = invalid<{
    __handlers: {
        'get-library-photos': jest.Mock<Promise<unknown>, unknown[]>;
        'suggest-photos': jest.Mock<Promise<unknown>, unknown[]>;
        'search-photo-tags': jest.Mock<Promise<unknown>, unknown[]>;
    };
}>(handlersModule).__handlers;
import type * as photosModule from '../../src/ts/cli/commands/photos';
const { listPhotosCmd, suggestPhotosCmd, parseSearchFlag, parseSortFlag, BAD_SORT_TEXT, shellQuote } =
    require('../../src/ts/cli/commands/photos') as typeof photosModule;

const text = (level: string) => calls.filter((c) => c.level === level).map((c) => c.msg);
const photos = [
    { id: 'p1', labels: ['Pink', 'Flower'], allowed: true, message: null, uploadDate: 1 },
    {
        id: 'p2\u001b[31m',
        labels: ['Car\u0007'],
        allowed: false,
        message: 'Used\u001b]0;pwned\u0007 in\nanother challenge',
        uploadDate: null,
    },
];

beforeEach(() => {
    calls.length = 0;
    guards.ensureAuthenticated.mockReturnValue(true);
    handlers['get-library-photos'].mockReset();
    handlers['suggest-photos'].mockReset();
    handlers['search-photo-tags'].mockReset();
});

describe('list-photos', () => {
    test('prints each photo, the allowed state when it is known, and strips control characters', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos,
            truncated: true,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
            memberId: 'm',
        });
        await expect(listPhotosCmd('5', 'pink')).resolves.toBe(0);
        expect(handlers['get-library-photos']).toHaveBeenCalledWith(
            null,
            '5',
            'pink',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        );
        const info = text('info');
        const stdout = text('stdout');
        // The persisted log gets the count and the cut-short flag, never a photo.
        expect(info[0]).toBe('=== Your photos (2, list cut short) ===');
        expect(stdout).toEqual([
            '  \u2022 p1  allowed  [Pink, Flower]',
            '  \u2022 p2  not allowed  [Car]',
            '      Used in another challenge',
        ]);
        expect(info.join('')).not.toMatch(/p1|p2|Pink|Car/);
        expect((info.join('') + stdout.join('')).match(/\p{Cc}/u)).toBeNull();
        // The challenge that was asked about is named in the closing hint, not a placeholder.
        expect(info[info.length - 1]).toBe('Choose photos with: set-setting chosenPhotos \'["<id>"]\' --challenge=5');
        expect(text('warning')).toEqual(['The list was cut short; narrow it with --search=<tag> to find the rest.']);
    });

    test('hides the allowed state when it applies to another challenge, and an empty library has no count', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: false,
            memberId: null,
        });
        await listPhotosCmd(null, null);
        expect(text('stdout')).toEqual(['  \u2022 p1  [Pink, Flower]']);
        expect(text('warning')).toEqual([]);
        // With no challenge, the global default is named as well as the per-challenge form.
        expect(text('info').slice(-2)).toEqual([
            'Choose photos for every challenge with: set-global-default chosenPhotos \'["<id>"]\'',
            'or for one challenge with: set-setting chosenPhotos \'["<id>"]\' --challenge=<id>',
        ]);
        // Without a challenge the note says eligibility is not shown and how to get it.
        expect(text('info').some((m) => m.includes('pass --challenge=<id>'))).toBe(true);
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [{ ...photos[0], labels: [] }],
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
            memberId: null,
        });
        await listPhotosCmd(null, null);
        expect(text('stdout')).toEqual(['  \u2022 p1  allowed']);
        expect(text('info').some((m) => m.includes('pass --challenge=<id>'))).toBe(false);
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [],
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: false,
            memberId: null,
        });
        await expect(listPhotosCmd(null, null)).resolves.toBe(0);
        expect(text('info')).toEqual(['No photos found in your library.']);
        calls.length = 0;
        await listPhotosCmd(null, 'pi\u001bnk');
        expect(text('info')).toEqual(['No photos found for "pink".']);
        expect(text('stdout')).toEqual([]);
    });

    test('asks for the listing with no mode, so it walks every time and never reads the cache', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos,
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
            memberId: 'm',
        });
        await listPhotosCmd('5', null);
        await listPhotosCmd(null, 'pink');
        expect(handlers['get-library-photos'].mock.calls).toEqual([
            [null, '5', null, undefined, undefined, undefined, undefined, undefined],
            [null, null, 'pink', undefined, undefined, undefined, undefined, undefined],
        ]);
    });

    test('says how many photos were left out for having won a challenge, with the photos or without any', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            wonIds: ['w1', 'w2'],
            wonCount: 2,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: false,
            allowedKnown: true,
            memberId: 'm',
        });
        await expect(listPhotosCmd('5', null)).resolves.toBe(0);
        expect(text('info')).toContain(
            "2 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).",
        );
        expect(text('stdout')).toEqual(['  \u2022 p1  allowed  [Pink, Flower]']);
        // The count is the walk's, not the length of the capped id list.
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            wonIds: ['w1'],
            wonCount: 1500,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: false,
            allowedKnown: true,
            memberId: 'm',
        });
        await listPhotosCmd('5', null);
        expect(text('info')).toContain(
            "1500 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).",
        );
        // A cut-short listing may have hidden more.
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            wonIds: ['w1'],
            wonCount: 1,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: true,
            allowedKnown: true,
            memberId: 'm',
        });
        await listPhotosCmd('5', null);
        expect(text('info')).toContain(
            "At least 1 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).",
        );
    });

    test('a listing with every match hidden says so in one line, for a tag or for the whole library', async () => {
        const allWon = {
            success: true as const,
            photos: [],
            wonIds: ['w1'],
            wonCount: 3,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: false,
            allowedKnown: true,
            memberId: 'm',
        };
        handlers['get-library-photos'].mockResolvedValue(allWon);
        await expect(listPhotosCmd('5', null)).resolves.toBe(0);
        expect(text('info')).toEqual([
            "No photos you can enter were found in your library; 3 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).",
        ]);
        calls.length = 0;
        await listPhotosCmd('5', 'pi\u001bnk');
        expect(text('info')).toEqual([
            `No photos you can enter were found for "pink"; 3 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).`,
        ]);
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({ ...allWon, truncated: true });
        await listPhotosCmd('5', null);
        expect(text('info')).toEqual([
            "No photos you can enter were found in your library; at least 3 photo(s) that have won a challenge are hidden (a winning photo can't be entered again).",
        ]);
        // Nothing hidden, nothing said.
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: false,
            allowedKnown: true,
            memberId: 'm',
        });
        await listPhotosCmd('5', null);
        expect(text('info').some((line) => line.includes('have won a challenge'))).toBe(false);
    });

    test('a blocked photo is printed with its reason exactly as the handler gives it, control characters stripped and nothing decoded again', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [
                {
                    id: 'p3',
                    labels: [],
                    allowed: false,
                    message: 'Used <b>twice</b> &amp; \u001b[31mred\u001b[0m',
                    uploadDate: null,
                },
            ],
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            truncated: false,
            allowedKnown: true,
            memberId: 'm',
        });
        await listPhotosCmd('5', null);
        expect(text('stdout')).toEqual(['  \u2022 p3  not allowed', '      Used <b>twice</b> &amp; red']);
    });

    test('a not-allowed photo without a message prints no second line', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [{ id: 'p3', labels: [], allowed: false, message: null, uploadDate: null }],
            truncated: false,
            wonIds: [],
            wonCount: 0,
            preview: false,
            readAtMs: 1_700_000_000_000,
            allowedKnown: true,
            memberId: null,
        });
        await listPhotosCmd('5', null);
        expect(text('stdout')).toEqual(['  \u2022 p3  not allowed']);
    });

    test.each([
        ['invalid-args', 'Use --challenge=<id>'],
        ['no-challenge-context', 'Join one first'],
        ['superseded', 'A newer request replaced this one'],
        ['library\u001b[0m down', 'library down'],
        // A code that names an Object.prototype member is text, not a lookup hit.
        ['constructor', 'Could not list your photos: constructor'],
        ['__proto__', 'Could not list your photos: __proto__'],
    ])('a refusal "%s" is explained', async (error, expected) => {
        handlers['get-library-photos'].mockResolvedValue({ success: false, error });
        await expect(listPhotosCmd(null, null)).resolves.toBe(1);
        expect(text('error')[0]).toContain(expected);
    });

    test('a missing result is an error too, and signed out stops before any request', async () => {
        handlers['get-library-photos'].mockResolvedValue(undefined);
        await expect(listPhotosCmd(null, null)).resolves.toBe(1);
        expect(text('error')[0]).toContain('undefined');
        guards.ensureAuthenticated.mockReturnValue(false);
        handlers['get-library-photos'].mockClear();
        await expect(listPhotosCmd(null, null)).resolves.toBe(1);
        expect(handlers['get-library-photos']).not.toHaveBeenCalled();
    });

    test('parseSearchFlag reads both spellings and nothing else', () => {
        expect(parseSearchFlag(['--search=a b'])).toBe('a b');
        expect(parseSearchFlag(['--search', 'a'])).toBe('a');
        expect(parseSearchFlag(['--search'])).toBeNull();
        expect(parseSearchFlag(['x'])).toBeNull();
    });
});

describe('list-photos --sort', () => {
    const okListing = {
        success: true,
        photos: [photos[0]],
        truncated: false,
        wonIds: [],
        wonCount: 0,
        preview: false,
        readAtMs: 1_700_000_000_000,
        allowedKnown: true,
        memberId: 'm',
    };

    test('a valid sort is passed to the handler as the seventh argument', async () => {
        handlers['get-library-photos'].mockResolvedValue(okListing);
        await expect(listPhotosCmd('5', null, 'newest')).resolves.toBe(0);
        expect(handlers['get-library-photos']).toHaveBeenCalledWith(
            null,
            '5',
            null,
            undefined,
            undefined,
            undefined,
            undefined,
            'newest',
        );
    });

    test('no sort asks for the default votes order', async () => {
        handlers['get-library-photos'].mockResolvedValue(okListing);
        await listPhotosCmd('5', null);
        expect(handlers['get-library-photos']).toHaveBeenCalledWith(
            null,
            '5',
            null,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        );
    });

    test.each([['strongest'], ['toString'], ['__proto__'], ['']])(
        'a sort that is not a library order (%s) refuses with the usage text and exits 1',
        async (sort) => {
            handlers['get-library-photos'].mockResolvedValue(okListing);
            await expect(listPhotosCmd('5', null, sort)).resolves.toBe(1);
            expect(handlers['get-library-photos']).not.toHaveBeenCalled();
            expect(text('error')[0]).toContain(BAD_SORT_TEXT);
        },
    );

    test('parseSortFlag reads both spellings and nothing else', () => {
        expect(parseSortFlag(['--sort=newest'])).toBe('newest');
        expect(parseSortFlag(['--sort', 'oldest'])).toBe('oldest');
        expect(parseSortFlag(['--sort'])).toBeNull();
        expect(parseSortFlag(['x'])).toBeNull();
    });
});

describe('list-photos --suggest', () => {
    const suggested = (extra: object = {}) => ({
        success: true,
        memberId: 'm',
        photos: [
            { id: 'p1', labels: ['Pink', 'Flower'], allowed: true, message: null, uploadDate: 1 },
            { id: 'p2\u001b[31m', labels: ['Car\u0007'], allowed: true, message: null, uploadDate: null },
            { id: 'p3', labels: [], allowed: true, message: null, uploadDate: null },
        ],
        statsLimited: false,
        ...extra,
    });

    test('prints the ranked photos on the terminal only, says nothing was submitted and names the next steps', async () => {
        handlers['suggest-photos'].mockResolvedValue(suggested());
        await expect(suggestPhotosCmd('5')).resolves.toBe(0);
        expect(handlers['suggest-photos']).toHaveBeenCalledWith(null, '5');
        expect(text('stdout')).toEqual([
            '  1. p1  [Pink, Flower]',
            '  2. p2  [Car]',
            '  3. p3',
            'Make them your chosen photos with: set-setting chosenPhotos \'["p1","p2","p3"]\' --challenge=5',
        ]);
        const info = text('info');
        expect(info[0]).toBe(
            'Ranking your photos by your auto-submit rules; this can take a minute. Nothing is submitted.',
        );
        expect(info[1]).toBe('=== Suggested photos for challenge 5 (3, best first) ===');
        // Never a photo in the persisted log.
        expect(info.join('')).not.toMatch(/\bp[123]\b|Pink|Car\b/);
        expect(info).toContain(
            'This is a ranking under your auto-submit rules, not a replay of the next fill. Nothing was submitted.',
        );
        expect(info).toContain(
            'submit --challenge=5 ranks again on its own (one photo, or every empty slot with --all) and ignores Submit Only; it does not submit these exact photos.',
        );
        expect((info.join('') + text('stdout').join('')).match(/\p{Cc}/u)).toBeNull();
        expect(text('warning')).toEqual([]);
    });

    test('says when the popularity stats were only partly read', async () => {
        handlers['suggest-photos'].mockResolvedValue(suggested({ statsLimited: true }));
        await suggestPhotosCmd('5');
        expect(text('warning')).toEqual([
            'Popularity stats were only partly read, so this ranking leans on tags and the image check.',
        ]);
    });

    test('strips terminal control characters from the challenge id it echoes', async () => {
        handlers['suggest-photos'].mockResolvedValue(suggested());
        await suggestPhotosCmd('5\u001b[2J');
        expect(
            text('info')
                .join('')
                .match(/\p{Cc}/u),
        ).toBeNull();
        expect(text('info')[1]).toBe('=== Suggested photos for challenge 5 (3, best first) ===');
    });

    test('is not run when you are not logged in', async () => {
        guards.ensureAuthenticated.mockReturnValue(false);
        await expect(suggestPhotosCmd('5')).resolves.toBe(1);
        expect(handlers['suggest-photos']).not.toHaveBeenCalled();
    });

    test.each([
        ['invalid-args', 'Invalid challenge or image id. Use --challenge=<id>.'],
        ['no-chosen-entered', 'Submit Only Chosen Photos is on and every chosen photo is already entered.'],
        ['no-chosen-unusable', 'Submit Only Chosen Photos is on and none of your chosen photos can go in.'],
        ['no-match', 'Nothing matches your Must Include tags.'],
        ['no-eligible', 'Your library has no photo this challenge accepts right now.'],
        ['suggest-busy', 'Another ranking is still running.'],
        ['challenge-ended', "This challenge has ended or couldn't be read."],
        ['fetch-failed', 'Ranking failed. Try again in a moment.'],
        ['suggest-failed', 'Ranking failed. Try again in a moment.'],
    ])('explains the refusal %s and exits 1', async (code, reason) => {
        handlers['suggest-photos'].mockResolvedValue({ success: false, error: code });
        await expect(suggestPhotosCmd('5')).resolves.toBe(1);
        const [message] = text('error');
        expect(message.startsWith('Could not suggest photos: ')).toBe(true);
        expect(message).toContain(reason);
        expect(text('stdout')).toEqual([]);
    });

    test('prints an unknown refusal stripped of control characters, and a missing answer as such', async () => {
        handlers['suggest-photos'].mockResolvedValue({ success: false, error: 'No authentication\u001b[31m token' });
        await expect(suggestPhotosCmd('5')).resolves.toBe(1);
        expect(text('error')).toEqual(['Could not suggest photos: No authentication token']);
        calls.length = 0;
        handlers['suggest-photos'].mockResolvedValue(undefined);
        await expect(suggestPhotosCmd('5')).resolves.toBe(1);
        expect(text('error')).toEqual(['Could not suggest photos: undefined']);
    });
});

describe('shellQuote', () => {
    test('wraps in single quotes and reopens around each embedded quote', () => {
        expect(shellQuote('')).toBe("''");
        expect(shellQuote('stair')).toBe(`'stair'`);
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    });
});

describe('list-photos --search tag suggestions', () => {
    const tagReply = (tags: string[]) => ({ success: true, tags });
    const noPhotos = {
        success: true,
        photos: [],
        truncated: false,
        wonIds: [],
        wonCount: 0,
        preview: false,
        readAtMs: 1_700_000_000_000,
        allowedKnown: false,
        memberId: null,
    };

    test('zero photos: the matching tags follow the "No photos found" line, the hint carries --challenge/--sort', async () => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['spiral staircase', 'stairs']));
        await expect(listPhotosCmd('5', 'stair', 'newest')).resolves.toBe(0);
        expect(handlers['search-photo-tags']).toHaveBeenCalledWith(null, 'stair');
        expect(text('info')).toEqual(['No photos found for "stair".']);
        expect(text('stdout')).toEqual([
            'Matching tags: spiral staircase, stairs',
            `Search one with: list-photos --search='spiral staircase' --challenge='5' --sort='newest'`,
        ]);
    });

    test('with photos too the tag lines come after the listing, and never reach the log files', async () => {
        handlers['get-library-photos'].mockResolvedValue({ ...noPhotos, photos });
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['pinkish', 'pink flower']));
        await expect(listPhotosCmd(null, 'pink')).resolves.toBe(0);
        expect(text('stdout')).toEqual([
            '  • p1  [Pink, Flower]',
            '  • p2  [Car]',
            'Matching tags: pinkish, pink flower',
            `Search one with: list-photos --search='pinkish'`,
        ]);
        // The tag lines are terminal only, like the photo lines.
        expect(text('info').join('')).not.toMatch(/pinkish|pink flower|Matching tags/);
        expect(text('warning')).toEqual([]);
    });

    test('the tag equal to the term is hidden, and a reply of only that prints nothing', async () => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['Staircase', 'staircase steel']));
        await expect(listPhotosCmd(null, 'staircase')).resolves.toBe(0);
        expect(text('stdout')).toEqual([
            'Matching tags: staircase steel',
            `Search one with: list-photos --search='staircase steel'`,
        ]);
        calls.length = 0;
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['Staircase']));
        await expect(listPhotosCmd(null, 'staircase')).resolves.toBe(0);
        expect(text('stdout')).toEqual([]);
    });

    test.each([
        ['an empty reply', tagReply([])],
        ['a superseded reply', { success: false, error: 'superseded' }],
        ['a null reply', null],
    ])('%s prints nothing and keeps exit 0', async (_name, reply) => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(reply);
        await expect(listPhotosCmd(null, 'stair')).resolves.toBe(0);
        expect(text('stdout')).toEqual([]);
    });

    test('a term shorter than 3 characters: the empty reply prints no tag lines', async () => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(tagReply([]));
        await expect(listPhotosCmd(null, 'st')).resolves.toBe(0);
        expect(text('info')).toEqual(['No photos found for "st".']);
        expect(text('stdout')).toEqual([]);
    });

    test.each([
        ['spiral staircase', `--search='spiral staircase'`],
        ["it's", `--search='it'\\''s'`],
        ['$(x)', `--search='$(x)'`],
        ['`x`', `--search='\`x\`'`],
    ])('the hint quotes a tag the shell must not split or run: %s', async (tag, expectedFlag) => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(tagReply([tag]));
        await expect(listPhotosCmd(null, 'nope')).resolves.toBe(0);
        expect(text('stdout')[1]).toBe(`Search one with: list-photos ${expectedFlag}`);
    });

    test('no --search, or an empty one, never asks for tags', async () => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        await expect(listPhotosCmd('5', null)).resolves.toBe(0);
        await expect(listPhotosCmd('5', '')).resolves.toBe(0);
        expect(handlers['search-photo-tags']).not.toHaveBeenCalled();
    });

    test('a failed listing stops before the tag lookup', async () => {
        handlers['get-library-photos'].mockResolvedValue({ success: false, error: 'superseded' });
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['stairs']));
        await expect(listPhotosCmd('5', 'stair')).resolves.toBe(1);
        expect(handlers['search-photo-tags']).not.toHaveBeenCalled();
    });

    test('control characters are stripped from the printed tags and from the hint', async () => {
        handlers['get-library-photos'].mockResolvedValue(noPhotos);
        handlers['search-photo-tags'].mockResolvedValue(tagReply(['sta\u0007irs\u001b[31m']));
        await expect(listPhotosCmd('5', 'stair')).resolves.toBe(0);
        expect(text('stdout')).toEqual([
            'Matching tags: stairs',
            `Search one with: list-photos --search='stairs' --challenge='5'`,
        ]);
        expect((text('stdout').join('') + text('info').join('')).match(/\p{Cc}/u)).toBeNull();
    });
});
