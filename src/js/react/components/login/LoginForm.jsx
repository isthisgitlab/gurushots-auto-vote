import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Login form component with validation
 */
export function LoginForm({
    onSubmit,
    loading = false,
    initialUsername = '',
}) {
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
    const handleSubmit = useCallback((e) => {
        e.preventDefault();

        if (validateForm()) {
            onSubmit(username.trim(), password);
        }
    }, [username, password, validateForm, onSubmit]);

    /**
     * Clear field error on change
     */
    const handleUsernameChange = useCallback((e) => {
        setUsername(e.target.value);
        if (errors.username) {
            setErrors(prev => ({ ...prev, username: null }));
        }
    }, [errors.username]);

    const handlePasswordChange = useCallback((e) => {
        setPassword(e.target.value);
        if (errors.password) {
            setErrors(prev => ({ ...prev, password: null }));
        }
    }, [errors.password]);

    return (
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {/* Username field */}
            <div className="form-control w-full">
                <label className="label" htmlFor="username">
                    <span className="label-text">{t('login.username')}</span>
                </label>
                <input
                    id="username"
                    type="text"
                    className={`input w-full border ${errors.username ? 'border-error' : 'border-gray-300'} focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all duration-200`}
                    placeholder={t('login.usernamePlaceholder')}
                    value={username}
                    onChange={handleUsernameChange}
                    disabled={loading}
                    autoComplete="username"
                />
                {errors.username && (
                    <div className="label-text-alt text-latvian font-medium mt-1">
                        {errors.username}
                    </div>
                )}
            </div>

            {/* Password field */}
            <div className="form-control w-full">
                <label className="label" htmlFor="password">
                    <span className="label-text">{t('login.password')}</span>
                </label>
                <input
                    id="password"
                    type="password"
                    className={`input w-full border ${errors.password ? 'border-error' : 'border-gray-300'} focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all duration-200`}
                    placeholder={t('login.passwordPlaceholder')}
                    value={password}
                    onChange={handlePasswordChange}
                    disabled={loading}
                    autoComplete="current-password"
                />
                {errors.password && (
                    <div className="label-text-alt text-latvian font-medium mt-1">
                        {errors.password}
                    </div>
                )}
            </div>

            {/* Submit button */}
            <div className="form-control w-full mt-6">
                <button
                    type="submit"
                    className="btn bg-latvian text-white w-full"
                    disabled={loading}
                >
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
