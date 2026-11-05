# GuruShots Auto Voter — Vietnes privātums

[← Sākums](../README.lv.md) · [English](privacy.md)

Šī lapa attiecas tikai uz **tīmekļa vietni**. Darbvirsmas, CLI un Android lietotne ir atsevišķi: ko tās sūta un glabā, aprakstīts sadaļās [Drošība](../README.lv.md#-drošība) un [Kur tiek glabāti jūsu dati](usage.lv.md#️-kur-tiek-glabāti-jūsu-dati--kā-tos-dzēst).

## Mitināšana

Vietne tiek mitināta **GitHub Pages**. GitHub piegādā katru lapu un var reģistrēt apmeklētāju IP adreses un citus pieprasījuma datus. Kā GitHub tos apstrādā, aprakstīts [GitHub privātuma paziņojumā](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Projektam šie žurnāli nav pieejami.

## Ko vietne nedara

- Tā **neiestata sīkdatnes**.
- Tā **neizmanto analītiku, izsekotājus vai reklāmu**.
- Lapas, stili, skripti, logotips un nozīmītes nāk no šīs vietnes, bez trešo pušu fontiem, attēliem vai skriptiem — ar vienu izņēmumu: **attālinātās vadības lapa** (`/remote/`, tikai atverot savienošanas saiti) veido savienojumu ar publiskajiem Nostr retranslatoriem, pa kuriem notiek savienošana (`wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`, `wss://nostr.oxtr.dev`), un STUN serveriem (`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`). Retranslatori redz šifrētu signālu apmaiņu un telefona IP adresi. Ja tiešs savienojums nav iespējams, tie pārraida arī lietotnes pašas ziņojumus, šifrētus ar savienošanas atslēgu: tie redz to laiku un aptuvenos izmērus, patur tos vismaz neilgu laiku, un jebkurš retranslators tos var ierakstīt. Ikviens, kas tos ir ierakstījis un vēlāk iegūst jūsu savienošanas saiti, var tos atšifrēt; līdzeklis ir **Atiestatīt savienošanu pārī**. Signālu apmaiņu un šos ziņojumus paraksta viena un tā pati publiskā atslēga, tāpēc retranslatori var tos saistīt, un telefons klausās līdz 3 retranslatoriem, tāpēc var lejupielādēt katru ziņojumu līdz 3 reizēm; lietotne to apstrādā vienu reizi. Dators klausās visus retranslatorus. Savienotais dators redz telefona IP. Lapa nekad nesūta savienošanas atslēgu retranslatoriem atklātā tekstā — tā tiek lietota kā šifrēšanas parole. Pilnā saite nav tikai datorā redzamajā QR kodā: tā paliek arī starpliktuvē pēc darbības **Kopēt saiti**, grāmatzīmēs un sākuma ekrāna ikonā, cilnes sesijas krātuvē, pārlūka vēsturē (ko pārlūks var sinhronizēt ar jūsu kontu) un QR skenera vēsturē.
- Tā lūdz pārlūkus **nesūtīt atsauces adresi** (referrer), tāpēc, atverot saiti uz citu vietni, tai netiek paziņots, no kuras lapas atnācāt.

## Kas paliek jūsu pārlūkā

Vietnes lapās tikai tad, ja noklikšķināt uz gaišās/tumšās **tēmas pārslēdzēja**, vietne saglabā jūsu izvēli (`theme`: `light` vai `dark`) pārlūka lokālajā krātuvē, lai nākamā lapa atvērtos tajā pašā tēmā. Kamēr neesat nospieduši pārslēdzēju, šīs lapas seko jūsu sistēmas tēmai un neko nesaglabā. Ja pārlūkā notīrāt vietnes datus, izvēle tiek izdzēsta. Attālinātās vadības lapa (`/remote/`) aplūkota tālāk.

Ja atverat **attālinātās vadības savienošanas saiti**, savienošanas atslēga tiek saglabāta šīs cilnes sesijas krātuvē (pazūd, aizverot cilni), un paliek pašā saitē — tāpēc grāmatzīme vai sākuma ekrāna ikona turpina strādāt. Vietne nevienu no šīm kopijām nekur nesūta; atslēga ceļo tikai caur šifrēto savienojumu uz jūsu pašu datoru. Lai to noņemtu, izdzēsiet grāmatzīmi vai sākuma ekrāna ikonu.

**Attālinātās vadības lapa** (`/remote/`) papildus saglabā šos ierakstus, un tikai tad, ja atverat savienošanas saiti:

- Lokālajā krātuvē, līdz pārlūkā notīrāt vietnes datus (grāmatzīmes vai sākuma ekrāna ikonas izdzēšana tos nenoņem):
    - `gs-remote-view-prefs` — lapas tēma, valoda un kompaktais skats, arī atsevišķu izaicinājumu kompakto kartīšu izvēles. Tie paliek jūsu telefonā un netiek sūtīti uz datoru.
    - `gs-remote-link-version` — īss kods, kas iegūts no savienošanas kanāla identifikatora, un saites versija, ko izmanto darbvirsmas lietotne (neliels skaitlis, piemēram, 1), lai lapa varētu uzreiz atvērt šīs versijas lapu. Savienošanas atslēgu tas nekad nesatur. Lapa to izdzēš arī tad, kad tas vairs neder, piemēram, kad atverat citu savienošanas saiti, un to izdzēš Android lietotnes poga **Atvienoties**. Lapa izdzēš arī `gs-remote-desktop-version` — atslēgu, ko raksta versijas 1.15.0 lapa.
- Sesijas krātuvē, līdz aizverat cilni:
    - `gs-remote-skipped-to` — saites versija, uz kuru cilne jau pārgāja uzreiz, lai lapa nepārlēkātu starp divām lapām.
    - `remote-add-home-hint` — karodziņš, lai ieteikumu pievienot lapu sākuma ekrānam piedāvātu vienu reizi cilnē.

## Saites uz citām vietnēm

Saites uz GitHub un citām vietnēm ir parastas saites: pēc to atvēršanas attiecas attiecīgās vietnes pašas noteikumi.

## Kontakti

Jautājumi par šo lapu vai vietni: [izveidojiet problēmas pieteikumu](https://github.com/isthisgitlab/gurushots-auto-vote/issues) (pieteikumi ir publiski) vai izmantojiet kontaktinformāciju profilā [github.com/isthisgitlab](https://github.com/isthisgitlab).
