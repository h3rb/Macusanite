Macusanite 0.1.17. Switch vaults from the title bar, keep the words you just typed, and see every node when the canvas is zoomed all the way out.

## Highlights
- **Switch vaults from the title bar.** Click the vault's name to see the other vaults this computer has opened and move between them. The list is kept in `Documents/macusanite/localstorage/vaults.json`, a plain file you can read or edit, and it is now the only record of which vault was open last — so the app still reopens where you left off.
- **Nothing typed is lost when you switch.** Choosing another vault saves the open vein's draft first. If that save cannot be made — a locked section, or merge markers still in the text — the app stays in the vault your words belong to instead of switching.
- **Nodes stay visible at every zoom.** At and below roughly 12.5% each node is now an icon pill instead of a glyph that disappeared, so a fully zoomed-out graph reads as a field of marks rather than an empty page.
- **Teaching notes are dismissed once.** Closing a note is remembered for the whole computer in `localstorage/tutorials.json` rather than per vault, so it never reopens when you move to another vault. Notes closed by earlier versions are carried over the next time their vault is opened, and **Settings → Reading → Reset tutorials** brings them all back.
