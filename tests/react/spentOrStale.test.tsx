import { alreadyEntered, spentOrStale } from '@/utils/spentOrStale';

describe('spentOrStale', () => {
    test('a successful spend refreshes', () => {
        expect(spentOrStale({ success: true })).toBe(true);
    });

    test('a not-available outcome refreshes (the card is stale)', () => {
        expect(spentOrStale({ success: false, outcome: 'not-available' })).toBe(true);
    });

    test('a data-incomplete refusal refreshes like not-available (the card is stale)', () => {
        expect(spentOrStale({ success: false, outcome: 'data-incomplete' })).toBe(true);
    });

    test('any other failure does not refresh', () => {
        expect(spentOrStale({ success: false, outcome: 'insufficient' })).toBe(false);
        expect(spentOrStale({ success: false, outcome: 'ok' })).toBe(false);
    });

    test('a missing result does not refresh', () => {
        expect(spentOrStale(null)).toBe(false);
        expect(spentOrStale(undefined)).toBe(false);
    });
});

describe('alreadyEntered', () => {
    test('a refusal for a photo that is entered already is one', () => {
        expect(alreadyEntered({ success: false, outcome: 'already-entered' })).toBe(true);
    });

    test('anything else is not', () => {
        expect(alreadyEntered({ success: true, outcome: 'already-entered' })).toBe(false);
        expect(alreadyEntered({ success: false, outcome: 'not-available' })).toBe(false);
        expect(alreadyEntered(null)).toBe(false);
        expect(alreadyEntered(undefined)).toBe(false);
    });
});
