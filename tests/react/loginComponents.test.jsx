/**
 * Login-page building blocks: LoginForm (validation + error clearing +
 * loading state), LanguageSwitcher, SettingsToggles and ModeInfoText. The
 * test mock's t() returns the key, so assertions match translation keys.
 */
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { LoginForm } from '@/components/login/LoginForm';
import { LanguageSwitcher } from '@/components/login/LanguageSwitcher';
import { SettingsToggles } from '@/components/login/SettingsToggles';
import { ModeInfoText } from '@/components/login/ModeInfoText';
import { mockTranslationManager } from './helpers/setup';

describe('LoginForm', () => {
    test('blocks submit and shows both required errors when empty', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} />);
        fireEvent.submit(document.querySelector('form'));
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByText('login.usernameRequired')).toBeTruthy();
        expect(screen.getByText('login.passwordRequired')).toBeTruthy();
        expect(document.getElementById('username').className).toContain('border-error');
        expect(document.getElementById('password').className).toContain('border-error');
    });

    test('typing clears the matching field error only', () => {
        render(<LoginForm onSubmit={jest.fn()} />);
        fireEvent.submit(document.querySelector('form'));
        fireEvent.input(document.getElementById('username'), { target: { value: 'u' } });
        expect(screen.queryByText('login.usernameRequired')).toBeNull();
        expect(screen.getByText('login.passwordRequired')).toBeTruthy();
        fireEvent.input(document.getElementById('password'), { target: { value: 'p' } });
        expect(screen.queryByText('login.passwordRequired')).toBeNull();
        // With no error showing, further typing leaves errors alone.
        fireEvent.input(document.getElementById('password'), { target: { value: 'pw' } });
        expect(document.getElementById('password').className).toContain('border-gray-300');
    });

    test('submits the trimmed username and raw password', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} initialUsername="  alice " />);
        expect(document.getElementById('username').value).toBe('  alice ');
        fireEvent.input(document.getElementById('password'), { target: { value: ' secret ' } });
        fireEvent.submit(document.querySelector('form'));
        expect(onSubmit).toHaveBeenCalledWith('alice', ' secret ');
    });

    test('whitespace-only fields are treated as empty', () => {
        const onSubmit = jest.fn();
        render(<LoginForm onSubmit={onSubmit} initialUsername="   " />);
        fireEvent.input(document.getElementById('password'), { target: { value: '   ' } });
        fireEvent.submit(document.querySelector('form'));
        expect(onSubmit).not.toHaveBeenCalled();
    });

    test('loading disables inputs and shows the logging-in label', () => {
        render(<LoginForm onSubmit={jest.fn()} loading />);
        expect(screen.getByText('login.loggingIn')).toBeTruthy();
        expect(screen.queryByText('login.loginButton')).toBeNull();
        expect(document.getElementById('username').disabled).toBe(true);
        expect(document.getElementById('password').disabled).toBe(true);
    });
});

describe('LanguageSwitcher', () => {
    test('shows English, switches to Latvian and refreshes the menu', async () => {
        render(<LanguageSwitcher />);
        expect(screen.getByText('English')).toBeTruthy();
        expect(screen.getByText('common.languageEnglish').className).toBe('active');
        expect(screen.getByText('common.languageLatvian').className).toBe('');
        // Real buttons, with the current language exposed as pressed.
        expect(screen.getByRole('button', { name: 'common.languageEnglish' }).getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(screen.getByRole('button', { name: 'common.languageLatvian' }).getAttribute('aria-pressed')).toBe(
            'false',
        );

        fireEvent.click(screen.getByText('common.languageLatvian'));
        await waitFor(() => expect(screen.getByText('Latviešu')).toBeTruthy());
        expect(mockTranslationManager.setLanguage).toHaveBeenCalledWith('lv');
        expect(window.api.refreshMenu).toHaveBeenCalledTimes(1);
        expect(screen.getByText('common.languageLatvian').className).toBe('active');

        fireEvent.click(screen.getByText('common.languageEnglish'));
        await waitFor(() => expect(screen.getByText('English')).toBeTruthy());
        expect(mockTranslationManager.setLanguage).toHaveBeenLastCalledWith('en');
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
        const [theme, stay, mock] = document.querySelectorAll('input[type="checkbox"]');
        return { handlers, theme, stay, mock };
    };

    test('reflects props as checked state', () => {
        const { theme, stay, mock } = renderToggles({ theme: 'dark', stayLoggedIn: true, mockMode: true });
        expect([theme.checked, stay.checked, mock.checked]).toEqual([true, true, true]);
    });

    test('toggling maps to dark/light and forwards booleans', () => {
        const { handlers, theme, stay, mock } = renderToggles();
        fireEvent.click(theme);
        expect(handlers.onThemeChange).toHaveBeenLastCalledWith('dark');
        fireEvent.click(stay);
        expect(handlers.onStayLoggedInChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(mock);
        expect(handlers.onMockModeChange).toHaveBeenLastCalledWith(true);
    });

    test('each toggle is named by its caption, under a translated heading', () => {
        const { theme, stay, mock } = renderToggles();
        expect(screen.getByLabelText('common.theme')).toBe(theme);
        expect(screen.getByLabelText('login.stayLoggedIn')).toBe(stay);
        expect(screen.getByLabelText('login.mockMode')).toBe(mock);
        expect(screen.getByText('app.settings')).toBeTruthy();
    });

    test('unchecking the theme toggle selects light', () => {
        const { handlers, theme } = renderToggles({ theme: 'dark' });
        fireEvent.click(theme);
        expect(handlers.onThemeChange).toHaveBeenLastCalledWith('light');
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
