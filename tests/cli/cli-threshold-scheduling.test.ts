/**
 * CLI/Node threshold-entry calculation.
 *
 * The logic lives in src/ts/scheduling/thresholdWindow.ts, consumed by
 * runScheduler.ts with a synchronous settings.getEffectiveSetting resolver.
 * These tests import the real module and use a sync resolver to represent the
 * CLI/Node path. Real scheduler switch/revert behavior is covered by
 * tests/scheduling/runScheduler.test.ts.
 */

import type * as thresholdWindowModule from '../../src/ts/scheduling/thresholdWindow';
import { invalid } from '../helpers/invalid';

const { calculateNextThresholdEntry } =
    require('../../src/ts/scheduling/thresholdWindow') as typeof thresholdWindowModule;

// CLI/Node resolver shape: synchronous return (settings.getEffectiveSetting).
const resolveThreshold = () => 5;

describe('CLI threshold entry calculation (shared thresholdWindow, sync resolver)', () => {
    it('returns the soonest non-flash challenge to cross its last-minute boundary', async () => {
        const now = Math.floor(Date.now() / 1000);
        const challenges = [
            { id: 1, title: 'Challenge 1', type: 'regular', close_time: now + 3600 },
            { id: 2, title: 'Challenge 2', type: 'regular', close_time: now + 1800 },
            { id: 3, title: 'Flash Challenge', type: 'flash', close_time: now + 1200 },
        ];

        const result = await calculateNextThresholdEntry(invalid(challenges), now, resolveThreshold);

        expect(result).not.toBeNull();
        expect(result!.challengeId).toBe(2); // 30 min - 5 min threshold = soonest entry
        expect(result!.entryTime).toBe(now + 1800 - 300);
        expect(result!.lastMinuteThreshold).toBe(5);
    });

    it('skips flash challenges', async () => {
        const now = Math.floor(Date.now() / 1000);
        const challenges = [{ id: 1, title: 'Flash Challenge', type: 'flash', close_time: now + 1800 }];
        expect(await calculateNextThresholdEntry(invalid(challenges), now, resolveThreshold)).toBeNull();
    });

    it('skips ended challenges', async () => {
        const now = Math.floor(Date.now() / 1000);
        const challenges = [{ id: 1, title: 'Ended Challenge', type: 'regular', close_time: now - 3600 }];
        expect(await calculateNextThresholdEntry(invalid(challenges), now, resolveThreshold)).toBeNull();
    });
});
