/**
 * The member-identity cache's explicit-retry throttle (forgetFailedMemberId), on the module itself:
 * the first retry after a failed lookup asks at once, repeated presses inside the gap share the
 * cached failure, and the record of who has retried is bounded like the cache.
 */

import { invalid } from '../helpers/invalid';
import type * as memberIdentityModule from '../../src/ts/services/autoFill/memberIdentity';
const { resolveMemberId, forgetFailedMemberId, __resetMemberIdCache } =
    require('../../src/ts/services/autoFill/memberIdentity') as typeof memberIdentityModule;

type Profile = Awaited<ReturnType<NonNullable<Parameters<typeof memberIdentityModule.resolveMemberId>[1]>>>;
let profile: jest.MockedFunction<(token: string) => Promise<Profile>>;
let now: jest.SpiedFunction<typeof Date.now>;

beforeEach(() => {
    __resetMemberIdCache();
    profile = jest.fn<Promise<Profile>, [string]>().mockResolvedValue(null);
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
});

afterEach(() => {
    jest.restoreAllMocks();
});

const lookup = (token: string) => resolveMemberId(token, profile);

test('the first explicit retry after a failed lookup asks at once; repeated presses inside the gap share the failure', async () => {
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_100);
    forgetFailedMemberId('t');
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_100 + 4_999);
    forgetFailedMemberId('t');
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_000_100 + 5_000);
    forgetFailedMemberId('t');
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(3);
});

test('a resolved id and a lookup in flight are never evicted', async () => {
    profile.mockResolvedValue(invalid<Profile>({ id: 'm' }));
    await lookup('ok');
    forgetFailedMemberId('ok');
    await lookup('ok');
    expect(profile).toHaveBeenCalledTimes(1);

    profile.mockReturnValue(new Promise(() => undefined));
    void lookup('slow');
    forgetFailedMemberId('slow');
    void lookup('slow');
    expect(profile).toHaveBeenCalledTimes(2);
});

test('a press during an in-flight lookup, or with nothing cached, uses up none of the allowance', async () => {
    // Nothing cached: nothing to evict, and no gap starts.
    forgetFailedMemberId('t');
    let fail!: (value: Profile) => void;
    profile.mockReturnValueOnce(new Promise<Profile>((resolve) => (fail = resolve)));
    const inFlight = lookup('t');
    // In flight: callers share it, so it is not evicted and no gap starts.
    forgetFailedMemberId('t');
    expect(profile).toHaveBeenCalledTimes(1);
    fail(null);
    await inFlight;

    // The lookup failed; a Retry right away still gets through (no gap was started by the presses above).
    now.mockReturnValue(1_000_000 + 100);
    forgetFailedMemberId('t');
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(2);
    // And that eviction does start one.
    forgetFailedMemberId('t');
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(2);
});

test('the record of who has retried is bounded: past the bound the oldest are forgotten, not kept forever', async () => {
    const retryOnce = async (token: string) => {
        await lookup(token);
        forgetFailedMemberId(token);
    };
    await retryOnce('t1');
    await lookup('t1');
    expect(profile).toHaveBeenCalledTimes(2);
    // Inside t1's gap a press is refused...
    forgetFailedMemberId('t1');
    await lookup('t1');
    expect(profile).toHaveBeenCalledTimes(2);
    // ...but once more tokens than the bound have retried, t1's record is gone and its press goes through.
    for (const token of ['t2', 't3', 't4', 't5']) await retryOnce(token);
    forgetFailedMemberId('t1');
    await lookup('t1');
    expect(profile).toHaveBeenCalledTimes(3 + 4);
});
