# GuruShots Auto Voter — Instalācijas un lietošanas ceļvedis

Automātiska balsošana GuruShots izaicinājumos. Viens un tas pats balsošanas dzinējs pieejams trīs veidos: darbvirsmas **grafiskā lietotne** (Electron), **komandrindas rīks** (`gurucli`) un **Android** lietotne (sānielādēts APK), kas turpina balsot fonā.

**🇬🇧 [Documentation in English →](../README.md)**

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
- **Pēdējās stundas ekspozīcija** — atsevišķs, parasti zemāks ekspozīcijas slieksnis pēdējai stundai.
- **Boost** — automātiski pielieto boost tuvu beigām, izvēlētajai foto vietai.
- **Turbo (iegūt + pielietot)** — automātiski spēlē mini-spēli, lai _iegūtu_ turbo, pēc tam automātiski _pielieto_ to izvēlētajai foto vietai pirms beigām.
- **Auto-aizpilde** — iesniedz fotogrāfijas tukšajās foto vietās tuvu beigām, ar laika atstarpi, lai izvairītos no balsu atšķaidīšanas, ar tagu filtriem un avārijas drošības tīklu.
- **Iestatījumi katram izaicinājumam** — katram balsošanas iestatījumam ir globālais noklusējums, ko jebkurš izaicinājums var pārrakstīt.
- **Trīs platformas** — Electron grafiskā lietotne, `gurucli` komandrinda un Android lietotne, kas balso ar bloķētu telefonu.
- **Noturīgs API slānis** — konfigurējama noildze plus automātiska atkārtošana/aizture pārejošu kļūmju gadījumā.
- **Ērtības** — gaišā/tumšā tēma, angļu/latviešu saskarne, laika joslas attēlošana, mock režīms drošai testēšanai un iebūvēti atjauninājumu paziņojumi.

## 📥 Lejupielāde un instalācija

### Jaunākie būvējumi

**Latest Version: v1.1.6**

#### 🖥️ Grafiskā lietotne (ieteicams lielākajai daļai lietotāju)

| Platforma         | Lejupielāde                                                                                                                                                          | Izmērs | Tips                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v1.1.6-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6-x64.exe)                 | ~50 MB | Portatīva izpildfaila |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v1.1.6-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6-arm64.dmg)             | ~50 MB | DMG instalētājs       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v1.1.6-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6-arm64.app.zip)     | ~50 MB | App komplekts (ZIP)   |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v1.1.6-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6-x86_64.AppImage) | ~50 MB | AppImage              |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v1.1.6-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6-arm64.AppImage)   | ~50 MB | AppImage              |

> **macOS:** tikai Apple Silicon (arm64) — Intel (x86_64) būvējuma nav. **DMG** ir vienkāršākā instalācija; **APP** zip ir alternatīva, ja vēlaties ievietot komplektu pats.

#### 📱 Mobilā lietotne (Android, sānielāde — bez Play Store)

| Platforma                     | Lejupielāde                                                                                                                                  | Izmērs | Tips           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------- |
| **Android (8.0+, sānielāde)** | [📥 GuruShotsAutoVote-v1.1.6.apk](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v1.1.6.apk) | ~10 MB | Parakstīts APK |

Android versija ir Capacitor apvalks ap to pašu React saskarni plus Kotlin spraudnis, kas balsošanas ciklus izpilda native līmenī fonā ar `AlarmManager` un foreground servisu. Balsošana turpinās, kad telefons ir bloķēts un lietotne aizvilkta no nesenajiem.

#### 💻 Komandrinda (pieredzējušiem lietotājiem / automatizācijai)

| Platforma             | Lejupielāde                                                                                                                          | Izmērs | Tips                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------- |
| **macOS CLI**         | [📥 gurucli-v1.1.6-mac](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.1.6-mac)             | ~55 MB | Termināļa izpildfaila |
| **Linux CLI (x64)**   | [📥 gurucli-v1.1.6-linux](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.1.6-linux)         | ~50 MB | Termināļa izpildfaila |
| **Linux CLI (ARM64)** | [📥 gurucli-v1.1.6-linux-arm](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v1.1.6-linux-arm) | ~47 MB | Termināļa izpildfaila |

> Windows CLI būvējuma nav — uz Windows izmantojiet augšā esošo grafisko lietotni.

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

1. Lejupielādējiet `gurucli-v1.1.6-mac`.
2. `cd ~/Downloads`
3. Padariet izpildāmu: `chmod +x gurucli-v1.1.6-mac`
4. Notīriet karantīnas karogu (tikai pārlūka lejupielādēm): `xattr -d com.apple.quarantine ./gurucli-v1.1.6-mac`
5. Palaidiet: `./gurucli-v1.1.6-mac help`

#### 🐧 Linux

**Grafiskā lietotne (AppImage):**

1. Lejupielādējiet AppImage savai arhitektūrai.
2. Padariet izpildāmu: `chmod +x GuruShotsAutoVote-v1.1.6-*.AppImage` (vai failu pārvaldniekā → Properties → Permissions).
3. Palaidiet: `./GuruShotsAutoVote-v1.1.6-*.AppImage`

**CLI:**

1. Lejupielādējiet `gurucli-v1.1.6-linux` (vai `-linux-arm`).
2. `cd ~/Downloads`
3. `chmod +x gurucli-v1.1.6-linux`
4. `./gurucli-v1.1.6-linux help`

#### 📱 Android (sānielāde)

Android versija **nav pieejama Google Play** — instalācija notiek caur tiešu APK lejupielādi.

1. Telefonā atveriet [jaunākā izlaiduma lapu](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest) un piesitiet `GuruShotsAutoVote-v1.1.6.apk`.
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
./gurucli-v0.12.1-[platforma] login    # autentificējieties vienreiz (saglabā tokenu)
./gurucli-v0.12.1-[platforma] run      # viens pilns auto-stratēģijas cikls (boost/turbo/aizpilde/slieksnis-balsošana)
./gurucli-v0.12.1-[platforma] start    # nepārtraukta balsošana (Ctrl+C, lai apturētu)
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

| Komanda                                           | Ko tā dara                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                                           | Autentificējieties ar GuruShots un saglabājiet tokenu (interaktīvs; nepieciešams īsts terminālis).                                              |
| `vote`                                            | Palaiž **vienu manuālu ciklu** — balso līdz **100%** visos aktīvajos izaicinājumos, ignorējot visus sliekšņus. Vienreizēja papildināšana.       |
| `run [--challenge=<id>]`                          | Palaiž **vienu pilnu auto-stratēģijas ciklu** (boost / turbo / auto-aizpilde / slieksni ievērojoša balsošana). `--challenge` ierobežo uz vienu. |
| `start`                                           | Sāk **nepārtrauktu** balsošanu ar dinamisku plānošanu. Darbojas, līdz nospiežat **Ctrl+C**.                                                     |
| `status`                                          | Parāda režīmu (MOCK/REAL), autentifikācijas statusu un galvenos iestatījumus.                                                                   |
| `get-setting <key> [--challenge=<id>]`            | Izdrukā iestatījuma efektīvo vērtību (katram izaicinājumam ar `--challenge`).                                                                   |
| `set-setting <key> <value> [--challenge=<id>]`    | Uzstāda iestatījumu; ar `--challenge` ieraksta pārrakstījumu konkrētam izaicinājumam.                                                           |
| `set-global-default <key> <value>`                | Uzstāda globālo noklusējumu **ar shēmas validāciju**.                                                                                           |
| `list-settings [--challenge=<id>]`                | Parāda visus iestatījumus un modifikācijas statusu (skats katram izaicinājumam ar `--challenge`).                                               |
| `reset-setting <key> [--challenge=<id>]`          | Atiestata iestatījumu uz noklusējumu (vai notīra izaicinājuma pārrakstījumu ar `--challenge`).                                                  |
| `reset-all-settings`                              | Atiestata visu uz noklusējumiem (saglabā tokenu, mock karogu un API galvenes).                                                                  |
| `logs [--error\|--api\|--settings] [--lines=<n>]` | Izdrukā žurnālfaila beigas (noklusējums 100 rindas; noklusējuma kategorija ir lietotnes žurnāls).                                               |
| `reset-windows`                                   | Atiestata grafiskās lietotnes logu pozīcijas uz noklusējumiem.                                                                                  |
| `help-settings`                                   | Detalizēta palīdzība par iestatījumiem — atslēgu nosaukumi, vērtību formāti, diapazoni.                                                         |
| `help`                                            | Parāda komandu palīdzību.                                                                                                                       |

Iestatījumi ir kopīgi ar grafisko lietotni: CLI veikts `set-setting` tiek pamanīts grafiskajā lietotnē un otrādi.

> Aizstājiet `[platforma]` zemāk ar `mac`, `linux` vai `linux-arm`.

```bash
./gurucli-v0.12.1-[platforma] set-global-default exposure 80
./gurucli-v0.12.1-[platforma] set-setting onlyBoost true --challenge=12345
./gurucli-v0.12.1-[platforma] list-settings --challenge=12345
./gurucli-v0.12.1-[platforma] logs --error --lines=50
```

## ⚙️ Kā darbojas balsošana

### Viens balsošanas cikls

Cikls ir viena caurlaide pa visiem jūsu aktīvajiem izaicinājumiem. Katram, šādā secībā, lietotne: pielieto **boost**, ja pienācis laiks, spēlē/pielieto **turbo**, ja atbilstošs, **auto-aizpilda** tukšu foto vietu, ja ir laiks, un pēc tam **balso** līdz mērķim, ko nosaka zemāk aprakstītie noteikumi.

### Ekspozīcijas noteikumi (kurš mērķis tiek piemērots)

Katram izaicinājumam ir ekspozīcijas **slieksnis** ("balsot, kamēr mana ekspozīcija ir zem tā") un balsošanas **mērķis** ("turpināt balsot līdz šim %"). Uzvar pirmais atbilstošais noteikums:

1. **Tikai boost** (`onlyBoost`) — balsošana tiek pilnībā izlaista; lietotne pielieto tikai boost/turbo.
2. **Vēl nav sācies** — izlaists.
3. **Flash izaicinājums** — vienmēr mērķis **100%**.
4. **Balsot tikai pēdējā minūtē** (`voteOnlyInLastMinute`) — ja iestatīts un izaicinājums _vēl nav_ savā pēdējās minūtes logā, balsošana tiek izlaista.
5. **Pēdējās minūtes logs** — `lastMinuteThreshold` minūšu robežās pirms beigām vienmēr mērķis **100%** (ekspozīcijas griesti tiek ignorēti).
6. **Pēdējā stunda** — ja `useLastHourExposure` ir ieslēgts un atlikusi mazāk par stundu, izmanto `lastHourExposure` slieksni un `lastHourExposureTarget` mērķi.
7. **Normāli** — citādi izmanto `exposure` slieksni un `exposureTarget` mērķi.

Sliekšņiem ar atsevišķu mērķi lietotne balso tikai tad, kad esat zem sliekšņa, pēc tam turpina līdz mērķim. Mērķis `0` nozīmē "apstāties pie sliekšņa" (mērķis = slieksnis).

### Plānošanas kadence

Nepārtrauktajā režīmā starp cikliem tiek izvēlēta nejauša aizture diapazonā `[checkFrequencyMin, checkFrequencyMax]` minūtes. Tiklīdz kāds izaicinājums ienāk savā `lastMinuteThreshold` logā, plānotājs pārslēdzas uz fiksētu, ciešāku kadenci (`lastMinuteCheckFrequency`, noklusējums ik minūti), līdz neviens izaicinājums vairs nav šajā logā, tad atgriežas. (Skatiet [`scheduling.md`](scheduling.md) par platformu iekšējo darbību — CLI/Android izmanto vienu dzinēju; grafiskā lietotne izmanto to pašu matemātiku.)

### Boost

Kad `autoBoost` ir ieslēgts, lietotne pielieto pieejamo boost foto vietai `boostImageIndex` (1 = pirmā fotogrāfija, `0` = pēdējā; tā paiet vienu vietu atpakaļ, ja šai vietai jau ir turbo):

- **Taimera boost** — pielieto, kad boost savā taimerī atlicis `boostTime` sekundes vai mazāk.
- **Atslēgas atvērts boost** (bez taimera) — boost taimers tiek ignorēts; pielieto tikai pēdējās 15 minūtēs pirms izaicinājuma beigām.

### Turbo (iegūt, pēc tam pielietot)

Turbo ir lēni atjaunojams patēriņa resurss, ko iegūstat, spēlējot mini-spēli, un pēc tam tērējat, kad vēlaties. Abas puses ir neatkarīgi iestatījumi:

- **Auto-iegūt (`autoTurbo`, pēc noklusējuma ieslēgts)** — kad nav rokā turbo, lietotne katru ciklu spēlē mini-spēli, lai iegūtu vienu. (Grafiskās lietotnes ekvivalents: poga **Spēlēt Auto-Turbo**.)
- **Auto-pielietot (`useTurbo`, pēc noklusējuma izslēgts)** — kad turbo ir rokā un izaicinājumam atlicis `turboTime` sekundes vai mazāk, to pielieto foto vietai `turboImageIndex`. Pēc noklusējuma tas gaida, līdz paiet jebkurš atvērts boost logs; iestatiet `turboApplyWhenBoostActive` uz `true`, lai abi varētu darboties vienā izaicinājumā (dažādām fotogrāfijām).

Grafiskajā lietotnē rokā esošu turbo varat pielietot arī konkrētai fotogrāfijai ar tās **⚡** pogu, pārrakstot auto vietu. Viena fotogrāfija var būt vai nu ar boost, vai ar turbo, nekad abiem.

### Trūkstošo ierakstu auto-aizpilde

Kad izaicinājums ļauj iesniegt vairākas fotogrāfijas un esat atstājuši tukšas vietas, šīs vietas beigās tiek izniekotas. Ar ieslēgtu `autoFill` plānotājs iesniedz **vienu fotogrāfiju katrā ciklā**, lai tās aizpildītu, ar atstarpi `autoFillIntervalMinutes`, sākot, kad `atlikušās_sekundes ≤ atlikušās_vietas × autoFillIntervalMinutes × 60`. Atstarpe ir svarīga, jo GuruShots atšķaida balsis starp vienlaikus iesniegtiem ierakstiem, tāpēc atstatums dod katram jaunajam ierakstam neatkarīgu ekspozīciju.

- **`emergencyFill`** — drošības tīkls: pēdējā posmā pirms beigām tas aizpilda visas atlikušās vietas pat tad, kad normālie noteikumi gaidītu, un pārraksta must-include tagu filtru. Grafiskajā lietotnē ievada kā h+m (glabā sekundēs). `0` to atspējo; turiet to `≤ lastMinuteThreshold`, lai ātrā pēdējās minūtes kadence būtu aktīva visā logā.
- **Tagu filtri** — `mustIncludeTags` ir cietais filtrs (atbilstošas tikai fotogrāfijas ar vismaz vienu tagu); `shouldIncludeTags` ir mīkstā preference. `fillWithoutTagMatch` izlemj, kas notiek, kad must-include tagi ir iestatīti, bet nekas neatbilst: tomēr aizpildīt (noklusējums) vai atstāt vietu tukšu.
- **Fotogrāfiju ranžēšana** — atlasītājs ranžē jūsu atbilstošās fotogrāfijas pēc, šādā secībā: tēmas atbilstības rezultāta (atslēgvārdi no izaicinājuma nosaukuma/slug/sveiciena ziņas pret katras fotogrāfijas vīzijas iezīmēm), sasniegumu skaita, kopējā balsu skaita, tad augšupielādes datuma.
- **Manuālās pogas** — katrai kartītei ar tukšām vietām ir **`+1`** (iesniegt labāk ranžēto fotogrāfiju vienā vietā) un **`+N`** (aizpildīt visas atlikušās vietas uzreiz, ignorējot atstarpi). Manuālie klikšķi ignorē `autoFill` slēdzi un ir atspējoti, kamēr auto-balsošana darbojas.

Jaunaizpildītos ierakstus boost un turbo noteikumi pamana automātiski _nākamajā_ ciklā.

### Tikai-boost režīms

`onlyBoost` (katram izaicinājumam) izslēdz normālo balsošanu šim izaicinājumam — lietotne darbojas tikai tad, kad var pielietot boost vai turbo. Noderīgi mazsvarīgiem izaicinājumiem, kuros vēlaties tērēt boost/turbo, bet ne balsis.

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

### Izaicinājumu iestatījumi

Visi atbalsta pārrakstīšanu katram izaicinājumam, izņemot kur norādīts.

**Vispārīgi**

| Iestatījums      | Noklusējums | Diapazons / vērtības                         | Apraksts                                                                             |
| ---------------- | ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `exposure`       | `100`       | 1–100 %                                      | Normālā sliekšņa vērtība: balsot, kamēr ekspozīcija ir zem tā.                       |
| `exposureTarget` | `0`         | `0` vai 1–100 % (ja iestatīts, ≥ `exposure`) | Balsot līdz šim %, kad iedarbojas normālais noteikums. `0` = apstāties pie sliekšņa. |
| `onlyBoost`      | `false`     | bool                                         | Izlaist normālo balsošanu; pielietot tikai boost/turbo.                              |
| `compactCards`   | `false`     | bool                                         | Kompakts izaicinājumu kartīšu izkārtojums (tikai grafiskās lietotnes attēlojums).    |

**Boost**

| Iestatījums       | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                             |
| ----------------- | ------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `autoBoost`       | `true`        | bool                 | Automātiski pielietot boost tuvu beigām.                                                             |
| `boostTime`       | `3600` s (1h) | ≥ 0                  | Pielietot taimera boost, kad atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada kā h+m. |
| `boostImageIndex` | `1`           | vesels ≥ 0           | Foto vieta boost (1 = pirmā, `0` = pēdējā). Paiet atpakaļ, ja vietai jau ir turbo.                   |

**Turbo**

| Iestatījums                 | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                     |
| --------------------------- | ------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `useTurbo`                  | `false`       | bool                 | Automātiski pielietot rokā esošu turbo pirms beigām.                                         |
| `autoTurbo`                 | `true`        | bool                 | Automātiski spēlēt mini-spēli, lai iegūtu turbo, kad tāda nav rokā.                          |
| `turboTime`                 | `7200` s (2h) | ≥ 0                  | Pielietot turbo, kad atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada kā h+m. |
| `turboImageIndex`           | `1`           | vesels ≥ 0           | Foto vieta turbo (1 = pirmā, `0` = pēdējā). Paiet atpakaļ, ja vietai jau ir boost.           |
| `turboApplyWhenBoostActive` | `false`       | bool                 | Atļaut turbo pielietot, kamēr ir atvērts boost logs.                                         |

**Pēdējā stunda**

| Iestatījums              | Noklusējums | Diapazons / vērtības                                 | Apraksts                                                       |
| ------------------------ | ----------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `useLastHourExposure`    | `false`     | bool                                                 | Izmantot atsevišķu ekspozīcijas noteikumu pēdējā stundā.       |
| `lastHourExposure`       | `100`       | 1–100 % (≤ `exposure`)                               | Slieksnis, ko izmanto pēdējā stundā.                           |
| `lastHourExposureTarget` | `0`         | `0` vai 1–100 % (ja iestatīts, ≥ `lastHourExposure`) | Balsot līdz šim % pēdējā stundā. `0` = apstāties pie sliekšņa. |

**Pēdējā minūte**

| Iestatījums                | Noklusējums | Diapazons / vērtības | Apraksts                                                                                                              |
| -------------------------- | ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `voteOnlyInLastMinute`     | `false`     | bool                 | Balsot tikai pēdējās minūtes logā (loga izmērs = `lastMinuteThreshold`, nevis burtiski viena minūte).                 |
| `lastMinuteThreshold`      | `10`        | 1–59 min             | Logs pirms beigām, kurā lietotne balso līdz 100 % neatkarīgi no ekspozīcijas griestiem.                               |
| `lastMinuteCheckFrequency` | `1`         | 1–59 min             | **Tikai globāls (bez pārrakstīšanas katram izaicinājumam).** Plānotāja kadence, kamēr kāds izaicinājums ir savā logā. |

**Auto-aizpilde**

| Iestatījums               | Noklusējums  | Diapazons / vērtības | Apraksts                                                                                                                                                                                             |
| ------------------------- | ------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFill`                | `false`      | bool                 | Iesniegt fotogrāfijas tukšajās foto vietās tuvu beigām (ar atstarpi, vienu katrā ciklā).                                                                                                             |
| `autoFillIntervalMinutes` | `10`         | 1–60 min             | Atstarpe starp auto-aizpildes iesniegumiem.                                                                                                                                                          |
| `fillWithoutTagMatch`     | `true`       | bool                 | Ja must-include tagi iestatīti, bet neviens neatbilst: tomēr aizpildīt (`true`) vai atstāt vietu tukšu (`false`).                                                                                    |
| `emergencyFill`           | `300` s (5m) | ≥ 0                  | Pēdējo minūšu drošības tīkls: aizpildīt atlikušās vietas pat ja noteikumi gaidītu, pārrakstot must-include tagus. `0` = izslēgts. Turiet ≤ `lastMinuteThreshold`. Grafiskajā lietotnē ievada kā h+m. |
| `mustIncludeTags`         | `[]`         | līdz 50 tagiem       | Cietais filtrs: aizpildīt tikai ar fotogrāfijām, kas atbilst vismaz vienam no šiem tagiem.                                                                                                           |
| `shouldIncludeTags`       | `[]`         | līdz 50 tagiem       | Mīkstā preference: dot priekšroku fotogrāfijām ar šiem tagiem, bet neizslēgt citas.                                                                                                                  |

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

## 🔍 Problēmu risināšana

**"Nav atrasts autentifikācijas tokens" / "Token beidzies"** — pieslēdzieties vēlreiz no pieslēgšanās ekrāna (CLI: palaidiet `login`). Tokeni ir saistīti ar jūsu kontu; ja tas atkārtojas, pārbaudiet sistēmas pulksteni.

**"Tīkla kļūda"** — pārbaudiet savienojumu un ugunsmūri, palieliniet `apiTimeout` (mēģiniet 60–120 s) un mēģiniet vēlāk; GuruShots var būt īslaicīgi nepieejams.

**"API Rate Limit Exceeded" / "Too Many Requests"** — apturiet **visas** instances (grafisko lietotni un CLI), pagaidiet 5–10 minūtes un pārliecinieties, ka darbojas tikai viena.

**Auto-balsošana darbojas, bet nekas nenotiek** — pārbaudiet, vai jums ir aktīvi izaicinājumi, vai ekspozīcija jau nav pie sliekšņa (noklusējums 100%), un vai `voteOnlyInLastMinute` nav ieslēgts, kamēr izaicinājumi vēl ir ārpus pēdējās minūtes loga. Pārbaudiet žurnālfailus, lai redzētu izlaišanas iemeslu katram izaicinājumam.

**Logs atveras ārpus ekrāna** — restartējiet lietotni; no CLI palaidiet `reset-windows`.

**Android: balsošana apstājas fonā** — iestatiet lietotnes baterijas lietojumu uz **Neierobežots** un baltā saraksta to sava ražotāja baterijas pārvaldniekā; Android 12 piešķiriet exact-alarm atļauju 1-minūtes pēdējās minūtes kadencei.

Ja joprojām esat iestrēdzis, pārbaudiet žurnālfailus un [atveriet problēmu](https://github.com/isthisgitlab/gurushots-auto-vote/issues) ar savu versiju, OS, aprakstu, reproducēšanas soļiem un attiecīgiem (bez akreditācijas datiem) žurnālfailu fragmentiem.

## 🔒 Drošība

- Visi API izsaukumi izmanto HTTPS.
- Akreditācijas dati tiek aizklāti no žurnāliem — jutīgās atslēgas tiek maskētas pirms jebkura ieraksta žurnālā.
- Jūsu tokens tiek glabāts lokāli lietotnes iestatījumu failā un tiek nosūtīts tikai GuruShots; iestatījumi un konfigurācija nekad nepamet jūsu ierīci.
- Kļūdu ziņojumi neatklāj jutīgu informāciju.

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
