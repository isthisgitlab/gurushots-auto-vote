# GuruShots Auto Voter - Instalācijas ceļvedis

## 📥 Lejupielāde un instalācija

### **🚀 Ātrās lejupielādes saites**

**Latest Version: v0.8.5**

#### **🖥️ Grafiskā lietotne (Ieteicams lielākajai daļai lietotāju)**

| Platforma         | Lejupielāde                                                                                                                                                          | Izmērs | Tips                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------- |
| **Windows**       | [📥 GuruShotsAutoVote-v0.8.5-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.8.5-x64.exe)                 | ~50 MB | Portatīva izpildfaila |
| **macOS (DMG)**   | [📥 GuruShotsAutoVote-v0.8.5-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.8.5-arm64.dmg)             | ~50 MB | DMG instalētājs       |
| **macOS (APP)**   | [📥 GuruShotsAutoVote-v0.8.5-arm64.app.zip](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.8.5-arm64.app.zip)     | ~50 MB | App komplekts (ZIP)   |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v0.8.5-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.8.5-x86_64.AppImage) | ~50 MB | AppImage              |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v0.8.5-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.8.5-arm64.AppImage)   | ~50 MB | AppImage              |

### **📋 Detalizētas instalācijas instrukcijas**

#### **🪟 Windows lietotājiem**

1. **Lejupielādēt**: Noklikšķiniet uz Windows saites augšā, lai lejupielādētu `.exe` failu
2. **Palaist**: Veiciet dubultklikšķi uz lejupielādētā faila, lai palaistu lietotni
3. **Instalācija nav nepieciešama**: Lietotne darbojas tieši no izpildfaila bez instalācijas
4. **Pirmā palaišana**: Lietotne izveidos konfigurācijas failus jūsu lietotāja mapē
    - Konfigurācijas faili tiek saglabāti: `%APPDATA%\gurushots-auto-vote\`
    - Žurnālfaili tiek saglabāti: `%APPDATA%\gurushots-auto-vote\logs\`
5. **Drošības brīdinājumi**: Ja saņemat Windows drošības brīdinājumu, noklikšķiniet uz "Papildu opcijas" un izvēlieties "Tomēr palaist"
6. **Automātiskā startēšana**: Ja vēlaties, lai lietotne startējas automātiski, izveidojiet saīsni un ievietojiet to mapē `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`

**✅ Tas ir viss!** Lietotne ir gatava lietošanai.

#### **🍎 macOS lietotājiem**

**Opcija 1: DMG instalētājs (Ieteicams)**

1. **Lejupielādēt**: Noklikšķiniet uz macOS (DMG) saites augšā, lai lejupielādētu `.dmg` failu
2. **Atvērt DMG**: Veiciet dubultklikšķi uz lejupielādētā `.dmg` faila
3. **Instalēt**: Velciet lietotnes ikonu uz Applications mapi
4. **Palaist**: Atveriet lietotni no Applications mapes

**Opcija 2: App komplekts (Tiešs)**

1. **Lejupielādēt**: Noklikšķiniet uz macOS (APP) saites augšā, lai lejupielādētu `.app.zip` failu
2. **Izvilkt**: Veiciet dubultklikšķi uz zip faila, lai izvilktu `.app` komplektu
3. **Pārvietot**: Pārvietojiet izvilkto lietotni uz Applications mapi
4. **Palaist**: Atveriet lietotni no Applications mapes

**Konfigurācijas faili**: Lietotne saglabā iestatījumus mapē `~/Library/Application Support/gurushots-auto-vote/`
**Žurnālfaili**: Žurnālfaili tiek saglabāti mapē `~/Library/Application Support/gurushots-auto-vote/logs/`

**🔧 Ja saņemat drošības brīdinājumus:**

```bash
# Atveriet Terminal un izpildiet šo komandu (aizstājiet ar savu faktisko ceļu):
xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
```

**🔒 Papildu drošības atļaujas:**

1. Atveriet System Preferences > Security & Privacy
2. Cilnē "General" noklikšķiniet uz "Open Anyway" blakus GuruShotsAutoVote.app
3. Ja nepieciešams, ievadiet administratora paroli, lai apstiprinātu

#### **🐧 Linux lietotājiem**

**Grafiskā lietotne (AppImage):**

1. **Lejupielādēt**: Noklikšķiniet uz atbilstošās Linux saites augšā
2. **Padarīt izpildāmu**: Labais klikšķis uz faila → Properties → Permissions → Atzīmējiet "Allow executing file as program"
    - Vai izmantojiet termināli: `chmod +x GuruShotsAutoVote-v0.8.5-*.AppImage`
3. **Palaist**: Veiciet dubultklikšķi uz faila vai palaidiet no termināļa: `./GuruShotsAutoVote-v0.8.5-*.AppImage`
4. **Konfigurācijas faili**: Lietotne saglabā iestatījumus mapē `~/.config/gurushots-auto-vote/`
5. **Žurnālfaili**: Žurnālfaili tiek saglabāti mapē `~/.config/gurushots-auto-vote/logs/`

**Integrācija ar darbvirsmu:**

1. Izveidojiet `.desktop` failu:
    ```bash
    cat > ~/.local/share/applications/gurushots-auto-vote.desktop << EOL
    [Desktop Entry]
    Name=GuruShots Auto Vote
    Exec=/pilns/ceļš/uz/GuruShotsAutoVote-v0.8.5-x86_64.AppImage
    Icon=
    Type=Application
    Categories=Utility;
    EOL
    ```
2. Aizstājiet `/pilns/ceļš/uz/` ar faktisko ceļu, kur saglabājāt AppImage failu
3. Pēc izvēles pievienojiet ikonu, lejupielādējot to no projekta repozitorija

### **🎯 Kuru versiju lejupielādēt?**

**Ieteicamā lejupielāde**: Grafiskā lietotne jūsu platformai

**Kāpēc grafiskā lietotne?**

- ✅ **Vienkārša lietošana** - Vizuāls interfeiss, nav nepieciešamas komandas
- ✅ **Pilna funkcionalitāte** - Visas funkcijas pieejamas caur interfeisu
- ✅ **Automātiska atjaunināšana** - Lietotne pati pārvalda balsošanu
- ✅ **Drošība** - Droša autentifikācija un datu saglabāšana
- ✅ **Vairāku valodu atbalsts** - Pieejama gan angļu, gan latviešu valodā
- ✅ **Tēmu atbalsts** - Gaišais un tumšais režīms

### **🔗 Alternatīva: Apskatīt visas izlaidumus**

Ja jums nepieciešama konkrēta versija vai vēlaties apskatīt visas pieejamās lejupielādes:

- **📂 [Apskatīt visas izlaidumus](https://github.com/isthisgitlab/gurushots-auto-vote/releases)**
- **📋 [Izlaiduma piezīmes](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest)**

### **❓ Joprojām neesat pārliecināts?**

**Vienkāršā atbilde**: Lejupielādējiet grafisko lietotni jūsu platformai:

- **Windows**: `.exe` fails
- **macOS**: `.dmg` fails
- **Linux**: `.AppImage` fails

**Nepieciešama palīdzība?** Apskatiet [Problēmu risināšanas](#problmu-risinana) sadaļu zemāk
vai [atveriet problēmu](https://github.com/isthisgitlab/gurushots-auto-vote/issues).

## 🎯 Detalizēts sākuma ceļvedis

### **Grafiskā lietotne (Ieteicams iesācējiem)**

Palaidiet lietotni un sekojiet šiem soļiem:

1. **Pieslēgšanās**:
    - Ievadiet savus GuruShots akreditācijas datus (e-pastu un paroli)
    - Atzīmējiet "Saglabāt pieteikšanos", ja vēlaties palikt pieslēgtam
    - Izvēlieties tēmu (gaišo vai tumšo) augšējā labajā stūrī
    - Noklikšķiniet uz "Pieteikties"

2. **Galvenais interfeiss**:
    - **Augšējā josla**: Rāda statusa informāciju un ātros iestatījumus
    - **Izaicinājumu saraksts**: Parāda visus jūsu aktīvos GuruShots izaicinājumus
    - **Detalizēta informācija**: Klikšķiniet uz izaicinājuma, lai redzētu detalizētu informāciju
    - **Iestatījumu poga**: Piekļūstiet visiem lietotnes iestatījumiem

3. **Automātiskās balsošanas konfigurēšana**:
    - Noklikšķiniet uz "Iestatījumi" pogas
    - Konfigurējiet globālos noklusējuma iestatījumus visiem izaicinājumiem
    - Pēc izvēles konfigurējiet specifiskus iestatījumus atsevišķiem izaicinājumiem
    - Saglabājiet iestatījumus, noklikšķinot uz "Saglabāt"

4. **Balsošanas sākšana**:
    - Atgriezieties galvenajā ekrānā
    - Noklikšķiniet uz "Sākt automātisko balsošanu"
    - Lietotne sāks automātiski balsot atbilstoši jūsu iestatījumiem
    - Balsošanas statuss tiks parādīts interfeisā

5. **Balsošanas apturēšana**:
    - Noklikšķiniet uz "Apturēt automātisko balsošanu", lai jebkurā laikā apturētu procesu

## 🔧 Detalizēta lietošanas instrukcija

### **Grafiskā lietotne**

Grafiskā lietotne nodrošina lietotājam draudzīgu interfeisu jūsu GuruShots balsošanas pārvaldībai:

#### **Pieslēgšanās ekrāns**:

- **Lietotājvārds/E-pasts**: Ievadiet savu GuruShots kontu e-pastu
- **Parole**: Ievadiet savu GuruShots konta paroli
- **Saglabāt pieteikšanos**: Atzīmējiet, lai saglabātu sesiju pēc lietotnes aizvēršanas
- **Tēma**: Izvēlieties starp gaišo un tumšo tēmu
- **Valoda**: Izvēlieties starp angļu un latviešu valodu

#### **Galvenais interfeiss**:

- **Augšējā josla**:
    - **Statuss**: Parāda, vai automātiskā balsošana ir aktīva
    - **Tēma**: Ātri pārslēdziet starp gaišo un tumšo tēmu
    - **Valoda**: Ātri pārslēdziet starp angļu un latviešu valodu
    - **Iziet**: Atteikties no pašreizējās sesijas

- **Izaicinājumu saraksts**:
    - **Nosaukums**: Izaicinājuma nosaukums
    - **Beigu laiks**: Kad izaicinājums beigsies
    - **Redzamība**: Jūsu pašreizējais redzamības procents
    - **Statuss**: Balsošanas statuss (Nobalsots/Balso/Gaida)

- **Detalizēta informācija par izaicinājumu**:
    - **Jūsu progress**: Pašreizējā vieta, redzamība un balsis
    - **Jūsu bildes**: Jūsu iesniegtās fotogrāfijas šajā izaicinājumā
    - **Boost statuss**: Vai boost ir pieejams un kad tas tiks pielietots

- **Balsošanas vadība**:
    - **Sākt automātisko balsošanu**: Sāk automātisko balsošanas procesu
    - **Apturēt automātisko balsošanu**: Aptur automātisko balsošanu
    - **Atjaunot**: Atsvaidzina izaicinājumu datus no GuruShots

#### **Iestatījumu ekrāns**:

- **Lietotnes iestatījumi**:
    - **Tēma**: Izvēlieties starp gaišo un tumšo tēmu
    - **Valoda**: Izvēlieties starp angļu un latviešu valodu
    - **Saglabāt pieteikšanos**: Saglabāt pieteikšanās sesiju pēc lietotnes aizvēršanas
    - **Laika josla**: Izvēlieties laika joslu izaicinājumu laiku attēlošanai
    - **API noildze**: Konfigurējiet API pieprasījumu noildzes laiku (1-120 sekundes)
    - **Balsošanas intervāls**: Intervāls starp balsošanas cikliem (1-60 minūtes)

- **Izaicinājumu noklusējuma iestatījumi**:
    - **Boost laiks**: Kad automātiski pielietot boost (atlikušais laiks)
    - **Redzamība**: Redzamības procentu slieksnis darbībām (0-100%)
    - **Pēdējo minūšu slieksnis**: Slieksnis minūtēs pēdējā brīža darbībām
    - **Tikai Boost režīms**: Veikt tikai boost darbības, izlaist parasto balsošanu
    - **Balsot tikai pēdējo minūšu laikā**: Balsot tikai tad, ja līdz izaicinājuma beigām ir mazāk laika, nekā norādīts pēdējo minūšu slieksnī

- **Specifiskie iestatījumi izaicinājumiem**:
    - Konfigurējiet īpašus iestatījumus katram izaicinājumam atsevišķi
    - Pārrakstiet globālos noklusējuma iestatījumus konkrētiem izaicinājumiem

## ⚙️ Detalizēti iestatījumi

Lietotne automātiski saglabā jūsu preferences:

### **Lietotnes iestatījumi**:

- **Tēma**: Gaišs vai tumšs režīms
    - **Gaišs**: Standarta gaišais interfeiss
    - **Tumšs**: Tumšais režīms nakts lietošanai vai acu komfortam

- **Valoda**: Lietotnes valodas izvēle
    - **English**: Angļu valoda
    - **Latviešu**: Latviešu valoda

- **Saglabāt pieteikšanos**: Palikt pieslēgtam starp sesijām
    - **Ieslēgts**: Saglabā jūsu pieteikšanās sesiju pēc lietotnes aizvēršanas
    - **Izslēgts**: Atsaka pieteikšanos, kad lietotne tiek aizvērta

- **Laika josla**: Laika josla izaicinājumu laiku attēlošanai
    - **Vietējā**: Izmanto jūsu datora laika joslu
    - **Pielāgota**: Izvēlieties jebkuru pasaules laika joslu

- **API noildze**: API pieprasījumu noildzes laiks sekundēs
    - **Diapazons**: 1-120 sekundes
    - **Noklusējums**: 30 sekundes
    - **Ieteikums**: Palieliniet, ja jums ir lēns interneta savienojums

- **Balsošanas intervāls**: Intervāls starp balsošanas cikliem minūtēs
    - **Diapazons**: 1-60 minūtes
    - **Noklusējums**: 3 minūtes
    - **Ieteikums**: 3-5 minūtes normālai lietošanai, 10-15 minūtes ilgstošai darbībai

### **Izaicinājumu iestatījumi**:

- **Boost laiks**: Kad automātiski pielietot boost (atlikušais laiks)
    - **Diapazons**: Jebkurš pozitīvs laiks sekundēs
    - **Noklusējums**: 3600 sekundes (1 stunda)
    - **Ieteikums**: 1-3 stundas pirms izaicinājuma beigām

- **Redzamība**: Redzamības procentu slieksnis darbībām
    - **Diapazons**: 0-100%
    - **Noklusējums**: 100%
    - **Ieteikums**: 80-90% optimālai efektivitātei

- **Pēdējo minūšu slieksnis**: Slieksnis minūtēs pēdējā brīža darbībām
    - **Diapazons**: 1-59 minūtes
    - **Noklusējums**: 10 minūtes
    - **Ieteikums**: 15-30 minūtes lielākajai daļai izaicinājumu

- **Tikai Boost režīms**: Veikt tikai boost darbības, izlaist parasto balsošanu
    - **Ieslēgts**: Lietotne tikai pielietos boost, bet nebalsot
    - **Izslēgts**: Lietotne gan balsos, gan pielietos boost

- **Balsot tikai pēdējo minūšu laikā**: Balsot tikai tad, ja līdz izaicinājuma beigām ir mazāk laika, nekā norādīts pēdējo minūšu slieksnī
    - **Ieslēgts**: Balsot tikai pēdējās minūtēs pirms izaicinājuma beigām
    - **Izslēgts**: Balsot jebkurā laikā, ievērojot redzamības iestatījumus

<!-- TODO(translation): The sections below document features added since the Latvian translation was last synced. Translate when convenient — find every occurrence by greping for `TODO(translation)` in this file. -->

### **Additional Per-Challenge Settings (untranslated)**

- **Last Hour Exposure** (`useLastHourExposure` + `lastHourExposure`): A tighter exposure ceiling that only applies during the final hour of a challenge. `lastHourExposure` must be ≤ `exposure`. Default: disabled, 100%.
- **Auto-Turbo Earn** (`autoTurbo`): Automatically play the in-app mini-game to earn turbo when none is held. Default: enabled (`true`).
- **Auto-Turbo Apply** (`useTurbo` + `turboTime` + `turboImageIndex` + `turboApplyWhenBoostActive`): Automatically apply held turbo to entry slot `turboImageIndex` when `turboTime` seconds remain before challenge end. `turboApplyWhenBoostActive` controls coexistence with active boost windows. Default: disabled, 7200 seconds (2h), entry 1, suppressed during boost.

### **Global-Only: Last Minute Check Frequency (untranslated)**

- **`lastMinuteCheckFrequency`**: Higher polling cadence used when at least one challenge is within its last-minute threshold. Range: 1-59 minutes. Default: 1.

### **Turbo (Auto-Earn & Auto-Apply) (untranslated)**

Turbo is GuruShots' long-game booster: you earn it by playing the in-app mini-game (slow-replenishing), then hold it until the moment you want to spend it on a specific photo. The app splits this lifecycle into two independent settings:

- **Auto-Earn (`autoTurbo`)** — automatically plays the mini-game to earn turbo when none is held.
- **Auto-Apply (`useTurbo`)** — applies the held turbo to a configured entry slot before challenge end.

Per-entry manual apply: in the GUI, each photo badge shows an `⚡` button when a turbo is held; clicking it applies the turbo to that specific entry. Boost and turbo are mutually exclusive on a single photo.

### **GUI Per-Entry Actions (untranslated)**

Each photo badge in the GUI shows up to two action buttons:

- **🚀** — apply the available boost to this specific photo
- **⚡** — apply the held turbo to this specific photo

Both buttons disappear once the photo is boosted or turboed.

### **Auto-Updater (untranslated)**

The GUI shows an Update Dialog when a new release is available. States: available → downloading (with progress) → ready to install (or error).

### **CLI Settings Management Commands (untranslated)**

| Command                            | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `list-settings`                    | Show all settings with their current values and modification status |
| `get-setting <key>`                | Print a setting's value                                             |
| `set-setting <key> <value>`        | Set a setting directly (no validation)                              |
| `set-global-default <key> <value>` | Set a global default with schema validation                         |
| `reset-setting <key>`              | Reset one setting to default                                        |
| `reset-all-settings`               | Reset all settings (preserves token/mock/apiHeaders)                |
| `reset-windows`                    | Reset GUI window positions                                          |
| `help-settings`                    | Detailed settings help                                              |

<!-- /TODO(translation) -->

## 🚀 Detalizēti lietošanas scenāriji

### **Scenārijs 1: Maksimāla redzamība visos izaicinājumos**

**Mērķis**: Sasniegt maksimālu redzamību visos aktīvajos izaicinājumos

**Ieteicamie iestatījumi**:

- **Redzamība**: 100%
- **Pēdējo minūšu slieksnis**: 30 minūtes
- **Balsošanas intervāls**: 3 minūtes
- **Tikai Boost režīms**: Izslēgts
- **Balsot tikai pēdējo minūšu laikā**: Izslēgts

**Darbības**:

1. Konfigurējiet iestatījumus, kā norādīts augstāk
2. Noklikšķiniet uz "Sākt automātisko balsošanu"
3. Atstājiet lietotni darboties fonā
4. Periodiski pārbaudiet statusu

### **Scenārijs 2: Stratēģiska balsošana pēdējās minūtēs**

**Mērķis**: Koncentrēt balsošanu tikai pēdējās minūtēs pirms izaicinājuma beigām

**Ieteicamie iestatījumi**:

- **Redzamība**: 90%
- **Pēdējo minūšu slieksnis**: 15 minūtes
- **Balsošanas intervāls**: 2 minūtes
- **Tikai Boost režīms**: Izslēgts
- **Balsot tikai pēdējo minūšu laikā**: Ieslēgts

**Darbības**:

1. Konfigurējiet iestatījumus, kā norādīts augstāk
2. Noklikšķiniet uz "Sākt automātisko balsošanu"
3. Lietotne gaidīs, līdz izaicinājumi būs pēdējo 15 minūšu laikā
4. Kad izaicinājums ienāk pēdējo minūšu slieksnī, balsošana sāksies automātiski

### **Scenārijs 3: Tikai Boost optimizācija**

**Mērķis**: Izmantot tikai Boost funkciju, bez parastās balsošanas

**Ieteicamie iestatījumi**:

- **Boost laiks**: 7200 sekundes (2 stundas)
- **Tikai Boost režīms**: Ieslēgts
- **Balsošanas intervāls**: 10 minūtes

**Darbības**:

1. Konfigurējiet iestatījumus, kā norādīts augstāk
2. Noklikšķiniet uz "Sākt automātisko balsošanu"
3. Lietotne automātiski pielietos boost, kad līdz izaicinājuma beigām būs 2 stundas
4. Parastā balsošana netiks veikta

### **Scenārijs 4: Pielāgoti iestatījumi katram izaicinājumam**

**Mērķis**: Optimizēt iestatījumus atbilstoši katra izaicinājuma specifikai

**Darbības**:

1. Noklikšķiniet uz "Iestatījumi"
2. Konfigurējiet globālos noklusējuma iestatījumus
3. Noklikšķiniet uz "Specifiskie iestatījumi izaicinājumiem"
4. Izvēlieties izaicinājumu no saraksta
5. Pielāgojiet iestatījumus šim konkrētajam izaicinājumam
6. Saglabājiet iestatījumus
7. Atkārtojiet 4.-6. soli katram izaicinājumam, kuram vēlaties specifiskus iestatījumus
8. Atgriezieties galvenajā ekrānā un sāciet automātisko balsošanu

## 📊 Žurnālfaili un monitorings

Lietotne uztur detalizētus žurnālfailus, kas palīdz sekot līdzi darbībām un diagnosticēt problēmas:

### **Žurnālfailu atrašanās vietas**:

- **Windows**: `%APPDATA%\gurushots-auto-vote\logs\`
- **macOS**: `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Linux**: `~/.config/gurushots-auto-vote/logs/`

### **Žurnālfailu tipi**:

- **errors-YYYY-MM-DD.log**: Kļūdu žurnāls (saglabājas 30 dienas)
- **app-YYYY-MM-DD.log**: Vispārējais lietotnes žurnāls (saglabājas 7 dienas)
- **api-YYYY-MM-DD.log**: API pieprasījumu/atbilžu žurnāls (tikai izstrādes režīmā, saglabājas 1 dienu)

### **Žurnālfailu tīrīšana**:

Lietotne automātiski veic žurnālfailu tīrīšanu:

- **Startēšanas tīrīšana**: Notiek, kad lietotne tiek palaista
- **Periodiska tīrīšana**: Notiek katru stundu, kamēr lietotne darbojas
- **Ikdienas rotācija**: Izveido jaunus žurnālfailus katru dienu ar datuma nosaukumiem
- **Izmēra ierobežojumi**: Automātiski dzēš žurnālfailus, kas pārsniedz izmēra ierobežojumus:
    - `errors-YYYY-MM-DD.log`: maksimāli 10 MB
    - `app-YYYY-MM-DD.log`: maksimāli 50 MB
    - `api-YYYY-MM-DD.log`: maksimāli 20 MB

## 🔍 Problēmu risināšana

### **Biežākās problēmas**

#### **"Nav atrasts autentifikācijas tokens"**

**Simptomi**:

- Lietotne rāda kļūdu par trūkstošu autentifikācijas tokenu
- Nevar piekļūt izaicinājumiem

**Risinājumi**:

- Pārliecinieties, ka esat pieslēdzies ar saviem GuruShots akreditācijas datiem
- Mēģiniet iziet un pieteikties vēlreiz
- Pārbaudiet, vai jūsu interneta savienojums ir stabils
- Ja problēma saglabājas, izdzēsiet iestatījumu failu un mēģiniet vēlreiz:
    - Windows: Izdzēsiet `%APPDATA%\gurushots-auto-vote\settings.json`
    - macOS: Izdzēsiet `~/Library/Application Support/gurushots-auto-vote/settings.json`
    - Linux: Izdzēsiet `~/.config/gurushots-auto-vote/settings.json`

#### **"Tīkla kļūda"**

**Simptomi**:

- Lietotne nevar savienoties ar GuruShots API
- Rāda tīkla kļūdas paziņojumu

**Risinājumi**:

- Pārbaudiet savu interneta savienojumu
- Pārliecinieties, ka jūsu ugunsmūris neblokē lietotni
- Palieliniet API noildzes laiku iestatījumos (līdz 60-120 sekundēm)
- Mēģiniet vēlāk, jo GuruShots serveri var būt īslaicīgi nepieejami
- Pārbaudiet, vai GuruShots vietne ir pieejama jūsu pārlūkprogrammā

#### **"Token beidzies"**

**Simptomi**:

- Lietotne rāda kļūdu par tokena derīguma termiņa beigām
- Nevar veikt darbības ar izaicinājumiem

**Risinājumi**:

- Piesakieties vēlreiz ar saviem akreditācijas datiem
- Pārliecinieties, ka jūsu datora laiks ir pareizi iestatīts
- Ja problēma atkārtojas, izdzēsiet iestatījumu failu un mēģiniet vēlreiz

#### **Logi atveras ārpus ekrāna**

**Simptomi**:

- Lietotnes logs nav redzams pēc palaišanas
- Lietotne darbojas (redzama uzdevumu joslā), bet logs nav redzams

**Risinājumi**:

- Aizveriet lietotni un palaidiet vēlreiz
- Mēģiniet palaist lietotni, turot nospiestu Shift taustiņu
- Atiestatiet logu pozīcijas, izdzēšot iestatījumu failu
- Windows: Ar peles labo pogu noklikšķiniet uz uzdevumu joslas ikonas un izvēlieties "Pārvietot", tad izmantojiet bulttaustiņus, lai pārvietotu logu

#### **Automātiskā balsošana nedarbojas**

**Simptomi**:

- Lietotne ir palaista, bet balsošana nenotiek
- Statuss rāda "Darbojas", bet nekas nemainās

**Risinājumi**:

- Pārbaudiet, vai jums ir aktīvi izaicinājumi
- Pārliecinieties, ka redzamības iestatījums nav jau sasniegts (noklusējums ir 100%)
- Pārbaudiet, vai "Balsot tikai pēdējo minūšu laikā" nav ieslēgts, kad izaicinājumi vēl nav pēdējo minūšu slieksnī
- Pārbaudiet žurnālfailus, lai iegūtu detalizētāku informāciju par problēmu
- Atjaunojiet izaicinājumu datus, noklikšķinot uz "Atjaunot" pogas

### **Saņemt palīdzību**

Pārbaudiet pašreizējo statusu:

- Apskatiet lietotnes interfeisu
- Pārbaudiet pieslēgšanās statusu
- Pārbaudiet žurnālfailus kļūdu diagnostikai

Ja problēmas saglabājas:

1. Pārbaudiet problēmu risināšanas sadaļu augšā
2. Pārbaudiet statusu lietotnes interfeisā
3. [Atveriet problēmu GitHub](https://github.com/isthisgitlab/gurushots-auto-vote/issues) ar detalizētu problēmas aprakstu

## 🔒 Drošība

GuruShots Auto Voter lietotne ir izstrādāta, ņemot vērā drošību:

- **Droša komunikācija**: Visi API izsaukumi izmanto drošu HTTPS protokolu
- **Akreditācijas datu aizsardzība**: Akreditācijas dati nekad netiek reģistrēti žurnālfailos
- **Droša tokenu glabāšana**: Tokeni tiek saglabāti lokāli un drošā veidā
- **Privātums**: Jutīga informācija netiek atklāta kļūdu ziņojumos
- **Datu minimizācija**: Lietotne saglabā tikai nepieciešamo informāciju darbībai
- **Lokāla darbība**: Visi iestatījumi un konfigurācijas tiek glabāti tikai jūsu datorā

### **Drošības ieteikumi**:

1. **Regulāri atjauniniet lietotni**: Vienmēr izmantojiet jaunāko versiju, lai iegūtu drošības uzlabojumus
2. **Izmantojiet drošu paroli**: Izmantojiet unikālu, spēcīgu paroli savam GuruShots kontam
3. **Nedalieties ar iestatījumu failiem**: Iestatījumu faili satur jūsu autentifikācijas informāciju
4. **Pārbaudiet žurnālfailus**: Periodiski pārbaudiet žurnālfailus, lai pārliecinātos, ka nav neparedzētu darbību
5. **Izmantojiet oficiālās lejupielādes**: Lejupielādējiet lietotni tikai no oficiālā GitHub repozitorija

## 🆘 Atbalsts

Problēmām un jautājumiem:

1. Pārbaudiet problēmu risināšanas sadaļu augšā
2. Pārbaudiet statusu lietotnes interfeisā
3. Pārbaudiet žurnālfailus detalizētai diagnostikai
4. [Atveriet problēmu GitHub](https://github.com/isthisgitlab/gurushots-auto-vote/issues) ar šādu informāciju:
    - Lietotnes versija
    - Operētājsistēma un versija
    - Detalizēts problēmas apraksts
    - Soļi, kā reproducēt problēmu
    - Attiecīgie žurnālfailu fragmenti (bez personīgās informācijas)

---

**Piezīme**: Šī lietotne ir paredzēta izglītības un attīstības nolūkiem. Lūdzu, ievērojiet GuruShots lietošanas
noteikumus un izmantojiet atbildīgi.
