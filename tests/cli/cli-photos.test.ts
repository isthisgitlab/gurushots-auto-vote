/**
 * `list-photos`: what it prints for each handler outcome, with everything the
 * server sent stripped of terminal control characters.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: string }[] = [];
    const rec = (level: string) => (msg: string) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), warning: rec('warning'), debug: rec('debug') };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});
jest.mock('../../src/ts/cli/guards', () => ({
    ensureAuthenticated: jest.fn(() => true),
    INVALID_ID_TEXT: 'Invalid challenge or image id.',
}));
jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = { 'get-library-photos': jest.fn() };
    return { __handlers: handlers, buildHandlers: jest.fn(() => handlers) };
});

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const calls = invalid<{ __calls: { level: string; msg: string }[] }>(loggerModule).__calls;
import guardsModule = require('../../src/ts/cli/guards');
const guards = jest.mocked(guardsModule);
import handlersModule = require('../../src/ts/ipc/actions.handlers');
const handlers = invalid<{ __handlers: { 'get-library-photos': jest.Mock<Promise<unknown>, unknown[]> } }>(
    handlersModule,
).__handlers;
import type * as photosModule from '../../src/ts/cli/commands/photos';
const { listPhotosCmd, parseSearchFlag } = require('../../src/ts/cli/commands/photos') as typeof photosModule;

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
});

describe('list-photos', () => {
    test('prints each photo, the allowed state when it is known, and strips control characters', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos,
            truncated: true,
            allowedKnown: true,
            memberId: 'm',
        });
        await expect(listPhotosCmd('5', 'pink')).resolves.toBe(0);
        expect(handlers['get-library-photos']).toHaveBeenCalledWith(null, '5', 'pink');
        const info = text('info');
        expect(info[0]).toBe('=== Your photos (2) ===');
        expect(info[1]).toBe('  \u2022 p1  allowed  [Pink, Flower]');
        expect(info[2]).toBe('  \u2022 p2  not allowed  [Car]');
        expect(info[3]).toBe('      Used in another challenge');
        expect(info.join('')).not.toMatch(/\p{Cc}/u);
        expect(info[info.length - 1]).toContain('set-setting chosenPhotos \'["<id>"]\' --challenge=<id>');
        expect(text('warning')).toEqual(['The list was cut short; narrow it with --search=<tag> to find the rest.']);
    });

    test('hides the allowed state when it applies to another challenge, and an empty library has no count', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [photos[0]],
            truncated: false,
            allowedKnown: false,
            memberId: null,
        });
        await listPhotosCmd(null, null);
        expect(text('info')[1]).toBe('  \u2022 p1  [Pink, Flower]');
        expect(text('warning')).toEqual([]);
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [{ ...photos[0], labels: [] }],
            truncated: false,
            allowedKnown: true,
            memberId: null,
        });
        await listPhotosCmd(null, null);
        expect(text('info')[1]).toBe('  \u2022 p1  allowed');
        calls.length = 0;
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [],
            truncated: false,
            allowedKnown: false,
            memberId: null,
        });
        await listPhotosCmd(null, null);
        expect(text('info')[0]).toBe('=== Your photos ===');
    });

    test('a not-allowed photo without a message prints no second line', async () => {
        handlers['get-library-photos'].mockResolvedValue({
            success: true,
            photos: [{ id: 'p3', labels: [], allowed: false, message: null, uploadDate: null }],
            truncated: false,
            allowedKnown: true,
            memberId: null,
        });
        await listPhotosCmd('5', null);
        expect(text('info')).toHaveLength(3);
    });

    test.each([
        ['invalid-args', 'Use --challenge=<id>'],
        ['no-challenge-context', 'Join one first'],
        ['superseded', 'A newer request replaced this one'],
        ['library\u001b[0m down', 'library down'],
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
