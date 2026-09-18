// Latvian translations for GuruShots Auto Vote
/* global window, self */
(function (root, factory) {
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
            noUpdatesMessage: 'Jūs izmantojat jaunāko versiju.',
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
            passwordPlaceholder: 'Ievadiet savu paroli',
            passwordRequired: 'Parole ir obligāta',
            productionModeInfo:
                'Produkcijas režīms: Tiek izmantots īstais GuruShots API. Nepieciešami derīgi pieejas dati.',
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
            apiTimeoutDesc:
                'Cik ilgi gaidīt GuruShots API atbildi, pirms pieprasījums tiek uzskatīts par neizdevušos (1–120 sekundes).',
            appSetting: 'Lietotnes iestatījums',
            applicationSettings: 'Lietotnes iestatījumi',
            autoVote: 'Automātiskā balsošana',
            autovoteRunning: 'Automātiskā balsošana darbojas',
            autovoteRunningDesc:
                'Iekšējs karogs — saglabā automātiskās balsošanas stāvokli starp lietotnes restartiem, lai balsošana varētu atsākties automātiski',
            skipUpdateVersion: 'Izlaistā atjauninājuma versija',
            skipUpdateVersionDesc:
                'Iekšējs — atjauninājuma versija, ko lietotājs izvēlējās izlaist; lietotne nepiedāvās šo versiju, līdz tā tiek notīrīta',
            available: 'Pieejams',
            used: 'Izmantots',
            unavailable: 'Nav pieejams',
            boost: 'Boost',
            boostWindowOpen: 'Boost logs ir atvērts',
            jumpToChallenge: 'Pāriet uz izaicinājumu',
            deadlineTimeline: 'Gaidāmās darbības',
            deadlineTimelineApprox: 'aptuveni — var mainīties, aizpildoties dalībām',
            deadlineNext: 'Nākamā',
            deadlineDue: 'jau tagad',
            deadlineActionAutoFill: 'Auto-aizpilde',
            deadlineActionBoost: 'Boost',
            deadlineActionTurbo: 'Turbo',
            deadlineActionEmergencyFill: 'Ārkārtas aizpilde',
            boostConflictWarning:
                'Boost nevar pielietot: tavai vienīgajai dalībai jau ir Turbo (tie nevar dalīt vienu dalību). Pievieno otru dalību, lai izmantotu abus.',
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
                'Boost pareizina to, kas foto ir tajā brīdī, kad tas nostrādā, un katram izaicinājumam tas ir tikai viens — tāpēc pielietot to foto ar sarukušu redzamību nozīmē to izšķērdēt. Kad šis ir ieslēgts, bots zemāk norādītajā nobīdē nobalso līdz 100%, un tad Boost tiek pielietots kā parasti. Nepieciešams ieslēgts “Auto-pielietot Boost”, un tas nedarbojas, ja attiecīgais Boost laiks ir 0 (“izslēgts”). Redzamība nesasniedz 100% vienā piegājienā, tāpēc atstāj nobīdi, kas pietiek vairākiem balsošanas cikliem.',
            voteBeforeBoostOnlyBoostHint:
                'Ieslēgts “Tikai "Boost" režīms”, tāpēc bots nebalso — šī uzpilde nekad nenotiks. Izslēdz to (sadaļā “Vispārīgi”), lai izmantotu šo uzpildi.',
            voteBeforeBoostNoAutoBoostHint:
                'Izslēgts “Auto-pielietot Boost”, tāpēc neviens Boost netiek pielietots automātiski un nav, pirms kā uzpildīt.',
            voteBeforeBoostLastMinuteOnlyHint:
                'Ieslēgts “Balsot tikai pēdējās minūtēs”, tāpēc bots pirms tam nebalso — šī uzpilde nostrādās tikai tad, ja Boost gadīsies iekrist tajā logā, kur balsošana tik un tā iet līdz 100%.',
            voteBeforeBoostNoBoostTimeHint:
                'Gan “Boost laiks”, gan “Boost laiks (atvērts ar atslēgu)” ir 0 (izslēgts), tāpēc neviens Boost netiek pielietots automātiski un nav brīža, pirms kā uzpildīt. Iestati vismaz vienu no tiem lielāku par 0.',
            voteBeforeBoostLeadMin: 'Nobīde pirms Boost',
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
                'Ja ieslēgts, jauns foto tiek iesniegts un Boost tiek pielietots tikai tad, ja tavam vienīgajam esošajam foto jau ir Turbo (tāpēc Boost nevar tur nokļūt). Parastā gadījumā Boost joprojām nonāk uz tava esošā foto. Ja nav brīvas vietas vai piemērota foto, ko iesniegt, Boost šajā ciklā tiek izlaists — atkāpšanās iespējas nav, jo tavam vienīgajam foto jau ir Turbo. Tiek ignorēts, ja augstākā iespēja ir ieslēgta, jo tā vienmēr iesniedz jaunu foto.',
            turboApplyWhenBoostActive: 'Pielietot Turbo Boost laikā',
            turboApplyWhenBoostActiveDesc: 'Ja izslēgts, nepielieto Turbo, kamēr šim izaicinājumam ir pieejams Boost',
            turboFillNew: 'Turbo jaunam iesniegtam foto',
            turboFillNewDesc:
                'Ja ieslēgts, tieši pirms Turbo tiek iesniegts jauns foto (izmantojot tavus automātiskās aizpildes tagu noteikumus) un Turbo tiek pielietots šim jaunajam foto, nevis esošajam. Ja nav brīvas vietas vai nav piemērota foto, tas atgriežas pie tava norādītā Turbo foto; ja vēl nav neviena foto, Turbo šajā ciklā tiek izlaists.',
            turboFillNewOnConflict: 'Turbo jaunam iesniegtam foto tikai konflikta gadījumā',
            turboFillNewOnConflictDesc:
                'Ja ieslēgts, jauns foto tiek iesniegts un tam tiek pielietots Turbo tikai tad, ja tavam vienīgajam esošajam foto jau ir Boost (tāpēc Turbo nevar tur nokļūt). Parastā gadījumā Turbo joprojām nonāk uz tava esošā foto. Ja nav brīvas vietas vai piemērota foto, ko iesniegt, Turbo šajā ciklā tiek izlaists — atkāpšanās iespējas nav, jo tavam vienīgajam foto jau ir Boost. Tiek ignorēts, ja augstākā iespēja ir ieslēgta, jo tā vienmēr iesniedz jaunu foto.',
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
            unitCoins: 'monētas',
            // Konts (galvenes rādītāji)
            bankrollKeys: 'atslēgas',
            bankrollSwaps: 'maiņas',
            bankrollFills: 'aizpildes',
            bankrollCoins: 'monētas',
            // Automātiskās pievienošanās iestatījumi
            groupAutoJoin: 'Automātiskā pievienošanās',
            autoJoin: 'Automātiski pievienoties izaicinājumiem',
            autoJoinDesc:
                'Katrā balsošanas ciklā automātiski pievienoties atvērtajiem izaicinājumiem (auto-balsošanai jādarbojas). Pēc noklusējuma izslēgts. Kad ieslēgts, pievienojas VISIEM atvērtajiem izaicinājumiem, ja vien nesašaurini ar tipu sarakstiem zemāk; maksas izaicinājumiem nepieciešami monētu limiti zemāk (0 = tikai bezmaksas).',
            autoJoinTypes: 'Tikai šiem tipiem',
            autoJoinTypesDesc:
                'Ar komatu atdalīti izaicinājumu tipi, kuriem pievienoties, piem., "flash,contest". Atstāj TUKŠU, lai pievienotos visiem tipiem (noklusējums). Reģistrnejutīgs.',
            autoJoinExcludeTypes: 'Nekad nepievienoties šiem tipiem',
            autoJoinExcludeTypesDesc:
                'Ar komatu atdalīti izaicinājumu tipi, kuriem nekad automātiski nepievienoties, piem., "flash,exhibition". Tā kā noklusējums ir pievienoties visiem tipiem, šādi iegūst "pievienoties visam, izņemot šos". Izaicinājums, kas atbilst saglabātam nosaukuma profilam, joprojām tiek pievienots — profils ir apzināta izvēle konkrētam nosaukumam.',
            autoJoinMaxCoins: 'Maks. monētas par izaicinājumu',
            autoJoinMaxCoinsDesc:
                'Lielākā monētu cena, ko maksāt par pievienošanos vienam izaicinājumam. 0 = tikai bezmaksas. Maksas pievienošanās prasa arī cikla budžetu virs 0.',
            autoJoinCycleCoinBudget: 'Monētu budžets ciklā',
            autoJoinCycleCoinBudgetDesc:
                'Kopējais monētu daudzums, ko automātiskā pievienošanās drīkst tērēt vienā ciklā. 0 = netērēt neko (maksas izslēgta). Gan šim, gan limitam par izaicinājumu jābūt virs 0, lai pievienotos maksas izaicinājumiem.',
            // Atklāšana (nepievienotie izaicinājumi)
            discoverTitle: 'Atklāt izaicinājumus',
            discoverCountLabel: 'atvērti izaicinājumi',
            discoverRefresh: 'Atsvaidzināt',
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
                'Striktais filtrs gan auto-aizpildei, gan manuālajām aizpildes pogām. Apsvērt tikai tos foto, kuru automātiski noteiktie tagi sakrīt ar visiem šiem tagiem. Atstāj tukšu, lai apsvērtu visus piemērotos foto. Salīdzināšana nav reģistrjutīga un notiek pa veseliem vārdiem: galotnes un daudzskaitlis joprojām sakrīt ("cat" sakrīt ar "cats"), bet tags nesakritīs ar garāku, nesaistītu vārdu ("cat" nesakrīt ar "catamaran"). Vairāku vārdu tagi sakrīt pa vārdiem, tāpēc "sea life" prasa abus. Tagi jāraksta angliski — automātiski noteiktie foto tagi vienmēr ir angļu valodā.',
            shouldIncludeTags: 'Vēlamie tagi',
            shouldIncludeTagsDesc:
                'Vēlamais kritērijs gan auto-aizpildei, gan manuālajai aizpildei. Priekšroku dot foto, kuru tagi sakrīt ar šiem; sakritības tiek ranžētas augstāk par automātiski noteikto izaicinājuma atslēgvārdu vērtējumu, bet neizslēdz pārējos foto. Ja neviens nesakrīt, aizpilde turpinās ar parasto ranžēšanu. Salīdzināšanai ir tie paši veselo vārdu noteikumi, kas Obligātajiem tagiem.',
            ignoreTitleWords: 'Ignorēt šos vārdus izaicinājumu nosaukumos',
            ignoreTitleWordsDesc:
                'Vārdi, ko izņemt no izaicinājuma nosaukuma, pirms pēc tā meklē piemērotus foto. Izaicinājumu nosaukumi parasti tēmu papildina ar apzīmētāju, nevis tikai nosauc to — "Epic Lighthouses" ir par bākām, nevis par "epic" — un šie liekie vārdi gan aizmiglo tēmu, gan aizņem nedaudzās meklēšanas reizes uz vienu izaicinājumu. Saraksts jau ir aizpildīts ar biežākajiem; to var brīvi labot. Izņem vārdu, ja izaicinājums tiešām ir par to. Sēriju priedēkļi kā "Color Hunt:" tiek apstrādāti automātiski, un tiem ieraksts nav vajadzīgs.',
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
                'Piešķir profilu un tagus pēc precīza nosaukuma (nav reģistrjutīgs). Tas darbojas arī pēc izaicinājuma id maiņas; manuālie iestatījumi ir prioritāri. Tagi tiek apvienoti.',
            titleTagRulesSaveError:
                'Neizdevās saglabāt noteikumus. Pārbaudi profilus, nosaukumu/tagu garumu un pretrunas ar atvērtu izaicinājumu manuālajiem iestatījumiem. Pārējie iestatījumi saglabāti.',
            titleTagRuleTitle: 'Izaicinājuma nosaukums',
            titleTagRuleTitlePlaceholder: "piem., Let's See Hats",
            titleRuleProfile: 'Automātiskais profils',
            addTitleTagRule: 'Pievienot noteikumu',
            removeTitleTagRule: 'Noņemt noteikumu',
            noTitleTagRules: 'Vēl nav noteikumu. Pievieno vienu izaicinājuma nosaukumam.',
            usingProfile: 'Izmanto profilu',
            none: '(nav)',
            addOnePhoto: 'Pievienot vienu foto, lai aizpildītu tukšu vietu',
            fillAllPhotos: 'Aizpildīt visas tukšās vietas tagad (bez intervāla)',
            cancel: 'Atcelt',
            challengeDefaults: 'Noklusējuma iestatījumi izaicinājumiem',
            groupGeneral: 'Vispārīgi',
            groupBoost: 'Boost',
            groupTurbo: 'Turbo',
            groupFinalWindow: 'Beigu loga ekspozīcija',
            groupLastMinute: 'Pēdējā minūte',
            groupScheduledFill: 'Plānotā balsošana',
            groupVotingPause: 'Balsošanas pauze',
            groupAutoFill: 'Automātiskā aizpilde',
            groupNotifications: 'Paziņojumi',
            groupDisplay: 'Attēlojums',
            tierCore: 'Pamata',
            tierEntries: 'Ieraksti',
            tierOverrides: 'Laika noteikumi',
            tierOverridesDesc:
                'Visi pēc noklusējuma izslēgti — ieslēdziet kādu tikai tad, ja vēlaties mainīt, kad darbojas parastais ekspozīcijas noteikums.',
            tierApp: 'Lietotne',
            // Paziņojumu iestatījumi (pēc noklusējuma izslēgti)
            notifyOnBoost: 'Paziņot pirms boost',
            notifyOnBoostDesc: 'Brīdināt pirms boost tiek pielietots, lai vari atstāt lietotni darbojamies.',
            notifyOnTurbo: 'Paziņot pirms turbo',
            notifyOnTurboDesc: 'Brīdināt pirms turbo tiek nospēlēts, lai vari atstāt lietotni darbojamies.',
            notifyOnAutoFill: 'Paziņot pirms automātiskās aizpildes',
            notifyOnAutoFillDesc:
                'Brīdināt pirms ieraksts tiek automātiski aizpildīts tuvu beigām, lai vari atstāt lietotni darbojamies.',
            notifyOnEmergencyFill: 'Paziņot pirms ārkārtas aizpildes',
            notifyOnEmergencyFillDesc:
                'Brīdināt pirms pēdējā brīža ārkārtas aizpildes, lai vari atstāt lietotni darbojamies.',
            notifyLeadTime: 'Brīdināt cik ilgi iepriekš',
            notifyLeadTimeDesc: 'Cik minūtes pirms darbības tiek parādīts brīdinājums.',
            notifyLeadTimeHelp:
                'Pēc iespējas: lietotne var brīdināt tikai ciklā, kas patiešām izpildās, tāpēc ilgāks laiks nekā pārbaudes biežums tuvu beigām var pienākt ar mazu brīdinājumu. Visdrošāk tas darbojas pēdējās minūtes logā.',
            // Paziņojuma virsraksta/teksta veidnes. {action} izmanto darbību
            // nosaukumus; {title} ir izaicinājuma nosaukums; {minutes}/{count}
            // aizpilda paziņojumu slānis.
            notifyTitle: 'Tuvojas {action}',
            notifyBody: '{action} izaicinājumam "{title}" pēc ~{minutes} min — atstāj lietotni atvērtu līdz tam.',
            notifyGroupTitle: 'Tuvojas darbības',
            notifyGroupBody: '{count} darbības nākamajās ~{minutes} min — atstāj lietotni atvērtu līdz tam.',
            challengeName: 'Izaicinājums',
            challengeOverrides: 'Specifiskie iestatījumi izaicinājumiem',
            challengeSettings: 'Izaicinājuma iestatījumi',
            challengeSettingsDesc:
                'Konfigurējiet iestatījumus, kas ir specifiski šim izaicinājumam. Pielāgotie iestatījumi būs prioritārāki par globālajiem noklusējumiem.',
            checkForUpdates: 'Pārbaudīt atjauninājumus',
            checkForUpdatesDesc: 'Pārbaudīt jaunāku versiju tagad, negaidot automātisko pārbaudi.',
            compactCards: 'Kompaktas kartes',
            compactCardsDesc:
                'Rādīt izaicinājumus kā mazākas kartes, lai ekrānā ietilpst vairāk; izslēdz, lai redzētu pilna izmēra kartes ar vairāk detaļām.',
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
            noOverrides: 'Nav norādīti specifiski iestatījumi izaicinājumiem',
            noUiSettingsToDisplay: 'Nav saskarnes iestatījumu, ko attēlot',
            noUpdatesAvailable: 'Nav pieejamu atjauninājumu',
            normal: 'NORMĀLS',
            of: 'no',
            onePhoto: '1 bilde',
            onlyBoost: 'Tikai "Boost" režīms',
            onlyBoostDesc: 'Pilnībā izlaist parasto balsošanu šim izaicinājumam un tikai pielietot Boost.',
            voteOnNewEntry: 'Balsot par jaunu bildi',
            voteOnNewEntryDesc:
                'Kad šajā izaicinājumā parādās jauna bilde — pievienota paša mājaslapā vai ar automātisko aizpildi, ārkārtas aizpildi vai Boost/Turbo aizpildi — nobalsot vienu reizi arī tad, ja redzamība jau ir sasniegusi vai pārsniegusi slieksni. Balso līdz tiem griestiem, ko izaicinājums izmantotu parasti: Redzamības mērķis (vai Redzamība, ja mērķis ir 0), vai Beigu loga ekspozīcijas mērķis beigu loga laikā, kad ieslēgts "Izmantot beigu loga ekspozīciju". Nepārspēj iestatījumus Tikai "Boost" režīms, Balsot tikai pēdējās minūtes laikā vai Tikai plānotā balsošana: ja kāds no tiem bloķē, balsojums nenotiek.',
            override: 'Pielāgots',
            overrideForChallenge: 'Pielāgot iestatījumus izaicinājumam',
            photo: 'bilde',
            photos: 'bildes',
            noActiveChallenges: 'Nav aktīvu izaicinājumu',
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
            resetToDefaultNotSaved: "Atiestatīt uz noklusējumu (netiks saglabāts, kamēr nenospiedīsiet 'Saglabāt')",
            resetAll: 'Atiestatīt visu',
            resetAllConfirmTitle: 'Atiestatīt visus iestatījumus',
            resetAllConfirmMessage: 'Vai tiešām vēlaties atiestatīt VISUS iestatījumus uz to noklusējuma vērtībām?',
            resetAllConfirmDetails:
                'Šī darbība atiestatīs:\\n• Visus saskarnes iestatījumus (tēmu, valodu, laika joslu)\\n• Visus globālos noklusējuma iestatījumus izaicinājumiem\\n• Lietotnes preferences\\n• Logu pozīcijas un izmērus\\n• Pielāgotās laika joslas\\n• Lietotājvārda un pieteikšanās sesijas preferences\\n\\nTiks saglabāts tikai jūsu piekļuves marķieris (token), pēdējais atjauninājumu pārbaudes laiks, testa režīma iestatījums un API galvenes.\\n\\nŠo darbību nevar atsaukt.',
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
            timezonePlaceholder: 'Ievadiet laika joslu',
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
                'Katrs cikls izmanto nejaušu aizkavi šajā diapazonā. Vienāds min un max nozīmē fiksētu biežumu.',
            checkFrequencyMin: 'Min',
            checkFrequencyMax: 'Max',
            reliability: 'Uzticamība',
            apiMaxRetries: 'API atkārtojumi',
            apiMaxRetriesDesc:
                'Cik reižu atkārtot neizdevušos API pieprasījumu pirms padošanās (0 atspējo). Attiecas uz īslaicīgām tīkla kļūdām, noildzēm, pieprasījumu ierobežojumiem (429) un servera kļūdām (5xx). “Atkārtojuma aizkave” ir bāzes aizkave milisekundēs, kas aptuveni dubultojas katrā mēģinājumā.',
            apiRetryBaseDelayMs: 'Atkārtojuma aizkave (ms)',
            voteOnlyInLastMinute: 'Balsot tikai pēdējās minūtes laikā',
            voteOnlyInLastMinuteDesc:
                'Pilnībā izlaist izaicinājumu, līdz tas sasniedz pēdējās minūtes sliekšņa logu, tad balsot līdz 100%. Tā balsošana notiek tikai pašās beigās, nevis visa izaicinājuma laikā.',
            lastMinuteCheckFrequency: 'Pēdējās minūtes pārbaudes biežums',
            lastMinuteCheckFrequencyDesc:
                'Cik bieži (minūtēs) pārbaudīt izaicinājumu, kad tas ir pēdējās minūtes sliekšņa robežās. Noklusējums 1 pārbauda katru minūti, lai nepalaistu garām beigu grūdienu.',
            useScheduledFill: 'Izmantot plānoto balsošanu',
            useScheduledFillDesc:
                'Balsot līdz 100% ekspozīcijai izvēlētos laikos, nevis tikai tad, kad tā nokrītas zem Redzamības sliekšņa. Tas plāno tikai balsošanu — foto netiek iesniegts (to dara Automātiskā aizpilde). Pieejami divi palaidēju saraksti, kurus var apvienot: viens vai vairāki ikdienas Balsošanas laiki un viens vai vairāki vienreizēji Balsošana pirms beigām intervāli. Katrs ieraksts atver savu neatkarīgu balsošanas logu — piem., intervāli 10h un 4h pirms beigām balso divreiz noslēguma dienā. Loga laikā izaicinājums tiek balsots līdz 100% un tur noturēts; laiki tiek interpretēti lietotnes Laika joslas iestatījumā (nevis šīs ierīces pulkstenī). Nedarbojas, kamēr nav iestatīts vismaz viens laiks zemāk, un nekad neattiecas uz zibens izaicinājumiem vai izaicinājumiem režīmā "Tikai Boost". Ja lietotne nedarbojas visa loga laikā, šis logs tiek izlaists — atgūšanas nav.',
            scheduledFillTime: 'Balsošanas laiki',
            scheduledFillTimeDesc:
                'Ikdienas pulksteņa laiki (24h), kuros atveras balsošanas logi, lietotnes Laika joslas iestatījumā — nevis šīs ierīces pulkstenī. Katrs laiks katru dienu atver savu logu; noņemiet visas rindas, lai izslēgtu šo palaidēju. Ap vasaras/ziemas laika maiņu faktiskais brīdis maiņas dienā var nobīdīties līdz pat stundai.',
            scheduledFillTimeOff: 'laiki nav iestatīti — šis palaidējs ir izslēgts',
            scheduledFillBeforeEnd: 'Balsošana pirms beigām',
            scheduledFillBeforeEndDesc:
                'Atvērt vienreizējus balsošanas logus tik ilgi pirms izaicinājuma beigām — piem., 10h 0m un 4h 0m, lai balsotu divreiz noslēguma dienā. GUI ievada stundās un minūtēs; noņemiet visas rindas, lai izslēgtu šo palaidēju. Tie ir relatīvi pret katra izaicinājuma termiņu — pārbaudiet tos vēlreiz, kad izmantojat saglabātu profilu izaicinājumam ar citu laika grafiku.',
            scheduledFillBeforeEndOff: 'intervāli nav iestatīti — šis palaidējs ir izslēgts',
            scheduledFillAddTime: 'Pievienot laiku',
            scheduledFillAddBeforeEnd: 'Pievienot intervālu',
            scheduledFillRemoveEntry: 'Noņemt ierakstu',
            scheduledFillEntryDraft: 'iestatiet laiku — 0h 0m rindas netiek saglabātas',
            scheduledFillDuplicateEntry: 'dublikāts — šis ieraksts tiek ignorēts',
            scheduledFillMaxEntries: 'Sasniegts maksimums — {0} ieraksti.',
            scheduledFillSourceBeforeEnd: '{0} pirms beigām',
            scheduledFillWindowMinutes: 'Balsošanas logs (minūtes)',
            scheduledFillWindowMinutesDesc:
                'Cik ilgi katrs balsošanas logs paliek atvērts pēc sava sākuma laika. Loga laikā izaicinājums tiek uzpildīts līdz 100% un tur noturēts; pēc tā aizvēršanās atkal darbojas parastie noteikumi. Turiet to garāku par Pārbaudes biežumu, lai balsošanas cikls garantēti trāpītu logā.',
            scheduledFillReplaces: 'Tikai plānotā balsošana',
            scheduledFillReplacesDesc:
                'Kad ieslēgts, parastā un beigu loga ekspozīcijas balsošana ārpus plānotajiem balsošanas logiem tiek bloķēta — plānotie laiki kļūst par vienīgo automātisko balsošanu. Zibens izaicinājumi un Pēdējās minūtes noteikumi joprojām balso kā parasti, manuālā balsošana netiek ietekmēta, un "Balsot tikai pēdējās minūtes laikā" ir pārāks par šo iestatījumu. Brīdinājums: ja lietotne nedarbojas visa loga laikā, šis logs tiek izlaists bez atgūšanas un bez sliekšņa rezerves, tāpēc izaicinājums var noslēgties ar nepilnīgu ekspozīciju.',
            scheduledFillNextHint: 'Nākamais balsošanas logs: {0}–{1} ({2}) — no {3}',
            scheduledFillNoTimesHint:
                'Nav iestatīts balsošanas laiks — plānotā balsošana nedarbojas, kamēr nav iestatīts kāds zemāk.',
            scheduledFillWastedWindowHint:
                'Logi intervāliem {0} sniedzas pāri izaicinājuma termiņam — izmantojama ir tikai daļa pirms beigām.',
            scheduledFillShortWindowHint:
                'Šis logs ir īsāks par jūsu maksimālo Pārbaudes biežumu ({0} min) — vesels logs var iekrist starp balsošanas cikliem, kamēr lietotne darbojas bez uzraudzības.',
            scheduledFillUnreachableHint:
                '"Tikai plānotā balsošana" ir ieslēgta, bet pirms šī izaicinājuma beigām vairs nevar notikt neviens balsošanas logs — parastā un beigu loga balsošana paliek bloķēta, tāpēc balsos tikai Pēdējās minūtes noteikumi.',
            scheduledFillProfileReplacesWarning:
                'Šī profila piemērošana ieslēgs "Tikai plānotā balsošana" šim izaicinājumam — pirms saglabāšanas pārskatiet balsošanas laikus.',
            useVotingPause: 'Balsošanas pauze',
            useVotingPauseDesc:
                'Apturēt automātisko balsošanu izvēlētajos logos — domāts nakts pārtraukumam starp mačiem, kad aizpildītā ekspozīcija savāc ļoti maz balsu un tās pašas balsis ir vērtīgāk iztērētas pēc nākamā mača sākuma. Pieejami divi palaidēju saraksti, kurus var apvienot: viens vai vairāki ikdienas Pauzes laiki un viens vai vairāki vienreizēji Pauze pirms beigām intervāli. Katrs ieraksts sāk savu pauzi, kas ilgst zemāk norādīto Pauzes ilgumu; laiki tiek interpretēti lietotnes Laika joslas iestatījumā (nevis šīs ierīces pulkstenī). Nedarbojas, kamēr nav iestatīts vismaz viens laiks zemāk. Zibens izaicinājumi un Pēdējās minūtes noteikumi joprojām balso, tāpēc izaicinājums, kas patiešām beidzas pauzes laikā, netiek pamests, un Boost un Turbo joprojām tiek pielietoti pēc saviem taimeriem. Manuālā balsošana nekad netiek bloķēta.',
            votingPauseTime: 'Pauzes laiki',
            votingPauseTimeDesc:
                'Ikdienas pulksteņa laiki (24h), kuros sākas pauze, lietotnes Laika joslas iestatījumā — nevis šīs ierīces pulkstenī. Katrs laiks katru dienu sāk savu pauzi; noņemiet visas rindas, lai izslēgtu šo palaidēju. Nakts pauzei no 01:30 līdz 06:00 iestatiet šeit 01:30 un Pauzes ilgumu 270 minūtes. Ap vasaras/ziemas laika maiņu faktiskais brīdis maiņas dienā var nobīdīties līdz pat stundai.',
            votingPauseBeforeEnd: 'Pauze pirms beigām',
            votingPauseBeforeEndDesc:
                'Sākt vienreizēju pauzi tik ilgi pirms izaicinājuma beigām. GUI ievada stundās un minūtēs; noņemiet visas rindas, lai izslēgtu šo palaidēju. Tie ir relatīvi pret katra izaicinājuma termiņu — pārbaudiet tos vēlreiz, kad izmantojat saglabātu profilu izaicinājumam ar citu laika grafiku. Pauze, kas sniedzas pāri termiņam, tāpat padodas Pēdējās minūtes noteikumiem, kuri balso vienmēr.',
            votingPauseDurationMinutes: 'Pauzes ilgums (minūtes)',
            votingPauseDurationMinutesDesc:
                'Cik ilgi katra pauze turpinās no sava sākuma laika. Kad tā beidzas, atkal darbojas parastie noteikumi un ekspozīcija tiek uzpildīta nākamajā balsošanas ciklā. Piemērs: 270 minūtes, sākot 01:30, notur pauzi līdz 06:00.',
            votingPauseNextHint: 'Nākamā pauze: {0}–{1} ({2}) — no {3}',
            votingPauseActiveHint:
                'Pauze ir aktīva līdz {0} ({1}) — balsos tikai Pēdējās minūtes un zibens noteikumi. Boost un Turbo joprojām tiek pielietoti pēc saviem taimeriem.',
            votingPauseShortWindowHint:
                'Šī pauze ir īsāka par jūsu maksimālo Pārbaudes biežumu ({0} min) — balsošanas cikls to var pilnībā pārlēkt, un balsošana turpināsies tā, it kā pauze nebūtu iestatīta.',
            votingPauseNoTimesHint:
                'Nav iestatīts pauzes laiks — balsošanas pauze nedarbojas, kamēr nav iestatīts kāds zemāk.',
            votingPauseAllDayHint:
                'Šīs pauzes aizņem visu diennakti — ārpus Pēdējās minūtes noteikumiem šis izaicinājums nekad automātiski nebalsotu.',
            finalWindowDuration: 'Beigu loga ilgums',
            finalWindowDurationDesc:
                'Cik ilgs ir beigu logs pirms izaicinājuma beigām. Beigu loga ekspozīcijas noteikums darbojas šajā logā. Pēc noklusējuma 1 stunda.',
            finalWindowDurationHelp:
                'Beigu loga garums, skaitot atpakaļ no izaicinājuma beigu laika. Iestati 1 stundu, lai atveidotu veco fiksēto pēdējās stundas darbību, vai saīsini/pagarini to, lai mainītu, kad pārņem Beigu loga ekspozīcijas slieksnis un mērķis.',
            finalWindowExposure: 'Beigu loga ekspozīcija',
            finalWindowExposureDesc:
                'Redzamības līmenis, kas iedarbina balsošanu beigu logā (tikai kad ieslēgts "Izmantot beigu loga ekspozīciju"). Jābūt vienādam vai mazākam par Redzamības iestatījumu.',
            finalWindowExposureTarget: 'Beigu loga ekspozīcijas mērķis',
            finalWindowExposureTargetDesc:
                'Balsot līdz šim procentam, kad nostrādā beigu loga noteikums (0 = tāds pats kā beigu loga slieksnis)',
            finalWindowExposureTargetHelp:
                '0 NENOZĪMĒ izslēgts. 0 nozīmē “balsot līdz beigu loga redzamības slieksnim” — beigu loga noteikums paliek aktīvs. Ievadi 1-100, lai balsotu tālāk par šo slieksni. Pretstatā laika iestatījumiem, kur 0 nozīmē izslēgts.',
            useFinalWindowExposure: 'Izmantot beigu loga ekspozīciju',
            useFinalWindowExposureDesc:
                'Beigu logā pirms izaicinājuma beigām izmantot atsevišķo beigu loga redzamības slieksni un mērķi parastā redzamības iestatījuma vietā.',
            voteBeforeFinalWindow: 'Balsot pirms beigu loga',
            voteBeforeFinalWindowDesc:
                'Ap beigu loga sākumu balsot līdz parastajam redzamības mērķim, lai izaicinājums, kura redzamība jau nokritusies zem tā, netiktu atstāts zemā līmenī beigu loga zemākā sliekšņa dēļ. Papildināšana paliek aktīva logā, kas aptver beigu loga robežu — nobīdes minūtes pirms tās un tikpat daudz minūšu pēc tās — un tad pārņem beigu loga redzamības noteikums. Darbojas tikai tad, kad ieslēgts "Izmantot beigu loga ekspozīciju".',
            voteBeforeFinalWindowLeadMin: 'Balsošanas pirms beigu loga nobīde',
            voteBeforeFinalWindowLeadMinDesc:
                'Cik minūtes ap beigu loga sākumu papildināšana paliek aktīva. Logs atveras tik daudz minūšu pirms beigu loga un aizveras tikpat daudz minūšu pēc tā sākuma, pēc kā pārņem beigu loga redzamības noteikums.',
            validationInvalidValue: 'Nepareiza vērtība',
            validationMustBeLessOrEqual: 'Jābūt ≤ {0} (pašlaik {1})',
            whatsNew: 'Kas jauns:',
            yourEntries: 'Jūsu bildes',
            yourProgress: 'Jūsu progress',
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
            updateReadyToInstall: 'Atjauninājums lejupielādēts un gatavs instalēšanai. Restartējiet, lai piemērotu.',
            skipVersion: 'Izlaist versiju',
            remindLater: 'Atgādināt vēlāk',
            download: 'Lejupielādēt',
            restartLater: 'Restartēt vēlāk',
            restartNow: 'Restartēt tagad',
            close: 'Aizvērt',
            downloadInBrowser: 'Lejupielādēt pārlūkā',
            overridden: 'Pielāgots',
            usingGlobal: 'Izmanto globālo',
            overridesActiveSummary: '{0} manuāls(-i) pielāgojums(-i); pārējie izmanto profila/globālo pamatu.',
            overridesNoneSummary: 'Nav manuālu pielāgojumu; izmanto profila/globālo pamatu.',
            enableOverride: 'Iespējot pielāgošanu šim izaicinājumam',
            clearAll: 'Notīrīt visu',
            notApplicable: 'Nav piemērojams',
            notApplicableHint: 'Jūsu saglabātās vērtības tiek paturētas.',
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
            profileSaveError: 'Neizdevās saglabāt profilu — kāda vērtība neizturēja validāciju.',
            profileNameRequired: 'Vispirms ievadiet profila nosaukumu.',
            profileNameTooLong: 'Profila nosaukums ir par garu (maks. {0} rakstzīmes).',
            profileLimitReached: 'Sasniegts profilu limits ({0}) — vispirms izdzēsiet kādu.',
            profileAppliedHint: 'Pielietots — pārskatiet vērtības zemāk un tad Saglabāt.',
            profileApplyHint:
                'Profila pielietošana aizstāj pašreizējās formas vērtības (arī nesaglabātās izmaiņas); iestatījumi, kas profilā nav iekļauti, atgriežas uz "Izmanto globālo".',
            profileOverwriteHint: 'Saglabājot ar esošu nosaukumu, tas tiek pārrakstīts.',
            intentBuiltIn: 'Iebūvēta sagatave',
            intentModified: 'Rediģēta sagatave',
            intentJustParticipate: 'Vienkārši piedalīties',
            intentJustParticipateDesc:
                'Uztur tavas dalības aizpildītas, bet nekad netērē Boost vai Turbo un nedzenas pēc redzamības tālāk par slieksni — maz pūļu, maz riska.',
            intentFinishStrong: 'Nobeigt spēcīgi',
            intentFinishStrongDesc:
                'Lielāko izaicinājuma daļu spēlē normāli, tad beigu logā izmanto Boost un Turbo un spēcīgi palielina redzamību.',
            intentMaxExposure: 'Maksimāla redzamība',
            intentMaxExposureDesc:
                'Visu laiku spiež uz priekšu: balso līdz pilnai redzamībai, aizpilda dalības un izmanto Boost un Turbo.',
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
