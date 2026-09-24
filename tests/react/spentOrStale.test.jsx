import { spentOrStale } from '@/utils/spentOrStale';

describe('spentOrStale', () => {
    test('a successful spend refreshes', () => {
        expect(spentOrStale({ success: true })).toBe(true);
    });

    test('a not-available outcome refreshes (the card is stale)', () => {
        expect(spentOrStale({ success: false, outcome: 'not-available' })).toBe(true);
    });

    test('any other failure does not refresh', () => {
        expect(spentOrStale({ success: false, outcome: 'insufficient' })).toBe(false);
    });

    test('a missing result does not refresh', () => {
        expect(spentOrStale(null)).toBe(false);
        expect(spentOrStale(undefined)).toBe(false);
    });
});
