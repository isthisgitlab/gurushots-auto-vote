import { scrollBehavior } from '@/utils/scrollBehavior';

describe('scrollBehavior', () => {
    const original = globalThis.matchMedia;
    afterEach(() => {
        globalThis.matchMedia = original;
    });

    const prefersReducedMotion = (reduce: boolean) => {
        const matchMedia = jest.fn((query: string) => ({ matches: reduce && query.includes('reduce') }));
        globalThis.matchMedia = matchMedia as unknown as typeof globalThis.matchMedia;
        return matchMedia;
    };

    test('is smooth by default', () => {
        const matchMedia = prefersReducedMotion(false);
        expect(scrollBehavior()).toBe('smooth');
        expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });

    test('is instant when the user asked for reduced motion', () => {
        prefersReducedMotion(true);
        expect(scrollBehavior()).toBe('auto');
    });

    test('is smooth where the platform has no matchMedia', () => {
        globalThis.matchMedia = undefined as unknown as typeof globalThis.matchMedia;
        expect(scrollBehavior()).toBe('smooth');
    });
});
