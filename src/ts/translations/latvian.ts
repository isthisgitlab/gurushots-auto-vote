// Latvian translations for GuruShots Auto Vote
// aislop-ignore-file complexity/file-too-large -- flat translation dictionary; one file per language keeps key parity reviewable
// Common/shared translations
export const common = {
    global: 'Globāli:',
    languageEnglish: 'English',
    languageLatvian: 'Latviešu',
    loading: 'Ielādē…',
    closeModal: 'Aizvērt',
    logout: 'Iziet',
    mock: 'Testa režīms:',
    never: 'Nekad',
    no: 'Nē',
    off: 'IZSLĒGTS',
    on: 'IESLĒGTS',
    refresh: 'Atsvaidzināt',
    running: 'Darbojas',
    status: 'Statuss:',
    stay: 'Palikt:',
    stopped: 'Apturēts',
    theme: 'Tēma',
    title: 'GuruShots Auto Vote',
    yes: 'Jā',
    ok: 'Labi',
};
// Error / recovery UI
export const errors = {
    boundaryTitle: 'Kaut kas nogāja greizi',
    logoutNotSavedStopped: 'Automātiskā balsošana ir apturēta. Palaid to vēlreiz, lai turpinātu balsot.',
    logoutFailedTitle: 'Izrakstīšanās nepabeidzās',
    logoutFailedDetail:
        'Izrakstoties kaut kas nogāja greizi, tāpēc tu, iespējams, joprojām esi pieteicies. Mēģini vēlreiz; sīkāka informācija ir žurnālos.',
    logoutNotSavedTitle: 'Tu joprojām esi pieteicies',
    logoutNotSavedDetail:
        'Izrakstīšanos neizdevās saglabāt: saglabātie uzstādījumi šobrīd netiek izmantoti. Pieteikšanās netika mainīta. Mēģini vēlreiz pēc brīža; ja atkārtojas, izpildi paziņojumā norādīto.',
    dismiss: 'Aizvērt',
    reload: 'Pārlādēt',
    fetchFailed: 'Neizdevās sazināties ar GuruShots — mēģinām vēlreiz automātiski.',
    actionInvalidArgs:
        'Darbību neizdevās izpildīt: izaicinājuma vai foto identifikators nav derīgs. Pārlādē lietotni un mēģini vēlreiz.',
    actionFailed:
        'Darbība netika pabeigta. Lietotne vai GuruShots to nevarēja pabeigt. Mēģini vēlreiz pēc brīža; ja tas atkārtojas, sīkāka informācija ir žurnālos.',
    compactToggleFailed:
        'Kartīšu izkārtojums netika mainīts. Uzstādījumu nevarēja saglabāt, tāpēc kartītes paliek, kā bija. Mēģini vēlreiz pēc brīža.',
    loginFailed:
        'Pieteikšanās neizdevās. GuruShots to nepieņēma vai nebija sasniedzams. Pārbaudi lietotājvārdu, paroli un savienojumu un mēģini vēlreiz.',
    invalidCredentials:
        'Pieteikšanās neizdevās. GuruShots nepieņēma lietotājvārdu vai paroli. Pārbaudi tos un mēģini vēlreiz.',
    notLoggedIn: 'Tu neesi pieteicies. Sesija ir beigusies vai nav sākta. Piesakies vēlreiz, lai turpinātu.',
    turboNotEarned: 'Turbo netika nopelnīts. Cīņas beidzās bez uzvaras. Mēģini vēlreiz vēlāk.',
    turboNoBattles: 'Šobrīd nav cīņu, ko spēlēt. GuruShots nav sagatavojis nevienu. Mēģini vēlreiz pēc dažām minūtēm.',
    turboRunInProgress: 'Šajā izaicinājumā Turbo spēle jau notiek. Pagaidi, kamēr tā beidzas, un mēģini vēlreiz.',
    turboModeUnknown:
        'Turbo veids vēl nav zināms. GuruShots nav paziņojis lietotnei, kāda ir šī Turbo spēle. Mēģini vēlreiz pēc brīža.',
    snapNeedsModel:
        'Snap netika spēlēts. Tam vajadzīgs vizuālais modelis, kura šajā versijā nav. Turbo uzstādījumos ieslēdz „Atbildēt Snap ar Jā bez vizuālā modeļa”, spēlē to GuruShots vai izmanto versiju ar modeli.',
    snapNotOffered:
        'Snap netika spēlēts. GuruShots to šim izaicinājumam vairs nepiedāvā. Atsvaidzini sarakstu, lai redzētu pašreizējo Turbo.',
    snapUnanswerable:
        'Snap netika pabeigts. Lietotne nevarēja atbildēt uz jautājumu par fotoattēlu. Mēģini vēlreiz vēlāk vai spēlē to GuruShots.',
    snapInterrupted:
        'Snap netika pabeigts. Spēle tika pārtraukta vai GuruShots neapstiprināja atbildi. Mēģini vēlreiz vēlāk; spēle turpināsies no pārtraukuma vietas.',
    challengeNoLongerActive:
        'Šis izaicinājums vairs nav atvērts, tāpēc darbība netika veikta. Atsvaidzini sarakstu, lai redzētu pašreizējos izaicinājumus.',
    boostFailed: 'Boost netika piemērots. GuruShots to noraidīja vai neatbildēja. Mēģini vēlreiz pēc brīža.',
    pinFailed: 'Piespraudi neizdevās saglabāt. Uzstādījumu failu neizdevās ierakstīt. Mēģini vēlreiz.',
    pinCapReached:
        'Piespraudi neizdevās saglabāt. Pārāk daudziem izaicinājumiem jau ir piespraudes, un tās tiek noņemtas, kad izaicinājums beidzas. Noņem piespraudi citā izaicinājumā un mēģini vēlreiz.',
    pickNotEnoughSlots:
        'Foto netika iesniegti. Izaicinājumā ir mazāk brīvo vietu nekā izvēlēto foto, jo tā iesniegumi ir mainījušies. Noņem foto, līdz skaits ietilpst brīvajās vietās, un iesniedz vēlreiz.',
    pickAlreadyEntered:
        'Foto netika iesniegti: viens jau ir iesniegts šajā izaicinājumā. Foto saraksts atsvaidzinās un nederīgos izņems no izvēles. Pārbaudi izvēli un iesniedz vēlreiz.',
    pickRejected:
        'Foto netika iesniegti. GuruShots tos noraidīja, tāpēc kāds foto šim izaicinājumam, iespējams, vairs neder. Izvēlies citus foto un mēģini vēlreiz.',
    pickBusy:
        'Foto netika iesniegti. Šajā izaicinājumā foto iesniegšana jau notiek. Pagaidi, kamēr tā beidzas, un pārbaudi kartīti.',
    pickUnclear:
        'Foto, iespējams, tika iesniegti. GuruShots neatbildēja skaidri, un kartīte tiek atsvaidzināta. Pārbaudi kartīti, pirms mēģini vēlreiz.',
    suggestNoChosenEntered:
        'Nav ko ieteikt. „Iesniegt tikai izvēlētos foto” ir ieslēgts, un visi izvēlētie foto jau iesniegti. Poga „Izvēlēties foto…” to nepiemēro — izvēlies foto šeit vai atjauno sarakstu.',
    suggestNoChosenUnusable:
        'Nav ko ieteikt. Ir ieslēgts uzstādījums „Iesniegt tikai izvēlētos foto”, un neviens izvēlētais foto šim izaicinājumam neder. Izvēlies jebkuru foto šeit vai atjauno izvēlētos foto.',
    suggestNoMatch:
        'Nav ko ieteikt. Neviens foto neatbilst taviem obligātajiem tagiem. Atbrīvo tagus vai izvēlies foto pats.',
    suggestNoEligible:
        'Nav ko ieteikt. Tavā bibliotēkā šobrīd nav foto, ko šis izaicinājums pieņem. Augšupielādē foto vai pamēģini meklēšanu.',
    suggestNoMore:
        'Vairāk ieteikumu nav. Visi piemērotie foto jau ir parādīti. Spied „Automātiski”, lai sāktu no jauna ar labākajiem.',
    suggestBusy: 'Foto netika sarindoti. Cita rindošana vēl turpinās. Pagaidi, kamēr tā beidzas, un mēģini vēlreiz.',
    suggestChallengeEnded:
        'Foto netika sarindoti. Izaicinājums ir beidzies vai to nevarēja nolasīt. Aizver šo dialoglodziņu un atver kartīti vēlreiz.',
    suggestFailed: 'Foto netika sarindoti. GuruShots neatbildēja vai rindošana nepabeidzās. Mēģini vēlreiz pēc brīža.',
    fetchChallengesFailed: 'Izaicinājumus neizdevās ielādēt. GuruShots neatbildēja. Mēģini vēlreiz pēc brīža.',
    libraryReadFailed:
        'Tavus foto neizdevās nolasīt. Bibliotēkas nolasīšana pārtrūka, pirms tā tika pabeigta. Pamēģini vēlreiz.',
    superseded: 'Pieprasījums tika pārtraukts: jaunāks pieprasījums to aizstāja, pirms tas pabeidzās. Mēģini vēlreiz.',
    tokenNotSaved:
        'Pieteikšanās pieņemta, bet nesaglabāta: uzstādījumus neizdevās ierakstīt. Pārbaudi faila atļaujas un brīvo vietu diskā, tad piesakies vēlreiz.',
    tokenNotSavedAndroid:
        'Pieteikšanās tika pieņemta, bet to neizdevās saglabāt. Ierīces uzstādījumu krātuve to nepieņēma. Restartē lietotni un piesakies vēlreiz.',
    webShellToken:
        'Šī lapa nevar sazināties ar tīmekļa serveri. Tā ir atvērta bez šīs palaišanas piekļuves tokena, vai serveris kopš tā laika ir restartēts. Atver adresi, ko izvadīja pnpm web.',
    joinRefusedFull:
        'Neizdevās pievienoties: izaicinājums ir pilns, brīvu vietu vairs nav. Monētas netika norakstītas. Atsvaidzini sarakstu un pievienojies, tiklīdz atbrīvojas kāda vieta.',
    joinRefusedPriceUnknown:
        'Neizdevās pievienoties: cena nav zināma — GuruShots to nenosūtīja, tāpēc nevarēja apstiprināt tēriņu. Monētas netika norakstītas. Atsvaidzini sarakstu vai pievienojies vietnē.',
    boundaryBody:
        'Daļa lietotnes pārstāja darboties. Informācija ir saglabāta žurnālos. Pārlādē lietotni, lai turpinātu; ja tas atkārtojas, žurnālos redzams, kas neizdevās.',
    votingFailed:
        'Pēdējais balsošanas cikls neizdevās. GuruShots neatbildēja vai noraidīja pieprasījumu. Automātiskā balsošana mēģinās vēlreiz nākamajā ciklā; sīkāka informācija ir žurnālos.',
};
// First-run onboarding
export const onboarding = {
    title: 'Laipni lūdzam GuruShots Auto Vote',
    intro: 'Šī lietotne pēc grafika automātiski balso tavos aktīvajos GuruShots izaicinājumos un uztur tavu redzamību augstu — tev pašam nekas nav jādara.',
    howItWorksTitle: 'Kā tas darbojas',
    howItWorks:
        'Piesakies, uzstādījumos izvēlies sliekšņus un ieslēdz automātisko balsošanu. Lietotne ik pēc dažām minūtēm pārbauda izaicinājumus un balso, kad vajag.',
    batteryTitle: 'Darbība fonā',
    batteryBody:
        'Lai balsošana turpinātos ar izslēgtu ekrānu, tālruņa uzstādījumos izslēdz šai lietotnei akumulatora optimizāciju. Daži ražotāji (Samsung, Xiaomi, OnePlus) fona lietotnes aptur īpaši agresīvi.',
    gotIt: 'Sapratu',
};
// Menu translations
export const menu = {
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
    toggleDevTools: 'Rādīt vai slēpt izstrādātāja rīkus',
    toggleFullscreen: 'Ieslēgt vai izslēgt pilnekrāna režīmu',
    minimize: 'Minimizēt',
    zoom: 'Tālummaiņa',
    close: 'Aizvērt',
    bringAllToFront: 'Novietot visu priekšplānā',
    logs: 'Žurnāli',
    about: 'Par GuruShots Auto Vote',
    aboutTitle: 'Par GuruShots Auto Vote',
    aboutAuthor: 'Autors',
    aboutElectron: 'Electron',
    aboutNode: 'Node.js',
    aboutDescription:
        'GuruShots Auto Vote — Electron lietotne automātiskai balsošanai GuruShots izaicinājumos ar kopīgu grafisko un komandrindas saskarni (atbalsta gan īsto, gan testa režīmu)',
    checkForUpdates: 'Pārbaudīt atjauninājumus…',
    noUpdates: 'Nav atjauninājumu',
    noUpdatesMessage: 'Tev jau ir jaunākā versija.',
    updateError: 'Atjaunināšanas kļūda',
    updateErrorMessage: 'Neizdevās pārbaudīt atjauninājumus.',
};
export const quitGuard = {
    title: 'Aizvērt, lai gan drīz jāizmanto Boost?',
    detail: 'Automātiskā balsošana darbojas un drīz izmantos Boost šajos izaicinājumos. Ja aizvērsi lietotni, šie Boost netiks izmantoti.',
    dueIn: 'Boost pēc {time}',
    dueNow: 'Boost tūlīt',
    keepRunning: 'Turpināt darbu',
    quitAnyway: 'Tomēr aizvērt',
};
// Login screen specific
export const login = {
    heading: 'Pieteikšanās',
    loadingModeInfo: 'Ielādē informāciju par režīmu…',
    loggingIn: 'Piesakās…',
    loginButton: 'Pieteikties',
    mockMode: 'Testa režīms',
    mockModeInfo: 'Testa režīms: lietotne izmanto simulētus datus. Der jebkāds lietotājvārds un parole.',
    password: 'Parole',
    passwordPlaceholder: 'Ievadi savu paroli',
    passwordRequired: 'Parole ir obligāta',
    productionModeInfo:
        'Īstais režīms: lietotne savienojas ar tavu GuruShots kontu. Vajag derīgu lietotājvārdu un paroli.',
    stayLoggedIn: 'Saglabāt pieteikšanos',
    title: 'Pieteikšanās — GuruShots Auto Vote',
    username: 'Lietotājvārds',
    usernamePlaceholder: 'Ievadi savu lietotājvārdu',
    usernameRequired: 'Lietotājvārds ir obligāts',
};
// App screen specific
export const app = {
    activeChallenges: 'Aktīvie izaicinājumi',
    addCustomTimezone: 'Pievienot pielāgotu laika joslu',
    addTimezone: 'Pievienot laika joslu',
    apiTimeout: 'Gaidīšanas laiks',
    apiTimeoutDesc:
        'Cik ilgi gaidīt GuruShots API atbildi, pirms uzskatīt pieprasījumu par neizdevušos (1–120 sekundes).',
    appSetting: 'Lietotnes uzstādījums',
    applicationSettings: 'Lietotnes uzstādījumi',
    autoVote: 'Automātiskā balsošana',
    autovoteRunning: 'Automātiskā balsošana darbojas',
    autovoteRunningDesc:
        'Iekšējs — atceras, vai automātiskā balsošana bija ieslēgta, lai pēc lietotnes restartēšanas tā atsāktos pati',
    autovoteStartedLaunch: 'Palaišanas reize, kurā sākta automātiskā balsošana',
    autovoteStartedLaunchDesc:
        'Iekšējs — lietotnes palaišanas reize, kurā automātiskā balsošana pēdējo reizi tika sākta, lai lietotne atšķirtu šajā reizē sākto balsošanu no tādas, kas vēl gaida atsākšanu',
    skipUpdateVersion: 'Izlaistā atjauninājuma versija',
    skipUpdateVersionDesc:
        'Iekšējs — atjauninājuma versija, ko lietotājs izvēlējās izlaist; lietotne šo versiju nepiedāvās, kamēr šī vērtība nav notīrīta',
    available: 'Pieejams',
    used: 'Izmantots',
    unavailable: 'Nav pieejams',
    boost: 'Boost',
    boostWindowOpen: 'Boost logs ir atvērts',
    boostOpenBadge: 'Boost atvērts',
    lowExposure: 'Zema redzamība',
    jumpToChallenge: 'Pāriet uz izaicinājumu',
    deadlineTimeline: 'Gaidāmās darbības',
    deadlineTimelineApprox: 'aptuveni — var mainīties, pievienojot foto',
    deadlineNext: 'Nākamā',
    deadlineDue: 'jau tagad',
    deadlineActionAutoSubmit: 'Automātiskā iesniegšana',
    deadlineActionBoost: 'Boost',
    deadlineActionTurbo: 'Turbo',
    deadlineActionEmergencySubmit: 'Ārkārtas iesniegšana',
    conflictFlag:
        '{kind} nevar izmantot: vienīgajam foto jau ir {other} (abi nevar būt vienam foto). Pievieno vēl vienu foto, lai izmantotu abus.',
    conflictPinReleases:
        '{kind} gaida: foto ir piesprausts {other}. Ja {other} līdz {time} nebūs gatavs, {kind} tiks izmantots šim foto. Noņem piespraudi vai pievieno vēl vienu foto, lai {kind} izmantotu agrāk.',
    conflictPinNever:
        '{kind} netiks izmantots: foto ir piesprausts {other}, un piespraude neatkāpsies (Ārkārtas iesniegšana ir izslēgta vai {other} ir gatavs). Noņem piespraudi vai pievieno vēl vienu foto.',
    pinForBoost: 'Piespraust Boost',
    pinForTurbo: 'Piespraust Turbo',
    pinnedForBoost: 'Piesprausts Boost',
    pinnedForTurbo: 'Piesprausts Turbo',
    pinClear: 'Noņemt piespraudi',
    pinNotApplying: 'Piespraustais {kind} foto netiek piemērots. Atver kartīti, lai uzzinātu vairāk.',
    pinNotApplyingBoth: 'Piespraustie {boost} un {turbo} foto netiek piemēroti. Atver kartīti, lai uzzinātu vairāk.',
    pinNotApplyingShort: '{kind} piespraude netiek piemērota',
    pinNotApplyingShortBoth: '{boost} un {turbo} piespraudes netiek piemērotas',
    pinGoneNote:
        'Piespraustā {kind} foto šajā izaicinājumā pašlaik nav, tāpēc {kind} izmantos tavus parastos {kind} uzstādījumus. Piespraud citu foto vai noņem piespraudi. Ja tas ir viens no taviem izvēlētajiem foto, piespraude stāsies spēkā, kad tas tiks iesniegts.',
    pinConflictNote:
        'Piespraustajam {kind} foto jau ir {other}, tāpēc {kind} izmantos tavus parastos {kind} uzstādījumus. Piespraud citu foto vai noņem piespraudi.',
    pinSwapWarning:
        'Šis foto ir piesprausts {kind}. Ja to apmainīsi, piespraudei nebūs foto, kam piemērot {kind}, tāpēc {kind} izmantos tavus parastos {kind} uzstādījumus.',
    statusHeaderActive: 'aktīvi',
    statusHeaderBoosts: 'Boost gatavi',
    statusHeaderTurbos: 'Turbo gatavi',
    statusHeaderMissedBoosts: 'Boost nokavēti',
    missedBoostsHint:
        'Izaicinājuma kartītē atbloķē ar atslēgu; ja kompaktā kartītē nav pogas „{unlock}”, atver „{details}”',
    missedBoostsNoKeys: 'Nav atslēgu, lai tos atbloķētu',
    missedBoostsKeysUnknown: 'Poga „{unlock}” kartītē var parādīties, kad būs pieejams atslēgu atlikums',
    statusHeaderNext: 'Nākamā',
    statusHeaderNextClaim: 'Nākamā balvu saņemšana',
    statusHeaderNextClaimHint:
        'Balvas saņem pirmajā balsošanas ciklā pēc tam, kad beidzies stundu garais gaidīšanas periods.',
    statusHeaderNotRunning: 'automātiskā balsošana izslēgta',
    statusHeaderNextApprox: 'aptuveni — pārrēķina katrā ciklā',
    statusHeaderResumesIn: 'Atsāksies pēc',
    statusHeaderResumesInHint:
        'Pēc palaišanas lietotne uzgaida, pirms atsāk automātisko balsošanu, lai vari vispirms pārbaudīt uzstādījumus.',
    settingHelpLabel: 'Ko tas nozīmē?',
    autoJoinBadge: 'automātiskā pievienošanās ieslēgta',
    autoJoinBadgeTitle:
        'Automātiskā pievienošanās darbojas katrā balsošanas ciklā, kamēr ieslēgta automātiskā balsošana. To var pielāgot sadaļā Uzstādījumi › Automātiskā pievienošanās.',
    boostTime: 'Boost laiks',
    boostTimeDesc:
        'Izmanto Boost, kad Boost laika atskaitē ir atlicis šis laiks. Neattiecas uz Boost, kas atbloķēts ar atslēgu, — tam nav laika atskaites; izmanto „Boost laiks (atbloķēts ar atslēgu)”.',
    boostTimeHelp:
        'Laiks līdz beigām. 0 izslēdz Boost izmantošanu pēc laika — šeit 0 nozīmē „izslēgts”, atšķirībā no redzamības mērķa uzstādījumiem, kur 0 nozīmē „sekot slieksnim”.',
    keyUnlockedBoostTime: 'Boost laiks (atbloķēts ar atslēgu)',
    keyUnlockedBoostTimeDesc:
        'Atsevišķs logs Boost, kas atbloķēts ar atslēgu (bez savas laika atskaites). Tā kā tas nekad nebeidzas, to izmanto tikai tad, kad līdz beigām atlicis šis laiks. 0 = nekad neizmanto automātiski.',
    keyUnlockedBoostTimeHelp:
        'Atsevišķs no „Boost laiks” — viens otru neaizstāj; attiecas tikai uz atslēgas atbloķēto Boost. Tāpat kā citos laika uzstādījumos, 0 nozīmē „izslēgts”.',
    boostFreshEntryWait: 'Gaidīt pirms Boost jaunam foto',
    boostFreshEntryWaitDesc:
        'Boost tiek aizturēts, līdz foto, kuram tas paredzēts, izaicinājumā pavadījis šo laiku, jo svaigam foto tas lielākoties aiziet zudumā. Tā termiņu nepārsniedz; 0 = Boost uzreiz.',
    boostOnSleep: 'Boost pirms miega',
    boostOnSleepDesc:
        'Darbvirsmā: ja dators pāriet miegā, kamēr darbojas automātiskā balsošana, Boost 30 minūšu laikā tiek izmantots uzreiz, lai neaizietu zudumā; tas arī saīsina „Gaidīt pirms Boost jaunam foto”.',
    voteBeforeBoost: 'Uzpildīt redzamību pirms Boost',
    voteBeforeBoostDesc:
        'Īsi pirms automātiskās Boost izmantošanas nobalso šajā izaicinājumā līdz 100 % redzamībai, lai Boost nostrādātu uz pilnībā redzama foto, nevis uz tāda, kura redzamība jau sarukusi.',
    voteBeforeBoostHelp:
        'Boost pareizina foto redzamību brīdī, kad nostrādā, un katrā izaicinājumā ir tikai viens — ar sarukušu redzamību tas aiziet zudumā. Nobalso līdz 100 % pirms Boost; vajag „Automātiski izmantot Boost”.',
    voteBeforeBoostOnlyBoostHint:
        'Ieslēgts „Tikai Boost režīms”, tāpēc lietotne nebalso — šī uzpilde nekad nenotiks. Lai to izmantotu, izslēdz šo režīmu (sadaļā „Vispārīgi”).',
    voteBeforeBoostNoAutoBoostHint:
        'Izslēgts „Automātiski izmantot Boost”, tāpēc lietotne Boost automātiski neizmanto un nav Boost, pirms kura šai uzpildei nostrādāt.',
    voteBeforeBoostLastMinuteOnlyHint:
        'Ieslēgts „Balsot tikai pēdējās minūtes laikā”, tāpēc lietotne pirms tam nebalso — šī uzpilde nostrādās tikai tad, ja Boost gadīsies tajā logā, kur balsošana tik un tā notiek līdz 100 %.',
    voteBeforeBoostNoBoostTimeHint:
        'Gan „Boost laiks”, gan „Boost laiks (atbloķēts ar atslēgu)” ir 0 (izslēgts), tāpēc lietotne Boost automātiski neizmanto un nav Boost, pirms kura šai uzpildei nostrādāt. Uzstādi kaut vienu virs 0.',
    voteBeforeBoostLeadMin: 'Cik laicīgi pirms Boost',
    voteBeforeBoostLeadMinDesc:
        'Cik ilgi pirms Boost izmantošanas sākas uzpilde. Atvēli pietiekami laika vairākiem balsošanas cikliem — redzamība nesasniedz 100 % vienā piegājienā.',
    autoBoost: 'Automātiski izmantot Boost',
    autoBoostDesc: 'Automātiski izmanto Boost šajā izaicinājumā, kad tā Boost logs drīz aizvērsies.',
    protectUncertainAutoSubmits: 'Saudzēt automātiski iesniegtos foto bez skaidras atbilstības',
    protectUncertainAutoSubmitsDesc:
        'Neizmantot Boost un Turbo automātiski iesniegtiem foto bez atbilstības tēmai. Izņēmumi: ārkārtas darbības, Boost termiņa beigas un atvērtas tēmas.',
    turbo: 'Turbo',
    autoTurbo: 'Automātiski iegūt Turbo',
    autoTurboDesc: 'Automātiski spēlē Turbo minispēli, lai iegūtu bonusu',
    snapYesWithoutModel: 'Atbildēt Snap ar „Jā” bez vizuālā modeļa',
    snapYesWithoutModelDesc:
        'Versijā bez vizuālā modeļa Snap Turbo spēlē, uz katru fotoattēlu atbildot „Jā”; Turbo iegūst ar jebkuru atbildi. Ja modelis ir, atbild modelis. Pēc noklusējuma izslēgts.',
    useTurbo: 'Automātiski izmantot Turbo',
    useTurboDesc: 'Automātiski izmanto iegūto Turbo vienam no taviem foto',
    turboTime: 'Turbo izmantošanas laiks',
    turboTimeDesc: 'Izmanto Turbo, kad līdz izaicinājuma beigām ir atlicis šis laiks.',
    turboTimeHelp:
        'Laiks līdz beigām, kad lietotne izmanto iegūto Turbo. Uzstādi 0, lai izslēgtu Turbo izmantošanu pēc laika. Tāpat kā citos laika uzstādījumos, 0 šeit nozīmē „izslēgts”, nevis „sekot slieksnim”.',
    turboImageIndex: 'Turbo foto',
    turboImageIndexDesc:
        'Kuram foto Turbo: 1 = pirmajam, 0 = pēdējam; Boost vai tā piespraude to pārbīda atpakaļ. Piesprausts Boost atkāpjas tikai ārkārtas iesniegšanas laikā — kamēr Boost nav gatavs, Turbo nenotiek.',
    boostImageIndex: 'Boost foto',
    boostImageIndexDesc:
        'Kuram foto Boost: 1 = pirmajam, 0 = pēdējam; Turbo vai tā piespraude to pārbīda atpakaļ. Piesprausts Turbo atkāpjas tikai ārkārtas iesniegšanas laikā — kamēr Turbo nav iegūts, Boost nenotiek.',
    boostNewSubmit: 'Boost jaunam iesniegtam foto',
    boostNewSubmitDesc:
        'Tieši pirms Boost iesniedz jaunu foto (pēc automātiskās iesniegšanas tagu noteikumiem), un Boost piešķiras jaunajam foto. Nav brīvas vietas vai piemērota foto — Boost pāriet uz norādīto Boost foto.',
    boostNewSubmitOnConflict: 'Boost jaunam iesniegtam foto tikai konflikta gadījumā',
    boostNewSubmitOnConflictDesc:
        'Boost jaunam foto iesniedz tikai tad, ja neviens esošais foto nevar saņemt Boost — katram ir Turbo vai tā piespraude. Turbo piespraude, kas ārkārtas iesniegšanas laikā atkāpjas, Boost saņem.',
    turboNewSubmit: 'Turbo jaunam iesniegtam foto',
    turboNewSubmitDesc:
        'Tieši pirms Turbo iesniedz jaunu foto pēc tagu noteikumiem, un Turbo piešķiras jaunajam foto. Nav vietas vai foto — Turbo pāriet uz norādīto Turbo foto, bet bez foto izlaiž ciklu.',
    turboNewSubmitOnConflict: 'Turbo jaunam iesniegtam foto tikai konflikta gadījumā',
    turboNewSubmitOnConflictDesc:
        'Turbo jaunam foto iesniedz tikai tad, ja neviens esošais foto nevar saņemt Turbo — katram ir Boost vai tā piespraude. Boost piespraude, kas ārkārtas iesniegšanas laikā atkāpjas, Turbo saņem.',
    playAutoTurbo: 'Spēlēt Turbo minispēli, lai iegūtu Turbo',
    autoTurboRunsWithAutovote: 'Automātiskā balsošana jau spēlē Turbo minispēli katrā ciklā',
    earnTurbo: 'Iegūt Turbo',
    applyTurboToThisEntry: 'Izmantot savu Turbo šim foto',
    applyBoostToThisEntry: 'Izmantot savu Boost šim foto',
    autoSubmit: 'Automātiski iesniegt trūkstošos foto',
    autoSubmitDesc:
        'Iesniegt papildu foto, kad tuvojas izaicinājuma termiņš, pēc zemāk norādītā grafika. Katrā pārbaudes ciklā iesniedz vienu foto.',
    autoSubmitSchedule: 'Automātiskās iesniegšanas grafiks',
    autoSubmitScheduleDesc:
        '0h 0min izslēdz attiecīgo foto. Katra rinda: kad līdz beigām atlicis šis laiks, jābūt vismaz tik foto, piemēram, „Foto 2 ≤ 48h”. Atpaliekot, lietotne grafiku panāk pa vienam foto ciklā.',
    autoSubmitScheduleShiftHint:
        'Šis izaicinājums atļauj {0} foto — mazāk, nekā aptver grafiks, tāpēc laiki nobīdās uz beigām: pēdējais foto izmanto Foto {1} laiku.',
    autoSubmitScheduleImage: 'Foto',
    autoSubmitScheduleOff: 'laiks nav uzstādīts — foto var iesniegt, panākot kādu vēlāku foto',
    autoSubmitScheduleEmpty: 'Visi foto ir izslēgti — automātiskā iesniegšana neko neiesniegs.',
    autoSubmitScheduleDominated: 'nekad nenostrādās (vēlākam foto jau ir tāds pats vai garāks laiks)',
    autoSubmitScheduleOutOfRange: 'laiks nedrīkst pārsniegt 30 dienas',
    settingsSaveError: 'Dažus uzstādījumus neizdevās saglabāt — pārbaudi izceltās vērtības un mēģini vēlreiz.',
    unitPercent: '%',
    unitMinutes: 'min',
    unitHours: 'h',
    unitSeconds: 's',
    unitMilliseconds: 'ms',
    unitCoins: 'monētas',
    unitVotes: 'balsis',
    unitKeys: 'atslēgas',
    unitSwaps: 'apmaiņas',
    unitFills: 'uzpildes',
    // Konts (galvenes rādītāji)
    bankrollKeys: 'atslēgas',
    bankrollSwaps: 'apmaiņas',
    bankrollFills: 'uzpildes',
    bankrollCoins: 'monētas',
    // Valūtas darbības (atslēga / apmaiņa / redzamības uzpilde) izaicinājuma kartītē
    currencyKeyUnlock: 'Atbloķēt',
    currencyKeyUnlockTitle: 'Atbloķēt Boost ar atslēgu?',
    currencyKeyUnlockBody:
        'Tas atbloķē Boost izaicinājumā „{title}”. Boost vēl netiek piešķirts nevienam foto — tu pats izvēlēsies, kuram foto to izmantot.',
    currencyFillExposure: 'Uzpildīt redzamību',
    currencyFillExposureTitle: 'Uzpildīt redzamību?',
    currencyFillExposureBody: 'Tas uzreiz paceļ redzamību izaicinājumā „{title}” līdz 100 %.',
    currencySwap: 'Apmainīt',
    currencySwapTitle: 'Apmainīt šo foto?',
    currencySwapBody:
        'Pašreizējo foto aizstās foto, ko lietotne izvēlējās šim izaicinājumam. Aizstāto foto nevar apmainīt atpakaļ.',
    currencySwapChoose: 'Izvēlēties citu foto…',
    currencySwapCurrent: 'Pašreizējais foto',
    currencySwapReplacement: 'Jaunais foto',
    currencySwapYourPick: 'Tavs izvēlētais foto',
    currencySwapChosenBody: 'Pašreizējo foto aizstās tavs izvēlētais foto. Aizstāto foto nevar apmainīt atpakaļ.',
    currencySwapBoostedWarning:
        'Šim foto ir Boost vai Turbo. Tas paliek pie šī foto — jaunajam foto tā nebūs, un šajā izaicinājumā to vairs nevarēs izmantot, ja vien šo foto neapmainīsi atpakaļ.',
    currencySwapBack: 'Apmainīt atpakaļ',
    currencySwapBackTitle: 'Apmainīt atpakaļ sākotnējo foto?',
    currencySwapBackBody: 'Tavs sākotnējais foto atgriežas šajā vietā un atgūst savu {kind}.',
    currencySwapBackOriginal: 'Sākotnējais foto',
    currencyCost: 'Maksā: 1 {unit}.',
    currencyBalance: 'Atlikums ({currency}): {current}; pēc tam paliks: {resulting}.',
    currencyBalanceUnknown: 'Neizdevās nolasīt atlikumu ({currency}) — lietotne to vēlreiz pārbaudīs pirms tērēšanas.',
    currencyUnitKeys: 'atslēga',
    currencyUnitSwaps: 'apmaiņa',
    currencyUnitFills: 'uzpilde',
    currencySpend: 'Tērēt: 1 {unit}',
    // Valūtas darbību rezultāti
    currencyOutcomeNotAvailable:
        'Šajā izaicinājumā šobrīd nav pieejams — iespējams, jau izdarīts. Kartīte atjaunosies.',
    currencyOutcomeNoBalance: 'Šīs valūtas vairs nav, tāpēc nekas netika iztērēts.',
    currencyOutcomeBalanceUnknown:
        'Neizdevās pārbaudīt atlikumu, tāpēc nekas netika iztērēts. Pēc brīža mēģini vēlreiz.',
    currencyOutcomeNoAlternative: 'Nav cita foto, ar ko apmainīt, — visi derīgie foto šeit jau izmantoti.',
    currencyOutcomeStaleCandidate:
        'Apmaiņas piedāvājums vairs nav aktuāls vai ir mainījies, tāpēc nekas netika iztērēts. Sāc apmaiņu no jauna.',
    currencyOutcomeAlreadyEntered:
        'Šis foto jau ir iesniegts šajā izaicinājumā, tāpēc nekas netika iztērēts. Sāc apmaiņu no jauna ar citu foto.',
    currencyOutcomeBusy: 'Vēl notiek cita valūtas darbība — pēc brīža mēģini vēlreiz.',
    currencyOutcomeUnclear:
        'Uz pieprasījumu netika saņemta atbilde, tāpēc nav zināms, vai tas izdevās. Atsvaidzini izaicinājumu un pārbaudi to, pirms mēģini vēlreiz.',
    currencyOutcomeFailed: 'GuruShots noraidīja pieprasījumu. Mēģini vēlāk; ja tas atkārtojas, pārbaudi žurnālus.',
    scenario: 'Scenārijs',
    scenarioDesc:
        'Scenārijs, ko izpilda šis izaicinājums, — tavs vairāku dienu plāns ar fāzēm un noteikumiem (Uzstādījumi → Scenāriji). Tukšs = nav; piešķir atsevišķi vai ar noteikumu (piemēram, tips = exhibition).',
    scenarioNone: 'Nav',
    scenarioMissingOption: '{name} (nav atrasts — nekas netiek izpildīts)',
    scenarios: 'Scenāriji',
    scenariosDesc:
        'Tavi vairāku dienu plāni: fāzes ar saviem uzstādījumiem un noteikumi, kas izvēlētos brīžos iesniedz, apmaina, izmanto Boost vai gaida. Piešķir atsevišķi vai ar noteikumu. Izmaiņas saglabājas uzreiz.',
    scenariosLoadError: 'Scenārijus neizdevās ielādēt. Aizver uzstādījumus un atver tos vēlreiz.',
    scenariosEmpty: 'Scenāriju vēl nav. Sāc no šablona vai importē kāda cita kopīgotu scenāriju.',
    scenarioErrorNext: 'Izlabo to un mēģini vēlreiz.',
    scenarioStartsIn: 'sākas fāzē {phase}',
    scenarioPhaseSummary: 'Fāze {phase}, noteikumu skaits: {rules}',
    scenarioSpends: 'Tērē: {actions}',
    scenarioSpendsNothing: 'Neko netērē.',
    scenarioLimits: 'Limiti: {limits}',
    scenarioNoLimits: 'Tēriņu limitu nav.',
    scenarioImportInvalid: 'Šo scenāriju nevar importēt, jo failā ir kļūdas.',
    scenarioImportFailed: 'Scenārijs netika importēts.',
    scenarioImportLabel: 'Ielīmē scenārija JSON',
    scenarioOverwrite: 'Aizstāt manu scenāriju „{name}”',
    scenarioPreview: 'Pārbaudīt',
    scenarioImportConfirm: 'Importēt',
    scenarioImport: 'Importēt…',
    scenarioExport: 'Eksportēt',
    scenarioExportFailed: 'Scenāriju neizdevās eksportēt — iespējams, tas pa to laiku izdzēsts.',
    scenarioExportHint: 'Nokopē šo tekstu, lai kopīgotu scenāriju vai saglabātu tā rezerves kopiju.',
    scenarioExportLabel: 'Scenārijs {name} JSON formātā',
    scenarioExportClose: 'Paslēpt',
    scenarioRename: 'Pārdēvēt',
    scenarioRenameLabel: 'Jaunais scenārija nosaukums',
    scenarioRenameSave: 'Saglabāt nosaukumu',
    scenarioRenameFailed: 'Scenārijs netika pārdēvēts.',
    scenarioDelete: 'Dzēst',
    scenarioDeleteConfirm: 'Noklikšķini vēlreiz, lai dzēstu',
    scenarioDeleteFailed: 'Scenāriju neizdevās izdzēst — iespējams, tā vairs nav.',
    scenarioPhaseCount: 'Fāzes: {count}',
    scenarioTemplatePick: 'Sākt no šablona…',
    scenarioAddTemplate: 'Pievienot kopiju',
    scenarioTemplateFailed: 'Šablona kopija netika saglabāta.',
    scenarioStatusMissing:
        'Scenārijs „{name}” vairs nepastāv — nekas netiek izpildīts. Izvēlies citu izaicinājuma uzstādījumos.',
    scenarioStatusUnloaded:
        'Scenārijs „{name}”: progresu vēl nav izdevies ielādēt, tāpēc plāns apturēts. Lietotne mēģina vēlreiz; ja netiek ielādēts, atver lietotni no jauna. Nekas netiek atiestatīts.',
    scenarioStatusUnloadedShort:
        'Scenārijs „{name}” ir apturēts: saglabāto progresu vēl nav izdevies ielādēt. Lietotne mēģina vēlreiz.',
    scenarioStatusUnloadedService:
        'Scenārijs „{name}”: šis logs progresu vēl nav ielādējis. Ja fona pakalpojums darbojas, plānus izpilda tas no savas kopijas. Ja netiek ielādēts, atver lietotni no jauna. Nekas netiek atiestatīts.',
    scenarioStatusUnloadedServiceShort:
        'Scenārijs „{name}”: šim logam vēl nav izdevies ielādēt scenāriju progresu. Ja fona pakalpojums darbojas, plānus izpilda pakalpojums no savas kopijas.',
    scenarioStatusCorrupt:
        'Scenārijs „{name}”: scenāriju saglabāto progresu nevar nolasīt, tāpēc visu izaicinājumu plāni ir apturēti. Ja atiestatīsi visu izaicinājumu progresu, plāni sāksies no jauna.',
    scenarioStatusCorruptShort:
        'Spied „{details}”, tad „{reset}” — scenārijs „{name}” ir apturēts: saglabāto progresu nevar nolasīt.',
    scenarioStatusCorruptRecord:
        'Scenārijs „{name}”: šī izaicinājuma saglabāto progresu nevar nolasīt, tāpēc tā plāns ir apturēts. Ja to atiestatīsi, plāns sāksies no jauna.',
    scenarioStatusCorruptRecordShort:
        'Spied „{details}”, tad „{reset}” — scenārijs „{name}” ir apturēts: šī izaicinājuma saglabāto progresu nevar nolasīt.',
    scenarioStatusPhase: 'fāze {phase}',
    scenarioStatusNotStarted: 'nākamajā palaišanā sāksies fāzē {phase}',
    scenarioStatusNotStartedManual: 'sāksies fāzē {phase}, kad „Tikai manuāli” būs izslēgts',
    scenarioStatusNext: 'nākamā pārbaude pēc {time}',
    scenarioStatusPausedManual: 'apturēts: ir ieslēgts „Tikai manuāli”, tāpēc neviens solis netiek izpildīts',
    scenarioStatusPausedManualShort: 'apturēts („Tikai manuāli”)',
    scenarioStatusProblem: 'Pēdējais solis izlaists: {message}',
    scenarioStatusSpendUnclear:
        'GuruShots neatbildēja uz „{action}”, tāpēc tas, iespējams, tika izpildīts. Tas netiks tērēts atkārtoti: nākamajā ciklā tikai pārbaudīs, vai tas stājās spēkā.',
    scenarioStatusSpendUnclearManual:
        'GuruShots neatbildēja uz „{action}”, tāpēc tas, iespējams, tika izpildīts. Tas netiks tērēts atkārtoti: kad „Tikai manuāli” būs izslēgts, nākamajā ciklā tikai pārbaudīs, vai tas stājās spēkā.',
    scenarioStatusSpendUnclearPendingManual:
        'Lietotne nesaglabāja, vai „{action}” tika nosūtīts, tāpēc tas, iespējams, izpildīts. To netērēs atkārtoti: kad „Tikai manuāli” būs izslēgts, nākamajā ciklā pārbaudīs, vai tas stājās spēkā.',
    scenarioStatusSpendUnclearPending:
        'Lietotne nesaglabāja, vai „{action}” tika nosūtīts, tāpēc tas, iespējams, tika izpildīts. Tas netiks tērēts atkārtoti: nākamajā ciklā tikai pārbaudīs, vai tas stājās spēkā.',
    scenarioStatusSpendStopped:
        'GuruShots neatbildēja uz „{action}”, tāpēc tas, iespējams, tika izpildīts, un tā noteikums tika apturēts, lai to netērētu atkārtoti. Pārbaudi izaicinājumu. {hint}',
    scenarioStatusResetHint:
        '{again} Lai sāktu no jauna, izmanto „Atiestatīt scenāriju” zemāk vai komandrindā palaid scenario-reset --challenge={id}: tas var vēlreiz iztērēt darbību un atsāk tēriņu skaitīšanu.',
    scenarioStatusSpendStoppedShort:
        'Spied „{details}”, lai redzētu sīkāk — GuruShots neatbildēja uz „{action}”: tā noteikums tika apturēts, lai to netērētu atkārtoti.',
    scenarioStatusSpendStoppedPending:
        'Lietotne nesaglabāja, vai „{action}” tika nosūtīts un kas no tā iznāca, tāpēc tas, iespējams, izpildīts, un tā noteikums apturēts, lai to netērētu atkārtoti. Pārbaudi izaicinājumu. {hint}',
    scenarioStatusSpendStoppedPendingShort:
        'Spied „{details}”, lai redzētu sīkāk — lietotne nesaglabāja, vai „{action}” tika nosūtīts: tā noteikums tika apturēts, lai to netērētu atkārtoti.',
    scenarioReset: 'Atiestatīt scenāriju…',
    scenarioResetAll: 'Atiestatīt visu izaicinājumu progresu…',
    scenarioResetTitle: 'Scenārija progresa atiestatīšana',
    scenarioResetBody:
        'Tas aizmirst, kurā scenārija vietā ir „{title}”: nākamajā reizē plāns sāksies no pirmās fāzes, noteikumi var darboties (un tērēt) vēlreiz, un darbība ar nezināmu iznākumu var tikt iztērēta atkārtoti.',
    scenarioResetAllBody:
        'Saglabāto progresu nevar nolasīt, tāpēc atiestatāms tikai visiem izaicinājumiem uzreiz. Pazūd katra plāna vieta, jau darbojušos noteikumu saraksts (tie var tērēt vēlreiz) un tēriņu skaitītāji.',
    scenarioResetConfirm: 'Atiestatīt',
    scenarioResetWorking: 'Notiek atiestatīšana…',
    scenarioResetBusy:
        'Šī izaicinājuma scenārijs pašlaik tiek izpildīts vai saglabātais progress tiek atjaunināts (lietotnē vai citā procesā). Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    scenarioResetAllBusy:
        'Saglabāto scenāriju progresu pašlaik atjaunina lietotne vai cits process. Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    scenarioResetUnloaded:
        'Saglabāto progresu vēl nav izdevies ielādēt, tāpēc nekas netika atiestatīts. Lietotne mēģina vēlreiz; ja progress joprojām netiek ielādēts, atver lietotni no jauna.',
    scenarioResetReadable:
        'Saglabāto progresu atkal var nolasīt, tāpēc nekas netika atiestatīts. Aizver šo dialoglodziņu, lai redzētu, kur ir plāni.',
    scenarioResetUnreadable:
        'Saglabāto progresu nevar nolasīt, tāpēc šo izaicinājumu nevar atiestatīt atsevišķi. Aizver šo dialoglodziņu un atver to vēlreiz, lai atiestatītu visus izaicinājumus.',
    locksUnavailable:
        'Lietotne nevar izveidot bloķēšanas failus savā datu mapē, tāpēc to nevar droši veikt. Nekas netika mainīts. Pārbaudi mapes atļaujas un brīvo vietu diskā (sīkāk žurnālā) un mēģini vēlreiz.',
    scenarioResetFailed: 'Pašlaik neizdevās atiestatīt scenāriju. Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    scenarioResetAllFailed:
        'Pašlaik neizdevās atiestatīt visu izaicinājumu progresu. Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    scenarioResetNotSaved:
        'Ierīce nevarēja saglabāt atiestatīšanu, tāpēc nekas netika mainīts. Atbrīvo vietu krātuvē un mēģini vēlreiz.',
    scenarioResetAllNotSaved:
        'Ierīce nevarēja saglabāt visu izaicinājumu atiestatīšanu, tāpēc nekas netika mainīts. Atbrīvo vietu krātuvē un mēģini vēlreiz.',
    scenarioStatusAgainPhase: 'Noteikums var darboties vēlreiz, kad fāze tiek sākta no jauna.',
    scenarioStatusAgainReset: 'Noteikums var darboties vēlreiz tikai pēc atiestatīšanas.',
    scenarioStatusAgainDay: 'Noteikums var darboties vēlreiz nākamajā dienā.',
    notifyOnScenario: 'Paziņojumi no scenārijiem',
    notifyOnScenarioDesc:
        'Rādīt ziņas, ko sūta tavu scenāriju paziņojumu soļi, un brīdinājumu, kad scenārijs apstājas, jo vajadzīga tava rīcība.',
    scenarioNotifyTitle: 'Scenārijs — {title}',
    scenarioNotifyGroupTitle: 'Scenāriji — jaunumi: {count}',
    sbCond_dailyWindow: 'Diennakts laiks',
    sbCond_beforeEnd: 'Laiks līdz beigām',
    sbCond_afterStart: 'Laiks kopš sākuma',
    sbCond_inPhaseFor: 'Laiks šajā fāzē',
    sbCond_elapsedPercent: 'Pagājusī izaicinājuma daļa (%)',
    sbCond_entries: 'Iesniegumu skaits',
    sbCond_freeSlots: 'Brīvās iesniegumu vietas',
    sbCond_exposure: 'Redzamība (%)',
    sbCond_challengeRank: 'Mana vieta izaicinājumā',
    sbCond_challengeVotes: 'Manas balsis izaicinājumā',
    sbCond_boostState: 'Boost stāvoklis',
    sbCond_turboState: 'Turbo stāvoklis',
    sbCond_balance: 'Mans atlikums',
    sbCond_memorySet: 'Ir atcerēts foto',
    sbCond_entry: 'Viens no maniem iesniegumiem',
    sbCond_all: 'Visi šie',
    sbCond_any: 'Jebkurš no šiem',
    sbCond_not: 'Ne šis',
    sbAct_enterPhoto: 'Iesniegt foto (jauns iesniegums)',
    sbAct_swap: 'Apmainīt iesniegumu',
    sbAct_boost: 'Izmantot Boost iesniegumam',
    sbAct_turbo: 'Izmantot Turbo iesniegumam',
    sbAct_unlockBoost: 'Atbloķēt Boost ar atslēgu',
    sbAct_fillExposure: 'Uzpildīt redzamību (tērē uzpildi)',
    sbAct_vote: 'Balsot līdz redzamībai',
    sbAct_remember: 'Atcerēties iesnieguma foto',
    sbAct_forget: 'Aizmirst atcerēto foto',
    sbAct_goto: 'Pāriet uz fāzi',
    sbAct_notify: 'Sūtīt man paziņojumu',
    sbSel_slot: 'Iesniegums vietā',
    sbSel_memory: 'Atcerētais foto',
    sbSel_fastest: 'Ātrākais (balsis stundā)',
    sbSel_mostVotes: 'Visvairāk balsu',
    sbSel_fewestVotes: 'Vismazāk balsu',
    sbSel_bestRank: 'Labākā vieta',
    sbSel_worstRank: 'Sliktākā vieta',
    sbSel_boosted: 'Ar Boost',
    sbSel_turbo: 'Ar Turbo',
    sbEntryField_votes: 'balsis',
    sbEntryField_rank: 'vieta',
    sbEntryField_votesPerHour: 'balsis stundā',
    sbEntryField_speedRatio: 'ātrums salīdzinājumā ar citiem maniem iesniegumiem (×)',
    sbEntryField_boosted: 'ir Boost',
    sbEntryField_turbo: 'ir Turbo',
    sbEntryField_boosting: 'Boost darbojas tagad',
    sbRepeat_always: 'Katrā palaišanā, kamēr nosacījumi izpildās',
    sbRepeat_once: 'Tikai vienreiz',
    sbRepeat_oncePerPhase: 'Vienreiz katras fāzes sākumā',
    sbRepeat_oncePerDay: 'Vienreiz dienā',
    sbState_boost_LOCKED: 'Bloķēts',
    sbState_boost_MISSED: 'Nokavēts',
    sbState_boost_AVAILABLE: 'Pieejams',
    sbState_boost_AVAILABLE_KEY: 'Atbloķēts ar atslēgu',
    sbState_boost_USED: 'Izmantots',
    sbState_boost_UNAVAILABLE: 'Nav pieejams',
    sbState_turbo_FREE: 'Var spēlēt bez maksas',
    sbState_turbo_IN_PROGRESS: 'Spēle notiek',
    sbState_turbo_TIMER: 'Gaida laika atskaites beigas',
    sbState_turbo_WON: 'Uzvarēts',
    sbState_turbo_LOCKED: 'Bloķēts',
    sbState_turbo_USED: 'Izmantots',
    sbCurrency_keys: 'atslēgas',
    sbCurrency_swaps: 'apmaiņas',
    sbCurrency_fills: 'uzpildes',
    sbCurrency_coins: 'monētas',
    sbField_from: 'No',
    sbField_to: 'Līdz',
    sbField_min: 'Vismaz',
    sbField_max: 'Ne vairāk kā',
    sbField_op: 'Salīdzinājums',
    sbField_value: 'Vērtība',
    sbField_in: 'Jebkurš no',
    sbField_currency: 'Valūta',
    sbField_slot: 'Atmiņas vieta',
    sbField_select: 'Kurš iesniegums',
    sbField_field: 'Kas',
    sbField_window: 'Mērīšanas periods',
    sbField_of: 'Nosacījumi',
    sbField_condition: 'Nosacījums',
    sbField_photo: 'Foto',
    sbField_remember: 'Atcerēties kā',
    sbField_entry: 'Kurš iesniegums',
    sbField_with: 'Ielikt vietā',
    sbField_rememberRemoved: 'Izņemto foto atcerēties kā',
    sbField_rememberAdded: 'Ielikto foto atcerēties kā',
    sbField_toExposure: 'Līdz redzamībai (%)',
    sbField_phase: 'Fāze',
    sbField_message: 'Ziņa',
    sbField_index: 'Vieta',
    sbField_skipProtected: 'Izlaist iesniegumus ar Boost vai Turbo',
    sbNew: 'Jauns scenārijs',
    sbEdit: 'Rediģēt',
    sbTitleNew: 'Jauns scenārijs',
    sbTitleEdit: 'Rediģēt scenāriju',
    sbTabBuilder: 'Veidotājs',
    sbTabJson: 'JSON',
    sbName: 'Nosaukums',
    sbDescription: 'Apraksts',
    sbStart: 'Sākas fāzē',
    sbLimits: 'Tēriņu limiti (tukšs = bez limita)',
    sbPhases: 'Fāzes',
    sbAddPhase: 'Pievienot fāzi',
    sbPhaseName: 'Fāzes nosaukums',
    sbRemovePhase: 'Noņemt fāzi',
    sbPhaseSettings: 'Uzstādījumi šajā fāzē',
    sbAddSetting: 'Pievienot uzstādījumu',
    sbPickSetting: 'Izvēlies uzstādījumu…',
    sbNoSettings: 'Uzstādījumi netiek mainīti — darbojas parastie.',
    sbRules: 'Noteikumi (izpilda pirmo gatavo)',
    sbAddRule: 'Pievienot noteikumu',
    sbRuleLabel: 'Noteikuma nosaukums',
    sbRepeat: 'Izpilda',
    sbConditions: 'Kad izpildās visi šie nosacījumi',
    sbConditionsEmpty: 'Nav nosacījumu — noteikums vienmēr ir gatavs.',
    sbAddCondition: 'Pievienot nosacījumu',
    sbActions: 'Tad dari',
    sbAddAction: 'Pievienot darbību',
    sbPickType: 'Izvēlies…',
    sbRemove: 'Noņemt',
    sbMoveUp: 'Uz augšu',
    sbMoveDown: 'Uz leju',
    sbSave: 'Saglabāt scenāriju',
    sbSaveFailed: 'Scenārijs netika saglabāts, jo tajā ir kļūdas.',
    sbJsonHint: 'Rediģē visu scenāriju JSON formātā. Izmaiņas parādās veidotājā, tiklīdz JSON ir derīgs.',
    sbJsonInvalid: 'Šis vēl nav derīgs JSON — veidotājs patur pēdējo derīgo versiju.',
    sbSimulate: 'Simulēt',
    sbSimulateOn: 'Simulēt izaicinājumam',
    sbSimulatePick: 'Izvēlies izaicinājumu…',
    sbSimulateAssume: 'Pieņem, ka katrs solis izdodas un izaicinājuma dati paliek tādi kā tagad.',
    sbSimulatePausedManual: 'Apturēts („Tikai manuāli”) — šādi notiktu, ja „Tikai manuāli” tagad būtu izslēgts.',
    sbSimulateNothing: 'Nekas netiktu izpildīts.',
    sbSimulateFailed: 'Simulāciju neizdevās palaist.',
    sbStop_closed: 'Beidzas: izaicinājums noslēdzas.',
    sbStop_idle: 'Beidzas: nekas vairs nav atkarīgs no laika — tālāk plāns gaida balsis, vietu vai Boost.',
    sbStop_halted: 'Beidzas: scenārijs apstājas.',
    sbStop_limit: 'Beidzas: parādīti tikai pirmie soļi.',
    sbPhotoBest: 'Vislabāk atbilstošais foto',
    sbPhotoMemory: 'Atcerētais foto',
    sbSlotLast: 'pēdējā',
    sbTrue: 'jā',
    sbFalse: 'nē',
    sbToPhase: 'tad fāze {phase}',
    // Automātiskās pievienošanās uzstādījumi
    groupAutoJoin: 'Automātiskā pievienošanās',
    autoJoin: 'Automātiski pievienoties izaicinājumiem',
    autoJoinDesc:
        'Pievienojas atvērtajiem izaicinājumiem katrā balsošanas ciklā. Noklusējumā izslēgts; tad pievienojas VISIEM, ja neierobežo zemāk. Maksas izaicinājumiem vajag monētu limitus (0 = bezmaksas).',
    autoJoinTypes: 'Tikai šiem tipiem',
    autoJoinTypesDesc:
        'Ar komatu atdalīti izaicinājumu tipi, kuriem pievienoties, piem., „flash,contest”. Atstāj TUKŠU, lai pievienotos visiem tipiem (noklusējums). Lielajiem un mazajiem burtiem nav nozīmes.',
    autoJoinExcludeTypes: 'Nekad nepievienoties šiem tipiem',
    autoJoinExcludeTypesDesc:
        'Tipi, kuriem nekad nepievienoties, piem., „flash,exhibition”. Tā kā noklusējums ir visi tipi, šādi iegūst „visu, izņemot šos”. Izaicinājums ar nosaukuma profilu pievienojas — tā ir apzināta izvēle.',
    autoJoinChallengeTags: 'Tikai izaicinājumi ar tagiem',
    autoJoinChallengeTagsDesc:
        'IZAICINĀJUMA tagi, kuru izaicinājumiem pievienoties, piem., „Exhibition,Turbo” — tagus piešķir GuruShots, tie nav tavu foto tagi. Tukšs = visi; pietiek ar vienu sakritību. Reģistrs nav svarīgs.',
    autoJoinExcludeChallengeTags: 'Nekad izaicinājumi ar tagiem',
    autoJoinExcludeChallengeTagsDesc:
        'IZAICINĀJUMA tagi, kuriem nekad nepievienoties, piem., „Comm”. Izņem no augstāk atlasītajiem — tā iegūst „visu, izņemot šos”. Ja ieslēdz nosaukuma noteikums, tomēr pievienojas — apzināta izvēle.',
    autoJoinWithinHoursOfEnd: 'Pievienoties tikai tuvu beigām',
    autoJoinWithinHoursOfEndDesc:
        'Nogaidīt, līdz izaicinājumam līdz beigām atlicis tik stundu, un tikai tad pievienoties, nevis pievienoties uzreiz, tiklīdz tas parādās. 0 = pievienoties uzreiz.',
    autoJoinWithinHoursOfEndHelp:
        'Ārpus loga izaicinājumu neizlaiž pavisam — pārbauda katrā ciklā un pievienojas, tiklīdz tas logā nonāk. Bez norādīta beigu laika un uzstādīta loga tam nepievienojas pāragri.',
    autoJoinAfterPercentElapsed: 'Pievienoties pēc % no izaicinājuma',
    autoJoinAfterPercentElapsedDesc:
        'Nogaidīt, līdz pagājusi šī izaicinājuma daļa, un tikai tad pievienoties; daļu norāda procentos no izaicinājuma garuma. 75 nozīmē „pievienoties, kad pagājušas trīs ceturtdaļas”. 0 = izslēgts.',
    autoJoinAfterPercentElapsedHelp:
        'Dažāda garuma izaicinājumiem: 75 % ir 6 stundas pirms beigām 24 stundu izaicinājumā un 5 dienas pirms 3 nedēļu izstādes. Virs 0 tas aizstāj stundu logu.',
    autoJoinMaxCoins: 'Maks. monētu par izaicinājumu',
    autoJoinMaxCoinsDesc:
        'Lielākā monētu cena, ko maksāt par pievienošanos vienam izaicinājumam. 0 = tikai bezmaksas. Maksas pievienošanās prasa arī cikla budžetu, kas lielāks par 0.',
    autoJoinCycleCoinBudget: 'Monētu budžets ciklā',
    autoJoinCycleCoinBudgetDesc:
        'Cik monētu automātiskā pievienošanās drīkst iztērēt ciklā. 0 = neko netērēt (maksas pievienošanās izslēgta). Maksas izaicinājumiem abiem limitiem jābūt virs 0.',
    // Atklāšana (nepievienotie izaicinājumi)
    discoverTitle: 'Atrast izaicinājumus',
    discoverCountLabel: 'Atvērtie izaicinājumi: {count}',
    discoverCountSplit: 'Atvērti: {open} · gaidāmi: {upcoming}',
    discoverStartsIn: 'Sākas pēc {time} — tad varēs pievienoties',
    discoverStartingNow: 'Sākas tagad — drīz parādīsies atvērto sarakstā',
    discoverUpcomingChosenHint:
        'Izvēlētos foto automātiski izmanto tikai tad, ja šim izaicinājumam ir ieslēgta automātiskā pievienošanās; citādi pievienojies pats, kad tas sāksies.',
    discoverJoinOpeningLabel: 'Pievienoties izaicinājumam „{title}” — pievienošanās atvērsies pēc brīža',
    discoverJoinNotStartedLabel: 'Pievienoties izaicinājumam „{title}” — iespējams tikai pēc tā sākuma',
    discoverRefresh: 'Atsvaidzināt',
    discoverEmpty: 'Šobrīd nav atvērtu izaicinājumu, kuriem pievienoties.',
    discoverUnavailableList: 'Neizdevās ielādēt atvērtos izaicinājumus. Pārbaudi savienojumu un mēģini vēlreiz.',
    discoverUntitled: 'Izaicinājums bez nosaukuma',
    discoverCostFree: 'bezmaksas',
    discoverCostPaid: 'monētas: {coins}',
    discoverFull: 'Pilns',
    discoverJoinFullLabel: 'Pievienoties izaicinājumam „{title}” — tas ir pilns',
    discoverPriceUnknown: 'Cena nav zināma',
    discoverJoinPriceUnknownLabel: 'Pievienoties izaicinājumam „{title}” — cena nav zināma',
    discoverPriceUnknownHint:
        'Šī izaicinājuma cena nav zināma: GuruShots to nenosūtīja, tāpēc lietotne nevar lūgt atļauju iztērēt monētas. Atsvaidzini sarakstu vai pievienojies izaicinājumam GuruShots vietnē.',
    discoverRecommended: 'GuruShots ieteikts',
    discoverJoin: 'Pievienoties',
    discoverJoinPaid: 'Pievienoties (maksas)',
    discoverJoinLabel: 'Pievienoties izaicinājumam „{title}”',
    discoverJoinPaidLabel: 'Pievienoties (maksas) izaicinājumam „{title}”, monētas: {coins}',
    discoverJoining: 'Pievienojas…',
    discoverChecking: 'Pārbauda…',
    discoverPendingNoPhoto:
        'Monētas jau iztērētas, bet neviens foto neder. Pievieno piemērotu foto un nospied „Mēģināt iesniegt vēlreiz” — monētas netiks ieturētas atkārtoti. Var neļaut izvēlēties arī tagu uzstādījumi.',
    discoverUnconfirmed:
        'Par maksājumu atbildes nav; tas varētu būt izdevies. Atkārtojot iesniedz tikai foto, neietur divreiz. Ja vietnē redzams, ka monētas nav ieturētas, spied „Monētas netika ieturētas” un pievienojies.',
    discoverForgetPayment: 'Monētas netika ieturētas',
    discoverForgetPaymentLabel: 'Monētas netika ieturētas: {title}',
    discoverForgetTitle: 'Aizmirst šo maksājumu?',
    discoverForgetBody:
        'Pārbaudi monētu vēsturi vietnē; turpini tikai tad, ja monētas par „{title}” netika ieturētas, citādi tās ieturēs otrreiz. Pēc aizmiršanas automātiskā pievienošanās var budžeta ietvaros atkal maksāt.',
    discoverForgetBalances:
        'Monētas pirms maksājuma: {before}; GuruShots tagad rāda: {now}. Citas monētu darbības kopš tā laika (balvas, citas pievienošanās) maina starpību, tāpēc izšķiroša ir vēsture vietnē.',
    discoverForgetBalanceBefore:
        'Monētas pirms šī maksājuma: {before}. Salīdzini ar atlikumu GuruShots vietnē: lietotne nevar noteikt, vai maksājums izdevās, un citas monētu darbības kopš tā laika maina starpību.',
    discoverForgetConfirm: 'Monētas netika ieturētas — aizmirst',
    discoverForgetWorking: 'Notiek aizmiršana…',
    discoverForgetNothing:
        'Nebija ko aizmirst: maksājums jau ir apstiprināts vai pievienošanās ir pabeigta. Atsvaidzini sarakstu.',
    discoverForgetBusy:
        'Pašlaik notiek pievienošanās šim izaicinājumam vai saglabātos maksājumu ierakstus izmanto cita lietotnes daļa. Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    discoverForgetNotAuthenticated:
        'Neesi pieteicies, tāpēc nekas netika mainīts. Piesakies no jauna un mēģini vēlreiz.',
    discoverForgetUnreadable:
        'Saglabātos maksājumu ierakstus neizdevās nolasīt; nekas netika mainīts. Restartē un mēģini vēlreiz. Ja atkārtojas, joinState.json nav nolasāms: pārbaudi monētu vēsturi, pārvieto failu malā, restartē.',
    discoverForgetUnreadableAndroid:
        'Saglabātos maksājumu ierakstus neizdevās nolasīt; nekas netika mainīts. Restartē un mēģini vēlreiz. Ja atkārtojas, „Lietotnes uzstādījumi” → „Par lietotni un datiem” → „Dzēst visus vietējos datus…” (izrakstīs un atiestatīs).',
    discoverForgetFailed: 'Pašlaik neizdevās aizmirst maksājumu. Nekas netika mainīts. Mēģini vēlreiz pēc brīža.',
    discoverAlreadyJoined:
        'Šis konts jau ir pievienojies šim izaicinājumam, tāpēc nekas netika iztērēts. Saraksts atjaunosies nākamajā pārbaudē.',
    discoverConfirmDialogFirst: 'Vispirms apstiprini vai aizver atvērto logu, tad pievienojies vēlreiz.',
    discoverRetrySubmit: 'Mēģināt iesniegt vēlreiz',
    discoverRetrySubmitLabel: 'Mēģināt vēlreiz iesniegt izaicinājumam „{title}”',
    discoverConfirmTitle: 'Pievienoties maksas izaicinājumam?',
    discoverConfirmBody: 'Pievienošanās izaicinājumam „{title}” maksā monētas: {coins}.',
    discoverConfirmBalance: 'Monētu atlikums: {current}; maksa: {cost}; paliks: {resulting}.',
    discoverConfirmBalanceUnknown: 'Neizdevās nolasīt tavu pašreizējo monētu atlikumu.',
    discoverConfirmInsufficient:
        'Monētu atlikums: {current}, bet šis izaicinājums maksā {cost} — ar to nepietiek, lai pievienotos. Nopelni vairāk monētu un mēģini vēlreiz.',
    discoverConfirmSpend: 'Tērēt monētas: {coins}',
    // Atklāšanas pievienošanās rezultāti
    discoverJoined: 'Pievienojies.',
    discoverUnaffordable: 'Nepietiek monētu, lai pievienotos (vajag {coins}, tev ir {have}).',
    discoverGenericError: 'Neizdevās pievienoties — mēģini vēlreiz.',
    discoverBalanceUnknown: 'Neizdevās nolasīt monētu atlikumu — pievienošanās nenotika.',
    discoverChargedPending:
        'Monētas tika norakstītas, bet pievienošanās netika pabeigta. Mēģini iesniegt vēlreiz — otrreiz monētas netiks norakstītas.',
    discoverFailedNoCharge: 'Neizdevās pievienoties. Monētas netika norakstītas.',
    discoverNoPhoto: 'Nav piemērota foto, ko iesniegt. Monētas netika norakstītas.',
    discoverUnavailable: 'Šim izaicinājumam vairs nevar pievienoties.',
    discoverNotStarted: 'Šis izaicinājums vēl nav sācies. Pievienoties varēs, kad tas sāksies.',
    discoverPriceChanged:
        'Cena mainījusies — tagad monētas: {coins}. Nekas netika iztērēts; nospied „Pievienoties”, lai apstiprinātu jauno cenu.',
    discoverBusy: 'Pievienošanās jau notiek. Mēģini vēlreiz pēc brīža.',
    validationOutOfRange: 'Ievadi vērtību no {min} līdz {max}.',
    validationAtLeast: 'Ievadi vērtību, kas nav mazāka par {min}.',
    autoSubmitBadge: 'automātiskā iesniegšana',
    manualPhotosBadge: 'tikai manuāli',
    teamMatchVs: 'Komandu mačs pret {opponent}',
    teamMatchVotes: 'Mūsējie {us} · Pretinieki {them}',
    teamMatchAhead: 'vadībā',
    teamMatchBehind: 'atpaliek',
    teamMatchTied: 'neizšķirts',
    teamStandingActive: 'Tu #{position} · sastāvā',
    teamStandingOverStandby: '+{votes} balsis virs rezervista',
    teamStandingStandby: 'Rezervists · {votes} balsis līdz sastāvam',
    teamMatchNotRunning: 'Mačs nenotiek',
    teamChallenge: 'Komandu mačs',
    customBadge: 'pielāgots',
    customSettingsHint: 'Ir pielāgoti uzstādījumi',
    mustIncludeTags: 'Obligātie tagi',
    mustIncludeTagsDesc:
        'Stingrs filtrs automātiskai iesniegšanai un manuālajām pogām: jāsakrīt ar VISIEM tagiem (tagus nosaka automātiski). Tukšs = visi. Veseli vārdi, reģistrs nav svarīgs: „cat” der „cats”, ne „catamaran”.',
    shouldIncludeTags: 'Vēlamie tagi',
    shouldIncludeTagsDesc:
        'Vēlamais kritērijs automātiskai iesniegšanai un manuālajām pogām: atbilstošie foto iegūst augstāku vietu, nekas netiek izslēgts; ja nekas nesakrīt, kārto kā parasti. Tie paši vārdu noteikumi.',
    chosenPhotos: 'Izvēlētie foto',
    chosenPhotosDesc:
        'Foto, ko automātiskā pievienošanās un iesniegšana mēģina pirmos; tiem jāiztur tagu uzstādījumi, un tos kārto kā pašas izvēles vai tavā secībā (uzstādījums zemāk). Vienam foto tikai viens izaicinājums.',
    chosenPhotosInOrder: 'Izmantot izvēlētos foto tādā secībā, kādā tos izvēlējos',
    chosenPhotosInOrderDesc:
        'Iesniedz izvēlētos foto tavā izvēles secībā (numuri izvēlnē), nevis kārtojot. Neizmantojamus izlaiž un ņem nākamo; atlikušās vietas aizpilda pēc kārtojuma. Pēc noklusējuma izslēgts.',
    chosenPhotosOnly: 'Iesniegt tikai izvēlētos foto',
    chosenPhotosOnlyDesc:
        'Automātiskā pievienošanās un iesniegšana neizvēlas pašas — bez derīga izvēlētā foto izaicinājumu izlaiž. Manuālās pogas tomēr izvēlas; apmaksātā pievienošanās iesniedz foto, lai monētas nepazūd.',
    chosenPhotosCount: 'Izvēlēto foto: {count}',
    choosePhotos: 'Izvēlēties foto',
    photosClear: 'Notīrīt',
    photosUseNone: 'Neizmantot nevienu',
    photosUseNoneHint:
        'Šajā izaicinājumā netiek izmantoti izvēlētie foto, pat ja globālajos noklusējumos vai kādā noteikumā ir saraksts. Atiestatīšanas poga blakus šim laukam atgriež mantoto sarakstu.',
    chosenPhotoThumbAlt: 'Izvēlētais foto {n}: {id}',
    chosenPhotosScenarioHint:
        'Scenārija izvēlētie foto tiek izmantoti tikai pēc pievienošanās izaicinājumam; pievienojoties tie netiek ņemti vērā.',
    chosenPhotosOnlyReachHint:
        'Tas attiecas uz katru izaicinājumu, ko aptver: automātiskā pievienošanās un iesniegšana izlaiž katru izaicinājumu, kuram nav derīga izvēlētā foto.',
    photoChooserTitle: 'Izvēlēties foto',
    photoRecommended: 'Ieteiktais foto',
    photoChooserHelpAuto:
        'Tos izmanto pirmos, bet tiem jāiztur tagu filtri. Kārto kā pašas izvēles vai tavā secībā, ja tas uzstādīts. Neko nelasa, līdz ielādē, meklē vai spiež „Automātiski”.',
    photoChooserHelpChallenge:
        'Tos izmanto pirmos, bet tiem jāiztur tagu filtri. Kārto kā pašas izvēles vai tavā secībā, ja tas uzstādīts (noteikums vai izaicinājums pēc pievienošanās). Neko nelasa, līdz ielādē vai meklē.',
    photoChooserHelpNoChallenge:
        'Tos izmanto pirmos, bet tiem jāiztur tagu filtri; ko izaicinājums pieņem, pārbauda iesniedzot. Kārto kā pašas izvēles vai tavā secībā, ja tas uzstādīts.',
    photoChooserSearchLabel: 'Meklēt savus foto pēc taga',
    photoChooserSearchPlaceholder: 'piem., saulriets…',
    photoChooserSearch: 'Meklēt',
    photoChooserCount: 'Izvēlēto foto: {count} no {max}',
    photoChooserLoading: 'Ielādē tavus foto…',
    photoChooserLoadError: 'Tavus foto neizdevās ielādēt (sīkāka informācija ir zemāk). Mēģini vēlreiz.',
    photoChooserLoadErrorNoDetail: 'Tavus foto neizdevās ielādēt — pieprasījums tika pārtraukts. Mēģini vēlreiz.',
    photoChooserRetry: 'Mēģināt vēlreiz',
    photoChooserNoContext:
        'Tavus foto vēl nevar parādīt: bibliotēku nolasa caur izaicinājumu, bet aktīva vai pievienojama izaicinājuma šobrīd nav. Pievienojies kādam vai uzgaidi un mēģini vēlreiz.',
    photoChooserEligibilityLater:
        'Šeit netiek pārbaudīts, vai foto der kādam izaicinājumam; to pārbauda iesniegšanas brīdī.',
    photoChooserShowing: 'Rāda {count} foto.',
    photoChooserWonHidden:
        'Paslēpti foto, kas uzvarējuši izaicinājumā: {count}. Uzvarējušo foto nevar iesniegt vēlreiz.',
    photoChooserWonHiddenTruncated:
        'Paslēpti foto, kas uzvarējuši izaicinājumā: vismaz {count}. Uzvarējušo foto nevar iesniegt vēlreiz. Spied „Ielādēt vairāk foto”, lai meklētu vēl.',
    photoChooserRefusedHidden: 'Paslēpti foto, ko GuruShots šajā izaicinājumā nepieņem: {count}.',
    photoChooserRefusedHiddenTruncated:
        'Paslēpti foto, ko GuruShots šajā izaicinājumā nepieņem: vismaz {count}. Spied „Ielādēt vairāk foto”, lai meklētu citus.',
    photoChooserNoneAccepted:
        'GuruShots šajā izaicinājumā nepieņem nevienu no uzskaitītajiem foto. Meklē pēc taga, lai atrastu citus, vai augšupielādē jaunus foto un spied „Atsvaidzināt”.',
    photoChooserNoneAcceptedTruncated:
        'GuruShots šajā izaicinājumā nepieņem nevienu no līdz šim ielādētajiem foto. Spied „Ielādēt vairāk foto” vai meklē pēc taga. Ja nekas neder, augšupielādē jaunus foto un spied „Atsvaidzināt”.',
    photoChooserWonInList:
        'Uzvarējis izaicinājumā, tāpēc to nevar iesniegt vēlreiz. Noklikšķini uz tā, lai to noņemtu no saraksta.',
    photoChooserEmpty:
        'Foto nav atrasti. Pamēģini citu tagu vai augšupielādē foto savā GuruShots bibliotēkā un spied „Atsvaidzināt”.',
    photoChooserEmptyAllWon:
        'Nav atrasts neviens foto, ko var iesniegt: visi atrastie foto ir uzvarējuši izaicinājumā. Pamēģini citu tagu vai augšupielādē jaunus foto savā GuruShots bibliotēkā un spied „Atsvaidzināt”.',
    photoChooserAsOf: 'Foto ielādēti plkst. {time}',
    photoChooserAsOfDate: 'Foto ielādēti {date} plkst. {time}',
    photoChooserRefresh: 'Atsvaidzināt',
    photoChooserRefreshLabel: 'Atsvaidzināt foto',
    photoChooserPreviewNoChallenge:
        'Rāda tavus foto, kā tie ielādēti iepriekš, kamēr lietotne pārbauda, vai nav kas jauns…',
    photoChooserRecheckFailed:
        'Neizdevās pārbaudīt, kuri no šiem foto der šim izaicinājumam, tāpēc tie rādīti, kā ielādēti iepriekš. Spied „Atsvaidzināt”.',
    photoChooserRecheckFailedNoChallenge:
        'Neizdevās pārbaudīt, vai tavos foto nav izmaiņu, tāpēc tie rādīti, kā ielādēti iepriekš. Spied „Atsvaidzināt”.',
    photoChooserRecheckFailedSubmit:
        'Neizdevās pārbaudīt, kuri no šiem foto der šim izaicinājumam, tāpēc izvēle ir aizturēta. Spied „Atsvaidzināt”.',
    photoChooserNotAsLoaded: 'Nav starp taviem foto, kā tie ielādēti iepriekš. Pārbauda vēlreiz…',
    photoChooserNotAsLoadedFailed:
        'Nav starp taviem foto, kā tie ielādēti iepriekš. Lai pārbaudītu vēlreiz, spied „Atsvaidzināt”.',
    photoChooserMissing: 'Nav pieejams šim izaicinājumam (atrodas citā izaicinājumā vai ir dzēsts)',
    photoChooserMissingNoChallenge: 'Tavā bibliotēkā nav atrasts (iespējams, tas ir dzēsts)',
    photoChooserMissingSearch:
        'Nav starp šiem meklēšanas rezultātiem. Pamēģini citu tagu vai spied „Ielādēt foto” — tas nolasa bibliotēku no sākuma, tāpēc, iespējams, vajadzēs vēl „Ielādēt vairāk foto”, lai to atrastu.',
    photoChooserMissingTileLabel: 'Izvēlētais foto {id}: {reason}',
    photoChooserListFull: 'Saraksts ir pilns',
    photoChooserLimitReached: 'Sasniegts ierobežojums — noņem kādu, lai pievienotu citu.',
    photoChooserNotEligible: 'Neder šim izaicinājumam',
    photoChooserAllowed: 'Var iesniegt',
    photoChooserTileLabel: 'Foto {id}: {labels}. {reason}',
    photoChooserPosition: 'Numurs {n} tavā sarakstā.',
    photoChooserNoTags: 'Bez tagiem',
    photoChooserInheritNote:
        'Ja saglabāsi, neko neizvēloties, šim izaicinājumam paredzētais saraksts tiks izņemts, un izaicinājums atkal izmantos sarakstu no taviem uzstādījumiem vai noteikumiem.',
    photoChooserIdle: 'Tavi foto vēl nav ielādēti. Ielādē foto vai meklē.',
    photoChooserIdleAuto: 'Tavi foto vēl nav ielādēti. Ielādē foto, meklē vai spied „Automātiski”.',
    photoChooserIdlePicks:
        'Tavi izvēlētie foto paliek izvēlēti. Ielādē foto vai meklē, lai redzētu pārējo bibliotēku un pārbaudītu tos.',
    photoChooserIdlePicksAuto:
        'Tavi izvēlētie foto paliek izvēlēti. Ielādē foto, meklē vai spied „Automātiski”, lai redzētu vairāk.',
    photoChooserAutoHelp:
        '„Automātiski” sarindo foto pēc automātiskās iesniegšanas noteikumiem un, kur pieejams, ar vietējo attēlu pārbaudi. Nekas nesaglabājas; vēlreiz nospiežot, redzēsi nākamos.',
    photoChooserAutoRunning: 'Foto tiek sarindoti… tas var aizņemt minūti. Nekas netiek saglabāts.',
    photoChooserSavedTileLabel: 'Izvēlētais foto {id}: {reason}',
    photoChooserSavedTileNote: 'Vēl nav ielādēts',
    photoChooserUnreachedTileNote: 'Vēl nav starp ielādētajiem foto; spied „Ielādēt vairāk foto”, lai to meklētu.',
    photoChooserUnreachedTileNoteSearch:
        'Vēl nav starp meklēšanas rezultātiem. „Ielādēt vairāk foto” to atradīs, ja foto ir šis tags; „Ielādēt foto” nolasa tavu bibliotēku no sākuma, tāpēc pēc tam, iespējams, vajadzēs „Ielādēt vairāk foto”.',
    photoChooserLoadMoreFailed:
        'Neizdevās ielādēt vairāk foto. Nolasīšana tika pārtraukta. Spied „Ielādēt vairāk foto”, lai mēģinātu vēlreiz.',
    photoChooserTileLocked: 'Aizslēgts, līdz tavs saglabātais saraksts ir nolasīts',
    photoChooserSaveError: 'Izvēlētos foto neizdevās saglabāt, jo uzstādījumu nevarēja ierakstīt. Mēģini vēlreiz.',
    photoChooserPinHelp:
        'Piespraud izvēlēto foto Boost vai Turbo. Piespraudes saglabājas ar „Izmantot šos foto” un stājas spēkā, kad foto ir izaicinājumā.',
    photoChooserPinElsewhere: '{kind} piespraude ir uz foto, kas šajā sarakstā nav.',
    photoChooserPinsUnreadable:
        'Piespraudes nevarēja nolasīt, tāpēc tās šeit nevar mainīt. Aizvēri un atver to vēlreiz, lai mēģinātu atkal.',
    photoChooserPinSaveError:
        'Izvēlētie foto ir saglabāti, bet {kind} piespraude nav saglabāta: {reason} Spied „Izmantot šos foto”, lai mēģinātu vēlreiz.',
    photoChooserPinSaveErrorBoth:
        'Izvēlētie foto ir saglabāti, bet Boost un Turbo piespraudes nav saglabātas: {reason} Spied „Izmantot šos foto”, lai mēģinātu vēlreiz.',
    photoChooserPinGroup: 'Izvēlētā {n}. foto piespraudes',
    photoChooserDiscardTitle: 'Atmest izmaiņas?',
    photoChooserDiscardText:
        'Izvēlētie foto ir mainīti, bet nav saglabāti. Ja aizvērsi tagad, šīs izmaiņas pazudīs. Izvēlies „Atcelt”, lai turpinātu izvēli, un tad spied „Izmantot šos foto”.',
    photoChooserDiscard: 'Atmest izmaiņas',
    settingsDiscardTitle: 'Atmest izmaiņas?',
    settingsDiscardText:
        'Šajos uzstādījumos ir izmaiņas, kas nav saglabātas. Ja aizvērsi tagad, tās pazudīs. Izvēlies „Turpināt rediģēt”, lai atgrieztos, un tad spied „Saglabāt”.',
    settingsDiscard: 'Atmest izmaiņas',
    settingsKeepEditing: 'Turpināt rediģēt',
    settingsDropTitle: 'Saglabāt bez daļas darba?',
    settingsDropText:
        'Saglabāšana ieraksta uzstādījumus, bet ne tālāk minētos elementus. Tie pazudīs, kad logs aizvērsies. Izvēlies „Turpināt rediģēt”, lai vispirms tos sakārtotu.',
    settingsSaveWithout: 'Saglabāt bez tiem',
    settingsDropTimezone: 'Pielāgota laika josla, ko ievadīji, bet nepievienoji',
    settingsDropScenario: 'Scenārijs, ko rediģē un neesi saglabājis',
    settingsFilterPlaceholder: 'Filtrēt uzstādījumus…',
    settingsFilterClear: 'Notīrīt',
    settingsJumpLabel: 'Iestatījumu sadaļas',
    tabHasErrors: 'ir kļūdas',
    tabOverrideCount: 'Manuāli pielāgoti: {0}',
    settingsNoMatch: 'Nav atbilstošu uzstādījumu',
    hide: 'Paslēpt',
    photoChooserUse: 'Izmantot šos foto',
    fillPick: 'Izvēlēties foto…',
    fillPickLabel: 'Izvēlēties, kurus foto iesniegt tagad',
    pickTitle: 'Izvēlēties iesniedzamos foto',
    pickHelp:
        'Izvēlētie foto šim izaicinājumam tiek iesniegti uzreiz un tieši tādi, kādus izvēlējies: tavi tagu filtri un uzstādījums „Izvēlētie foto” netiek piemēroti, un nekas netiek saglabāts.',
    pickCount: 'Izvēlēti: {count}, brīvās vietas: {max}',
    pickOverCap: 'Izvēlēti: {count}, brīvās vietas: {max}. Noņem dažus, lai iesniegtu.',
    pickFull: 'Visām brīvajām vietām foto izvēlēti',
    pickTileLocked: 'Aizslēgts, kamēr lietotne pārbauda, vai tas der šim izaicinājumam.',
    pickTileSubmitting: 'Aizslēgts, kamēr tava izvēle tiek iesniegta.',
    pickNoSlots: 'Brīvu vietu vairs nav: katrā vietā jau ir foto. Aizver šo dialoglodziņu.',
    pickSubmit: 'Iesniegt',
    pickSubmitCount: 'Iesniegt {count} foto',
    pickAuto: 'Automātiski',
    pickAutoNext: 'Nākamie ieteikumi',
    pickAutoHelp:
        'Šī poga sarindo tavus foto pēc automātiskās iesniegšanas noteikumiem un, kur pieejams, ar vietējo attēlu pārbaudi. Nekas netiek iesniegts; vēlreiz nospiežot, redzēsi nākamos.',
    pickLoadPhotos: 'Ielādēt foto',
    pickLoadMore: 'Ielādēt vairāk foto',
    pickIdle: 'Foto vēl nav ielādēti. Ielādē foto, meklē vai izmanto pogu „Automātiski”.',
    pickIdleWithPicks: 'Izvēlētos foto var iesniegt jau tagad. Ielādē foto vai meklē, lai redzētu pārējo bibliotēku.',
    pickAutoRunning: 'Foto tiek sarindoti… tas var aizņemt minūti. Nekas netiek iesniegts.',
    pickSuggestedTitle: 'Ieteikumi',
    pickSuggestedCount: 'Ieteikumi: {count}',
    pickSuggestedStatsLimited:
        'Popularitātes statistiku neizdevās nolasīt pilnībā (pieprasījumi turpināja neizdoties), tāpēc rindojums balstās uz tagiem un attēlu pārbaudi.',
    pickSuggestionRank: 'Ieteikums Nr. {n}',
    pickAddSuggestions: 'Pievienot ieteikumus',
    pickAddSuggestionsFull: 'Nav brīvu vietu',
    swapPick: 'Nomainīt ar…',
    swapPickLabel: 'Izvēlēties foto no bibliotēkas, ar ko apmainīt',
    swapPickTitle: 'Izvēlies foto, ar ko apmainīt',
    swapPickHelp:
        'Izvēlētais foto aizstāj pašreizējo; nederīgie ir paslēpti. „Automātiski” kārto pēc tagu noteikumiem un „Izvēlētie foto” — pašam izvēlēts tos apiet. Nekas netērē, kamēr neapstiprini.',
    swapPickAutoHelp:
        'Šī poga sarindo tavus foto pēc automātiskās iesniegšanas noteikumiem un, kur pieejams, ar vietējo attēlu pārbaudi. Nekas netiek apmainīts; vēlreiz nospiežot, redzēsi nākamos.',
    swapPickAutoRunning: 'Foto tiek sarindoti… tas var aizņemt minūti. Nekas netiek tērēts.',
    swapPickIdleWithPicks:
        'Izvēlēto foto var izmantot jau tagad. Ielādē foto vai meklē, lai redzētu pārējo bibliotēku.',
    swapPickCount: 'Izvēlēts: {count}/1',
    swapPickSubmit: 'Izmantot šo foto',
    swapPickBlocked: 'Jau iesniegts šajā izaicinājumā',
    swapPickNoSuggestion: 'Lietotne neatrada foto, ko ieteikt šai apmaiņai. Izvēlies foto no savas bibliotēkas.',
    discoverChosenChip: 'Izvēlētie foto',
    discoverChosenChipHint: 'Šim izaicinājumam ir izvēlēti foto. Spied, lai tos mainītu.',
    discoverChosenChipLabel: 'Izvēlētie foto izaicinājumam „{title}”: mainīt',
    discoverChoosePhotosLabel: 'Izvēlēties foto izaicinājumam „{title}”',
    discoverChosenInherited: 'Mantotie izvēlētie foto: {count} (no taviem uzstādījumiem vai noteikumiem)',
    discoverConfirmChosen: 'Tavs izvēlētais foto, ja tas der, citādi automātiski izvēlēts foto.',
    scenarioFlagged:
        'Pārskati pirms importa: {settings}. „Iesniegt tikai izvēlētos foto” liek izlaist izaicinājumu, kuram nav derīga izvēlētā foto.',
    scenarioExportOmitted: 'Eksportā nav iekļauts, jo pieder tavam kontam: {settings}.',
    ignoreTitleWords: 'Ignorēt šos vārdus izaicinājumu nosaukumos',
    ignoreTitleWordsDesc:
        'Izņem no nosaukuma pirms foto meklēšanas; liekie vārdi aizmiglo tēmu un tērē izaicinājuma nedaudzās meklēšanas reizes. Saraksts aizpildīts; izņem vārdu, ja izaicinājums tiešām ir par to.',
    submitWithoutTagMatch: 'Iesniegt arī bez tagu sakritības',
    submitWithoutTagMatchDesc:
        'Attiecas tikai pie obligātajiem tagiem. Ieslēgts (noklusējums): ja neviens foto nesakrīt ar visiem tagiem, tomēr pievieno labāko, lai vieta nav tukša. Izslēgts: vieta paliek tukša līdz sakritībai.',
    emergencySubmit: 'Ārkārtas iesniegšana',
    emergencySubmitDesc:
        'Pēdējās minūtēs labākie foto aizpilda tukšās vietas arī pret tagu noteikumiem un „Iesniegt tikai izvēlētos foto”; darbojas arī Boost un iegūtais Turbo. 0 = izslēgts, arī Boost/Turbo glābšana.',
    emergencySubmitHelp:
        'Laiks līdz beigām. 0 izslēdz to pilnībā, arī pēdējās minūtes Boost/Turbo glābšanu — atšķirībā no redzamības mērķa uzstādījumiem, kur 0 nozīmē „sekot slieksnim”.',
    tagsPlaceholder: 'piem., saulriets, pludmale, okeāns',
    titleTagRules: 'Izaicinājumu noteikumi',
    titleTagRulesDesc:
        'Piešķir izaicinājumiem profilu, pievienošanās laiku un foto tagus pēc rotācijā nemainīgām pazīmēm: nosaukums, tags, veids, foto skaits, ilgums. Darbojas arī ar jaunu id; manuālie uzstādījumi uzvar.',
    titleTagRulesSaveError:
        'Noteikumi nesaglabāti. Pārbaudi profilu nosaukumus, tagu garumus, diapazonus („Ilgst vismaz” ≤ „Ilgst ne vairāk kā”), beigu laikus (HH:MM) un pretrunas ar manuālajiem. Pārējie saglabāti.',
    titleTagRulesLoadError:
        'Neizdevās ielādēt izaicinājumu noteikumus, tāpēc tie ir paslēpti, lai tos nepārrakstītu. Pārējos uzstādījumus joprojām var saglabāt; lai mēģinātu vēlreiz, aizver uzstādījumus un atver tos no jauna.',
    titleTagRuleTitle: 'Izaicinājuma nosaukums',
    titleTagRuleTitlePlaceholder: "piem., Let's See Hats",
    titleRuleTitlesLabel: 'Izaicinājumu nosaukumi (pietiek ar vienu)',
    addTitleRuleTitle: 'Pievienot nosaukumu',
    removeTitleRuleTitle: 'Noņemt nosaukumu',
    titleRuleMatch: 'Nosaukuma atbilstība',
    titleRuleMatchExact: 'Ir tieši',
    titleRuleMatchStarts: 'Sākas ar',
    titleRuleMatchContains: 'Satur',
    titleRuleConditionsLabel: 'Atbilst, ja',
    titleRuleConditionsHint:
        'Katram aizpildītajam laukam jāatbilst; tukšus neņem vērā. Izaicinājuma tags ir paša izaicinājuma, nevis foto tags. Ilgums no sākuma līdz beigām. Beigu laiks ir kartītes laiks lietotnes laika joslā.',
    titleRuleChallengeTag: 'Izaicinājuma tags',
    titleRuleChallengeTagPlaceholder: 'piem., Exhibition',
    titleRuleType: 'Izaicinājuma veids',
    titleRuleTypePlaceholder: 'Jebkurš veids',
    titleRulePics: 'Foto',
    titleRuleAnyPics: 'Jebkāds skaits',
    titleRuleMinHours: 'Ilgst vismaz',
    titleRuleMaxHours: 'Ilgst ne vairāk kā',
    titleRuleClosesAt: 'Beigu laiki (pietiek ar vienu)',
    titleRuleClosesAtRow: 'Beigu laiks',
    addCloseTime: 'Pievienot laiku',
    removeCloseTime: 'Noņemt laiku',
    titleRuleClosesAtInvalid:
        'Šis saglabātais laiks nav derīgs (jāizmanto HH:MM), tāpēc noteikums neatbilst nevienam izaicinājumam. Izvēlies citu laiku vai noņem šo.',
    titleRuleAnyLength: 'jebkāds',
    titleRuleProfile: 'Automātiskais profils',
    titleRuleInherit: 'Noklusējums',
    titleRuleOn: 'Ieslēgts',
    titleRuleOff: 'Izslēgts',
    titleRuleAutoJoin: 'Automātiski pievienoties',
    titleRuleAutoSubmit: 'Automātiskā iesniegšana',
    titleRulePercentElapsed: 'Pievienoties pēc',
    titleRuleJoinWindow: 'Vai stundas pirms beigām',
    titleRuleJoinWindowPlaceholder: 'noklusējums',
    titleRuleOverridesLabel: 'Uzvedība',
    titleRuleBroadWarning:
        'Šim noteikumam nav nosaukuma, tāpēc tas ieslēdz šo iespēju katram atbilstošajam izaicinājumam — tas var tērēt monētas vai foto veselai izaicinājumu grupai.',
    titleRuleOrderHint:
        'Noteikumus pārbauda no augšas uz leju: katram uzstādījumam uzvar pirmais atbilstošais noteikums, kas to uzstāda; ko tas atstāj tukšu, ņem no nākamā, tad no globālā noklusējuma.',
    titleRuleSortDefault: 'Kārtot noklusējuma secībā',
    titleRuleMoveUp: 'Pārvietot noteikumu augstāk',
    titleRuleMoveDown: 'Pārvietot noteikumu zemāk',
    addTitleTagRule: 'Pievienot noteikumu',
    removeTitleTagRule: 'Noņemt noteikumu',
    noTitleTagRules:
        'Vēl nav noteikumu. Pievieno kādu, lai atlasītu izaicinājumus pēc nosaukuma, taga, veida, foto skaita, ilguma vai beigu laika.',
    usingProfile: 'Izmanto profilu',
    fromRule: 'No noteikuma: {title}',
    ruleNumber: 'Nr. {n}',
    ruleSettingsHint: 'Uzstādījumus nosaka izaicinājumu noteikums',
    none: '(nav)',
    addOnePhoto: 'Iesniegt vienu foto tukšā vietā',
    fillAllPhotos: 'Iesniegt foto visās tukšajās vietās tagad (bez intervāla)',
    cancel: 'Atcelt',
    // Keys, Swaps & Fills (currency automation) settings
    groupCurrencyAuto: 'Atslēgas, apmaiņas un uzpildes',
    autoKeyUnlock: 'Automātiski izmantot atslēgu',
    autoKeyUnlockDesc:
        'Iztērē atslēgu, lai atbloķētu šī izaicinājuma bloķēto Boost, kad pienācis zemāk norādītais laiks — tikai atbloķē; tad „Automātiski izmantot Boost” to izmanto pēc „Boost laiks (atbloķēts ar atslēgu)”.',
    autoKeyAfterStart: 'Atslēga: pēc laika no sākuma',
    autoKeyAfterStartDesc:
        'Izmantot atslēgu tikai tad, kad izaicinājums ilgst jau tik ilgi (piem., 11 h). 0 = bez nosacījuma.',
    autoKeyBeforeEnd: 'Atslēga: pēdējā laikā līdz beigām',
    autoKeyBeforeEndDesc:
        'Izmantot atslēgu tikai tad, kad līdz beigām atlicis tik daudz laika vai mazāk (piem., 7 h). 0 = bez nosacījuma.',
    autoKeyAfterPercent: 'Atslēga: pēc % no izaicinājuma',
    autoKeyAfterPercentDesc: 'Izmantot atslēgu tikai tad, kad pagājusi šī izaicinājuma daļa. 0 = bez nosacījuma.',
    autoSwap: 'Automātiski apmainīt foto',
    autoSwapDesc:
        'Iztērēt apmaiņu, lai kādu no taviem foto aizstātu ar piemērotāko foto no bibliotēkas, kad pienācis zemāk norādītais laiks. Uzstāda globāli, profilā vai atsevišķam izaicinājumam.',
    autoSwapAfterStart: 'Apmaiņa: pēc laika no sākuma',
    autoSwapAfterStartDesc: 'Apmainīt tikai tad, kad izaicinājums ilgst jau tik ilgi. 0 = bez nosacījuma.',
    autoSwapBeforeEnd: 'Apmaiņa: pēdējā laikā līdz beigām',
    autoSwapBeforeEndDesc: 'Apmainīt tikai tad, kad līdz beigām atlicis tik daudz laika vai mazāk. 0 = bez nosacījuma.',
    autoSwapAfterPercent: 'Apmaiņa: pēc % no izaicinājuma',
    autoSwapAfterPercentDesc: 'Apmainīt tikai tad, kad pagājusi šī izaicinājuma daļa. 0 = bez nosacījuma.',
    autoSwapImageIndex: 'Apmaināmais foto',
    autoSwapImageIndexDesc:
        'Kuru foto aizstāt: 1 = pirmo, 2 = otro utt. 0 = pēdējo. Foto ar Boost vai Turbo izlaiž un ņem iepriekšējo, ja vien zemāk tas nav atļauts.',
    autoSwapLowestVotes: 'Apmainīt foto ar vismazāk balsīm',
    autoSwapLowestVotesDesc: 'Neņemt vērā „Apmaināmais foto” un aizstāt to foto, kuram ir vismazāk balsu.',
    autoSwapAllowBoosted: 'Atļaut apmainīt foto ar Boost/Turbo',
    autoSwapAllowBoostedDesc:
        'Pēc noklusējuma foto ar Boost vai Turbo nekad neapmaina — Boost/Turbo paliek pie foto. Ieslēdz, lai to atļautu; tad kartīte piedāvās apmainīt sākotnējo foto atpakaļ.',
    autoSwapMaxVotes: 'Apmainīt tikai zem balsu skaita',
    autoSwapMaxVotesDesc:
        'Apmainīt tikai tad, ja izvēlētajam foto ir mazāk balsu par šo skaitu. 0 = bez balsu nosacījuma.',
    autoSwapMax: 'Maks. apmaiņu šajā izaicinājumā',
    autoSwapMaxDesc:
        'Pārtraukt automātisko apmaiņu, kad šajā izaicinājumā izdarīts tik daudz apmaiņu (manuālās arī skaitās).',
    autoExposureFill: 'Automātiski izmantot uzpildi',
    autoExposureFillDesc:
        'Iztērē uzpildi, lai paceltu redzamību līdz 100 %, — tikai ja tā ir zem zemāk norādītā sliekšņa UN balsot to nesasniedz. Parasti noder zibens izaicinājumos.',
    autoExposureFillBelow: 'Uzpildīt, ja redzamība zem',
    autoExposureFillBelowDesc:
        'Uzpildi tērē tikai tad, ja redzamība ir zem šīs vērtības un balsojot to sasniegt nevar.',
    autoExposureFillAfterStart: 'Uzpilde: pēc laika no sākuma',
    autoExposureFillAfterStartDesc: 'Uzpildīt tikai tad, kad izaicinājums ilgst jau tik ilgi. 0 = bez nosacījuma.',
    autoExposureFillBeforeEnd: 'Uzpilde: pēdējā laikā līdz beigām',
    autoExposureFillBeforeEndDesc:
        'Uzpildīt tikai tad, kad līdz beigām atlicis tik daudz laika vai mazāk. 0 = bez nosacījuma.',
    autoExposureFillAfterPercent: 'Uzpilde: pēc % no izaicinājuma',
    autoExposureFillAfterPercentDesc: 'Uzpildīt tikai tad, kad pagājusi šī izaicinājuma daļa. 0 = bez nosacījuma.',
    autoExposureFillMax: 'Maks. automātisko uzpilžu šajā izaicinājumā',
    autoExposureFillMaxDesc:
        'Pārtraukt automātisko uzpildi, kad šajā izaicinājumā automātiski iztērēts tik daudz uzpilžu.',
    currencyReserveKeys: 'Paturēt vismaz (atslēgas)',
    currencyReserveKeysDesc:
        'Automātiskā tērēšana nekad nesamazina atslēgu skaitu zem šīs vērtības. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
    currencyReserveSwaps: 'Paturēt vismaz (apmaiņas)',
    currencyReserveSwapsDesc:
        'Automātiskā tērēšana nekad nesamazina apmaiņu skaitu zem šīs vērtības. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
    currencyReserveFills: 'Paturēt vismaz (uzpildes)',
    currencyReserveFillsDesc:
        'Automātiskā tērēšana nekad nesamazina uzpilžu skaitu zem šīs vērtības. Manuālo tērēšanu no kartītes tas neierobežo. 0 = bez rezerves.',
    currencyRuleTimingHelp:
        'Katrai darbībai trīs neobligāti nosacījumi: pēc laika no sākuma, pēdējā laikā līdz beigām, pēc % — visiem uzstādītajiem jāizpildās; 0 = uzreiz. Katrā ciklā ne vairāk kā viens tēriņš; rezerve paliek.',
    groupGeneral: 'Vispārīgi',
    groupBoost: 'Boost',
    groupTurbo: 'Turbo',
    groupFinalWindow: 'Beigu loga redzamība',
    groupLastMinute: 'Pēdējā minūte',
    groupScheduledFill: 'Plānotā balsošana',
    groupVotingPause: 'Balsošanas pauze',
    groupAutoSubmit: 'Automātiskā iesniegšana',
    groupRewards: 'Balvas',
    groupMissions: 'Misijas',
    groupNotifications: 'Paziņojumi',
    groupDisplay: 'Attēlojums',
    tierCore: 'Pamata',
    tierEntries: 'Foto',
    tierOverrides: 'Laika noteikumi',
    tierOverridesDesc:
        'Visi pēc noklusējuma izslēgti — ieslēdz kādu tikai tad, ja vēlies mainīt, kad darbojas parastais redzamības noteikums.',
    tierApp: 'Lietotne',
    tierDefaultsNote: 'Noklusējumi visiem izaicinājumiem — katrs izaicinājums tos var aizstāt',
    tierOther: 'Citi',
    // Paziņojumu uzstādījumi (pēc noklusējuma izslēgti)
    autoClaimPrizes: 'Automātiski saņemt balvas',
    autoClaimPrizesDesc:
        'Automātiski saņem balvas par noslēgtajiem izaicinājumiem un izpildītajām misijām (automātiskajai balsošanai jādarbojas). Pārbauda ne biežāk kā reizi stundā. Pēc noklusējuma izslēgts.',
    missionSaveTurbos: 'Taupīt Turbo misijām',
    missionSaveTurbosDesc:
        'Aizturas katra izaicinājuma Turbo iegūšanu, lai misijai „Win Turbo” būtu ko iegūt. Pietaupīto Turbo iegūst, kad misija aktīva vai stundu pirms izmantošanas laika. Pēc noklusējuma izslēgts.',
    missionJoinEarly: 'Pievienoties nekavējoties misiju laikā',
    missionJoinEarlyDesc:
        'Kamēr aktīva misija „Join challenges” vai „Win Turbo”, pievienojas, negaidot automātiskās pievienošanās laiku, līdz misija izpildīta. Tipu, tagu un monētu filtri joprojām darbojas.',
    missionUseFills: 'Izmantot uzpildes misijām',
    missionUseFillsDesc:
        'Kamēr aktīva misija „Use Fill”, lietotne izmanto uzpildes izaicinājumos, kuros redzamība ir zem 100 %, līdz misija izpildīta. Uzpilžu rezerve paliek neskarta. Pēc noklusējuma izslēgts.',
    missionUseBoosts: 'Izmantot Boost misijām',
    missionUseBoostsDesc:
        'Kamēr aktīva misija „Use a boost”, izmanto jau pieejamu Boost, negaidot tā automātiskās izmantošanas laiku. Atslēgas netērē; Boost, kura laika uzstādījums 0 (izslēgts), neizmanto.',
    missionVote: 'Balsot misijām',
    missionVoteDesc:
        'Kamēr aktīva misija „Vote on photos”, balso katrā ciklā, negaidot redzamības slieksni, sadalot balsis pa izaicinājumiem līdz 100 % katram. Flash izlaiž. Noklusējumā izslēgts.',
    notifyOnBoost: 'Paziņot pirms Boost',
    notifyOnBoostDesc: 'Brīdina pirms Boost izmantošanas, lai paspētu atstāt lietotni ieslēgtu.',
    notifyOnTurbo: 'Paziņot pirms Turbo',
    notifyOnTurboDesc: 'Brīdina pirms Turbo spēles, lai paspētu atstāt lietotni ieslēgtu.',
    notifyOnAutoSubmit: 'Paziņot pirms automātiskās iesniegšanas',
    notifyOnAutoSubmitDesc:
        'Brīdina, pirms lietotne tuvu beigām automātiski iesniedz foto, lai paspētu atstāt lietotni ieslēgtu.',
    notifyOnEmergencySubmit: 'Paziņot pirms ārkārtas iesniegšanas',
    notifyOnEmergencySubmitDesc:
        'Brīdina pirms pēdējā brīža ārkārtas iesniegšanas, lai paspētu atstāt lietotni ieslēgtu.',
    notifyLeadTime: 'Cik laicīgi brīdināt',
    notifyLeadTimeDesc: 'Cik minūtes pirms darbības parādīt brīdinājumu.',
    notifyLeadTimeHelp:
        'Ne vienmēr precīzi: lietotne brīdina tikai pārbaudes brīdī, tāpēc, ja šis laiks ir garāks par pārbaudes biežumu, brīdinājums var pienākt vēlāk. Visdrošāk tas darbojas pēdējās minūtes logā.',
    // Paziņojuma virsraksta/teksta veidnes. {action} izmanto darbību
    // nosaukumus; {title} ir izaicinājuma nosaukums; {minutes}/{count}
    // aizpilda paziņojumu slānis.
    notifyTitle: 'Tuvojas: {action}',
    notifyBody: '{action} izaicinājumā „{title}” pēc ~{minutes} min — līdz tam atstāj lietotni atvērtu.',
    notifyGroupTitle: 'Tuvojas darbības',
    notifyGroupBody: 'Darbības nākamajās ~{minutes} min: {count}. Līdz tam atstāj lietotni atvērtu.',
    challengeName: 'Izaicinājums',
    challengeOverrides: 'Atsevišķu izaicinājumu uzstādījumi',
    challengeSettings: 'Izaicinājuma uzstādījumi',
    challengeSettingsDesc: 'Uzstādījumi tikai šim izaicinājumam. Tie aizstāj globālos noklusējumus.',
    checkForUpdates: 'Pārbaudīt atjauninājumus',
    checkForUpdatesDesc: 'Pārbaudīt, vai ir jaunāka versija, tagad, negaidot automātisko pārbaudi.',
    compactCards: 'Kompaktas kartītes',
    compactCardsDesc:
        'Rādīt izaicinājumus mazākās kartītēs, lai ekrānā ietilptu vairāk; izslēdz, lai redzētu pilna izmēra kartītes ar vairāk informācijas.',
    compactCardActions: 'Darbības kompaktajās kartītēs',
    compactCardActionsDesc:
        'Rādīt darbību pogas arī kompaktajās kartītēs, lai rīkotos bez pilnās kartītes. Darbības ar atsevišķiem foto paliek pilnajā kartītē.',
    compact: 'Kompakts',
    details: 'Detaļas',
    configureBoost: 'Boost uzstādījumi izaicinājumam:',
    currentVersion: 'Pašreizējā versija',
    cycles: 'Cikli:',
    downloadUpdate: 'Lejupielādēt atjauninājumu',
    ends: 'Beidzas',
    english: 'English',
    entries: 'Foto',
    entryDetails: 'Informācija par foto',
    entryPhoto: 'Iesniegtais foto',
    entrySubmitted: 'Iesniegts {time}',
    entrySubmittedOrEarlier: 'Iesniegts {time} vai agrāk',
    entrySubmittedOrEarlierLong:
        'Lietotne nepierakstīja, kad šis foto tika iesniegts. Norādītais laiks ir brīdis, kad lietotne to pirmoreiz ieraudzīja, tātad tas iesniegts šajā brīdī vai agrāk.',
    viewEntryPhoto: 'Skatīt iesniegto foto',
    error: 'Kļūda',
    errorCheckingUpdates: 'Kļūda, pārbaudot atjauninājumus',
    errorLoadingUiSettings: 'Kļūda, ielādējot saskarnes uzstādījumus',
    exposure: 'Redzamība',
    exposureDesc:
        'Redzamības procents, zem kura lietotne turpina balsot izaicinājumā. Noklusējums 100 nozīmē balsot līdz pilnai redzamībai.',
    exposureTarget: 'Redzamības mērķis',
    exposureTargetDesc:
        'Līdz kādam procentam balsot, kad nostrādā parastais redzamības noteikums (0 = tāds pats kā redzamības slieksnis)',
    exposureTargetHelp:
        '0 NENOZĪMĒ „izslēgts”. 0 nozīmē „balsot līdz redzamības sliekšņa vērtībai” — noteikums paliek aktīvs. 1–100 balsots tālāk par slieksni. Laika uzstādījumos ir otrādi: 0 nozīmē „izslēgts”.',
    fast: 'ĀTRS',
    global: 'Globāls',
    globalDefault: 'Globālais noklusējums',
    globalSettings: 'Globālie uzstādījumi',
    hours: 'stunda(s)',
    language: 'Valoda',
    languageDesc: 'Lietotnes saskarnes valoda (angļu vai latviešu).',
    lastMinuteThreshold: 'Pēdējās minūtes slieksnis',
    lastMinuteThresholdDesc:
        'Kad līdz beigām atlicis šis minūšu skaits, lietotne balso līdz 100 %, ignorējot sliekšņus; šajā logā darbojas „Balsot tikai pēdējās minūtes laikā” un „Pēdējās minūtes pārbaudes biežums”.',
    lastRun: 'Pēdējā palaišana:',
    latestVersion: 'Jaunākā versija',
    latvian: 'Latviešu',
    local: 'Vietējā',
    minutes: 'minūte(s)',
    missingConfigFor: 'Trūkst konfigurācijas:',
    next: 'Nākamais',
    noComm: 'Bez komentāriem',
    noEntries: 'Nav foto',
    noGlobalSettingsToDisplay: 'Nav globālu uzstādījumu, ko parādīt',
    noOverrides: 'Nevienam izaicinājumam nav atsevišķu uzstādījumu',
    noUiSettingsToDisplay: 'Nav saskarnes uzstādījumu, ko parādīt',
    noUpdatesAvailable: 'Nav pieejamu atjauninājumu',
    normal: 'NORMĀLS',
    of: 'no',
    onePhoto: '1 foto',
    manualPhotosOnly: 'Tikai manuāli',
    manualPhotosOnlyDesc:
        'Lietotne šajā izaicinājumā pati neko nedara: ne pievienošanās, foto iesniegšana vai apmaiņa, balsošana, Boost, Turbo, atslēgas, uzpilde, scenāriju soļi. Kartītes pogas darbojas; „Palaist” paslēpts.',
    manualOnlyLabel: '„Tikai manuāli” ir ieslēgts — nekas nenotiek automātiski',
    manualOnlyAlert:
        '„Tikai manuāli”: lietotne pati neko nedara — ne pievienošanās, iesniegšana, apmaiņa, balsošana, Boost, Turbo, atslēgas, uzpilde, scenāriji. Kartītes pogas darbojas; „Palaist” paslēpts.',
    manualPhotosOnlyRuleHint:
        'Kad ieslēgts „Tikai manuāli”, noteikuma izaicinājumos lietotne nebalso, neizmanto Boost un Turbo, nepievienojas un neiesniedz, ja vien paša uzstādījums to neizslēdz.',
    onlyBoost: 'Tikai Boost režīms',
    onlyBoostDesc: 'Šajā izaicinājumā pilnībā izlaist parasto balsošanu un tikai izmantot Boost.',
    voteOnNewEntry: 'Balsot par jaunu foto',
    voteOnNewEntryDesc:
        'Jauns foto šeit saņem vienu balsi arī virs sliekšņa, līdz izaicinājuma parastajai robežai; beigu logā — beigu loga mērķim. „Tikai Boost režīms” un pārējie ierobežojumi joprojām spēkā.',
    discoverUpcomingHours: 'Cik stundas uz priekšu rādīt gaidāmos izaicinājumus',
    discoverUpcomingHoursDesc:
        'Cik tālu „Atrast izaicinājumus” rāda vēl nesākušos izaicinājumus, lai foto varētu izvēlēties iepriekš. Pievienoties var tikai pēc sākuma. 0 = tikai atvērtie.',
    autovoteStartupDelay: 'Gaidīt pēc palaišanas, pirms atsākt automātisko balsošanu',
    autovoteStartupDelayDesc:
        'Ja lietotne aizvērta, kamēr balsošana bija ieslēgta, cik ilgi pēc palaišanas uzgaida, pirms atsāk pati, lai vari pārbaudīt uzstādījumus. Attiecas uz lietotni, ne komandrindu. 0 = izslēgts.',
    override: 'Pielāgots',
    overrideForChallenge: 'Pielāgot uzstādījumus izaicinājumam',
    photo: 'foto',
    photos: 'foto',
    noActiveChallenges: 'Nav aktīvu izaicinājumu',
    players: 'Spēlētāji',
    pleaseLogin: 'Piesakies, lai redzētu izaicinājumus',
    prerelease: 'Testa (beta) versija',
    prize: 'Balva',
    rank: 'Vieta',
    // Izaicinājuma detaļas: Top rezultāti, balvu pakāpes, treku nozīmītes
    benchmarkScore: 'Top {target}: {score} balsis',
    benchmarkGap: '+{n} balsis līdz top {target}',
    prizeTierTopPhotographer: 'Top fotogrāfs #{min}–{max}',
    prizeTierTopPhotographerSingle: 'Top fotogrāfs #{min}',
    prizeTierTopPhoto: 'Top foto #{min}–{max}',
    prizeTierTopPhotoSingle: 'Top foto #{min}',
    prizeKey: 'Atslēga',
    prizeCoins: 'Monētas',
    prizePhotoSwap: 'Foto apmaiņa',
    prizeExposureAutofill: 'Redzamības uzpilde',
    prizeUnknown: 'Balva',
    prizeAmount: '{name} × {amount}',
    trackTopPhotographer: 'Top fotogrāfs',
    trackTopPhoto: 'Top foto',
    trackGurusPick: 'Guru izvēle',
    rememberLoginSession: 'Atcerēties pieteikšanās sesiju',
    remindMeLater: 'Atgādināt vēlāk',
    removeCurrentTimezone: 'Noņemt pašreizējo laika joslu',
    resetToGlobal: 'Atiestatīt uz globālajiem',
    resetToDefault: 'Atiestatīt uz noklusējumu',
    resetToDefaultNotSaved: 'Atiestatīt uz noklusējumu (netiks saglabāts, kamēr nenospiedīsi „Saglabāt”)',
    resetAll: 'Atiestatīt visu',
    resetAllConfirmTitle: 'Atiestatīt visus uzstādījumus',
    resetAllConfirmMessage: 'Vai tiešām atiestatīt VISUS uzstādījumus uz noklusējumu?',
    resetAllConfirmDetails:
        'Atiestatīs saskarnes uzstādījumus, izaicinājumu noklusējumus, preferences, laika joslas, pieteikšanās preferences.\\n\\nPaliek: tokens, atjauninājumu pārbaudes laiks, testa režīms. Nevar atsaukt.',
    resetAllSuccess: 'Visi uzstādījumi ir atiestatīti. Lapa tiks pārlādēta, lai izmaiņas stātos spēkā.',
    save: 'Saglabāt',
    scrollToTop: 'Uz augšu',
    seconds: 'sekunde(s)',
    settings: 'Uzstādījumi',
    skipThisVersion: 'Izlaist šo versiju',
    speed: 'Ātrums',
    startAutoVote: 'Sākt automātisko balsošanu',
    statusWaiting: 'Gaida',
    resumeHold: 'Automātiskā balsošana atsāksies pēc {time}.',
    resumeHoldNote:
        'Līdz tam turi lietotni atvērtu — pēc palaišanas tā uzgaida, lai vari vispirms pārbaudīt uzstādījumus.',
    resumeStartNow: 'Sākt tūlīt',
    resumeCancel: 'Neatsākt',
    stayLoggedIn: 'Saglabāt pieteikšanos',
    stayLoggedInDesc: 'Saglabāt sesiju, lai pēc lietotnes aizvēršanas tu paliktu pieteicies.',
    stopAutoVote: 'Apturēt automātisko balsošanu',
    theme: 'Tēma',
    themeDesc: 'Izvēlies lietotnes krāsu tēmu.',
    time: 'Laiks',
    timezone: 'Laika josla',
    timezoneDesc: 'Laika josla, kurā rādīt izaicinājumu sākuma un beigu laikus tavā vietējā laikā.',
    timezonePlaceholder: 'Ievadi laika joslu',
    timezoneInvalid: 'Nederīga laika josla. Izmanto nosaukumu, piemēram, Europe/Riga.',
    uiSetting: 'Saskarnes uzstādījums',
    updateAvailable: 'Pieejams atjauninājums!',
    run: 'Palaist',
    running: 'Darbojas…',
    vote: 'Balsot',
    voteTitle:
        'Tagad nobalsot šajā izaicinājumā līdz 100 % (apiet automātiku; automātiskā balsošana turpina darboties)',
    voteAll: 'Balsot visur',
    voteToNextLevel: 'balsis līdz nākamajam līmenim',
    voted: 'Nobalsots!',
    votedAll: 'Visur nobalsots!',
    votes: 'Balsis',
    votesNeeded: 'balsis nepieciešamas',
    voting: 'Balso…',
    votingAll: 'Balso…',
    checkFrequency: 'Pārbaudes biežums',
    checkFrequencyDesc:
        'Katrs cikls izmanto nejauša garuma pauzi šajā diapazonā. Vienāds min un max nozīmē fiksētu biežumu.',
    checkFrequencyMin: 'Min',
    checkFrequencyMax: 'Max',
    reliability: 'Uzticamība',
    apiMaxRetries: 'Atkārtoti mēģinājumi',
    apiMaxRetriesDesc:
        'Cik reizes mēģināt neizdevušos pieprasījumu (0 = izslēgts): tīkla kļūdas, noildze, 429, 5xx. „Pauze starp mēģinājumiem” ir sākuma pauze ms, kas aptuveni dubultojas katrā mēģinājumā.',
    apiRetryBaseDelayMs: 'Pauze starp mēģinājumiem (ms)',
    voteOnlyInLastMinute: 'Balsot tikai pēdējās minūtes laikā',
    voteOnlyInLastMinuteDesc:
        'Pilnībā izlaist izaicinājumu, līdz tas sasniedz pēdējās minūtes sliekšņa logu, un tad balsot līdz 100 %. Tā balsošana notiek tikai pašās beigās, nevis visa izaicinājuma laikā.',
    lastMinuteCheckFrequency: 'Pēdējās minūtes pārbaudes biežums',
    lastMinuteCheckFrequencyDesc:
        'Cik bieži (minūtēs) pārbaudīt izaicinājumu, kad tas ir pēdējās minūtes sliekšņa robežās. Noklusējums 1 pārbauda katru minūti, lai nepalaistu garām noslēguma spurtu.',
    useScheduledFill: 'Izmantot plānoto balsošanu',
    useScheduledFillDesc:
        'Balsot līdz 100 % noteiktos laikos, nevis tikai zem sliekšņa — tikai balsošana, foto neiesniedz. Neattiecas uz Flash un „Tikai Boost režīms”. Ja lietotne izslēgta visu logu, logs zūd bez atkārtojuma.',
    scheduledFillTime: 'Balsošanas laiki',
    scheduledFillTimeDesc:
        'Ikdienas pulksteņa laiki (24 h), kuros atveras balsošanas logi, pēc uzstādījuma „Laika josla”, nevis ierīces pulksteņa. Katrs atver savu logu katru dienu; noņem visas rindas, lai izslēgtu.',
    scheduledFillTimeOff: 'laiki nav uzstādīti — izslēgts',
    scheduledFillBeforeEnd: 'Balsošana pirms beigām',
    scheduledFillBeforeEndDesc:
        'Vienreizēji balsošanas logi tik ilgi pirms beigām — piem., 10h un 4h, lai noslēguma dienā balsotu divreiz. Skaita no katra izaicinājuma beigām; noņem visas rindas, lai izslēgtu.',
    scheduledFillBeforeEndOff: 'intervāli nav uzstādīti — izslēgts',
    scheduledFillAddTime: 'Pievienot laiku',
    scheduledFillAddBeforeEnd: 'Pievienot intervālu',
    scheduledFillRemoveEntry: 'Noņemt rindu',
    scheduledFillEntryDraft: 'uzstādi laiku — rindas ar 0h 0min netiek saglabātas',
    scheduledFillDuplicateEntry: 'atkārtojas — šo rindu neņem vērā',
    scheduledFillMaxEntries: 'Sasniegts rindu maksimums: {0}.',
    scheduledFillSourceBeforeEnd: '{0} pirms beigām',
    scheduledFillWindowMinutes: 'Balsošanas logs (minūtes)',
    scheduledFillWindowMinutesDesc:
        'Cik ilgi katrs logs paliek atvērts: loga laikā izaicinājums notur 100 %, pēc tam atkal darbojas parastie noteikumi. Uzstādi garāku par pārbaudes biežumu, lai cikls noteikti iekrīt logā.',
    scheduledFillReplaces: 'Tikai plānotā balsošana',
    scheduledFillReplacesDesc:
        'Plānotie logi kļūst par vienīgo automātisko balsošanu; Flash un pēdējās minūtes noteikumi joprojām balso, manuālo neietekmē. Izlaists logs neatgūstas — izaicinājums var palikt ar nepilnu redzamību.',
    scheduledFillNextHint: 'Nākamais balsošanas logs: {0}–{1} ({2}) — no {3}',
    scheduledFillNoTimesHint:
        'Nav uzstādīts neviens balsošanas laiks — plānotā balsošana nedarbojas, kamēr zemāk nav uzstādīts kāds laiks.',
    scheduledFillWastedWindowHint:
        'Intervālu {0} logi sniedzas pāri izaicinājuma termiņam — izmantojama ir tikai daļa pirms beigām.',
    scheduledFillShortWindowHint:
        'Šis logs ir īsāks par tavu maksimālo pārbaudes biežumu ({0} min) — viss logs var iekrist starp balsošanas cikliem, kamēr lietotne darbojas bez uzraudzības.',
    scheduledFillUnreachableHint:
        '„Tikai plānotā balsošana” ieslēgta, bet neviens logs vairs nesāksies pirms beigām — parastā un beigu loga balsošana bloķēta, balsos tikai pēdējās minūtes noteikumi.',
    scheduledFillProfileReplacesWarning:
        'Šī profila piemērošana šim izaicinājumam ieslēgs „Tikai plānotā balsošana” — pirms saglabāšanas pārskati balsošanas laikus.',
    useVotingPause: 'Balsošanas pauze',
    useVotingPauseDesc:
        'Aptur automātisko balsošanu izvēlētos logos, piem., naktī starp kārtām. Flash un pēdējās minūtes joprojām balso — pauzes laikā beidzošs izaicinājums nav pamests. Manuālā balsošana nav bloķēta.',
    votingPauseTime: 'Pauzes laiki',
    votingPauseTimeDesc:
        'Ikdienas pulksteņa laiki (24 h), kuros sākas pauze, pēc „Laika josla”, nevis ierīces pulksteņa. Katrs sāk savu pauzi; noņem visas rindas, lai izslēgtu. Nakts pauzei 01:30-06:00: 01:30 un 270 min.',
    votingPauseBeforeEnd: 'Pauze pirms beigām',
    votingPauseBeforeEndDesc:
        'Sāk vienreizēju pauzi tik ilgi pirms beigām. Skaita no katra izaicinājuma beigām. Arī pauze pāri termiņam piekāpjas pēdējās minūtes noteikumiem, kuri balso vienmēr.',
    votingPauseDurationMinutes: 'Pauzes ilgums (minūtes)',
    votingPauseDurationMinutesDesc:
        'Cik ilgi katra pauze ilgst no sākuma. Kad beidzas, atkal darbojas parastie noteikumi. Piemērs: 270 min no 01:30 notur pauzi līdz 06:00.',
    votingPauseNextHint: 'Nākamā pauze: {0}–{1} ({2}) — no {3}',
    votingPauseActiveHint:
        'Pauze ir aktīva līdz {0} ({1}) — balsos tikai pēdējās minūtes un Flash noteikumi. Boost un Turbo lietotne joprojām izmanto pēc to laika atskaitēm.',
    votingPauseShortWindowHint:
        'Šī pauze ir īsāka par tavu maksimālo pārbaudes biežumu ({0} min) — balsošanas cikls to var pilnībā izlaist, un balsošana turpināsies tā, it kā pauze nebūtu uzstādīta.',
    votingPauseNoTimesHint:
        'Nav uzstādīts neviens pauzes laiks — balsošanas pauze nedarbojas, kamēr zemāk nav uzstādīts kāds laiks.',
    votingPauseAllDayHint:
        'Šīs pauzes aizņem visu diennakti — ārpus pēdējās minūtes noteikumiem šajā izaicinājumā automātiski nekad netiktu balsots.',
    finalWindowDuration: 'Beigu loga ilgums',
    finalWindowDurationDesc:
        'Cik ilgs ir beigu logs pirms izaicinājuma beigām. Beigu loga redzamības noteikums darbojas šajā logā. Pēc noklusējuma 1 stunda.',
    finalWindowDurationHelp:
        'Beigu loga garums no izaicinājuma beigu laika atpakaļ. 1 stunda = fiksēta pēdējā stunda; mainot to, mainās arī brīdis, kad sāk darboties beigu loga slieksnis un mērķis.',
    finalWindowExposure: 'Beigu loga redzamība',
    finalWindowExposureDesc:
        'Redzamības līmenis, pie kura beigu logā sākas balsošana (tikai tad, ja ieslēgts „Izmantot beigu loga redzamību”). Tam jābūt vienādam ar redzamības uzstādījumu vai mazākam par to.',
    finalWindowExposureTarget: 'Beigu loga redzamības mērķis',
    finalWindowExposureTargetDesc:
        'Līdz kādam procentam balsot, kad nostrādā beigu loga noteikums (0 = tāds pats kā beigu loga slieksnis)',
    finalWindowExposureTargetHelp:
        '0 NENOZĪMĒ „izslēgts”. 0 nozīmē „balsot līdz beigu loga slieksnim” — beigu loga noteikums paliek aktīvs. 1–100 balsots tālāk par slieksni. Laika uzstādījumos 0 nozīmē „izslēgts”.',
    useFinalWindowExposure: 'Izmantot beigu loga redzamību',
    useFinalWindowExposureDesc:
        'Beigu logā pirms izaicinājuma beigām parastā redzamības uzstādījuma vietā izmantot atsevišķu beigu loga redzamības slieksni un mērķi.',
    voteBeforeFinalWindow: 'Balsot pirms beigu loga',
    voteBeforeFinalWindowDesc:
        'Ap beigu loga sākumu balsot līdz parastajam mērķim, lai zemu nokritušais izaicinājums nepaliktu pie zema zemākā beigu loga sliekšņa dēļ; darbojas norādītās minūtes pirms un pēc robežas.',
    voteBeforeFinalWindowLeadMin: 'Cik laicīgi pirms beigu loga',
    voteBeforeFinalWindowLeadMinDesc:
        'Cik minūtes ap beigu loga sākumu uzpilde paliek aktīva. Logs atveras tik minūšu pirms beigu loga un aizveras tikpat minūšu pēc tā sākuma, un tad darbu pārņem beigu loga redzamības noteikums.',
    validationInvalidValue: 'Nederīga vērtība',
    validationMustBeLessOrEqual: 'Jābūt ≤ {0} (pašlaik {1})',
    whatsNew: 'Kas jauns:',
    yourEntries: 'Tavi foto',
    yourProgress: 'Tavs progress',
    // Additional keys for React components
    refresh: 'Atsvaidzināt',
    challengeOverrideInfo: 'Šeit norādītie uzstādījumi aizstās globālos noklusējumus tikai šim izaicinājumam.',
    challengeOverridesLoadError:
        'Neizdevās ielādēt šī izaicinājuma saglabātos uzstādījumus, tāpēc tos tagad nevar labot — saglabāšana tos pārrakstītu. Aizver dialoglodziņu un atver vēlreiz; ja atkārtojas, skaties kļūdu žurnālā.',
    mockMode: 'Testa režīms',
    logout: 'Iziet',
    status: 'Statuss',
    title: 'GuruShots Auto Vote',
    mainContent: 'Automātiskā balsošana un izaicinājumi',
    downloadingUpdate: 'Lejupielādē atjauninājumu…',
    updateReady: 'Atjauninājums gatavs',
    updateError: 'Atjaunināšanas kļūda',
    releaseNotes: 'Laidiena piezīmes',
    updateReadyToInstall: 'Atjauninājums ir lejupielādēts, un to var instalēt. Restartē lietotni, lai to instalētu.',
    updateFailed:
        'Atjauninājumu neizdevās pabeigt: nevarēja sazināties ar atjauninājumu serveri, vai lejupielāde tika pārtraukta. Mēģini vēlreiz vēlāk vai lejupielādē to pārlūkā.',
    updateInstallFailed:
        'Atjauninājumu neizdevās instalēt: lejupielādēto atjauninājumu nevarēja uzstādīt. Restartē lietotni un mēģini vēlreiz.',
    updateUnverified:
        'Lejupielādi neizdevās pārbaudīt, tāpēc tā netika instalēta. Laidiena lapa ir atvērta tavā pārlūkā.',
    updateReleasePageOpened:
        'Atjauninājumu neizdevās instalēt lietotnē. Laidiena lapa ir atvērta tavā pārlūkā, kur vari to lejupielādēt.',
    skipVersion: 'Izlaist versiju',
    remindLater: 'Atgādināt vēlāk',
    download: 'Lejupielādēt',
    restartLater: 'Restartēt vēlāk',
    restartNow: 'Restartēt tagad',
    close: 'Aizvērt',
    downloadInBrowser: 'Lejupielādēt pārlūkā',
    overridden: 'Pielāgots',
    usingGlobal: 'Izmanto globālo',
    overridesActiveSummary: 'Manuāli pielāgoti: {0}; pārējie izmanto profila vai globālos uzstādījumus.',
    overridesNoneSummary: 'Nav manuālu pielāgojumu; izmanto profila vai globālos uzstādījumus.',
    enableOverride: 'Pielāgot šim izaicinājumam',
    clearAll: 'Notīrīt visu',
    notApplicable: 'Neattiecas',
    notApplicableHint: 'Tavas saglabātās vērtības netiek dzēstas.',
    naBoostUsed: 'Boost šajā izaicinājumā jau izmantots — šie uzstādījumi nedarbosies.',
    naTurboUsed: 'Turbo šajā izaicinājumā jau izmantots — šie uzstādījumi nedarbosies.',
    naSlotsFull: 'Visas foto vietas ir aizņemtas — automātiskajai iesniegšanai nav, kur pievienot.',
    naFlashNoBoost: 'Flash izaicinājumos nav Boost.',
    naFlashNoScheduledFill: 'Flash izaicinājumos vienmēr balso līdz 100 % — plānotā balsošana nekad nedarbojas.',
    naFlashNoVotingPause: 'Flash izaicinājumos vienmēr balso līdz 100 % — balsošanas pauze nekad nedarbojas.',
    naFlashNoTurbo: 'Flash izaicinājumos nav Turbo.',
    naExhibitionNoTurbo: 'Izstāžu izaicinājumos nav Turbo.',
    naBoostSinglePhoto: 'Viena foto izaicinājumos Boost nekad netiek atbloķēts — šie uzstādījumi nedarbosies.',
    challengeProfiles: 'Profili',
    applyProfile: 'Piemērot',
    deleteProfile: 'Dzēst',
    confirmDelete: 'Apstiprināt dzēšanu?',
    confirmOverwrite: 'Pārrakstīt?',
    saveAsProfile: 'Saglabāt pašreizējos kā profilu',
    profileNamePlaceholder: 'Profila nosaukums (piem., „2 foto taktika”)',
    noProfiles: 'Nav saglabātu profilu',
    profileSaveError: 'Neizdevās saglabāt profilu — kāda vērtība nav derīga.',
    profileNameRequired: 'Vispirms ievadi profila nosaukumu.',
    profileNameTooLong: 'Profila nosaukums ir par garu (maks. rakstzīmju skaits: {0}).',
    profileLimitReached: 'Sasniegts profilu limits ({0}) — vispirms izdzēs kādu.',
    profileAppliedHint: 'Profils piemērots — pārskati vērtības zemāk un nospied „Saglabāt”.',
    profileApplyHint:
        'Profila piemērošana aizstāj pašreizējās formas vērtības (arī nesaglabātās izmaiņas); uzstādījumi, kas profilā nav iekļauti, atgriežas pie „Izmanto globālo”.',
    profileOverwriteHint: 'Ja saglabā ar esošu nosaukumu, esošais profils tiek pārrakstīts.',
    intentBuiltIn: 'Iebūvēta sagatave',
    intentModified: 'Rediģēta sagatave',
    intentJustParticipate: 'Vienkārši piedalīties',
    intentJustParticipateDesc:
        'Iesniedz foto visās foto vietās, bet nekad netērē Boost vai Turbo un nedzenas pēc redzamības, kas pārsniedz slieksni, — maz pūļu, maz riska.',
    intentFinishStrong: 'Spēcīgs finišs',
    intentFinishStrongDesc:
        'Lielāko izaicinājuma daļu spēlē kā parasti, tad beigu logā izmanto Boost un Turbo un krietni palielina redzamību.',
    intentMaxExposure: 'Maksimāla redzamība',
    intentMaxExposureDesc:
        'Visu laiku ar pilnu jaudu: balso līdz pilnai redzamībai, iesniedz foto visās foto vietās un izmanto Boost un Turbo.',
    ended: 'Beidzies',
    stateUnknown: 'Nezināms',
    stateAvailableMinutes: 'Pieejams (vēl {time})',
    stateLocked: 'Slēgts',
    stateFree: 'Bezmaksas',
    stateTimer: 'Gaidīšana',
    stateInProgress: 'Notiek',
    stateWon: 'Laimēts',
    statusError: 'Kļūda',
    autovoteNotificationPreparing: 'Automātiskā balsošana darbojas — sagatavo pirmo ciklu',
    autovoteNotificationLastCycle: 'Pēdējais cikls: {time}',
    actionOnItem: '{action}: {item}',
    sbRuleN: '{n}. likums',
    scenarioPathPhase: 'Fāze {name}',
    scenarioPathCondition: '{n}. nosacījums',
    scenarioPathAction: '{n}. darbība',
    scenarioPathSettings: 'Uzstādījumi',
    scenarioPathLimits: 'Limiti',
    sbDurationHint: 'Sekundes vai laika posms, piemēram, „90m”, „6h” vai „1d 6h” (līdz 60 dienām).',
    timeLeft: 'atlicis {time}',
    noReleaseNotes: 'Laidiena piezīmju nav',
    scenarioIssueNoJson: 'Scenārijs nav ievadīts. Ielīmē scenārija failu.',
    scenarioIssueTooLarge: 'Fails ir lielāks par {kb} KB.',
    scenarioIssueNotJson: 'Šis nav derīgs JSON.',
    scenarioIssuePhaseScenario: 'Fāze nevar mainīt, kurš scenārijs ir piešķirts.',
    scenarioIssuePhaseManualPhotos: 'Fāze nevar mainīt uzstādījumu „Tikai manuāli”.',
    scenarioIssueNotPerChallenge: 'Šo uzstādījumu nevar iestatīt vienam izaicinājumam.',
    scenarioIssueSetTogether: 'Uzstādi {fields} kopā.',
    scenarioIssueConflictDefaults:
        'Šīs vērtības ir pretrunā ar globālajiem noklusējumiem, ar kuriem tās darbojas kopā.',
    scenarioIssueNoPhase: 'Nav fāzes ar nosaukumu „{name}”.',
    scenarioIssueDuplicateRuleId: 'Likuma identifikators „{id}” ir izmantots divreiz.',
    scenarioIssueConditionDepth: 'Nosacījumi ir ieklāti dziļāk par {depth} līmeņiem.',
    scenarioIssueMemoryNeverSet: 'Atmiņas vieta „{slot}” netiek aizpildīta ne ar vienu darbību.',
    scenarioIssueControlChars: 'Noņem rindu pārtraukumus un citas vadības rakstzīmes.',
    scenarioIssueIdentifier: 'Lieto burtus, ciparus, „-” vai „_”, sākot ar burtu (ne vairāk kā 32 rakstzīmes).',
    scenarioIssueReserved: 'Šis nosaukums ir rezervēts.',
    scenarioIssueNameRequired: 'Nosaukums ir obligāts.',
    scenarioIssueNameTooLong: 'Nosaukums ir garāks par {max} rakstzīmēm.',
    scenarioIssueNameChars: "Lieto burtus, ciparus, atstarpes un . _ - ' ( ).",
    scenarioIssueTimeOfDay: 'Lieto 24 stundu laiku formātā HH:MM.',
    scenarioIssueStateName: 'Lieto stāvokļa nosaukumu ar lielajiem burtiem, piemēram, AVAILABLE.',
    scenarioIssueSetMinMax: 'Norādi minimumu, maksimumu vai abus.',
    scenarioIssueMinMax: 'Minimums ir lielāks par maksimumu.',
    scenarioIssueWindowOnly: 'Logs attiecas tikai uz {fields}.',
    scenarioIssueCompareBool: 'Lauku {field} salīdzina ar true vai false.',
    scenarioIssueOpEquals: 'Lauks {field} atbalsta tikai = un !=.',
    scenarioIssueCompareNumber: 'Lauku {field} salīdzina ar skaitli.',
    scenarioIssueSameTime: 'Sākuma un beigu laiks ir vienāds.',
    scenarioIssueWriteMessage: 'Uzraksti ziņojumu.',
    scenarioIssueIdChars: 'Lieto burtus, ciparus, „-” vai „_” (ne vairāk kā 40 rakstzīmes).',
    scenarioIssueNeedsAction: 'Likumam ir vajadzīga vismaz viena darbība.',
    scenarioIssuePhaseNeeded: 'Scenārijam ir vajadzīga vismaz viena fāze.',
    scenarioIssueTooManyPhases: 'Scenārijā var būt ne vairāk kā {max} fāzes.',
    scenarioIssueMissing: 'Šī vērtība ir obligāta.',
    scenarioIssueWrongType: 'Šīs vērtības veids nav pareizs.',
    scenarioIssueUnknownKey: 'Šī atslēga nav daļa no scenārija formāta.',
    scenarioIssueRange: 'Šī vērtība ir ārpus atļautā diapazona vai garuma.',
    scenarioIssueInvalidOption: 'Šī nav neviena no atļautajām vērtībām.',
    scenarioIssueInvalidFormat: 'Šīs vērtības formāts nav pareizs.',
    scenarioIssueGeneric: 'Šī scenārija daļa nav derīga.',
    noticeAcknowledgedVersion: 'Apstiprinātā paziņojuma versija',
    noticeAcknowledgedVersionDesc:
        'Iekšējs — tā paziņojuma versija, ko apstiprināji (lietotne nav saistīta ar GuruShots); paziņojums tiek rādīts vēlreiz, ja tā teksts būtiski mainās',
};
// Logs page specific
export const logs = {
    title: 'Žurnāli',
    status: 'Statuss',
    empty: 'Vēl nav žurnāla ierakstu.',
    connected: 'Savienots',
    disconnected: 'Nav savienots',
    levels: { DEBUG: 'Diagnostika', INFO: 'Informācija', WARN: 'Brīdinājums', ERROR: 'Kļūda' },
    categories: {
        api: 'API',
        authentication: 'Pieteikšanās',
        autoSubmit: 'Automātiskā iesniegšana',
        boost: 'Boost',
        challenges: 'Izaicinājumi',
        claim: 'Balvu saņemšana',
        currency: 'Valūta',
        error: 'Kļūda',
        general: 'Vispārīgi',
        join: 'Pievienošanās',
        lexicon: 'Leksika',
        middleware: 'Starpprogrammatūra',
        missions: 'Misijas',
        scenario: 'Scenārijs',
        settings: 'Uzstādījumi',
        translation: 'Tulkošana',
        turbo: 'Turbo',
        ui: 'Saskarne',
        update: 'Atjauninājumi',
        voting: 'Balsošana',
    },
};
// Theme picker labels, keyed by DaisyUI theme name (settings/uiDefaults.ts THEMES)
export const themes = {
    light: 'Gaišs',
    dark: 'Tumšs',
    cupcake: 'Kēksiņš',
    bumblebee: 'Kamene',
    emerald: 'Smaragds',
    corporate: 'Korporatīvs',
    synthwave: 'Synthwave',
    retro: 'Retro',
    cyberpunk: 'Kiberpanks',
    valentine: 'Valentīndiena',
    halloween: 'Helovīns',
    garden: 'Dārzs',
    forest: 'Mežs',
    aqua: 'Akva',
    lofi: 'Lo-Fi',
    pastel: 'Pasteļi',
    fantasy: 'Fantāzija',
    wireframe: 'Karkass',
    black: 'Melns',
    luxury: 'Luksuss',
    dracula: 'Drakula',
    cmyk: 'CMYK',
    autumn: 'Rudens',
    business: 'Bizness',
    acid: 'Skābe',
    lemonade: 'Limonāde',
    night: 'Nakts',
    coffee: 'Kafija',
    winter: 'Ziema',
    dim: 'Krēsla',
    nord: 'Nord',
    sunset: 'Saulriets',
    caramellatte: 'Karameļu latte',
    abyss: 'Bezdibenis',
    silk: 'Zīds',
};
// notice
export const notice = {
    title: 'Pirms lieto lietotni',
    unofficial:
        'Šī nav oficiāla GuruShots lietotne. GuruShots Auto Vote ir citu izstrādāts rīks, kas nav saistīts ar GuruShots, un GuruShots to nav apstiprinājis vai atbalstījis.',
    trademark:
        'GuruShots ir tā īpašnieka preču zīme. Tā šeit lietota tikai tāpēc, lai norādītu, ar kuru pakalpojumu šī lietotne strādā.',
    terms: 'Automātiska balsošana var pārkāpt GuruShots lietošanas noteikumus un var novest pie tava konta apturēšanas. Lietotni lieto uz savu atbildību.',
    updates: 'Lai pārbaudītu atjauninājumus, lietotne sazinās ar GitHub.',
    acknowledge: 'Sapratu',
    recoveryRegion: 'Paziņojumi par uzstādījumiem',
    recoveryCorruptWhat:
        'Tavs uzstādījumu fails config.json bija bojāts, tāpēc lietotne sāka darbu ar noklusētajiem uzstādījumiem.',
    recoveryCorruptWhy:
        'Failu config.json neizdevās nolasīt kā derīgus uzstādījumus. Bojātā kopija ir saglabāta šeit: {path}.',
    recoveryCorruptNext:
        'Jaunus uzstādījumus vari saglabāt kā parasti. Bojātā kopijā vēl ir tavi iepriekšējie uzstādījumi, arī pieteikšanās — paturi to, lai nolasītu vecās vērtības, un izdzēs, kad vairs nav vajadzīga.',
    recoveryCorruptWhatAndroid:
        'Tavi saglabātie uzstādījumi bija bojāti, tāpēc lietotne sāka darbu ar noklusētajiem uzstādījumiem.',
    recoveryCorruptWhyAndroid:
        'Saglabātos uzstādījumus neizdevās nolasīt kā derīgus. Lietotne bojāto kopiju paturēja savā krātuvē, kur tu to nevari atvērt.',
    recoveryCorruptNextAndroid:
        'Uzstādījumi ir atiestatīti uz noklusētajiem. Iestati tos vēlreiz; jaunus uzstādījumus vari saglabāt kā parasti.',
    recoveryUnreadableWhat: 'Tavu uzstādījumu failu neizdevās nolasīt, tāpēc uzstādījumu saglabāšana ir izslēgta.',
    recoveryUnreadableWhy:
        'Lietotne nevarēja atvērt failu {path}. Iespējams, to bloķē cita programma vai piekļuvi liedz atļaujas.',
    recoveryUnreadableNext:
        'Aizver citas programmas, kas to izmanto, vai salabo atļaujas. Saglabāšana atkal darbojas, tiklīdz failu var nolasīt; nekas netika pārrakstīts.',
    recoveryUnreadableWhyAndroid:
        'Lietotne nevarēja nolasīt saglabātos uzstādījumus. Iespējams, ierīces krātuve ir aizņemta vai pilna.',
    recoveryUnreadableNextAndroid:
        'Restartē lietotni. Nekas netika pārrakstīts, un saglabāšana paliek izslēgta, kamēr uzstādījumus nevar nolasīt. Ja atkārtojas, sadaļā „Lietotnes uzstādījumi” → „Par lietotni un datiem” izmanto „Dzēst visus vietējos datus”.',
    recoveryImportWhat:
        'Tavus uzstādījumus no settings.json neizdevās importēt, tāpēc uzstādījumu saglabāšana ir izslēgta un lietotne izmanto noklusētos uzstādījumus.',
    recoveryImportWhatAndroid:
        'Tavus saglabātos uzstādījumus neizdevās importēt, tāpēc uzstādījumu saglabāšana ir izslēgta un lietotne izmanto noklusētos uzstādījumus.',
    recoveryImportWhy:
        'Failu settings.json (šeit: {path}) šobrīd neizdevās nolasīt (iespējams, to izmanto cita programma, vai arī saglabāšana neizgāja).',
    recoveryImportNext:
        'Nekas netika pārrakstīts; lietotne mēģina vēlreiz nākamajā palaišanā. Izvēlies „Mēģināt vēlreiz” (tagad) vai „Sākt no jauna” (noklusētie uzstādījumi); settings.json paliek kā ir.',
    recoveryImportWhyAndroid: 'Saglabātos uzstādījumus šobrīd neizdevās nolasīt.',
    recoveryImportNextAndroid:
        'Izvēlies „Mēģināt vēlreiz” vai „Sākt no jauna”, lai sāktu ar noklusētajiem uzstādījumiem. Nekas netika pārrakstīts, un uzstādījumu saglabāšana paliek izslēgta, kamēr nav izdarīta kāda no šīm darbībām.',
    recoveryImportSettledWhat:
        'Tavus uzstādījumus no settings.json neizdevās importēt, tāpēc lietotne to vietā saglabāja noklusētos uzstādījumus.',
    recoveryImportSettledWhatAndroid:
        'Tavus saglabātos uzstādījumus neizdevās importēt, tāpēc lietotne to vietā saglabāja noklusētos uzstādījumus.',
    recoveryImportWhyCorrupt:
        'Fails nav nolasāms uzstādījumu fails. Tas ir paturēts, kāds ir, un importēšana pēc savas iniciatīvas vairs netiek mēģināta.',
    recoveryImportWhyMigration:
        'Tajā esošos uzstādījumus nevar pārveidot uz pašreizējo uzstādījumu formātu. Fails ir paturēts, kāds ir, un importēšana pēc savas iniciatīvas vairs netiek mēģināta.',
    recoveryImportSettledNext:
        'Lai importētu savus uzstādījumus, kad settings.json ir salabots: aizvēr lietotni un mapē, kurā atrodas settings.json ({path}), izdzēs failus config.json un v2-import.json, kā arī izņem no tās visas config.json.corrupt-… kopijas (paturi settings.json tajā). Atkal palaid lietotni; nākamajā palaišanā salabotais fails tiek importēts vienreiz, un līdz šim lietotie uzstādījumi — arī tas, ko mainīji pēc noklusēto uzstādījumu ierakstīšanas, un pašreizējā pieteikšanās — tiek aizstāti ar importētajiem.',
    recoveryImportSettledNextAndroid:
        'Lietotne izmanto noklusētos uzstādījumus. Iestati savus vēlreiz; jaunus uzstādījumus vari saglabāt kā parasti.',
    recoverySignInKept:
        'Bojātajā kopijā joprojām var būt pieteikšanās dati, arī pēc izrakstīšanās. Izdzēs to, kad tā vairs nav vajadzīga.',
    recoverySignInKeptAndroid: 'Bojātajā kopijā joprojām var būt pieteikšanās dati, arī pēc izrakstīšanās.',
    recoveryRetry: 'Mēģināt vēlreiz',
    recoveryStartFresh: 'Sākt no jauna',
    recoveryWorking: 'Notiek darbība…',
    recoveryStartFreshTitle: 'Sākt ar noklusētajiem uzstādījumiem?',
    recoveryStartFreshBody:
        'Lietotne sāks darbu ar noklusētajiem uzstādījumiem. Fails settings.json netiek importēts un paliek, kāds ir, arī vēlāk netiek importēts bez aicinājuma.',
    recoveryStartFreshBodyAndroid:
        'Lietotne sāks darbu ar noklusētajiem uzstādījumiem. Saglabātie uzstādījumi netiek importēti un paliek, kādi ir, arī vēlāk netiek importēti bez aicinājuma.',
    recoveryRetryDone: 'Tavi uzstādījumi no settings.json ir importēti. Uzstādījumu saglabāšana atkal darbojas.',
    recoveryRetryDoneAndroid:
        'Tavi uzstādījumi ir importēti no saglabātajiem uzstādījumiem. Uzstādījumu saglabāšana atkal darbojas.',
    recoveryRetryDoneAdopted:
        'Nekas netika importēts. Tavi uzstādījumi jau bija savā vietā (saglabāti, kamēr tu izvēlējies šo darbību), un lietotne tos izmanto. Uzstādījumu saglabāšana darbojas.',
    recoveryStartFreshDoneAdopted:
        'Nekas netika atiestatīts. Uzstādījumi tika saglabāti, kamēr tu izvēlējies šo darbību, un lietotne tos izmanto. Saglabāšana darbojas.',
    recoveryRetryFailed:
        'Importēšana neizdevās: settings.json neizdevās nolasīt vai pārveidot, vai uzstādījumus saglabāt. Nekas netika mainīts. Salabo failu un mēģini vēlreiz, vai izvēlies „Sākt no jauna”. Sīkāk žurnālā.',
    recoveryRetryFailedAndroid:
        'Importēšana neizdevās: saglabātos uzstādījumus neizdevās nolasīt vai pārveidot, vai saglabāt. Nekas netika mainīts. Izvēlies „Mēģināt vēlreiz” vai „Sākt no jauna”. Sīkāk žurnālā.',
    recoveryStartFreshDone:
        'Lietotne tagad izmanto noklusētos uzstādījumus, un saglabāšana darbojas. Fails settings.json ir paturēts, kāds ir.',
    recoveryStartFreshDoneAndroid:
        'Lietotne tagad izmanto noklusētos uzstādījumus, un saglabāšana darbojas. Saglabātie uzstādījumi ir paturēti, kādi ir.',
    recoveryStartFreshFailed:
        'Sākt ar noklusētajiem uzstādījumiem neizdevās: jaunos neizdevās saglabāt. Nekas netika mainīts. Mēģini vēlreiz; ja atkārtojas, pārbaudi, vai lietotne var rakstīt krātuvē. Sīkāk žurnālā.',
    importReportTitle: 'Uzstādījumi importēti',
    importReportIntro:
        'Tavi uzstādījumi no settings.json importēti. Atsauces uz profiliem un scenārijiem paturētas un, kā iepriekš, vēl nedarbojas — izveido vai salabo to, ko katra nosauc.',
    importReportIntroAndroid:
        'Tavi saglabātie uzstādījumi importēti. Atsauces uz profiliem un scenārijiem paturētas un, kā iepriekš, vēl nedarbojas — izveido vai salabo to, ko katra nosauc.',
    importReportFailed:
        'Lietotne nevarēja saglabāt, ka šis paziņojums ir redzēts. Tas parādīsies vēlreiz nākamajā startā. Pārbaudi, vai lietotne var rakstīt savā krātuvē.',
    importRefLine: '{where}: {problem}',
    importRefRule: 'Noteikums {number}',
    importRefRuleTitled: 'Noteikums {number} ({title})',
    importRefProfile: 'Profils „{name}”',
    importRefChallenge: 'Izaicinājums {id}',
    importRefChallengeTitled: 'Izaicinājums „{title}” ({id})',
    importRefProfileMissing: 'profils „{name}” nepastāv',
    importRefProfileInvalid: 'profilu „{name}” nevar izmantot',
    importRefScenarioMissing: 'scenārijs „{name}” nepastāv',
    importRefScenarioInvalid: 'scenāriju „{name}” nevar izmantot',
    recoveryDroppedWhat: 'Vienu no tavām izmaiņām uzstādījumos neizdevās saglabāt.',
    recoveryDroppedWhyConflict: 'Fona pakalpojums tajā pašā laikā mainīja uzstādījumus.',
    recoveryDroppedWhyTooLarge: 'Uzstādījumi ir pārāk lieli, lai tos varētu saglabāt.',
    recoveryDroppedWhyStorage: 'Ierīces uzstādījumu krātuve izmaiņu nepieņēma.',
    recoveryDroppedWhyUnknown: 'Uzstādījumus šobrīd neizdevās ierakstīt.',
    recoveryDroppedNext: 'Uzstādījums atkal rāda saglabāto vērtību. Ja vajag, nomaini to vēlreiz.',
    recoveryDroppedNextTooLarge:
        'Uzstādījums atkal rāda saglabāto vērtību. Noņem izaicinājumu atsevišķos uzstādījumus un scenārijus, kas vairs nav vajadzīgi, un nomaini to vēlreiz.',
};
// about
export const about = {
    title: 'Par lietotni un datiem',
    licensesDesc: 'Atvērtā koda programmatūra un dati, kas iekļauti šajā lietotnē, ar to licencēm.',
    licensesButton: 'Trešo pušu licences',
    licensesTitle: 'Trešo pušu licences',
    licensesTextLabel: 'Trešo pušu licenču teksti',
    licensesLoadError:
        'Licenču tekstus neizdevās ielādēt. Fails ar tiem trūkst šajā instalācijā vai nav nolasāms. Mēģini vēlreiz; ja tas atkārtojas, pārinstalē lietotni.',
    licensesRetry: 'Mēģināt vēlreiz',
    dangerTitle: 'Bīstamā zona',
    deleteDesc: 'Dzēst visu, ko lietotne glabā šajā ierīcē. To nevar atsaukt.',
    deleteButton: 'Dzēst visus vietējos datus…',
    deleteTitle: 'Dzēst visus vietējos datus?',
    deleteIntro: 'Tiks neatgriezeniski dzēsts šajā ierīcē:',
    deleteLogin: 'saglabātā pieteikšanās',
    deleteSettings: 'uzstādījumi',
    deleteProfiles: 'saglabātie profili',
    deleteScenarios: 'scenāriji un to norise',
    deleteStats: 'statistika',
    deleteLogs: 'žurnāli',
    deleteBackground: 'fona pakalpojuma stāvoklis',
    deleteAfter:
        'Pēc tam lietotne tiek palaista no jauna un lūdz pieteikties vēlreiz. Tavs GuruShots konts netiek skarts.',
    deleteAfterWeb:
        'Pēc tam tīmekļa serveris apstājas. Palaid pnpm web vēlreiz, atver adresi, ko tas izvada, un piesakies no jauna. Tavs GuruShots konts netiek skarts.',
    deleteConfirm: 'Dzēst visu',
    deleteChecking: 'Pārbauda, vai neviens cits neizmanto datus, un pēc tam dzēš…',
    deleteBusyPass:
        'Notiek balsošanas cikls, tāpēc nekas netika dzēsts. Aptur automātisko balsošanu, pagaidi, kamēr cikls beidzas, un mēģini vēlreiz.',
    deleteBusyCli:
        'Darbojas cita komandrindas komanda vai sesija, tāpēc nekas netika dzēsts. Pagaidi, kamēr tā beidzas, vai aptur to terminālī, kurā tā darbojas (Ctrl+C), un mēģini vēlreiz.',
    deleteBusyApp:
        'Darbvirsmas lietotne ir atvērta, tāpēc nekas netika dzēsts. Aizver darbvirsmas lietotni un mēģini vēlreiz.',
    deleteBusyWeb:
        'Darbojas tīmekļa serveris (pnpm web), tāpēc nekas netika dzēsts. Aptur to terminālī, kurā tas darbojas (Ctrl+C), un mēģini vēlreiz.',
    deleteFailed:
        'Ne viss tika izdzēsts. Kādu failu vai krātuvi neizdevās noņemt. Aizver citas programmas, kas izmanto lietotnes failus, un mēģini vēlreiz.',
    deleteFailedAndroid:
        'Ne viss tika izdzēsts. Daļu saglabāto datu vai fona pakalpojuma datu neizdevās noņemt. Mēģini vēlreiz tūlīt.',
    deleteRestartsOnClose: 'Kad aizvērsi šo dialoglodziņu, lietotne tiks palaista no jauna.',
    deleteDone:
        'Visi vietējie dati ir dzēsti. Lietotne tūlīt tiks palaista no jauna. Ja tas nenotiek, aizver to un atver vēlreiz.',
    deleteDoneWeb:
        'Visi vietējie dati ir dzēsti. Tīmekļa serveris ir apstājies. Palaid pnpm web vēlreiz un atver adresi, ko tas izvada.',
    importTitle: 'Uzstādījumu imports',
    importAt: 'Tavi uzstādījumi no settings.json tika importēti {date}',
    importAtAndroid: 'Tavi saglabātie uzstādījumi tika importēti {date}',
    importNone: 'Nekas nebija jālabo.',
    importSome:
        'Šīs atsauces uz profiliem un scenārijiem ir paturētas, un tās joprojām netiek piemērotas, tāpat kā pirms importa. Izveido vai salabo profilu vai scenāriju, ko katra no tām nosauc:',
};
