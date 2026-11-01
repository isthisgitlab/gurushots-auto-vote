# GuruShots Auto Voter — Website privacy

[← Home](../README.md) · [Latviski](privacy.lv.md)

This page is about this **website** only. The desktop, CLI and Android apps are separate: what they send and store is described under [Security](../README.md#-security) and [Where your data is stored](usage.md#️-where-your-data-is-stored--how-to-erase-it).

## Hosting

The site is hosted on **GitHub Pages**. GitHub serves every page and may log visitors' IP addresses and other request data. How GitHub handles it is described in [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The project has no access to those logs.

## What the site does not do

- It sets **no cookies**.
- It uses **no analytics, trackers or advertising**.
- The pages, styles, scripts, logo and badges all come from this site, with no third-party fonts, images or scripts — with one exception: the **remote-control page** (`/remote/`, only when you open a pairing link) connects to the public Nostr relays the pairing runs over (`wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.snort.social`, `wss://nostr.mom`, `wss://offchain.pub`) and to STUN servers (`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`). The relays see encrypted signalling and your phone's IP address; the paired computer sees your phone's IP. The page never sends the pairing key to the relays in plain text — it is used as the encryption password. The full link is not only in the QR code on your computer: it also stays in the clipboard after **Copy link**, in bookmarks and the Home Screen icon, in the tab's session storage, in your browser's history (which the browser may sync to its account), and in your QR scanner's history.
- It asks browsers to send **no referrer**, so a link to another site does not carry the address of the page you came from.

## What stays in your browser

Only if you click the light/dark **theme toggle**, the site saves your choice (`theme`: `light` or `dark`) in your browser's local storage so the next page opens in the same theme. Until you click the toggle, the site follows your system's theme and stores nothing. Clearing the site's data in your browser removes the choice.

If you open a **remote-control pairing link**, the pairing key is kept in that tab's session storage (gone when you close the tab) and stays in the link itself — so a bookmark or a Home Screen icon keeps working. Neither copy is sent anywhere by the site; the key travels only over the encrypted pairing connection to your own computer. Delete the bookmark or Home Screen icon to remove the key.

## Links to other sites

Links to GitHub and other sites are ordinary links: once you follow one, that site's own policy applies.

## Contact

Questions about this page or the site: [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues) (issues are public) or use the contact details on the [github.com/isthisgitlab](https://github.com/isthisgitlab) profile.
