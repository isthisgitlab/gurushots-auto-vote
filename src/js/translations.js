// Translation system for GuruShots Auto Vote
const translations = {
    en: {
        // Common/shared translations
        common: {
            dark: 'Dark',
            global: 'Global:',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
            light: 'Light',
            loading: 'Loading...',
            logout: 'Logout',
            mock: 'Mock:',
            never: 'Never',
            no: 'No',
            off: 'OFF',
            on: 'ON',
            refresh: 'Refresh',
            running: 'Running',
            status: 'Status:',
            stay: 'Stay:',
            stopped: 'Stopped',
            theme: 'Theme',
            title: 'GuruShots Auto Vote',
            yes: 'Yes',
            ok: 'OK',
        },
        // Menu translations
        menu: {
            file: 'File',
            view: 'View',
            window: 'Window',
            help: 'Help',
            reload: 'Reload',
            toggleDevTools: 'Toggle Developer Tools',
            toggleFullscreen: 'Toggle Fullscreen',
            minimize: 'Minimize',
            zoom: 'Zoom',
            close: 'Close',
            bringAllToFront: 'Bring All to Front',
            about: 'About GuruShots Auto Vote',
            aboutTitle: 'About GuruShots Auto Vote',
            aboutAuthor: 'Author',
            aboutElectron: 'Electron',
            aboutNode: 'Node.js',
            aboutDescription: 'GuruShots Auto Vote - An Electron application for automated voting on GuruShots challenges with unified GUI and CLI interfaces (supports both real and mock modes)',
        },
        // Login screen specific
        login: {
            heading: 'Login',
            loadingModeInfo: 'Loading mode information...',
            loggingIn: 'Logging in...',
            loginButton: 'Login',
            mockMode: 'Mock mode',
            mockModeInfo: 'Mock mode: Using simulated data for testing. Any credentials will work.',
            password: 'Password',
            passwordPlaceholder: 'Enter your password',
            passwordRequired: 'Password is required',
            productionModeInfo: 'Production mode: Using real GuruShots API. Valid credentials required.',
            stayLoggedIn: 'Stay logged in',
            title: 'Login - GuruShots Auto Vote',
            username: 'Username',
            usernamePlaceholder: 'Enter your username',
            usernameRequired: 'Username is required',
        },
        // App screen specific
        app: {
            activeChallenges: 'Active Challenges',
            addCustomTimezone: 'Add custom timezone',
            addTimezone: 'Add custom timezone',
            apiTimeout: 'API Timeout',
            apiTimeoutDesc: 'Timeout for API requests in seconds (1-120)',
            appSetting: 'App Setting',
            applicationSettings: 'Application Settings',
            autoVote: 'Auto Vote',
            available: 'Available',
            used: 'Used',
            unavailable: 'Unavailable',
            boost: 'Boost',
            boostTime: 'Boost Time',
            boostTimeDesc: 'When to automatically apply boost (time remaining)',
            turbo: 'Turbo',
            cancel: 'Cancel',
            challengeDefaults: 'Challenge Defaults',
            challengeName: 'Challenge',
            challengeOverrides: 'Challenge Overrides',
            challengeSettings: 'Challenge Settings',
            challengeSettingsDesc: 'Configure settings specific to this challenge. Overrides will take precedence over global defaults.',
            checkForUpdates: 'Check for Updates',
            checkForUpdatesDesc: 'Manually check for new versions of the application',
            configureBoost: 'Configure Boost for',
            currentVersion: 'Current version',
            cycles: 'Cycles:',
            downloadUpdate: 'Download Update',
            ends: 'Ends',
            english: 'English',
            entries: 'Entries',
            entryDetails: 'Entry Details',
            error: 'Error',
            errorCheckingUpdates: 'Error checking for updates',
            errorLoadingUiSettings: 'Error loading UI settings',
            exposure: 'Exposure',
            exposureDesc: 'Exposure percentage threshold for actions',
            fast: 'FAST',
            global: 'Global',
            globalDefault: 'Global Default',
            globalSettings: 'Global Settings',
            hours: 'hours',
            language: 'Language',
            languageDesc: 'Select your preferred language',
            lastMinuteThreshold: 'Last Minute Threshold',
            lastMinuteThresholdDesc: 'Threshold in minutes for last-minute actions',
            lastRun: 'Last Run:',
            latestVersion: 'Latest version',
            latvian: 'Latviešu',
            local: 'Local',
            minutes: 'minutes',
            missingConfigFor: 'Missing config for',
            next: 'Next',
            noComm: 'No comm',
            noEntries: 'No entries',
            noGlobalSettingsToDisplay: 'No global settings to display',
            noOverrides: 'No challenge-specific overrides configured',
            noUiSettingsToDisplay: 'No UI settings to display',
            noUpdatesAvailable: 'No updates available',
            normal: 'NORMAL',
            of: 'of',
            onePhoto: '1 photo',
            onlyBoost: 'Only Boost Mode',
            onlyBoostDesc: 'Only perform boost actions, skip regular voting',
            override: 'Override',
            overrideForChallenge: 'Override for Challenge',
            photo: 'photo',
            photos: 'photos',
            players: 'Players',
            pleaseLogin: 'Please log in to view challenges',
            prerelease: 'Pre-release',
            prize: 'Prize',
            rank: 'Rank',
            rememberLoginSession: 'Remember login session',
            remindMeLater: 'Remind Me Later',
            removeCurrentTimezone: 'Remove current timezone',
            resetToGlobal: 'Reset to Global',
            resetToDefault: 'Reset to default',
            resetToDefaultNotSaved: 'Reset to default (not saved until Save)',
            resetAll: 'Reset All',
            resetAllConfirmTitle: 'Reset All Settings',
            resetAllConfirmMessage: 'Are you sure you want to reset ALL settings to their default values?',
            resetAllConfirmDetails: 'This will reset:\n• All UI settings (theme, language, timezone)\n• All global challenge defaults\n• Application preferences\n• Window positions and sizes\n• Custom timezones\n• Username and login session preferences\n\nOnly your login token, last update check time, mock mode setting, and API headers will be preserved.\n\nThis action cannot be undone.',
            resetAllSuccess: 'All settings have been reset to their default values. The page will reload to apply changes.',
            save: 'Save',
            seconds: 'seconds',
            settings: 'Settings',
            skipThisVersion: 'Skip This Version',
            speed: 'Speed',
            startAutoVote: 'Start Auto Vote',
            stayLoggedIn: 'Stay Logged In',
            stayLoggedInDesc: 'Keep login session after closing the app',
            stopAutoVote: 'Stop Auto Vote',
            theme: 'Theme',
            themeDesc: 'Choose between light and dark theme',
            time: 'Time',
            timezone: 'Timezone',
            timezoneDesc: 'Select your timezone for displaying challenge times',
            timezonePlaceholder: 'Enter timezone',
            uiSetting: 'UI Setting',
            updateAvailable: 'Update available!',
            vote: 'Vote',
            voteToNextLevel: 'vote to next level',
            voted: 'Voted!',
            votes: 'Votes',
            votesNeeded: 'votes needed',
            voting: 'Voting...',
            checkFrequency: 'Check Frequency',
            checkFrequencyDesc: 'Frequency of API checks for voting opportunities in minutes (1-60)',
            voteOnlyInLastMinute: 'Vote Only in Last Minute',
            voteOnlyInLastMinuteDesc: 'Only auto-vote when within the last minute threshold, skip voting otherwise',
            lastMinuteCheckFrequency: 'Last Minute Check Frequency',
            lastMinuteCheckFrequencyDesc: 'Check frequency in minutes when within last minute threshold (0-60, 0 = disabled)',
            lastHourExposure: 'Last Hour Exposure',
            lastHourExposureDesc: 'Exposure threshold for actions within the last hour of challenge (0-100)',
            useLastHourExposure: 'Use Last Hour Exposure',
            useLastHourExposureDesc: 'Enable special exposure logic for the last hour of challenge',
            validationInvalidValue: 'Invalid value',
            validationMustBeLessOrEqual: 'Must be ≤ {0} (currently {1})',
            whatsNew: 'What\'s New:',
            yourEntries: 'Your Entries',
            yourProgress: 'Your Progress',
        },
    },
    lv: {
        // Common/shared translations
        common: {
            dark: 'Tumšs',
            global: 'Globāls:',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
            light: 'Gaišs',
            loading: 'Ielādē...',
            logout: 'Iziet',
            mock: 'Tests:',
            never: 'Nekad',
            no: 'Nē',
            off: 'IZSLĒGTS',
            on: 'IESLĒGTS',
            refresh: 'Atjaunot',
            running: 'Darbojas',
            status: 'Statuss:',
            stay: 'Palikt:',
            stopped: 'Apturēts',
            theme: 'Tēma',
            title: 'GuruShots Auto Vote',
            yes: 'Jā',
            ok: 'Labi',
        },
        // Menu translations
        menu: {
            file: 'Fails',
            view: 'Skats',
            window: 'Logs',
            help: 'Palīdzība',
            reload: 'Pārlādēt',
            toggleDevTools: 'Pārslēgt izstrādātāja rīkus',
            toggleFullscreen: 'Pārslēgt pilnekrāna režīmu',
            minimize: 'Samazināt',
            zoom: 'Mērogot',
            close: 'Aizvērt',
            bringAllToFront: 'Pārvietot visus uz priekšu',
            about: 'Par GuruShots Auto Vote',
            aboutTitle: 'Par GuruShots Auto Vote',
            aboutAuthor: 'Autors',
            aboutElectron: 'Electron',
            aboutNode: 'Node.js',
            aboutDescription: 'GuruShots Auto Vote - Electron lietojumprogramma automātiskai balsošanai GuruShots izaicinājumos ar apvienotu GUI un CLI saskarni (atbalsta gan īstos, gan testa režīmus)',
        },
        // Login screen specific
        login: {
            heading: 'Pieteikšanās',
            loadingModeInfo: 'Ielādē informāciju par režīmu...',
            loggingIn: 'Piesakās...',
            loginButton: 'Pieteikties',
            mockMode: 'Testa režīms',
            mockModeInfo: 'Testa režīms: tiek izmantoti simulēti dati. Derēs jebkādi pieteikšanās dati.',
            password: 'Parole',
            passwordPlaceholder: 'Ievadiet savu paroli',
            passwordRequired: 'Parole ir obligāta',
            productionModeInfo: 'Produkcijas režīms: Tiek izmantots īstais GuruShots API. Nepieciešami derīgi pieejas dati.',
            stayLoggedIn: 'Saglabāt pieteikšanos',
            title: 'Pieteikšanās - GuruShots Auto Vote',
            username: 'Lietotājvārds',
            usernamePlaceholder: 'Ievadiet savu lietotājvārdu',
            usernameRequired: 'Lietotājvārds ir obligāts',
        },
        // App screen specific
        app: {
            activeChallenges: 'Aktīvie izaicinājumi',
            addCustomTimezone: 'Pievienot pielāgotu laika joslu',
            addTimezone: 'Pievienot laika joslu',
            apiTimeout: 'API noildze',
            apiTimeoutDesc: 'API pieprasījumu noildzes laiks sekundēs (1-120)',
            appSetting: 'Lietotnes iestatījums',
            applicationSettings: 'Lietotnes iestatījumi',
            autoVote: 'Automātiskā balsošana',
            available: 'Pieejams',
            used: 'Izmantots',
            unavailable: 'Nav pieejams',
            boost: 'Boost',
            boostTime: 'Boost laiks',
            boostTimeDesc: 'Kad automātiski pielietot "Boost" (pēc atlikušā laika)',
            turbo: 'Turbo',
            cancel: 'Atcelt',
            challengeDefaults: 'Noklusējuma iestatījumi izaicinājumiem',
            challengeName: 'Izaicinājums',
            challengeOverrides: 'Specifiskie iestatījumi izaicinājumiem',
            challengeSettings: 'Izaicinājuma iestatījumi',
            challengeSettingsDesc: 'Konfigurējiet iestatījumus, kas ir specifiski šim izaicinājumam. Pielāgotie iestatījumi būs prioritārāki par globālajiem noklusējumiem.',
            checkForUpdates: 'Pārbaudīt atjauninājumus',
            checkForUpdatesDesc: 'Manuāli pārbaudīt, vai ir pieejama jauna lietotnes versija',
            configureBoost: 'Konfigurēt "Boost" izaicinājumam:',
            currentVersion: 'Pašreizējā versija',
            cycles: 'Cikli:',
            downloadUpdate: 'Lejupielādēt atjauninājumu',
            ends: 'Beidzas',
            english: 'English',
            entries: 'Bildes',
            entryDetails: 'Bildes informācija',
            error: 'Kļūda',
            errorCheckingUpdates: 'Kļūda pārbaudot atjauninājumus',
            errorLoadingUiSettings: 'Kļūda UI iestatījumu ielādē',
            exposure: 'Redzamība',
            exposureDesc: 'Redzamības procentu slieksnis darbībām',
            fast: 'ĀTRS',
            global: 'Globāls',
            globalDefault: 'Globālais noklusējums',
            globalSettings: 'Globālie iestatījumi',
            hours: 'stunda(s)',
            language: 'Valoda',
            languageDesc: 'Izvēlieties lietotnes valodu',
            lastMinuteThreshold: 'Pēdējās minūtes slieksnis',
            lastMinuteThresholdDesc: 'Slieksnis minūtēs pēdējā brīža darbībām',
            lastRun: 'Pēdējoreiz darbināts:',
            latestVersion: 'Jaunākā versija',
            latvian: 'Latviešu',
            local: 'Vietējā',
            minutes: 'minūte(s)',
            missingConfigFor: 'Trūkst konfigurācijas:',
            next: 'Nākamais',
            noComm: 'Bez komentāriem',
            noEntries: 'Nav bilžu',
            noGlobalSettingsToDisplay: 'Nav globālu iestatījumu, ko attēlot',
            noOverrides: 'Nav norādīti specifiski iestatījumi izaicinājumiem',
            noUiSettingsToDisplay: 'Nav saskarnes iestatījumu, ko attēlot',
            noUpdatesAvailable: 'Nav pieejamu atjauninājumu',
            normal: 'NORMĀLS',
            of: 'no',
            onePhoto: '1 bilde',
            onlyBoost: 'Tikai "Boost" režīms',
            onlyBoostDesc: 'Veikt tikai boost darbības, izlaist parasto balsošanu',
            override: 'Pielāgots',
            overrideForChallenge: 'Pielāgot iestatījumus izaicinājumam',
            photo: 'bilde',
            photos: 'bildes',
            players: 'Spēlētāji',
            pleaseLogin: 'Lai apskatītu izaicinājumus, lūdzu, piesakieties',
            prerelease: 'Pirmizlaides versija',
            prize: 'Balva',
            rank: 'Vieta',
            rememberLoginSession: 'Atcerēties pieteikšanās sesiju',
            remindMeLater: 'Atgādināt vēlāk',
            removeCurrentTimezone: 'Noņemt pašreizējo laika joslu',
            resetToGlobal: 'Atiestatīt uz globālajiem',
            resetToDefault: 'Atiestatīt uz noklusējumu',
            resetToDefaultNotSaved: 'Atiestatīt uz noklusējumu (netiks saglabāts, kamēr nenospiedīsiet \'Saglabāt\')',
            resetAll: 'Atiestatīt visu',
            resetAllConfirmTitle: 'Atiestatīt visus iestatījumus',
            resetAllConfirmMessage: 'Vai tiešām vēlaties atiestatīt VISUS iestatījumus uz to noklusējuma vērtībām?',
            resetAllConfirmDetails: 'Šī darbība atiestatīs:\n• Visus saskarnes iestatījumus (tēmu, valodu, laika joslu)\n• Visus globālos noklusējuma iestatījumus izaicinājumiem\n• Lietotnes preferences\n• Logu pozīcijas un izmērus\n• Pielāgotās laika joslas\n• Lietotājvārda un pieteikšanās sesijas preferences\n\nTiks saglabāts tikai jūsu piekļuves marķieris (token), pēdējais atjauninājumu pārbaudes laiks, testa režīma iestatījums un API galvenes.\n\nŠo darbību nevar atsaukt.',
            resetAllSuccess: 'Visi iestatījumi ir atiestatīti. Lapa tiks pārlādēta, lai piemērotu izmaiņas.',
            save: 'Saglabāt',
            seconds: 'sekunde(s)',
            settings: 'Iestatījumi',
            skipThisVersion: 'Izlaist šo versiju',
            speed: 'Ātrums',
            startAutoVote: 'Sākt automātisko balsošanu',
            stayLoggedIn: 'Saglabāt pieteikšanos',
            stayLoggedInDesc: 'Saglabāt pieteikšanās sesiju pēc lietotnes aizvēršanas',
            stopAutoVote: 'Apturēt automātisko balsošanu',
            theme: 'Tēma',
            themeDesc: 'Izvēlieties gaišo vai tumšo tēmu',
            time: 'Laiks',
            timezone: 'Laika josla',
            timezoneDesc: 'Izvēlieties savu laika joslu, lai korekti attēlotu izaicinājumu laikus',
            timezonePlaceholder: 'Ievadiet laika joslu',
            uiSetting: 'Saskarnes iestatījums',
            updateAvailable: 'Pieejams atjauninājums!',
            vote: 'Balsot',
            voteToNextLevel: 'balsis līdz nākamajam līmenim',
            voted: 'Nobalsots!',
            votes: 'Balsis',
            votesNeeded: 'balsis nepieciešamas',
            voting: 'Balso...',
            checkFrequency: 'Pārbaudes biežums',
            checkFrequencyDesc: 'API pārbaudes biežums balsošanas iespējām minūtēs (1-60)',
            voteOnlyInLastMinute: 'Balsot tikai pēdējās minūtes laikā',
            voteOnlyInLastMinuteDesc: 'Balsot tikai tad, ja līdz izaicinājuma beigām ir mazāk laika, nekā norādīts pēdējās minūtes slieksnī.',
            lastMinuteCheckFrequency: 'Pēdējās minūtes pārbaudes biežums',
            lastMinuteCheckFrequencyDesc: 'Pārbaudes biežums minūtēs, kad atrodas pēdējās minūtes slieksnī (0-60, 0 = izslēgts)',
            lastHourExposure: 'Pēdējās stundas ekspozīcija',
            lastHourExposureDesc: 'Ekspozīcijas slieksnis darbībām pēdējās stundas laikā (0-100)',
            useLastHourExposure: 'Izmantot pēdējās stundas ekspozīciju',
            useLastHourExposureDesc: 'Iespējot īpašu ekspozīcijas loģiku pēdējā stundā',
            validationInvalidValue: 'Nepareiza vērtība',
            validationMustBeLessOrEqual: 'Jābūt ≤ {0} (pašlaik {1})',
            whatsNew: 'Kas jauns:',
            yourEntries: 'Jūsu bildes',
            yourProgress: 'Jūsu progress',
        },
    },
};

// Translation utility functions
class TranslationManager {
    constructor() {
        this.currentLanguage = 'en'; // Default language
        this.initialized = false;
        this.init();
    }

    async init() {
        // Wait a bit for window.api to be available
        if (typeof window !== 'undefined' && !window.api) {
            // Wait for window.api to be available
            let attempts = 0;
            while (!window.api && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
        }
        await this.loadLanguageFromSettings();
        this.initialized = true;
    }

    // Load language from settings
    async loadLanguageFromSettings() {
        try {
            // Check if we're in a browser context with window.api
            if (typeof window !== 'undefined' && window.api && window.api.getSettings) {
                const settings = await window.api.getSettings();
                const savedLanguage = settings.language;
                if (savedLanguage && translations[savedLanguage]) {
                    this.currentLanguage = savedLanguage;
                }
            } else {
                // Fallback for Node.js context
                try {
                    const settings = require('./settings');
                    const savedLanguage = settings.getSetting('language');
                    if (savedLanguage && translations[savedLanguage]) {
                        this.currentLanguage = savedLanguage;
                    }
                } catch (error) {
                    const logger = require('./logger');
                    logger.warning('Could not load language from settings (Node.js):', error);
                }
            }
        } catch (error) {
            const logger = require('./logger');
            logger.warning('Could not load language from settings:', error);
        }
    }

    // Save language to settings
    async saveLanguageToSettings(language) {
        try {
            // Check if we're in a browser context with window.api
            if (typeof window !== 'undefined' && window.api && window.api.setSetting) {
                await window.api.setSetting('language', language);
                this.currentLanguage = language;
            } else {
                // Fallback for Node.js context
                try {
                    const settings = require('./settings');
                    settings.setSetting('language', language);
                    this.currentLanguage = language;
                } catch (error) {
                    const logger = require('./logger');
                    logger.error('Could not save language to settings (Node.js):', error);
                }
            }
        } catch (error) {
            const logger = require('./logger');
            logger.error('Could not save language to settings:', error);
        }
    }

    // Get translation for a key
    t(key) {
        const keys = key.split('.');
        let value = translations[this.currentLanguage];

        for (const k of keys) {
            if (value && value[k]) {
                value = value[k];
            } else {
                // Fallback to English if translation not found
                value = translations.en;
                for (const fallbackKey of keys) {
                    if (value && value[fallbackKey]) {
                        value = value[fallbackKey];
                    } else {
                        return key; // Return key if no translation found
                    }
                }
            }
        }

        return value || key;
    }

    // Get current language
    getCurrentLanguage() {
        return this.currentLanguage;
    }

    // Get available languages
    getAvailableLanguages() {
        return Object.keys(translations);
    }

    // Set language
    async setLanguage(language) {
        if (translations[language]) {
            await this.saveLanguageToSettings(language);
            this.currentLanguage = language;
            return true;
        }
        return false;
    }
}

// Create global instance only if it doesn't already exist
if (typeof window !== 'undefined' && !window.translationManager) {
    window.translationManager = new TranslationManager();
    window.translations = translations;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    // Create instance for Node.js (main process)
    const mainProcessTranslationManager = new TranslationManager();
    module.exports = {
        translationManager: typeof window !== 'undefined' ? window.translationManager : mainProcessTranslationManager,
        translations,
    };
}