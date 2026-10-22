/**
 * mock/voting.ts — generated vote-image payloads for mock mode.
 */

import type * as votingModule from '../../src/ts/mock/voting';

import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { generateMockVoteImages } = require('../../src/ts/mock/voting') as typeof votingModule;

afterEach(() => jest.restoreAllMocks());

describe('generateMockVoteImages', () => {
    test('with a real challenge, mirrors its id/title/url and exposure', () => {
        const original = invalid<Challenge>({
            id: 77,
            title: 'Golden Hour',
            url: 'golden-hour',
            member: {
                ranking: {
                    exposure: { exposure_factor: 63, vote_exposure_factor: 61, vote_ratio: 2.4 },
                },
            },
        });
        const out = generateMockVoteImages('street-photography-2024', original);
        expect(out.challenge).toEqual({ id: 77, title: 'Golden Hour', url: 'golden-hour' });
        expect(out.voting.exposure).toEqual({ exposure_factor: 63, vote_exposure_factor: 61, vote_ratio: 2.4 });
    });

    test('without a challenge, derives a title from the url and randomises id/exposure in range', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const out = generateMockVoteImages('macro-photography-2024');
        expect(out.challenge).toEqual({ id: 1000, title: 'Macro Photography', url: 'macro-photography-2024' });
        expect(out.voting.exposure).toEqual({ exposure_factor: 20, vote_exposure_factor: 20, vote_ratio: 1 });
        expect(out.images).toHaveLength(15);
    });

    test('an unknown url still yields the title derived from it', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const out = generateMockVoteImages('no-such-challenge');
        expect(out.challenge).toEqual({ id: 1000, title: 'No Such Challenge', url: 'no-such-challenge' });
    });

    test('produces 15-25 well-formed images with 3-6 ratios', () => {
        const { images } = generateMockVoteImages(
            'landscape-photography-2024',
            invalid({ id: 1, title: 'T', url: 'u' }),
        );
        expect(images.length).toBeGreaterThanOrEqual(15);
        expect(images.length).toBeLessThanOrEqual(25);
        images.forEach((img, i) => {
            expect(img.id).toBe(`vote_img_${String(i + 1).padStart(3, '0')}`);
            expect(img.ratio).toBeGreaterThanOrEqual(3);
            expect(img.ratio).toBeLessThanOrEqual(6);
        });
    });
});
