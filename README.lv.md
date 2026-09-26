# GuruShots Auto Voter — Lejupielāde un instalācija

Automātiska balsošana GuruShots izaicinājumos. Viens un tas pats balsošanas dzinējs pieejams trīs veidos: darbvirsmas **grafiskā lietotne** (Electron), **komandrindas rīks** (`gurucli`) un **Android** lietotne (sānielādēts APK), kas turpina balsot fonā.

**🇬🇧 [Documentation in English →](README.md)**

## Saturs

- [⚠️ Brīdinājums: tikai viena instance](#️-brīdinājums-tikai-viena-instance)
- [🚀 Funkcijas](#-funkcijas)
- [📥 Lejupielāde un instalācija](#-lejupielāde-un-instalācija)
- [🎯 Ātrais sākums](#-ātrais-sākums)
- [🔧 Lietošanas ceļvedis](docs/usage.lv.md)
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

**Latest Version: v1.11.1**

#### 🖥️ Grafiskā lietotne (ieteicams lielākajai daļai lietotāju)

| Platforma         | Lejupielāde                                                                                                                                                            | Izmērs  | Tips                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.11.1-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-x64.exe)                 | ~270 MB | Portatīva izpildfaila |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.11.1-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64.dmg)             | ~310 MB | DMG instalētājs       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.11.1-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64.app.zip)     | ~335 MB | App komplekts (ZIP)   |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.11.1-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-x86_64.AppImage) | ~270 MB | AppImage              |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.11.1-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64.AppImage)   | ~255 MB | AppImage              |

> **macOS:** tikai Apple Silicon (arm64) — Intel (x86_64) būvējuma nav. **DMG** ir vienkāršākā instalācija; **APP** zip ir alternatīva, ja vēlaties ievietot komplektu pats.

> **Kāpēc lejupielādes ir lielas:** katrā būvējumā (grafiskajā lietotnē, Android un CLI) ir iekļauts ~200 MB attēlu atpazīšanas modelis (Google SigLIP, 8 bitu kvantizēts) un tā izpildvide. Auto-iesniegšana to izmanto, lai pārbaudītu, vai fotogrāfijā tiešām redzams izaicinājuma temats — skatiet [Vizuālā pārbaude](docs/usage.lv.md#trūkstošo-ierakstu-auto-iesniegšana). Tas darbojas tikai jūsu ierīcē: pirmajā lietošanas reizē nekas netiek lejupielādēts, nav vajadzīga API atslēga vai konts, un neviena fotogrāfija netiek nekur augšupielādēta. Nevēlaties to? Izvēlieties [vieglo būvējumu](#-vieglie-būvējumi-bez-attēlu-modeļa).

#### 📱 Mobilā lietotne (Android, sānielāde — bez Play Store)

| Platforma                     | Lejupielāde                                                                                                                                    | Izmērs  | Tips           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| **Android (8.0+, sānielāde)** | [📥 GuruShotsAutoVote-v1.11.1.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1.apk) | ~160 MB | Parakstīts APK |

Android versija ir Capacitor apvalks ap to pašu React saskarni plus Kotlin spraudnis, kas balsošanas ciklus izpilda native līmenī fonā ar `AlarmManager` un foreground servisu. Balsošana turpinās, kad telefons ir bloķēts un lietotne aizvilkta no nesenajiem.

#### 💻 Komandrinda (pieredzējušiem lietotājiem / automatizācijai)

| Platforma             | Lejupielāde                                                                                                                            | Izmērs  | Tips                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **macOS CLI**         | [📥 gurucli-v1.11.1-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-mac)             | ~375 MB | Termināļa izpildfaila |
| **Linux CLI (x64)**   | [📥 gurucli-v1.11.1-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-linux)         | ~355 MB | Termināļa izpildfaila |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.11.1-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-linux-arm) | ~350 MB | Termināļa izpildfaila |

> Windows CLI būvējuma nav — uz Windows izmantojiet augšā esošo grafisko lietotni.

#### 🪶 Vieglie būvējumi (bez attēlu modeļa)

Katra iepriekš minētā lejupielāde ir pieejama arī kā **vieglais** (lite) būvējums bez attēlu modeļa un tā izpildvides: macOS DMG samazinās no ~310 MB līdz ~130 MB, macOS CLI — no ~375 MB līdz ~140 MB. Viss pārējais darbojas tāpat — auto-iesniegšana vienkārši izlaiž [vizuālo pārbaudi](docs/usage.lv.md#trūkstošo-ierakstu-auto-iesniegšana) un saglabā tagu ranžēšanu. Vieglajai grafiskās lietotnes vai Android instalācijai tiek piedāvāti tikai vieglie atjauninājumi (vieglā galddatora lietotne izlaiž beta versijas).

| Platforma                     | Lejupielāde                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**                   | [📥 GuruShotsAutoVote-v1.11.1-x64-lite.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-x64-lite.exe)                 |
| **macOS (DMG)**               | [📥 GuruShotsAutoVote-v1.11.1-arm64-lite.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64-lite.dmg)             |
| **macOS (APP)**               | [📥 GuruShotsAutoVote-v1.11.1-arm64-lite.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64-lite.app.zip)     |
| **Linux (x64)**               | [📥 GuruShotsAutoVote-v1.11.1-x86_64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-x86_64-lite.AppImage) |
| **Linux (ARM64)**             | [📥 GuruShotsAutoVote-v1.11.1-arm64-lite.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-arm64-lite.AppImage)   |
| **Android (8.0+, sānielāde)** | [📥 GuruShotsAutoVote-v1.11.1-lite.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.11.1-lite.apk)                         |
| **macOS CLI**                 | [📥 gurucli-v1.11.1-mac-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-mac-lite)                                             |
| **Linux CLI (x64)**           | [📥 gurucli-v1.11.1-linux-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-linux-lite)                                         |
| **Linux CLI (ARM64)**         | [📥 gurucli-v1.11.1-linux-arm-lite](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.11.1-linux-arm-lite)                                 |

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

1. Lejupielādējiet `gurucli-v1.11.1-mac`.
2. `cd ~/Downloads`
3. Padariet izpildāmu: `chmod +x gurucli-v1.11.1-mac`
4. Notīriet karantīnas karogu (tikai pārlūka lejupielādēm): `xattr -d com.apple.quarantine ./gurucli-v1.11.1-mac`
5. Palaidiet: `./gurucli-v1.11.1-mac help`

Pirmajā reizē, kad CLI iesniedz foto, tā izpako iekļauto attēlu modeli un izpildvidi (~560 MB) mapē `~/Library/Application Support/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jauna versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 🐧 Linux

**Grafiskā lietotne (AppImage):**

1. Lejupielādējiet AppImage savai arhitektūrai.
2. Padariet izpildāmu: `chmod +x GuruShotsAutoVote-v1.11.1-*.AppImage` (vai failu pārvaldniekā → Properties → Permissions).
3. Palaidiet: `./GuruShotsAutoVote-v1.11.1-*.AppImage`

**CLI:**

1. Lejupielādējiet `gurucli-v1.11.1-linux` (vai `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.11.1-linux`
4. `./gurucli-v1.11.1-linux help`

Pirmajā reizē, kad CLI iesniedz foto, tā izpako iekļauto attēlu modeli un izpildvidi (~550 MB) mapē `~/.config/gurushots-auto-vote/vision/`. Tas notiek vienreiz katrai versijai; pēc izpakošanas jauna versija izdzēš vecākās kopijas, kas pēdējā stundā nav izmantotas.

#### 📱 Android (sānielāde)

Android versija **nav pieejama Google Play** — instalācija notiek caur tiešu APK lejupielādi.

1. Telefonā atveriet [jaunākā izlaiduma lapu](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) un piesitiet `GuruShotsAutoVote-v1.11.1.apk`.
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
./gurucli-v1.11.1-[platforma] login    # autentificējieties vienreiz (saglabā tokenu)
./gurucli-v1.11.1-[platforma] run      # viens pilns auto-stratēģijas cikls (boost/turbo/auto-iesniegšana/slieksnis-balsošana)
./gurucli-v1.11.1-[platforma] start    # nepārtraukta balsošana (Ctrl+C, lai apturētu)
```

> Aizstājiet `[platforma]` ar `mac`, `linux` vai `linux-arm`. Palaidiet `help`, lai redzētu visas komandas.

Grafiskās lietotnes un CLI instrukcijas, balsošanas noteikumus, iestatījumus, žurnālfailus un problēmu risināšanu skatiet [lietošanas ceļvedī](docs/usage.lv.md).

## 🔒 Drošība

- Visi API izsaukumi izmanto HTTPS.
- Akreditācijas dati tiek aizklāti no žurnāliem — jutīgās atslēgas tiek maskētas pirms jebkura ieraksta žurnālā.
- Jūsu tokens tiek glabāts lokāli lietotnes iestatījumu failā un tiek nosūtīts tikai GuruShots; iestatījumi un konfigurācija nekad nepamet jūsu ierīci.
- Kļūdu ziņojumi neatklāj jutīgu informāciju.
- Auto-iesniegšanas attēlu pārbaude darbojas lokāli ar iekļautu modeli; tā tikai lejupielādē jūsu pašu fotogrāfiju sīktēlus no GuruShots un neko nesūta citiem pakalpojumiem.

## 📄 Licence un atbalsts

Licencēts saskaņā ar **ISC licenci**.

Lai saņemtu palīdzību, vispirms apskatiet [Problēmu risināšanu](docs/usage.lv.md#-problēmu-risināšana), pēc tam [atveriet problēmu](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

Ja šis rīks jums ir noderīgs, varat atbalstīt izstrādi:

[![Bitcoin](https://img.shields.io/badge/Bitcoin-000000?style=for-the-badge&logo=bitcoin&logoColor=white)](bitcoin:3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD)
[![Ethereum](https://img.shields.io/badge/Ethereum-3C3C3D?style=for-the-badge&logo=Ethereum&logoColor=white)](ethereum:0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6)

**Bitcoin**: `3JSKTwYk1sfqsFyXisFsxvdD5yb7L81vBD`
**Ethereum**: `0xe065D3F01e8826Ecbd128abfB8F0B98069B98Ad6`

---

**Piezīme:** Šī lietotne ir paredzēta izglītības un attīstības nolūkiem. Lūdzu, ievērojiet GuruShots lietošanas noteikumus un izmantojiet atbildīgi.
