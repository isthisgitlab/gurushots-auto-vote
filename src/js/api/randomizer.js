/**
 * API Header Randomizer
 * 
 * Randomizes API headers to make the app look more natural when used by multiple people.
 * Headers are saved in settings so they stay consistent for each app installation.
 * Keeps app version and build number the same for consistency.
 */

const settings = require('../settings');

// Current app version - update this when releasing new versions
const CURRENT_APP_VERSION = '2.41.3';
const CURRENT_BUILD_NUMBER = '507';

// iPhone models that can be randomized
const IPHONE_MODELS = [
    'iPhone 16 Pro Max',
    'iPhone 16 Pro',
    'iPhone 16',
    'iPhone 15 Pro Max',
    'iPhone 15 Pro',
    'iPhone 15',
    'iPhone 14 Pro Max',
    'iPhone 14 Pro',
    'iPhone 14',
    'iPhone 13 Pro',
    'iPhone 13',
    'iPhone 12 Pro',
    'iPhone 12',
    'iPhone 11 Pro',
    'iPhone 11',
];

// iOS versions that can be randomized
const IOS_VERSIONS = [
    '16.7.11',
    '16.7.10',
    '16.7.9',
    '16.7.8',
    '16.7.7',
    '16.7.6',
    '16.7.5',
    '16.7.4',
    '16.7.3',
    '16.7.2',
    '16.7.1',
    '16.7.0',
];

// Language preferences that can be randomized
const LANGUAGE_PREFERENCES = [
    'en-SE;q=1.0, sv-SE;q=0.9, fr-SE;q=0.8, es-SE;q=0.7',
    'en-SE;q=1.0, fr-SE;q=0.9, sv-SE;q=0.8, es-SE;q=0.7',
    'fr-SE;q=1.0, en-SE;q=0.9, sv-SE;q=0.8, es-SE;q=0.7',
    'sv-SE;q=1.0, en-SE;q=0.9, fr-SE;q=0.8, es-SE;q=0.7',
    'es-SE;q=1.0, en-SE;q=0.9, fr-SE;q=0.8, sv-SE;q=0.7',
];

// Alamofire versions that can be randomized
const ALAMOFIRE_VERSIONS = [
    '5.10.2',
    '5.10.1',
    '5.10.0',
    '5.9.1',
    '5.9.0',
    '5.8.1',
    '5.8.0',
];

/**
 * Gets a random item from an array
 */
const getRandomItem = (array) => {
    return array[Math.floor(Math.random() * array.length)];
};

/**
 * Initializes API headers on app startup
 * Ensures headers are always available in settings
 */
const initializeHeaders = () => {
    // Check if we already have saved headers
    let savedHeaders = settings.getSetting('apiHeaders');
    
    if (!savedHeaders) {
        // Generate new random headers
        const iphoneModel = getRandomItem(IPHONE_MODELS);
        const iosVersion = getRandomItem(IOS_VERSIONS);
        const languagePref = getRandomItem(LANGUAGE_PREFERENCES);
        const alamofireVersion = getRandomItem(ALAMOFIRE_VERSIONS);
        
        savedHeaders = {
            'host': 'api.gurushots.com',
            'accept': '*/*',
            'x-device': 'iPhone',
            'x-requested-with': 'XMLHttpRequest',
            'x-model': iphoneModel,
            'accept-language': languagePref,
            'x-api-version': '20',
            'x-env': 'IOS',
            'user-agent': `GuruShotsIOS/${CURRENT_APP_VERSION} (com.gurushots.app; build:${CURRENT_BUILD_NUMBER}; iOS ${iosVersion}) Alamofire/${alamofireVersion}`,
            'x-app-version': CURRENT_APP_VERSION,
            'connection': 'keep-alive',
            'x-brand': 'Apple',
            '_version': CURRENT_APP_VERSION, // Track version for updates
        };
        
        // Save headers to settings
        settings.setSetting('apiHeaders', savedHeaders);
    } else {
        // Check if version needs updating
        if (savedHeaders._version !== CURRENT_APP_VERSION) {
            // Update version-related fields while preserving randomized values
            const iosVersion = savedHeaders.userAgent.match(/iOS ([^)]+)/)?.[1] || '16.7.11';
            const alamofireVersion = savedHeaders.userAgent.match(/Alamofire\/([^)]+)/)?.[1] || '5.10.2';
            
            savedHeaders = {
                ...savedHeaders,
                'user-agent': `GuruShotsIOS/${CURRENT_APP_VERSION} (com.gurushots.app; build:${CURRENT_BUILD_NUMBER}; iOS ${iosVersion}) Alamofire/${alamofireVersion}`,
                'x-app-version': CURRENT_APP_VERSION,
                '_version': CURRENT_APP_VERSION,
            };
            
            // Save updated headers
            settings.setSetting('apiHeaders', savedHeaders);
        }
    }
    
    return savedHeaders;
};

/**
 * Generates randomized API headers
 * Ensures headers are initialized and returns them with the current token
 */
const generateRandomHeaders = (token) => {
    // Ensure headers are initialized
    const savedHeaders = initializeHeaders();
    
    // Return headers with current token
    return {
        ...savedHeaders,
        'x-token': token,
    };
};

module.exports = {
    generateRandomHeaders,
    initializeHeaders,
    IPHONE_MODELS,
    IOS_VERSIONS,
    LANGUAGE_PREFERENCES,
    ALAMOFIRE_VERSIONS,
    CURRENT_APP_VERSION,
    CURRENT_BUILD_NUMBER,
}; 