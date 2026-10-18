/**
 * useImageLoads — listens for `error` on the rendered <img> (through the returned callback ref) and reports
 * false once the current URL has failed. The probe keeps its <img> mounted whatever the hook says, so a test
 * can fire errors on it across URL changes.
 */
import { act, render, screen } from '@testing-library/preact';
import { useImageLoads } from '@/hooks/useImageLoads';

function Probe({ url }: { url: string | null }) {
    const [loads, imageRef] = useImageLoads(url);
    return <img ref={imageRef} src={url ?? undefined} alt="" data-testid="img" data-loads={String(loads)} />;
}

const img = () => screen.getByTestId('img');
const loads = () => img().getAttribute('data-loads');
const fail = () =>
    act(() => {
        img().dispatchEvent(new Event('error'));
    });

describe('useImageLoads', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a falsy url is false and listens for nothing', () => {
        const add = jest.spyOn(HTMLImageElement.prototype, 'addEventListener');
        render(<Probe url={null} />);
        expect(loads()).toBe('false');
        expect(add).not.toHaveBeenCalledWith('error', expect.anything());
    });

    test('optimistic true, flips false when the image errors', () => {
        render(<Probe url="https://x/a.jpg" />);
        expect(loads()).toBe('true');
        fail();
        expect(loads()).toBe('false');
    });

    test('a new url starts as not failed, and fails on its own error', () => {
        const { rerender } = render(<Probe url="https://x/a.jpg" />);
        fail();
        expect(loads()).toBe('false');
        rerender(<Probe url="https://x/b.jpg" />);
        expect(loads()).toBe('true');
        fail();
        expect(loads()).toBe('false');
        rerender(<Probe url="https://x/c.jpg" />);
        expect(loads()).toBe('true');
    });

    test('an error that arrives late for the previous url does not hide the new one', () => {
        const add = jest.spyOn(HTMLImageElement.prototype, 'addEventListener');
        const { rerender } = render(<Probe url="https://x/a.jpg" />);
        const errorListeners = () =>
            add.mock.calls.filter(([type]) => type === 'error').map(([, listener]) => listener as () => void);
        const forA = errorListeners()[0];
        rerender(<Probe url="https://x/b.jpg" />);
        act(() => forA());
        expect(loads()).toBe('true');
        fail();
        expect(loads()).toBe('false');
    });

    test('the listener is removed when the url changes and when the image unmounts', () => {
        const add = jest.spyOn(HTMLImageElement.prototype, 'addEventListener');
        const remove = jest.spyOn(HTMLImageElement.prototype, 'removeEventListener');
        const { rerender, unmount } = render(<Probe url="https://x/a.jpg" />);
        const added = () => add.mock.calls.filter(([type]) => type === 'error').map(([, listener]) => listener);
        const removed = () => remove.mock.calls.filter(([type]) => type === 'error').map(([, listener]) => listener);
        expect(added()).toHaveLength(1);
        expect(removed()).toEqual([]);
        rerender(<Probe url="https://x/b.jpg" />);
        expect(removed()).toEqual([added()[0]]);
        unmount();
        expect(removed()).toEqual([added()[0], added()[1]]);
    });
});
