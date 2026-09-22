/**
 * mock/voting.js — generated vote-image payloads for mock mode.
 */

const { generateMockVoteImages, mockVoteImages } = require('../../src/js/mock/voting');

afterEach(() => jest.restoreAllMocks());

describe('generateMockVoteImages', () => {
    test('with a real challenge, mirrors its id/title/url and exposure', () => {
        const original = {
            id: 77,
            title: 'Golden Hour',
            url: 'golden-hour',
            member: { ranking: { exposure: { exposure_factor: 63 } } },
        };
        const out = generateMockVoteImages('street-photography-2024', original);
        expect(out.challenge).toEqual({ id: 77, title: 'Golden Hour', url: 'golden-hour' });
        expect(out.voting.exposure).toEqual({ exposure_factor: 63, max_exposure: 100 });
    });

    test('without a challenge, derives a title from the url and randomises id/exposure in range', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const out = generateMockVoteImages('macro-photography-2024');
        expect(out.challenge).toEqual({ id: 1000, title: 'Macro Photography', url: 'macro-photography-2024' });
        expect(out.voting.exposure.exposure_factor).toBe(20);
        expect(out.images).toHaveLength(15);
    });

    test('an unknown url falls back to the street-photography titles', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const out = generateMockVoteImages('no-such-challenge', { id: 1, title: 'T', url: 'u' });
        expect(out.images.every((img) => img.title === 'Urban Life')).toBe(true);
        // No exposure on the challenge → a random 20-50% value.
        expect(out.voting.exposure.exposure_factor).toBe(20);
    });

    test('produces 15-25 well-formed images with 3-6 ratios', () => {
        const { images } = generateMockVoteImages('landscape-photography-2024', { id: 1, title: 'T', url: 'u' });
        expect(images.length).toBeGreaterThanOrEqual(15);
        expect(images.length).toBeLessThanOrEqual(25);
        images.forEach((img, i) => {
            expect(img.id).toBe(`vote_img_${String(i + 1).padStart(3, '0')}`);
            expect(img.ratio).toBeGreaterThanOrEqual(3);
            expect(img.ratio).toBeLessThanOrEqual(6);
        });
    });

    test('the module-level default payload is generated for street photography', () => {
        expect(mockVoteImages.challenge.url).toBe('street-photography-2024');
    });
});
