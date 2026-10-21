/**
 * The member-identity cache's negative-TTL expiry, on the module itself: a failed
 * lookup is retried after NEGATIVE_IDENTITY_TTL_MS, not before, and a resolved id
 * is kept for the process lifetime.
 */

import { invalid } from '../helpers/invalid';
import type * as memberIdentityModule from '../../src/ts/services/autoFill/memberIdentity';
const { resolveMemberId, NEGATIVE_IDENTITY_TTL_MS, __resetMemberIdCache } =
    require('../../src/ts/services/autoFill/memberIdentity') as typeof memberIdentityModule;

type Profile = Awaited<ReturnType<NonNullable<Parameters<typeof resolveMemberId>[1]>>>;
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

test('a failed lookup is shared while it is fresh and asked again once the negative TTL is out', async () => {
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(1);
    // Still fresh: the cached failure is answered again, without a request.
    now.mockReturnValue(1_000_000 + NEGATIVE_IDENTITY_TTL_MS - 1);
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(1);
    // Expired: the lookup runs once more (and its failure is cached again).
    now.mockReturnValue(1_000_000 + NEGATIVE_IDENTITY_TTL_MS);
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(2);
});

test('a resolved id never expires', async () => {
    profile.mockResolvedValue(invalid<Profile>({ id: 'm' }));
    await lookup('t');
    now.mockReturnValue(1_000_000 + NEGATIVE_IDENTITY_TTL_MS * 10);
    await lookup('t');
    expect(profile).toHaveBeenCalledTimes(1);
});
