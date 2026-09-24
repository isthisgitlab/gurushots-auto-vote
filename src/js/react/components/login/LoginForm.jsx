import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Login form component with validation
 */
export function LoginForm({ onSubmit, loading = false, initialUsername = '' }) {
    const { t } = useTranslation();
    const [username, setUsername] = useState(initialUsername);
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState({});

    /**
     * Validate form fields
     * @returns {boolean} - Whether form is valid
     */
    const validateForm = useCallback(() => {
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
        (e) => {
            e.preventDefault();

            if (validateForm()) {
                onSubmit(username.trim(), password);
            }
        },
        [username, password, validateForm, onSubmit],
    );

    /**
     * Clear field error on change
     */
    const handleUsernameChange = useCallback(
        (e) => {
            setUsername(e.target.value);
            if (errors.username) {
                setErrors((prev) => ({ ...prev, username: null }));
            }
        },
        [errors.username],
    );

    const handlePasswordChange = useCallback(
        (e) => {
            setPassword(e.target.value);
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
                    className={`input w-full ${errors.username ? 'input-error' : ''}`}
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
                    className={`input w-full ${errors.password ? 'input-error' : ''}`}
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
                <button type="submit" className="btn btn-latvian w-full" disabled={loading}>
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
