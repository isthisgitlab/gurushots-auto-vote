// Translation system for GuruShots Auto Vote
const translations = {
    en: {
        // Common/shared translations
        common: {
            title: 'GuruShots Auto Vote',
            light: 'Light',
            dark: 'Dark',
            on: 'ON',
            off: 'OFF',
            loading: 'Loading...',
            theme: 'Theme',
            mock: 'Mock:',
            stay: 'Stay:',
            logout: 'Logout',
            refresh: 'Refresh',
            status: 'Status:',
            running: 'Running',
            stopped: 'Stopped',
            never: 'Never',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
        },
        // Login screen specific
        login: {
            title: 'Login - GuruShots Auto Vote',
            heading: 'Login',
            username: 'Username',
            usernamePlaceholder: 'Enter your username',
            password: 'Password',
            passwordPlaceholder: 'Enter your password',
            usernameRequired: 'Username is required',
            passwordRequired: 'Password is required',
            stayLoggedIn: 'Stay logged in',
            mockMode: 'Mock mode',
            loginButton: 'Login',
            loggingIn: 'Logging in...',
            mockModeInfo: 'Mock mode: Using simulated data for testing. Any credentials will work.',
            productionModeInfo: 'Production mode: Using real GuruShots API. Valid credentials required.',
            loadingModeInfo: 'Loading mode information...',
        },
        // App screen specific
        app: {
            timezone: 'Timezone',
            addTimezone: 'Add custom timezone',
            timezonePlaceholder: 'Enter timezone',
            local: 'Local',
            autoVote: 'Auto Vote',
            startAutoVote: 'Start Auto Vote',
            stopAutoVote: 'Stop Auto Vote',
            lastRun: 'Last Run:',
            cycles: 'Cycles:',
            activeChallenges: 'Active Challenges',
            pleaseLogin: 'Please log in to view challenges',
            vote: 'Vote',
            entries: 'Entries',
            players: 'Players',
            votes: 'Votes',
            prize: 'Prize',
            time: 'Time',
            ends: 'Ends',
            exposure: 'Exposure',
            boost: 'Boost',
            yourEntries: 'Your Entries',
            yourProgress: 'Your Progress',
            rank: 'Rank',
            of: 'of',
            voteToNextLevel: 'vote to next level',
            next: 'Next',
            votesNeeded: 'votes needed',
            photo: 'photo',
            photos: 'photos',
            speed: 'Speed',
            noComm: 'No comm',
            onePhoto: '1 photo',
            entryDetails: 'Entry Details',
            fast: 'FAST',
            normal: 'NORMAL',
            available: 'Available',
            voting: 'Voting...',
            voted: 'Voted!',
            error: 'Error',
            noEntries: 'No entries',
            configureBoost: 'Configure Boost for',
            autoBoostWhenTimeRemaining: 'Auto-boost when time remaining is less than:',
            hours: 'hours',
            minutes: 'minutes',
            save: 'Save',
            cancel: 'Cancel',
            // New settings-related translations
            settings: 'Settings',
            globalSettings: 'Global Settings',
            challengeOverrides: 'Challenge Overrides',
            boostTime: 'Boost Time',
            boostTimeDesc: 'When to automatically apply boost (time remaining)',
            exposureThreshold: 'Exposure Threshold',
            exposureDesc: 'Exposure percentage threshold for actions',
            onGuruVoting: 'Guru Voting Mode',
            onGuruVotingDesc: 'Enable special voting mode for guru picks',
            lastMinutes: 'Last Minutes Threshold',
            lastMinutesDesc: 'Threshold in minutes for last-minute actions',
            onlyBoost: 'Only Boost Mode',
            onlyBoostDesc: 'Only perform boost actions, skip regular voting',
            globalDefaults: 'Global Defaults',
            overrideForChallenge: 'Override for Challenge',
            resetToGlobal: 'Reset to Global',
            challengeName: 'Challenge',
            noOverrides: 'No challenge-specific overrides configured',
        },
    },
    lv: {
        // Common/shared translations
        common: {
            title: 'GuruShots Auto Vote',
            light: 'Gaišs',
            dark: 'Tumšs',
            on: 'ON',
            off: 'OFF',
            loading: 'Ielādē...',
            theme: 'Tēma',
            mock: 'Tests:',
            stay: 'Palikt:',
            logout: 'Izrakstīties',
            refresh: 'Atjaunot',
            status: 'Statuss:',
            running: 'Darbojas',
            stopped: 'Apturēts',
            never: 'Nekad',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
        },
        // Login screen specific
        login: {
            title: 'Pieslēgšanās - GuruShots Auto Vote',
            heading: 'Pieslēgšanās',
            username: 'Lietotājvārds',
            usernamePlaceholder: 'Ievadiet savu lietotājvārdu',
            password: 'Parole',
            passwordPlaceholder: 'Ievadiet savu paroli',
            usernameRequired: 'Lietotājvārds ir obligāts',
            passwordRequired: 'Parole ir obligāta',
            stayLoggedIn: 'Palikt pieslēgtam',
            mockMode: 'Testa režīms',
            loginButton: 'Pieslēgties',
            loggingIn: 'Notiek pieslēgšanās...',
            mockModeInfo: 'Testa režīms: Tiek izmantoti simulēti dati testēšanai. Derēs jebkuri pieteikšanās dati.',
            productionModeInfo: 'Produkcijas režīms: Tiek izmantots īstais GuruShots API. Nepieciešami derīgi pieteikšanās dati.',
            loadingModeInfo: 'Ielādē režīma informāciju...',
        },
        // App screen specific
        app: {
            timezone: 'Laika josla',
            addTimezone: 'Pievienot laika joslu',
            timezonePlaceholder: 'Ievadiet laika joslu',
            local: 'Vietējā',
            autoVote: 'Automātiskā balsošana',
            startAutoVote: 'Sākt balsošanu',
            stopAutoVote: 'Apturēt balsošanu',
            lastRun: 'Pēdējā palaišana:',
            cycles: 'Cikli:',
            activeChallenges: 'Aktīvie izaicinājumi',
            pleaseLogin: 'Lūdzu, piesakieties, lai apskatītu izaicinājumus',
            vote: 'Balsot',
            entries: 'Bildes',
            players: 'Spēlētāji',
            votes: 'Balsis',
            prize: 'Balva',
            time: 'Laiks',
            ends: 'Beidzas',
            exposure: 'Ekspozīcija',
            boost: 'Boost',
            yourEntries: 'Jūsu bildes',
            yourProgress: 'Jūsu progress',
            rank: 'Vieta',
            of: 'no',
            voteToNextLevel: 'balsis līdz nākamajam līmenim',
            next: 'Nākamais',
            votesNeeded: 'nepieciešamas balsis',
            photo: 'foto',
            photos: 'foto',
            speed: 'Ātrums',
            noComm: 'Bez komentāriem',
            onePhoto: '1 foto',
            entryDetails: 'Iesnieguma detaļas',
            fast: 'ĀTRS',
            normal: 'NORMĀLS',
            available: 'Pieejams',
            voting: 'Notiek balsošana...',
            voted: 'Nobalsots!',
            error: 'Kļūda',
            noEntries: 'Nav bilžu',
            configureBoost: 'Konfigurēt boost:',
            autoBoostWhenTimeRemaining: 'Automātisks boost, ja atlicis mazāk par:',
            hours: 'stundām',
            minutes: 'minūtēm',
            save: 'Saglabāt',
            cancel: 'Atcelt',
            // New settings-related translations
            settings: 'Iestatījumi',
            globalSettings: 'Globālie iestatījumi',
            challengeOverrides: 'Izaicinājumu pārlabošana',
            boostTime: 'Boost laiks',
            boostTimeDesc: 'Kad automātiski lietot boost (atlikušais laiks)',
            exposureThreshold: 'Ekspozīcijas slieksnis',
            exposureDesc: 'Ekspozīcijas procentu slieksnis darbībām',
            onGuruVoting: 'Guru balsošanas režīms',
            onGuruVotingDesc: 'Iespējot speciālo balsošanas režīmu guru izvēlēm',
            lastMinutes: 'Pēdējo minūšu slieksnis',
            lastMinutesDesc: 'Slieksnis minūtēs pēdējo minūšu darbībām',
            onlyBoost: 'Tikai boost režīms',
            onlyBoostDesc: 'Veikt tikai boost darbības, izlaist parasto balsošanu',
            globalDefaults: 'Globālie noklusējumi',
            overrideForChallenge: 'Pārlabot izaicinājumam',
            resetToGlobal: 'Atiestatīt uz globālo',
            challengeName: 'Izaicinājums',
            noOverrides: 'Nav konfigurēta specifiska izaicinājumu pārlabošana',
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
    module.exports = { translationManager: window.translationManager || new TranslationManager(), translations };
}