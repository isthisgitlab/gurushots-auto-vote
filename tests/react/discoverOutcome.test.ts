/**
 * outcomeMeta — the line a join leaves under its Discover row, and whether the row offers Retry submit.
 */

import { outcomeMeta } from '@/utils/discoverOutcome';

test('a status says what it says, unless a reason makes it more exact', () => {
    expect(outcomeMeta({ status: 'joined' })).toEqual({ key: 'app.discoverJoined', variant: 'success', retry: false });
    expect(outcomeMeta({ status: 'charged-pending-submit' })).toEqual({
        key: 'app.discoverChargedPending',
        variant: 'error',
        retry: true,
    });
    expect(outcomeMeta({ status: 'charged-pending-submit', reason: 'no-photo' })).toEqual({
        key: 'app.discoverPendingNoPhoto',
        variant: 'error',
        retry: false,
    });
    expect(outcomeMeta({ status: 'charged-pending-submit', reason: 'unconfirmed' })).toEqual({
        key: 'app.discoverUnconfirmed',
        variant: 'error',
        retry: true,
    });
    expect(outcomeMeta({ status: 'failed-no-charge', reason: 'account-unknown' })).toEqual({
        key: 'app.discoverAccountUnknown',
        variant: 'error',
        retry: false,
    });
});

test('a reason that does not belong to the status changes nothing', () => {
    expect(outcomeMeta({ status: 'joined', reason: 'no-photo' }).key).toBe('app.discoverJoined');
    expect(outcomeMeta({ status: 'failed-no-charge', reason: 'unconfirmed' }).key).toBe('app.discoverFailedNoCharge');
});

test('a result with no status, or one that is not mapped, carries its own error text', () => {
    expect(outcomeMeta({})).toEqual({ key: null, variant: 'error', retry: false });
    expect(outcomeMeta({ status: 'weird' })).toEqual({ key: null, variant: 'error', retry: false });
});
