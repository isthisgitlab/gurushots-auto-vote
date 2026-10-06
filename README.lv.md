# GuruShots Auto Voter

[![Build Status](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml/badge.svg?branch=master&event=push)](https://github.com/isthisgitlab/gurushots-auto-vote/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/isthisgitlab/gurushots-auto-vote/badge.svg?branch=master)](https://coveralls.io/github/isthisgitlab/gurushots-auto-vote?branch=master)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

Automātiska balsošana GuruShots izaicinājumos. Viens un tas pats balsošanas dzinējs pieejams trīs veidos: kā darbvirsmas **grafiskā lietotne** (Electron), kā **komandrindas rīks** (`gurucli`) un kā **Android** lietotne (APK fails, ko instalē ārpus Play Store), kas turpina balsot fonā.

**🇬🇧 [Documentation in English →](README.md)**

## Saturs

- [⚠️ Brīdinājums: tikai viens eksemplārs](#️-brīdinājums-tikai-viens-eksemplārs)
- [🚀 Funkcijas](#-funkcijas)
- [📥 Lejupielāde un instalācija](#-lejupielāde-un-instalācija)
- [🎯 Ātrais sākums](#-ātrais-sākums)
- [🔧 Lietošanas ceļvedis](docs/usage.lv.md)
- [🔒 Drošība](#-drošība)
- [📄 Licence un atbalsts](#-licence-un-atbalsts)

## ⚠️ Brīdinājums: tikai viens eksemplārs

**Vienlaikus darbiniet tikai VIENU lietotnes eksemplāru** — vienu grafisko lietotni **vai** vienu tīmekļa saskarni, **vai** vienu CLI, **vai** vienu telefonu, nekad vairākus reizē. Vairāki eksemplāri paralēli pārslogo GuruShots API, un tas var izraisīt:

- **pieprasījumu limita kļūdas** (rate limit) — GuruShots bloķē jūsu pieprasījumus;
- **balsošanas kļūmes** — cikli vairs nedarbojas pareizi;
- **konta ierobežojumus** — jūsu kontam uz laiku nosaka ierobežojumus.

Ja saņemat pieprasījumu limita kļūdu, apturiet visus eksemplārus, pagaidiet 5–10 minūtes un palaidiet tikai vienu.

Grafiskajai lietotnei to nodrošina pati darbvirsmas lietotne: ja palaižat to otrreiz, tiek aktivizēts jau atvērtais logs, nevis sākts jauns eksemplārs. Tā nekonstatē CLI, tīmekļa saskarni vai Android lietotni, ko darbina vienlaikus ar grafisko lietotni, — uz šīm kombinācijām attiecas augstāk minētais brīdinājums.

## 🚀 Funkcijas

- **Automātiska balsošana** — balso jūsu aktīvajos izaicinājumos, līdz sasniegts jūsu norādītais redzamības mērķis.
- **Redzamības kontrole** — katram izaicinājumam savs redzamības slieksnis un, ja vēlaties, atsevišķs mērķis ("balsot līdz X %").
- **Pēdējās minūtes spurts** — uzstādāmā laika logā pirms izaicinājuma beigām balso līdz 100 % un automātiski biežāk pārbauda izaicinājumus.
- **Beigu loga redzamība** — atsevišķi, parasti zemāki redzamības griesti uzstādāmam laika logam pirms beigām (pēc noklusējuma — pēdējā stunda).
- **Boost** — tuvu termiņa beigām automātiski izmanto Boost foto, kas atrodas izvēlētajā vietā. Ja Boost drīz jāizmanto, tas tiek izmantots uzreiz, kad dators pāriet miega režīmā (darbvirsmas lietotnē; izslēdzams ar Boost pirms miega), bet aizverot lietotni, kamēr Boost ir gaidāms, vispirms tiek jautāts.
- **Turbo (iegūt + izmantot)** — automātiski spēlē minispēli, lai _iegūtu_ Turbo, un pēc tam pirms termiņa beigām automātiski to _izmanto_ izvēlētajam foto.
- **Automātiskā iesniegšana** — tuvu termiņa beigām iesniedz foto tukšajās vietās ar laika atstarpēm, lai balsis nesadalītos starp vienlaikus iesniegtiem foto; tai ir tagu filtri, tēmai atbilstoša foto izvēle, ko vēlreiz pārbauda ierīcē darbināms attēlu atpazīšanas modelis, un ārkārtas drošības tīkls.
- **Automātiskā pievienošanās** — atrod atvērtos izaicinājumus, kuriem vēl neesat pievienojušies, un automātiski pievienojas tiem (pēc noklusējuma izslēgta). Kad tā ieslēgta, pēc noklusējuma lietotne pievienojas visiem izaicinājumiem; loku var sašaurināt ar izaicinājumu veidu iekļaušanas/izslēgšanas sarakstu vai izaicinājumu noteikumu. Maksas izaicinājumiem ir monētu limiti (vienam izaicinājumam un vienam ciklam), un monētas nekad netiek iztērētas, ja pievienošanās nav pabeigta. Pievienoties var arī manuāli — grafiskajā lietotnē sakļaujamajā sarakstā "Atrast izaicinājumus" un ar CLI komandām `discover`/`join`.
- **Misijas** — pēc izvēles palīdz izpildīt GuruShots mainīgās misijas (visas šīs funkcijas pēc noklusējuma ir izslēgtas): pietaupa katra izaicinājuma Turbo "Win Turbo" misijai, nevienu nezaudējot, "Join challenges" misijas laikā pievienojas izaicinājumiem, negaidot automātiskās pievienošanās laiku, "Use Fill" misijas laikā izmanto uzpildes un "Vote on photos" misijas laikā balso jūsu izaicinājumos.
- **Konta atlikums** — rāda jūsu atslēgas / apmaiņas / uzpildes / monētas grafiskajā lietotnē blakus laika atskaitei un ar CLI komandu `bankroll` (sinonīms `coins`).
- **Uzstādījumi katram izaicinājumam** — katram balsošanas uzstādījumam ir globāla noklusējuma vērtība, ko jebkuram izaicinājumam var pielāgot atsevišķi.
- **Izaicinājumu noteikumi** — noteikumi, kas atlasa izaicinājumus pēc nosaukuma, izaicinājuma taga, veida, foto skaita vai ilguma (tāpēc tie darbojas arī tad, kad GuruShots katrā rotācijā piešķir izaicinājumam jaunu ID), jūsu izvēlētā secībā; katrs noteikums var piešķirt uzstādījumu profilu, ieslēgt vai izslēgt automātisko pievienošanos / automātisko iesniegšanu, noteikt pievienošanās laiku un pievienot tagus automātiskajai iesniegšanai.
- **Scenāriji** — jūsu pašu vairāku dienu plāni izaicinājumam: fāzes ar saviem uzstādījumiem un noteikumi, kas jūsu izvēlētos laikos un apstākļos iesniedz foto, apmaina foto, izmanto Boost, spēlē Turbo, gaida vai sūta jums paziņojumu. Scenārijus veido vizuālajā redaktorā (vai JSON formātā), kopīgo kā failus un, pirms tie kaut ko iztērē, pārbauda ar "kas būtu, ja" simulāciju.
- **Darbvirsmas paziņojumi** — pēc izvēles brīdinājumi dažas minūtes pirms Boost, Turbo vai automātiskās iesniegšanas, kā arī jūsu scenāriju sūtītie ziņojumi.
- **Trīs platformas** — Electron grafiskā lietotne, `gurucli` komandrinda un Android lietotne, kas balso arī tad, kad telefons ir bloķēts.
- **Noturīgs API slānis** — uzstādāms pieprasījumu gaidīšanas laiks un automātiski atkārtoti mēģinājumi ar pieaugošu pauzi, ja rodas pārejošas kļūmes.
- **Ērtības** — gaišā/tumšā tēma, angļu/latviešu saskarne, laiku rādīšana izvēlētajā laika joslā, testa režīms drošai izmēģināšanai un iebūvēti paziņojumi par atjauninājumiem.

## 📥 Lejupielāde un instalācija

### Jaunākie būvējumi

**Jaunākā versija: v1.12.2**

#### 🖥️ Grafiskā lietotne (ieteicama lielākajai daļai lietotāju)

| Platforma         | Lejupielāde                                                                                                                                                            | Izmērs  | Tips                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.12.2-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-x64.exe)                 | ~270 MB | Portatīvs izpildfails   |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.12.2-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64.dmg)             | ~310 MB | DMG instalētājs         |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.12.2-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64.app.zip)     | ~335 MB | Lietotnes pakotne (ZIP) |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.12.2-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-x86_64.AppImage) | ~270 MB | AppImage                |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.12.2-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64.AppImage)   | ~255 MB | AppImage                |

> **macOS:** tikai Apple Silicon (arm64) — Intel (x86_64) būvējuma nav. Vienkāršāk instalēt no **DMG**; **APP** zip ir alternatīva, ja lietotnes pakotni vēlaties ievietot paši.

> **Kāpēc lejupielādes ir tik lielas:** katrā būvējumā (grafiskajā lietotnē, Android lietotnē un CLI) ir iekļauts ~200 MB liels attēlu atpazīšanas modelis (Google SigLIP, kvantizēts līdz 8 bitiem) un tā izpildvide. Automātiskā iesniegšana to izmanto, lai pārbaudītu, vai foto tiešām redzams izaicinājuma temats, — skatiet [vizuālās pārbaudes aprakstu](docs/usage.lv.md#trūkstošo-foto-automātiskā-iesniegšana). Modelis darbojas tikai jūsu ierīcē: pirmajā lietošanas reizē nekas netiek lejupielādēts, nav vajadzīga ne API atslēga, ne konts, un neviens foto netiek nekur augšupielādēts. Nevēlaties to? Izvēlieties [vieglo būvējumu](#-vieglie-būvējumi-bez-attēlu-modeļa).

#### 📱 Mobilā lietotne (Android APK — bez Play Store)

| Platforma                            | Lejupielāde                                                                                                                                    | Izmērs  | Tips           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| **Android (8.0+, ārpus Play Store)** | [📥 GuruShotsAutoVote-v1.12.2.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2.apk) | ~160 MB | Parakstīts APK |

Android versija ir Capacitor apvalks ap to pašu React saskarni, un tai ir Kotlin spraudnis, kas balsošanas ciklus izpilda fonā tieši Android vidē, izmantojot `AlarmManager` un priekšplāna pakalpojumu. Balsošana turpinās arī tad, kad telefons ir bloķēts un lietotne aizvērta neseno lietotņu sarakstā.

#### 💻 Komandrinda (pieredzējušiem lietotājiem / automatizācijai)

| Platforma             | Lejupielāde                                                                                                                            | Izmērs  | Tips                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **macOS CLI**         | [📥 gurucli-v1.12.2-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-mac)             | ~375 MB | Termināļa izpildfails |
| **Linux CLI (x64)**   | [📥 gurucli-v1.12.2-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-linux)         | ~355 MB | Termināļa izpildfails |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.12.2-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-linux-arm) | ~350 MB | Termināļa izpildfails |

> Windows CLI būvējuma nav — operētājsistēmā Windows izmantojiet augstāk minēto grafisko lietotni.

#### 🪶 Vieglie būvējumi (bez attēlu modeļa)

Katra augstāk minētā lejupielāde pieejama arī kā **vieglais** (lite) būvējums bez attēlu atpazīšanas modeļa un tā izpildvides: macOS DMG izmērs samazinās no ~310 MB līdz ~130 MB, bet macOS CLI — no ~375 MB līdz ~140 MB. Viss pārējais darbojas tāpat — automātiskā iesniegšana izlaiž [vizuālo pārbaudi](docs/usage.lv.md#trūkstošo-foto-automātiskā-iesniegšana) un ranžē foto bez tās. Vieglajai grafiskajai lietotnei un vieglajai Android lietotnei tiek piedāvāti tikai vieglie atjauninājumi (vieglā darbvirsmas lietotne pirmsizlaiduma versijas izlaiž).

| Platforma                            | Lejupielāde                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**                          | [📥 GuruShotsAutoVote-v1.12.2-x64-lite.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-x64-lite.exe)                 |
| **macOS (DMG)**                      | [📥 GuruShotsAutoVote-v1.12.2-arm64-lite.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64-lite.dmg)             |
| **macOS (APP)**                      | [📥 GuruShotsAutoVote-v1.12.2-arm64-lite.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64-lite.app.zip)     |
| **Linux (x64)**                      | [📥 GuruShotsAutoVote-v1.12.2-x86_64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-x86_64-lite.AppImage) |
| **Linux (ARM64)**                    | [📥 GuruShotsAutoVote-v1.12.2-arm64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-arm64-lite.AppImage)   |
| **Android (8.0+, ārpus Play Store)** | [📥 GuruShotsAutoVote-v1.12.2-lite.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.12.2-lite.apk)                         |
| **macOS CLI**                        | [📥 gurucli-v1.12.2-mac-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-mac-lite)                                             |
| **Linux CLI (x64)**                  | [📥 gurucli-v1.12.2-linux-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-linux-lite)                                         |
| **Linux CLI (ARM64)**                | [📥 gurucli-v1.12.2-linux-arm-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.12.2-linux-arm-lite)                                 |

Nepieciešama konkrēta versija? Apskatiet **[visus izlaidumus](https://github.com/isthisgitlab/gurushots-auto-vote/releases)** vai **[jaunākā izlaiduma piezīmes](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest)**.

### Instalācija katrai platformai

#### 🪟 Windows

1. Lejupielādējiet augstāk norādīto `.exe` failu.
2. Palaidiet to ar dubultklikšķi — instalēt nav nepieciešams, lietotne darbojas tieši no izpildfaila.
3. Pirmajā palaišanas reizē lietotne izveido konfigurāciju un žurnālfailus mapē `%APPDATA%\gurushots-auto-vote\`.
4. Ja SmartScreen rāda brīdinājumu, izvēlieties **Papildinformācija → Tomēr palaist**.

#### 🍎 macOS

1. **DMG:** atveriet `.dmg` failu, ievelciet lietotni mapē **Applications** un palaidiet to no turienes.
   **APP:** atarhivējiet `.app.zip`, pārvietojiet lietotni uz mapi **Applications** un palaidiet to no turienes.
2. Ja redzat drošības brīdinājumu (Gatekeeper), noņemiet karantīnas atzīmi Terminālī — grafiskajai lietotnei:

    ```bash
    xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
    ```

**CLI operētājsistēmā macOS:**

1. Lejupielādējiet `gurucli-v1.12.2-mac`.
2. `cd ~/Downloads`
3. Padariet failu izpildāmu: `chmod +x gurucli-v1.12.2-mac`
4. Noņemiet karantīnas atzīmi (tikai pārlūkā lejupielādētam failam): `xattr -d com.apple.quarantine ./gurucli-v1.12.2-mac`
5. Palaidiet: `./gurucli-v1.12.2-mac help`

Kad CLI pirmo reizi iesniedz foto, tas izpako iekļauto attēlu atpazīšanas modeli un izpildvidi (~560 MB) mapē `~/Library/Application Support/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jaunā versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 🐧 Linux

**Grafiskā lietotne (AppImage):**

1. Lejupielādējiet savai procesora arhitektūrai atbilstošo AppImage failu.
2. Padariet to izpildāmu: `chmod +x GuruShotsAutoVote-v1.12.2-*.AppImage` (vai failu pārvaldniekā: Properties → Permissions).
3. Palaidiet: `./GuruShotsAutoVote-v1.12.2-*.AppImage`

**CLI:**

1. Lejupielādējiet `gurucli-v1.12.2-linux` (vai `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.12.2-linux`
4. `./gurucli-v1.12.2-linux help`

Kad CLI pirmo reizi iesniedz foto, tas izpako iekļauto attēlu atpazīšanas modeli un izpildvidi (~550 MB) mapē `~/.config/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jaunā versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 📱 Android (APK instalēšana)

Android versija **nav pieejama Google Play** — to instalē, tieši lejupielādējot APK failu.

1. Telefonā atveriet [jaunākā izlaiduma lapu](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) un pieskarieties `GuruShotsAutoVote-v1.12.2.apk`.
2. Pirms APK lejupielādes pārlūks rāda brīdinājumu — pieskarieties **Tomēr lejupielādēt**.
3. Paziņojumu panelī pieskarieties lejupielādētajam failam.
4. Android prasīs atļauju **Instalēt nezināmas lietotnes** — piešķiriet to lietotnei, ar kuru lejupielādējāt failu (Chrome, Files u. c.), un pieskarieties **Instalēt**.
5. Pirmajā palaišanas reizē piešķiriet abas atļaujas:
    - **Paziņojumi** — pastāvīgajam priekšplāna paziņojumam, kas uztur balsošanu darbībā, kad lietotne ir aizvērta.
    - **Atspējot akumulatora optimizāciju** (sistēmas uzstādījumos: Lietotnes → GuruShots Auto Vote → Akumulators → Neierobežots) — citādi ražotāju akumulatora taupīšanas funkcijas (Samsung, Xiaomi, OnePlus…) pakalpojumu apturēs.
6. Piesakieties un pieskarieties **Sākt automātisko balsošanu**. Pastāvīgajā paziņojumā redzams pēdējā cikla laiks. Lietotni var aizvērt neseno lietotņu sarakstā — balsošana turpināsies.

**Fona ierobežojumi:** ražotāju akumulatora pārvaldnieki tomēr var apturēt pakalpojumu (pievienojiet lietotni izņēmumiem tā, kā to paredz konkrētais ražotājs; saite ir lietotnes uzstādījumos). Pēdējās minūtes režīma 1 minūtes pārbaužu intervālam vajadzīga atļauja `SCHEDULE_EXACT_ALARM` (Android 13+ to piešķir automātiski, Android 12 — jāpiešķir manuāli).

## 🎯 Ātrais sākums

### Grafiskā lietotne

1. **Piesakieties** ar savu GuruShots e-pasta adresi un paroli.
2. Izvēlieties **tēmu/valodu** un norādiet, vai **saglabāt pieteikšanos**.
3. Atveriet **Uzstādījumus** un norādiet globālās noklusējuma vērtības (sāciet ar `exposure` un Boost/Turbo laikiem).
4. Ja vēlaties, atveriet izaicinājuma **⚙️**, lai pielāgotu uzstādījumus tikai šim izaicinājumam.
5. Noklikšķiniet uz **Sākt automātisko balsošanu**.

### Komandrinda

```bash
./gurucli-v1.12.2-[platforma] login    # piesakieties vienreiz (saglabā tokenu)
./gurucli-v1.12.2-[platforma] run      # viens pilns automātiskās stratēģijas cikls (Boost, Turbo, automātiskā iesniegšana, balsošana pēc sliekšņa)
./gurucli-v1.12.2-[platforma] start    # nepārtraukta balsošana (Ctrl+C, lai apturētu)
```

> Aizstājiet `[platforma]` ar `mac`, `linux` vai `linux-arm`. Palaidiet `help`, lai redzētu visas komandas.

### Tīmekļa saskarne (no pirmkoda)

Tādu pašu saskarni var atvērt parastā pārlūka cilnē, nevis darbvirsmas logā, — tas noder pārlūka automatizācijai, piemēram, ar Playwright. Tam vajadzīga pirmkoda kopija, Node.js 26 vai jaunāka versija un pnpm:

```bash
pnpm install
pnpm web                 # sabūvē saskarni un palaiž to adresē http://localhost:4400/
pnpm web --port=5000     # cits ports (0 — jebkurš brīvs ports)
```

Atveriet adresi, ko komanda izvada, un piesakieties tāpat kā grafiskajā lietotnē. Automātiskā balsošana darbojas šajā cilnē, tāpēc neaizveriet to: aizverot cilni, balsošana apstājas. Uzstādījumi un pieteikšanās ir kopīgi ar lietotni un CLI, kas palaisti no tās pašas pirmkoda kopijas. Tīmekļa saskarne atjauninājumus neinstalē: atjauninājuma paziņojums atver izlaidumu lapu.

Norādījumus par grafisko lietotni un CLI, balsošanas noteikumus, uzstādījumus, žurnālfailus un problēmu risināšanu skatiet [lietošanas ceļvedī](docs/usage.lv.md).

## 🔒 Drošība

- Visi API pieprasījumi tiek sūtīti, izmantojot HTTPS.
- Akreditācijas dati žurnālos netiek rādīti — pirms jebkura ieraksta žurnālā jutīgo lauku vērtības tiek maskētas.
- Lietotne jūsu tokenu glabā lokāli uzstādījumu failā un sūta to tikai uz GuruShots; uzstādījumi un konfigurācija nekad nepamet jūsu ierīci.
- Kļūdu ziņojumos nav jutīgas informācijas.
- Tīmekļa saskarne (`pnpm web`) ir pieejama tikai šajā datorā (localhost) un noraida pieprasījumus no citām vietnēm. Tai nav savas paroles, tāpēc nekad nepadariet tās portu pieejamu tīklā.
- Automātiskās iesniegšanas vizuālā pārbaude darbojas lokāli ar iebūvētu modeli; tā no GuruShots lejupielādē tikai jūsu pašu foto sīktēlus un neko nesūta citiem pakalpojumiem.

## 📄 Licence un atbalsts

Lietotne tiek izplatīta saskaņā ar **ISC licenci**.

Ja nepieciešama palīdzība, vispirms skatiet sadaļu [Problēmu risināšana](docs/usage.lv.md#-problēmu-risināšana), pēc tam [izveidojiet problēmas pieteikumu](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

Ja šis rīks jums noder, varat atbalstīt tā izstrādi:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

---

**Piezīme:** šī lietotne paredzēta izglītojošiem un izstrādes nolūkiem. Lūdzu, ievērojiet GuruShots lietošanas noteikumus un izmantojiet lietotni atbildīgi.
