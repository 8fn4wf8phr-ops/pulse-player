# Pulse — Music Player

A music player web app built in vanilla HTML, CSS, and JavaScript — no framework, no build step, no server. Local audio files in, a canvas-based Web Audio visualizer out.

## Live site

**Coming soon — deploying now.**

## The journey

**1. The brief.** The starting point was a design brief for "Pulse": a centered player card on a near-black background (`#14121A`), coral-pink accent (`#FF5C7A`), Space Grotesk for the track title, Inter for UI labels, IBM Plex Mono for the time readout — album art → track info → progress bar → transport controls → volume, all in a single `index.html`.

**2. The base player.** Play/pause wired to a real `<audio>` element, a click-or-drag seekable progress bar with live elapsed/remaining time (arrow-key seek too), next/prev that walk a track list (prev restarts the current song if more than 3s in), auto-advance on end, and a volume slider. A canvas-based circular visualizer came next — built on the Web Audio API's `AnalyserNode`, it draws a slow-breathing idle state and, once playing, 64 radial frequency bars around a bass-reactive pulsing core.

**3. The pain point.** That first version worked, but adding a song meant hand-editing a hardcoded `tracks` array and getting an mp3 filename to match exactly. Shuffle was a toggle that didn't actually shuffle anything. That friction became the priority for the next round.

**4. Easy importing.** The hardcoded array came out; the library now starts empty and fills at runtime. A `+` button opens a multi-file picker, a folder icon opens a folder picker, and dragging mp3s (or whole folders) anywhere on the page adds them — folders are walked recursively via `webkitGetAsEntry`. Each file's ID3 tags are read for title/artist (`jsmediatags`), falling back to parsing `"Artist - Title.mp3"`-style filenames when tags are missing. A library panel, opened from a header button, lists everything imported so far and jumps to any track on click.

**5. Real shuffle and persistence.** Shuffle became an actual Fisher-Yates-randomized play order (anchored to the current track so toggling it on doesn't yank playback sideways) instead of a cosmetic toggle. Since imported files only exist as in-memory object URLs, reloading the page used to mean re-importing everything — so the library is now persisted properly: each file is stored as a Blob in IndexedDB, and volume, shuffle/repeat state, and the last-played track are stored in `localStorage`. Reload the page and the whole session picks back up where it left off, on that browser.

**6. Shipping it.** The repo went up on GitHub and connected to Vercel for auto-deploy on every push to `main`.

**7. Crossfade and an equalizer.** Switching tracks used to be a hard cut — one `<audio>` element, swap the `src`, done. Crossfade needed two, so the player now runs two audio elements at once, each through its own bass/mid/treble `BiquadFilterNode` chain and gain node, both feeding one shared analyser. Crossfading ramps one element's gain down and the other's up over four seconds — triggered automatically near the end of a track, or on a manual skip — while the equalizer sliders adjust both chains identically so the incoming track already sounds right before it's audible. Both live in a new settings panel, opened from a gear icon next to the library button.

**8. Media Session and keyboard shortcuts.** Two smaller finishing touches: the Media Session API now reports track metadata and playback state to the OS, so lock-screen and hardware media keys (play/pause, next/previous, scrubbing) work like a native app; and a global keyboard layer adds space to play/pause and arrow keys for seek/volume, stepping aside whenever a form control already has focus so it doesn't fight with native slider behavior.

**9. Energy-reactive visualizer color.** The radial bars and pulsing core always drew in the fixed pink accent color, at any energy level. Now, a smoothed read of the full frequency spectrum (an exponential moving average, so it eases rather than flickers) drives an HSL hue shift — calm passages stay close to the brand pink, louder/denser passages shift warmer toward orange. Only the active-playback state reacts this way; the idle breathing animation before playback starts still uses the fixed accent color.

The full history of that progression — every step above as its own commit — is in this repo's [commit log](../../commits/main).

## Design

- **Colors** — background `#14121A`, card surface `#1E1B26`, accent `#FF5C7A` (coral-pink), text `#F2EFEA`.
- **Type** — Space Grotesk for the track title, Inter for UI/labels, IBM Plex Mono for the time readout.
- **Layout** — a single centered player card: album-art/visualizer → track info → progress bar → transport controls → volume slider, with a library bar and import controls above the art.

## Features

- Play/pause, seekable progress bar (click, drag, or arrow keys), volume control
- Next/previous with a 3-second "restart vs. skip back" rule, auto-advance on end, repeat
- Real shuffle — randomized play order, not just a toggle
- Crossfade between tracks (auto-triggered near the end of a track, or on manual skip)
- A 3-band equalizer (bass/mid/treble), applied live via Web Audio `BiquadFilterNode`s
- Import songs by file picker, folder picker, or drag-and-drop (including whole folders)
- Automatic title/artist from ID3 tags, with filename-based fallback parsing
- A library panel to browse and jump to any imported track
- Library, volume, playback, crossfade, and EQ settings persist across reloads (IndexedDB + `localStorage`)
- A canvas-based circular visualizer (idle breathing state; 64 radial frequency bars + a bass-reactive pulsing core while playing), respecting `prefers-reduced-motion` — its color shifts from the accent pink toward warm orange as the music's overall energy rises
- OS/browser media notifications and hardware media key support (Media Session API)
- Keyboard shortcuts — space to play/pause, arrow keys to seek and adjust volume

## Structure

```
index.html    Everything — structure, styles, and script in one file
```

Nothing else is needed: no build step, no dependencies to install. The only external resources are Google Fonts and the `jsmediatags` library, both loaded from a CDN.

## Running locally

No build step — just serve the folder statically, e.g.:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## A note on persistence

Imported songs are stored in the browser's IndexedDB, not uploaded anywhere — the library, and everything else that persists, is local to whichever browser and device you imported them in.

## Deploying

This is static output, so it deploys as-is to Vercel, Netlify, GitHub Pages, or any static host. This project is deployed on Vercel, connected directly to this GitHub repo — every push to `main` auto-deploys.
