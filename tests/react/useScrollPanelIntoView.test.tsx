/**
 * useScrollPanelIntoView — the modal-body scroll both settings modals run on
 * a user tab selection. happy-dom measures zero rects and zero offsetHeight,
 * so the tests spy on getBoundingClientRect, define the sticky chrome's
 * offsetHeight on its element, and drive both the scroll and the no-scroll
 * branches through the stubs.
 */
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from './helpers/test-utils';
import { useScrollPanelIntoView } from '@/hooks/useScrollPanelIntoView';

const rect = (top: number): DOMRect => ({
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => rect(top),
});

/** The body measures `bodyTop`; everything else (the panels) `panelTop`. */
let rectTops = { body: 100, panel: 60 };
const stubRects = (bodyTop: number, panelTop: number) => {
    rectTops = { body: bodyTop, panel: panelTop };
};

/** happy-dom leaves offsetHeight at 0; the sticky chrome's height is defined on its element. */
const setStickyHeight = (height: number) => {
    const sticky = document.getElementById('sticky-chrome')!;
    Object.defineProperty(sticky, 'offsetHeight', { value: height, configurable: true });
};

/**
 * The wiring the settings modals build on: `select-b` is the user path
 * (select, then ask for the scroll), `reveal-a`/`reveal-b` select without
 * asking, `bump` re-renders without a request, and `request-missing` names a
 * panel that is not in the DOM. `withSticky={false}` leaves the sticky ref
 * unattached, as when the chrome is not mounted at scroll time.
 */
function HookHarness({ withBody = true, withSticky = true }: { withBody?: boolean; withSticky?: boolean }) {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const stickyRef = useRef<HTMLDivElement | null>(null);
    const scrollPanelIntoView = useScrollPanelIntoView(bodyRef, stickyRef);
    const [active, setActive] = useState('a');
    const [, bumpRender] = useState(0);
    const panels = (
        <>
            <div id="panel-a" data-rect="panel" hidden={active !== 'a'}>
                panel a
            </div>
            <div id="panel-b" data-rect="panel" hidden={active !== 'b'}>
                panel b
            </div>
        </>
    );
    return (
        <>
            {withBody ? (
                <>
                    {withSticky && <div ref={stickyRef} id="sticky-chrome" />}
                    <div ref={bodyRef} id="modal-body" data-rect="body">
                        {panels}
                    </div>
                </>
            ) : (
                panels
            )}
            <button
                type="button"
                onClick={() => {
                    setActive('b');
                    scrollPanelIntoView('panel-b');
                }}
            >
                select-b
            </button>
            <button type="button" onClick={() => setActive('a')}>
                reveal-a
            </button>
            <button type="button" onClick={() => setActive('b')}>
                reveal-b
            </button>
            <button type="button" onClick={() => bumpRender((n) => n + 1)}>
                bump
            </button>
            <button type="button" onClick={() => scrollPanelIntoView('panel-missing')}>
                request-missing
            </button>
        </>
    );
}

const body = () => document.getElementById('modal-body')!;

describe('useScrollPanelIntoView', () => {
    // The body's visible top is 100, the chrome to clear is 48; panel tops are
    // per test. With the body at scrollTop 200, a panel top under 148 means the
    // body is scrolled past it.
    beforeEach(() => {
        rectTops = { body: 100, panel: 60 };
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return rect(this.dataset.rect === 'body' ? rectTops.body : rectTops.panel);
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a body scrolled past the panel top is brought back so the top clears the chrome', () => {
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('select-b'));

        // target = 60 - 100 + 200 - 48 = 112
        expect(body().scrollTop).toBe(112);
        expect(document.getElementById('panel-b')!.hasAttribute('hidden')).toBe(false);
    });

    test('a panel already in view below the chrome does not move the body', () => {
        stubRects(100, 300);
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('select-b'));

        // target = 300 - 100 + 200 - 48 = 352; the body is not scrolled past it.
        expect(body().scrollTop).toBe(200);
    });

    test('re-asking for the same panel after an unrequested selection still scrolls', () => {
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;
        fireEvent.click(screen.getByText('select-b'));
        expect(body().scrollTop).toBe(112);

        // A reveal puts the user back on panel-a without a scroll; the user
        // scrolls down again and re-clicks the b tab — the same id runs again.
        fireEvent.click(screen.getByText('reveal-a'));
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('select-b'));

        expect(body().scrollTop).toBe(112);
    });

    test('a sticky-height change on its own does not move a consumed request', () => {
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;
        fireEvent.click(screen.getByText('select-b'));
        expect(body().scrollTop).toBe(112);

        // The chrome's banner toggles in (a taller sticky) and the body
        // re-renders: the consumed request is not re-run, nothing jumps.
        setStickyHeight(96);
        fireEvent.click(screen.getByText('bump'));
        expect(body().scrollTop).toBe(112);

        // The next request measures the new height.
        body().scrollTop = 200;
        fireEvent.click(screen.getByText('select-b'));

        // target = 60 - 100 + 200 - 96 = 64
        expect(body().scrollTop).toBe(64);
    });

    test('a null sticky ref measures no chrome and still scrolls', () => {
        render(<HookHarness withSticky={false} />);
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('select-b'));

        // target = 60 - 100 + 200 - 0 = 160: the unmounted chrome contributes no offset.
        expect(body().scrollTop).toBe(160);
        expect(document.getElementById('panel-b')!.hasAttribute('hidden')).toBe(false);
    });

    test('a reveal selects the tab but never scrolls the modal', () => {
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('reveal-b'));

        expect(document.getElementById('panel-b')!.hasAttribute('hidden')).toBe(false);
        expect(body().scrollTop).toBe(200);
    });

    test('a request for a panel that is not in the DOM is dropped', () => {
        render(<HookHarness />);
        setStickyHeight(48);
        body().scrollTop = 200;

        fireEvent.click(screen.getByText('request-missing'));

        expect(body().scrollTop).toBe(200);

        // The dropped request does not wedge the hook: the next real one scrolls.
        fireEvent.click(screen.getByText('select-b'));
        expect(body().scrollTop).toBe(112);
    });

    test('a request with no modal body mounted is dropped', () => {
        render(<HookHarness withBody={false} />);

        fireEvent.click(screen.getByText('select-b'));

        // The selection itself still went through; only the scroll was skipped.
        expect(screen.getByText('panel b')).toBeTruthy();
        expect(document.getElementById('panel-b')!.hasAttribute('hidden')).toBe(false);
        expect(document.getElementById('modal-body')).toBeNull();
    });
});
