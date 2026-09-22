/**
 * Tests for computations.handlers — get-deadline-actions, the read-only
 * per-card deadline timeline. Covers the renderer-supplied-argument
 * validation (defense-in-depth on the challenge id), delegation to
 * VotingLogic.describeDeadlineActions with a unix-seconds `now`, and the
 * never-throw error envelope (which must not leak the internal message).
 */

jest.mock('../../src/js/services/VotingLogic', () => ({ describeDeadlineActions: jest.fn() }));

const votingLogic = require('../../src/js/services/VotingLogic');
const { buildHandlers, register } = require('../../src/js/ipc/computations.handlers');

let handler;

beforeEach(() => {
    jest.clearAllMocks();
    handler = buildHandlers()['get-deadline-actions'];
});

describe('get-deadline-actions', () => {
    test.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'c1'],
        ['a number', 7],
        ['an array', [{ id: 1 }]],
    ])('rejects %s as the challenge', async (_label, challenge) => {
        await expect(handler({}, challenge)).resolves.toEqual({ success: false, error: 'invalid challenge' });
        expect(votingLogic.describeDeadlineActions).not.toHaveBeenCalled();
    });

    test.each([
        ['missing', {}],
        ['an object', { id: { $ne: 1 } }],
        ['an array', { id: [1] }],
        ['a boolean', { id: true }],
    ])('rejects a challenge whose id is %s', async (_label, challenge) => {
        await expect(handler({}, challenge)).resolves.toEqual({ success: false, error: 'invalid challenge id' });
        expect(votingLogic.describeDeadlineActions).not.toHaveBeenCalled();
    });

    test.each([
        ['string', 'c1'],
        ['number', 42],
    ])('passes a challenge with a %s id and the current unix time to VotingLogic', async (_label, id) => {
        const actions = [{ kind: 'boost', at: 100 }];
        votingLogic.describeDeadlineActions.mockReturnValue({ actions, boostBlocked: true, extra: 'dropped' });
        const challenge = { id, close_time: 999 };
        const before = Math.floor(Date.now() / 1000);

        const result = await handler({}, challenge);

        const after = Math.floor(Date.now() / 1000);
        expect(result).toEqual({ success: true, actions, boostBlocked: true });
        const [passedChallenge, now] = votingLogic.describeDeadlineActions.mock.calls[0];
        expect(passedChallenge).toBe(challenge);
        expect(Number.isInteger(now)).toBe(true);
        expect(now).toBeGreaterThanOrEqual(before);
        expect(now).toBeLessThanOrEqual(after);
    });

    test('returns a generic failure (no internal message) when VotingLogic throws', async () => {
        votingLogic.describeDeadlineActions.mockImplementation(() => {
            throw new Error('internal detail');
        });
        await expect(handler({}, { id: 1 })).resolves.toEqual({
            success: false,
            error: 'Failed to compute deadline actions',
        });
    });
});

describe('register', () => {
    test('registers get-deadline-actions through the guarded registerHandlers', async () => {
        const channels = new Map();
        register({ handle: (channel, impl) => channels.set(channel, impl) });
        expect([...channels.keys()]).toEqual(['get-deadline-actions']);

        // An untrusted (remote main frame) sender is refused before the handler runs.
        const frame = { url: 'https://evil.example/' };
        const result = await channels.get('get-deadline-actions')(
            { senderFrame: frame, sender: { mainFrame: frame } },
            {
                id: 1,
            },
        );
        expect(result).toEqual({ success: false, error: 'Refused: untrusted sender' });
        expect(votingLogic.describeDeadlineActions).not.toHaveBeenCalled();
    });
});
