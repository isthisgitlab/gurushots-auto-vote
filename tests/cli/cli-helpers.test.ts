/**
 * Unit tests for the small CLI helper modules: guards (auth gate, profile /
 * challenge argument validation), prompts (readline I/O with the muted secret
 * prompt) and parseValue (string → setting value coercion). process.exit is
 * stubbed to throw so a guard's early exit halts the helper like the real one.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error') };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});

jest.mock('../../src/ts/apiFactory', () => {
    const isAuthenticated = jest.fn(() => true);
    return { __isAuthenticated: isAuthenticated, getMiddleware: jest.fn(() => ({ isAuthenticated })) };
});

jest.mock('node:readline', () => ({ createInterface: jest.fn(() => ({ tag: 'rl' })) }));

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __isAuthenticated: ReturnType<typeof apiFactoryModule.getMiddleware>['isAuthenticated'];
        }
    >(apiFactoryModule),
);
import readlineModule = require('node:readline');
const readline = jest.mocked(readlineModule);
import type * as guardsModule from '../../src/ts/cli/guards';
import type * as promptsModule from '../../src/ts/cli/prompts';
import type * as parseValueModule from '../../src/ts/cli/parseValue';
import { invalid } from '../helpers/invalid';
const { ensureAuthenticated, requireProfileArgs, requireChallenge } =
    require('../../src/ts/cli/guards') as typeof guardsModule;
const { createReadlineInterface, askYesNo, askInput, askSecret } =
    require('../../src/ts/cli/prompts') as typeof promptsModule;
const { parseSettingValue } = require('../../src/ts/cli/parseValue') as typeof parseValueModule;

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => c.msg);

let exitSpy: jest.SpiedFunction<typeof process.exit>;
beforeEach(() => {
    logger.__calls.length = 0;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit:${code}`);
    });
});
afterEach(() => exitSpy.mockRestore());

describe('ensureAuthenticated', () => {
    test('returns true silently when a token is present', () => {
        apiFactory.__isAuthenticated.mockReturnValue(true);
        expect(ensureAuthenticated()).toBe(true);
        expect(logger.__calls).toHaveLength(0);
    });

    test('returns false and prints the login guidance when no token', () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);
        expect(ensureAuthenticated()).toBe(false);
        expect(msgs('error')[0]).toMatch(/Please login first/);
        expect(msgs('info')).toEqual(['Run: login']);
    });
});

describe('requireProfileArgs', () => {
    test('returns the profile name when valid', () => {
        expect(requireProfileArgs('delete-profile', { challengeId: null, rest: ['p1'] })).toBe('p1');
        expect(requireProfileArgs('save-profile', { challengeId: '5', rest: ['p1'] }, { needsChallenge: true })).toBe(
            'p1',
        );
    });

    test('exits with usage when the name is missing', () => {
        expect(() => requireProfileArgs('delete-profile', { challengeId: null, rest: [] })).toThrow('exit:1');
        expect(msgs('error')).toEqual(['Please specify a profile name']);
        expect(msgs('info')).toEqual(['Usage: delete-profile "<name>"']);
    });

    test('usage mentions --challenge when the command needs one', () => {
        expect(() =>
            requireProfileArgs('apply-profile', { challengeId: null, rest: [] }, { needsChallenge: true }),
        ).toThrow('exit:1');
        expect(msgs('info')).toEqual(['Usage: apply-profile "<name>" --challenge=<id>']);
    });

    test('rejects an unquoted multi-word name (with and without challenge hint)', () => {
        expect(() => requireProfileArgs('delete-profile', { challengeId: null, rest: ['a', 'b', 'c'] })).toThrow(
            'exit:1',
        );
        expect(msgs('error')).toEqual(['Unexpected extra arguments: b c']);
        expect(msgs('info')[0]).toBe('Quote profile names containing spaces: delete-profile "2-pic tactic"');

        logger.__calls.length = 0;
        expect(() =>
            requireProfileArgs('save-profile', { challengeId: '1', rest: ['a', 'b'] }, { needsChallenge: true }),
        ).toThrow('exit:1');
        expect(msgs('info')[0]).toBe(
            'Quote profile names containing spaces: save-profile "2-pic tactic" --challenge=<id>',
        );
    });

    test('exits with the challenge hint when a required challenge is missing', () => {
        expect(() =>
            requireProfileArgs(
                'save-profile',
                { challengeId: null, rest: ['p'] },
                { needsChallenge: true, challengeHint: 'need a challenge' },
            ),
        ).toThrow('exit:1');
        expect(msgs('error')).toEqual(['need a challenge']);
    });
});

describe('requireChallenge', () => {
    test('returns the id when present', () => {
        expect(requireChallenge({ challengeId: '42' }, 'usage')).toBe('42');
    });

    test('exits with the command usage when missing', () => {
        expect(() => requireChallenge({ challengeId: null }, 'Usage: boost')).toThrow('exit:1');
        expect(msgs('error')).toEqual(['Please specify a challenge']);
        expect(msgs('info')).toEqual(['Usage: boost']);
    });
});

describe('prompts', () => {
    type FakeRl = {
        output: { write: jest.Mock<void, [string]> };
        question: jest.Mock<void, [string, (answer: string) => void]>;
        pendingCb: () => void;
        _writeToOutput?: (s: string) => void;
        stdoutMuted?: boolean;
    };
    const fakeRl = (answer: string) => {
        const rl = invalid<FakeRl>({
            output: { write: jest.fn() },
            question: jest.fn((q: string, cb: (answer: string) => void) => {
                rl.pendingCb = () => cb(answer);
            }),
        });
        return rl;
    };

    test('createReadlineInterface binds stdin/stdout', () => {
        expect(createReadlineInterface()).toEqual({ tag: 'rl' });
        expect(readline.createInterface).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout });
    });

    test.each([
        [' Y ', true],
        ['yes', true],
        ['no', false],
        ['', false],
    ])('askYesNo(%p) → %p', async (answer, expected) => {
        const rl = fakeRl(answer);
        const p = askYesNo('Continue?', invalid(rl));
        expect(rl.question.mock.calls[0][0]).toBe('Continue? (y/n): ');
        rl.pendingCb();
        await expect(p).resolves.toBe(expected);
    });

    test('askInput trims the answer', async () => {
        const rl = fakeRl('  me@x.io ');
        const p = askInput('Email: ', invalid(rl));
        rl.pendingCb();
        await expect(p).resolves.toBe('me@x.io');
    });

    test('askSecret mutes echo while typing and restores the original writer after', async () => {
        const original = jest.fn();
        const rl = fakeRl(' hunter2 ');
        rl._writeToOutput = original;
        const p = askSecret('Password: ', invalid(rl));

        expect(rl.stdoutMuted).toBe(true);
        rl._writeToOutput('h');
        expect(rl.output.write).not.toHaveBeenCalled();
        rl._writeToOutput('\r\n');
        expect(rl.output.write).toHaveBeenCalledWith('\r\n');
        rl._writeToOutput('\n');
        expect(rl.output.write).toHaveBeenCalledWith('\n');

        // Unmuted while the hook is still installed: delegates to the original writer.
        rl.stdoutMuted = false;
        const hook = rl._writeToOutput;
        hook('visible');
        expect(original).toHaveBeenCalledWith('visible');
        expect(original.mock.contexts[0]).toBe(rl);

        rl.pendingCb();
        await expect(p).resolves.toBe('hunter2');
        expect(rl.stdoutMuted).toBe(false);
        expect(rl._writeToOutput).toBe(original);
    });

    test('askSecret falls back to output.write when readline had no writer hook', async () => {
        const rl = fakeRl('pw');
        const p = askSecret('Password: ', invalid(rl));
        rl.stdoutMuted = false;
        rl._writeToOutput!('plain');
        expect(rl.output.write).toHaveBeenCalledWith('plain');
        rl.pendingCb();
        await expect(p).resolves.toBe('pw');
        expect(rl._writeToOutput).toBeUndefined();
    });
});

describe('parseSettingValue', () => {
    test.each([
        ['80', 80],
        ['null', null],
        ['"x"', 'x'],
        ['[1,2]', [1, 2]],
        ['true', true],
        ['1.5e', '1.5e'],
        ['.5', 0.5],
        ['dark', 'dark'],
        ['', ''],
        ['  ', '  '],
    ])('%p → %p', (raw, expected) => {
        expect(parseSettingValue(raw)).toEqual(expected);
    });
});
