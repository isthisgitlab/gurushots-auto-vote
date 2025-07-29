# GuruShots Auto Voter - Instalācijas ceļvedis

## 📥 Lejupielāde un instalācija

### **🚀 Ātrās lejupielādes saites**

**Latest Version: v0.1.0**

#### **🖥️ Grafiskā lietotne (Ieteicams lielākajai daļai lietotāju)**

| Platforma         | Lejupielāde                                                                                                                                                          | Izmērs | Tips                  |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------|-----------------------|
| **Windows**       | [📥 GuruShotsAutoVote-v0.1.0-x64.exe](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.1.0-x64.exe)                 | ~50 MB | Portatīva izpildfaila |
| **macOS**         | [📥 GuruShotsAutoVote-v0.1.0-arm64.dmg](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.1.0-arm64.dmg)             | ~50 MB | DMG instalētājs       |
| **Linux (x64)**   | [📥 GuruShotsAutoVote-v0.1.0-x86_64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.1.0-x86_64.AppImage) | ~50 MB | AppImage              |
| **Linux (ARM64)** | [📥 GuruShotsAutoVote-v0.1.0-arm64.AppImage](https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v0.1.0-arm64.AppImage)   | ~50 MB | AppImage              |

### **📋 Instalācijas instrukcijas**

#### **🪟 Windows lietotājiem**

1. **Lejupielādēt**: Noklikšķiniet uz Windows saites augšā, lai lejupielādētu `.exe` failu
2. **Palaist**: Veiciet dubultklikšķi uz lejupielādētā faila, lai palaistu lietotni
3. **Instalācija nav nepieciešama**: Lietotne darbojas tieši no izpildfaila
4. **Pirmā palaišana**: Lietotne izveidos konfigurācijas failus jūsu lietotāja mapē

**✅ Tas ir viss!** Lietotne ir gatava lietošanai.

#### **🍎 macOS lietotājiem**

1. **Lejupielādēt**: Noklikšķiniet uz macOS saites augšā, lai lejupielādētu `.dmg` failu
2. **Atvērt DMG**: Veiciet dubultklikšķi uz lejupielādētā `.dmg` faila
3. **Instalēt**: Velciet lietotnes ikonu uz Applications mapi
4. **Palaist**: Atveriet lietotni no Applications mapes

**🔧 Ja saņemat drošības brīdinājumus:**

```bash
# Atveriet Terminal un izpildiet šo komandu (aizstājiet ar savu faktisko ceļu):
xattr -rd com.apple.quarantine /Applications/GuruShotsAutoVote.app
```

#### **🐧 Linux lietotājiem**

**Grafiskā lietotne (AppImage):**

1. **Lejupielādēt**: Noklikšķiniet uz atbilstošās Linux saites augšā
2. **Padarīt izpildāmu**: Labais klikšķis uz faila → Properties → Permissions → Atzīmējiet "Allow executing file as
   program"
    - Vai izmantojiet termināli: `chmod +x GuruShotsAutoVote-v0.1.0-*.AppImage`
3. **Palaist**: Veiciet dubultklikšķi uz faila vai palaidiet no termināļa: `./GuruShotsAutoVote-v0.1.0-*.AppImage`

### **🎯 Kuru versiju lejupielādēt?**

**Ieteicamā lejupielāde**: Grafiskā lietotne jūsu platformai

**Kāpēc grafiskā lietotne?**

- ✅ **Vienkārša lietošana** - Vizuāls interfeiss, nav nepieciešamas komandas
- ✅ **Pilna funkcionalitāte** - Visas funkcijas pieejamas caur interfeisu
- ✅ **Automātiska atjaunināšana** - Lietotne pati pārvalda balsošanu
- ✅ **Drošība** - Droša autentifikācija un datu saglabāšana

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

## 🎯 Ātrs sākums

### **Grafiskā lietotne (Ieteicams iesācējiem)**

Palaidiet lietotni un sekojiet šiem soļiem:

1. **Pieslēgšanās**: Ievadiet savus GuruShots akreditācijas datus
2. **Iestatījumu izvēle**: Izvēlieties tēmu un vai palikt pieslēgtam
3. **Izaicinājumu apskate**: Apskatiet savus aktīvos izaicinājumus un balsošanas statusu
4. **Balsošanas sākšana**: Izmantojiet interfeisu, lai pārvaldītu savu balsošanu

## 🔧 Lietošana

### **Grafiskā lietotne**

Grafiskā lietotne nodrošina lietotājam draudzīgu interfeisu jūsu GuruShots balsošanas pārvaldībai:

- **Pieslēgšanās ekrāns**: Droša autentifikācija ar tēmas opcijām
- **Galvenais interfeiss**: Apskatiet izaicinājumus, uzraugiet balsošanas statusu un pārvaldiet iestatījumus
- **Iestatījumi**: Visas preferences tiek automātiski saglabātas

## ⚙️ Iestatījumi

Lietotne automātiski saglabā jūsu preferences:

- **Tēma**: Gaišs vai tumšs režīms
- **Atcerēties mani**: Palikt pieslēgtam starp sesijām
- **Loga pozīcija**: Atceras, kur novietojāt lietotnes logu
- **Autentifikācija**: Drošā veidā saglabā jūsu pieslēgšanās tokenu

## 🔍 Problēmu risināšana

### **Biežākās problēmas**

**"Nav atrasts autentifikācijas tokens"**

- Pārliecinieties, ka esat pieslēdzies ar saviem GuruShots akreditācijas datiem
- Mēģiniet vēlreiz

**"Tīkla kļūda"**

- Pārbaudiet savu interneta savienojumu
- Mēģiniet vēlāk

**"Token beidzies"**

- Piesakieties vēlreiz ar saviem akreditācijas datiem

**Logi atveras ārpus ekrāna**

- Aizveriet lietotni un palaidiet vēlreiz

### **Saņemt palīdzību**

Pārbaudiet pašreizējo statusu:

- Apskatiet lietotnes interfeisu
- Pārbaudiet pieslēgšanās statusu

## 🔒 Drošība

- Visi API izsaukumi izmanto drošu HTTPS
- Akreditācijas dati nekad netiek reģistrēti
- Tokeni tiek saglabāti lokāli un drošā veidā
- Jutīga informācija netiek atklāta kļūdu ziņojumos

## 🆘 Atbalsts

Problēmām un jautājumiem:

1. Pārbaudiet problēmu risināšanas sadaļu augšā
2. Pārbaudiet statusu lietotnes interfeisā
3. [Atveriet problēmu GitHub](https://github.com/isthisgitlab/gurushots-auto-vote/issues)

---

**Piezīme**: Šī lietotne ir paredzēta izglītības un attīstības nolūkiem. Lūdzu, ievērojiet GuruShots lietošanas
noteikumus un izmantojiet atbildīgi. 