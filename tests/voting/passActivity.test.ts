/**
 * The count of voting passes under way, which the local-data wipe refuses to run beneath.
 */

import { beginVotingPass, isVotingPassRunning } from '../../src/ts/voting/passActivity';

describe('voting pass activity', () => {
    test('is idle until a pass begins, and idle again once it ends', () => {
        expect(isVotingPassRunning()).toBe(false);
        const end = beginVotingPass();
        expect(isVotingPassRunning()).toBe(true);
        end();
        expect(isVotingPassRunning()).toBe(false);
    });

    test('overlapping passes keep it running until the last one ends', () => {
        const first = beginVotingPass();
        const second = beginVotingPass();
        first();
        expect(isVotingPassRunning()).toBe(true);
        second();
        expect(isVotingPassRunning()).toBe(false);
    });

    test('ending the same pass twice does not end another', () => {
        const first = beginVotingPass();
        const second = beginVotingPass();
        first();
        first();
        expect(isVotingPassRunning()).toBe(true);
        second();
        expect(isVotingPassRunning()).toBe(false);
    });
});
