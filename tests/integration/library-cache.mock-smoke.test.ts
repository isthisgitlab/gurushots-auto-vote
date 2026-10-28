/**
 * Mock-mode smoke test of the photo-library cache, in a single process over the real settings facade
 * (an in-memory headless store), the real handlers, the real cache and the mock API: a first opening walks,
 * the next one for the same challenge answers from memory with its marks, another challenge gets the same
 * photos as a preview without marks, an action of this window (a submit) drops the challenge's listing, and a
 * logout forgets everything.
 */

import settings = require('../../src/ts/settings');
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as apiFactoryModule from '../../src/ts/apiFactory';
import type * as authModule from '../../src/ts/services/auth';
import type * as libraryCacheModule from '../../src/ts/services/libraryCache';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';

const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actionsHandlersModule;
const { getApiStrategy, refreshApi } = require('../../src/ts/apiFactory') as typeof apiFactoryModule;
const { clearAuthToken } = require('../../src/ts/services/auth') as typeof authModule;
const { clearLibraryCache } = require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;

// Mock endpoints answer after a simulated delay; give the whole story room.
jest.setTimeout(30000);

type Listing = {
    success: true;
    preview: boolean;
    readAtMs: number;
    allowedKnown: boolean;
    wonCount: number;
    truncated: boolean;
    nextStart: number;
    photos: Array<{ id: string; allowed: boolean; message: string | null }>;
};

const library = (challengeId: string | null, mode?: 'cached' | 'fresh', start?: number, keep?: number) =>
    invalid<
        (
            event: object,
            challenge: string | null,
            search: undefined,
            mode?: string,
            usage?: undefined,
            start?: number,
            keep?: number,
        ) => Promise<Listing>
    >(buildHandlers()['get-library-photos'])({}, challengeId, undefined, mode, undefined, start, keep);

beforeEach(() => {
    installHeadlessStore();
    settings.setSetting('mock', true);
    settings.setSetting('token', 'smoke-token');
    refreshApi();
    clearLibraryCache();
});

afterEach(() => {
    removeHeadlessStore();
});

test('a Refresh re-read of the on-screen extent replaces the kept listing with the newer one', async () => {
    const { challenges } = await getApiStrategy().getActiveChallenges('smoke-token');
    const [first] = challenges.map((challenge) => String(challenge.id));

    // The first opening walks the whole library and keeps it (12 rows, the mock's won photo left out).
    const walked = await library(first, 'cached');
    expect(walked).toMatchObject({ success: true, preview: false, truncated: false, nextStart: 12 });

    // Refresh asks for a 4-photo extent: under the mock's votes order the won
    // photo rides in page one (skipped, so only three were kept there) and the
    // page that crosses the extent is kept whole — two pages, 7 photos, a
    // SMALLER listing than the full walk above.
    const extent = await library(first, 'fresh', 0, 4);
    expect(extent.photos).toHaveLength(7);
    expect(extent).toMatchObject({ success: true, preview: false, truncated: true, nextStart: 8 });

    // …and the next cached opening answers the NEWER, smaller extent listing,
    // not the older full walk.
    const again = await library(first, 'cached');
    expect(again).toEqual(extent);
});

test('the story of a chooser opened again, for another challenge, after a submit and after a logout', async () => {
    const { challenges } = await getApiStrategy().getActiveChallenges('smoke-token');
    const [first, second] = challenges.map((challenge) => String(challenge.id));

    // A first opening walks the library; the mock's won photo is left out and counted.
    const walked = await library(first, 'cached');
    expect(walked).toMatchObject({ success: true, preview: false, allowedKnown: true, wonCount: 1 });
    expect(walked.photos.length).toBeGreaterThan(0);
    expect(walked.photos.some((photo) => photo.id === 'photo_won_009')).toBe(false);

    // The next opening for that challenge is the same listing, from memory.
    const again = await library(first, 'cached');
    expect(again).toEqual(walked);

    // Another challenge opens with the same photos as a preview, none of the first challenge's marks.
    const other = await library(second, 'cached');
    expect(other).toMatchObject({ preview: true, allowedKnown: false, readAtMs: walked.readAtMs, wonCount: 1 });
    expect(other.photos.map((photo) => photo.id)).toEqual(walked.photos.map((photo) => photo.id));
    expect(other.photos.every((photo) => !photo.allowed && photo.message === null)).toBe(true);

    // Submitting to the first challenge outdates its listing: the next opening is a preview again.
    await invalid<(event: object, id: string, ids: string[]) => Promise<unknown>>(
        buildHandlers()['submit-picked-photos'],
    )({}, first, [walked.photos[0].id]);
    expect(await library(first, 'cached')).toMatchObject({ preview: true, allowedKnown: false });

    // A fresh read writes it again; a logout forgets every listing.
    await library(first, 'fresh');
    expect(await library(first, 'cached')).toMatchObject({ preview: false });
    await clearAuthToken();
    // The logout core returned the mode to the environment default; the story continues in mock mode.
    settings.setSetting('mock', true);
    settings.setSetting('token', 'smoke-token');
    const afterLogout = await library(first, 'cached');
    expect(afterLogout).toMatchObject({ preview: false });
    expect(afterLogout.readAtMs).toBeGreaterThan(walked.readAtMs);
});
