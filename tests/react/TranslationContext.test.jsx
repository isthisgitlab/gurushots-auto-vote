/**
 * TranslationProvider — the renderer's translation adapter: reads the saved
 * language over window.api, hands it to the page translator, persists
 * changes, and exposes `t` bound to the current language.
 */
import { memo } from 'react';
import { render, act, waitFor } from '@testing-library/preact';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { mockApi, mockTranslator } from './helpers/setup';

describe('TranslationContext', () => {
    let ctx;

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

    const deferred = () => {
        let resolve;
        const promise = new Promise((res) => {
            resolve = res;
        });
        return { promise, resolve };
    };

    beforeEach(() => {
        window.api = mockApi;
        mockApi.getSetting.mockResolvedValue('lv');
        mockApi.setSetting.mockResolvedValue(true);
        mockTranslator.t.mockImplementation((key) => `T:${key}`);
    });

    afterEach(() => {
        mockApi.getSetting.mockResolvedValue(null);
        mockApi.setSetting.mockResolvedValue(undefined);
        mockTranslator.t.mockImplementation((key) => key);
    });

    it('throws when used outside a provider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => render(<Capture />)).toThrow('useTranslation must be used within a TranslationProvider');
        spy.mockRestore();
    });

    it('waits for the saved language, then adopts it on the page translator', async () => {
        const saved = deferred();
        mockApi.getSetting.mockReturnValue(saved.promise);
        const { getByText, findByText } = renderProvider();
        expect(mockApi.getSetting).toHaveBeenCalledWith('language');
        expect(getByText('waiting')).toBeTruthy();
        expect(ctx.language).toBe('en');

        saved.resolve('lv');

        expect(await findByText('ready')).toBeTruthy();
        expect(mockTranslator.setCurrentLanguage).toHaveBeenCalledWith('lv');
        expect(ctx.language).toBe('lv');
        expect(ctx.getCurrentLanguage()).toBe('lv');
        expect(ctx.t('app.title')).toBe('T:app.title');
        expect(mockTranslator.t).toHaveBeenCalledWith('app.title', 'lv');
    });

    it('an unset or unknown saved language resolves to English', async () => {
        mockApi.getSetting.mockResolvedValue('de');
        const { findByText } = renderProvider();
        await findByText('ready');
        expect(ctx.language).toBe('en');
        expect(mockTranslator.setCurrentLanguage).toHaveBeenCalledWith('en');
    });

    it('a failed read still turns ready, in English', async () => {
        mockApi.getSetting.mockRejectedValue(new Error('ipc down'));
        const { findByText } = renderProvider();
        await findByText('ready');
        expect(ctx.language).toBe('en');
        expect(mockTranslator.setCurrentLanguage).not.toHaveBeenCalled();
    });

    it('setLanguage persists the language, then switches the provider and the page translator', async () => {
        const { findByText } = renderProvider();
        await findByText('ready');
        const staleT = ctx.t;

        await act(async () => {
            await ctx.setLanguage('en');
        });

        expect(mockApi.setSetting).toHaveBeenCalledWith('language', 'en');
        expect(mockTranslator.setCurrentLanguage).toHaveBeenLastCalledWith('en');
        expect(ctx.language).toBe('en');
        expect(ctx.t).not.toBe(staleT);
    });

    it('a saved language refreshes the main-process menu and resolves true', async () => {
        const { findByText } = renderProvider();
        await findByText('ready');
        mockApi.refreshMenu.mockClear();

        let saved;
        await act(async () => {
            saved = await ctx.setLanguage('en');
        });

        expect(saved).toBe(true);
        expect(mockApi.refreshMenu).toHaveBeenCalledTimes(1);
    });

    it('a failed save resolves false and leaves the menu alone', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        const { findByText } = renderProvider();
        await findByText('ready');
        mockApi.refreshMenu.mockClear();

        let saved;
        await act(async () => {
            saved = await ctx.setLanguage('en');
        });

        expect(saved).toBe(false);
        expect(mockApi.refreshMenu).not.toHaveBeenCalled();
    });

    it('a menu refresh that rejects (or is missing) does not fail the save', async () => {
        const { findByText } = renderProvider();
        await findByText('ready');
        const savedRefresh = mockApi.refreshMenu;
        try {
            mockApi.refreshMenu = jest.fn().mockRejectedValue(new Error('no window'));
            await act(async () => {
                await expect(ctx.setLanguage('en')).resolves.toBe(true);
            });
            delete mockApi.refreshMenu;
            await act(async () => {
                await expect(ctx.setLanguage('lv')).resolves.toBe(true);
            });
        } finally {
            mockApi.refreshMenu = savedRefresh;
        }
    });

    it('setLanguage ignores an unsupported language', async () => {
        const { findByText } = renderProvider();
        await findByText('ready');
        let saved;
        await act(async () => {
            saved = await ctx.setLanguage('de');
        });
        expect(saved).toBe(false);
        expect(mockApi.setSetting).not.toHaveBeenCalled();
        expect(ctx.language).toBe('lv');
    });

    it('a failed save is logged and keeps the current language', async () => {
        mockApi.setSetting.mockRejectedValue(new Error('disk full'));
        const { findByText } = renderProvider();
        await findByText('ready');
        mockTranslator.setCurrentLanguage.mockClear();

        await act(async () => {
            await ctx.setLanguage('en');
        });

        expect(mockApi.logError).toHaveBeenCalledWith('Could not save language to settings: disk full');
        expect(mockTranslator.setCurrentLanguage).not.toHaveBeenCalled();
        expect(ctx.language).toBe('lv');
    });

    it('a save the settings store rejects (false) is logged and keeps the current language', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        const { findByText } = renderProvider();
        await findByText('ready');
        mockTranslator.setCurrentLanguage.mockClear();

        await act(async () => {
            await ctx.setLanguage('en');
        });

        expect(mockApi.logError).toHaveBeenCalledWith(
            'Could not save language to settings: the settings store rejected the write',
        );
        expect(mockTranslator.setCurrentLanguage).not.toHaveBeenCalled();
        expect(ctx.language).toBe('lv');
    });

    it('a save rejected with null is logged without throwing', async () => {
        mockApi.setSetting.mockRejectedValue(null);
        const { findByText } = renderProvider();
        await findByText('ready');

        await act(async () => {
            await expect(ctx.setLanguage('en')).resolves.toBe(false);
        });

        expect(mockApi.logError).toHaveBeenCalledWith('Could not save language to settings: null');
        expect(ctx.language).toBe('lv');
    });

    it('a failed save without (or with a rejecting) logError stays silent', async () => {
        mockApi.setSetting.mockRejectedValue(new Error('disk full'));
        const { findByText } = renderProvider();
        await findByText('ready');
        const savedLogError = mockApi.logError;
        try {
            mockApi.logError = jest.fn().mockRejectedValue(new Error('log down'));
            await act(async () => {
                await expect(ctx.setLanguage('en')).resolves.toBe(false);
            });
            delete mockApi.logError;
            await act(async () => {
                await expect(ctx.setLanguage('en')).resolves.toBe(false);
            });
        } finally {
            mockApi.logError = savedLogError;
        }
        expect(ctx.language).toBe('lv');
    });

    it('keeps the context value stable across an unrelated provider re-render', async () => {
        let renders = 0;
        const Consumer = memo(function Consumer() {
            renders++;
            ctx = useTranslation();
            return null;
        });
        const tree = () => (
            <TranslationProvider>
                <Consumer />
            </TranslationProvider>
        );
        const { rerender } = render(tree());
        await waitFor(() => expect(ctx.ready).toBe(true));
        const first = ctx;
        const rendersBefore = renders;

        rerender(tree());

        expect(renders).toBe(rendersBefore);
        expect(ctx).toBe(first);
    });
});
