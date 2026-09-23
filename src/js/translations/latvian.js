// Latvian translations for GuruShots Auto Vote
/* global window, self */
(function (root, factory) {
    // The else branch is the classic <script>-tag load (src/html/*.html). Jest
    // always loads this file through its CommonJS wrapper, where `module` is
    // defined, so that branch cannot run under test.
    /* istanbul ignore else */
    if (typeof module === 'object' && module.exports) {
        // Node.js
        module.exports = factory();
    } else {
        // Browser globals
        root.latvianTranslations = factory();
    }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
    return {
        // Common/shared translations
        common: {
            dark: 'Tumšs',
            global: 'Globāls:',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
            light: 'Gaišs',
            loading: 'Ielādē...',
            closeModal: 'Aizvērt',
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
        // Error / recovery UI
        errors: {
            boundaryTitle: 'Kaut kas nogāja greizi',
            dismiss: 'Aizvērt',
            reload: 'Pārlādēt',
            fetchFailed: 'Neizdevās sasniegt GuruShots — automātiski mēģinām vēlreiz.',
        },
        // First-run onboarding
        onboarding: {
            title: 'Laipni lūdzam GuruShots Auto Vote',
            intro: 'Šī lietotne automātiski balso tavās aktīvajās GuruShots sacensībās pēc grafika, uzturot tavu redzamību augstu bez tavas iesaistes.',
            howItWorksTitle: 'Kā tas darbojas',
            howItWorks:
                'Pieslēdzies, izvēlies sliekšņus iestatījumos un ieslēdz automātisko balsošanu. Lietotne pārbauda sacensības ik pēc dažām minūtēm un balso, kad nepieciešams.',
            batteryTitle: 'Darbība fonā',
            batteryBody:
                'Lai balsošana turpinātos, kad ekrāns ir izslēgts, izslēdz šai lietotnei akumulatora optimizāciju tālruņa iestatījumos. Daži ražotāji (Samsung, Xiaomi, OnePlus) agresīvi pārtrauc fona lietotnes.',
            gotIt: 'Sapratu',
        },
        // Menu translations
        menu: {
            edit: 'Rediģēt',
            undo: 'Atsaukt',
            redo: 'Atkārtot',
            cut: 'Izgriezt',
            copy: 'Kopēt',
            paste: 'Ielīmēt',
            selectAll: 'Atlasīt visu',
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
            logs: 'Žurnāli',
            about: 'Par GuruShots Auto Vote',
            aboutTitle: 'Par GuruShots Auto Vote',
            aboutAuthor: 'Autors',
            aboutElectron: 'Electron',
            aboutNode: 'Node.js',
            aboutDescription:
                'GuruShots Auto Vote - Electron lietojumprogramma automātiskai balsošanai GuruShots izaicinājumos ar apvienotu GUI un CLI saskarni (atbalsta gan īstos, gan testa režīmus)',
            checkForUpdates: 'Pārbaudīt atjauninājumus...',
            noUpdates: 'Nav atjauninājumu',
            noUpdatesMessage: 'Tev jau ir jaunākā versija.',
            updateError: 'Atjaunināšanas kļūda',
            updateErrorMessage: 'Neizdevās pārbaudīt atjauninājumus.',
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
            passwordPlaceholder: 'Ievadi savu paroli',
            passwordRequired: 'Parole ir obligāta',
            productionModeInfo:
                'Īstais režīms: savienojas ar tavu GuruShots kontu. Vajag derīgu lietotājvārdu un paroli.',
            stayLoggedIn: 'Saglabāt pieteikšanos',
            title: 'Pieteikšanās - GuruShots Auto Vote',
            username: 'Lietotājvārds',
            usernamePlaceholder: 'Ievadi savu lietotājvārdu',
            usernameRequired: 'Lietotājvārds ir obligāts',
        },
        // App screen specific
        app: {
            activeChallenges: 'Aktīvie izaicinājumi',
            addCustomTimezone: 'Pievienot pielāgotu laika joslu',
            addTimezone: 'Pievienot laika joslu',
            apiTimeout: 'Gaidīšanas laiks',
            apiTimeoutDesc:
                'Cik ilgi gaidīt GuruShots API atbildi, pirms pieprasījums tiek uzskatīts par neizdevušos (1–120 sekundes).',
            appSetting: 'Lietotnes iestatījums',
            applicationSettings: 'Lietotnes iestatījumi',
            autoVote: 'Automātiskā balsošana',
            autovoteRunning: 'Automātiskā balsošana darbojas',
            autovoteRunningDesc:
                'Iekšējs — atceras, vai automātiskā balsošana bija ieslēgta, lai pēc lietotnes restarta tā atsāktos pati',
            skipUpdateVersion: 'Izlaistā atjauninājuma versija',
            skipUpdateVersionDesc:
                'Iekšējs — atjauninājuma versija, ko lietotājs izvēlējās izlaist; lietotne nepiedāvās šo versiju, līdz tā tiek notīrīta',
            available: 'Pieejams',
            used: 'Izmantots',
            unavailable: 'Nav pieejams',
            boost: 'Boost',
            boostWindowOpen: 'Boost logs ir atvērts',
            boostOpenBadge: 'Boost atvērts',
            lowExposure: 'Zema redzamība',
            jumpToChallenge: 'Pāriet uz izaicinājumu',
            deadlineTimeline: 'Gaidāmās darbības',
            deadlineTimelineApprox: 'aptuveni — var mainīties, pievienojot bildes',
            deadlineNext: 'Nākamā',
            deadlineDue: 'jau tagad',
            deadlineActionAutoFill: 'Auto-aizpilde',
            deadlineActionBoost: 'Boost',
            deadlineActionTurbo: 'Turbo',
            deadlineActionEmergencyFill: 'Ārkārtas aizpilde',
            boostConflictWarning:
                'Boost nevar izmantot: tavai vienīgajai bildei jau ir Turbo, un abi nevar būt uz vienas bildes. Pievieno otru bildi, lai izmantotu abus.',
            statusHeaderActive: 'aktīvi',
            statusHeaderBoosts: 'Boost gatavi',
            statusHeaderTurbos: 'Turbo gatavi',
            statusHeaderNext: 'Nākamā',
            statusHeaderNotRunning: 'auto-balsošana izslēgta',
            statusHeaderAutoJoin: 'auto-pievienošanās ieslēgta',
            statusHeaderAutoJoinTitle:
                'Auto-pievienošanās darbojas katrā balsošanas ciklā, kamēr auto-balsošana ir ieslēgta. Konfigurē to sadaļā Iestatījumi › Auto-pievienošanās.',
            statusHeaderNextApprox: 'aptuveni — pārrēķina katrā ciklā',
            settingHelpLabel: 'Ko tas nozīmē?',
            boostTime: 'Boost laiks',
            boostTimeDesc:
                'Pielieto Boost, kad paša Boost taimerī ir atlicis šis laiks. Neattiecas uz Boost, kas atvērts ar atslēgu — tam nav taimera, un tas izmanto atsevišķu iestatījumu “Boost laiks (atvērts ar atslēgu)”.',
            boostTimeHelp:
                'Šis ir taimeris, mērīts kā laiks līdz beigām. Iestati 0, lai izslēgtu laika Boost — bots vispār nepielietos taimera Boost. Ņem vērā: šeit 0 nozīmē “izslēgts”, atšķirībā no redzamības mērķa iestatījumiem, kur 0 nozīmē “sekot slieksnim”. Attiecas tikai uz Boost, kam ir savs taimeris; Boost, kas atvērts ar atslēgu, izmanto “Boost laiks (atvērts ar atslēgu)”.',
            keyUnlockedBoostTime: 'Boost laiks (atvērts ar atslēgu)',
            keyUnlockedBoostTimeDesc:
                'Atsevišķs logs Boost, kas atvērts ar atslēgu — tam nav sava taimera. Tā kā tas nebeidzas, to pielieto tikai tad, kad līdz izaicinājuma beigām atlicis šis laiks, lai tas nostrādātu pēc iespējas vēlāk. Iestatījums “Boost laiks” uz šiem neattiecas. 0 = izslēgts.',
            keyUnlockedBoostTimeHelp:
                'Attiecas tikai uz Boost, kas atvērts ar atslēgu (bez sava taimera). Iestati 0, lai to nekad automātiski nepielietotu. Šis ir atsevišķs pulkstenis no “Boost laiks” — tie viens otru neaizvieto. Tāpat kā citos laika iestatījumos, 0 nozīmē “izslēgts”.',
            voteBeforeBoost: 'Uzpildīt redzamību pirms Boost',
            voteBeforeBoostDesc:
                'Īsu brīdi pirms Boost automātiskās pielietošanas nobalso šo izaicinājumu līdz 100% redzamībai, lai Boost nostrādātu uz pilnībā redzama foto, nevis uz tāda, kura redzamība jau sarukusi.',
            voteBeforeBoostHelp:
                'Boost pareizina to, kas foto ir tajā brīdī, kad tas nostrādā, un katram izaicinājumam tas ir tikai viens — tāpēc pielietot to foto ar sarukušu redzamību nozīmē to izšķērdēt. Kad šis ir ieslēgts, bots zemāk norādīto laiku pirms Boost nobalso līdz 100%, un tad Boost tiek pielietots kā parasti. Nepieciešams ieslēgts “Auto-pielietot Boost”, un tas nedarbojas, ja attiecīgais Boost laiks ir 0 (“izslēgts”). Redzamība nesasniedz 100% vienā piegājienā, tāpēc atstāj pietiekami laika vairākiem balsošanas cikliem.',
            voteBeforeBoostOnlyBoostHint:
                'Ieslēgts “Tikai "Boost" režīms”, tāpēc bots nebalso — šī uzpilde nekad nenotiks. Izslēdz to (sadaļā “Vispārīgi”), lai izmantotu šo uzpildi.',
            voteBeforeBoostNoAutoBoostHint:
                'Izslēgts “Auto-pielietot Boost”, tāpēc Boost netiek izmantots automātiski un šai uzpildei nav, kad nostrādāt.',
            voteBeforeBoostLastMinuteOnlyHint:
                'Ieslēgts “Balsot tikai pēdējās minūtēs”, tāpēc bots pirms tam nebalso — šī uzpilde nostrādās tikai tad, ja Boost gadīsies iekrist tajā logā, kur balsošana tik un tā iet līdz 100%.',
            voteBeforeBoostNoBoostTimeHint:
                'Gan “Boost laiks”, gan “Boost laiks (atvērts ar atslēgu)” ir 0 (izslēgts), tāpēc Boost netiek izmantots automātiski un šai uzpildei nav, kad nostrādāt. Iestati vismaz vienu no tiem lielāku par 0.',
            voteBeforeBoostLeadMin: 'Cik laicīgi pirms Boost',
            voteBeforeBoostLeadMinDesc:
                'Cik ilgi pirms Boost pielietošanas sākas uzpilde. Atvēli pietiekami laika vairākām balsošanas kārtām — redzamība nesasniedz 100% vienā piegājienā.',
            autoBoost: 'Auto-pielietot Boost',
            autoBoostDesc: 'Automātiski pielieto Boost šim izaicinājumam, kad tā Boost logs gatavojas aizvērties.',
            turbo: 'Turbo',
            autoTurbo: 'Auto-iegūt Turbo',
            autoTurboDesc: 'Automātiski spēlē Turbo mini-spēli, lai iegūtu bonusu',
            useTurbo: 'Auto-pielietot Turbo',
            useTurboDesc: 'Automātiski pielieto iegūto Turbo vienam no taviem foto',
            turboTime: 'Turbo pielietošanas laiks',
            turboTimeDesc: 'Pielieto Turbo, kad līdz izaicinājuma beigām ir atlicis šis laiks.',
            turboTimeHelp:
                'Laiks līdz beigām, kad iegūtais Turbo tiek pielietots. Iestati 0, lai izslēgtu laika Turbo pielietošanu. Tāpat kā citos laika iestatījumos, 0 šeit nozīmē “izslēgts” — nevis “sekot slieksnim”.',
            turboImageIndex: 'Turbo foto',
            turboImageIndexDesc:
                'Kuram foto pielietot Turbo: 1 = pirmais, 2 = otrais utt. Izmanto 0 priekš pēdējā foto. Ja Boost jau ir uz šī foto, Turbo pāriet uz iepriekšējo bildi (no 1 pāriet uz pēdējo). Piezīme: gan Turbo, gan Boost noklusētā vērtība ir 1, tāpēc, ja abi auto-režīmi ir ieslēgti, viens no tiem pāries uz pēdējo foto.',
            boostImageIndex: 'Boost foto',
            boostImageIndexDesc:
                'Kuram foto pielietot Boost: 1 = pirmais, 2 = otrais utt. Izmanto 0 priekš pēdējā foto. Ja Turbo jau ir uz šī foto, Boost pāriet uz iepriekšējo bildi (no 1 pāriet uz pēdējo). Piezīme: gan Turbo, gan Boost noklusētā vērtība ir 1, tāpēc, ja abi auto-režīmi ir ieslēgti, viens no tiem pāries uz pēdējo foto.',
            boostFillNew: 'Boost jaunam iesniegtam foto',
            boostFillNewDesc:
                'Ja ieslēgts, tieši pirms Boost tiek iesniegts jauns foto (izmantojot tavus automātiskās aizpildes tagu noteikumus) un Boost tiek pielietots šim jaunajam foto, nevis esošajam. Ja nav brīvas vietas vai nav piemērota foto, tas atgriežas pie tava norādītā Boost foto.',
            boostFillNewOnConflict: 'Boost jaunam iesniegtam foto tikai konflikta gadījumā',
            boostFillNewOnConflictDesc:
                'Ja ieslēgts, jauns foto tiek iesniegts un Boost tiek pielietots tikai tad, ja tavam vienīgajam esošajam foto jau ir Turbo (tāpēc Boost nevar tur nokļūt). Parastā gadījumā Boost joprojām nonāk uz tava esošā foto. Ja nav brīvas vietas vai piemērota foto, ko iesniegt, Boost šajā ciklā tiek izlaists — rezerves varianta nav, jo tavam vienīgajam foto jau ir Turbo. Netiek ņemts vērā, ja ieslēgta iepriekšējā opcija, jo tā vienmēr iesniedz jaunu foto.',
            turboApplyWhenBoostActive: 'Pielietot Turbo Boost laikā',
            turboApplyWhenBoostActiveDesc: 'Ja izslēgts, nepielieto Turbo, kamēr šim izaicinājumam ir pieejams Boost',
            turboFillNew: 'Turbo jaunam iesniegtam foto',
            turboFillNewDesc:
                'Ja ieslēgts, tieši pirms Turbo tiek iesniegts jauns foto (izmantojot tavus automātiskās aizpildes tagu noteikumus) un Turbo tiek pielietots šim jaunajam foto, nevis esošajam. Ja nav brīvas vietas vai nav piemērota foto, tas atgriežas pie tava norādītā Turbo foto; ja vēl nav neviena foto, Turbo šajā ciklā tiek izlaists.',
            turboFillNewOnConflict: 'Turbo jaunam iesniegtam foto tikai konflikta gadījumā',
            turboFillNewOnConflictDesc:
                'Ja ieslēgts, jauns foto tiek iesniegts un tam tiek pielietots Turbo tikai tad, ja tavam vienīgajam esošajam foto jau ir Boost (tāpēc Turbo nevar tur nokļūt). Parastā gadījumā Turbo joprojām nonāk uz tava esošā foto. Ja nav brīvas vietas vai piemērota foto, ko iesniegt, Turbo šajā ciklā tiek izlaists — rezerves varianta nav, jo tavam vienīgajam foto jau ir Boost. Netiek ņemts vērā, ja ieslēgta iepriekšējā opcija, jo tā vienmēr iesniedz jaunu foto.',
            playAutoTurbo: 'Spēlēt Turbo mini-spēli, lai iegūtu Turbo',
            autoTurboRunsWithAutovote: 'Automātiskā balsošana jau spēlē Turbo mini-spēli katrā ciklā',
            earnTurbo: 'Iegūt Turbo',
            applyTurboToThisEntry: 'Pielietot tavu Turbo šim foto',
            applyBoostToThisEntry: 'Pielietot tavu Boost šim foto',
            autoFill: 'Aizpildīt trūkstošos foto',
            autoFillDesc:
                'Iesniegt papildu foto, kad izaicinājuma termiņš tuvojas, sekojot zemāk norādītajam grafikam. Aizpilda vienu vietu katrā pārbaudes ciklā.',
            autoFillSchedule: 'Auto-aizpildes grafiks',
            autoFillScheduleDesc:
                'Iestati laiku uz 0h 0m, lai izslēgtu attiecīgo foto. Katra rinda nozīmē: kad līdz beigām atlicis šis laiks, jābūt vismaz šitik foto — "Foto 2 ≤ 48h" iesniedz tavu 2. foto, kad atlikušas 48 stundas. Ja esi atpalicis no grafika (lietotne palaista vēlu vai laiks ir garāks par visu izaicinājumu), tā panāk grafiku, iesniedzot vienu foto katrā ciklā jau no sākuma. Ja izaicinājums atļauj mazāk foto, nekā grafiks aptver, viss grafiks nobīdās uz beigām, lai pēdējā foto laiks attiektos uz izaicinājuma pēdējo foto — piemēram, 2 foto izaicinājumā 2. foto izmanto Foto 4 laiku, bet 3 foto izaicinājumā 2. foto izmanto Foto 3 laiku un 3. foto — Foto 4 laiku.',
            autoFillScheduleShiftHint:
                'Šis izaicinājums atļauj {0} foto — mazāk, nekā grafiks aptver, tāpēc laiki nobīdās uz beigām: pēdējais foto izmanto Foto {1} laiku.',
            autoFillScheduleImage: 'Foto',
            autoFillScheduleOff: 'laiks nav iestatīts — var tikt iesniegts, panākot vēlāku foto',
            autoFillScheduleEmpty: 'Visi foto ir izslēgti — auto-aizpilde neko neiesniegs.',
            autoFillScheduleDominated: 'nekad nedarbosies (vēlākam foto jau ir tāds pats vai garāks laiks)',
            autoFillScheduleOutOfRange: 'laiks nedrīkst pārsniegt 30 dienas',
            settingsSaveError: 'Dažus iestatījumus neizdevās saglabāt — pārbaudi izceltās vērtības un mēģini vēlreiz.',
            unitPercent: '%',
            unitMinutes: 'min',
            unitHours: 'h',
            unitCoins: 'monētas',
            unitVotes: 'balsis',
            unitKeys: 'atslēgas',
            unitSwaps: 'maiņas',
            unitFills: 'uzpildes',
            // Konts (galvenes rādītāji)
            bankrollKeys: 'atslēgas',
            bankrollSwaps: 'maiņas',
            bankrollFills: 'uzpildes',
            bankrollCoins: 'monētas',
            // Valūtas darbības (atslēga / apmaiņa / redzamības papildināšana) izaicinājuma kartītē
            currencyKeyUnlock: 'Atbloķēt',
            currencyKeyUnlockTitle: 'Atbloķēt Boost ar atslēgu?',
            currencyKeyUnlockBody:
                'Tas atbloķē Boost izaicinājumā "{title}". Boost vēl netiek uzlikts nevienai bildei — tu pats izvēlies, kurai bildei to izmantot.',
            currencyFillExposure: 'Uzpildīt redzamību',
            currencyFillExposureTitle: 'Uzpildīt redzamību?',
            currencyFillExposureBody: 'Tas uzreiz paceļ izaicinājuma "{title}" redzamību līdz 100%.',
            currencySwap: 'Apmainīt',
            currencySwapTitle: 'Apmainīt šo bildi?',
            currencySwapBody:
                'Pašreizējā bilde tiek aizstāta ar to, ko lietotne izvēlējās šim izaicinājumam. Aizstāto bildi nevar apmainīt atpakaļ.',
            currencySwapCurrent: 'Pašreizējā bilde',
            currencySwapReplacement: 'Jaunā bilde',
            currencySwapBoostedWarning:
                'Šai bildei ir Boost vai Turbo. Tas paliek pie šīs bildes — jaunajai bildei tā nebūs, un šajā izaicinājumā to vairs nevarēs izmantot, ja vien šo bildi neapmainīsi atpakaļ.',
            currencySwapBack: 'Apmainīt atpakaļ',
            currencySwapBackTitle: 'Apmainīt atpakaļ sākotnējo bildi?',
            currencySwapBackBody: 'Tava sākotnējā bilde atgriežas šajā vietā un atgūst savu {kind}.',
            currencySwapBackOriginal: 'Sākotnējā bilde',
            currencyCost: 'Maksā: 1 {unit}.',
            currencyBalance: 'Tev ir {current} {currency}; pēc tam paliks {resulting}.',
            currencyBalanceUnknown:
                'Neizdevās nolasīt atlikumu ({currency}) — lietotne to pārbaudīs vēlreiz pirms tērēšanas.',
            currencyUnitKeys: 'atslēga',
            currencyUnitSwaps: 'maiņa',
            currencyUnitFills: 'uzpilde',
            currencySpend: 'Tērēt: 1 {unit}',
            // Valūtas darbību rezultāti
            currencyOutcomeNotAvailable:
                'Šobrīd šajā izaicinājumā nav pieejams — iespējams, jau izdarīts. Kartīte atjaunosies.',
            currencyOutcomeNoBalance: 'Šīs valūtas vairs nav, tāpēc nekas netika iztērēts.',
            currencyOutcomeBalanceUnknown:
                'Neizdevās pārbaudīt atlikumu, tāpēc nekas netika iztērēts. Mēģini vēlreiz pēc brīža.',
            currencyOutcomeNoAlternative:
                'Nav citas bildes, ar ko apmainīt — visas derīgās bildes šeit jau izmantotas.',
            currencyOutcomeStaleCandidate:
                'Ieteiktā bilde vairs nav aktuāla. Nospied Apmainīt vēlreiz, lai saņemtu jaunu ieteikumu.',
            currencyOutcomeBusy: 'Vēl notiek cita valūtas darbība — mēģini vēlreiz pēc brīža.',
            currencyOutcomeFailed: 'GuruShots noraidīja pieprasījumu. Mēģini vēlāk; ja atkārtojas, pārbaudi žurnālus.',
            // Automātiskās pievienošanās iestatījumi
            groupAutoJoin: 'Automātiskā pievienošanās',
            autoJoin: 'Automātiski pievienoties izaicinājumiem',
            autoJoinDesc:
                'Katrā balsošanas ciklā automātiski pievienoties atvērtajiem izaicinājumiem (auto-balsošanai jādarbojas). Pēc noklusējuma izslēgts. Kad ieslēgts, pievienojas VISIEM atvērtajiem izaicinājumiem, ja vien nesašaurini ar tipu sarakstiem zemāk; maksas izaicinājumiem nepieciešami monētu limiti zemāk (0 = tikai bezmaksas).',
            autoJoinTypes: 'Tikai šiem tipiem',
            autoJoinTypesDesc:
                'Ar komatu atdalīti izaicinājumu tipi, kuriem pievienoties, piem., "flash,contest". Atstāj TUKŠU, lai pievienotos visiem tipiem (noklusējums). Lielajiem/mazajiem burtiem nav nozīmes.',
            autoJoinExcludeTypes: 'Nekad nepievienoties šiem tipiem',
            autoJoinExcludeTypesDesc:
                'Ar komatu atdalīti izaicinājumu tipi, kuriem nekad automātiski nepievienoties, piem., "flash,exhibition". Tā kā noklusējums ir pievienoties visiem tipiem, šādi iegūst "pievienoties visam, izņemot šos". Izaicinājums, kas atbilst saglabātam nosaukuma profilam, joprojām tiek pievienots — profils ir apzināta izvēle konkrētam nosaukumam.',
            autoJoinChallengeTags: 'Tikai izaicinājumi ar tagiem',
            autoJoinChallengeTagsDesc:
                'Ar komatu atdalīti IZAICINĀJUMA tagi, kuriem pievienoties, piem., "Exhibition,Turbo". Šie ir tagi, ko izaicinājumam piešķir GuruShots (Exhibition, Comm, No comm, Turbo, Magazine, "special 4 pic"), nevis tavu foto tagi. Atstāj TUKŠU, lai atļautu visus. Izaicinājums atbilst, ja tam ir JEBKURŠ tags no saraksta. Lielajiem/mazajiem burtiem nav nozīmes.',
            autoJoinExcludeChallengeTags: 'Nekad izaicinājumi ar tagiem',
            autoJoinExcludeChallengeTagsDesc:
                'Ar komatu atdalīti IZAICINĀJUMA tagi, kuriem nekad automātiski nepievienoties, piem., "Comm". Izslēdz tos no augstāk atlasītajiem — šādi iegūst "pievienoties visam, izņemot šos". Nosaukuma noteikums, kas ieslēdz pievienošanos, joprojām pievienojas — tā ir apzināta izvēle konkrētam nosaukumam.',
            autoJoinWithinHoursOfEnd: 'Pievienoties tikai tuvu beigām',
            autoJoinWithinHoursOfEndDesc:
                'Nogaidīt, līdz izaicinājumam līdz beigām atlicis tik stundu, un tikai tad pievienoties, nevis pievienoties uzreiz, tiklīdz tas parādās. 0 = pievienoties uzreiz.',
            autoJoinWithinHoursOfEndHelp:
                'Izaicinājums ārpus loga netiek izlaists pavisam — tas tiek pārbaudīts katrā ciklā no jauna un pievienots, tiklīdz nonāk logā. Ja izaicinājums nenorāda beigu laiku, tas netiek pievienots pāragri, kamēr logs ir iestatīts.',
            categoryRules: 'Pievienošanās laiks pēc kategorijas',
            categoryRulesDesc:
                'Piešķir veselai izaicinājumu grupai savu pievienošanās laiku, nenosaucot katru nosaukumu. Atlasa pēc izaicinājuma veida, pēc bilžu skaita vai pēc abiem. Šie noteikumi aizstāj globālo laiku augšā, bet nosaukuma noteikums aizstāj tos.',
            categoryRulesSaveError:
                'Šos kategoriju noteikumus neizdevās saglabāt. Pārbaudi, vai divas rindas neatbilst vienai kategorijai un vai visas vērtības ir pieļaujamajā diapazonā.',
            noCategoryRules: 'Vēl nav kategoriju noteikumu. Visi izaicinājumi izmanto globālo laiku augšā.',
            addCategoryRule: 'Pievienot kategorijas noteikumu',
            removeCategoryRule: 'Noņemt kategorijas noteikumu',
            categoryRuleType: 'Izaicinājuma veids',
            categoryRuleTypePlaceholder: 'Jebkurš veids',
            categoryRulePics: 'Bildes',
            categoryRuleAnyPics: 'Jebkāds skaits',
            categoryRulePercentElapsed: 'Pievienoties pēc',
            categoryRuleJoinWindow: 'Vai stundas pirms beigām',
            categoryRuleInheritPlaceholder: 'Noklusējums',
            categoryRuleHint:
                'Atstāj lauku tukšu, lai izmantotu globālo iestatījumu; ievadi 0, lai šai kategorijai to izslēgtu. Ja aizpildīti abi, tiek izmantoti procenti. Bilžu skaits labi norāda garumu: 4 bilžu izaicinājumi parasti ilgst dienu, 2 bilžu — divas dienas, 3 bilžu — trīs.',
            autoJoinAfterPercentElapsed: 'Pievienoties pēc % no izaicinājuma',
            autoJoinAfterPercentElapsedDesc:
                'Nogaidīt, līdz pagājusi šī daļa no izaicinājuma, un tikai tad pievienoties — procentos no tā paša garuma. 75 nozīmē "pievienoties, kad pagājušas trīs ceturtdaļas". 0 = izslēgts.',
            autoJoinAfterPercentElapsedHelp:
                'Izmanto šo fiksētu stundu vietā, kad izaicinājumi ir dažāda garuma: 75% nozīmē 6 stundas pirms beigām 24 stundu izaicinājumam un 5 dienas pirms beigām 3 nedēļu izstādei, ko ar vienu stundu iestatījumu panākt nevar. Kad šis ir virs 0, tas pilnībā aizstāj stundu logu. Izaicinājums, kas nenorāda gan sākuma, gan beigu laiku, netiek pievienots pāragri.',
            autoJoinMaxCoins: 'Maks. monētas par izaicinājumu',
            autoJoinMaxCoinsDesc:
                'Lielākā monētu cena, ko maksāt par pievienošanos vienam izaicinājumam. 0 = tikai bezmaksas. Maksas pievienošanās prasa arī cikla budžetu virs 0.',
            autoJoinCycleCoinBudget: 'Monētu budžets ciklā',
            autoJoinCycleCoinBudgetDesc:
                'Kopējais monētu daudzums, ko automātiskā pievienošanās drīkst tērēt vienā ciklā. 0 = netērēt neko (maksas izslēgta). Gan šim, gan limitam par izaicinājumu jābūt virs 0, lai pievienotos maksas izaicinājumiem.',
            // Atklāšana (nepievienotie izaicinājumi)
            discoverTitle: 'Atrast izaicinājumus',
            discoverCountLabel: 'atvērti izaicinājumi',
            discoverRefresh: 'Atjaunot',
            discoverEmpty: 'Šobrīd nav atvērtu izaicinājumu, kuriem pievienoties.',
            discoverUnavailableList:
                'Neizdevās ielādēt atvērtos izaicinājumus. Pārbaudi savienojumu un mēģini vēlreiz.',
            discoverUntitled: 'Izaicinājums bez nosaukuma',
            discoverCostFree: 'bezmaksas',
            discoverCostPaid: '{coins} monētas',
            discoverJoin: 'Pievienoties',
            discoverJoinPaid: 'Pievienoties (maksas)',
            discoverJoining: 'Pievienojas…',
            discoverRetrySubmit: 'Mēģināt iesniegt vēlreiz',
            discoverConfirmTitle: 'Pievienoties maksas izaicinājumam?',
            discoverConfirmBody: 'Pievienošanās "{title}" maksā {coins} monētas.',
            discoverConfirmBalance: 'Tev ir {current} monētas; tas maksā {cost}, paliks {resulting}.',
            discoverConfirmBalanceUnknown: 'Neizdevās nolasīt tavu pašreizējo monētu atlikumu.',
            discoverConfirmInsufficient:
                'Tev ir {current} monētas; šis izaicinājums maksā {cost} — nepietiek, lai pievienotos.',
            discoverConfirmSpend: 'Tērēt {coins} monētas',
            // Atklāšanas pievienošanās rezultāti
            discoverJoined: 'Pievienojies.',
            discoverUnaffordable: 'Nepietiek monētu, lai pievienotos (nepieciešams {coins}, tev ir {have}).',
            discoverGenericError: 'Neizdevās pievienoties — mēģini vēlreiz.',
            discoverBalanceUnknown: 'Neizdevās nolasīt monētu atlikumu — nav pievienots.',
            discoverChargedPending:
                'Monētas tika norakstītas, bet pievienošanās nepabeidzās. Mēģini iesniegt vēlreiz — atkārtoti netiks norakstīts.',
            discoverFailedNoCharge: 'Neizdevās pievienoties. Monētas netika norakstītas.',
            discoverNoPhoto: 'Nav piemērota foto, ko iesniegt. Monētas netika norakstītas.',
            discoverUnavailable: 'Šis izaicinājums vairs nav pieejams pievienošanās.',
            discoverBusy: 'Pievienošanās jau notiek.',
            validationOutOfRange: 'Ievadi vērtību no {min} līdz {max}.',
            validationAtLeast: 'Ievadi vērtību {min} vai lielāku.',
            autoFillBadge: 'auto-aizpilde',
            customBadge: 'pielāgots',
            customSettingsHint: 'Ir pielāgoti iestatījumi',
            mustIncludeTags: 'Obligātie tagi',
            mustIncludeTagsDesc:
                'Stingrs filtrs gan auto-aizpildei, gan manuālajām aizpildes pogām. Ņemt vērā tikai tos foto, kuru automātiski noteiktie tagi sakrīt ar visiem šiem tagiem. Atstāj tukšu, lai ņemtu vērā visus piemērotos foto. Lielajiem/mazajiem burtiem nav nozīmes, un salīdzina pa veseliem vārdiem: galotnes un daudzskaitlis joprojām sakrīt ("cat" sakrīt ar "cats"), bet tags nesakritīs ar garāku, nesaistītu vārdu ("cat" nesakrīt ar "catamaran"). Vairāku vārdu tagi sakrīt pa vārdiem, tāpēc "sea life" prasa abus. Tagi jāraksta angliski — automātiski noteiktie foto tagi vienmēr ir angļu valodā.',
            shouldIncludeTags: 'Vēlamie tagi',
            shouldIncludeTagsDesc:
                'Vēlamais kritērijs gan auto-aizpildei, gan manuālajai aizpildei. Priekšroku dot foto, kuru tagi sakrīt ar šiem; tie tiek likti augstāk nekā pēc automātiski noteiktajiem izaicinājuma atslēgvārdiem, bet pārējie foto netiek izslēgti. Ja neviens nesakrīt, aizpilde notiek kā parasti. Salīdzināšanai ir tie paši veselo vārdu noteikumi, kas Obligātajiem tagiem.',
            ignoreTitleWords: 'Ignorēt šos vārdus izaicinājumu nosaukumos',
            ignoreTitleWordsDesc:
                'Vārdi, ko izņemt no izaicinājuma nosaukuma, pirms pēc tā meklē piemērotus foto. Izaicinājumu nosaukumos tēmai parasti pieliek kādu papildvārdu — "Epic Lighthouses" ir par bākām, nevis par "epic" — un šie liekie vārdi gan aizmiglo tēmu, gan tērē tās nedaudzās meklēšanas reizes, kas pieejamas vienam izaicinājumam. Saraksts jau ir aizpildīts ar biežākajiem; to var brīvi labot. Izņem vārdu, ja izaicinājums tiešām ir par to. Sēriju sākumi kā "Color Hunt:" tiek atmesti automātiski, tos šeit nav jāraksta.',
            fillWithoutTagMatch: 'Aizpildīt arī bez tagu sakritības',
            fillWithoutTagMatchDesc:
                'Attiecas tikai tad, ja ir iestatīti obligātie tagi. Tā kā foto jāsakrīt ar visiem tagiem, tas notiek biežāk, kad pieprasīti vairāki tagi. Kad ieslēgts (noklusējums), ja neviens no taviem foto nesakrīt ar visiem šiem tagiem, tik un tā tiek pievienots labākais pieejamais foto, lai vieta nepaliek tukša. Kad izslēgts, vieta paliek tukša, līdz parādās foto, kas sakrīt ar visiem tagiem.',
            emergencyFill: 'Ārkārtas aizpilde',
            emergencyFillDesc:
                'Drošības tīkls, kas darbojas izaicinājuma pēdējās minūtēs, kad auto-aizpilde citādi atstātu foto vietas tukšas — vai nu tāpēc, ka auto-aizpilde ir izslēgta, vai tāpēc, ka obligātie tagi nesakrīt ne ar vienu foto un "Aizpildīt arī bez tagu sakritības" ir izslēgts. Kad izaicinājumam līdz beigām atlicis tik daudz laika, atlikušās vietas tiek aizpildītas ar labākajiem pieejamajiem foto, pat ja tie nesakrīt ar taviem tagiem. Tas apzināti ignorē šos iestatījumus, lai izaicinājums nebeigtos ar neizmantotām vietām. Šajā pašā logā tā arī izmanto jebkuru pieejamo Boost un jebkuru iegūto Turbo — pat ja "Auto-pielietot Boost" vai "Auto-pielietot Turbo" izaicinājumam ir izslēgts — lai tie netiktu izniekoti, kad izaicinājums beidzas. Grafiskajā lietotnē ievada kā stundas un minūtes. Noklusējums 5 minūtes; iestati 0, lai izslēgtu (kas izslēdz arī šo pēdējās minūtes Boost/Turbo ignorēšanu). Padoms: turi šo logu ne garāku par pēdējās minūtes slieksni (noklusējums 10 minūtes), lai lietotne bieži pārbauda visu tā laiku.',
            emergencyFillHelp:
                'Pēdējo minūšu drošības tīkls, mērīts kā laiks līdz beigām. Iestati 0, lai to pilnībā izslēgtu (kas izslēdz arī tā pēdējās minūtes Boost/Turbo glābšanu). Šeit 0 nozīmē “izslēgts” — atšķirībā no redzamības mērķa iestatījumiem, kur 0 nozīmē “sekot slieksnim”.',
            tagsPlaceholder: 'piem., saulriets, pludmale, okeāns',
            titleTagRules: 'Noteikumi pēc nosaukuma',
            titleTagRulesDesc:
                'Piešķir profilu un tagus pēc izaicinājuma nosaukuma (lielajiem/mazajiem burtiem nav nozīmes). Darbojas arī tad, ja tas pats izaicinājums atgriežas vēlreiz; manuāliem iestatījumiem ir priekšroka. Tagi tiek apvienoti.',
            titleTagRulesSaveError:
                'Neizdevās saglabāt noteikumus. Pārbaudi profilus, nosaukumu/tagu garumu un pretrunas ar atvērtu izaicinājumu manuālajiem iestatījumiem. Pārējie iestatījumi saglabāti.',
            titleTagRuleTitle: 'Izaicinājuma nosaukums',
            titleTagRuleTitlePlaceholder: "piem., Let's See Hats",
            titleRuleTitlesLabel: 'Izaicinājumu nosaukumi (pietiek ar vienu)',
            addTitleRuleTitle: 'Pievienot nosaukumu',
            removeTitleRuleTitle: 'Noņemt nosaukumu',
            titleRuleMatch: 'Nosaukuma atbilstība',
            titleRuleMatchExact: 'Ir tieši',
            titleRuleMatchStarts: 'Sākas ar',
            titleRuleMatchContains: 'Satur',
            titleRuleChallengeTag: 'Izaicinājuma tags',
            titleRuleChallengeTagPlaceholder: 'piem., Exhibition',
            titleRuleChallengeTagHint:
                'Paša izaicinājuma tags, nevis foto tags. Atstāj nosaukumu tukšu, lai atbilstu tikai pēc taga.',
            titleRuleProfile: 'Automātiskais profils',
            titleRuleInherit: 'Noklusējums',
            titleRuleOn: 'Ieslēgts',
            titleRuleOff: 'Izslēgts',
            titleRuleAutoJoin: 'Automātiski pievienoties šim nosaukumam',
            titleRuleAutoFill: 'Automātiski aizpildīt šo nosaukumu',
            titleRuleJoinWindow: 'Pievienoties, kad līdz beigām atlicis (h)',
            titleRuleJoinWindowPlaceholder: 'noklusējums',
            titleRuleOverridesLabel: 'Iestatījumi šim nosaukumam',
            addTitleTagRule: 'Pievienot noteikumu',
            removeTitleTagRule: 'Noņemt noteikumu',
            noTitleTagRules: 'Vēl nav noteikumu. Pievieno vienu izaicinājuma nosaukumam.',
            usingProfile: 'Izmanto profilu',
            none: '(nav)',
            addOnePhoto: 'Pievienot vienu foto, lai aizpildītu tukšu vietu',
            fillAllPhotos: 'Aizpildīt visas tukšās vietas tagad (bez intervāla)',
            cancel: 'Atcelt',
            challengeDefaults: 'Noklusējuma iestatījumi izaicinājumiem',
            // Keys, Swaps & Fills (currency automation) settings
            groupCurrencyAuto: 'Atslēgas, maiņas un uzpildes',
            autoKeyUnlock: 'Automātiski izmantot atslēgu',
            autoKeyUnlockDesc:
                'Iztērēt atslēgu, lai atbloķētu šī izaicinājuma bloķēto Boost, kad sasniegts zemāk norādītais laiks. Tikai atbloķē — Boost pēc tam uzliek “Auto-pielietot Boost” pie “Boost laiks (atvērts ar atslēgu)”. Iestata izaicinājumam vai profilā; globāla slēdža nav.',
            autoKeyAfterStart: 'Atslēga: pēc laika no sākuma',
            autoKeyAfterStartDesc:
                'Izmantot atslēgu tikai tad, kad izaicinājums ilgst jau tik ilgi (piem., 11 h). 0 = bez nosacījuma.',
            autoKeyBeforeEnd: 'Atslēga: pēdējā laikā līdz beigām',
            autoKeyBeforeEndDesc:
                'Izmantot atslēgu tikai tad, kad līdz beigām atlicis tik vai mazāk (piem., 7 h). 0 = bez nosacījuma.',
            autoKeyAfterPercent: 'Atslēga: pēc % no izaicinājuma',
            autoKeyAfterPercentDesc:
                'Izmantot atslēgu tikai tad, kad pagājusi šī daļa no izaicinājuma. 0 = bez nosacījuma.',
            autoSwap: 'Automātiski apmainīt bildi',
            autoSwapDesc:
                'Iztērēt maiņu, lai kādu no tavām bildēm aizstātu ar piemērotāko bildi no bibliotēkas, kad sasniegts zemāk norādītais laiks. Iestata izaicinājumam vai profilā; globāla slēdža nav.',
            autoSwapAfterStart: 'Maiņa: pēc laika no sākuma',
            autoSwapAfterStartDesc: 'Mainīt tikai tad, kad izaicinājums ilgst jau tik ilgi. 0 = bez nosacījuma.',
            autoSwapBeforeEnd: 'Maiņa: pēdējā laikā līdz beigām',
            autoSwapBeforeEndDesc: 'Mainīt tikai tad, kad līdz beigām atlicis tik vai mazāk. 0 = bez nosacījuma.',
            autoSwapAfterPercent: 'Maiņa: pēc % no izaicinājuma',
            autoSwapAfterPercentDesc: 'Mainīt tikai tad, kad pagājusi šī daļa no izaicinājuma. 0 = bez nosacījuma.',
            autoSwapImageIndex: 'Maināmā bilde',
            autoSwapImageIndexDesc:
                'Kuru bildi aizstāt: 1 = pirmo, 2 = otro utt. 0 = pēdējo. Bildi ar Boost vai Turbo izlaiž un ņem iepriekšējo, ja vien zemāk tas nav atļauts.',
            autoSwapLowestVotes: 'Mainīt bildi ar vismazāk balsīm',
            autoSwapLowestVotesDesc: 'Neņemt vērā “Maināmā bilde” un aizstāt to bildi, kurai ir vismazāk balsu.',
            autoSwapAllowBoosted: 'Atļaut mainīt bildes ar Boost/Turbo',
            autoSwapAllowBoostedDesc:
                'Pēc noklusējuma bildi ar Boost vai Turbo nekad neapmaina — Boost/Turbo paliek pie bildes. Ieslēdz, lai atļautu; kartīte tad piedāvās apmainīt sākotnējo atpakaļ.',
            autoSwapMaxVotes: 'Mainīt tikai zem balsu skaita',
            autoSwapMaxVotesDesc:
                'Mainīt tikai tad, ja izvēlētajai bildei ir mazāk balsu par šo. 0 = bez balsu nosacījuma.',
            autoSwapMax: 'Maks. maiņas šajā izaicinājumā',
            autoSwapMaxDesc:
                'Pārtraukt automātisko maiņu, kad šajā izaicinājumā veikts tik daudz maiņu (manuālās arī skaitās).',
            autoExposureFill: 'Automātiski izmantot uzpildi',
            autoExposureFillDesc:
                'Iztērēt uzpildi, lai paceltu redzamību līdz 100% — bet tikai tad, ja redzamība ir zem zemāk norādītā sliekšņa UN nav pietiekami daudz bilžu, par ko nobalsot, lai to paceltu. Parasti vajag zibens izaicinājumos. Iestata izaicinājumam vai profilā; globāla slēdža nav.',
            autoExposureFillBelow: 'Uzpildīt, ja redzamība zem',
            autoExposureFillBelowDesc: 'Uzpildi tērē tikai tad, ja redzamība ir zem šī un balsojot to sasniegt nevar.',
            autoExposureFillAfterStart: 'Uzpilde: pēc laika no sākuma',
            autoExposureFillAfterStartDesc:
                'Uzpildīt tikai tad, kad izaicinājums ilgst jau tik ilgi. 0 = bez nosacījuma.',
            autoExposureFillBeforeEnd: 'Uzpilde: pēdējā laikā līdz beigām',
            autoExposureFillBeforeEndDesc:
                'Uzpildīt tikai tad, kad līdz beigām atlicis tik vai mazāk. 0 = bez nosacījuma.',
            autoExposureFillAfterPercent: 'Uzpilde: pēc % no izaicinājuma',
            autoExposureFillAfterPercentDesc:
                'Uzpildīt tikai tad, kad pagājusi šī daļa no izaicinājuma. 0 = bez nosacījuma.',
            autoExposureFillMax: 'Maks. automātiskās uzpildes šajā izaicinājumā',
            autoExposureFillMaxDesc:
                'Pārtraukt automātisko uzpildi, kad šim izaicinājumam automātiski iztērēts tik daudz uzpilžu.',
            currencyReserveKeys: 'Paturēt vismaz (atslēgas)',
            currencyReserveKeysDesc:
                'Automātiskā tērēšana nekad nesamazina atslēgas zem šī skaita. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
            currencyReserveSwaps: 'Paturēt vismaz (maiņas)',
            currencyReserveSwapsDesc:
                'Automātiskā tērēšana nekad nesamazina maiņas zem šī skaita. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
            currencyReserveFills: 'Paturēt vismaz (uzpildes)',
            currencyReserveFillsDesc:
                'Automātiskā tērēšana nekad nesamazina uzpildes zem šī skaita. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
            currencyRuleTimingHelp:
                'Katrai darbībai ir trīs neobligāti laika nosacījumi: pēc laika no sākuma, pēdējā laikā līdz beigām un pēc % no izaicinājuma. Visiem iestatītajiem nosacījumiem jāizpildās vienlaikus — piem., “pēc 11 h no sākuma” un “pēdējās 7 h līdz beigām” gaida abus. Atstāj visus uz 0, lai rīkotos, tiklīdz darbība iespējama. Katra darbība vienā ciklā tērē ne vairāk kā vienu reizi, un globālā rezerve vienmēr tiek paturēta.',
            groupGeneral: 'Vispārīgi',
            groupBoost: 'Boost',
            groupTurbo: 'Turbo',
            groupFinalWindow: 'Beigu loga redzamība',
            groupLastMinute: 'Pēdējā minūte',
            groupScheduledFill: 'Plānotā balsošana',
            groupVotingPause: 'Balsošanas pauze',
            groupAutoFill: 'Automātiskā aizpilde',
            groupRewards: 'Balvas',
            groupNotifications: 'Paziņojumi',
            groupDisplay: 'Attēlojums',
            tierCore: 'Pamata',
            tierEntries: 'Bildes',
            tierOverrides: 'Laika noteikumi',
            tierOverridesDesc:
                'Visi pēc noklusējuma izslēgti — ieslēdz kādu tikai tad, ja gribi mainīt, kad darbojas parastais redzamības noteikums.',
            tierApp: 'Lietotne',
            // Paziņojumu iestatījumi (pēc noklusējuma izslēgti)
            autoClaimPrizes: 'Automātiski saņemt balvas',
            autoClaimPrizesDesc:
                'Automātiski saņem balvas no noslēgtajiem izaicinājumiem un izpildītajām misijām (auto-balsošanai jādarbojas). Pārbauda ne biežāk kā reizi stundā. Pēc noklusējuma izslēgts.',
            notifyOnBoost: 'Paziņot pirms Boost',
            notifyOnBoostDesc: 'Brīdina pirms Boost izmantošanas, lai paspētu atstāt lietotni ieslēgtu.',
            notifyOnTurbo: 'Paziņot pirms Turbo',
            notifyOnTurboDesc: 'Brīdina pirms Turbo spēles, lai paspētu atstāt lietotni ieslēgtu.',
            notifyOnAutoFill: 'Paziņot pirms automātiskās aizpildes',
            notifyOnAutoFillDesc:
                'Brīdina pirms bilde tiek automātiski pievienota tuvu beigām, lai paspētu atstāt lietotni ieslēgtu.',
            notifyOnEmergencyFill: 'Paziņot pirms ārkārtas aizpildes',
            notifyOnEmergencyFillDesc:
                'Brīdina pirms pēdējā brīža ārkārtas aizpildes, lai paspētu atstāt lietotni ieslēgtu.',
            notifyLeadTime: 'Brīdināt cik ilgi iepriekš',
            notifyLeadTimeDesc: 'Cik minūtes pirms darbības tiek parādīts brīdinājums.',
            notifyLeadTimeHelp:
                'Ne vienmēr precīzi: lietotne brīdina tikai pārbaudes brīdī, tāpēc, ja šis laiks ir garāks par pārbaudes biežumu, brīdinājums var pienākt vēlāk. Visdrošāk tas darbojas pēdējās minūtes logā.',
            // Paziņojuma virsraksta/teksta veidnes. {action} izmanto darbību
            // nosaukumus; {title} ir izaicinājuma nosaukums; {minutes}/{count}
            // aizpilda paziņojumu slānis.
            notifyTitle: 'Tuvojas {action}',
            notifyBody: '{action} izaicinājumam "{title}" pēc ~{minutes} min — atstāj lietotni atvērtu līdz tam.',
            notifyGroupTitle: 'Tuvojas darbības',
            notifyGroupBody: '{count} darbības nākamajās ~{minutes} min — atstāj lietotni atvērtu līdz tam.',
            challengeName: 'Izaicinājums',
            challengeOverrides: 'Atsevišķu izaicinājumu iestatījumi',
            challengeSettings: 'Izaicinājuma iestatījumi',
            challengeSettingsDesc: 'Iestatījumi tikai šim izaicinājumam. Tie aizstāj globālos noklusējumus.',
            checkForUpdates: 'Pārbaudīt atjauninājumus',
            checkForUpdatesDesc: 'Pārbaudīt jaunāku versiju tagad, negaidot automātisko pārbaudi.',
            compactCards: 'Kompaktas kartītes',
            compactCardsDesc:
                'Rādīt izaicinājumus kā mazākas kartītes, lai ekrānā ietilpst vairāk; izslēdz, lai redzētu pilna izmēra kartītes ar vairāk detaļām.',
            compact: 'Kompakts',
            details: 'Detaļas',
            configureBoost: 'Konfigurēt "Boost" izaicinājumam:',
            currentVersion: 'Pašreizējā versija',
            cycles: 'Cikli:',
            downloadUpdate: 'Lejupielādēt atjauninājumu',
            ends: 'Beidzas',
            english: 'English',
            entries: 'Bildes',
            entryDetails: 'Bildes informācija',
            entryPhoto: 'Iesniegtā bilde',
            viewEntryPhoto: 'Skatīt iesniegto bildi',
            error: 'Kļūda',
            errorCheckingUpdates: 'Kļūda pārbaudot atjauninājumus',
            errorLoadingUiSettings: 'Kļūda UI iestatījumu ielādē',
            exposure: 'Redzamība',
            exposureDesc:
                'Redzamības procents, zem kura bots turpina balsot par izaicinājumu. Noklusējums 100 nozīmē balsot līdz pilnai redzamībai.',
            exposureTarget: 'Redzamības mērķis',
            exposureTargetDesc:
                'Balsot līdz šim procentam, kad nostrādā parastais redzamības noteikums (0 = tāds pats kā redzamības slieksnis)',
            exposureTargetHelp:
                '0 NENOZĪMĒ izslēgts. 0 nozīmē “balsot līdz redzamības sliekšņa vērtībai” — noteikums paliek aktīvs. Ievadi 1-100 tikai tad, ja gribi balsot tālāk par slieksni līdz šai redzamībai. Pretstatā laika iestatījumiem, piemēram, “Boost laiks”, kur 0 nozīmē, ka funkcija ir izslēgta.',
            fast: 'ĀTRS',
            global: 'Globāls',
            globalDefault: 'Globālais noklusējums',
            globalSettings: 'Globālie iestatījumi',
            hours: 'stunda(s)',
            language: 'Valoda',
            languageDesc: 'Lietotnes saskarnes valoda (angļu vai latviešu).',
            lastMinuteThreshold: 'Pēdējās minūtes slieksnis',
            lastMinuteThresholdDesc:
                'Kad izaicinājumam līdz beigām atlicis šis minūšu skaits, bots balso uzreiz līdz 100%, ignorējot redzamības sliekšņus. Šajā logā darbojas opcija "Balsot tikai pēdējās minūtes laikā", un pārbaudes notiek ar "Pēdējās minūtes pārbaudes biežums" intervālu.',
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
            noOverrides: 'Nevienam izaicinājumam nav atsevišķu iestatījumu',
            noUiSettingsToDisplay: 'Nav saskarnes iestatījumu, ko attēlot',
            noUpdatesAvailable: 'Nav pieejamu atjauninājumu',
            normal: 'NORMĀLS',
            of: 'no',
            onePhoto: '1 bilde',
            onlyBoost: 'Tikai "Boost" režīms',
            onlyBoostDesc: 'Pilnībā izlaist parasto balsošanu šim izaicinājumam un tikai pielietot Boost.',
            voteOnNewEntry: 'Balsot par jaunu bildi',
            voteOnNewEntryDesc:
                'Kad šajā izaicinājumā parādās jauna bilde — pievienota pašā GuruShots vai ar automātisko aizpildi, ārkārtas aizpildi vai Boost/Turbo aizpildi — nobalsot vienu reizi arī tad, ja redzamība jau ir sasniegusi vai pārsniegusi slieksni. Balso līdz tiem griestiem, ko izaicinājums izmantotu parasti: Redzamības mērķis (vai Redzamība, ja mērķis ir 0), vai Beigu loga redzamības mērķis beigu loga laikā, kad ieslēgts "Izmantot beigu loga redzamību". Tas neapiet iestatījumus Tikai "Boost" režīms, Balsot tikai pēdējās minūtes laikā un Tikai plānotā balsošana: ja kāds no tiem to aizliedz, balsojums nenotiek.',
            override: 'Pielāgots',
            overrideForChallenge: 'Pielāgot iestatījumus izaicinājumam',
            photo: 'bilde',
            photos: 'bildes',
            noActiveChallenges: 'Nav aktīvu izaicinājumu',
            players: 'Spēlētāji',
            pleaseLogin: 'Piesakies, lai redzētu izaicinājumus',
            prerelease: 'Testa (beta) versija',
            prize: 'Balva',
            rank: 'Vieta',
            rememberLoginSession: 'Atcerēties pieteikšanās sesiju',
            remindMeLater: 'Atgādināt vēlāk',
            removeCurrentTimezone: 'Noņemt pašreizējo laika joslu',
            resetToGlobal: 'Atiestatīt uz globālajiem',
            resetToDefault: 'Atiestatīt uz noklusējumu',
            resetToDefaultNotSaved: "Atiestatīt uz noklusējumu (netiks saglabāts, kamēr nenospiedīsi 'Saglabāt')",
            resetAll: 'Atiestatīt visu',
            resetAllConfirmTitle: 'Atiestatīt visus iestatījumus',
            resetAllConfirmMessage: 'Vai tiešām atiestatīt VISUS iestatījumus uz noklusējumu?',
            resetAllConfirmDetails:
                'Šī darbība atiestatīs:\\n• Visus saskarnes iestatījumus (tēmu, valodu, laika joslu)\\n• Visus globālos noklusējuma iestatījumus izaicinājumiem\\n• Lietotnes preferences\\n• Logu pozīcijas un izmērus\\n• Pielāgotās laika joslas\\n• Lietotājvārda un pieteikšanās sesijas preferences\\n\\nPaliks tikai tava pieteikšanās (tokens un savienojuma dati), pēdējās atjauninājumu pārbaudes laiks un testa režīma iestatījums.\\n\\nŠo darbību nevar atsaukt.',
            resetAllSuccess: 'Visi iestatījumi ir atiestatīti. Lapa tiks pārlādēta, lai piemērotu izmaiņas.',
            save: 'Saglabāt',
            scrollToTop: 'Uz augšu',
            seconds: 'sekunde(s)',
            settings: 'Iestatījumi',
            skipThisVersion: 'Izlaist šo versiju',
            speed: 'Ātrums',
            startAutoVote: 'Sākt automātisko balsošanu',
            stayLoggedIn: 'Saglabāt pieteikšanos',
            stayLoggedInDesc: 'Saglabāt sesiju, lai pēc lietotnes aizvēršanas paliktu pieteicies.',
            stopAutoVote: 'Apturēt automātisko balsošanu',
            theme: 'Tēma',
            themeDesc: 'Pārslēdz lietotni starp gaišo un tumšo izskatu.',
            time: 'Laiks',
            timezone: 'Laika josla',
            timezoneDesc: 'Laika josla, ko izmanto, lai rādītu izaicinājumu sākuma un beigu laikus tavā vietējā laikā.',
            timezonePlaceholder: 'Ievadi laika joslu',
            uiSetting: 'Saskarnes iestatījums',
            updateAvailable: 'Pieejams atjauninājums!',
            run: 'Palaist',
            running: 'Darbojas...',
            vote: 'Balsot',
            voteTitle: 'Balsot par šo izaicinājumu līdz 100% tagad (apiet automātiku; bots turpina darboties)',
            voteAll: 'Balsot visus',
            voteToNextLevel: 'balsis līdz nākamajam līmenim',
            voted: 'Nobalsots!',
            votedAll: 'Visi nobalsoti!',
            votes: 'Balsis',
            votesNeeded: 'balsis nepieciešamas',
            voting: 'Balso...',
            votingAll: 'Balso...',
            checkFrequency: 'Pārbaudes biežums',
            checkFrequencyDesc:
                'Katrs cikls izmanto nejaušu pauzi šajā diapazonā. Vienāds min un max nozīmē fiksētu biežumu.',
            checkFrequencyMin: 'Min',
            checkFrequencyMax: 'Max',
            reliability: 'Uzticamība',
            apiMaxRetries: 'Atkārtoti mēģinājumi',
            apiMaxRetriesDesc:
                'Cik reizes mēģināt vēlreiz, ja pieprasījums uz GuruShots neizdodas (0 = nemēģināt). Attiecas uz īslaicīgām tīkla kļūdām, pārāk ilgu gaidīšanu, pārāk daudz pieprasījumu (429) un servera kļūdām (5xx). “Pauze starp mēģinājumiem” ir sākuma pauze milisekundēs, kas ar katru mēģinājumu aptuveni dubultojas.',
            apiRetryBaseDelayMs: 'Pauze starp mēģinājumiem (ms)',
            voteOnlyInLastMinute: 'Balsot tikai pēdējās minūtes laikā',
            voteOnlyInLastMinuteDesc:
                'Pilnībā izlaist izaicinājumu, līdz tas sasniedz pēdējās minūtes sliekšņa logu, tad balsot līdz 100%. Tā balsošana notiek tikai pašās beigās, nevis visa izaicinājuma laikā.',
            lastMinuteCheckFrequency: 'Pēdējās minūtes pārbaudes biežums',
            lastMinuteCheckFrequencyDesc:
                'Cik bieži (minūtēs) pārbaudīt izaicinājumu, kad tas ir pēdējās minūtes sliekšņa robežās. Noklusējums 1 pārbauda katru minūti, lai nepalaistu garām beigu grūdienu.',
            useScheduledFill: 'Izmantot plānoto balsošanu',
            useScheduledFillDesc:
                'Balsot līdz 100% redzamībai izvēlētos laikos, nevis tikai tad, kad tā nokrītas zem Redzamības sliekšņa. Tas plāno tikai balsošanu — foto netiek iesniegts (to dara Automātiskā aizpilde). Laikus var norādīt divos veidos, un tos var apvienot: ikdienas “Balsošanas laiki” un vienreizēji intervāli “Balsošana pirms beigām”. Katrs laiks atver savu neatkarīgu balsošanas logu — piem., intervāli 10h un 4h pirms beigām balso divreiz noslēguma dienā. Loga laikā izaicinājums tiek balsots līdz 100% un tur noturēts; laiki tiek interpretēti lietotnes Laika joslas iestatījumā (nevis šīs ierīces pulkstenī). Nedarbojas, kamēr nav iestatīts vismaz viens laiks zemāk, un nekad neattiecas uz Flash izaicinājumiem vai izaicinājumiem režīmā "Tikai Boost". Ja lietotne nedarbojas visa loga laikā, šis logs tiek izlaists un vēlāk netiek atkārtots.',
            scheduledFillTime: 'Balsošanas laiki',
            scheduledFillTimeDesc:
                'Ikdienas pulksteņa laiki (24h), kuros atveras balsošanas logi, lietotnes Laika joslas iestatījumā — nevis šīs ierīces pulkstenī. Katrs laiks katru dienu atver savu logu; noņem visas rindas, lai šos laikus izslēgtu. Ap vasaras/ziemas laika maiņu faktiskais brīdis maiņas dienā var nobīdīties līdz pat stundai.',
            scheduledFillTimeOff: 'laiki nav iestatīti — izslēgts',
            scheduledFillBeforeEnd: 'Balsošana pirms beigām',
            scheduledFillBeforeEndDesc:
                'Atvērt vienreizējus balsošanas logus tik ilgi pirms izaicinājuma beigām — piem., 10h 0m un 4h 0m, lai balsotu divreiz noslēguma dienā. Ievada stundās un minūtēs; noņem visas rindas, lai šos intervālus izslēgtu. Tie skaitās no katra izaicinājuma beigām — pārbaudi tos vēlreiz, ja lieto saglabātu profilu izaicinājumam ar citu garumu.',
            scheduledFillBeforeEndOff: 'intervāli nav iestatīti — izslēgts',
            scheduledFillAddTime: 'Pievienot laiku',
            scheduledFillAddBeforeEnd: 'Pievienot intervālu',
            scheduledFillRemoveEntry: 'Noņemt rindu',
            scheduledFillEntryDraft: 'iestati laiku — rindas ar 0h 0m netiek saglabātas',
            scheduledFillDuplicateEntry: 'atkārtojas — šī rinda tiek ignorēta',
            scheduledFillMaxEntries: 'Sasniegts maksimums — {0} rindas.',
            scheduledFillSourceBeforeEnd: '{0} pirms beigām',
            scheduledFillWindowMinutes: 'Balsošanas logs (minūtes)',
            scheduledFillWindowMinutesDesc:
                'Cik ilgi katrs balsošanas logs paliek atvērts pēc sava sākuma laika. Loga laikā izaicinājums tiek uzpildīts līdz 100% un tur noturēts; pēc tā aizvēršanās atkal darbojas parastie noteikumi. Iestati to garāku par Pārbaudes biežumu, lai balsošanas cikls garantēti trāpītu logā.',
            scheduledFillReplaces: 'Tikai plānotā balsošana',
            scheduledFillReplacesDesc:
                'Kad ieslēgts, parastā un beigu loga redzamības balsošana ārpus plānotajiem balsošanas logiem tiek bloķēta — plānotie laiki kļūst par vienīgo automātisko balsošanu. Flash izaicinājumi un Pēdējās minūtes noteikumi joprojām balso kā parasti, manuālā balsošana netiek ietekmēta, un iestatījumam "Balsot tikai pēdējās minūtes laikā" ir priekšroka pār šo. Brīdinājums: ja lietotne nedarbojas visa loga laikā, šis logs tiek izlaists, vēlāk netiek atkārtots un parastais slieksnis to neaizstāj, tāpēc izaicinājums var noslēgties ar nepilnīgu redzamību.',
            scheduledFillNextHint: 'Nākamais balsošanas logs: {0}–{1} ({2}) — no {3}',
            scheduledFillNoTimesHint:
                'Nav iestatīts balsošanas laiks — plānotā balsošana nedarbojas, kamēr nav iestatīts kāds zemāk.',
            scheduledFillWastedWindowHint:
                'Logi intervāliem {0} sniedzas pāri izaicinājuma termiņam — izmantojama ir tikai daļa pirms beigām.',
            scheduledFillShortWindowHint:
                'Šis logs ir īsāks par tavu maksimālo Pārbaudes biežumu ({0} min) — vesels logs var iekrist starp balsošanas cikliem, kamēr lietotne darbojas bez uzraudzības.',
            scheduledFillUnreachableHint:
                '"Tikai plānotā balsošana" ir ieslēgta, bet pirms šī izaicinājuma beigām vairs nevar notikt neviens balsošanas logs — parastā un beigu loga balsošana paliek bloķēta, tāpēc balsos tikai Pēdējās minūtes noteikumi.',
            scheduledFillProfileReplacesWarning:
                'Šī profila piemērošana ieslēgs "Tikai plānotā balsošana" šim izaicinājumam — pārskati balsošanas laikus pirms saglabāšanas.',
            useVotingPause: 'Balsošanas pauze',
            useVotingPauseDesc:
                'Apturēt automātisko balsošanu izvēlētajos logos — domāts nakts pārtraukumam starp kārtām, kad pilna redzamība savāc ļoti maz balsu un tās pašas balsis labāk iztērēt, kad sākas nākamā kārta. Laikus var norādīt divos veidos, un tos var apvienot: ikdienas “Pauzes laiki” un vienreizēji intervāli “Pauze pirms beigām”. Katrs laiks sāk savu pauzi, kas ilgst zemāk norādīto Pauzes ilgumu; laiki tiek interpretēti lietotnes Laika joslas iestatījumā (nevis šīs ierīces pulkstenī). Nedarbojas, kamēr nav iestatīts vismaz viens laiks zemāk. Flash izaicinājumi un Pēdējās minūtes noteikumi joprojām balso, tāpēc izaicinājums, kas patiešām beidzas pauzes laikā, netiek pamests, un Boost un Turbo joprojām tiek pielietoti pēc saviem taimeriem. Manuālā balsošana nekad netiek bloķēta.',
            votingPauseTime: 'Pauzes laiki',
            votingPauseTimeDesc:
                'Ikdienas pulksteņa laiki (24h), kuros sākas pauze, lietotnes Laika joslas iestatījumā — nevis šīs ierīces pulkstenī. Katrs laiks katru dienu sāk savu pauzi; noņem visas rindas, lai šos laikus izslēgtu. Nakts pauzei no 01:30 līdz 06:00 iestati šeit 01:30 un Pauzes ilgumu 270 minūtes. Ap vasaras/ziemas laika maiņu faktiskais brīdis maiņas dienā var nobīdīties līdz pat stundai.',
            votingPauseBeforeEnd: 'Pauze pirms beigām',
            votingPauseBeforeEndDesc:
                'Sākt vienreizēju pauzi tik ilgi pirms izaicinājuma beigām. Ievada stundās un minūtēs; noņem visas rindas, lai šos intervālus izslēgtu. Tie skaitās no katra izaicinājuma beigām — pārbaudi tos vēlreiz, ja lieto saglabātu profilu izaicinājumam ar citu garumu. Pauze, kas sniedzas pāri termiņam, tāpat padodas Pēdējās minūtes noteikumiem, kuri balso vienmēr.',
            votingPauseDurationMinutes: 'Pauzes ilgums (minūtes)',
            votingPauseDurationMinutesDesc:
                'Cik ilgi katra pauze turpinās no sava sākuma laika. Kad tā beidzas, atkal darbojas parastie noteikumi un redzamība tiek uzpildīta nākamajā balsošanas ciklā. Piemērs: 270 minūtes, sākot 01:30, notur pauzi līdz 06:00.',
            votingPauseNextHint: 'Nākamā pauze: {0}–{1} ({2}) — no {3}',
            votingPauseActiveHint:
                'Pauze ir aktīva līdz {0} ({1}) — balsos tikai Pēdējās minūtes un Flash noteikumi. Boost un Turbo joprojām tiek pielietoti pēc saviem taimeriem.',
            votingPauseShortWindowHint:
                'Šī pauze ir īsāka par tavu maksimālo Pārbaudes biežumu ({0} min) — balsošanas cikls to var pilnībā pārlēkt, un balsošana turpināsies tā, it kā pauze nebūtu iestatīta.',
            votingPauseNoTimesHint:
                'Nav iestatīts pauzes laiks — balsošanas pauze nedarbojas, kamēr nav iestatīts kāds zemāk.',
            votingPauseAllDayHint:
                'Šīs pauzes aizņem visu diennakti — ārpus Pēdējās minūtes noteikumiem šis izaicinājums nekad automātiski nebalsotu.',
            finalWindowDuration: 'Beigu loga ilgums',
            finalWindowDurationDesc:
                'Cik ilgs ir beigu logs pirms izaicinājuma beigām. Beigu loga redzamības noteikums darbojas šajā logā. Pēc noklusējuma 1 stunda.',
            finalWindowDurationHelp:
                'Beigu loga garums, skaitot atpakaļ no izaicinājuma beigu laika. Iestati 1 stundu, lai viss darbotos kā agrāk (fiksēta pēdējā stunda), vai saīsini/pagarini to, lai mainītu, kad pārņem Beigu loga redzamības slieksnis un mērķis.',
            finalWindowExposure: 'Beigu loga redzamība',
            finalWindowExposureDesc:
                'Redzamības līmenis, kas iedarbina balsošanu beigu logā (tikai kad ieslēgts "Izmantot beigu loga redzamību"). Jābūt vienādam vai mazākam par Redzamības iestatījumu.',
            finalWindowExposureTarget: 'Beigu loga redzamības mērķis',
            finalWindowExposureTargetDesc:
                'Balsot līdz šim procentam, kad nostrādā beigu loga noteikums (0 = tāds pats kā beigu loga slieksnis)',
            finalWindowExposureTargetHelp:
                '0 NENOZĪMĒ izslēgts. 0 nozīmē “balsot līdz beigu loga redzamības slieksnim” — beigu loga noteikums paliek aktīvs. Ievadi 1-100, lai balsotu tālāk par šo slieksni. Pretstatā laika iestatījumiem, kur 0 nozīmē izslēgts.',
            useFinalWindowExposure: 'Izmantot beigu loga redzamību',
            useFinalWindowExposureDesc:
                'Beigu logā pirms izaicinājuma beigām izmantot atsevišķo beigu loga redzamības slieksni un mērķi parastā redzamības iestatījuma vietā.',
            voteBeforeFinalWindow: 'Balsot pirms beigu loga',
            voteBeforeFinalWindowDesc:
                'Ap beigu loga sākumu balsot līdz parastajam redzamības mērķim, lai izaicinājums, kura redzamība jau nokritusies zem tā, netiktu atstāts zemā līmenī beigu loga zemākā sliekšņa dēļ. Papildināšana paliek aktīva logā, kas aptver beigu loga robežu — nobīdes minūtes pirms tās un tikpat daudz minūšu pēc tās — un tad pārņem beigu loga redzamības noteikums. Darbojas tikai tad, kad ieslēgts "Izmantot beigu loga redzamību".',
            voteBeforeFinalWindowLeadMin: 'Cik laicīgi pirms beigu loga',
            voteBeforeFinalWindowLeadMinDesc:
                'Cik minūtes ap beigu loga sākumu papildināšana paliek aktīva. Logs atveras tik daudz minūšu pirms beigu loga un aizveras tikpat daudz minūšu pēc tā sākuma, pēc kā pārņem beigu loga redzamības noteikums.',
            validationInvalidValue: 'Nepareiza vērtība',
            validationMustBeLessOrEqual: 'Jābūt ≤ {0} (pašlaik {1})',
            whatsNew: 'Kas jauns:',
            yourEntries: 'Tavas bildes',
            yourProgress: 'Tavs progress',
            // Additional keys for React components
            refresh: 'Atjaunot',
            challengeOverrideInfo:
                'Šeit konfigurētie iestatījumi aizstās globālos noklusējumus tikai šim izaicinājumam.',
            mockMode: 'Testa režīms',
            logout: 'Iziet',
            status: 'Statuss',
            title: 'GuruShots Auto Vote',
            downloadingUpdate: 'Lejupielādē atjauninājumu...',
            updateReady: 'Atjauninājums gatavs',
            updateError: 'Atjaunināšanas kļūda',
            releaseNotes: 'Laidiena piezīmes',
            updateReadyToInstall:
                'Atjauninājums lejupielādēts un gatavs instalēšanai. Restartē lietotni, lai to uzstādītu.',
            skipVersion: 'Izlaist versiju',
            remindLater: 'Atgādināt vēlāk',
            download: 'Lejupielādēt',
            restartLater: 'Restartēt vēlāk',
            restartNow: 'Restartēt tagad',
            close: 'Aizvērt',
            downloadInBrowser: 'Lejupielādēt pārlūkā',
            overridden: 'Pielāgots',
            usingGlobal: 'Izmanto globālo',
            overridesActiveSummary: 'Manuāli pielāgoti: {0}; pārējie izmanto profila vai globālos iestatījumus.',
            overridesNoneSummary: 'Nav manuālu pielāgojumu; izmanto profila vai globālos iestatījumus.',
            enableOverride: 'Iespējot pielāgošanu šim izaicinājumam',
            clearAll: 'Notīrīt visu',
            notApplicable: 'Nav piemērojams',
            notApplicableHint: 'Tavas saglabātās vērtības netiek dzēstas.',
            naBoostUsed: 'Boost šim izaicinājumam jau izmantots — šie iestatījumi nedarbosies.',
            naTurboUsed: 'Turbo šim izaicinājumam jau izmantots — šie iestatījumi nedarbosies.',
            naSlotsFull: 'Visas bilžu vietas ir aizpildītas — automātiskajai aizpildei nav ko pievienot.',
            naFlashNoBoost: 'Flash izaicinājumi neatbalsta Boost.',
            naFlashNoScheduledFill: 'Flash izaicinājumi vienmēr balso līdz 100% — plānotā balsošana nekad nedarbojas.',
            naFlashNoVotingPause: 'Flash izaicinājumi vienmēr balso līdz 100% — balsošanas pauze nekad nedarbojas.',
            naFlashNoTurbo: 'Flash izaicinājumi neatbalsta Turbo.',
            naExhibitionNoTurbo: 'Izstādes izaicinājumi neatbalsta Turbo.',
            naBoostSinglePhoto: 'Viena foto izaicinājumi nekad neatbloķē Boost — šie iestatījumi nedarbosies.',
            challengeProfiles: 'Profili',
            applyProfile: 'Pielietot',
            deleteProfile: 'Dzēst',
            confirmDelete: 'Apstiprināt dzēšanu?',
            confirmOverwrite: 'Pārrakstīt?',
            saveAsProfile: 'Saglabāt pašreizējo kā profilu',
            profileNamePlaceholder: 'Profila nosaukums (piem., "2 bilžu taktika")',
            noProfiles: 'Nav saglabātu profilu',
            profileSaveError: 'Neizdevās saglabāt profilu — kāda vērtība nav derīga.',
            profileNameRequired: 'Vispirms ievadi profila nosaukumu.',
            profileNameTooLong: 'Profila nosaukums ir par garu (maks. {0} rakstzīmes).',
            profileLimitReached: 'Sasniegts profilu limits ({0}) — vispirms izdzēs kādu.',
            profileAppliedHint: 'Profils ielikts — pārskati vērtības zemāk un nospied Saglabāt.',
            profileApplyHint:
                'Profila pielietošana aizstāj pašreizējās formas vērtības (arī nesaglabātās izmaiņas); iestatījumi, kas profilā nav iekļauti, atgriežas uz "Izmanto globālo".',
            profileOverwriteHint: 'Saglabājot ar esošu nosaukumu, tas tiek pārrakstīts.',
            intentBuiltIn: 'Iebūvēta sagatave',
            intentModified: 'Rediģēta sagatave',
            intentJustParticipate: 'Vienkārši piedalīties',
            intentJustParticipateDesc:
                'Uztur visas bilžu vietas aizpildītas, bet nekad netērē Boost vai Turbo un nedzenas pēc redzamības tālāk par slieksni — maz pūļu, maz riska.',
            intentFinishStrong: 'Spēcīgs finišs',
            intentFinishStrongDesc:
                'Lielāko izaicinājuma daļu spēlē normāli, tad beigu logā izmanto Boost un Turbo un spēcīgi palielina redzamību.',
            intentMaxExposure: 'Maksimāla redzamība',
            intentMaxExposureDesc:
                'Visu laiku uz pilnu jaudu: balso līdz pilnai redzamībai, aizpilda bilžu vietas un izmanto Boost un Turbo.',
        },
        // Logs page specific
        logs: {
            title: 'Žurnāli',
            status: 'Statuss',
            empty: 'Vēl nav žurnāla ierakstu.',
            connected: 'Savienots',
            disconnected: 'Nav savienots',
        },
    };
});
