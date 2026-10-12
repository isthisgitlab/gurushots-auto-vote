/**
 * outcomeMeta — the line a join leaves under its Discover row, and which actions the row offers.
 */

import { outcomeMeta } from '@/utils/discoverOutcome';

test('a status says what it says, unless a reason makes it more exact', () => {
    expect(outcomeMeta({ status: 'joined' })).toEqual({
        key: 'app.discoverJoined',
        variant: 'success',
        retry: false,
        forget: false,
    });
    expect(outcomeMeta({ status: 'charged-pending-submit' })).toEqual({
        key: 'app.discoverChargedPending',
        variant: 'error',
        retry: true,
        forget: false,
    });
    expect(outcomeMeta({ status: 'charged-pending-submit', reason: 'no-photo' })).toEqual({
        key: 'app.discoverPendingNoPhoto',
        variant: 'error',
        retry: false,
        forget: false,
    });
    expect(outcomeMeta({ status: 'failed-no-charge', reason: 'account-unknown' })).toEqual({
        key: 'app.discoverAccountUnknown',
        variant: 'error',
        retry: false,
        forget: false,
    });
});

test('an unconfirmed payment offers "I wasn\'t charged" as well as the retry; an older version\'s record only the retry', () => {
    expect(outcomeMeta({ status: 'charged-pending-submit', reason: 'unconfirmed' })).toEqual({
        key: 'app.discoverUnconfirmed',
        variant: 'error',
        retry: true,
        forget: true,
    });
    expect(outcomeMeta({ status: 'charged-pending-submit', reason: 'earlier-payment' })).toEqual({
        key: 'app.discoverEarlierPayment',
        variant: 'error',
        retry: true,
        forget: false,
    });
});

test('a reason that does not belong to the status changes nothing', () => {
    expect(outcomeMeta({ status: 'joined', reason: 'no-photo' }).key).toBe('app.discoverJoined');
    expect(outcomeMeta({ status: 'failed-no-charge', reason: 'unconfirmed' })).toMatchObject({
        key: 'app.discoverFailedNoCharge',
        forget: false,
    });
});

test('a result with no status, or one that is not mapped, carries its own error text', () => {
    expect(outcomeMeta({})).toEqual({ key: null, variant: 'error', retry: false, forget: false });
    expect(outcomeMeta({ status: 'weird' })).toEqual({ key: null, variant: 'error', retry: false, forget: false });
});
