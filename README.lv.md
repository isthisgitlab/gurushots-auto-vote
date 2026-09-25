# GuruShots Auto Voter — Instalācijas un lietošanas ceļvedis

Automātiska balsošana GuruShots izaicinājumos. Viens un tas pats balsošanas dzinējs pieejams trīs veidos: darbvirsmas **grafiskā lietotne** (Electron), **komandrindas rīks** (`gurucli`) un **Android** lietotne (sānielādēts APK), kas turpina balsot fonā.

**🇬🇧 [Documentation in English →](README.md)**

## Saturs

- [⚠️ Brīdinājums: tikai viena instance](#️-brīdinājums-tikai-viena-instance)
- [🚀 Funkcijas](#-funkcijas)
- [📥 Lejupielāde un instalācija](#-lejupielāde-un-instalācija)
- [🎯 Ātrais sākums](#-ātrais-sākums)
- [🔧 Lietošana](#-lietošana)
- [⚙️ Kā darbojas balsošana](#️-kā-darbojas-balsošana)
- [🎛️ Iestatījumu atsauce](#️-iestatījumu-atsauce)
- [📐 Ieteicamie iestatījumi](#-ieteicamie-iestatījumi)
- [📝 Žurnālfaili](#-žurnālfaili)
- [🔍 Problēmu risināšana](#-problēmu-risināšana)
- [🔒 Drošība](#-drošība)
- [📄 Licence un atbalsts](#-licence-un-atbalsts)

## ⚠️ Brīdinājums: tikai viena instance

**Vienlaikus darbiniet tikai VIENU instanci** — vienu grafisko lietotni **vai** vienu CLI **vai** vienu telefonu, nekad vairākas reizē. Vairākas instances paralēli pārslogo GuruShots API un var izraisīt:

- **Rate-limit kļūdas** — GuruShots bloķē jūsu pieprasījumus
- **Neveiksmīgu balsošanu** — cikli pārstāj darboties pareizi
- **Konta ierobežojumus** — pagaidu ierobežojumus jūsu kontā

Ja saņemat rate-limit kļūdu: apturiet visas instances, pagaidiet 5–10 minūtes un palaidiet tikai vienu.

## 🚀 Funkcijas

- **Automātiska balsošana** — balso jūsu aktīvajos izaicinājumos līdz konfigurējamam ekspozīcijas mērķim.
- **Ekspozīcijas kontrole** — katram izaicinājumam ekspozīcijas slieksnis un papildu mērķis ("balsot līdz X%").
- **Pēdējās minūtes grūdiens** — balso līdz 100% konfigurējamā logā pirms izaicinājuma beigām un automātiski sablīvē pārbaudes biežumu.
- **Beigu loga ekspozīcija** — atsevišķs, parasti zemāks ekspozīcijas slieksnis konfigurējamam beigu logam (noklusējums pēdējā stunda).
- **Boost** — automātiski pielieto boost tuvu beigām, izvēlētajai foto vietai.
- **Turbo (iegūt + pielietot)** — automātiski spēlē mini-spēli, lai _iegūtu_ turbo, pēc tam automātiski _pielieto_ to izvēlētajai foto vietai pirms beigām.
- **Auto-iesniegšana** — iesniedz fotogrāfijas tukšajās foto vietās tuvu beigām, ar laika atstarpi, lai izvairītos no balsu atšķaidīšanas, ar tagu filtriem, tematiski atbilstošu foto izvēli, ko papildus pārbauda ierīcē strādājošs attēlu modelis, un avārijas drošības tīklu.
- **Auto-pievienošanās** — atrod atvērtos (nepievienotos) izaicinājumus un pievienojas tiem automātiski (pēc noklusējuma izslēgts); kad ieslēgts, pēc noklusējuma pievienojas visiem, sašaurinot ar tipu iekļaušanas/izslēgšanas sarakstu vai izaicinājumu noteikumu. Maksas izaicinājumus ierobežo monētu limiti (par izaicinājumu un ciklā), un monētas nekad netiek tērētas bez pabeigtas pievienošanās. Pieejama arī manuāla pievienošanās — sakļaujams "Atklāt" saraksts grafiskajā lietotnē un `discover`/`join` CLI komandas.
- **Konta atlikums** — parāda jūsu atslēgas / maiņas / uzpildes / monētas blakus taimerim grafiskajā lietotnē un ar `bankroll` (alias `coins`) CLI komandu.
- **Iestatījumi katram izaicinājumam** — katram balsošanas iestatījumam ir globālais noklusējums, ko jebkurš izaicinājums var pārrakstīt.
- **Izaicinājumu noteikumi** — noteikumi, kas atlasa izaicinājumus pēc nosaukuma, izaicinājuma taga, veida, bilžu skaita vai ilguma (tāpēc tie saglabājas, kad GuruShots katrā rotācijā maina izaicinājuma ID), jūsu izvēlētā secībā; katrs var piešķirt iestatījumu profilu, ieslēgt/izslēgt auto-pievienošanos / auto-iesniegšanu, iestatīt pievienošanās laiku un pievienot auto-iesniegšanas tagus.
- **Scenāriji** — jūsu pašu vairāku dienu plāni izaicinājumam: fāzes ar saviem iestatījumiem un noteikumi, kas jūsu izvēlētos laikos un apstākļos iesniedz bildes, apmaina, pielieto Boost, spēlē Turbo, gaida vai paziņo jums. Veido vizuālā redaktorā (vai kā JSON), kopīgo kā failus un pirms jebkādiem tēriņiem pārbaudi ar "kas būtu, ja" simulāciju.
- **Darbvirsmas paziņojumi** — pēc izvēles brīdinājumi dažas minūtes pirms Boost, Turbo vai auto-iesniegšanas, kā arī jūsu scenāriju sūtītie ziņojumi.
- **Trīs platformas** — Electron grafiskā lietotne, `gurucli` komandrinda un Android lietotne, kas balso ar bloķētu telefonu.
- **Noturīgs API slānis** — konfigurējama noildze plus automātiska atkārtošana/aizture pārejošu kļūmju gadījumā.
- **Ērtības** — gaišā/tumšā tēma, angļu/latviešu saskarne, laika joslas attēlošana, mock režīms drošai testēšanai un iebūvēti atjauninājumu paziņojumi.

## 📥 Lejupielāde un instalācija

### Jaunākie būvējumi

**Latest Version: v1.11.0**

#### 🖥️ Grafiskā lietotne (ieteicams lielākajai daļai lietotāju)

| Platforma         | Lejupielāde                                                                                                                                                            | Izmērs  | Tips                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.11.0-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x64.exe)                 | ~270 MB | Portatīva izpildfaila |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.11.0-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.dmg)             | ~310 MB | DMG instalētājs       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.11.0-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.app.zip)     | ~335 MB | App komplekts (ZIP)   |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.11.0-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x86_64.AppImage) | ~270 MB | AppImage              |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.11.0-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64.AppImage)   | ~255 MB | AppImage              |

> **macOS:** tikai Apple Silicon (arm64) — Intel (x86_64) būvējuma nav. **DMG** ir vienkāršākā instalācija; **APP** zip ir alternatīva, ja vēlaties ievietot komplektu pats.

> **Kāpēc lejupielādes ir lielas:** katrā būvējumā (grafiskajā lietotnē, Android un CLI) ir iekļauts ~200 MB attēlu atpazīšanas modelis (Google SigLIP, 8 bitu kvantizēts) un tā izpildvide. Auto-iesniegšana to izmanto, lai pārbaudītu, vai fotogrāfijā tiešām redzams izaicinājuma temats — skatiet [Vizuālā pārbaude](#trūkstošo-ierakstu-auto-iesniegšana). Tas darbojas tikai jūsu ierīcē: pirmajā lietošanas reizē nekas netiek lejupielādēts, nav vajadzīga API atslēga vai konts, un neviena fotogrāfija netiek nekur augšupielādēta. Nevēlaties to? Izvēlieties [vieglo būvējumu](#-vieglie-būvējumi-bez-attēlu-modeļa).

#### 📱 Mobilā lietotne (Android, sānielāde — bez Play Store)

| Platforma                     | Lejupielāde                                                                                                                                    | Izmērs  | Tips           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| **Android (8.0+, sānielāde)** | [📥 GuruShotsAutoVote-v1.11.0.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0.apk) | ~160 MB | Parakstīts APK |

Android versija ir Capacitor apvalks ap to pašu React saskarni plus Kotlin spraudnis, kas balsošanas ciklus izpilda native līmenī fonā ar `AlarmManager` un foreground servisu. Balsošana turpinās, kad telefons ir bloķēts un lietotne aizvilkta no nesenajiem.

#### 💻 Komandrinda (pieredzējušiem lietotājiem / automatizācijai)

| Platforma             | Lejupielāde                                                                                                                            | Izmērs  | Tips                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **macOS CLI**         | [📥 gurucli-v1.11.0-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-mac)             | ~375 MB | Termināļa izpildfaila |
| **Linux CLI (x64)**   | [📥 gurucli-v1.11.0-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux)         | ~355 MB | Termināļa izpildfaila |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.11.0-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-arm) | ~350 MB | Termināļa izpildfaila |

> Windows CLI būvējuma nav — uz Windows izmantojiet augšā esošo grafisko lietotni.

#### 🪶 Vieglie būvējumi (bez attēlu modeļa)

Katra iepriekš minētā lejupielāde ir pieejama arī kā **vieglais** (lite) būvējums bez attēlu modeļa un tā izpildvides: macOS DMG samazinās no ~310 MB līdz ~130 MB, macOS CLI — no ~375 MB līdz ~140 MB. Viss pārējais darbojas tāpat — auto-iesniegšana vienkārši izlaiž [vizuālo pārbaudi](#trūkstošo-ierakstu-auto-iesniegšana) un saglabā tagu ranžēšanu. Vieglajai grafiskās lietotnes vai Android instalācijai tiek piedāvāti tikai vieglie atjauninājumi (vieglā galddatora lietotne izlaiž beta versijas).

| Platforma                     | Lejupielāde                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**                   | [📥 GuruShotsAutoVote-v1.11.0-x64-lite.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x64-lite.exe)                 |
| **macOS (DMG)**               | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.dmg)             |
| **macOS (APP)**               | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.app.zip)     |
| **Linux (x64)**               | [📥 GuruShotsAutoVote-v1.11.0-x86_64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-x86_64-lite.AppImage) |
| **Linux (ARM64)**             | [📥 GuruShotsAutoVote-v1.11.0-arm64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-arm64-lite.AppImage)   |
| **Android (8.0+, sānielāde)** | [📥 GuruShotsAutoVote-v1.11.0-lite.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.0-lite.apk)                         |
| **macOS CLI**                 | [📥 gurucli-v1.11.0-mac-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-mac-lite)                                             |
| **Linux CLI (x64)**           | [📥 gurucli-v1.11.0-linux-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-lite)                                         |
| **Linux CLI (ARM64)**         | [📥 gurucli-v1.11.0-linux-arm-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.0-linux-arm-lite)                                 |

Nepieciešama konkrēta versija? Apskatiet **[visus izlaidumus](https://github.com/isthisgitlab/gurushots-auto-vote/releases)** vai **[jaunākā izlaiduma piezīmes](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest)**.

### Instalācija katrai platformai

#### 🪟 Windows

1. Lejupielādējiet augšā esošo `.exe` failu.
2. Veiciet dubultklikšķi, lai palaistu — instalācija nav nepieciešama; tas darbojas tieši no izpildfaila.
3. Pirmajā palaišanā tas izveido konfigurāciju un žurnālfailus mapē `%APPDATA%\gurushots-auto-vote\`.
4. Ja SmartScreen brīdina, izvēlieties **Papildu informācija → Tomēr palaist**.

#### 🍎 macOS

1. **DMG:** atveriet `.dmg`, ievelciet lietotni mapē **Applications**, palaidiet no turienes.
   **APP:** izvelciet `.app.zip`, pārvietojiet lietotni uz **Applications**, palaidiet no turienes.
2. Ja saņemat drošības brīdinājumu (Gatekeeper), notīriet karantīnas karogu Terminālī — grafiskajai lietotnei:

    ```bash
    xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
    ```

**CLI uz macOS:**

1. Lejupielādējiet `gurucli-v1.11.0-mac`.
2. `cd ~/Downloads`
3. Padariet izpildāmu: `chmod +x gurucli-v1.11.0-mac`
4. Notīriet karantīnas karogu (tikai pārlūka lejupielādēm): `xattr -d com.apple.quarantine ./gurucli-v1.11.0-mac`
5. Palaidiet: `./gurucli-v1.11.0-mac help`

Pirmajā reizē, kad CLI iesniedz foto, tā izpako iekļauto attēlu modeli un izpildvidi (~560 MB) mapē `~/Library/Application Support/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jauna versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 🐧 Linux

**Grafiskā lietotne (AppImage):**

1. Lejupielādējiet AppImage savai arhitektūrai.
2. Padariet izpildāmu: `chmod +x GuruShotsAutoVote-v1.11.0-*.AppImage` (vai failu pārvaldniekā → Properties → Permissions).
3. Palaidiet: `./GuruShotsAutoVote-v1.11.0-*.AppImage`

**CLI:**

1. Lejupielādējiet `gurucli-v1.11.0-linux` (vai `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.11.0-linux`
4. `./gurucli-v1.11.0-linux help`

Pirmajā reizē, kad CLI iesniedz foto, tā izpako iekļauto attēlu modeli un izpildvidi (~550 MB) mapē `~/.config/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jauna versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 📱 Android (sānielāde)

Android versija **nav pieejama Google Play** — instalācija notiek caur tiešu APK lejupielādi.

1. Telefonā atveriet [jaunākā izlaiduma lapu](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) un piesitiet `GuruShotsAutoVote-v1.11.0.apk`.
2. Pārlūks brīdinās pirms APK lejupielādes — piesitiet **Tomēr lejupielādēt**.
3. Piesitiet lejupielādēto failu no paziņojumu joslas.
4. Android pieprasīs **Atļaut nezināmu lietotņu instalēšanu** — piešķiriet to lietotnei, ar kuru lejupielādējāt (Chrome / Files / utt.), tad piesitiet **Instalēt**.
5. Pirmajā palaišanā piešķiriet abas atļaujas:
    - **Paziņojumi** — pastāvīgajam foreground paziņojumam, kas tur balsošanu dzīvu, kad lietotne ir aizvērta.
    - **Atspējot baterijas optimizāciju** (Iestatījumi → Lietotnes → GuruShots Auto Vote → Baterija → Neierobežots) — ražotāja baterijas taupītāji (Samsung, Xiaomi, OnePlus…) citādi nogalinās servisu.
6. Pieslēdzieties, piesitiet **Sākt automātisko balsošanu**. Pastāvīgais paziņojums rāda pēdējā cikla laiku. Varat aizvilkt lietotni no nesenajiem — balsošana turpinās.

**Fona ierobežojumi:** ražotāja baterijas pārvaldnieki joprojām var nogalināt servisu (baltā saraksta lietotni katram ražotājam; saite Iestatījumos). 1-minūtes pēdējās minūtes kadence prasa `SCHEDULE_EXACT_ALARM` (automātiski piešķirta Android 13+, manuāla Android 12).

## 🎯 Ātrais sākums

### Grafiskā lietotne

1. **Pieslēdzieties** ar savu GuruShots e-pastu un paroli.
2. Izvēlieties **tēmu/valodu** un vai **palikt pieslēgtam**.
3. Atveriet **Iestatījumus** un uzstādiet globālos noklusējumus (sāciet ar `exposure` un boost/turbo laikiem).
4. Pēc izvēles atveriet izaicinājuma **⚙️**, lai pārrakstītu iestatījumus tikai šim izaicinājumam.
5. Noklikšķiniet uz **Sākt automātisko balsošanu**.

### Komandrinda

```bash
./gurucli-v1.11.0-[platforma] login    # autentificējieties vienreiz (saglabā tokenu)
./gurucli-v1.11.0-[platforma] run      # viens pilns auto-stratēģijas cikls (boost/turbo/auto-iesniegšana/slieksnis-balsošana)
./gurucli-v1.11.0-[platforma] start    # nepārtraukta balsošana (Ctrl+C, lai apturētu)
```

> Aizstājiet `[platforma]` ar `mac`, `linux` vai `linux-arm`. Palaidiet `help`, lai redzētu visas komandas.

## 🔧 Lietošana

### Grafiskā lietotne

- **Pieslēgšanās ekrāns** — e-pasts, parole, _Saglabāt pieteikšanos_, tēma un valoda.
- **Augšējā josla** — lietotnes nosaukums, mock režīma indikators, Iestatījumi un Iziet.
- **Auto-balsošanas vadība** — Sākt/Apturēt, statusa nozīme (darbojas / gaida / dīkstāve), pēdējā cikla laiks un sesijas ciklu skaits.
- **Izaicinājumu saraksts** — katra kartīte rāda nosaukumu, beigu laiku, jūsu ekspozīciju un balsošanas statusu. Poga **⚙️** atver pārrakstīšanas logu konkrētam izaicinājumam (jebkuru balsošanas iestatījumu var pārrakstīt; neuzstādītās vērtības izmanto globālos noklusējumus).
- **Izaicinājuma detaļas** — jūsu vieta/ekspozīcija/balsis, jūsu iesniegtās fotogrāfijas un boost/turbo statuss.
- **Darbības katram foto** — uz katras fotogrāfijas **🚀 Pielietot Boost** un **⚡ Pielietot Turbo** parādās, kad pieejamas. Boost un turbo ir savstarpēji izslēdzoši vienai fotogrāfijai, tāpēc, tiklīdz viens ir pielietots, otra poga šai fotogrāfijai nerādās.
- **Spēlēt Auto-Turbo** — atvērtiem izaicinājumiem bez rokā esoša turbo, palaiž mini-spēli, lai iegūtu turbo (darbojas arī automātiski, kad `autoTurbo` ir ieslēgts).
- **Atjauninājumu dialogs** — parādās, kad pieejams jauns izlaidums: pieejams → lejupielādē (ar progresu) → gatavs instalēšanai (vai kļūda).

> **Piezīme:** iestatījumu maiņa vai grafiskās lietotnes loga pārvietošana, kamēr auto-balsošana darbojas, **aptur** balsošanas ciklu (loga pārvietošana saglabā jaunās pozīcijas iestatījumos). Pēc tam atsāciet auto-balsošanu.

### CLI komandas

> **⚠️** Vienlaikus darbiniet tikai VIENU instanci (grafisko lietotni vai CLI).

| Komanda                                           | Ko tā dara                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                                           | Autentificējieties ar GuruShots un saglabājiet tokenu (interaktīvs; nepieciešams īsts terminālis).                                                              |
| `logout`                                          | Notīra saglabāto autentifikācijas tokenu.                                                                                                                       |
| `vote`                                            | Palaiž **vienu manuālu ciklu** — balso līdz **100%** visos aktīvajos izaicinājumos, ignorējot visus sliekšņus. Vienreizēja papildināšana.                       |
| `run [--challenge=<id>]`                          | Palaiž **vienu pilnu auto-stratēģijas ciklu** (boost / turbo / auto-iesniegšana / slieksni ievērojoša balsošana). `--challenge` ierobežo uz vienu.              |
| `boost --challenge=<id> [--image=<id>]`           | Pielieto boost vienam izaicinājumam. Bez `--image` izmanto `boostImageIndex` vietu.                                                                             |
| `turbo --challenge=<id>`                          | Spēlē turbo mini-spēli, lai iegūtu turbo vienam izaicinājumam (tikai iegūšana; rokā esošu turbo pielieto `useTurbo` vai grafiskā lietotne).                     |
| `submit --challenge=<id> [--all]`                 | Iesniedz labāk ranžēto fotogrāfiju vienā tukšā vietā, vai ar `--all` iesniedz foto visās tukšajās vietās uzreiz.                                                |
| `bankroll` (alias `coins`)                        | Parāda jūsu valūtu atlikumus — atslēgas / maiņas / uzpildes / monētas.                                                                                          |
| `discover`                                        | Uzskaita atvērtos (nepievienotos) izaicinājumus, kuriem varat pievienoties, ar katra tipu un monētu izmaksu.                                                    |
| `join <id> [--yes]`                               | Pievienojas atvērtam izaicinājumam. Bezmaksas pievienojas uzreiz; **maksas** izaicinājums izdrukā monētu izmaksu un prasa `--yes`, pirms tiek tērētas monētas.  |
| `list-scenarios`                                  | Parāda jūsu saglabātos scenārijus un piemēru šablonus.                                                                                                          |
| `scenario-template <id> [file]`                   | Izdrukā (vai ieraksta failā) piemēra scenāriju, no kura sākt.                                                                                                   |
| `import-scenario <file> [--overwrite] [--yes]`    | Pārbauda scenārija failu un parāda, ko tas dara, ieskaitot katru darbību, kas tērē; `--yes` to importē, `--overwrite` aizstāj scenāriju ar tādu pašu nosaukumu. |
| `export-scenario "<name>" [file]`                 | Izdrukā (vai ieraksta) scenāriju kā JSON kopīgošanai.                                                                                                           |
| `rename-scenario "<old>" "<new>"`                 | Pārdēvē scenāriju; izaicinājumi, kas to izmanto, seko jaunajam nosaukumam.                                                                                      |
| `delete-scenario "<name>"`                        | Dzēš scenāriju un notīra tā piešķīrumus.                                                                                                                        |
| `scenario-status --challenge=<id>`                | Kur izaicinājums ir savā scenārijā: fāze, pēdējā darbība, pēdējā problēma.                                                                                      |
| `scenario-dry-run --challenge=<id>`               | Ko scenārijs darītu tieši tagad (neko netērē).                                                                                                                  |
| `scenario-simulate --challenge=<id>`              | "Kas būtu, ja" laika līnija līdz izaicinājuma beigām (neko netērē).                                                                                             |
| `scenario-reset --challenge=<id>`                 | Aizmirst izaicinājuma scenārija progresu, lai plāns sāktos no jauna.                                                                                            |
| `scenario-vocabulary`                             | Uzskaita katru nosacījumu, ieraksta izvēli un darbību, ko scenārijs var izmantot.                                                                               |
| `check-updates`                                   | Pārbauda GitHub, vai nav pieejams jaunāks izlaidums.                                                                                                            |
| `start`                                           | Sāk **nepārtrauktu** balsošanu ar dinamisku plānošanu. Darbojas, līdz nospiežat **Ctrl+C**.                                                                     |
| `status`                                          | Parāda režīmu (MOCK/REAL), autentifikācijas statusu un galvenos iestatījumus.                                                                                   |
| `get-setting <key> [--challenge=<id>]`            | Izdrukā iestatījuma efektīvo vērtību (katram izaicinājumam ar `--challenge`).                                                                                   |
| `set-setting <key> <value> [--challenge=<id>]`    | Uzstāda iestatījumu; ar `--challenge` ieraksta pārrakstījumu konkrētam izaicinājumam.                                                                           |
| `set-global-default <key> <value>`                | Uzstāda globālo noklusējumu **ar shēmas validāciju**.                                                                                                           |
| `list-settings [--challenge=<id>]`                | Parāda visus iestatījumus un modifikācijas statusu (skats katram izaicinājumam ar `--challenge`).                                                               |
| `reset-setting <key> [--challenge=<id>]`          | Atiestata iestatījumu uz noklusējumu (vai notīra izaicinājuma pārrakstījumu ar `--challenge`).                                                                  |
| `reset-all-settings`                              | Atiestata visu uz noklusējumiem (saglabā tokenu, mock karogu un API galvenes).                                                                                  |
| `logs [--error\|--api\|--settings] [--lines=<n>]` | Izdrukā žurnālfaila beigas (noklusējums 100 rindas; noklusējuma kategorija ir lietotnes žurnāls).                                                               |
| `reset-windows`                                   | Atiestata grafiskās lietotnes logu pozīcijas uz noklusējumiem.                                                                                                  |
| `help-settings`                                   | Detalizēta palīdzība par iestatījumiem — atslēgu nosaukumi, vērtību formāti, diapazoni.                                                                         |
| `help`                                            | Parāda komandu palīdzību.                                                                                                                                       |

Iestatījumi ir kopīgi ar grafisko lietotni: CLI veikts `set-setting` tiek pamanīts grafiskajā lietotnē un otrādi.

> Aizstājiet `[platforma]` zemāk ar `mac`, `linux` vai `linux-arm`.

```bash
./gurucli-v1.11.0-[platforma] set-global-default exposure 80
./gurucli-v1.11.0-[platforma] set-setting onlyBoost true --challenge=12345
./gurucli-v1.11.0-[platforma] list-settings --challenge=12345
./gurucli-v1.11.0-[platforma] logs --error --lines=50
```

## ⚙️ Kā darbojas balsošana

### Viens balsošanas cikls

Cikls ir viena caurlaide pa visiem jūsu aktīvajiem izaicinājumiem. Katram, šādā secībā, lietotne: pielieto **boost**, ja pienācis laiks, spēlē/pielieto **turbo**, ja atbilstošs, **auto-iesniedz** foto tukšā vietā, ja ir laiks, un pēc tam **balso** līdz mērķim, ko nosaka zemāk aprakstītie noteikumi.

### Ekspozīcijas noteikumi (kurš mērķis tiek piemērots)

Katram izaicinājumam ir ekspozīcijas **slieksnis** ("balsot, kamēr mana ekspozīcija ir zem tā") un balsošanas **mērķis** ("turpināt balsot līdz šim %"). Uzvar pirmais atbilstošais noteikums:

1. **Tikai boost** (`onlyBoost`) — balsošana tiek pilnībā izlaista; lietotne pielieto tikai boost/turbo.
2. **Vēl nav sācies** — izlaists.
3. **Flash izaicinājums** — vienmēr mērķis **100%**.
4. **Balsot tikai pēdējā minūtē** (`voteOnlyInLastMinute`) — ja iestatīts un izaicinājums _vēl nav_ savā pēdējās minūtes logā, balsošana tiek izlaista.
5. **Pēdējās minūtes logs** — `lastMinuteThreshold` minūšu robežās pirms beigām vienmēr mērķis **100%** (ekspozīcijas griesti tiek ignorēti).
6. **Beigu logs** — ja `useFinalWindowExposure` ir ieslēgts un izaicinājums ir `finalWindowDuration` robežās pirms beigām (noklusējums 1 stunda), izmanto `finalWindowExposure` slieksni un `finalWindowExposureTarget` mērķi.
7. **Normāli** — citādi izmanto `exposure` slieksni un `exposureTarget` mērķi.

Sliekšņiem ar atsevišķu mērķi lietotne balso tikai tad, kad esat zem sliekšņa, pēc tam turpina līdz mērķim. Mērķis `0` nozīmē "apstāties pie sliekšņa" (mērķis = slieksnis).

### Plānošanas kadence

Nepārtrauktajā režīmā starp cikliem tiek izvēlēta nejauša aizture diapazonā `[checkFrequencyMin, checkFrequencyMax]` minūtes. Tiklīdz kāds izaicinājums ienāk savā `lastMinuteThreshold` logā, plānotājs pārslēdzas uz fiksētu, ciešāku kadenci (`lastMinuteCheckFrequency`, noklusējums ik minūti), līdz neviens izaicinājums vairs nav šajā logā, tad atgriežas. (Skatiet [`scheduling.md`](docs/scheduling.md) par platformu iekšējo darbību — CLI/Android izmanto vienu dzinēju; grafiskā lietotne izmanto to pašu matemātiku.)

### Boost

Kad `autoBoost` ir ieslēgts, lietotne pielieto pieejamo boost foto vietai `boostImageIndex` (1 = pirmā fotogrāfija, `0` = pēdējā; tā paiet vienu vietu atpakaļ, ja šai vietai jau ir turbo):

- **Taimera boost** — pielieto, kad boost savā taimerī atlicis `boostTime` sekundes vai mazāk.
- **Atslēgas atvērts boost** (bez taimera) — boost taimers tiek ignorēts; pielieto tikai pēdējās 15 minūtēs pirms izaicinājuma beigām.

### Turbo (iegūt, pēc tam pielietot)

Turbo ir lēni atjaunojams patēriņa resurss, ko iegūstat, spēlējot mini-spēli, un pēc tam tērējat, kad vēlaties. Abas puses ir neatkarīgi iestatījumi:

- **Auto-iegūt (`autoTurbo`, pēc noklusējuma ieslēgts)** — kad nav rokā turbo, lietotne katru ciklu spēlē mini-spēli, lai iegūtu vienu. (Grafiskās lietotnes ekvivalents: poga **Spēlēt Auto-Turbo**.)
- **Auto-pielietot (`useTurbo`, pēc noklusējuma izslēgts)** — kad turbo ir rokā un izaicinājumam atlicis `turboTime` sekundes vai mazāk, to pielieto foto vietai `turboImageIndex`. Tas negaida atvērta boost loga beigas — boost un turbo tikai nekad nav uz viena un tā paša foto.

Grafiskajā lietotnē rokā esošu turbo varat pielietot arī konkrētai fotogrāfijai ar tās **⚡** pogu, pārrakstot auto vietu. Viena fotogrāfija var būt vai nu ar boost, vai ar turbo, nekad abiem.

### Trūkstošo ierakstu auto-iesniegšana

GuruShots **uzpilde** (angliski _fill_) ir valūta, kas paceļ redzamību līdz 100% (viens no atlikumiem, ko rāda [Konta atlikums](#konta-atlikums)). Foto iesniegšana tukšajās vietās ir kas cits, un lietotne to sauc par **auto-iesniegšanu**.

Kad izaicinājums ļauj iesniegt vairākas fotogrāfijas un esat atstājuši tukšas vietas, šīs vietas beigās tiek izniekotas. Ar ieslēgtu `autoFill` plānotājs iesniedz **vienu fotogrāfiju katrā ciklā**, sekojot jūsu `autoFillSchedule` — soļu sarakstam, kur katrs solis nozīmē "kad līdz beigām atlicis `seconds`, jābūt vismaz `count` foto" (piem., 2. foto pie 48h, 3. pie 3h, 4. pie 15min). Ja esat atpalicis no grafika (lietotne palaista vēlu vai solis pārsniedz visu izaicinājuma ilgumu), tā panāk grafiku pa vienam foto ciklā. Atstarpe ir svarīga, jo GuruShots atšķaida balsis starp vienlaikus iesniegtiem ierakstiem, tāpēc atstatums dod katram jaunajam ierakstam neatkarīgu ekspozīciju. Esošie `autoFillIntervalMinutes` iestatījumi tiek migrēti automātiski (intervāls `M` kļūst par 2 @ 3×M, 3 @ 2×M, 4 @ 1×M minūtēm pirms beigām).

- **`emergencyFill`** (Ārkārtas iesniegšana) — drošības tīkls: pēdējā posmā pirms beigām tas iesniedz foto visās atlikušajās vietās pat tad, kad normālie noteikumi gaidītu, un pārraksta must-include tagu filtru. Šajā pašā logā tas pielieto arī jebkuru pieejamu Boost un jebkuru iegūtu Turbo pat tad, kad `autoBoost` / `useTurbo` šim izaicinājumam ir izslēgti, lai tie netiktu izniekoti beigās. Grafiskajā lietotnē ievada kā h+m (glabā sekundēs). `0` to atspējo (kas atspējo arī boost/turbo pārrakstīšanu); turiet to `≤ lastMinuteThreshold`, lai ātrā pēdējās minūtes kadence būtu aktīva visā logā.
- **Tagu filtri** — `mustIncludeTags` ir cietais filtrs (atbilstošas tikai fotogrāfijas ar visiem tagiem); `shouldIncludeTags` ir mīkstā preference. `fillWithoutTagMatch` izlemj, kas notiek, kad must-include tagi ir iestatīti, bet nekas neatbilst visiem tagiem: tomēr iesniegt (noklusējums) vai atstāt vietu tukšu.
- **Noteikumu tagi** — [izaicinājumu noteikums](#izaicinājumu-noteikumi) var pievienot must/should-include tagus; iesniegšanas brīdī tie tiek apvienoti efektīvajos tagu sarakstos, tāpēc atkārtots izaicinājums katrā rotācijā atgūst savus tagus.
- **Fotogrāfiju izvēle** — kandidātus savāc ar vienmēr ieslēgtu servera puses tematisko meklēšanu paša GuruShots tagu indeksā — izmantojot jūsu must/should-include tagus, ja tie ir iestatīti, citādi atslēgvārdus no izaicinājuma nosaukuma — un atkāpjoties uz jūsu pilno atbilstošo bibliotēku, ja tā neko neuzrāda. Pēc tam katru kandidātu ranžē vienmēr ieslēgts semantiskais tēmas rezultāts (cik labi tas atbilst izaicinājumam, `0`–`1`) — ar atslēgvārdu/saknes salīdzināšanu pret fotogrāfijas vīzijas iezīmēm kā rezerves variantu, kad semantiskie dati nav pieejami — un neizšķirtus gadījumus risina pēc sasniegumu skaita, kopējā balsu skaita, skatījumu skaita, tad augšupielādes datuma.
- **Vizuālā pārbaude** — pirms fotogrāfijas iesniegšanas ierīcē strādājošs attēlu modelis apskata 12 augstāk ranžētos kandidātus un salīdzina katru ar izaicinājumu — tā nosaukuma tematu (bez sērijas priedēkļa, noliegtajiem vārdiem kā "No Humans" un jūsu `ignoreTitleWords`) un apraksta sākumu (bez HTML un standarta balvu teksta). Fotogrāfijas, kurās temats acīmredzami nav redzams, tiek pārvietotas aiz tām, kurās tas ir; starp pārbaudi izturējušajām saglabājas augstāk aprakstītā ranžēšana, tāpēc popularitāte joprojām izšķir. Darbojas katrā izaicinājumā bez iestatīšanas. Tā nekad neatstāj vietu tukšu: ja nosaukumā nav vizuāla temata ("Photo of the Day", "Guru of The Week"), ja neviena fotogrāfija skaidri neatbilst (abstraktas tēmas kā "It's all About Balance") vai ja modeli neizdodas palaist, tiek izmantota augstāk aprakstītā ranžēšana bez izmaiņām. Tā pati pārbaude darbojas auto-iesniegšanai, ārkārtas iesniegšanai, `+1`/`+N` pogām, jaunās foto boost/turbo, foto maiņai un auto-pievienošanās. Galddatora procesoram tā aizņem ~1–1,5 s katram izaicinājumam, telefonā ilgāk; modelis tiek ielādēts vienreiz, pirmajā foto iesniegšanā pēc palaišanas.
- **Jaunās foto boost/turbo** — ar ieslēgtu `boostFillNew` / `turboFillNew` lietotne iesniedz jaunu fotogrāfiju un uzreiz pielieto boost / turbo šim jaunajam ierakstam, lai pieejamais boost vai turbo nepaliktu neizmantots tukšā vietā.
- **Manuālās pogas** — katrai kartītei ar tukšām vietām ir **`+1`** (iesniegt labāk ranžēto fotogrāfiju vienā vietā) un **`+N`** (iesniegt foto visās atlikušajās vietās uzreiz, ignorējot atstarpi). Manuālie klikšķi ignorē `autoFill` slēdzi un ir atspējoti, kamēr auto-balsošana darbojas.

Jaunos iesniegtos ierakstus boost un turbo noteikumi pamana automātiski _nākamajā_ ciklā.

### Tikai-boost režīms

`onlyBoost` (katram izaicinājumam) izslēdz normālo balsošanu šim izaicinājumam — lietotne darbojas tikai tad, kad var pielietot boost vai turbo. Noderīgi mazsvarīgiem izaicinājumiem, kuros vēlaties tērēt boost/turbo, bet ne balsis.

### Auto-pievienošanās izaicinājumiem

Viss iepriekšējais darbojas ar izaicinājumiem, kuriem jau esat pievienojies. **Auto-pievienošanās** (pēc noklusējuma izslēgta) katrā ciklā atrod **atvērtos, nepievienotos** izaicinājumus un pievienojas tiem, kurus vēlaties. Tā darbojas kā solis pirms balsošanas visās platformās (grafiskā lietotne, CLI `start`, Android), un pievienošanās nozīmē foto iesniegšanu — auto-pievienošanās izmanto to pašu foto izvēli kā auto-iesniegšana (tagi, tematiskā meklēšana, semantiskā ranžēšana, vizuālā pārbaude).

- **Tvērums — kurus izaicinājumus pievienot.** Ieslēdz `autoJoin`, un tas pēc noklusējuma pievienojas **visiem** atvērtajiem izaicinājumiem; sašaurini ar tipu sarakstiem (pēc izvēles):
    - `autoJoinTypes` — **iekļaušanas** saraksts ar izaicinājumu tipiem, atdalīti ar komatu (piem., `flash,contest`). Atstāj **tukšu, lai pievienotos visiem tipiem** (noklusējums).
    - `autoJoinExcludeTypes` — **izslēgšanas** saraksts ar tipiem, kuriem nekad nepievienoties (piem., `flash,exhibition`). Tā kā noklusējums ir visi, šis viens pats dod "pievienoties visam, izņemot flash un exhibition".
    - **Noteikuma izvēle** uzvar pār abiem tipu sarakstiem: [izaicinājumu noteikums](#izaicinājumu-noteikumi), kas ieslēdz auto-pievienošanos, vai profils, ko piešķir noteikums ar nosaukumu vai izaicinājuma tagu. Profils no noteikuma, kas atlasa tikai pēc veida / bilžu skaita / ilguma, tipu sarakstus **neapiet** — tas nosaka, kā balsot, nevis vai pievienoties.
- **Maksas izaicinājumi — monētu drošība.** Maksas pievienošanās pēc noklusējuma **izslēgta** un ierobežota ar diviem limitiem, abi `0 = izslēgts`: `autoJoinMaxCoins` (maksimums monētu vienai pievienošanās reizei) un `autoJoinCycleCoinBudget` (kopējais monētu daudzums vienā ciklā). **Abiem jābūt > 0**, lai tērētu monētas. Maksas pievienošanās nekad netiek apmaksāta bez pabeigtas pievienošanās: vispirms tiek atrasta foto (nav foto ⇒ izlaist, netērēt), un ja apmaksa izdodas, bet iesniegšana neizdodas, stāvoklis tiek iegaumēts, tāpēc atkārtojums pabeidz iesniegšanu, nevis maksā vēlreiz.
- **Manuāla pievienošanās.** Sakļauts **Atklāt** panelis zem izaicinājumu saraksta parāda atvērtos izaicinājumus; bezmaksas pievienojas ar klikšķi, maksas atver apstiprinājumu ar izmaksu un jūsu atlikušo bilanci. No CLI izmantojiet `discover`, lai tos uzskaitītu, un `join <id>` (maksas prasa `--yes`).
- **Indikators.** Kamēr auto-balsošana darbojas un auto-pievienošanās ir aktīva (master ieslēgts vai to iespējo izaicinājumu noteikums), galvenē blakus taimerim parādās **"auto-pievienošanās ieslēgta"** nozīmīte — tā parādās tikai tad, kad pievienošanās solis tiešām darbosies katrā ciklā, nevis tikai tad, kad iestatījums ir ieslēgts.
- **Pievienošanās laiks.** `autoJoinWithinHoursOfEnd` gaida, līdz izaicinājumam līdz beigām atlicis tik stundu; `autoJoinAfterPercentElapsed` gaida, līdz pagājusi šī daļa no paša izaicinājuma ilguma (75 = pēdējā ceturtdaļa), kas der gan 24 stundu, gan vairāku nedēļu izaicinājumiem. Ja procenti ir virs 0, tie aizstāj stundu logu. Izaicinājums ārpus loga tiek pārbaudīts katrā ciklā no jauna, nevis izlaists pavisam.
- **Prioritāte.** `autoJoin`, tipu/monētu iestatījumi un pievienošanās laiks tiek atrisināti caur [izaicinājumu noteikumiem](#izaicinājumu-noteikumi) (salīdzinot ar pašu nepievienoto izaicinājumu), tad master noklusējumu — tāpēc noteikums var ieslēgt pievienošanos, atslābināt vai pastiprināt limitus vai mainīt laiku izaicinājumiem, kuriem tas atbilst, pat ar izslēgtu master noklusējumu. Tikai `autoJoinCycleCoinBudget` paliek globāls — kopējam cikla tēriņa limitam nav nozīmes katram noteikumam.

### Izaicinājumu noteikumi

GuruShots katrā rotācijā atkārto izaicinājumu ar jaunu ID, tāpēc izaicinājuma pārrakstījums tiek zaudēts, kad izaicinājums atgriežas. **Izaicinājumu noteikumi** tā vietā atlasa pēc tā, kas saglabājas starp rotācijām. Tos pārvalda sadaļā **Izaicinājumu noteikumi** grafiskās lietotnes un Android lietotnes Iestatījumu logā; CLI tos piemēro, bet redaktora tam nav.

- **Nosacījumi.** Noteikums var atlasīt pēc jebkuras kombinācijas: viena vai vairākiem **nosaukumiem** (ir tieši / sākas ar / satur, reģistrnejutīgi — pietiek ar vienu no nosaukumiem), paša izaicinājuma **taga** (Exhibition, Comm, …, nevis foto tags), tā **veida** (default, flash, exhibition, …), **bilžu skaita** un **ilguma** — "ilgst vismaz" / "ilgst ne vairāk kā" stundās no sākuma līdz beigām (24 h = 1 diena, 168 h = 7 dienas). Jāatbilst katram aizpildītajam laukam; tukšs lauks netiek ņemts vērā. Izaicinājums ar nezināmu sākuma vai beigu laiku nekad neatbilst ilguma nosacījumam.
- **Ko noteikums dara.** Piešķir iestatījumu **profilu** (jebkurš izaicinājuma iestatījums — balsošana, boost, turbo, …) un [**scenāriju**](#scenāriji), ieslēdz vai izslēdz **auto-pievienošanos** / **auto-iesniegšanu**, iestata **pievienošanās laiku** (procenti no izaicinājuma ilguma vai stundas pirms beigām) un pievieno must/should-include **foto tagus**. Tukšs lauks nozīmē "noklusējums".
- **Secība nosaka.** Noteikumi tiek pārbaudīti no augšas uz leju. Katram iestatījumam uzvar pirmais atbilstošais noteikums, kas to iestata — noteikuma paša vērtība pirms tā profila —, bet tas, ko tas atstāj tukšu, nāk no nākamā atbilstošā noteikuma, tad no globālā noklusējuma. Izaicinājumam piemēro tikai **vienu profilu**: no pirmā atbilstošā noteikuma, kas norāda profilu. Izaicinājuma pārrakstījums ⚙️ logā joprojām uzvar pār visiem noteikumiem.
- **Noklusējuma secība.** **Kārtot pēc noklusējuma secības** vispirms liek noteikumus ar nosaukumu, tad pārējos; katrā grupā augstāk nonāk konkrētākais noteikums. Aptuveni: ir tieši pirms sākas ar pirms satur, un vairāk nosacījumu pirms mazāk — papildu nosacījums var pacelt "sākas ar" noteikumu līdz "ir tieši" līmenim, un tad uzvar garākais nosaukums. Vienlīdzīgus noteikumus kārto pēc bilžu skaita, tad ilguma, tad veida, tad taga — piem., `4 bildes + ≥ 168 h` virs `4 bildes` virs `≥ 168 h`. Secību var brīvi mainīt ar bultiņām; saglabājot tā tiek saglabāta.
- **Plaši noteikumi.** Noteikums bez nosaukuma var ieslēgt auto-pievienošanos vai auto-iesniegšanu katram atbilstošajam izaicinājumam; redaktors tad rāda brīdinājumu, jo viens noteikums var tērēt monētas vai foto veselai izaicinājumu grupai.
- **Atjaunināšana.** Ielādējot iestatījumus no vecākas versijas, saglabātie noteikumi vienreiz tiek sakārtoti noklusējuma secībā, un "pievienošanās laiks pēc kategorijas" noteikumi tiek pārvietoti šajā sarakstā zem tiem. Tā kā zemāks noteikums aizpilda to, ko augstāks atstāj tukšu, iestatījumu žurnālā parādās brīdinājums par katru noteikumu pāri, kur tas varētu ieslēgt auto-pievienošanos vai auto-iesniegšanu — ja tāds redzams, pārskatiet secību.

### Scenāriji

**Scenārijs** ir jūsu rakstīts plāns izaicinājumam, kas ilgst vairākas dienas — piemēram, "katru rītu iesniegt vienu bildi, un, ja kāda no tām strauji kāpj, noturēt to malā un pēdējā dienā pielietot tai Boost". Lietotnē nav iebūvētas taktikas: scenārijs sastāv no dažiem būvblokiem, un to kombināciju izvēlaties jūs.

**Kur tos atrast.** Grafiskajā un Android lietotnē: **Iestatījumi → Scenāriji**. Sāciet ar **Jauns scenārijs**, izvēlieties piemēru sadaļā **Sākt no šablona…** un spiediet **Pievienot kopiju**, vai **Importēt…** kāda kopīgotu scenāriju. Katram saglabātajam scenārijam ir **Rediģēt**, **Eksportēt**, **Pārdēvēt** un **Dzēst**; izmaiņas šeit tiek saglabātas uzreiz. Redaktoram ir divas cilnes — vizuālais **Veidotājs** un neapstrādāts **JSON** —, un saglabāšana pārbauda visu, norādot, kurš lauks ir nepareizs. CLI redaktora nav, bet tā var importēt, eksportēt, apskatīt un simulēt (skatiet [CLI komandas](#cli-komandas)).

**Piešķiršana.** Scenārijs neko nedara, kamēr to neizpilda kāds izaicinājums. Izvēlieties to izaicinājuma ⚙️ iestatījumos laukā **Scenārijs** vai piešķiriet to uzreiz daudziem izaicinājumiem ar [izaicinājumu noteikumu](#izaicinājumu-noteikumi) vai profilu (piemēram, katram `exhibition` izaicinājumam). No CLI: `set-setting scenario "<nosaukums>" --challenge=<id>`. Izaicinājuma kartītē tad parādās 🧭 rinda ar scenāriju, pašreizējo fāzi, nākamās pārbaudes laiku un pēdējo problēmu, ja tāda ir.

**Kā scenārijs ir veidots.**

- **Fāzes.** Scenārijam ir viena vai vairākas nosauktas fāzes, un tas sākas jūsu izvēlētajā. Kamēr izaicinājums ir fāzē, tam tiek piemēroti šīs fāzes **iestatījumi** (jebkurš izaicinājuma iestatījums — ekspozīcija, auto-Boost, auto-iesniegšana, …). Tiem ir priekšroka pār visu citu, ieskaitot jūsu manuālo ⚙️ pārrakstījumu, un parastie iestatījumi atgriežas, tiklīdz fāze tiek pamesta. Nekas netiek kopēts jūsu saglabātajos pārrakstījumos.
- **Noteikumi.** Katrai fāzei ir sakārtots noteikumu saraksts. Katrā balsošanas ciklā **pirmais noteikums, kura visi nosacījumi izpildās**, pēc kārtas izpilda savas darbības. Noteikuma iestatījums **Izpilda** nosaka, cik bieži: _katrā palaišanā, kamēr izpildās_, _tikai vienreiz_, _vienreiz katrā fāzes sākumā_ vai _vienreiz dienā_.
- **Nosacījumi** — diennakts laiks (lietotnes laika joslā), atlikušais laiks līdz beigām, laiks kopš sākuma, izaicinājuma pagājusī daļa, laiks šajā fāzē, ierakstu skaits, brīvās vietas, ekspozīcija, izaicinājuma vieta un balsis, Boost / Turbo stāvoklis, jūsu atslēgu / apmaiņu / uzpilžu / monētu atlikums, vai atcerētā bilde ir iestatīta, un pārbaude vienam ierakstam (tā balsis, vieta, **balsis stundā**, **ātruma attiecība** pret jūsu pārējiem ierakstiem, Boost / Turbo). Kombinējiet tos ar _visi no_, _jebkurš no_ un _ne_.
- **Kurš ieraksts.** Darbības un ierakstu pārbaudes izvēlas ierakstu pēc vietas, visvairāk / vismazāk balsu, labākās / sliktākās vietas, ātrākā (balsis stundā), ieraksta ar Boost vai Turbo, vai iepriekš atcerētas bildes — pēc izvēles izlaižot ierakstus ar Boost / Turbo.
- **Darbības** — iesniegt bildi (jūsu labāko piemēroto vai atcerētu), apmainīt ierakstu pret citu bildi (balsis, Boost un Turbo paliek pie bildes), pielietot Boost, pielietot Turbo, atbloķēt Boost ar atslēgu, uzpildīt ekspozīciju, balsot līdz noteiktam procentam, atcerēties / aizmirst bildi, pāriet uz citu fāzi un **paziņot** jums ar ziņojumu.
- **Atmiņa.** Noteikums var atcerēties bildi ar nosaukumu (piemēram, `held`), un vēlāks noteikums — pat pēc dienām, citā fāzē — var to apmainīt atpakaļ vai pielietot tai Boost.

Pilnu sarakstu ar visiem laukiem parāda CLI komanda `scenario-vocabulary`.

**Droši atstāt darbībā.**

- Pirms katras darbības izaicinājums tiek nolasīts no jauna, tāpēc darbība, kuras mērķis vairs nav, tiek izlaista, nevis minēta.
- Progress tiek saglabāts pēc katras darbības. Pēc avārijas vai restarta daļēji izpildīts noteikums turpina tur, kur apstājās, un nekad neatkārto tēriņu, kas jau notika.
- Tēriņi ievēro jūsu valūtas rezerves un paša scenārija neobligātos **tēriņu limitus** (apmaiņas / atslēgas / uzpildes).
- Ja scenārija saglabāto progresu nevar nolasīt vai jūs izdzēšat fāzi vai noteikumu, kura vidū tas bija, šis izaicinājums **apstājas** un jums par to paziņo (brīdinājums kartītē un paziņojums). Pats no sevis tas nekad nesākas no jauna. Izlabojiet scenāriju vai sāciet to no jauna ar `scenario-reset --challenge=<id>` CLI.
- Balsošanas ātruma nosacījumiem vajag vismaz 10 minūšu balsu vēsturi. Līdz tam tie ir nepatiesi.

**Izmēģiniet pirms tēriņiem.** Veidotājā izvēlieties izaicinājumu un spiediet **Simulēt**, lai redzētu "kas būtu, ja" laika līniju līdz izaicinājuma beigām: kas izpildītos, kad, un kāpēc tas apstājas. Tas darbojas arī ar nesaglabātām izmaiņām. Simulācija pieņem, ka katrs solis izdodas un balsis un vieta paliek tādas kā tagad. No CLI `scenario-dry-run` parāda, kas notiktu tieši tagad, un `scenario-simulate` — visu laika līniju; neviena no tām neko netērē.

**Šabloni**, no kuriem sākt: _Exhibition double-dip_, _Evening boost before the last day_, _Morning swap of the weakest entry_ un _Turbo in the top 10_. Pievienojiet kopiju un tad to rediģējiet.

Minimāls scenārijs JSON formātā — pielietot Boost labākajai vietai ierakstam no 20:00 līdz 21:00, kad līdz izaicinājuma beigām ir 1–2 dienas:

```json
{
    "name": "Evening boost",
    "version": 1,
    "start": "main",
    "phases": {
        "main": {
            "rules": [
                {
                    "id": "evening-boost",
                    "repeat": "once",
                    "if": [
                        { "type": "dailyWindow", "from": "20:00", "to": "21:00" },
                        { "type": "beforeEnd", "min": "1d", "max": "2d" },
                        { "type": "boostState", "in": ["AVAILABLE", "AVAILABLE_KEY"] }
                    ],
                    "do": [{ "type": "boost", "entry": { "by": "bestRank" } }]
                }
            ]
        }
    }
}
```

Ilgumus raksta kā `"90m"`, `"6h"`, `"1d 6h"` vai sekundēs. Importējiet scenāriju failus tikai no cilvēkiem, kam uzticaties — scenārijs var tērēt jūsu apmaiņas, atslēgas, uzpildes un Boost. Importa priekšskatījums pirms saglabāšanas uzskaita katru darbību, kas tērē.

**Paziņojumi.** Darbība `notify` un scenārijs, kas apstājas, jo tam vajag jūs, parāda paziņojumu darbvirsmas lietotnē un no `gurucli start` (izslēdz ar **Paziņojumi no scenārijiem**). Android lietotne scenāriju paziņojumus nerāda. Scenāriji tur tomēr darbojas, arī fona servisā.

### Konta atlikums

Jūsu valūtu atlikumi — **atslēgas / maiņas / uzpildes / monētas** — parādās blakus taimerim grafiskās lietotnes galvenē (tie rāda `—`, nevis `0`, ja atlikumu nevar nolasīt, tāpēc neizdevusies nolasīšana netiek sajaukta ar "tukšu"). No CLI `bankroll` (alias `coins`) tos izdrukā.

## 🎛️ Iestatījumu atsauce

Iestatījumi ir divos slāņos. **Lietotnes preferences** ir globālas visai lietotnei. **Izaicinājumu iestatījumiem** ir globālais noklusējums, un tos var **pārrakstīt katram izaicinājumam** (caur grafiskās lietotnes ⚙️ logu vai CLI `--challenge` karogu); efektīvā vērtība ir izaicinājuma pārrakstījums, ja tāds ir, citādi globālais noklusējums.

### Lietotnes preferences

| Iestatījums                               | Noklusējums   | Diapazons / vērtības | Piezīmes                                                                                   |
| ----------------------------------------- | ------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `theme`                                   | `light`       | `light`, `dark`      | Saskarnes tēma.                                                                            |
| `language`                                | `en`          | `en`, `lv`           | Saskarnes valoda (angļu / latviešu); pārslēdzas uzreiz.                                    |
| `timezone`                                | `Europe/Riga` | jebkura IANA josla   | Laika josla izaicinājumu laiku attēlošanai (`customTimezones` glabā pievienotās).          |
| `stayLoggedIn`                            | `false`       | bool                 | Izlaist pieslēgšanās logu nākamajā palaišanā, ja tokens eksistē.                           |
| `apiTimeout`                              | `30`          | 1–120 s              | API pieprasījuma noildze.                                                                  |
| `checkFrequencyMin` / `checkFrequencyMax` | `3` / `3`     | 1–60 min             | Nejauša aizture starp cikliem, izvēlēta `[min, max]`. Vienādas vērtības = fiksēta kadence. |
| `apiMaxRetries`                           | `3`           | 0–10                 | Atkārtojumi pārejošu kļūmju gadījumā (tīkls/noildze/429/5xx). `0` atspējo.                 |
| `apiRetryBaseDelayMs`                     | `1000`        | 100–10000 ms         | Bāzes aizture eksponenciālajai atkāpei starp atkārtojumiem.                                |
| `windowBounds`                            | —             | —                    | Grafiskās lietotnes loga pozīcija/izmērs (Electron); saglabājas automātiski.               |

**Paziņojumi** (darbvirsmas lietotne un `gurucli start`; tikai globāli — uzstāda ar `set-global-default`)

| Iestatījums             | Noklusējums | Diapazons / vērtības | Apraksts                                                                                      |
| ----------------------- | ----------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `notifyOnScenario`      | `true`      | bool                 | Rāda ziņojumus, ko sūta jūsu scenāriju `notify` soļi, un brīdinājumu, kad scenārijs apstājas. |
| `notifyOnBoost`         | `false`     | bool                 | Brīdina pirms Boost pielietošanas, lai jūs varētu atstāt lietotni darbībā.                    |
| `notifyOnTurbo`         | `false`     | bool                 | Brīdina pirms Turbo spēlēšanas.                                                               |
| `notifyOnAutoFill`      | `false`     | bool                 | Brīdina pirms bildes auto-iesniegšanas tuvu termiņam.                                         |
| `notifyOnEmergencyFill` | `false`     | bool                 | Brīdina pirms pēdējā brīža ārkārtas iesniegšanas.                                             |
| `notifyLeadTime`        | `5`         | 1–60 min             | Cik minūtes pirms darbības parāda brīdinājumu.                                                |

### Izaicinājumu iestatījumi

Visi atbalsta pārrakstīšanu katram izaicinājumam, izņemot kur norādīts.

**Vispārīgi**

| Iestatījums          | Noklusējums | Diapazons / vērtības                         | Apraksts                                                                                                                                                               |
| -------------------- | ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exposure`           | `100`       | 1–100 %                                      | Normālā sliekšņa vērtība: balsot, kamēr ekspozīcija ir zem tā.                                                                                                         |
| `exposureTarget`     | `0`         | `0` vai 1–100 % (ja iestatīts, ≥ `exposure`) | Balsot līdz šim %, kad iedarbojas normālais noteikums. `0` = apstāties pie sliekšņa.                                                                                   |
| `scenario`           | `''`        | saglabāta scenārija nosaukums vai tukšs      | [Scenārijs](#scenāriji), ko šis izaicinājums izpilda. Tukšs = nav. Katram izaicinājumam atsevišķi vai ar izaicinājumu noteikumu vai profilu (globālā noklusējuma nav). |
| `onlyBoost`          | `false`     | bool                                         | Izlaist normālo balsošanu; pielietot tikai boost/turbo.                                                                                                                |
| `compactCards`       | `false`     | bool                                         | Kompakts izaicinājumu kartīšu izkārtojums (tikai grafiskās lietotnes attēlojums).                                                                                      |
| `compactCardActions` | `false`     | bool                                         | Izaicinājuma darbību pogas (balsošana, palaišana, Turbo, iesniegšana, valūtas tēriņi, iestatījumi) kompaktajās kartītēs (tikai grafiskajā lietotnē, globāls).          |

**Boost**

| Iestatījums              | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                       |
| ------------------------ | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoBoost`              | `true`        | bool                 | Automātiski pielietot boost tuvu beigām.                                                                                                                                                                                                                       |
| `boostTime`              | `3600` s (1h) | ≥ 0                  | Pielietot taimera boost, kad atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada kā h+m.                                                                                                                                                           |
| `boostImageIndex`        | `1`           | vesels ≥ 0           | Foto vieta boost (1 = pirmā, `0` = pēdējā). Paiet atpakaļ, ja vietai jau ir turbo.                                                                                                                                                                             |
| `boostFillNew`           | `false`       | bool                 | Iesniegt jaunu fotogrāfiju un uzreiz pielietot boost šim jaunajam ierakstam.                                                                                                                                                                                   |
| `boostFillNewOnConflict` | `false`       | bool                 | Iesniegt jaunu foto un pielietot tam boost tikai tad, ja vienīgajam esošajam ierakstam jau ir turbo (boost tur nevar nokļūt). Ja nav brīvas vietas vai piemērota foto, boost tiek izlaists (atkāpšanās iespējas nav). Ignorēts, ja `boostFillNew` ir ieslēgts. |

**Turbo**

| Iestatījums              | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                       |
| ------------------------ | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useTurbo`               | `false`       | bool                 | Automātiski pielietot rokā esošu turbo pirms beigām.                                                                                                                                                                                                           |
| `autoTurbo`              | `true`        | bool                 | Automātiski spēlēt mini-spēli, lai iegūtu turbo, kad tāda nav rokā.                                                                                                                                                                                            |
| `turboTime`              | `7200` s (2h) | ≥ 0                  | Pielietot turbo, kad atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada kā h+m.                                                                                                                                                                   |
| `turboImageIndex`        | `1`           | vesels ≥ 0           | Foto vieta turbo (1 = pirmā, `0` = pēdējā). Paiet atpakaļ, ja vietai jau ir boost.                                                                                                                                                                             |
| `turboFillNew`           | `false`       | bool                 | Iesniegt jaunu fotogrāfiju un uzreiz pielietot turbo šim jaunajam ierakstam.                                                                                                                                                                                   |
| `turboFillNewOnConflict` | `false`       | bool                 | Iesniegt jaunu foto un pielietot tam turbo tikai tad, ja vienīgajam esošajam ierakstam jau ir boost (turbo tur nevar nokļūt). Ja nav brīvas vietas vai piemērota foto, turbo tiek izlaists (atkāpšanās iespējas nav). Ignorēts, ja `turboFillNew` ir ieslēgts. |

**Beigu logs**

| Iestatījums                    | Noklusējums | Diapazons / vērtības                                    | Apraksts                                                                                                                                                                                  |
| ------------------------------ | ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useFinalWindowExposure`       | `false`     | bool                                                    | Izmantot atsevišķu ekspozīcijas noteikumu beigu logā.                                                                                                                                     |
| `finalWindowDuration`          | `3600`      | 60 s – 30 d (glabā sekundēs)                            | Beigu loga garums pirms beigām. Noklusējums 1 stunda (mantotā fiksētā stunda).                                                                                                            |
| `finalWindowExposure`          | `100`       | 1–100 % (≤ `exposure`)                                  | Slieksnis, ko izmanto beigu logā.                                                                                                                                                         |
| `finalWindowExposureTarget`    | `0`         | `0` vai 1–100 % (ja iestatīts, ≥ `finalWindowExposure`) | Balsot līdz šim % beigu logā. `0` = apstāties pie sliekšņa.                                                                                                                               |
| `voteBeforeFinalWindow`        | `false`     | bool                                                    | Papildināt līdz **parastajam** ekspozīcijas mērķim logā ap beigu loga sākumu, lai zemais beigu loga slieksnis neatstātu novecojušu ekspozīciju. Aktīvs tikai ar `useFinalWindowExposure`. |
| `voteBeforeFinalWindowLeadMin` | `15`        | 1–59 min                                                | Pirms-beigu-loga papildināšanas loga puse (minūtēs) katrā pusē no beigu loga sākuma.                                                                                                      |

**Pēdējā minūte**

| Iestatījums                | Noklusējums | Diapazons / vērtības | Apraksts                                                                                                              |
| -------------------------- | ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `voteOnlyInLastMinute`     | `false`     | bool                 | Balsot tikai pēdējās minūtes logā (loga izmērs = `lastMinuteThreshold`, nevis burtiski viena minūte).                 |
| `lastMinuteThreshold`      | `10`        | 1–59 min             | Logs pirms beigām, kurā lietotne balso līdz 100 % neatkarīgi no ekspozīcijas griestiem.                               |
| `lastMinuteCheckFrequency` | `1`         | 1–59 min             | **Tikai globāls (bez pārrakstīšanas katram izaicinājumam).** Plānotāja kadence, kamēr kāds izaicinājums ir savā logā. |

**Auto-iesniegšana**

| Iestatījums           | Noklusējums         | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFill`            | `false`             | bool                 | Iesniegt fotogrāfijas tukšajās foto vietās tuvu beigām (ar atstarpi, vienu katrā ciklā).                                                                                                                                                                                                                                                                                    |
| `autoFillSchedule`    | 2@30m, 3@20m, 4@10m | foto 2–4             | `{count, seconds}` rindas: kad atlicis ≤ `seconds`, jābūt ≥ `count` foto. Tikai foto 2–4; izlaid foto (vai GUI iestati 0h 0m), lai to nekad neplānotu. Aizstāj `autoFillIntervalMinutes` (migrē automātiski).                                                                                                                                                               |
| `fillWithoutTagMatch` | `true`              | bool                 | Ja must-include tagi iestatīti, bet neviena fotogrāfija neatbilst visiem tagiem: tomēr iesniegt (`true`) vai atstāt vietu tukšu (`false`).                                                                                                                                                                                                                                  |
| `emergencyFill`       | `300` s (5m)        | ≥ 0                  | Ārkārtas iesniegšana — pēdējo minūšu drošības tīkls: iesniegt foto atlikušajās vietās pat ja noteikumi gaidītu, pārrakstot must-include tagus; pielieto arī jebkuru pieejamu Boost/iegūtu Turbo pat tad, kad `autoBoost`/`useTurbo` ir izslēgti. `0` = izslēgts (atspējo arī Boost/Turbo pārrakstīšanu). Turiet ≤ `lastMinuteThreshold`. Grafiskajā lietotnē ievada kā h+m. |
| `mustIncludeTags`     | `[]`                | līdz 50 tagiem       | Cietais filtrs: iesniegt tikai fotogrāfijas, kas atbilst visiem šiem tagiem.                                                                                                                                                                                                                                                                                                |
| `shouldIncludeTags`   | `[]`                | līdz 50 tagiem       | Mīkstā preference: dot priekšroku fotogrāfijām ar šiem tagiem, bet neizslēgt citas.                                                                                                                                                                                                                                                                                         |

**Auto-pievienošanās**

| Iestatījums                   | Noklusējums | Diapazons / vērtības   | Apraksts                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autoJoin`                    | `false`     | bool                   | Ieslēgt auto-pievienošanos. Kad ieslēgts, pēc noklusējuma pievienojas **visiem** atvērtajiem. [Izaicinājumu noteikums](#izaicinājumu-noteikumi) var to ieslēgt (vai izslēgt) izaicinājumiem, kuriem tas atbilst, pat tad, ja master noklusējums ir izslēgts. |
| `autoJoinTypes`               | `''`        | tipi, ar komatu        | Tvērums: **iekļaut** tikai šos izaicinājumu tipus, piem., `flash,contest`. **Tukšs = visi tipi** (noklusējums). Reģistrnejutīgs; atstarpes ap komatiem tiek ignorētas.                                                                                       |
| `autoJoinExcludeTypes`        | `''`        | tipi, ar komatu        | **Nekad** nepievienoties šiem tipiem, piem., `flash,exhibition`. Atņem no noklusējuma-visi tvēruma, tāpēc šis viens pats dod "pievienoties visam, izņemot šos". Noteikuma izvēle joprojām pievieno savus izaicinājumus.                                      |
| `autoJoinMaxCoins`            | `0`         | ≥ 0 (0 = izslēgts)     | Maksimums monētu vienas maksas pievienošanās reizei. `0` = tikai bezmaksas izaicinājumi.                                                                                                                                                                     |
| `autoJoinCycleCoinBudget`     | `0`         | ≥ 0 (0 = izslēgts)     | Kopējais monētu daudzums, ko pievienošanās solis drīkst tērēt **vienā ciklā** (globāls). `0` = netērēt. Maksas pievienošanās prasa, lai **abi** šis un `autoJoinMaxCoins` būtu > 0.                                                                          |
| `autoJoinWithinHoursOfEnd`    | `0`         | 0–720 h (0 = izslēgts) | Pievienoties izaicinājumam tikai tad, kad līdz beigām atlicis ne vairāk kā tik stundu. `0` = pievienoties uzreiz.                                                                                                                                            |
| `autoJoinAfterPercentElapsed` | `0`         | 0–99 % (0 = izslēgts)  | Pievienoties izaicinājumam tikai tad, kad pagājusi šī daļa no tā ilguma. Virs 0 aizstāj stundu logu.                                                                                                                                                         |

## 📐 Ieteicamie iestatījumi

**Maksimāla ekspozīcija visur** — pacelt katru aktīvo izaicinājumu augšā.
`exposure` 100, `lastMinuteThreshold` 30, pārbaudes biežums 3 min, `onlyBoost` izslēgts, `voteOnlyInLastMinute` izslēgts. Sāciet auto-balsošanu un atstājiet to darboties.

**Taupīt balsis, sist vēlu** — balsot tikai pēdējās minūtēs.
`exposure` 90, `lastMinuteThreshold` 15, `voteOnlyInLastMinute` ieslēgts. Lietotne gaida, līdz izaicinājums ir savā logā, tad balso līdz 100%.

**Tikai boost** — tērēt boost, bet ne balsis (piem., mazsvarīgiem izaicinājumiem).
`onlyBoost` ieslēgts, `boostTime` 7200 (2h), pārbaudes biežums 10 min.

**Pielāgošana katram izaicinājumam** — uzstādiet saprātīgus globālos noklusējumus, pēc tam atveriet izaicinājuma **⚙️** (grafiskā lietotne) vai izmantojiet `set-setting <key> <value> --challenge=<id>` (CLI), lai pārrakstītu tikai svarīgākos.

## 📝 Žurnālfaili

Žurnālfaili palīdz problēmu risināšanā un tiek glabāti kopā ar jūsu iestatījumiem:

- **macOS:** `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Windows:** `%APPDATA%\gurushots-auto-vote\logs\`
- **Linux:** `~/.config/gurushots-auto-vote/logs/`

Faili tiek rotēti katru dienu (`<tips>-YYYY-MM-DD.log`) un automātiski tīrīti pēc vecuma un izmēra, palaižoties un ik stundu darbības laikā:

| Fails        | Saturs                                                | Glabā     | Maks. izmērs |
| ------------ | ----------------------------------------------------- | --------- | ------------ |
| `errors-*`   | Kļūdas visās kategorijās                              | 30 dienas | 10 MB        |
| `app-*`      | Vispārējā lietotnes darbība                           | 7 dienas  | 50 MB        |
| `settings-*` | Iestatījumu lasīšana/rakstīšana                       | 7 dienas  | 10 MB        |
| `api-*`      | API pieprasījumi/atbildes (tikai source/dev būvējumi) | 1 diena   | 20 MB        |

No CLI jebkuru no tiem var apskatīt ar `logs [--error|--api|--settings] [--lines=<n>]`. Akreditācijas dati tiek aizklāti pirms jebkas tiek ierakstīts diskā.

Vizuālā pārbaude raksta žurnālā kategorijā `autoFill`: `Visual check reordered picks for [Challenge …]`, ja tā mainīja iesniedzamo fotogrāfiju, un `Visual check unavailable for [Challenge …]`, ja modeli neizdevās palaist (tad tika izmantota tagu ranžēšana). Ja ieraksta nav, pārbaude piekrita ranžēšanai vai atturējās.

## 🔍 Problēmu risināšana

**"Nav atrasts autentifikācijas tokens" / "Token beidzies"** — pieslēdzieties vēlreiz no pieslēgšanās ekrāna (CLI: palaidiet `login`). Tokeni ir saistīti ar jūsu kontu; ja tas atkārtojas, pārbaudiet sistēmas pulksteni.

**"Tīkla kļūda"** — pārbaudiet savienojumu un ugunsmūri, palieliniet `apiTimeout` (mēģiniet 60–120 s) un mēģiniet vēlāk; GuruShots var būt īslaicīgi nepieejams.

**"API Rate Limit Exceeded" / "Too Many Requests"** — apturiet **visas** instances (grafisko lietotni un CLI), pagaidiet 5–10 minūtes un pārliecinieties, ka darbojas tikai viena.

**Auto-balsošana darbojas, bet nekas nenotiek** — pārbaudiet, vai jums ir aktīvi izaicinājumi, vai ekspozīcija jau nav pie sliekšņa (noklusējums 100%), un vai `voteOnlyInLastMinute` nav ieslēgts, kamēr izaicinājumi vēl ir ārpus pēdējās minūtes loga. Pārbaudiet žurnālfailus, lai redzētu izlaišanas iemeslu katram izaicinājumam.

**Auto-iesniegšana izvēlējās tematam neatbilstošu fotogrāfiju** — vizuālā pārbaude izvēlas tikai starp 12 augstākajiem kandidātiem, ko atrada tagu meklēšana, tāpēc, ja nevienā no tiem temats nav redzams, tā nevar palīdzēt: pievienojiet šim izaicinājumam `mustIncludeTags`/`shouldIncludeTags` (vai [izaicinājumu noteikumu](#izaicinājumu-noteikumi)), lai sarakstā nonāktu labāki kandidāti. Žurnāla ieraksts `Visual check unavailable` nozīmē, ka attēlu modeli neizdevās ielādēt vai palaist; CLI modeli izpako pirmajā lietošanas reizē (skatiet [Instalācija katrai platformai](#instalācija-katrai-platformai)), tāpēc pārbaudiet brīvo vietu diskā.

**Logs atveras ārpus ekrāna** — restartējiet lietotni; no CLI palaidiet `reset-windows`.

**Android: balsošana apstājas fonā** — iestatiet lietotnes baterijas lietojumu uz **Neierobežots** un baltā saraksta to sava ražotāja baterijas pārvaldniekā; Android 12 piešķiriet exact-alarm atļauju 1-minūtes pēdējās minūtes kadencei.

Ja joprojām esat iestrēdzis, pārbaudiet žurnālfailus un [atveriet problēmu](https://github.com/isthisgitlab/gurushots-auto-vote/issues) ar savu versiju, OS, aprakstu, reproducēšanas soļiem un attiecīgiem (bez akreditācijas datiem) žurnālfailu fragmentiem.

## 🔒 Drošība

- Visi API izsaukumi izmanto HTTPS.
- Akreditācijas dati tiek aizklāti no žurnāliem — jutīgās atslēgas tiek maskētas pirms jebkura ieraksta žurnālā.
- Jūsu tokens tiek glabāts lokāli lietotnes iestatījumu failā un tiek nosūtīts tikai GuruShots; iestatījumi un konfigurācija nekad nepamet jūsu ierīci.
- Kļūdu ziņojumi neatklāj jutīgu informāciju.
- Auto-iesniegšanas attēlu pārbaude darbojas lokāli ar iekļautu modeli; tā tikai lejupielādē jūsu pašu fotogrāfiju sīktēlus no GuruShots un neko nesūta citiem pakalpojumiem.

## 📄 Licence un atbalsts

Licencēts saskaņā ar **ISC licenci**.

Lai saņemtu palīdzību, vispirms apskatiet [Problēmu risināšanu](#-problēmu-risināšana), pēc tam [atveriet problēmu](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

Ja šis rīks jums ir noderīgs, varat atbalstīt izstrādi:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

---

**Piezīme:** Šī lietotne ir paredzēta izglītības un attīstības nolūkiem. Lūdzu, ievērojiet GuruShots lietošanas noteikumus un izmantojiet atbildīgi.
