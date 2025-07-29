// Get translation manager from global scope
const translationManager = window.translationManager;

// Function for production login using real GuruShots API
const loginProd = async (username, password) => {
    console.log('Production login with:', username, password);

    try {
        // Use the IPC call to authenticate through the main process
        const result = await window.api.authenticate(username, password, false);
        return result;

    } catch (error) {
        console.error('Production login error:', error);
        return {
            success: false,
            message: error.message || 'Authentication failed due to network error',
        };
    }
};

// Function for mock login using mock authentication data
const loginMock = async (username, password) => {
    console.log('Mock login with:', username, password);

    try {
        // Use the IPC call to authenticate through the main process with mock flag
        const result = await window.api.authenticate(username, password, true);
        return result;

    } catch (error) {
        console.error('Mock login error:', error);
        return {
            success: false,
            message: error.message || 'Mock authentication failed',
        };
    }
};


const showToast = (message, type = 'info') => {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');

    // Set toast classes based on type
    let alertClass = 'alert';
    switch (type) {
    case 'success':
        alertClass += ' alert-success';
        break;
    case 'error':
        alertClass += ' alert-error';
        break;
    case 'warning':
        alertClass += ' alert-warning';
        break;
    default:
        alertClass += ' alert-info';
    }

    toast.className = alertClass;
    toast.innerHTML = `
        <span>${message}</span>
        <button class="btn btn-sm btn-ghost" onclick="this.parentElement.remove()">✕</button>
    `;

    toastContainer.appendChild(toast);

    // Auto-remove toast after 5 seconds
    setTimeout(() => {
        if (toast.parentElement) {
            toast.remove();
        }
    }, 5000);
};


const validateForm = () => {
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const usernameError = document.getElementById('username-error');
    const passwordError = document.getElementById('password-error');

    let isValid = true;

    // Clear previous errors
    usernameError.classList.add('hidden');
    passwordError.classList.add('hidden');

    // Reset input styling
    username.className = 'input w-full border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all duration-200';
    password.className = 'input w-full border border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all duration-200';

    // Validate username
    if (username.value.trim() === '') {
        usernameError.textContent = translationManager.t('login.usernameRequired');
        usernameError.classList.remove('hidden');
        username.className = 'input w-full border border-latvian focus:border-latvian focus:outline-none focus:ring-1 focus:ring-red-300 transition-all duration-200';
        isValid = false;
    }

    // Validate password
    if (password.value.trim() === '') {
        passwordError.textContent = translationManager.t('login.passwordRequired');
        passwordError.classList.remove('hidden');
        password.className = 'input w-full border border-latvian focus:border-latvian focus:outline-none focus:ring-1 focus:ring-red-300 transition-all duration-200';
        isValid = false;
    }

    return isValid;
};

// Loading state management
const setLoadingState = (isLoading) => {
    const loginBtn = document.getElementById('loginBtn');
    const loginBtnText = document.getElementById('loginBtnText');
    const loginBtnSpinner = document.getElementById('loginBtnSpinner');

    if (isLoading) {
        loginBtn.disabled = true;
        loginBtnText.textContent = translationManager.t('login.loggingIn');
        loginBtnSpinner.classList.remove('hidden');
    } else {
        loginBtn.disabled = false;
        loginBtnText.textContent = translationManager.t('login.loginButton');
        loginBtnSpinner.classList.add('hidden');
    }
};

// Update bottom text based on mock setting
const updateBottomText = (isMock) => {
    const bottomText = document.querySelector('.text-center.text-sm.mt-4.text-gray-500');
    if (bottomText) {
        if (isMock) {
            bottomText.textContent = translationManager.t('login.mockModeInfo');
        } else {
            bottomText.textContent = translationManager.t('login.productionModeInfo');
        }
    }
};

// Function to update all translations on the page
const updateTranslations = () => {
    // Update elements with data-translate attribute (except the bottom text which is dynamic)
    document.querySelectorAll('[data-translate]').forEach(element => {
        const key = element.getAttribute('data-translate');
        // Skip the bottom text element as it's updated dynamically
        if (key !== 'login.loadingModeInfo') {
            element.textContent = translationManager.t(key);
        }
    });

    // Update elements with data-translate-placeholder attribute
    document.querySelectorAll('[data-translate-placeholder]').forEach(element => {
        const key = element.getAttribute('data-translate-placeholder');
        element.placeholder = translationManager.t(key);
    });

    // Update elements with data-translate-title attribute
    document.querySelectorAll('[data-translate-title]').forEach(element => {
        const key = element.getAttribute('data-translate-title');
        element.title = translationManager.t(key);
    });

    // Update page title
    document.title = translationManager.t('login.title');
};

// Wait for the DOM to be fully loaded
document.addEventListener('DOMContentLoaded', async () => {
    // Get the login form element
    const loginForm = document.getElementById('loginForm');
    const usernameInput = document.getElementById('username');

    // Get settings elements
    const themeToggle = document.getElementById('themeToggle');
    const stayLoggedIn = document.getElementById('stayLoggedIn');
    const mockToggle = document.getElementById('mockToggle');
    const currentLanguageSpan = document.getElementById('current-language');

    // Load settings and environment info
    const settings = await window.api.getSettings();
    const envInfo = await window.api.getEnvironmentInfo();

    // Apply settings to form elements
    themeToggle.checked = settings.theme === 'dark';
    stayLoggedIn.checked = settings.stayLoggedIn;

    // Mock setting is ALWAYS environment-dependent, not user preference
    mockToggle.checked = envInfo.defaultMock;

    // Add environment indicator to mock toggle label
    const mockToggleLabel = mockToggle.parentElement.parentElement.querySelector('.label-text');
    if (mockToggleLabel) {
        const envText = envInfo.defaultMock ? ' (Dev)' : ' (Prod)';
        mockToggleLabel.textContent = translationManager.t('login.mockMode') + envText;
    }

    // Apply theme
    document.documentElement.setAttribute('data-theme', settings.theme);

    // If stay logged in is enabled, pre-fill the username field
    if (settings.stayLoggedIn && settings.lastUsername) {
        usernameInput.value = settings.lastUsername;
    }

    // Wait for translation manager to be initialized
    while (!translationManager.initialized) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Set language selector to current language
    const currentLang = translationManager.getCurrentLanguage();
    currentLanguageSpan.textContent = translationManager.t(`common.language${currentLang === 'en' ? 'English' : 'Latvian'}`);

    // Apply initial translations
    updateTranslations();

    // Set initial bottom text based on environment default (after translations are applied)
    updateBottomText(envInfo.defaultMock);

    // Handle theme change
    themeToggle.addEventListener('change', async () => {
        const theme = themeToggle.checked ? 'dark' : 'light';
        await window.api.setSetting('theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
    });

    // Handle stay logged in change
    stayLoggedIn.addEventListener('change', async () => {
        await window.api.setSetting('stayLoggedIn', stayLoggedIn.checked);
        // If stay logged in is disabled, clear the lastUsername
        if (!stayLoggedIn.checked) {
            await window.api.setSetting('lastUsername', '');
        }
    });

    // Handle mock toggle change
    mockToggle.addEventListener('change', async () => {
        // Update the bottom text based on mock setting
        updateBottomText(mockToggle.checked);

        console.log(`🔄 Login mock toggle changed to: ${mockToggle.checked}`);
    });

    // Handle language change
    document.querySelectorAll('[data-lang]').forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            const newLanguage = e.target.getAttribute('data-lang');
            await translationManager.setLanguage(newLanguage);

            // Update the current language display
            currentLanguageSpan.textContent = translationManager.t(`common.language${newLanguage === 'en' ? 'English' : 'Latvian'}`);

            updateTranslations();
            updateBottomText(mockToggle.checked); // Update bottom text with new language
        });
    });

    // Add submit event listener to the form
    loginForm.addEventListener('submit', async (event) => {
        // Prevent the default form submission
        event.preventDefault();

        // Validate form
        if (!validateForm()) {
            return;
        }

        // Set loading state
        setLoadingState(true);

        try {
            // Get the username and password values
            const username = usernameInput.value;
            const password = document.getElementById('password').value;

            // Determine which login function to use based on current mock toggle state
            // (ignore saved settings, use toggle value)
            const isMock = mockToggle.checked;
            console.log(`🔐 Login attempt with mock mode: ${isMock}`);
            const loginResult = isMock
                ? await loginMock(username, password)
                : await loginProd(username, password);

            // Check if login was successful
            if (!loginResult.success) {
                showToast(loginResult.message || 'Login failed', 'error');
                setLoadingState(false);
                return;
            }

            // Save settings including the mock setting from the toggle
            const updatedSettings = {
                theme: themeToggle.checked ? 'dark' : 'light',
                stayLoggedIn: stayLoggedIn.checked,
                mock: mockToggle.checked, // Save the mock setting from toggle
            };

            // Always save the token regardless of stay logged in setting
            updatedSettings.token = loginResult.token;

            // If stay logged in is enabled, save the username
            if (updatedSettings.stayLoggedIn) {
                updatedSettings.lastUsername = username;
            } else {
                // If stay logged in is not enabled, ensure username is empty
                updatedSettings.lastUsername = '';
            }

            // Save settings
            await window.api.saveSettings(updatedSettings);

            // Call the login method exposed by the preload script immediately
            window.api.login();

        } catch (error) {
            console.error('Login error:', error);
            showToast('An unexpected error occurred during login', 'error');
            setLoadingState(false);
        }
    });
});