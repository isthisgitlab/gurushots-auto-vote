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
            // New settings-related translations
            activeChallenges: 'Active Challenges',
            addCustomTimezone: 'Add custom timezone',
            addTimezone: 'Add custom timezone',
            apiTimeout: 'API Timeout',
            apiTimeoutDesc: 'Timeout for API requests in seconds (1-120)',
            appSetting: 'App Setting',
            applicationSettings: 'Application Settings',
            autoBoostWhenTimeRemaining: 'Auto-boost when time remaining is less than:',
            autoVote: 'Auto Vote',
            available: 'Available',
            boost: 'Boost',
            boostTime: 'Boost Time',
            boostTimeDesc: 'When to automatically apply boost (time remaining)',
            cancel: 'Cancel',
            challengeDefaults: 'Challenge Defaults',
            challengeName: 'Challenge',
            challengeOverrides: 'Challenge Overrides',
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
            exposureThreshold: 'Exposure Threshold',
            fast: 'FAST',
            global: 'Global',
            globalDefault: 'Global Default',
            globalDefaults: 'Global Defaults',
            globalSettings: 'Global Settings',
            hours: 'hours',
            language: 'Language',
            languageDesc: 'Select your preferred language',
            lastMinutes: 'Last Minutes Threshold',
            lastMinutesDesc: 'Threshold in minutes for last-minute actions',
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
            votingInterval: 'Voting Interval',
            votingIntervalDesc: 'Interval between voting cycles in minutes (1-60)',
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
            logout: 'Izrakstīties',
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
        },
        // Login screen specific
        login: {
            heading: 'Pieslēgšanās',
            loadingModeInfo: 'Ielādē režīma informāciju...',
            loggingIn: 'Notiek pieslēgšanās...',
            loginButton: 'Pieslēgties',
            mockMode: 'Testa režīms',
            mockModeInfo: 'Testa režīms: Tiek izmantoti simulēti dati testēšanai. Derēs jebkuri pieteikšanās dati.',
            password: 'Parole',
            passwordPlaceholder: 'Ievadiet savu paroli',
            passwordRequired: 'Parole ir obligāta',
            productionModeInfo: 'Produkcijas režīms: Tiek izmantots īstais GuruShots API. Nepieciešami derīgi pieteikšanās dati.',
            stayLoggedIn: 'Palikt pieslēgtam',
            title: 'Pieslēgšanās - GuruShots Auto Vote',
            username: 'Lietotājvārds',
            usernamePlaceholder: 'Ievadiet savu lietotājvārdu',
            usernameRequired: 'Lietotājvārds ir obligāts',
        },
        // App screen specific
        app: {
            // New settings-related translations
            activeChallenges: 'Aktīvie izaicinājumi',
            addCustomTimezone: 'Pievienot pielāgotu laika joslu',
            addTimezone: 'Pievienot laika joslu',
            apiTimeout: 'API noildze',
            apiTimeoutDesc: 'API pieprasījumu noildze sekundēs (1-120)',
            appSetting: 'Lietotnes iestatījums',
            applicationSettings: 'Lietotnes iestatījumi',
            autoBoostWhenTimeRemaining: 'Automātisks boost, ja atlicis mazāk par:',
            autoVote: 'Automātiskā balsošana',
            available: 'Pieejams',
            boost: 'Boost',
            boostTime: 'Boost laiks',
            boostTimeDesc: 'Kad automātiski lietot boost (atlikušais laiks)',
            cancel: 'Atcelt',
            challengeDefaults: 'Izaicinājumu noklusējumi',
            challengeName: 'Izaicinājums',
            challengeOverrides: 'Izaicinājumu pārlabošana',
            checkForUpdates: 'Pārbaudīt atjauninājumus',
            checkForUpdatesDesc: 'Manuāli pārbaudīt jaunas lietotnes versijas',
            configureBoost: 'Konfigurēt boost:',
            currentVersion: 'Pašreizējā versija',
            cycles: 'Cikli:',
            downloadUpdate: 'Lejupielādēt atjauninājumu',
            ends: 'Beidzas',
            english: 'English',
            entries: 'Bildes',
            entryDetails: 'Iesnieguma detaļas',
            error: 'Kļūda',
            errorCheckingUpdates: 'Kļūda pārbaudot atjauninājumus',
            errorLoadingUiSettings: 'Kļūda UI iestatījumu ielādē',
            exposure: 'Ekspozīcija',
            exposureDesc: 'Ekspozīcijas procentu slieksnis darbībām',
            exposureThreshold: 'Ekspozīcijas slieksnis',
            fast: 'ĀTRS',
            global: 'Globāls',
            globalDefault: 'Globālais noklusējums',
            globalDefaults: 'Globālie noklusējumi',
            globalSettings: 'Globālie iestatījumi',
            hours: 'stunda(s)',
            language: 'Valoda',
            languageDesc: 'Izvēlieties savu vēlamo valodu',
            lastMinutes: 'Pēdējo minūšu slieksnis',
            lastMinutesDesc: 'Slieksnis minūtēs pēdējo minūšu darbībām',
            lastRun: 'Pēdējā palaišana:',
            latestVersion: 'Jaunākā versija',
            latvian: 'Latviešu',
            local: 'Vietējā',
            minutes: 'minūte(s)',
            missingConfigFor: 'Trūkst konfigurācijas priekš',
            next: 'Nākamais',
            noComm: 'Bez komentāriem',
            noEntries: 'Nav bilžu',
            noGlobalSettingsToDisplay: 'Nav globālo iestatījumu attēlošanai',
            noOverrides: 'Nav konfigurēta specifiska izaicinājumu pārlabošana',
            noUiSettingsToDisplay: 'Nav UI iestatījumu attēlošanai',
            noUpdatesAvailable: 'Nav pieejamu atjauninājumu',
            normal: 'NORMĀLS',
            of: 'no',
            onePhoto: '1 foto',
            onlyBoost: 'Tikai boost režīms',
            onlyBoostDesc: 'Veikt tikai boost darbības, izlaist parasto balsošanu',
            override: 'Pārlabošana',
            overrideForChallenge: 'Pārlabot izaicinājumam',
            photo: 'foto',
            photos: 'foto',
            players: 'Spēlētāji',
            pleaseLogin: 'Lūdzu, piesakieties, lai apskatītu izaicinājumus',
            prerelease: 'Priekšizlaidums',
            prize: 'Balva',
            rank: 'Vieta',
            rememberLoginSession: 'Atcerēties ielogošanas sesiju',
            remindMeLater: 'Atgādināt vēlāk',
            removeCurrentTimezone: 'Noņemt pašreizējo laika joslu',
            resetToGlobal: 'Atiestatīt uz globālo',
            save: 'Saglabāt',
            seconds: 'sekunde(s)',
            settings: 'Iestatījumi',
            skipThisVersion: 'Izlaist šo versiju',
            speed: 'Ātrums',
            startAutoVote: 'Sākt balsošanu',
            stayLoggedIn: 'Palikt ielogotam',
            stayLoggedInDesc: 'Saglabāt ielogošanas sesiju pēc lietotnes aizvēršanas',
            stopAutoVote: 'Apturēt balsošanu',
            theme: 'Tēma',
            themeDesc: 'Izvēlieties starp gaišo un tumšo tēmu',
            time: 'Laiks',
            timezone: 'Laika josla',
            timezoneDesc: 'Izvēlieties savu laika joslu izaicinājumu laiku attēlošanai',
            timezonePlaceholder: 'Ievadiet laika joslu',
            uiSetting: 'UI iestatījums',
            updateAvailable: 'Atjauninājums pieejams!',
            vote: 'Balsot',
            voteToNextLevel: 'balsis līdz nākamajam līmenim',
            voted: 'Nobalsots!',
            votes: 'Balsis',
            votesNeeded: 'nepieciešamas balsis',
            voting: 'Notiek balsošana...',
            votingInterval: 'Balsošanas intervāls',
            votingIntervalDesc: 'Intervāls starp balsošanas cikliem minūtēs (1-60)',
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
                    console.warn('Could not load language from settings (Node.js):', error);
                }
            }
        } catch (error) {
            console.warn('Could not load language from settings:', error);
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
                    console.error('Could not save language to settings (Node.js):', error);
                }
            }
        } catch (error) {
            console.error('Could not save language to settings:', error);
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
    module.exports = {translationManager: window.translationManager || new TranslationManager(), translations};
}