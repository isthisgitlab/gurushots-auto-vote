/**
 * Mock-mode smoke test of the photo picker's "GS suggestions": the real handler over the mock API, in one process
 * over the real settings facade (an in-memory headless store). A joined mock challenge and the open one (900001)
 * both answer the three suggested library photos, and the walk is complete (not `gs-suggestions-incomplete`).
 * The open challenge 900002, which GuruShots suggests nothing for, answers `no-gs-suggestions`.
 */

import settings = require('../../src/ts/core/settings');
import type * as actionsHandlersModule from '../../src/ts/core/ipc/actions.handlers';
import type * as apiFactoryModule from '../../src/ts/core/apiFactory';
import type * as photoLibraryModule from '../../src/ts/core/mock/photoLibrary';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';

const { buildHandlers } = require('../../src/ts/core/ipc/actions.handlers') as typeof actionsHandlersModule;
const { getApiStrategy, refreshApi } = require('../../src/ts/core/apiFactory') as typeof apiFactoryModule;
const { SUGGESTED_PHOTO_IDS } = require('../../src/ts/core/mock/photoLibrary') as typeof photoLibraryModule;

// Mock endpoints answer after a simulated delay; give the whole story room.
jest.setTimeout(30000);

type SuggestReply = {
    success: boolean;
    error?: string;
    source?: string;
    photos?: Array<{ id: string; allowed: boolean }>;
};
const suggest = (id: string | number, usage: 'submit' | 'swap') =>
    invalid<
        (event: object, id: string | number, usage: string, exclude: string[], source: string) => Promise<SuggestReply>
    >(buildHandlers()['suggest-photos'])({}, id, usage, [], 'gurushots');

beforeEach(() => {
    installHeadlessStore();
    settings.setSetting('mock', true);
    settings.setSetting('token', 'smoke-token');
    refreshApi();
});

afterEach(() => {
    removeHeadlessStore();
});

test.each(['submit', 'swap'] as const)(
    'the open challenge 900001 shows the three library photos (%s)',
    async (usage) => {
        const reply = await suggest(900001, usage);
        expect(reply.error).toBeUndefined();
        expect(reply).toMatchObject({ success: true, source: 'gurushots' });
        expect(reply.photos?.map((photo) => photo.id)).toEqual([...SUGGESTED_PHOTO_IDS]);
        expect(reply.photos?.every((photo) => photo.allowed)).toBe(true);
    },
);

test.each(['submit', 'swap'] as const)(
    'a joined mock challenge shows the three library photos too (%s)',
    async (usage) => {
        const active = await getApiStrategy().getActiveChallenges('smoke-token');
        const joined = active?.challenges[0];
        expect(joined).toBeDefined();
        const reply = await suggest(String(joined?.id), usage);
        expect(reply.error).toBeUndefined();
        expect(reply.photos?.map((photo) => photo.id)).toEqual([...SUGGESTED_PHOTO_IDS]);
    },
);

test('a challenge GuruShots suggests nothing for (900002) answers no-gs-suggestions', async () => {
    await expect(suggest(900002, 'submit')).resolves.toEqual({ success: false, error: 'no-gs-suggestions' });
});
