import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ToneNote } from '@/components/ui/ToneNote';
import type { TargetedEvent, TargetedSubmitEvent } from 'preact';

/**
 * Login form component with validation
 *
 * @param props - `onSubmit` receives the trimmed username once both fields validate.
 */
export function LoginForm({
    onSubmit,
    loading = false,
    initialUsername = '',
}: {
    onSubmit: (username: string, password: string) => void | Promise<void>;
    loading?: boolean;
    initialUsername?: string;
}) {
    const { t } = useTranslation();
    const [username, setUsername] = useState(initialUsername);
    // A saved name that arrives after the form is up fills the field, unless something was typed by then.
    useEffect(() => {
        setUsername((typed) => typed || initialUsername);
    }, [initialUsername]);
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState<{ username?: string | null; password?: string | null }>({});
    const usernameRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    /**
     * Validate form fields
     * @returns The error text of each invalid field (empty when the form is valid)
     */
    const validateForm = useCallback(() => {
        const newErrors: { username?: string; password?: string } = {};

        if (!username.trim()) {
            newErrors.username = t('login.usernameRequired');
        }

        if (!password.trim()) {
            newErrors.password = t('login.passwordRequired');
        }

        setErrors(newErrors);
        return newErrors;
    }, [username, password, t]);

    /**
     * Handle form submission
     */
    const handleSubmit = useCallback(
        (e: TargetedSubmitEvent<HTMLFormElement>) => {
            e.preventDefault();

            const found = validateForm();
            // Focus follows the first invalid field, so the keyboard and a screen reader land on what to fix.
            if (found.username) usernameRef.current?.focus();
            else if (found.password) passwordRef.current?.focus();
            else void onSubmit(username.trim(), password);
        },
        [username, password, validateForm, onSubmit],
    );

    /**
     * Clear field error on change
     */
    const handleUsernameChange = useCallback(
        (e: TargetedEvent<HTMLInputElement, Event>) => {
            setUsername(e.currentTarget.value);
            if (errors.username) {
                setErrors((prev) => ({ ...prev, username: null }));
            }
        },
        [errors.username],
    );

    const handlePasswordChange = useCallback(
        (e: TargetedEvent<HTMLInputElement, Event>) => {
            setPassword(e.currentTarget.value);
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
                    ref={usernameRef}
                    id="username"
                    type="text"
                    className={`input w-full ${errors.username ? 'input-error' : ''}`}
                    placeholder={t('login.usernamePlaceholder')}
                    value={username}
                    onChange={handleUsernameChange}
                    disabled={loading}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellcheck={false}
                    aria-invalid={errors.username ? true : undefined}
                    aria-describedby={errors.username ? 'username-error' : undefined}
                />
                {errors.username && (
                    <ToneNote tone="error" as="div" id="username-error" className="font-medium mt-1">
                        {errors.username}
                    </ToneNote>
                )}
            </div>

            {/* Password field */}
            <div className="flex flex-col w-full">
                <label className="label" htmlFor="password">
                    <span>{t('login.password')}</span>
                </label>
                <input
                    ref={passwordRef}
                    id="password"
                    type="password"
                    className={`input w-full ${errors.password ? 'input-error' : ''}`}
                    placeholder={t('login.passwordPlaceholder')}
                    value={password}
                    onChange={handlePasswordChange}
                    disabled={loading}
                    autoComplete="current-password"
                    aria-invalid={errors.password ? true : undefined}
                    aria-describedby={errors.password ? 'password-error' : undefined}
                />
                {errors.password && (
                    <ToneNote tone="error" as="div" id="password-error" className="font-medium mt-1">
                        {errors.password}
                    </ToneNote>
                )}
            </div>

            {/* Submit button */}
            <div className="flex flex-col w-full mt-6">
                <button type="submit" className="btn btn-neutral w-full" disabled={loading}>
                    {loading ? (
                        <>
                            <span>{t('login.loggingIn')}</span>
                            <LoadingSpinner size="sm" className="ml-2" decorative />
                        </>
                    ) : (
                        <span>{t('login.loginButton')}</span>
                    )}
                </button>
            </div>
        </form>
    );
}
