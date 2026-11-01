# GuruShots Auto Voter — Vietnes privātums

[← Sākums](../README.lv.md) · [English](privacy.md)

Šī lapa attiecas tikai uz **tīmekļa vietni**. Darbvirsmas, CLI un Android lietotne ir atsevišķi: ko tās sūta un glabā, aprakstīts sadaļās [Drošība](../README.lv.md#-drošība) un [Kur tiek glabāti jūsu dati](usage.lv.md#️-kur-tiek-glabāti-jūsu-dati--kā-tos-dzēst).

## Mitināšana

Vietne tiek mitināta **GitHub Pages**. GitHub piegādā katru lapu un var reģistrēt apmeklētāju IP adreses un citus pieprasījuma datus. Kā GitHub tos apstrādā, aprakstīts [GitHub privātuma paziņojumā](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Projektam šie žurnāli nav pieejami.

## Ko vietne nedara

- Tā **neiestata sīkdatnes**.
- Tā **neizmanto analītiku, izsekotājus vai reklāmu**.
- Lapas, stili, skripti, logotips un nozīmītes nāk no šīs vietnes, bez trešo pušu fontiem, attēliem vai skriptiem — ar vienu izņēmumu: **attālinātās vadības lapa** (`/remote/`, tikai atverot savienošanas saiti) veido savienojumu ar publiskajiem Nostr retranslatoriem, pa kuriem notiek savienošana (`wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.snort.social`, `wss://nostr.mom`, `wss://offchain.pub`), un STUN serveriem (`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`). Retranslatori redz šifrētu signālu apmaiņu un telefona IP adresi; savienotais dators redz telefona IP. Lapa nekad nesūta savienošanas atslēgu retranslatoriem atklātā tekstā — tā tiek lietota kā šifrēšanas parole. Pilnā saite nav tikai datorā redzamajā QR kodā: tā paliek arī starpliktuvē pēc darbības **Kopēt saiti**, grāmatzīmēs un sākuma ekrāna ikonā, cilnes sesijas krātuvē, pārlūka vēsturē (ko pārlūks var sinhronizēt ar jūsu kontu) un QR skenera vēsturē.
- Tā lūdz pārlūkus **nesūtīt atsauces adresi** (referrer), tāpēc, atverot saiti uz citu vietni, tai netiek paziņots, no kuras lapas atnācāt.

## Kas paliek jūsu pārlūkā

Tikai tad, ja noklikšķināt uz gaišās/tumšās **tēmas pārslēdzēja**, vietne saglabā jūsu izvēli (`theme`: `light` vai `dark`) pārlūka lokālajā krātuvē, lai nākamā lapa atvērtos tajā pašā tēmā. Kamēr neesat nospieduši pārslēdzēju, vietne seko jūsu sistēmas tēmai un neko nesaglabā. Ja pārlūkā notīrāt vietnes datus, izvēle tiek izdzēsta.

Ja atverat **attālinātās vadības savienošanas saiti**, savienošanas atslēga tiek saglabāta šīs cilnes sesijas krātuvē (pazūd, aizverot cilni), un paliek pašā saitē — tāpēc grāmatzīme vai sākuma ekrāna ikona turpina strādāt. Vietne nevienu no šīm kopijām nekur nesūta; atslēga ceļo tikai caur šifrēto savienojumu uz jūsu pašu datoru. Lai to noņemtu, izdzēsiet grāmatzīmi vai sākuma ekrāna ikonu.

## Saites uz citām vietnēm

Saites uz GitHub un citām vietnēm ir parastas saites: pēc to atvēršanas attiecas attiecīgās vietnes pašas noteikumi.

## Kontakti

Jautājumi par šo lapu vai vietni: [izveidojiet problēmas pieteikumu](https://github.com/isthisgitlab/gurushots-auto-vote/issues) (pieteikumi ir publiski) vai izmantojiet kontaktinformāciju profilā [github.com/isthisgitlab](https://github.com/isthisgitlab).
