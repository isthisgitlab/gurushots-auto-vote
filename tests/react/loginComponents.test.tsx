/**
 * Login-page building blocks: LoginForm (validation + error clearing +
 * loading state), LanguageSwitcher, SettingsToggles and ModeInfoText. The
 * test mock's t() returns the key, so assertions match translation keys.
 */
import { fireEvent, pickOption, render, screen, waitFor } from './helpers/test-utils';
import { LoginForm } from '@/components/login/LoginForm';
import { LanguageSwitcher } from '@/components/login/LanguageSwitcher';
import { SettingsToggles } from '@/components/login/SettingsToggles';
import { ModeInfoText } from '@/components/login/ModeInfoText';
import { THEMES } from '../../src/ts/settings/uiDefaults';

describe('LoginForm', () => {
    test('blocks submit and shows both required errors when empty', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} />);
        fireEvent.submit(document.querySelector('form')!);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByText('login.usernameRequired')).toBeTruthy();
        expect(screen.getByText('login.passwordRequired')).toBeTruthy();
        expect(document.getElementById('username')!.className).toContain('input-error');
        expect(document.getElementById('password')!.className).toContain('input-error');
    });

    test('typing clears the matching field error only', () => {
        render(<LoginForm onSubmit={jest.fn()} />);
        fireEvent.submit(document.querySelector('form')!);
        fireEvent.input(document.getElementById('username')!, { target: { value: 'u' } });
        expect(screen.queryByText('login.usernameRequired')).toBeNull();
        expect(screen.getByText('login.passwordRequired')).toBeTruthy();
        fireEvent.input(document.getElementById('password')!, { target: { value: 'p' } });
        expect(screen.queryByText('login.passwordRequired')).toBeNull();
        // With no error showing, further typing leaves errors alone.
        fireEvent.input(document.getElementById('password')!, { target: { value: 'pw' } });
        expect(document.getElementById('password')!.className).not.toContain('input-error');
    });

    test('submits the trimmed username and raw password', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} initialUsername="  alice " />);
        expect((document.getElementById('username') as HTMLInputElement).value).toBe('  alice ');
        fireEvent.input(document.getElementById('password')!, { target: { value: ' secret ' } });
        fireEvent.submit(document.querySelector('form')!);
        expect(onSubmit).toHaveBeenCalledWith('alice', ' secret ');
    });

    test('whitespace-only fields are treated as empty', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} initialUsername="   " />);
        fireEvent.input(document.getElementById('password')!, { target: { value: '   ' } });
        fireEvent.submit(document.querySelector('form')!);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    test('loading disables inputs and shows the logging-in label', () => {
        render(<LoginForm onSubmit={jest.fn()} loading />);
        expect(screen.getByText('login.loggingIn')).toBeTruthy();
        expect(screen.queryByText('login.loginButton')).toBeNull();
        expect((document.getElementById('username') as HTMLInputElement).disabled).toBe(true);
        expect((document.getElementById('password') as HTMLInputElement).disabled).toBe(true);
    });
});

describe('LanguageSwitcher', () => {
    test('shows English, switches to Latvian and refreshes the menu', async () => {
        render(<LanguageSwitcher />);
        // The trigger names the current language in itself, marked with its own lang; the items do the same.
        const triggerName = () => document.querySelector('button[aria-expanded] span[lang]')!;
        expect(triggerName().textContent).toBe('common.languageEnglish');
        expect(triggerName().getAttribute('lang')).toBe('en');
        expect(screen.getByRole('button', { name: 'common.languageEnglish', pressed: true }).className).toBe('active');
        // The trigger is a disclosure button, not a menu.
        expect(document.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByRole('button', { name: 'common.languageLatvian' }).className).toBe('');
        expect(screen.getByRole('button', { name: 'common.languageLatvian' }).getAttribute('lang')).toBe('lv');
        // Real buttons, with the current language exposed as pressed.
        expect(screen.getByRole('button', { name: 'common.languageLatvian', pressed: false })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'common.languageLatvian' }));
        await waitFor(() => expect(triggerName().getAttribute('lang')).toBe('lv'));
        expect(window.api.setSetting).toHaveBeenCalledWith('language', 'lv');
        expect(window.api.refreshMenu).toHaveBeenCalledTimes(1);
        expect(screen.getAllByRole('button', { name: 'common.languageLatvian' }).at(-1)!.className).toBe('active');
        expect(document.documentElement.lang).toBe('lv');

        fireEvent.click(screen.getByRole('button', { name: 'common.languageEnglish', pressed: false }));
        await waitFor(() => expect(triggerName().getAttribute('lang')).toBe('en'));
        expect(window.api.setSetting).toHaveBeenLastCalledWith('language', 'en');
    });
});

describe('SettingsToggles', () => {
    const renderToggles = (props = {}) => {
        const handlers = {
            onThemeChange: jest.fn(),
            onStayLoggedInChange: jest.fn(),
            onMockModeChange: jest.fn(),
        };
        render(<SettingsToggles theme="light" stayLoggedIn={false} mockMode={false} {...handlers} {...props} />);
        const theme = document.getElementById('login-theme') as HTMLSelectElement;
        const [stay, mock] = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        return { handlers, theme, stay, mock };
    };

    test('reflects props as the selected theme and checked state', () => {
        const { theme, stay, mock } = renderToggles({ theme: 'nord', stayLoggedIn: true, mockMode: true });
        expect([theme.value, stay.checked, mock.checked]).toEqual(['nord', true, true]);
    });

    test('picking a theme forwards its name; toggles forward booleans', () => {
        const { handlers, theme, stay, mock } = renderToggles();
        pickOption(theme, 'dark');
        expect(handlers.onThemeChange).toHaveBeenLastCalledWith('dark');
        fireEvent.click(stay);
        expect(handlers.onStayLoggedInChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(mock);
        expect(handlers.onMockModeChange).toHaveBeenLastCalledWith(true);
    });

    test('each control is named by its caption, under a translated heading', () => {
        const { theme, stay, mock } = renderToggles();
        expect(screen.getByLabelText('common.theme')).toBe(theme);
        expect(screen.getByLabelText('login.stayLoggedIn')).toBe(stay);
        expect(screen.getByLabelText('login.mockMode')).toBe(mock);
        expect(screen.getByText('app.settings')).toBeTruthy();
    });

    test('the theme picker offers every theme, translated', () => {
        const { theme } = renderToggles();
        expect([...theme.options].map((o) => [o.value, o.textContent])).toEqual(
            THEMES.map((name) => [name, `themes.${name}`]),
        );
    });
});

describe('ModeInfoText', () => {
    test('mock vs live text', () => {
        const { rerender } = render(<ModeInfoText isMock />);
        expect(screen.getByText('login.mockModeInfo')).toBeTruthy();
        rerender(<ModeInfoText isMock={false} />);
        expect(screen.getByText('login.loadingModeInfo')).toBeTruthy();
    });
});
