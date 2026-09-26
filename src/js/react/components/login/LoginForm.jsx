// @ts-check
import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Login form component with validation
 *
 * @param {{
 *   onSubmit: (username: string, password: string) => void | Promise<void>,
 *   loading?: boolean,
 *   initialUsername?: string,
 * }} props - `onSubmit` receives the trimmed username once both fields validate.
 */
export function LoginForm({ onSubmit, loading = false, initialUsername = '' }) {
    const { t } = useTranslation();
    const [username, setUsername] = useState(initialUsername);
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState(/** @type {{ username?: string | null, password?: string | null }} */ ({}));

    /**
     * Validate form fields
     * @returns {boolean} - Whether form is valid
     */
    const validateForm = useCallback(() => {
        /** @type {{ username?: string, password?: string }} */
        const newErrors = {};

        if (!username.trim()) {
            newErrors.username = t('login.usernameRequired');
        }

        if (!password.trim()) {
            newErrors.password = t('login.passwordRequired');
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    }, [username, password, t]);

    /**
     * Handle form submission
     */
    const handleSubmit = useCallback(
        /** @param {import('preact').JSX.TargetedSubmitEvent<HTMLFormElement>} e */
        (e) => {
            e.preventDefault();

            if (validateForm()) {
                void onSubmit(username.trim(), password);
            }
        },
        [username, password, validateForm, onSubmit],
    );

    /**
     * Clear field error on change
     */
    const handleUsernameChange = useCallback(
        /** @param {import('preact').JSX.TargetedEvent<HTMLInputElement, Event>} e */
        (e) => {
            setUsername(/** @type {HTMLInputElement} */ (e.target).value);
            if (errors.username) {
                setErrors((prev) => ({ ...prev, username: null }));
            }
        },
        [errors.username],
    );

    const handlePasswordChange = useCallback(
        /** @param {import('preact').JSX.TargetedEvent<HTMLInputElement, Event>} e */
        (e) => {
            setPassword(/** @type {HTMLInputElement} */ (e.target).value);
            if (errors.password) {
                setErrors((prev) => ({ ...prev, password: null }));
            }
        },
        [errors.password],
    );

    return (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {/* Username field */}
            <div className="flex flex-col w-full">
                <label className="label" htmlFor="username">
                    <span>{t('login.username')}</span>
                </label>
                <input
                    id="username"
                    type="text"
                    className={`input input-sm w-full ${errors.username ? 'input-error' : ''}`}
                    placeholder={t('login.usernamePlaceholder')}
                    value={username}
                    onChange={handleUsernameChange}
                    disabled={loading}
                    autoComplete="username"
                />
                {errors.username && <div className="text-error font-medium mt-1">{errors.username}</div>}
            </div>

            {/* Password field */}
            <div className="flex flex-col w-full">
                <label className="label" htmlFor="password">
                    <span>{t('login.password')}</span>
                </label>
                <input
                    id="password"
                    type="password"
                    className={`input input-sm w-full ${errors.password ? 'input-error' : ''}`}
                    placeholder={t('login.passwordPlaceholder')}
                    value={password}
                    onChange={handlePasswordChange}
                    disabled={loading}
                    autoComplete="current-password"
                />
                {errors.password && <div className="text-error font-medium mt-1">{errors.password}</div>}
            </div>

            {/* Submit button */}
            <div className="flex flex-col w-full mt-6">
                <button type="submit" className="btn btn-latvian btn-sm w-full" disabled={loading}>
                    {loading ? (
                        <>
                            <span>{t('login.loggingIn')}</span>
                            <LoadingSpinner size="sm" className="ml-2" />
                        </>
                    ) : (
                        <span>{t('login.loginButton')}</span>
                    )}
                </button>
            </div>
        </form>
    );
}
