/**
 * useImageLoads — probes a URL with a detached Image and reports false once it
 * fails. A fake Image constructor captures each probe so onerror can be fired.
 */
import { renderHook, act } from '@testing-library/preact';
import { useImageLoads } from '@/hooks/useImageLoads';

describe('useImageLoads', () => {
    let probes;
    let OriginalImage;

    beforeEach(() => {
        probes = [];
        OriginalImage = global.Image;
        global.Image = function FakeImage() {
            probes.push(this);
        };
    });

    afterEach(() => {
        global.Image = OriginalImage;
    });

    test('falsy url is false and starts no probe', () => {
        const { result } = renderHook(() => useImageLoads(null));
        expect(result.current).toBe(false);
        expect(probes).toHaveLength(0);
    });

    test('optimistic true, flips false when the probe errors', () => {
        const { result } = renderHook(() => useImageLoads('https://x/a.jpg'));
        expect(result.current).toBe(true);
        expect(probes[0].src).toBe('https://x/a.jpg');
        act(() => probes[0].onerror());
        expect(result.current).toBe(false);
    });

    test("a stale probe's failure after the url changed does not condemn the new url", () => {
        const { result, rerender } = renderHook(({ url }) => useImageLoads(url), {
            initialProps: { url: 'https://x/a.jpg' },
        });
        rerender({ url: 'https://x/b.jpg' });
        act(() => probes[0].onerror());
        expect(result.current).toBe(true);
        act(() => probes[1].onerror());
        expect(result.current).toBe(false);
        // Changing url again resets the failure.
        rerender({ url: 'https://x/c.jpg' });
        expect(result.current).toBe(true);
    });
});
