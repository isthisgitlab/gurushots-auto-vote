const translationManager = window.translationManager;

// Function to update all translations on the page
export const updateTranslations = () => {
    // Update elements with data-translate attribute
    document.querySelectorAll('[data-translate]').forEach(element => {
        const key = element.getAttribute('data-translate');
        element.textContent = translationManager.t(key);
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
    document.title = translationManager.t('common.title');
};

// Function to update settings display
export const updateSettingsDisplay = (settings) => {
    // Header status badges
    const mockStatus = document.getElementById('mock-status');
    if (mockStatus) {
        if (settings.mock) {
            mockStatus.textContent = translationManager.t('common.on');
            mockStatus.className = 'badge badge-sm badge-success';
        } else {
            mockStatus.textContent = translationManager.t('common.off');
            mockStatus.className = 'badge badge-sm badge-neutral';
        }
    }

    const stayLoggedInStatus = document.getElementById('stay-logged-in-status');
    if (stayLoggedInStatus) {
        if (settings.stayLoggedIn) {
            stayLoggedInStatus.textContent = translationManager.t('common.on');
            stayLoggedInStatus.className = 'badge badge-sm badge-success';
        } else {
            stayLoggedInStatus.textContent = translationManager.t('common.off');
            stayLoggedInStatus.className = 'badge badge-sm badge-neutral';
        }
    }
}; 