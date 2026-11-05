# GuruShots Auto Voter — Website privacy

[← Home](../README.md) · [Latviski](privacy.lv.md)

This page is about this **website** only. The desktop, CLI and Android apps are separate: what they send and store is described under [Security](../README.md#-security) and [Where your data is stored](usage.md#️-where-your-data-is-stored--how-to-erase-it).

## Hosting

The site is hosted on **GitHub Pages**. GitHub serves every page and may log visitors' IP addresses and other request data. How GitHub handles it is described in [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The project has no access to those logs.

## What the site does not do

- It sets **no cookies**.
- It uses **no analytics, trackers or advertising**.
- The pages, styles, scripts, logo and badges all come from this site, with no third-party fonts, images or scripts — with one exception: the **remote-control page** (`/remote/`, only when you open a pairing link) connects to the public Nostr relays the pairing runs over (`wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`, `wss://nostr.oxtr.dev`) and to STUN servers (`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`). The relays see encrypted signalling and your phone's IP address. When a direct connection is not possible they also carry the app's own messages, encrypted with the pairing key: they see their timing and approximate sizes, keep them at least briefly, and any relay can record them. Someone who records them and later gets your pairing link can decrypt them; **Reset pairing** is the remedy. The same public key signs the signalling and these messages, so relays can link the two, and the phone listens on up to 3 relays, so it may download each message up to 3 times; the app processes it once. The computer listens on every relay. The paired computer sees your phone's IP. The page never sends the pairing key to the relays in plain text — it is used as the encryption password. The full link is not only in the QR code on your computer: it also stays in the clipboard after **Copy link**, in bookmarks and the Home Screen icon, in the tab's session storage, in your browser's history (which the browser may sync to its account), and in your QR scanner's history.
- It asks browsers to send **no referrer**, so a link to another site does not carry the address of the page you came from.

## What stays in your browser

On the site's pages, only if you click the light/dark **theme toggle**, the site saves your choice (`theme`: `light` or `dark`) in your browser's local storage so the next page opens in the same theme. Until you click the toggle, those pages follow your system's theme and store nothing. Clearing the site's data in your browser removes the choice. The remote-control page (`/remote/`) is covered below.

If you open a **remote-control pairing link**, the pairing key is kept in that tab's session storage (gone when you close the tab) and stays in the link itself — so a bookmark or a Home Screen icon keeps working. Neither copy is sent anywhere by the site; the key travels only over the encrypted pairing connection to your own computer. Delete the bookmark or Home Screen icon to remove the key.

The **remote-control page** (`/remote/`) also keeps these items, and only when you open a pairing link:

- In local storage, until you clear the site's data in your browser (deleting the bookmark or Home Screen icon does not remove them):
    - `gs-remote-view-prefs` — the page's theme, language and compact view, including the compact-card choices for single challenges. It stays on your phone and is never sent to the computer.
    - `gs-remote-link-version` — a short hash of the pairing room's id, plus the link version the desktop app speaks (a small number such as 1), so the page can open straight to that version's page. It never holds the pairing key. The page also removes it when it no longer fits, for example when you open a different pairing link, and **Disconnect** in the Android app removes it. The page also removes `gs-remote-desktop-version`, a key that the 1.15.0 page writes.
- In session storage, gone when you close the tab:
    - `gs-remote-skipped-to` — the link version the tab already went straight to, so the page does not loop between two pages.
    - `remote-add-home-hint` — a flag so the Add to Home Screen hint is offered once per tab.

## Links to other sites

Links to GitHub and other sites are ordinary links: once you follow one, that site's own policy applies.

## Contact

Questions about this page or the site: [open an issue](https://github.com/isthisgitlab/gurushots-auto-vote/issues) (issues are public) or use the contact details on the [github.com/isthisgitlab](https://github.com/isthisgitlab) profile.
