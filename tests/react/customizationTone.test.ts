/** The class each customization source colours a jump-list chip and a setting's source badge with. */

import { chipToneOf, sourceBadgeTone } from '@/utils/customizationTone';

describe('chipToneOf', () => {
    test.each([
        ['manual', 'btn-accent'],
        ['profile', 'btn-info'],
        ['rule', 'btn-secondary'],
    ] as const)('%s gives %s', (kind, tone) => {
        expect(chipToneOf(kind)).toBe(tone);
    });

    test('both gives the profile tone', () => {
        expect(chipToneOf('both')).toBe('btn-info');
    });

    test('no customization gives no tone', () => {
        expect(chipToneOf(undefined)).toBe('');
    });
});

describe('sourceBadgeTone', () => {
    test.each([
        ['manual', 'badge-accent'],
        ['profile', 'badge-info'],
        ['rule', 'badge-secondary'],
    ] as const)('%s gives %s', (source, tone) => {
        expect(sourceBadgeTone(source)).toBe(tone);
    });
});
