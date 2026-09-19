# Pulse — Music Player

A music player web app built in vanilla HTML, CSS, and JavaScript — no framework, no build step, no server. Local audio files in, a canvas-based Web Audio visualizer out.

## Live site

**[pulse-player-eight.vercel.app](https://pulse-player-eight.vercel.app)**

## The journey

**1. The brief.** The starting point was a design brief for "Pulse": a centered player card on a near-black background (`#14121A`), coral-pink accent (`#FF5C7A`), Space Grotesk for the track title, Inter for UI labels, IBM Plex Mono for the time readout — album art → track info → progress bar → transport controls → volume, all in a single `index.html`.

**2. The base player.** Play/pause wired to a real `<audio>` element, a click-or-drag seekable progress bar with live elapsed/remaining time (arrow-key seek too), next/prev that walk a track list (prev restarts the current song if more than 3s in), auto-advance on end, and a volume slider. A canvas-based circular visualizer came next — built on the Web Audio API's `AnalyserNode`, it draws a slow-breathing idle state and, once playing, 64 radial frequency bars around a bass-reactive pulsing core.

**3. The pain point.** That first version worked, but adding a song meant hand-editing a hardcoded `tracks` array and getting an mp3 filename to match exactly. Shuffle was a toggle that didn't actually shuffle anything. That friction became the priority for the next round.

**4. Easy importing.** The hardcoded array came out; the library now starts empty and fills at runtime. A `+` button opens a multi-file picker, a folder icon opens a folder picker, and dragging mp3s (or whole folders) anywhere on the page adds them — folders are walked recursively via `webkitGetAsEntry`. Each file's ID3 tags are read for title/artist (`jsmediatags`), falling back to parsing `"Artist - Title.mp3"`-style filenames when tags are missing. A library panel, opened from a header button, lists everything imported so far and jumps to any track on click.

**5. Real shuffle and persistence.** Shuffle became an actual Fisher-Yates-randomized play order (anchored to the current track so toggling it on doesn't yank playback sideways) instead of a cosmetic toggle. Since imported files only exist as in-memory object URLs, reloading the page used to mean re-importing everything — so the library is now persisted properly: each file is stored as a Blob in IndexedDB, and volume, shuffle/repeat state, and the last-played track are stored in `localStorage`. Reload the page and the whole session picks back up where it left off, on that browser.

**6. Shipping it.** The repo went up on GitHub and connected to Vercel for auto-deploy on every push to `main`.

**7. Crossfade and an equalizer.** Switching tracks used to be a hard cut — one `<audio>` element, swap the `src`, done. Crossfade needed two, so the player now runs two audio elements at once, each through its own bass/mid/treble `BiquadFilterNode` chain and gain node, both feeding one shared analyser. Crossfading ramps one element's gain down and the other's up over a length you set with a 0–5 second slider (0 is the old hard cut; a fade never takes more than a third of a track, so short tracks stay sane) — triggered automatically near the end of a track, or on a manual skip — while the equalizer sliders adjust both chains identically so the incoming track already sounds right before it's audible. Both live in a new settings panel, opened from a gear icon next to the library button.

**8. Media Session and keyboard shortcuts.** Two smaller finishing touches: the Media Session API now reports track metadata and playback state to the OS, so lock-screen and hardware media keys (play/pause, next/previous, scrubbing) work like a native app; and a global keyboard layer adds space to play/pause and arrow keys for seek/volume, stepping aside whenever a form control already has focus so it doesn't fight with native slider behavior.

**9. Energy-reactive visualizer color.** The radial bars and pulsing core always drew in the fixed pink accent color, at any energy level. Now, a smoothed read of the full frequency spectrum (an exponential moving average, so it eases rather than flickers) drives an HSL hue shift — calm passages stay close to the brand pink, louder/denser passages shift warmer toward orange. Only the active-playback state reacts this way; the idle breathing animation before playback starts still uses the fixed accent color.

**10. Mood theming.** Each track now carries a mood — `chill`, `hype`, `focus`, `moody`, or `warm` — that recolors the whole player, not just the visualizer: the `--accent` and `--accent-dim` CSS variables update live, so the play button, progress bar, toggled icons, and library highlight all shift together over a soft 0.6s fade. Since the library is an open-ended set of user-imported files rather than a fixed track list, moods aren't hand-picked — they're derived deterministically from a hash of each track's title and artist, so the same track always lands on the same mood, and it's stored alongside the file so it survives a reload. The energy-reactive shift from the previous step now centers on the current track's mood hue instead of always starting from the original pink.

**11. Removing a track.** The last piece the library panel was missing: a small `×` on every row that pulls that track from the library, storage, and — if it was the one loaded — playback, falling back to whatever's next or clearing to the empty state if it was the last one.

**12. Export and import.** The library is stuck in IndexedDB, in one browser, on one device — Export/Import in the settings panel move it between them as a single `.zip` file, built client-side with JSZip: every track's audio goes in under `audio/`, alongside a `metadata.json` listing title/artist/mood and the matching filename. Import reads that same structure back, skips anything already in the library (matched by title+artist), and writes the rest straight into IndexedDB. No server touches it either way.

**13. A native iOS app.** The web app already works fine in mobile Safari, but a from-the-home-screen app feels different — a real icon, no browser chrome, actual backgrounding. `ios-app/` wraps the same interface as a native iOS app via [Capacitor](https://capacitorjs.com/): Vite bundles the code, and the iOS platform is added via Swift Package Manager rather than CocoaPods, so there's no separate CocoaPods toolchain to install. It's a separate copy of the same HTML/CSS/JS, kept in step with the root `index.html` by hand as features are added.

**14. Optional Google Drive import.** Local files and Drive files are different enough — Drive's own auth, its own picker UI — that this stays a clearly separate, opt-in path rather than folded into the regular file picker. Sign-in uses Google Identity Services' token-based OAuth flow, and the Google Picker API lets you browse and select audio files straight from Drive; picked files are fetched and added through the same import pipeline as local ones, and nothing about the local-only experience changes if this is never touched.

**15. Video-to-MP3 conversion.** Some of what ends up in a music library started life as a screen recording — a voice memo captured as video, a clip with a song playing in the background. Drop a video file and [`ffmpeg.wasm`](https://ffmpegwasm.netlify.app/) extracts and compresses its audio to MP3 entirely client-side, then feeds it into the same import pipeline as everything else. It runs ffmpeg's single-threaded core specifically, not the faster multi-threaded build — that one needs `SharedArrayBuffer` and cross-origin-isolation headers that iOS Safari (and the Capacitor app's WebView) don't reliably support, so single-threaded is the version that actually works everywhere the rest of the app does.

**16. Sync with a code.** Moving a library between devices used to mean exporting a `.zip` and manually carrying it over. Sync adds a faster path: generate a short code on one device, and it encrypts the library client-side and uploads it to temporary storage; entering that same code on another device downloads and decrypts it there. The server only ever sees a hash of the code — never the code itself, the encryption key, or the plaintext — and the upload is single-use and deleted after the first successful claim, or after 24 hours either way. It's relay-only for now; a faster direct device-to-device path (WebRTC, no server relay) may come later for when both devices happen to be online at the same time.

**17. Renaming tracks.** Titles and artists come from ID3 tags or a guess at the filename, and both are wrong often enough that fixing them shouldn't mean re-importing. Every row in the library panel now has a pencil that turns the title and artist into inline inputs (✓ to save, ✕ or Escape to cancel; a blank title is refused, a blank artist becomes "Unknown Artist"). The change is written to IndexedDB and, if it's the track that's loaded, shows up in the now-playing text and lock-screen metadata immediately. Renaming exposed a flaw in sync, which decided two tracks were "the same song" by comparing title and artist — so a track renamed on one device arrived on the other as a duplicate. Tracks are now matched by a SHA-256 of their audio instead, and each rename is timestamped: a newer name wins on the receiving device, a stale snapshot can't overwrite a newer rename, and two different songs that happen to share a title are no longer silently merged. Hashes are computed lazily and cached, so libraries from before this change pick theirs up the first time they sync.

**18. iOS volume.** iOS doesn't let JavaScript set an `<audio>` element's volume — the property always reads back as 1, in Safari and in Capacitor's WKWebView alike — so the volume slider was a control that did nothing on the very devices it was most likely to be touched on. On iOS the slider is now replaced with a "Use your device's volume buttons" hint, and `audio.volume` is never touched there. Platform detection checks the `window.Capacitor.getPlatform()` global that Capacitor injects into the native app, then falls back to the user agent (including iPadOS, which reports itself as a Mac), and everywhere else the slider is unchanged. It deliberately doesn't try to fake volume with a Web Audio `GainNode`, which is unreliable inside WKWebView.

**19. Music that survives a locked phone.** Testing the iOS app on a real device turned up two problems the desktop never showed: playback stopped when the screen locked, and pulling out a headphone made it stutter. The lock-screen entry also had no cover art. Three causes, three fixes. The app had no permission to play in the background, so `Info.plist` now declares the `audio` background mode and `AppDelegate` sets a playback audio session. The Media Session `play`/`pause` handlers were toggles, so when iOS paused the audio itself on unplug and then also sent a "pause" command, the toggle started it back up — they're idempotent now, and the lock screen shows the app icon and an album name. And the real culprit for the lock-screen cutoff: everything played through the Web Audio graph that powers the equalizer, crossfade, and visualizer, which iOS shuts off when the screen locks. On iOS the graph is now skipped entirely so the `<audio>` element plays straight to the system — which also means the equalizer and crossfade don't exist there and the visualizer stays in its idle animation while music plays. Everywhere else the graph is unchanged.

The full history of that progression — every step above as its own commit — is in this repo's [commit log](../../commits/main).

## Design

- **Colors** — background `#14121A`, card surface `#1E1B26`, text `#F2EFEA`. The accent defaults to `#FF5C7A` (coral-pink) but shifts per track via mood theming (see below).
- **Type** — Space Grotesk for the track title, Inter for UI/labels, IBM Plex Mono for the time readout.
- **Layout** — a single centered player card: album-art/visualizer → track info → progress bar → transport controls → volume slider, with a library bar and import controls above the art.

## Features

- Play/pause, seekable progress bar (click, drag, or arrow keys), volume control (hardware buttons only on iOS)
- Next/previous with a 3-second "restart vs. skip back" rule, auto-advance on end, repeat
- Real shuffle — randomized play order, not just a toggle
- Crossfade between tracks with an adjustable 0–5 second length (auto-triggered near the end of a track, or on manual skip) — not on iOS, where the audio graph is skipped so music keeps playing with the screen locked
- A 3-band equalizer (bass/mid/treble), applied live via Web Audio `BiquadFilterNode`s (not on iOS — see below)
- Import songs by file picker, folder picker, or drag-and-drop (including whole folders)
- Automatic title/artist from ID3 tags, with filename-based fallback parsing
- A library panel to browse, jump to, or remove any imported track
- Library, volume, playback, crossfade, and EQ settings persist across reloads (IndexedDB + `localStorage`)
- Export/import the library as a `.zip` file to move it between browsers or devices
- Rename any track's title and artist inline from the library panel
- Sync a library between devices with a short one-time code — encrypted client-side, relay-only, no account. Tracks are matched by their audio content, so a rename travels with the track instead of creating a duplicate
- On iOS, the volume slider is replaced by a hint to use the hardware buttons (iOS doesn't allow web pages to set audio volume)
- Optional Google Drive import, alongside local file/folder import
- Convert a screen-recorded video's audio to MP3 for import, entirely client-side via `ffmpeg.wasm`
- A canvas-based circular visualizer (idle breathing state; 64 radial frequency bars + a bass-reactive pulsing core while playing), respecting `prefers-reduced-motion` — its color shifts from the accent pink toward warm orange as the music's overall energy rises
- OS/browser media notifications and hardware media key support (Media Session API), with cover art on the lock screen, and background playback in the iOS app
- Keyboard shortcuts — space to play/pause, arrow keys to seek and adjust volume
- Mood theming — each track recolors the whole player (accent color, not just the visualizer), derived deterministically per track and persisted with it

## Structure

```
index.html    Everything — structure, styles, and script in one file
ios-app/      A Capacitor-wrapped native iOS build of this same app
api/          Vercel serverless functions backing the sync-with-code feature
```

No build step is needed to run the web app itself — the whole player is one static `index.html`. `jsmediatags`, `JSZip`, and `ffmpeg.wasm` load from a CDN at runtime; Google Fonts, Google Identity Services, and Google Picker are optional and only load if Drive import is used. The `api/` functions have their own small `package.json` (just `@vercel/blob`) since they run server-side on Vercel, not in the browser.

## iOS app

`ios-app/` wraps this same app as a native iOS app with [Capacitor](https://capacitorjs.com/) — Vite bundles the code, and the iOS platform is added via Swift Package Manager (no CocoaPods needed). To build it:

```bash
cd ios-app
npm install
npm run build
npx cap sync ios
npx cap open ios
```

Then build and run from Xcode. A real device additionally needs a signing team set in the project's Signing & Capabilities tab; the Simulator doesn't.

## Running locally

No build step — just serve the folder statically, e.g.:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`. Sync talks to the deployed API directly (not a relative path), so it works the same way from a local server as it does in production — the other two optional cloud features (Drive import, video conversion) also work locally as-is.

## A note on persistence

Imported songs are stored in the browser's IndexedDB, not uploaded anywhere — the library, and everything else that persists, is local to whichever browser and device you imported them in. To move a library to another browser or device, either use Export/Import in the settings panel (a `.zip` file you carry over manually) or Sync (a short code, faster, no file to handle) — Sync's upload is encrypted client-side, single-use, and expires within 24 hours either way; nothing here leaves your machine other than that temporary, encrypted blob.

## Deploying

The player itself is static output, so it deploys as-is to Vercel, Netlify, GitHub Pages, or any static host. This project is deployed on Vercel, connected directly to this GitHub repo — every push to `main` auto-deploys. The Sync feature additionally needs [Vercel Blob](https://vercel.com/docs/vercel-blob) storage enabled on the project (Storage tab → Create Database → Blob), which sets a `BLOB_READ_WRITE_TOKEN` environment variable the `api/` functions read; without it, everything else in the app still works, and Sync just fails with a clear error instead.
