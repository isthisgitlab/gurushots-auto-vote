import { render, act } from '@testing-library/preact';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { mockTranslationManager } from './helpers/setup';

describe('TranslationContext', () => {
    let ctx;
    let savedTm;

    function Capture() {
        ctx = useTranslation();
        return <span>{ctx.ready ? 'ready' : 'waiting'}</span>;
    }

    const renderProvider = () =>
        render(
            <TranslationProvider>
                <Capture />
            </TranslationProvider>,
        );

    beforeEach(() => {
        jest.useFakeTimers();
        savedTm = window.translationManager;
        mockTranslationManager.initialized = true;
        mockTranslationManager.getCurrentLanguage.mockReturnValue('lv');
        mockTranslationManager.t.mockImplementation((key) => `T:${key}`);
    });

    afterEach(() => {
        window.translationManager = savedTm;
        mockTranslationManager.initialized = true;
        mockTranslationManager.t.mockImplementation((key) => key);
        mockTranslationManager.getCurrentLanguage.mockReturnValue('en');
        jest.useRealTimers();
    });

    it('throws when used outside a provider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => render(<Capture />)).toThrow('useTranslation must be used within a TranslationProvider');
        spy.mockRestore();
    });

    it('waits for the manager to initialize, then adopts its language', () => {
        mockTranslationManager.initialized = false;
        const { getByText } = renderProvider();
        act(() => jest.advanceTimersByTime(100));
        expect(getByText('waiting')).toBeTruthy();
        expect(ctx.language).toBe('en');

        mockTranslationManager.initialized = true;
        act(() => jest.advanceTimersByTime(50));
        expect(getByText('ready')).toBeTruthy();
        expect(ctx.language).toBe('lv');
        expect(ctx.getCurrentLanguage()).toBe('lv');
        expect(ctx.t('app.title')).toBe('T:app.title');
    });

    it('keeps polling while no manager exists and falls back to the raw key', () => {
        delete window.translationManager;
        const { getByText } = renderProvider();
        act(() => jest.advanceTimersByTime(200));
        expect(getByText('waiting')).toBeTruthy();
        expect(ctx.t('app.title')).toBe('app.title');
    });

    it('setLanguage delegates to the manager and updates the language', async () => {
        renderProvider();
        await act(async () => {
            await ctx.setLanguage('en');
        });
        expect(mockTranslationManager.setLanguage).toHaveBeenCalledWith('en');
        expect(ctx.language).toBe('en');
    });

    it('setLanguage is a no-op without a manager', async () => {
        delete window.translationManager;
        renderProvider();
        await act(async () => {
            await ctx.setLanguage('lv');
        });
        expect(mockTranslationManager.setLanguage).not.toHaveBeenCalled();
        expect(ctx.language).toBe('en');
    });

    it('stops polling on unmount', () => {
        mockTranslationManager.initialized = false;
        const { unmount } = renderProvider();
        unmount();
        expect(jest.getTimerCount()).toBe(0);
    });
});
