# GuruShots Auto Voter — Lietošanas ceļvedis

[← Lejupielāde, instalācija un ātrais sākums](../README.lv.md) · [English](usage.md)

- [Lietošana](#-lietošana)
- [Kā darbojas balsošana](#️-kā-darbojas-balsošana)
- [Uzstādījumu apraksts](#️-uzstādījumu-apraksts)
- [Ieteicamie uzstādījumi](#-ieteicamie-uzstādījumi)
- [Žurnālfaili](#-žurnālfaili)
- [Problēmu risināšana](#-problēmu-risināšana)

## 🔧 Lietošana

### Grafiskā lietotne

- **Pieteikšanās ekrāns** — e-pasts, parole, _Atcerēties pieteikšanās sesiju_, tēma un valoda.
- **Augšējā josla** — lietotnes nosaukums, testa režīma indikators, Uzstādījumi un Iziet.
- **Automātiskās balsošanas vadība** — Sākt/Apturēt, statusa zīme (darbojas / gaida / dīkstāvē), pēdējās palaišanas laiks un sesijā izpildīto ciklu skaits.
- **Izaicinājumu saraksts** — katrā kartītē redzams nosaukums, beigu laiks, jūsu redzamība un balsošanas statuss. Poga **⚙️** atver konkrētā izaicinājuma uzstādījumu logu (tajā var pielāgot jebkuru balsošanas uzstādījumu; nenorādītajiem tiek izmantotas jūsu globālās noklusējuma vērtības).
- **Pāreja uz izaicinājumu** — virs kartītēm redzams visu aktīvo izaicinājumu saraksts; noklikšķiniet uz nosaukuma, lai uzreiz pārvietotos līdz tā kartītei. Virs saraksta esošā Boost logu josla izceļ izaicinājumus, kuriem Boost logs pašlaik ir atvērts.
- **Izaicinājuma informācija** — jūsu vieta reitingā/redzamība/balsis, jūsu iesniegtie foto un Boost/Turbo statuss.
- **Darbības ar katru foto** — pie katra foto, kad tas iespējams, parādās pogas **🚀 Izmantot Boost** un **⚡ Izmantot Turbo**. Vienam foto var izmantot vai nu Boost, vai Turbo, tāpēc, tiklīdz viens no tiem izmantots, neviena no pogām šim foto vairs netiek rādīta.
- **Spēlēt Turbo minispēli** — atvērtos izaicinājumos, kuros jums nav Turbo, palaiž minispēli, lai iegūtu Turbo (tas notiek arī automātiski, ja ieslēgts `autoTurbo`).
- **Atjauninājumu logs** — parādās, kad pieejama jauna versija: pieejama → notiek lejupielāde (ar progresu) → gatava instalēšanai (vai kļūda).

> **Piezīme:** ja automātiskās balsošanas laikā maināt uzstādījumus vai pārvietojat grafiskās lietotnes logu, balsošanas cikls **apstājas** (pārvietojot logu, tā jaunā pozīcija un izmērs tiek saglabāti uzstādījumos). Kad esat beiguši, atsāciet automātisko balsošanu.

### CLI komandas

> **⚠️** Vienlaikus darbiniet tikai VIENU eksemplāru (grafisko lietotni vai CLI).

| Komanda                                           | Ko tā dara                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                                           | Piesakās GuruShots un saglabā tokenu (interaktīvi; vajadzīgs īsts terminālis).                                                                                                    |
| `logout`                                          | Izdzēš saglabāto autentifikācijas tokenu.                                                                                                                                         |
| `vote`                                            | Izpilda **vienu manuālu ciklu** — balso līdz **100 %** visos aktīvajos izaicinājumos, neņemot vērā nevienu slieksni. Vienreizēja papildināšana.                                   |
| `run [--challenge=<id>]`                          | Izpilda **vienu pilnu automātiskās stratēģijas ciklu** (Boost / Turbo / automātiskā iesniegšana / balsošana, ievērojot sliekšņus). Ar `--challenge` — tikai vienam izaicinājumam. |
| `boost --challenge=<id> [--image=<id>]`           | Izmanto Boost vienā izaicinājumā. Bez `--image` izmanto vietu, ko nosaka `boostImageIndex`.                                                                                       |
| `turbo --challenge=<id>`                          | Spēlē Turbo minispēli, lai iegūtu Turbo vienā izaicinājumā (tikai iegūst; iegūto Turbo izmanto `useTurbo` vai grafiskā lietotne).                                                 |
| `submit --challenge=<id> [--all]`                 | Iesniedz augstāk ranžēto foto vienā tukšā vietā vai ar `--all` — uzreiz visās tukšajās vietās.                                                                                    |
| `bankroll` (alias `coins`)                        | Parāda jūsu valūtu atlikumus — atslēgas / apmaiņas / uzpildes / monētas.                                                                                                          |
| `discover`                                        | Parāda atvērtos izaicinājumus, kuriem vēl neesat pievienojušies un kuriem varat pievienoties, kopā ar katra izaicinājuma veidu un cenu monētās.                                   |
| `join <id> [--yes]`                               | Pievienojas atvērtam izaicinājumam. Bezmaksas izaicinājumiem pievienojas uzreiz; **maksas** izaicinājumam parāda cenu monētās un, pirms tērēt monētas, prasa `--yes`.             |
| `list-scenarios`                                  | Parāda jūsu saglabātos scenārijus un scenāriju šablonu piemērus.                                                                                                                  |
| `scenario-template <id> [file]`                   | Izdrukā (vai ieraksta failā) scenārija piemēru, ar ko sākt.                                                                                                                       |
| `import-scenario <file> [--overwrite] [--yes]`    | Pārbauda scenārija failu un parāda, ko tas dara, arī katru darbību, kas tērē resursus; `--yes` to importē, `--overwrite` aizstāj scenāriju ar tādu pašu nosaukumu.                |
| `export-scenario "<name>" [file]`                 | Izdrukā (vai ieraksta failā) scenāriju JSON formātā kopīgošanai.                                                                                                                  |
| `rename-scenario "<old>" "<new>"`                 | Pārdēvē scenāriju; izaicinājumi, kas to izmanto, pāriet uz jauno nosaukumu.                                                                                                       |
| `delete-scenario "<name>"`                        | Izdzēš scenāriju un noņem tā piešķīrumus.                                                                                                                                         |
| `scenario-status --challenge=<id>`                | Parāda, kur izaicinājums ir savā scenārijā: fāzi, pēdējo darbību, pēdējo problēmu.                                                                                                |
| `scenario-dry-run --challenge=<id>`               | Parāda, ko scenārijs darītu tieši tagad (neko netērē).                                                                                                                            |
| `scenario-simulate --challenge=<id>`              | Parāda "kas būtu, ja" laika grafiku līdz izaicinājuma beigām (neko netērē).                                                                                                       |
| `scenario-reset --challenge=<id>`                 | Aizmirst izaicinājuma scenārija progresu, lai plāns sāktos no sākuma.                                                                                                             |
| `scenario-vocabulary`                             | Uzskaita visus nosacījumus, iesnieguma izvēles veidus un darbības, ko scenārijs var izmantot.                                                                                     |
| `check-updates`                                   | Pārbauda GitHub, vai ir pieejama jaunāka versija.                                                                                                                                 |
| `start`                                           | Sāk **nepārtrauktu** balsošanu ar dinamisku plānošanu. Darbojas, līdz nospiežat **Ctrl+C**.                                                                                       |
| `status`                                          | Parāda režīmu (MOCK/REAL), autentifikācijas statusu un galvenos uzstādījumus.                                                                                                     |
| `get-setting <key> [--challenge=<id>]`            | Izdrukā uzstādījuma spēkā esošo vērtību (ar `--challenge` — konkrētajam izaicinājumam).                                                                                           |
| `set-setting <key> <value> [--challenge=<id>]`    | Maina uzstādījuma vērtību; ar `--challenge` saglabā to kā izaicinājuma pielāgojumu.                                                                                               |
| `set-global-default <key> <value>`                | Maina globālo noklusējuma vērtību, **pārbaudot to pēc shēmas**.                                                                                                                   |
| `list-settings [--challenge=<id>]`                | Parāda visus uzstādījumus un to, kuri ir mainīti (ar `--challenge` — konkrētā izaicinājuma skatā).                                                                                |
| `reset-setting <key> [--challenge=<id>]`          | Atjauno uzstādījuma noklusējuma vērtību (vai ar `--challenge` noņem izaicinājuma pielāgojumu).                                                                                    |
| `reset-all-settings`                              | Atjauno visu noklusējuma vērtības (saglabā tokenu, testa režīma pazīmi un API galvenes).                                                                                          |
| `logs [--error\|--api\|--settings] [--lines=<n>]` | Izdrukā žurnālfaila beigas (pēc noklusējuma 100 rindu; noklusējuma kategorija — lietotnes žurnāls).                                                                               |
| `reset-windows`                                   | Atjauno grafiskās lietotnes logu noklusējuma pozīcijas.                                                                                                                           |
| `help-settings`                                   | Detalizēta palīdzība par uzstādījumu sistēmu — atslēgu nosaukumi, vērtību formāti, diapazoni.                                                                                     |
| `help`                                            | Parāda komandu palīdzību.                                                                                                                                                         |

Grafiskajai lietotnei un CLI uzstādījumi ir kopīgi: izmaiņu, ko CLI veic ar `set-setting`, redz arī grafiskā lietotne, un otrādi.

> Turpmākajos piemēros aizstājiet `[platforma]` ar `mac`, `linux` vai `linux-arm`.

```bash
./gurucli-v1.12.0-beta.2-[platforma] set-global-default exposure 80
./gurucli-v1.12.0-beta.2-[platforma] set-setting onlyBoost true --challenge=12345
./gurucli-v1.12.0-beta.2-[platforma] list-settings --challenge=12345
./gurucli-v1.12.0-beta.2-[platforma] logs --error --lines=50
```

## ⚙️ Kā darbojas balsošana

### Viens balsošanas cikls

Cikls ir viena visu jūsu aktīvo izaicinājumu apstrāde. Katram izaicinājumam lietotne pēc kārtas izmanto **Boost**, ja pienācis laiks, spēlē minispēli vai izmanto **Turbo**, ja tas iespējams, **automātiski iesniedz** foto tukšā vietā, ja pienācis laiks, un pēc tam **balso**, līdz sasniegts mērķis, ko nosaka turpmāk aprakstītie noteikumi.

### Redzamības noteikumi (kurš mērķis ir spēkā)

Katram izaicinājumam ir redzamības **slieksnis** ("balsot, kamēr mana redzamība ir zem šī līmeņa") un balsošanas **mērķis** ("turpināt balsot līdz šim %"). Spēkā ir pirmais atbilstošais noteikums:

1. **Tikai Boost** (`onlyBoost`) — balsošana tiek izlaista pavisam; lietotne tikai izmanto Boost/Turbo.
2. **Vēl nav sācies** — izaicinājums tiek izlaists.
3. **Flash izaicinājums** — mērķis vienmēr ir **100 %**.
4. **Balsot tikai pēdējās minūtes laikā** (`voteOnlyInLastMinute`) — ja ieslēgts un izaicinājums _vēl nav_ sasniedzis savu pēdējās minūtes logu, balsošana tiek izlaista.
5. **Pēdējās minūtes logs** — `lastMinuteThreshold` minūtes pirms beigām mērķis vienmēr ir **100 %** (redzamības griesti netiek ņemti vērā).
6. **Beigu logs** — ja ieslēgts `useFinalWindowExposure` un līdz izaicinājuma beigām atlicis ne vairāk kā `finalWindowDuration` (pēc noklusējuma 1 stunda), tiek izmantots slieksnis `finalWindowExposure` un mērķis `finalWindowExposureTarget`.
7. **Parastais** — citos gadījumos tiek izmantots slieksnis `exposure` un mērķis `exposureTarget`.

Ja slieksnim ir atsevišķs mērķis, lietotne sāk balsot tikai tad, kad esat zem sliekšņa, un turpina līdz mērķim. Mērķis `0` nozīmē "apstāties pie sliekšņa" (mērķis = slieksnis).

**Balsot par jaunu foto** (`voteOnNewEntry`, pēc noklusējuma izslēgts) maina tikai pārbaudi "vai mērķis jau sasniegts?". Kad izaicinājumā parādās jauns foto — tāds, ko pievienojāt tīmekļa vietnē, vai tāds, ko iesniedza automātiskā iesniegšana, ārkārtas iesniegšana vai jauna foto Boost/Turbo funkcija, — lietotne nobalso vienu reizi arī tad, ja jūsu redzamība jau rāda slieksni vai vairāk. Tā balso līdz mērķim, ko noteica spēkā esošais noteikums (100 % flash izaicinājumos, pēdējās minūtes logā un plānotajā balsošanā; `finalWindowExposureTarget` beigu logā; citos gadījumos `exposureTarget`). Foto pievienošana redzamību samazina uzreiz, taču uzrādītais skaitlis ne vienmēr atjaunojas tajā pašā pārbaudē, tāpēc bez šī uzstādījuma jaunais foto var palikt bez redzamības vienu ciklu vai ilgāk.

Šis uzstādījums nekad neatceļ noteikumu, kas izlaiž balsošanu: ja balsošanu bloķē **only-boost** (1. solis), **not-started** (2. solis), **vote-only-in-last-minute** (4. solis) vai **scheduled-fill-only** (`scheduledFillReplaces`, ārpus sava loga), balsojums nenotiek un jaunā foto signāls tiek uzskatīts par izlietotu. Šie ir iekšējie noteikumu nosaukumi, ko rāda žurnāli, tāpēc pēdējā no tiem joprojām ir vārds "fill", lai gan saskarnē šis uzstādījums tagad saucas **Plānotā balsošana**. Ja neizdodas pats balsojums, signāls paliek spēkā, un nākamajā ciklā lietotne mēģina vēlreiz.

### Pārbaužu biežums

Nepārtrauktajā režīmā lietotne starp cikliem nogaida nejauši izvēlētu laiku no `[checkFrequencyMin, checkFrequencyMax]` minūtēm. Tiklīdz kāds izaicinājums sasniedz savu `lastMinuteThreshold` logu, plānotājs pāriet uz fiksētu, biežāku intervālu (`lastMinuteCheckFrequency`, pēc noklusējuma ik pēc 1 minūtes), līdz šajā logā vairs nav neviena izaicinājuma, un tad atgriežas pie iepriekšējā. (Katras platformas iekšējā darbība aprakstīta failā [`scheduling.md`](scheduling.md): CLI un Android izmanto vienu dzinēju, grafiskā lietotne — tos pašus aprēķinus.)

### Boost

Kad ieslēgts `autoBoost`, lietotne izmanto pieejamo Boost foto, kas atrodas vietā `boostImageIndex` (1 = pirmais foto, `0` = pēdējais; ja šim foto jau izmantots Turbo, tiek ņemta iepriekšējā vieta):

- **Boost ar laika atskaiti** — tiek izmantots, kad Boost logā atlicis `boostTime` sekunžu vai mazāk.
- **Ar atslēgu atbloķēts Boost** (bez laika atskaites) — `boostTime` uz to neattiecas, jo nav laika, ko skaitīt. Tam ir savs logs `keyUnlockedBoostTime` (pēc noklusējuma 15 min), ko mēra līdz izaicinājuma beigām. Tā kā ar atslēgu atbloķēta Boost derīgums nekad nebeidzas, pēc noklusējuma lietotne to izmanto pēc iespējas vēlāk, lai efekts būtu vislielākais.
- **Gaidīšana pēc jauna foto** — Boost, ko izmanto foto tūlīt pēc tā nonākšanas izaicinājumā, saņem maz balsu, tāpēc paredzētais Boost tiek aizturēts, līdz foto, kuram tas paredzēts, ir bijis izaicinājumā `boostFreshEntryWait` (pēc noklusējuma 3 min). Tad Boost tiek izmantots nākamajā ciklā, ko plānotājs ieplāno tieši šajā brīdī. Laiku skaita no brīža, kad lietotne foto ieraudzīja pirmo reizi: no pašas lietotnes veiktās iesniegšanas vai no pirmās pārbaudes pēc tam, kad foto iesniedzāt paši. Boost nekad netiek aizturēts pēc tā termiņa beigām — ja gaidīšana nebeigtos vismaz minūti pirms Boost laika beigām (Boost ar laika atskaiti) vai izaicinājuma beigām (ar atslēgu atbloķēts Boost), lietotne to izmanto uzreiz. `0` gaidīšanu izslēdz.

### Turbo (iegūt, pēc tam izmantot)

Turbo ir lēni atjaunojams resurss, ko iegūstat, spēlējot minispēli, un pēc tam izmantojat, kad vēlaties. Abas daļas regulē atsevišķi uzstādījumi:

- **Automātiska iegūšana (`autoTurbo`, pēc noklusējuma ieslēgta)** — ja jums nav Turbo, lietotne katrā ciklā spēlē minispēli, lai to iegūtu. (Grafiskajā lietotnē to pašu dara poga **Spēlēt Turbo minispēli**.)
- **Automātiska izmantošana (`useTurbo`, pēc noklusējuma izslēgta)** — ja jums ir Turbo un līdz izaicinājuma beigām atlicis `turboTime` sekunžu vai mazāk, Turbo tiek izmantots foto, kas atrodas vietā `turboImageIndex`. Lietotne negaida, kad atvērsies Boost logs: vienīgais ierobežojums ir tāds, ka Boost un Turbo nekad netiek izmantoti vienam un tam pašam foto.

Katra izaicinājuma Turbo var iegūt tikai vienreiz. Lai daļu pietaupītu "Win Turbo" misijai, ieslēdziet **Taupīt Turbo misijām** (skatiet [Misijas](#misijas)).

Grafiskajā lietotnē iegūto Turbo varat izmantot arī konkrētam foto ar tā pogu **⚡**, neņemot vērā automātiski izvēlēto vietu. Vienam foto var izmantot vai nu Boost, vai Turbo, nekad abus.

### Trūkstošo foto automātiskā iesniegšana

GuruShots **uzpilde** (angliski _fill_) ir valūta, kas paceļ redzamību līdz 100 % (viens no atlikumiem, kas redzami sadaļā [Konta atlikums](#konta-atlikums)). Foto pievienošana tukšajās vietās ir kas cits, un lietotne to sauc par **automātisko iesniegšanu**.

Ja izaicinājumā var iesniegt vairākus foto, bet daļu vietu esat atstājuši tukšas, izaicinājuma beigās šīs vietas ir zaudētas. Ja ieslēgts `autoFill`, plānotājs **katrā ciklā iesniedz vienu foto** saskaņā ar jūsu `autoFillSchedule` — soļu sarakstu, kurā katrs solis nozīmē "kad līdz beigām atlicis `seconds`, jābūt vismaz `count` foto" (piemēram, 2. foto 48 h, 3. foto 3 h, 4. foto 15 min pirms beigām). Ja izaicinājumā var iesniegt mazāk foto, nekā aptver grafiks, viss grafiks tiek pārbīdīts uz beigām, lai pēdējā foto laiks attiektos uz izaicinājuma pēdējo foto: izaicinājumā ar 2 foto 2. foto izmanto 4. foto laiku, bet izaicinājumā ar 3 foto 2. un 3. foto izmanto 3. un 4. foto laikus. Ja atpaliekat no grafika (lietotne palaista vēlu vai kāds solis ir garāks par visu izaicinājuma ilgumu), lietotne to panāk, katrā ciklā iesniedzot pa vienam foto. Atstarpes ir svarīgas, jo GuruShots sadala balsis starp vienlaikus iesniegtiem foto, tāpēc, iesniedzot tos pakāpeniski, katrs jaunais foto iegūst savu redzamību. Esošās `autoFillIntervalMinutes` konfigurācijas tiek pārveidotas automātiski (intervāls `M` kļūst par 2 @ 3×M, 3 @ 2×M, 4 @ 1×M minūtēm pirms beigām).

- **`emergencyFill`** (Ārkārtas iesniegšana) — drošības tīkls: pēdējā posmā pirms beigām tā iesniedz foto visās atlikušajās vietās arī tad, ja parastie noteikumi vēl gaidītu, un neņem vērā obligāto (must-include) tagu filtru. Šajā pašā logā tā arī izmanto jebkuru pieejamu Boost un jebkuru iegūtu Turbo, pat ja `autoBoost` / `useTurbo` šim izaicinājumam ir izslēgti, lai tie beigās neaizietu zudumā. Grafiskajā lietotnē vērtību ievada stundās un minūtēs (h+m), saglabā — sekundēs. `0` ārkārtas iesniegšanu izslēdz (līdz ar to izslēdzot arī Boost/Turbo izņēmumu); vērtībai jābūt `≤ lastMinuteThreshold`, lai ātrais pēdējās minūtes intervāls darbotos visā logā.
- **Tagu filtri** — `mustIncludeTags` ir stingrs filtrs (derīgi tikai foto, kuriem ir visi norādītie tagi); `shouldIncludeTags` nosaka tikai priekšroku. `fillWithoutTagMatch` nosaka, kas notiek, ja obligātie tagi ir norādīti, bet nevienam foto nav visu šo tagu: iesniegt tik un tā (noklusējums) vai atstāt vietu tukšu.
- **Noteikumu tagi** — [izaicinājumu noteikums](#izaicinājumu-noteikumi) var pievienot obligātos/vēlamos (must/should-include) tagus; iesniegšanas brīdī tos apvieno ar spēkā esošajiem tagu sarakstiem, tāpēc atkārtots izaicinājums savus tagus saņem katrā rotācijā no jauna.
- **Foto izvēle** — kandidātus vienmēr atlasa ar tematisku meklēšanu GuruShots serverī, tā tagu indeksā, izmantojot jūsu obligātos/vēlamos tagus, ja tie norādīti, citādi — atslēgvārdus no izaicinājuma nosaukuma; ja tā neko neatrod, lietotne izmanto visu jūsu bibliotēku, kas atbilst prasībām. Pēc tam katru kandidātu ranžē pēc semantiskā tēmas vērtējuma, kas arī vienmēr ir ieslēgts (cik labi foto atbilst izaicinājumam, `0`–`1`); ja semantisko datu nav, rezerves variants ir atslēgvārdu un vārdu sakņu salīdzināšana ar foto atpazīšanas iezīmēm. Vienāda vērtējuma gadījumā izšķir sasniegumu skaits, kopējais balsu skaits, skatījumi un visbeidzot augšupielādes datums.
- **Brīvas tēmas un temata vārdi** — pirms meklēšanas lietotne izlasa izaicinājuma nosaukumu kopā ar aprakstu. Izaicinājumam ir **brīva tēma**, ja to saka apraksts ("The challenge is an open theme") vai ja nosaukumā vispār nav temata — tikai standartfrāzes ("Guru of The Week", "My Best Shot") vai izaicinājuma formāts ("10 Hours", "500 Guru's Picks"). Brīvas tēmas izaicinājumā tematiskā meklēšana, tēmas vērtējums un vizuālā pārbaude tiek izlaisti, tāpēc jūsu foto ranžē tikai pēc popularitātes (jūsu obligātie/vēlamie tagi joprojām darbojas). Citos gadījumos nosaukuma vārdu, ko atkārto apraksts, uzskata par tematu un meklē vispirms: izaicinājumā "Roads to Anywhere" vispirms meklē "road" un tikai tad "anywhere", jo apraksts prasa ceļus. Nosaukumu, ko apraksts neapstiprina, meklē tāpat kā līdz šim. Pēc katras iesniegšanas un pievienošanās žurnālā tiek ierakstīts, kā lietotne saprata tēmu, kopā ar apraksta sākumu, lai nepareizu interpretāciju varētu pārbaudīt žurnālā.
- **Vizuālā pārbaude** — pirms foto iesniegšanas ierīcē darbināms attēlu atpazīšanas modelis apskata 12 augstāk ranžētos kandidātus un salīdzina katru ar izaicinājumu — ar nosaukuma tematu (bez sērijas prefiksa, noliegtajiem vārdiem, piemēram, "No Humans", un jūsu `ignoreTitleWords`) un apraksta sākumu (bez HTML un standarta balvu teksta). Foto, kuros temats acīmredzami nav redzams, tiek novietoti aiz tiem, kuros tas ir; starp pārbaudi izturējušajiem saglabājas iepriekš aprakstītā ranžēšana, tāpēc izšķirošā joprojām ir popularitāte. Pārbaude darbojas katrā izaicinājumā bez papildu uzstādījumiem. Tā nekad neatstāj vietu tukšu: ja nosaukumā nav vizuāla temata ("Photo of the Day", "Guru of The Week"), ja neviens foto skaidri neatbilst (abstraktas tēmas, piemēram, "It's all About Balance") vai ja modeli neizdodas palaist, tiek izmantota iepriekš aprakstītā ranžēšana bez izmaiņām. Tā pati pārbaude notiek automātiskajā iesniegšanā, ārkārtas iesniegšanā, ar pogām `+1`/`+N`, jauna foto Boost/Turbo funkcijā, foto apmaiņā un automātiskās pievienošanās laikā. Datorā pārbaude vienam izaicinājumam aizņem aptuveni 1–1,5 s (izmantojot procesoru), telefonā — ilgāk; modelis tiek ielādēts vienreiz, pirmajā foto iesniegšanas reizē pēc palaišanas.
- **Jauna foto Boost/Turbo** — ja ieslēgts `boostFillNew` / `turboFillNew`, lietotne iesniedz jaunu foto un izmanto Boost / Turbo tieši tam, lai pieejamais Boost vai Turbo nepaliktu neizmantots tukšas vietas dēļ. Boost gaida `boostFreshEntryWait` pēc iesniegšanas (skatiet **Boost**); Turbo tiek izmantots uzreiz.
- **Manuālās pogas** — katrā kartītē ar tukšām vietām ir pogas **`+1`** (iesniegt augstāk ranžēto foto vienā vietā) un **`+N`** (iesniegt foto visās atlikušajās vietās uzreiz, neievērojot atstarpes). Manuāli klikšķi neņem vērā `autoFill` slēdzi, un automātiskās balsošanas laikā šīs pogas ir atspējotas.

Nesen iesniegtos foto Boost un Turbo pārbaudes automātiski ņem vērā _nākamajā_ ciklā.

### Tikai Boost režīms

`onlyBoost` (katram izaicinājumam atsevišķi) izslēdz šajā izaicinājumā parasto balsošanu — lietotne rīkojas tikai tad, kad var izmantot Boost vai Turbo. Tas noder mazāk svarīgos izaicinājumos, kuros vēlaties tērēt Boost/Turbo, bet ne balsis.

### Automātiskā pievienošanās izaicinājumiem

Viss iepriekš aprakstītais attiecas uz izaicinājumiem, kuriem jau esat pievienojušies. **Automātiskā pievienošanās** (pēc noklusējuma izslēgta) katrā ciklā atrod **atvērtos izaicinājumus, kuriem vēl neesat pievienojušies**, un pievienojas tiem, kurus vēlaties. Tā darbojas kā sagatavošanās solis pirms balsošanas visās platformās (grafiskajā lietotnē, CLI `start`, Android), un pievienoties izaicinājumam nozīmē iesniegt foto, tāpēc automātiskā pievienošanās izmanto to pašu foto izvēli, ko automātiskā iesniegšana (tagi, tematiskā meklēšana, semantiskā ranžēšana, vizuālā pārbaude).

- **Tvērums — kuriem izaicinājumiem pievienoties.** Ieslēdziet `autoJoin`, un pēc noklusējuma lietotne pievienosies **visiem** atvērtajiem izaicinājumiem; loku var sašaurināt ar veidu sarakstiem (pēc izvēles):
    - `autoJoinTypes` — izaicinājumu veidu **iekļaušanas** saraksts, atdalīts ar komatiem (piemēram, `flash,contest`). Atstājiet to **tukšu, lai pievienotos visu veidu izaicinājumiem** (noklusējums).
    - `autoJoinExcludeTypes` — **aizlieguma** saraksts ar veidiem, kuriem nekad nepievienoties (piemēram, `flash,exhibition`). Tā kā pēc noklusējuma lietotne pievienojas visiem, jau ar šo sarakstu vien iegūstat "pievienoties visiem, izņemot flash un exhibition".
    - **Noteikuma ieslēgta pievienošanās** ir svarīgāka par abiem veidu sarakstiem: tā ir [izaicinājumu noteikums](#izaicinājumu-noteikumi), kas ieslēdz automātisko pievienošanos, vai profils, ko piešķir noteikums ar nosaukumu vai izaicinājuma tagu. Profils no noteikuma, kas atlasa tikai pēc veida / foto skaita / ilguma, veidu sarakstus **neapiet** — tas nosaka, kā balsot, nevis vai pievienoties.
- **Maksas izaicinājumi — monētu drošība.** Pievienošanās maksas izaicinājumiem pēc noklusējuma ir **izslēgta**, un to ierobežo divi limiti, abiem `0 = izslēgts`: `autoJoinMaxCoins` (lielākais monētu skaits vienai pievienošanās reizei) un `autoJoinCycleCoinBudget` (kopējais monētu skaits, ko drīkst iztērēt vienā ciklā). Lai tērētu monētas, **abiem jābūt > 0**. Par pievienošanos nekad nemaksā, ja pievienošanās netiek pabeigta: vispirms tiek izvēlēts iesniedzamais foto (nav foto ⇒ izlaist, netērēt), un, ja samaksa izdodas, bet iesniegšana ne, šis stāvoklis tiek saglabāts, lai atkārtots mēģinājums pabeigtu iesniegšanu, nevis maksātu vēlreiz.
- **Manuāla pievienošanās.** Sakļautais panelis **Atrast izaicinājumus** zem izaicinājumu saraksta parāda atvērtos izaicinājumus; bezmaksas izaicinājumiem pievienojas ar vienu klikšķi, bet maksas izaicinājumiem atveras apstiprinājums, kurā redzama cena un atlikums pēc samaksas. CLI izmantojiet `discover`, lai tos parādītu, un `join <id>` (maksas izaicinājumiem vajag `--yes`).
- **Indikators.** Kamēr automātiskā balsošana darbojas un automātiskā pievienošanās ir aktīva (ieslēgts galvenais uzstādījums vai to ieslēdz izaicinājumu noteikums), galvenē blakus laika atskaitei parādās zīme **"automātiskā pievienošanās ieslēgta"**. Tā parādās tikai tad, kad pievienošanās solis tiešām tiks izpildīts katrā ciklā, nevis vienkārši tad, kad uzstādījums ir ieslēgts.
- **Pievienošanās laiks.** `autoJoinWithinHoursOfEnd` gaida, kamēr līdz izaicinājuma beigām paliek norādītais stundu skaits; `autoJoinAfterPercentElapsed` gaida, līdz pagājusi norādītā daļa no izaicinājuma ilguma (75 = pēdējā ceturtdaļa), un tas der gan 24 stundu, gan vairāku nedēļu izaicinājumiem. Ja procentu vērtība ir lielāka par 0, tā aizstāj stundu logu. Izaicinājumu, kas ir ārpus loga, katrā ciklā izvērtē no jauna, nevis izlaiž pavisam.
- **Tvērums un prioritāte.** `autoJoin`, veidu un monētu limitu uzstādījumi un pievienošanās laiks tiek noteikti pēc [izaicinājumu noteikumiem](#izaicinājumu-noteikumi) (salīdzinot ar pašu izaicinājumu, kuram vēl neesat pievienojušies), pēc tam — pēc galvenās noklusējuma vērtības. Tāpēc noteikums var ieslēgt pievienošanos, mīkstināt vai pastiprināt limitus vai mainīt laiku tiem izaicinājumiem, kuriem tas atbilst, pat ja galvenā noklusējuma vērtība ir izslēgta. Globāls paliek tikai `autoJoinCycleCoinBudget`, jo kopējam viena cikla tēriņu limitam atsevišķos noteikumos nav jēgas.

### Misijas

GuruShots galvenā misija mainās pa apli: **Join N challenges**, **Use Fill N times**, **Win Turbo N times** un all-star misija. Lietotne var palīdzēt ar pirmajām trim. Katrai ir savs uzstādījums; visi ir globāli un pēc noklusējuma izslēgti. Kamēr kāds no tiem ir ieslēgts, lietotne reizi ciklā nolasa jūsu misijas, atpazīst katru pēc nosaukuma un, pievienojoties izaicinājumiem, izmantojot uzpildes un iegūstot Turbo, skaita, cik vēl atlicis. All-star misiju automatizēt nevar. Izpildīto misiju balvas saņem uzstādījums **Automātiski saņemt balvas** (`autoClaimPrizes`).

- **Taupīt Turbo misijām (`missionSaveTurbos`).** Ja ieslēgta automātiskā iegūšana, lietotne parasti iegūst katra izaicinājuma Turbo, tiklīdz tas kļūst pieejams, tāpēc "Win Turbo" misijai vairs nav ko iegūt. Ja šis uzstādījums ir ieslēgts, iegūstamais Turbo gaida, līdz šāda misija kļūst aktīva vai līdz tā izmantošanas brīdim (`turboTime`) atlikusi stunda. Katrs Turbo joprojām tiek iegūts un izmantots tāpat kā iepriekš, tikai vēlāk. Tam vajadzīga ieslēgta automātiskā iegūšana (`autoTurbo`) un pārbaude vismaz reizi stundā (grafiskās lietotnes lielākais pārbaužu intervāls).
- **Pievienoties agrāk misiju dēļ (`missionJoinEarly`).** "Join challenges" vai "Win Turbo" misijas laikā automātiskā pievienošanās neievēro savu laika nosacījumu (`autoJoinWithinHoursOfEnd` / `autoJoinAfterPercentElapsed`), līdz misija izpildīta, tāpēc izaicinājumiem, kuriem tā tik un tā pievienotos vēlāk, tā pievienojas jau tagad. Turbo misijā tas dod vairāk Turbo, ko iegūt, jo Turbo var iegūt tikai izaicinājumā, kuram esat pievienojušies. Lietotne pievienojas tikai tik izaicinājumiem, cik misijai trūkst, ņemot vērā Turbo, kas jau gaida jūsu izaicinājumos (arī tos, kuru laika atskaite vēl turpinās). Jauna izaicinājuma Turbo var iegūt, tiklīdz beidzas tā laika atskaite. Ārpus šīm misijām automātiskā pievienošanās darbojas kā parasti. Veidu, tagu un monētu filtri joprojām ir spēkā, un arī pašai automātiskās pievienošanās funkcijai jābūt ieslēgtai.
- **Izmantot uzpildes misijām (`missionUseFills`).** "Use Fill" misijas laikā lietotne izmanto uzpildes izaicinājumos, kuros redzamība ir zem 100 %, ne vairāk kā vienu katrā izaicinājumā vienā ciklā, līdz misija izpildīta. Jūsu uzpilžu rezerve (`currencyReserveFills`) netiek aizskarta.

### Izaicinājumu noteikumi

GuruShots katrā rotācijā izaicinājumu atkārto ar jaunu ID, tāpēc izaicinājumam norādītie pielāgojumi zūd, kad izaicinājums atgriežas. **Izaicinājumu noteikumi** tā vietā atlasa izaicinājumus pēc pazīmēm, kas starp rotācijām nemainās. Tos pārvalda sadaļā **Izaicinājumu noteikumi** grafiskās un Android lietotnes uzstādījumu logā; CLI noteikumus ievēro, taču redaktora tajā nav.

- **Nosacījumi.** Noteikumā var izmantot jebkuru šo nosacījumu kombināciju: viens vai vairāki **nosaukumi** (ir tieši / sākas ar / satur, reģistrs netiek ņemts vērā; pietiek ar jebkuru no norādītajiem nosaukumiem), paša izaicinājuma **tags** (Exhibition, Comm, …, nevis foto tags), tā **veids** (default, flash, exhibition, …), **foto skaits** un **ilgums** — "ilgst vismaz" / "ilgst ne vairāk kā" stundās no sākuma līdz beigām (24 h = 1 diena, 168 h = 7 dienas). Jāatbilst katram aizpildītajam laukam; tukšus laukus neņem vērā. Izaicinājums, kura sākuma vai beigu laiks nav zināms, nekad neatbilst ilguma nosacījumam.
- **Ko noteikums dara.** Piešķir uzstādījumu **profilu** (jebkurš izaicinājuma uzstādījums — balsošana, Boost, Turbo, …) un [**scenāriju**](#scenāriji), ieslēdz vai izslēdz **automātisko pievienošanos** / **automātisko iesniegšanu**, nosaka **pievienošanās laiku** (pagājusī izaicinājuma ilguma daļa procentos vai stundas pirms beigām) un pievieno obligātos/vēlamos **foto tagus**. Tukšs lauks nozīmē, ka vērtība tiek mantota.
- **Secība ir noteicošā.** Noteikumus pārbauda no augšas uz leju. Katram uzstādījumam spēkā ir pirmais atbilstošais noteikums, kas to nosaka (noteikuma paša vērtība ir svarīgāka par tā profilu), un visu, ko tas atstāj tukšu, ņem no nākamā atbilstošā noteikuma un pēc tam no globālās noklusējuma vērtības. Izaicinājumam tiek piemērots tikai **viens profils**: no pirmā atbilstošā noteikuma, kurā norādīts profils. Izaicinājuma pielāgojums ⚙️ logā joprojām ir svarīgāks par jebkuru noteikumu.
- **Noklusējuma secība.** **Kārtot noklusējuma secībā** vispirms novieto noteikumus, kuros ir nosaukums, pēc tam pārējos; katrā grupā augstāk atrodas konkrētākais noteikums. Aptuveni: "ir tieši" pirms "sākas ar", "sākas ar" pirms "satur", un vairāk nosacījumu pirms mazāk. Papildu nosacījums var pacelt "sākas ar" noteikumu līdz "ir tieši" līmenim, un tad priekšroka ir garākajam nosaukumam. Vienlīdzīgus noteikumus kārto pēc foto skaita, tad ilguma, tad veida, tad taga — piemēram, `4 foto + ≥ 168 h` ir virs `4 foto`, un tas ir virs `≥ 168 h`. Secību var brīvi mainīt ar bultiņām; saglabājot jūsu secība netiek mainīta.
- **Plaši noteikumi.** Noteikums bez nosaukuma var ieslēgt automātisko pievienošanos vai automātisko iesniegšanu visiem izaicinājumiem, kuriem tas atbilst; šādā gadījumā redaktors rāda brīdinājumu, jo viens noteikums tad var tērēt monētas vai foto veselā izaicinājumu grupā.
- **Pāreja no vecākas versijas.** Ielādējot uzstādījumus no vecākas versijas, saglabātie noteikumi vienreiz tiek sakārtoti noklusējuma secībā, un visi "pievienošanās laiks pēc kategorijas" noteikumi tiek pārvietoti šajā sarakstā zem tiem. Tā kā zemāks noteikums papildina to, ko augstāks atstāj tukšu, uzstādījumu žurnālā tiek ierakstīts brīdinājums par katru noteikumu pāri, kurā tas varētu ieslēgt automātisko pievienošanos vai automātisko iesniegšanu. Ja redzat šādu brīdinājumu, pārskatiet secību.

### Scenāriji

**Scenārijs** ir jūsu pašu rakstīts plāns izaicinājumam, kas ilgst vairākas dienas, piemēram: "katru rītu iesniegt vienu foto, un, ja kāds no tiem strauji kāpj uz augšu, nolikt to malā un pēdējā dienā izmantot tam Boost". Lietotnē nav iebūvētas taktikas: scenārijs sastāv no dažiem pamatelementiem, un to, kā tie savienojas, izlemjat jūs.

**Kur tos atrast.** Grafiskajā un Android lietotnē: **Uzstādījumi → Scenāriji**. Sāciet ar **Jauns scenārijs**, izvēlieties piemēru sarakstā **Sākt no šablona…** un noklikšķiniet uz **Pievienot kopiju** vai ar **Importēt…** ielādējiet scenāriju, ko kāds ir kopīgojis. Katram saglabātajam scenārijam ir pogas **Rediģēt**, **Eksportēt**, **Pārdēvēt** un **Dzēst**; šeit veiktās izmaiņas tiek saglabātas uzreiz. Redaktoram ir divas cilnes — vizuālais **Veidotājs** un neapstrādāts **JSON**. Saglabājot viss tiek pārbaudīts, un lietotne norāda, kurš lauks ir nepareizs. CLI redaktora nav, taču tajā scenārijus var importēt, eksportēt, apskatīt un simulēt (skatiet [CLI komandas](#cli-komandas)).

**Piešķiršana.** Scenārijs neko nedara, kamēr to neizpilda kāds izaicinājums. Izvēlieties to izaicinājuma ⚙️ uzstādījumos laukā **Scenārijs** vai piešķiriet to uzreiz daudziem izaicinājumiem ar [izaicinājumu noteikumu](#izaicinājumu-noteikumi) vai profilu (piemēram, visiem `exhibition` izaicinājumiem). CLI: `set-setting scenario "<nosaukums>" --challenge=<id>`. Pēc tam izaicinājuma kartītē redzama 🧭 rinda ar scenāriju, tā pašreizējo fāzi, nākamās pārbaudes laiku un pēdējo problēmu, ja tāda bijusi.

**Kā scenārijs ir veidots.**

- **Fāzes.** Scenārijam ir viena vai vairākas fāzes ar nosaukumiem, un tas sākas jūsu izvēlētajā fāzē. Kamēr izaicinājums ir kādā fāzē, uz to attiecas šīs fāzes **uzstādījumi** (jebkurš izaicinājuma uzstādījums — redzamība, automātiska Boost izmantošana, automātiskā iesniegšana, …). Tiem ir priekšroka pār visu pārējo, arī pār jūsu manuālo ⚙️ pielāgojumu, un, tiklīdz izaicinājums iziet no fāzes, atkal ir spēkā parastie uzstādījumi. Jūsu saglabātajos pielāgojumos nekas netiek kopēts.
- **Noteikumi.** Katrai fāzei ir sakārtots noteikumu saraksts. Katrā balsošanas ciklā **pirmais noteikums, kura visi nosacījumi izpildās**, pēc kārtas izpilda savas darbības. Noteikuma lauks **Izpilda** nosaka, cik bieži: _katrā palaišanā, kamēr izpildās_, _tikai vienreiz_, _vienreiz katrā fāzes sākumā_ vai _vienreiz dienā_.
- **Nosacījumi** — diennakts laiks (lietotnes laika joslā), laiks līdz beigām, laiks kopš sākuma, pagājusī izaicinājuma daļa, laiks šajā fāzē, iesniegumu skaits, brīvās vietas, redzamība, jūsu vieta reitingā un balsis izaicinājumā, Boost / Turbo stāvoklis, jūsu atslēgu / apmaiņu / uzpilžu / monētu atlikums, vai ir atcerēts kāds foto, un pārbaude vienam iesniegumam (tā balsis, vieta reitingā, **balsis stundā**, **ātruma attiecība** pret jūsu pārējiem iesniegumiem, vai tam izmantots Boost / Turbo). Kombinējiet tos ar _visi no_, _jebkurš no_ un _ne_.
- **Kurš iesniegums.** Darbības un iesniegumu pārbaudes izvēlas iesniegumu pēc tā vietas izaicinājumā, pēc lielākā / mazākā balsu skaita, pēc labākās / sliktākās vietas reitingā, pēc ātruma (balsis stundā), izvēlas to, kuram izmantots Boost vai Turbo, vai iepriekš atcerētu foto — pēc izvēles izlaižot iesniegumus ar Boost / Turbo.
- **Darbības** — iesniegt foto (jūsu labāko atbilstošo vai atcerēto), apmainīt iesniegumu pret citu foto (balsis, Boost un Turbo paliek pie foto), izmantot Boost, izmantot Turbo, atbloķēt Boost ar atslēgu, uzpildīt redzamību, balsot līdz noteiktam procentam, atcerēties / aizmirst foto, pāriet uz citu fāzi un **paziņot** jums ar ziņojumu.
- **Atmiņa.** Noteikums var atcerēties foto ar nosaukumu (piemēram, `held`), un kāds vēlāks noteikums — pat pēc vairākām dienām, citā fāzē — var to apmainīt atpakaļ vai izmantot tam Boost.

Pilnu sarakstu ar visiem laukiem parāda CLI komanda `scenario-vocabulary`.

**Var droši atstāt darbībā.**

- Pirms katras darbības izaicinājums tiek nolasīts no jauna, tāpēc darbība, kuras mērķa vairs nav, tiek izlaista, nevis izpildīta uz labu laimi.
- Progress tiek saglabāts pēc katras darbības. Ja lietotne avarē vai tiek restartēta, daļēji izpildīts noteikums turpina no vietas, kur apstājās, un nekad neatkārto jau notikušu tēriņu.
- Tēriņos tiek ievērotas jūsu valūtas rezerves un paša scenārija neobligātie **tēriņu limiti** (apmaiņas / atslēgas / uzpildes).
- Ja scenārija saglabāto progresu nevar nolasīt vai, rediģējot scenāriju, noņemat fāzi vai noteikumu, kura izpildes vidū tas bija, izaicinājums **apstājas** un jums par to paziņo (brīdinājums kartītē un paziņojums). Pats no sevis tas nekad nesāk no jauna. Izlabojiet scenāriju vai sāciet to no jauna ar CLI komandu `scenario-reset --challenge=<id>`.
- Balsošanas ātruma nosacījumiem vajadzīga vismaz 10 minūšu balsu vēsture. Līdz tam tie netiek uzskatīti par izpildītiem.

**Izmēģiniet, pirms kaut kas tiek iztērēts.** Veidotājā izvēlieties izaicinājumu un noklikšķiniet uz **Simulēt**, lai redzētu "kas būtu, ja" laika grafiku līdz izaicinājuma beigām: kas tiktu izpildīts, kad un kāpēc tas apstājas. Tas darbojas arī ar nesaglabātām izmaiņām. Simulācija pieņem, ka katrs solis izdodas un ka balsis un vieta reitingā paliek tādas pašas kā tagad. CLI komanda `scenario-dry-run` parāda, kas notiktu tieši tagad, bet `scenario-simulate` — visu laika grafiku; neviena no tām neko netērē.

**Šabloni**, ar ko sākt: _Exhibition double-dip_, _Evening boost before the last day_, _Morning swap of the weakest entry_ un _Turbo in the top 10_. Pievienojiet kopiju un pēc tam rediģējiet to.

Minimāls scenārijs JSON formātā — izmantot Boost iesniegumam ar labāko vietu reitingā laikā no 20:00 līdz 21:00, kad līdz izaicinājuma beigām atlikušas 1–2 dienas:

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

Ilgumu norāda kā `"90m"`, `"6h"`, `"1d 6h"` vai sekundēs. Importējiet scenāriju failus tikai no cilvēkiem, kuriem uzticaties: scenārijs var tērēt jūsu apmaiņas, atslēgas, uzpildes un Boost. Pirms kaut kas tiek saglabāts, importa priekšskatījumā redzamas visas darbības, kas tērē resursus.

**Paziņojumi.** Darbība `notify`, kā arī scenārijs, kas apstājas, jo tam vajadzīga jūsu iejaukšanās, parāda paziņojumu darbvirsmas lietotnē un `gurucli start` režīmā (to var izslēgt ar **Paziņojumi no scenārijiem**). Android lietotne scenāriju paziņojumus nerāda. Scenāriji tur tomēr darbojas, arī fona pakalpojumā.

### Konta atlikums

Jūsu valūtu atlikumi — **atslēgas / apmaiņas / uzpildes / monētas** — redzami grafiskās lietotnes galvenē blakus laika atskaitei (ja atlikumu neizdodas iegūt, tur redzams `—`, nevis `0`, lai neizdevusies nolasīšana netiktu sajaukta ar "nav nekā"). CLI tos izdrukā komanda `bankroll` (sinonīms `coins`).

## 🎛️ Uzstādījumu apraksts

Uzstādījumi ir divos līmeņos. **Lietotnes uzstādījumi** ir kopīgi visai lietotnei. **Izaicinājumu uzstādījumiem** ir globāla noklusējuma vērtība, ko var **pielāgot katram izaicinājumam** (grafiskās lietotnes ⚙️ logā vai ar CLI karodziņu `--challenge`); spēkā ir izaicinājuma pielāgojums, ja tāds ir, citādi — globālā noklusējuma vērtība.

### Lietotnes uzstādījumi

| Uzstādījums                               | Noklusējums   | Diapazons / vērtības | Piezīmes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`                                   | `light`       | `light`, `dark`      | Saskarnes tēma.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `language`                                | `en`          | `en`, `lv`           | Saskarnes valoda (angļu / latviešu); pārslēdzas uzreiz.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `timezone`                                | `Europe/Riga` | jebkura IANA josla   | Laika josla, kurā rādīt izaicinājumu laikus (`customTimezones` glabā pievienotās joslas).                                                                                                                                                                                                                                                                                                                                                                            |
| `stayLoggedIn`                            | `false`       | bool                 | Saglabāt tokenu starp palaišanām. Ja izslēgts, tokens tiek izdzēsts, kad lietotne beidz darbu (aizverot grafisko lietotni vai apturot CLI ar Ctrl+C **vai `SIGTERM`**), tāpēc nākamajā palaišanā būs jāpiesakās vēlreiz. Ievērojiet `SIGTERM` gadījumu: `gurucli start`, kas darbojas systemd/Docker vidē, katrā restartā zaudē pieteikšanos, ja vien šo uzstādījumu **neieslēdzat**. Android netiek izmantots, jo tur nav uzticama brīža, kad lietotne beidz darbu. |
| `apiTimeout`                              | `30`          | 1–120 s              | API pieprasījuma gaidīšanas laiks.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `checkFrequencyMin` / `checkFrequencyMax` | `3` / `3`     | 1–60 min             | Nejauša pauze starp cikliem, izvēlēta no `[min, max]`. Vienādas vērtības = fiksēts intervāls.                                                                                                                                                                                                                                                                                                                                                                        |
| `apiMaxRetries`                           | `3`           | 0–10                 | Atkārtoti mēģinājumi pārejošu kļūmju gadījumā (tīkla kļūda, pārsniegts gaidīšanas laiks, 429, 5xx). `0` tos izslēdz.                                                                                                                                                                                                                                                                                                                                                 |
| `apiRetryBaseDelayMs`                     | `1000`        | 100–10000 ms         | Bāzes aizture eksponenciāli pieaugošajām pauzēm starp mēģinājumiem.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `windowBounds`                            | —             | —                    | Grafiskās lietotnes loga pozīcija/izmērs (Electron); saglabājas automātiski.                                                                                                                                                                                                                                                                                                                                                                                         |

**Paziņojumi** (darbvirsmas lietotne un `gurucli start`; tikai globāli — norāda ar `set-global-default`)

| Uzstādījums             | Noklusējums | Diapazons / vērtības | Apraksts                                                                                      |
| ----------------------- | ----------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `notifyOnScenario`      | `true`      | bool                 | Rāda ziņojumus, ko sūta jūsu scenāriju `notify` soļi, un brīdinājumu, kad scenārijs apstājas. |
| `notifyOnBoost`         | `false`     | bool                 | Brīdina, pirms tiek izmantots Boost, lai jūs varētu atstāt lietotni darbībā.                  |
| `notifyOnTurbo`         | `false`     | bool                 | Brīdina pirms Turbo minispēles.                                                               |
| `notifyOnAutoFill`      | `false`     | bool                 | Brīdina, pirms tuvu termiņa beigām tiek automātiski iesniegts foto.                           |
| `notifyOnEmergencyFill` | `false`     | bool                 | Brīdina pirms pēdējā brīža ārkārtas iesniegšanas.                                             |
| `notifyLeadTime`        | `5`         | 1–60 min             | Cik minūtes pirms darbības parādīt brīdinājumu.                                               |

**Misijas** (tikai globāli — norāda ar `set-global-default`; skatiet [Misijas](#misijas))

| Uzstādījums         | Noklusējums | Diapazons / vērtības | Apraksts                                                                                                                 |
| ------------------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `missionSaveTurbos` | `false`     | bool                 | Atliek Turbo iegūšanu, līdz ir aktīva "Win Turbo" misija vai līdz Turbo izmantošanas laikam atlikusi stunda.             |
| `missionJoinEarly`  | `false`     | bool                 | "Join challenges" vai "Win Turbo" misijas laikā pievienojas automātiski, negaidot noteikto laiku, līdz misija izpildīta. |
| `missionUseFills`   | `false`     | bool                 | "Use Fill" misijas laikā izmanto uzpildes izaicinājumos, kuros redzamība ir zem 100 %, līdz misija izpildīta.            |

### Izaicinājumu uzstādījumi

Visus šos uzstādījumus var pielāgot katram izaicinājumam, ja vien nav norādīts citādi.

**Vispārīgi**

| Uzstādījums      | Noklusējums | Diapazons / vērtības                        | Apraksts                                                                                                                                                                                                                                                    |
| ---------------- | ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exposure`       | `100`       | 1–100 %                                     | Parastā noteikuma slieksnis: balsot, kamēr jūsu redzamība ir zem šīs vērtības.                                                                                                                                                                              |
| `exposureTarget` | `0`         | `0` vai 1–100 % (ja norādīts, ≥ `exposure`) | Līdz kuram % balsot, kad izpildās parastais noteikums. `0` = apstāties pie sliekšņa.                                                                                                                                                                        |
| `onlyBoost`      | `false`     | bool                                        | Izlaist parasto balsošanu; tikai izmantot Boost/Turbo.                                                                                                                                                                                                      |
| `scenario`       | `''`        | saglabāta scenārija nosaukums vai tukšs     | [Scenārijs](#scenāriji), ko izpilda šis izaicinājums. Tukšs = nav. Norāda katram izaicinājumam vai ar izaicinājumu noteikumu vai profilu (globālās noklusējuma vērtības tam nav).                                                                           |
| `voteOnNewEntry` | `false`     | bool                                        | Kad parādās jauns foto, nobalsot vienu reizi, pat ja redzamība jau sasniedz vai pārsniedz slieksni, līdz mērķim, ko nosaka spēkā esošais noteikums. Neapiet uzstādījumus Tikai Boost režīms, Balsot tikai pēdējās minūtes laikā un Tikai plānotā balsošana. |

**Boost**

| Uzstādījums              | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                              |
| ------------------------ | ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoBoost`              | `true`        | bool                 | Automātiski izmantot Boost tuvu termiņa beigām.                                                                                                                                                                                                                       |
| `boostTime`              | `3600` s (1h) | ≥ 0                  | Izmantot Boost ar laika atskaiti, kad **pašā Boost logā** atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada stundās un minūtēs (h+m).                                                                                                                   |
| `keyUnlockedBoostTime`   | `900` s (15m) | ≥ 0                  | Atsevišķs logs **ar atslēgu atbloķētam** Boost, kuram nav savas laika atskaites; to mēra līdz izaicinājuma beigām. `boostTime` uz šādu Boost neattiecas. `0` = nekad neizmantot automātiski. Grafiskajā lietotnē ievada stundās un minūtēs (h+m).                     |
| `boostImageIndex`        | `1`           | `0`–`4`              | Foto vieta, kurai izmantot Boost (1 = pirmā, `0` = pēdējā; izaicinājumā var būt ne vairāk kā 4 foto). Ja šai vietai jau izmantots Turbo, tiek ņemta iepriekšējā vieta.                                                                                                |
| `boostFreshEntryWait`    | `180` s (3m)  | ≥ 0                  | Aizturēt paredzēto Boost, līdz foto, kuram tas paredzēts, ir bijis izaicinājumā tik ilgi. Nekad neaiztur ilgāk par paša Boost termiņu. `0` = izmantot Boost uzreiz. Grafiskajā lietotnē ievada stundās un minūtēs (h+m).                                              |
| `boostFillNew`           | `false`       | bool                 | Iesniegt jaunu foto un izmantot tam Boost, kad pagājis `boostFreshEntryWait`.                                                                                                                                                                                         |
| `boostFillNewOnConflict` | `false`       | bool                 | Iesniegt jaunu foto un izmantot tam Boost tikai tad, ja vienīgajam esošajam foto jau izmantots Turbo (tur Boost izmantot nevar). Ja nav brīvas vietas vai piemērota foto, Boost tiek izlaists (rezerves varianta nav). Netiek ņemts vērā, ja ieslēgts `boostFillNew`. |

**Turbo**

| Uzstādījums              | Noklusējums   | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                              |
| ------------------------ | ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useTurbo`               | `false`       | bool                 | Automātiski izmantot iegūto Turbo pirms termiņa beigām.                                                                                                                                                                                                               |
| `autoTurbo`              | `true`        | bool                 | Automātiski spēlēt minispēli, lai iegūtu Turbo, ja jums tā nav.                                                                                                                                                                                                       |
| `turboTime`              | `7200` s (2h) | ≥ 0                  | Izmantot Turbo, kad atlicis tik daudz laika (vai mazāk). Grafiskajā lietotnē ievada stundās un minūtēs (h+m).                                                                                                                                                         |
| `turboImageIndex`        | `1`           | `0`–`4`              | Foto vieta, kurai izmantot Turbo (1 = pirmā, `0` = pēdējā; izaicinājumā var būt ne vairāk kā 4 foto). Ja šai vietai jau izmantots Boost, tiek ņemta iepriekšējā vieta.                                                                                                |
| `turboFillNew`           | `false`       | bool                 | Iesniegt jaunu foto un uzreiz izmantot tam Turbo.                                                                                                                                                                                                                     |
| `turboFillNewOnConflict` | `false`       | bool                 | Iesniegt jaunu foto un izmantot tam Turbo tikai tad, ja vienīgajam esošajam foto jau izmantots Boost (tur Turbo izmantot nevar). Ja nav brīvas vietas vai piemērota foto, Turbo tiek izlaists (rezerves varianta nav). Netiek ņemts vērā, ja ieslēgts `turboFillNew`. |

**Beigu logs**

| Uzstādījums                    | Noklusējums | Diapazons / vērtības                                   | Apraksts                                                                                                                                                                                                          |
| ------------------------------ | ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useFinalWindowExposure`       | `false`     | bool                                                   | Beigu logā izmantot atsevišķu redzamības noteikumu.                                                                                                                                                               |
| `finalWindowDuration`          | `3600`      | 60 s – 30 d (glabā sekundēs)                           | Beigu loga garums pirms beigām. Pēc noklusējuma 1 stunda.                                                                                                                                                         |
| `finalWindowExposure`          | `100`       | 1–100 % (≤ `exposure`)                                 | Slieksnis beigu logā.                                                                                                                                                                                             |
| `finalWindowExposureTarget`    | `0`         | `0` vai 1–100 % (ja norādīts, ≥ `finalWindowExposure`) | Līdz kuram % balsot beigu logā. `0` = apstāties pie sliekšņa.                                                                                                                                                     |
| `voteBeforeFinalWindow`        | `false`     | bool                                                   | Papildināt redzamību līdz **parastajam** mērķim laika logā ap beigu loga sākumu, lai samazinājusies redzamība nepaliktu nepapildināta zemākā beigu loga sliekšņa dēļ. Darbojas tikai ar `useFinalWindowExposure`. |
| `voteBeforeFinalWindowLeadMin` | `15`        | 1–59 min                                               | Papildināšanas loga pusplatums (minūtēs) uz katru pusi no beigu loga sākuma.                                                                                                                                      |

**Pēdējā minūte**

| Uzstādījums                | Noklusējums | Diapazons / vērtības | Apraksts                                                                                                     |
| -------------------------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `voteOnlyInLastMinute`     | `false`     | bool                 | Balsot tikai pēdējās minūtes logā (loga garums = `lastMinuteThreshold`, nevis burtiski viena minūte).        |
| `lastMinuteThreshold`      | `10`        | 1–59 min             | Logs pirms beigām, kurā lietotne balso līdz 100 % neatkarīgi no redzamības griestiem.                        |
| `lastMinuteCheckFrequency` | `1`         | 1–59 min             | **Tikai globāls (nevar pielāgot izaicinājumam).** Plānotāja intervāls, kamēr kāds izaicinājums ir savā logā. |

**Automātiskā iesniegšana**

| Uzstādījums           | Noklusējums         | Diapazons / vērtības | Apraksts                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoFill`            | `false`             | bool                 | Tuvu termiņa beigām iesniegt foto tukšajās vietās (pakāpeniski, pa vienam katrā ciklā).                                                                                                                                                                                                                                                                                                        |
| `autoFillSchedule`    | 2@30m, 3@20m, 4@10m | foto 2–4             | `{count, seconds}` rindas: kad atlicis ≤ `seconds`, jābūt ≥ `count` foto. Tikai foto 2–4; izlaidiet foto rindu (vai grafiskajā lietotnē norādiet 0h 0m), lai to nekad neplānotu. Ja izaicinājumā var iesniegt mazāk foto, grafiks tiek pārbīdīts uz beigām (izaicinājuma pēdējais foto izmanto pēdējās rindas laiku). Aizstāj `autoFillIntervalMinutes` (pārveido automātiski).                |
| `fillWithoutTagMatch` | `true`              | bool                 | Ja obligātie tagi norādīti, bet nevienam foto nav visu šo tagu: iesniegt tik un tā (`true`) vai atstāt vietu tukšu (`false`).                                                                                                                                                                                                                                                                  |
| `emergencyFill`       | `300` s (5m)        | ≥ 0                  | Ārkārtas iesniegšana — pēdējo minūšu drošības tīkls: iesniegt foto atlikušajās vietās, pat ja noteikumi vēl gaidītu, neņemot vērā obligātos tagus; izmanto arī jebkuru pieejamu Boost/iegūtu Turbo, pat ja `autoBoost`/`useTurbo` ir izslēgti. `0` = izslēgts (izslēdz arī Boost/Turbo izņēmumu). Vērtībai jābūt ≤ `lastMinuteThreshold`. Grafiskajā lietotnē ievada stundās un minūtēs (h+m). |
| `mustIncludeTags`     | `[]`                | līdz 50 tagiem       | Stingrs filtrs: iesniegt tikai foto, kuriem ir visi šie tagi.                                                                                                                                                                                                                                                                                                                                  |
| `shouldIncludeTags`   | `[]`                | līdz 50 tagiem       | Vēlamie tagi: dot priekšroku foto ar šiem tagiem, bet neizslēgt citus.                                                                                                                                                                                                                                                                                                                         |

**Automātiskā pievienošanās**

| Uzstādījums                   | Noklusējums | Diapazons / vērtības        | Apraksts                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoJoin`                    | `false`     | bool                        | Ieslēgt automātisko pievienošanos. Ja ieslēgta, pēc noklusējuma lietotne pievienojas **visiem** atvērtajiem izaicinājumiem. [Izaicinājumu noteikums](#izaicinājumu-noteikumi) var to ieslēgt (vai izslēgt) izaicinājumiem, kuriem tas atbilst, pat ja galvenā noklusējuma vērtība ir izslēgta. |
| `autoJoinTypes`               | `''`        | veidi, atdalīti ar komatiem | Tvērums: **iekļaut** tikai šos izaicinājumu veidus, piemēram, `flash,contest`. **Tukšs = visi veidi** (noklusējums). Reģistrs netiek ņemts vērā; atstarpes ap komatiem tiek ignorētas.                                                                                                         |
| `autoJoinExcludeTypes`        | `''`        | veidi, atdalīti ar komatiem | **Nekad** nepievienoties šiem veidiem, piemēram, `flash,exhibition`. Atņem tos no noklusējuma tvēruma (visi veidi), tāpēc jau ar šo vien iegūstat "pievienoties visiem, izņemot šos". Izaicinājumiem, kuriem pievienošanos ieslēdz noteikums, lietotne pievienojas joprojām.                   |
| `autoJoinMaxCoins`            | `0`         | ≥ 0 (0 = izslēgts)          | Lielākais monētu skaits, ko tērēt, pievienojoties **vienam** maksas izaicinājumam. `0` = tikai bezmaksas izaicinājumi.                                                                                                                                                                         |
| `autoJoinCycleCoinBudget`     | `0`         | ≥ 0 (0 = izslēgts)          | Kopējais monētu skaits, ko pievienošanās solis drīkst iztērēt **vienā ciklā** (globāls). `0` = maksas pievienošanās nenotiek. Lai pievienotos maksas izaicinājumiem, **gan** šai vērtībai, gan `autoJoinMaxCoins` jābūt > 0.                                                                   |
| `autoJoinWithinHoursOfEnd`    | `0`         | 0–720 h (0 = izslēgts)      | Pievienoties izaicinājumam tikai tad, kad līdz tā beigām atlicis ne vairāk kā šis stundu skaits. `0` = pievienoties, tiklīdz izaicinājums atrasts.                                                                                                                                             |
| `autoJoinAfterPercentElapsed` | `0`         | 0–99 % (0 = izslēgts)       | Pievienoties izaicinājumam tikai tad, kad pagājusi šī daļa no tā ilguma. Ja vērtība ir lielāka par 0, tā aizstāj stundu logu.                                                                                                                                                                  |

**Attēlojums**

| Uzstādījums          | Noklusējums | Diapazons / vērtības | Apraksts                                                                                                                                                                                           |
| -------------------- | ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compactCards`       | `false`     | bool                 | Kompakts izaicinājumu kartīšu izkārtojums (tikai grafiskās lietotnes attēlojums).                                                                                                                  |
| `compactCardActions` | `false`     | bool                 | Rādīt izaicinājuma līmeņa darbību pogas (balsošana, palaišana, Turbo iegūšana, iesniegšana, valūtas tēriņi, uzstādījumi) arī kompaktajās kartītēs (tikai grafiskās lietotnes attēlojums, globāls). |

## 📐 Ieteicamie uzstādījumi

**Maksimāla redzamība visur** — pacelt katru aktīvo izaicinājumu līdz augšai.
`exposure` 100, `lastMinuteThreshold` 30, pārbaudes biežums 3 min, `onlyBoost` izslēgts, `voteOnlyInLastMinute` izslēgts. Palaidiet automātisko balsošanu un ļaujiet tai darboties.

**Taupīt balsis, rīkoties vēlu** — balsot tikai pēdējās minūtēs.
`exposure` 90, `lastMinuteThreshold` 15, `voteOnlyInLastMinute` ieslēgts. Lietotne gaida, līdz izaicinājums sasniedz savu logu, un tad balso līdz 100 %.

**Tikai Boost** — tērēt Boost, bet ne balsis (piemēram, mazāk svarīgos izaicinājumos).
`onlyBoost` ieslēgts, `boostTime` 7200 (2h), pārbaudes biežums 10 min.

**Pielāgošana katram izaicinājumam** — norādiet saprātīgas globālās noklusējuma vērtības, pēc tam atveriet izaicinājuma **⚙️** (grafiskajā lietotnē) vai izmantojiet `set-setting <key> <value> --challenge=<id>` (CLI), lai mainītu tikai tos uzstādījumus, kas šim izaicinājumam ir svarīgi.

## 📝 Žurnālfaili

Žurnālfaili palīdz risināt problēmas un tiek glabāti kopā ar jūsu uzstādījumiem:

- **macOS:** `~/Library/Application Support/gurushots-auto-vote/logs/`
- **Windows:** `%APPDATA%\gurushots-auto-vote\logs\`
- **Linux:** `~/.config/gurushots-auto-vote/logs/`

Katru dienu tiek sākts jauns fails (`<tips>-YYYY-MM-DD.log`), un vecie faili tiek automātiski dzēsti pēc vecuma un izmēra — palaišanas brīdī un darbības laikā ik stundu:

| Fails        | Saturs                                                         | Glabāšanas laiks | Maks. izmērs |
| ------------ | -------------------------------------------------------------- | ---------------- | ------------ |
| `errors-*`   | Kļūdas no visām kategorijām                                    | 30 dienas        | 10 MB        |
| `app-*`      | Lietotnes vispārējā darbība                                    | 7 dienas         | 50 MB        |
| `settings-*` | Uzstādījumu nolasīšana/saglabāšana                             | 7 dienas         | 10 MB        |
| `api-*`      | API pieprasījumi/atbildes (tikai pirmkoda/izstrādes būvējumos) | 1 diena          | 20 MB        |

CLI jebkuru no tiem var apskatīt ar `logs [--error|--api|--settings] [--lines=<n>]`. Akreditācijas dati tiek aizklāti, pirms kaut kas tiek ierakstīts diskā.

Vizuālā pārbaude raksta žurnālā kategorijā `autoFill`: `Visual check reordered picks for [Challenge …]`, ja tā mainīja iesniedzamo foto, un `Visual check unavailable for [Challenge …]`, ja modeli neizdevās palaist (tad tika izmantota tagu ranžēšana). Ja šādas rindas nav, pārbaude piekrita ranžēšanai vai atturējās.

## 🔍 Problēmu risināšana

**"No authentication token found" / "Token expired"** — piesakieties vēlreiz pieteikšanās ekrānā (CLI: palaidiet `login`). Tokeni ir piesaistīti jūsu kontam; ja tas atkārtojas, pārbaudiet sistēmas pulksteni.

**"Network Error"** — pārbaudiet interneta savienojumu un ugunsmūri, palieliniet `apiTimeout` (mēģiniet 60–120 s) un mēģiniet vēlāk; GuruShots var būt īslaicīgi nepieejams.

**"API Rate Limit Exceeded" / "Too Many Requests"** — apturiet **visus** eksemplārus (grafisko lietotni un CLI), pagaidiet 5–10 minūtes un pārliecinieties, ka darbojas tikai viens.

**Automātiskā balsošana darbojas, bet nekas nenotiek** — pārbaudiet, vai jums ir aktīvi izaicinājumi, vai jūsu redzamība jau nav sasniegusi slieksni (pēc noklusējuma 100 %) un vai nav ieslēgts `voteOnlyInLastMinute`, kamēr izaicinājumi vēl ir ārpus pēdējās minūtes loga. Žurnālfailos redzams, kāpēc katrs izaicinājums izlaists.

**Automātiskā iesniegšana izvēlējās tematam neatbilstošu foto** — vizuālā pārbaude izvēlas tikai starp 12 augstākajiem kandidātiem, ko atrada tagu meklēšana, tāpēc, ja nevienā no tiem temats nav redzams, tā nevar palīdzēt. Pievienojiet šim izaicinājumam `mustIncludeTags`/`shouldIncludeTags` (vai [izaicinājumu noteikumu](#izaicinājumu-noteikumi)), lai sarakstā nonāktu labāki kandidāti. Žurnāla rinda `Visual check unavailable` nozīmē, ka attēlu atpazīšanas modeli neizdevās ielādēt vai palaist; CLI modeli izpako pirmajā lietošanas reizē (skatiet [Instalācija katrai platformai](../README.lv.md#instalācija-katrai-platformai)), tāpēc pārbaudiet, vai diskā ir brīva vieta.

**Logs atveras ārpus ekrāna** — restartējiet lietotni; CLI palaidiet `reset-windows`.

**Palaižot lietotni, šķiet, ka nekas nenotiek (logs neparādās)** — iespējams, joprojām darbojas vecs vai sastindzis eksemplārs; otrā palaišana nodod vadību tam un beidz darbu. Aizveriet vai piespiedu kārtā apturiet veco procesu (Activity Monitor / `pkill -f GuruShotsAutoVote`) un palaidiet lietotni vēlreiz.

**Android: balsošana fonā apstājas** — lietotnes akumulatora lietojumam norādiet **Neierobežots** un pievienojiet lietotni izņēmumiem sava ražotāja akumulatora pārvaldniekā; Android 12 piešķiriet precīzo modinātāju (exact alarm) atļauju, lai darbotos pēdējās minūtes 1 minūtes pārbaužu intervāls.

Ja problēmu joprojām neizdodas atrisināt, pārbaudiet žurnālfailus un [izveidojiet problēmas pieteikumu](https://github.com/isthisgitlab/gurushots-auto-vote/issues), norādot savu versiju, operētājsistēmu, problēmas aprakstu, tās atkārtošanas soļus un attiecīgus žurnālfailu fragmentus (bez akreditācijas datiem).
