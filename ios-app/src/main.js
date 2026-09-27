  const audioA = document.getElementById('audioA');
  const audioB = document.getElementById('audioB');
  const els = { A: audioA, B: audioB };
  let activeSlot = 'A';
  function activeEl() { return els[activeSlot]; }
  function inactiveSlotKey() { return activeSlot === 'A' ? 'B' : 'A'; }
  function isActive(el) { return el === activeEl(); }

  const canvas = document.getElementById('visualizer');
  const canvasCtx = canvas.getContext('2d');
  const artEl = document.querySelector('.art');
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#FF5C7A';

  // Crossfade length in seconds (0 = off, hard cut). Set by the settings slider.
  let crossfadeSeconds = 0;
  let crossfadeInProgress = false;

  let audioCtx, analyser, dataArray, bufferLength;
  const webAudioSlots = {}; // { A: {source, bass, mid, treble, gain}, B: {...} } — built lazily, once, after a user gesture
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const num = parseInt(h, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  const accentRgb = hexToRgb(accentColor);
  function accentAlpha(a) { return `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, ${a})`; }

  // Smoothed 0-1 read of overall loudness across the full spectrum, updated
  // every frame in drawActive() and used to drive the active-state color.
  let smoothedEnergy = 0;

  // The hue energyColor() shifts away from as the music gets denser/louder —
  // starts at the default accent's hue, then follows the current track's
  // mood once one loads (see applyMoodTheme()).
  let currentMoodHue = 340;

  function energyColor(energy, alpha) {
    // Base hue starts at the current mood's hue, shifts warmer as energy rises
    const hue = currentMoodHue - energy * 60; // shifts toward orange/yellow as energy increases
    const saturation = 70 + energy * 20;
    const lightness = 55 + energy * 10;
    return `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
  }

  // ---------------------------------------------------------------------
  // Mood theming: each track carries a mood that recolors the whole
  // player — not just the visualizer, but every CSS surface driven by
  // --accent/--accent-dim (buttons, progress bar, toggled icons).
  // ---------------------------------------------------------------------

  const MOODS = ['chill', 'hype', 'focus', 'moody', 'warm'];
  const moodPalettes = {
    chill: { hue: 190, sat: 65, light: 55 }, // cool teal/blue
    hype: { hue: 345, sat: 80, light: 58 }, // hot pink/red (close to the original default)
    focus: { hue: 265, sat: 55, light: 60 }, // indigo/purple
    moody: { hue: 225, sat: 45, light: 45 }, // deep blue-violet
    warm: { hue: 30, sat: 75, light: 58 }, // amber/orange
  };

  // No mood metadata exists per song, and the library is an open-ended,
  // user-imported set rather than a fixed track list — so instead of
  // hand-picking a mood per title, every track gets one deterministically
  // from a hash of its title+artist. Same track, same mood, every time.
  function pickMood(title, artist) {
    const str = `${artist}::${title}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return MOODS[hash % MOODS.length];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  function applyMoodTheme(mood) {
    const palette = moodPalettes[mood] || moodPalettes.hype;
    const rgb = hslToRgb(palette.hue, palette.sat, palette.light);

    document.documentElement.style.setProperty('--accent', `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
    document.documentElement.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);

    // accentAlpha() (used by drawIdle()) reads these fields live, so
    // mutating them in place is enough — no need to touch drawIdle() itself.
    accentRgb.r = rgb.r;
    accentRgb.g = rgb.g;
    accentRgb.b = rgb.b;

    // energyColor()'s per-frame shift during playback now centers on this
    // mood's hue instead of always starting from the original pink.
    currentMoodHue = palette.hue;
  }

  function resizeCanvas() {
    const size = artEl.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Each <audio> element gets its own bass/mid/treble filter chain and gain
  // node (the gain is what crossfade ramps between 0 and 1), then both
  // chains feed one shared analyser so the visualizer sees combined output.
  function buildChain(el) {
    const source = audioCtx.createMediaElementSource(el);
    const bass = audioCtx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    const mid = audioCtx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 1;
    const treble = audioCtx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 4000;
    const gain = audioCtx.createGain();
    source.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(gain);
    gain.connect(analyser);
    return { source, bass, mid, treble, gain };
  }

  // Web Audio graph can only be created after a user gesture, and
  // createMediaElementSource can only ever be called once per <audio> element.
  function setupAudioGraph() {
    // iOS keeps music playing with the screen locked (and rides out route
    // changes like unplugging headphones) only when the <audio> element plays
    // straight to the system. Routing it through Web Audio gets it cut off,
    // so there's deliberately no graph on iOS — and so no EQ, crossfade, or
    // analyser there. Everything below tolerates audioCtx being undefined.
    if (audioCtx || IS_IOS) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    analyser.connect(audioCtx.destination);

    webAudioSlots.A = buildChain(audioA);
    webAudioSlots.B = buildChain(audioB);
    applyEQ();
  }

  function drawIdle(time) {
    const size = artEl.clientWidth;
    const cx = size / 2, cy = size / 2;
    const breathe = prefersReducedMotion ? 0 : Math.sin(time / 1200) * 0.04;
    const baseR = size * 0.16;

    canvasCtx.clearRect(0, 0, size, size);

    [0.42, 0.66, 0.88].forEach((mult, i) => {
      canvasCtx.beginPath();
      canvasCtx.arc(cx, cy, size * mult * (1 + (i === 0 ? breathe : 0)) / 2, 0, Math.PI * 2);
      canvasCtx.strokeStyle = accentAlpha(0.35 - i * 0.11);
      canvasCtx.lineWidth = 1.5;
      canvasCtx.stroke();
    });

    canvasCtx.beginPath();
    canvasCtx.arc(cx, cy, baseR * (1 + breathe), 0, Math.PI * 2);
    canvasCtx.fillStyle = accentAlpha(0.16);
    canvasCtx.fill();
  }

  function drawActive() {
    const size = artEl.clientWidth;
    const cx = size / 2, cy = size / 2;
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.clearRect(0, 0, size, size);

    // Bass-driven pulsing core (average of the lowest few bins) — stays
    // bass-only; it's the overall spectrum average below that drives color.
    const bassBins = 4;
    let bassSum = 0;
    for (let i = 0; i < bassBins; i++) bassSum += dataArray[i];
    const bassAvg = bassSum / bassBins / 255;
    const coreR = size * 0.14 * (1 + bassAvg * 0.5);

    // Full-spectrum loudness, smoothed with an exponential moving average
    // (90% previous frame / 10% new sample) so the color eases rather than
    // flickering frame to frame.
    let spectrumSum = 0;
    for (let i = 0; i < bufferLength; i++) spectrumSum += dataArray[i];
    const rawEnergy = spectrumSum / bufferLength / 255;
    smoothedEnergy = smoothedEnergy * 0.9 + rawEnergy * 0.1;

    canvasCtx.beginPath();
    canvasCtx.arc(cx, cy, coreR, 0, Math.PI * 2);
    canvasCtx.fillStyle = energyColor(smoothedEnergy, 0.25 + bassAvg * 0.25);
    canvasCtx.shadowColor = energyColor(smoothedEnergy, 0.5);
    canvasCtx.shadowBlur = size * 0.06 * (0.5 + bassAvg);
    canvasCtx.fill();
    canvasCtx.shadowBlur = 0;

    // Radial frequency bars
    const numBars = bufferLength;
    const baseRadius = size * 0.2;
    const maxBarLength = size * 0.18;
    const lineWidth = Math.max(1.5, size * 0.008);

    canvasCtx.lineCap = 'round';
    canvasCtx.lineWidth = lineWidth;

    for (let i = 0; i < numBars; i++) {
      const value = dataArray[i] / 255;
      const angle = (i / numBars) * Math.PI * 2 - Math.PI / 2;
      const barLen = Math.max(size * 0.01, value * maxBarLength);
      const x1 = cx + Math.cos(angle) * baseRadius;
      const y1 = cy + Math.sin(angle) * baseRadius;
      const x2 = cx + Math.cos(angle) * (baseRadius + barLen);
      const y2 = cy + Math.sin(angle) * (baseRadius + barLen);

      canvasCtx.strokeStyle = energyColor(smoothedEnergy, 0.35 + value * 0.65);
      canvasCtx.beginPath();
      canvasCtx.moveTo(x1, y1);
      canvasCtx.lineTo(x2, y2);
      canvasCtx.stroke();
    }
  }

  function animate(time) {
    requestAnimationFrame(animate);
    if (analyser && isPlaying) {
      drawActive();
    } else {
      drawIdle(time || 0);
    }
  }
  requestAnimationFrame(animate);

  let isPlaying = false;
  let isSeeking = false;

  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const progressBar = document.getElementById('progressBar');
  const waveformBase = document.getElementById('waveformBase');
  const waveformPlayed = document.getElementById('waveformPlayed');
  const waveformPlayedClip = document.getElementById('waveformPlayedClip');
  const waveformBaseCtx = waveformBase.getContext('2d');
  const waveformPlayedCtx = waveformPlayed.getContext('2d');
  const progressHandle = document.getElementById('progressHandle');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeIcon = document.getElementById('volumeIcon');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const repeatBtn = document.getElementById('repeatBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const crossfadeSlider = document.getElementById('crossfadeSlider');
  const crossfadeValue = document.getElementById('crossfadeValue');
  const eqBassSlider = document.getElementById('eqBass');
  const eqMidSlider = document.getElementById('eqMid');
  const eqTrebleSlider = document.getElementById('eqTreble');

  // The library starts empty — songs are added at runtime via the
  // "add songs" / "add folder" buttons or by dragging files onto the page,
  // then persisted in IndexedDB so they survive a reload.
  let tracks = [];
  let trackIndex = 0;
  let playOrder = [];
  let orderPos = 0;

  // Keeps the current track first so shuffling doesn't yank playback
  // sideways; rebuild whenever the library or the shuffle toggle changes.
  // Next/previous/auto-advance/shuffle all work off this queue, which is the
  // library or a playlist depending on where the current track was started.
  function queueIndices() {
    const all = tracks.map((_, i) => i);
    if (playContext === 'all') return all;
    const pl = playlists.find((p) => p.id === playContext);
    if (!pl) return all;
    const idxs = pl.trackIds.map((id) => tracks.findIndex((t) => t.id === id)).filter((i) => i >= 0);
    return idxs.length ? idxs : all;
  }

  function rebuildOrder() {
    const indices = queueIndices();
    if (shuffleBtn.classList.contains('toggled')) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const pos = indices.indexOf(trackIndex);
      if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
    }
    playOrder = indices;
    orderPos = playOrder.indexOf(trackIndex);
  }

  function stepTrack(delta, autoplay) {
    if (!tracks.length) return;
    if (!playOrder.length) rebuildOrder();
    // -1: the current track isn't in the queue, so next is the first entry and previous the last
    if (orderPos < 0) orderPos = delta > 0 ? -1 : 0;
    orderPos = (orderPos + delta + playOrder.length) % playOrder.length;
    switchTrack(playOrder[orderPos], autoplay);
  }

  function updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: 'Pulse',
          // Real cover art if this track has any; the app icon otherwise.
          artwork: track.artworkUrl
            ? [{ src: track.artworkUrl, sizes: '512x512' }]
            : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
        })
      : null;
  }

  function updateTrackArt(track) {
    const img = document.getElementById('trackArt');
    if (track && track.artworkUrl) {
      img.src = track.artworkUrl;
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
  }

  function setNowPlayingUI(track) {
    document.getElementById('trackTitle').textContent = track.title;
    document.getElementById('trackArtist').textContent = track.artist;
    updateTrackArt(track);
    updateMediaSessionMetadata(track);
    applyMoodTheme(track.mood);
    offerResume(track);
    loadWaveformForTrack(track);
  }

  // ---------------------------------------------------------------------
  // Resume position: remember where each track was left, and offer to pick
  // up from there the next time it loads. Positions live in memory for
  // instant lookups and are mirrored to a small IndexedDB store.
  // ---------------------------------------------------------------------
  const RESUME_MIN_SECONDS = 10;          // ignore spots this close to the start...
  const RESUME_END_MARGIN = 10;           // ...or this close to the end
  const POSITION_SAVE_INTERVAL_MS = 5000; // at most one throttled write per interval
  const positions = new Map();            // track id -> seconds
  let lastPositionSave = 0;
  let pendingResume = null;               // { track, position, shown } while an offer is open
  const resumePrompt = document.getElementById('resumePrompt');
  const resumeText = document.getElementById('resumeText');
  const resumeYes = document.getElementById('resumeYes');
  const resumeNo = document.getElementById('resumeNo');

  function clearPosition(id) {
    if (id == null) return;
    positions.delete(id);
    dbDeletePosition(id).catch((err) => console.warn('Pulse: failed to clear saved position', err));
  }

  // Saves the loaded track's current spot. `force` skips the throttle (used
  // when pausing or leaving a track, so the last few seconds aren't lost).
  function savePosition(force = false) {
    const track = tracks[trackIndex];
    const el = activeEl();
    if (!track || track.id == null || el.currentSrc !== track.url) return;   // element isn't actually playing this track
    if (!Number.isFinite(el.duration) || el.duration <= 0 || el.ended) return;
    const t = el.currentTime;
    if (t <= 0) return;
    // While an offer is open, don't overwrite the spot being offered with the
    // start of this playthrough — normal saving resumes once it's answered or passed.
    if (pendingResume && pendingResume.track === track && t < pendingResume.position) return;
    const now = performance.now();
    if (!force && now - lastPositionSave < POSITION_SAVE_INTERVAL_MS) return;
    lastPositionSave = now;
    positions.set(track.id, t);
    dbSetPosition(track.id, t).catch((err) => console.warn('Pulse: failed to save position', err));
  }

  function hideResumePrompt() {
    pendingResume = null;
    resumePrompt.hidden = true;
  }

  // Shows the prompt once the loaded track's duration is known, and only if
  // the saved spot is far enough from both ends to be worth offering.
  function evaluateResumeOffer() {
    if (!pendingResume || pendingResume.shown) return;
    const el = activeEl();
    if (pendingResume.track !== tracks[trackIndex] || !Number.isFinite(el.duration)) return;
    const { position } = pendingResume;
    if (position > RESUME_MIN_SECONDS && position < el.duration - RESUME_END_MARGIN && el.currentTime < position) {
      resumeText.textContent = `Resume from ${formatTime(position)}?`;
      resumePrompt.hidden = false;
      pendingResume.shown = true;
    } else {
      pendingResume = null;
    }
  }

  // Called for every track that becomes the loaded one. Any offer for the
  // previous track is dropped first, so switching before answering is safe.
  function offerResume(track) {
    hideResumePrompt();
    const saved = track.id != null ? positions.get(track.id) : undefined;
    if (!(saved > RESUME_MIN_SECONDS)) return;
    pendingResume = { track, position: saved, shown: false };
    evaluateResumeOffer();   // otherwise the element's loadedmetadata event calls it
  }

  resumeYes.addEventListener('click', () => {
    const offer = pendingResume;
    hideResumePrompt();
    if (!offer || offer.track !== tracks[trackIndex]) return;
    const el = activeEl();
    if (Number.isFinite(el.duration)) el.currentTime = offer.position;
  });

  resumeNo.addEventListener('click', () => {
    const offer = pendingResume;
    hideResumePrompt();
    if (offer && offer.track === tracks[trackIndex]) clearPosition(offer.track.id);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(true); });
  window.addEventListener('pagehide', () => savePosition(true));


  // ---------------------------------------------------------------------
  // Waveform seek bar. Peaks are computed once per track (cached in memory,
  // keyed by track id — or by url for a track that hasn't been assigned one
  // yet) and drawn as two identical bar charts stacked on top of each other:
  // a dim "unplayed" one underneath, and a bright "played" one in an
  // overflow:hidden wrapper whose width tracks playback position. Revealing
  // more of the played layer on every timeupdate is a CSS width change, not
  // a canvas redraw — the actual bars are only ever drawn twice per track
  // (once per layer), which is what keeps this cheap enough to update
  // continuously without extra battery cost on a phone.
  // ---------------------------------------------------------------------
  const WAVEFORM_PEAK_COUNT = 120;
  const waveformPeakCache = new Map();
  let waveformToken = 0; // guards a slow decode from drawing over a track switched to in the meantime

  // A dedicated context used only for decodeAudioData — never connected to
  // any output, so it does no real-time audio work and has nothing to do
  // with the playback graph (which setupAudioGraph() intentionally never
  // creates on iOS at all). Decoding doesn't need the context to be resumed.
  let waveformDecodeCtx = null;
  function getWaveformDecodeCtx() {
    if (!waveformDecodeCtx) waveformDecodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    return waveformDecodeCtx;
  }

  function waveformCacheKey(track) {
    return track.id != null ? `id:${track.id}` : `url:${track.url}`;
  }

  // Peaks are the max sample magnitude in each of numPeaks even-width
  // segments, taken across all channels and normalized so the loudest
  // segment reaches 1 — a coarse inner stride keeps this from walking every
  // sample of a long track, which matters more on a phone than a desktop.
  function generateWaveformPeaks(audioBuffer, numPeaks) {
    const length = audioBuffer.length;
    const channelCount = audioBuffer.numberOfChannels;
    const channels = [];
    for (let ch = 0; ch < channelCount; ch++) channels.push(audioBuffer.getChannelData(ch));
    const samplesPerPeak = Math.max(1, Math.floor(length / numPeaks));
    const stride = Math.max(1, Math.floor(samplesPerPeak / 200));
    const peaks = new Array(numPeaks).fill(0);

    for (let p = 0; p < numPeaks; p++) {
      const start = p * samplesPerPeak;
      const end = Math.min(length, start + samplesPerPeak);
      let max = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const data = channels[ch];
        for (let i = start; i < end; i += stride) {
          const v = data[i] < 0 ? -data[i] : data[i];
          if (v > max) max = v;
        }
      }
      peaks[p] = max;
    }

    const loudest = peaks.reduce((a, b) => (b > a ? b : a), 0) || 1;
    return peaks.map((v) => v / loudest);
  }

  function sizeWaveformCanvases() {
    const rect = progressBar.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    [[waveformBase, waveformBaseCtx], [waveformPlayed, waveformPlayedCtx]].forEach(([canvas, ctx]) => {
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    return { width: rect.width, height: rect.height };
  }

  function drawWaveformBars(ctx, peaks, width, height, color) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const gap = 2;
    const slot = width / peaks.length;
    const barWidth = Math.max(1, slot - gap);
    const minBarHeight = 2;
    peaks.forEach((p, i) => {
      const barHeight = Math.max(minBarHeight, p * height);
      const x = i * slot;
      const y = (height - barHeight) / 2;
      ctx.fillRect(x, y, barWidth, barHeight);
    });
  }

  function waveformAccentDimColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim() || 'rgba(255,255,255,0.2)';
  }
  function waveformAccentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
  }

  // A flat neutral placeholder while the real peaks are still decoding, so
  // there's never a blank bar while a track is loading.
  function drawWaveformPlaceholder() {
    const { width, height } = sizeWaveformCanvases();
    if (!width || !height) return;
    const flat = new Array(WAVEFORM_PEAK_COUNT).fill(0.18);
    drawWaveformBars(waveformBaseCtx, flat, width, height, waveformAccentDimColor());
    drawWaveformBars(waveformPlayedCtx, flat, width, height, waveformAccentColor());
  }

  function drawWaveformPeaks(peaks) {
    const { width, height } = sizeWaveformCanvases();
    if (!width || !height) return;
    drawWaveformBars(waveformBaseCtx, peaks, width, height, waveformAccentDimColor());
    drawWaveformBars(waveformPlayedCtx, peaks, width, height, waveformAccentColor());
  }

  let currentWaveformPeaks = null;

  function redrawCurrentWaveform() {
    if (currentWaveformPeaks) drawWaveformPeaks(currentWaveformPeaks);
    else drawWaveformPlaceholder();
  }
  window.addEventListener('resize', redrawCurrentWaveform);

  async function loadWaveformForTrack(track) {
    const token = ++waveformToken;
    const key = waveformCacheKey(track);
    const cached = waveformPeakCache.get(key);
    if (cached) {
      currentWaveformPeaks = cached;
      drawWaveformPeaks(cached);
      return;
    }

    currentWaveformPeaks = null;
    drawWaveformPlaceholder();

    try {
      const response = await fetch(track.url);
      const arrayBuffer = await response.arrayBuffer();
      // decodeAudioData detaches the buffer it's given, so this can't reuse
      // one already handed to something else — fetch() above gives it a
      // fresh one, independent of the <audio> element's own playback.
      const audioBuffer = await getWaveformDecodeCtx().decodeAudioData(arrayBuffer);
      const peaks = generateWaveformPeaks(audioBuffer, WAVEFORM_PEAK_COUNT);
      waveformPeakCache.set(key, peaks);
      if (token !== waveformToken) return; // a different track loaded while this was decoding
      currentWaveformPeaks = peaks;
      drawWaveformPeaks(peaks);
    } catch (err) {
      console.warn('Pulse: could not generate waveform', err);
      // leave the placeholder in place rather than showing nothing
    }
  }

  function resetProgressUI() {
    waveformPlayedClip.style.width = '0%';
    progressHandle.style.left = '0%';
    currentTimeEl.textContent = '0:00';
    durationEl.textContent = '0:00';
  }

  // Hard cut: used whenever crossfade is off, unavailable, or nothing is
  // currently playing (nothing to fade out of).
  function hardSwitch(index, autoplay) {
    savePosition(true);   // the outgoing track's spot, before anything changes
    if (!tracks.length) {
      trackIndex = 0;
      hideResumePrompt();
      activeEl().pause();
      activeEl().removeAttribute('src');
      document.getElementById('trackTitle').textContent = '—';
      document.getElementById('trackArtist').textContent = 'Add a track to get started';
      updateTrackArt(null);
      updateMediaSessionMetadata(null);
      resetProgressUI();
      renderLibrary();
      return;
    }
    trackIndex = (index + tracks.length) % tracks.length;
    const track = tracks[trackIndex];
    const el = activeEl();
    el.pause();
    el.src = track.url;
    setNowPlayingUI(track);
    resetProgressUI();
    orderPos = playOrder.indexOf(trackIndex);
    if (track.id != null) localStorage.setItem('pulse:lastTrackId', track.id);
    renderLibrary();
    if (autoplay) el.play().catch(() => {});
  }

  // Crossfades into a new track by playing it on the currently-idle audio
  // element and ramping gain between the two, falling back to a hard cut
  // when crossfade is off, the audio graph isn't ready yet, or nothing is
  // currently playing (there's nothing to fade out of).
  async function switchTrack(index, autoplay = true) {
    if (!tracks.length) { hardSwitch(index, autoplay); return; }
    index = (index + tracks.length) % tracks.length;

    const canCrossfade =
      audioCtx &&
      crossfadeSeconds > 0 &&
      isPlaying &&
      !crossfadeInProgress &&
      index !== trackIndex;

    if (!canCrossfade) {
      hardSwitch(index, autoplay);
      return;
    }

    crossfadeInProgress = true;
    const fromKey = activeSlot;
    const toKey = inactiveSlotKey();
    const fromEl = els[fromKey];
    const toEl = els[toKey];
    const fromGain = webAudioSlots[fromKey].gain.gain;
    const toGain = webAudioSlots[toKey].gain.gain;
    const track = tracks[index];

    toEl.src = track.url;
    toGain.cancelScheduledValues(audioCtx.currentTime);
    toGain.setValueAtTime(0, audioCtx.currentTime);
    try { await toEl.play(); } catch (err) { /* ignore */ }

    // A fade never takes more than a third of the incoming track, so a short
    // track can't spend its whole life fading in and its own end-of-track
    // fade always starts after this one has finished.
    const fadeSeconds = Math.min(crossfadeSeconds, Number.isFinite(toEl.duration) ? toEl.duration / 3 : Infinity);
    const now = audioCtx.currentTime;
    fromGain.cancelScheduledValues(now);
    fromGain.setValueAtTime(fromGain.value, now);
    fromGain.linearRampToValueAtTime(0, now + fadeSeconds);
    toGain.cancelScheduledValues(now);
    toGain.setValueAtTime(0, now);
    toGain.linearRampToValueAtTime(1, now + fadeSeconds);

    // Leaving the outgoing track: drop its spot if it played out, keep it if it was cut short.
    const outgoing = tracks[trackIndex];
    if (outgoing) {
      if (Number.isFinite(fromEl.duration) && fromEl.duration - fromEl.currentTime <= RESUME_END_MARGIN) clearPosition(outgoing.id);
      else savePosition(true);
    }

    activeSlot = toKey;
    trackIndex = index;
    orderPos = playOrder.indexOf(trackIndex);
    if (track.id != null) localStorage.setItem('pulse:lastTrackId', track.id);
    setNowPlayingUI(track);
    renderLibrary();

    setTimeout(() => {
      fromEl.pause();
      fromEl.currentTime = 0;
      fromEl.removeAttribute('src');
      fromGain.value = 1;
      crossfadeInProgress = false;
    }, fadeSeconds * 1000 + 150);
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function setPlayingUI(playing) {
    isPlaying = playing;
    playIcon.style.display = playing ? 'none' : 'block';
    pauseIcon.style.display = playing ? 'block' : 'none';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  playBtn.addEventListener('click', () => {
    if (!tracks.length) { addFilesBtn.click(); return; }
    setupAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    const el = activeEl();
    if (isPlaying) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  });

  function handleTimeUpdate(el) {
    if (!isActive(el) || isSeeking) return;
    if (pendingResume && el.currentTime >= pendingResume.position) hideResumePrompt();
    savePosition();
    const pct = el.duration ? (el.currentTime / el.duration) * 100 : 0;
    waveformPlayedClip.style.width = pct + '%';
    progressHandle.style.left = pct + '%';
    progressBar.setAttribute('aria-valuenow', Math.round(pct));
    currentTimeEl.textContent = formatTime(el.currentTime);

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && el.duration) {
      try {
        navigator.mediaSession.setPositionState({ duration: el.duration, playbackRate: el.playbackRate, position: el.currentTime });
      } catch (err) { /* ignore unsupported position state */ }
    }

    const remaining = el.duration - el.currentTime;
    if (
      audioCtx &&
      crossfadeSeconds > 0 &&
      !crossfadeInProgress &&
      !repeatBtn.classList.contains('toggled') &&
      tracks.length > 1 &&
      el.duration &&
      remaining > 0 &&
      remaining <= Math.min(crossfadeSeconds, el.duration / 3)
    ) {
      const nextIndex = playOrder[(orderPos + 1) % playOrder.length];
      switchTrack(nextIndex, true);
    }
  }

  function handleEnded(el) {
    if (!isActive(el)) return;
    const finished = tracks[trackIndex];
    if (finished) clearPosition(finished.id);
    if (repeatBtn.classList.contains('toggled')) {
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    if (!crossfadeInProgress) stepTrack(1, true);
  }

  [audioA, audioB].forEach((el) => {
    el.addEventListener('play', () => { if (isActive(el)) setPlayingUI(true); });
    el.addEventListener('pause', () => { if (isActive(el)) { setPlayingUI(false); savePosition(true); } });
    el.addEventListener('loadedmetadata', () => {
      if (isActive(el)) {
        durationEl.textContent = formatTime(el.duration);
        evaluateResumeOffer();
      }
    });
    el.addEventListener('timeupdate', () => handleTimeUpdate(el));
    el.addEventListener('ended', () => handleEnded(el));
  });

  // Lets the OS/browser media notification show track info and respond to
  // hardware media keys (headphones, lock screen, etc).
  //
  // play/pause must be idempotent, not a toggle: the OS can send "pause" for
  // something the audio element already paused on its own (unplugging
  // headphones), and toggling that would start the music back up.
  function handleMediaPlay() { if (!isPlaying) playBtn.click(); }
  function handleMediaPause() { if (isPlaying) playBtn.click(); }

  if ('mediaSession' in navigator) {
    const setHandler = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (err) { /* unsupported action */ }
    };
    setHandler('play', handleMediaPlay);
    setHandler('pause', handleMediaPause);
    setHandler('previoustrack', () => prevBtn.click());
    setHandler('nexttrack', () => nextBtn.click());
    setHandler('seekto', (details) => {
      const el = activeEl();
      if (details.seekTime != null && el.duration) el.currentTime = details.seekTime;
    });
  }

  function seekToClientX(clientX) {
    const el = activeEl();
    const rect = progressBar.getBoundingClientRect();
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.min(1, Math.max(0, pct));
    waveformPlayedClip.style.width = (pct * 100) + '%';
    progressHandle.style.left = (pct * 100) + '%';
    if (el.duration) {
      el.currentTime = pct * el.duration;
      currentTimeEl.textContent = formatTime(el.currentTime);
    }
  }

  progressBar.addEventListener('pointerdown', (e) => {
    isSeeking = true;
    seekToClientX(e.clientX);
    progressBar.setPointerCapture(e.pointerId);
  });
  progressBar.addEventListener('pointermove', (e) => {
    if (isSeeking) seekToClientX(e.clientX);
  });
  progressBar.addEventListener('pointerup', () => { isSeeking = false; });

  // iOS ignores audio.volume (not settable, always reads back 1) in both
  // Safari and Capacitor's WKWebView — volume there is hardware-buttons
  // only. Capacitor's injected global is checked first when present; 'web'
  // means a plain browser, which could still be mobile Safari, so that case
  // falls through to the UA check. iPadOS 13+ Safari reports a Mac UA, hence
  // the touch-points check.
  function detectIOS() {
    const cap = window.Capacitor;
    if (cap && typeof cap.getPlatform === 'function') {
      const platform = cap.getPlatform();
      if (platform === 'ios') return true;
      if (platform === 'android') return false;
    }
    if (/iPad|iPhone|iPod/.test(navigator.userAgent || '')) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }
  const IS_IOS = detectIOS();

  if (IS_IOS) {
    volumeSlider.hidden = true;
    document.getElementById('volumeIosNote').hidden = false;
    document.getElementById('audioFxSettings').hidden = true;
    document.getElementById('iosAudioNote').hidden = false;
  }

  function applyVolume() {
    if (IS_IOS) return;
    const v = volumeSlider.value / 100;
    audioA.volume = v;
    audioB.volume = v;
  }

  volumeSlider.addEventListener('input', () => {
    applyVolume();
    volumeIcon.style.opacity = Number(volumeSlider.value) === 0 ? '0.4' : '1';
    localStorage.setItem('pulse:volume', volumeSlider.value);
  });

  shuffleBtn.addEventListener('click', () => {
    const active = shuffleBtn.classList.toggle('toggled');
    shuffleBtn.setAttribute('aria-pressed', active);
    localStorage.setItem('pulse:shuffle', active ? '1' : '0');
    rebuildOrder();
  });

  repeatBtn.addEventListener('click', () => {
    const active = repeatBtn.classList.toggle('toggled');
    repeatBtn.setAttribute('aria-pressed', active);
    localStorage.setItem('pulse:repeat', active ? '1' : '0');
  });

  function setCrossfadeSeconds(value) {
    const seconds = Math.min(5, Math.max(0, Number(value) || 0));
    crossfadeSeconds = seconds;
    crossfadeSlider.value = seconds;
    crossfadeValue.textContent = seconds === 0 ? 'Off' : `${seconds}s`;
  }

  crossfadeSlider.addEventListener('input', () => {
    setCrossfadeSeconds(crossfadeSlider.value);
    localStorage.setItem('pulse:crossfadeSeconds', String(crossfadeSeconds));
  });

  // Direct .value sets step instantly, which can click/zipper when a slider
  // is dragged quickly (many gain jumps per second). setTargetAtTime glides
  // to each new value instead — short enough to still feel immediate.
  const EQ_SMOOTHING_SECONDS = 0.015;

  function applyEQ() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const bass = Number(eqBassSlider.value);
    const mid = Number(eqMidSlider.value);
    const treble = Number(eqTrebleSlider.value);
    ['A', 'B'].forEach((key) => {
      webAudioSlots[key].bass.gain.setTargetAtTime(bass, now, EQ_SMOOTHING_SECONDS);
      webAudioSlots[key].mid.gain.setTargetAtTime(mid, now, EQ_SMOOTHING_SECONDS);
      webAudioSlots[key].treble.gain.setTargetAtTime(treble, now, EQ_SMOOTHING_SECONDS);
    });
    updateEQPresetHighlight();
  }

  const EQ_PRESETS = {
    flat: { bass: 0, mid: 0, treble: 0 },
    bass: { bass: 6, mid: 0, treble: 0 },
    vocal: { bass: 0, mid: 4, treble: 0 },
  };
  const eqPresetButtons = [...document.querySelectorAll('.eq-preset-btn')];

  function updateEQPresetHighlight() {
    const bass = Number(eqBassSlider.value);
    const mid = Number(eqMidSlider.value);
    const treble = Number(eqTrebleSlider.value);
    eqPresetButtons.forEach((btn) => {
      const p = EQ_PRESETS[btn.dataset.preset];
      btn.classList.toggle('active', p.bass === bass && p.mid === mid && p.treble === treble);
    });
  }

  function setEQValues(bass, mid, treble) {
    eqBassSlider.value = bass;
    eqMidSlider.value = mid;
    eqTrebleSlider.value = treble;
    localStorage.setItem('pulse:eqBass', bass);
    localStorage.setItem('pulse:eqMid', mid);
    localStorage.setItem('pulse:eqTreble', treble);
    applyEQ();
  }

  eqPresetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = EQ_PRESETS[btn.dataset.preset];
      setEQValues(p.bass, p.mid, p.treble);
    });
  });

  [[eqBassSlider, 'pulse:eqBass'], [eqMidSlider, 'pulse:eqMid'], [eqTrebleSlider, 'pulse:eqTreble']].forEach(([slider, key]) => {
    slider.addEventListener('input', () => {
      localStorage.setItem(key, slider.value);
      applyEQ();
    });
  });

  prevBtn.addEventListener('click', () => {
    // Restart current track if more than 3s in, otherwise go to previous track
    if (activeEl().currentTime > 3) {
      activeEl().currentTime = 0;
    } else {
      stepTrack(-1, isPlaying);
    }
  });

  nextBtn.addEventListener('click', () => {
    stepTrack(1, isPlaying);
  });

  // ---------------------------------------------------------------------
  // Library: import + browse tracks
  // ---------------------------------------------------------------------

  const libraryBtn = document.getElementById('libraryBtn');
  const libraryPanel = document.getElementById('libraryPanel');
  const libraryList = document.getElementById('libraryList');
  const libCountEl = document.getElementById('libCount');
  const addFilesBtn = document.getElementById('addFilesBtn');
  const addFolderBtn = document.getElementById('addFolderBtn');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const dropOverlay = document.getElementById('dropOverlay');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importInput = document.getElementById('importInput');
  const driveImportBtn = document.getElementById('driveImportBtn');
  const driveDisconnectBtn = document.getElementById('driveDisconnectBtn');
  const convertVideoBtn = document.getElementById('convertVideoBtn');
  const videoInput = document.getElementById('videoInput');
  const syncSendBtn = document.getElementById('syncSendBtn');
  const syncReceiveBtn = document.getElementById('syncReceiveBtn');
  const syncCodeDisplay = document.getElementById('syncCodeDisplay');
  const syncCodeValue = document.getElementById('syncCodeValue');
  const syncCodeEntry = document.getElementById('syncCodeEntry');
  const syncCodeInput = document.getElementById('syncCodeInput');
  const syncSubmitBtn = document.getElementById('syncSubmitBtn');

  // Inline rename state. Keyed by the track object itself (not its index),
  // so a removal or reorder mid-edit can't leave the wrong row in edit mode.
  let editingTrack = null;
  let editDraft = { title: '', artist: '' };
  let editError = '';

  // Library views and playlists. currentView is what the list is showing;
  // playContext is the list the playing track was started from, which is
  // what next/previous/auto-advance follow.
  let currentView = 'all';
  let playContext = 'all';
  let playlists = [];
  let menuTrack = null;
  const viewSelect = document.getElementById('viewSelect');
  const newPlaylistBtn = document.getElementById('newPlaylistBtn');
  const deletePlaylistBtn = document.getElementById('deletePlaylistBtn');
  const newPlaylistForm = document.getElementById('newPlaylistForm');
  const newPlaylistName = document.getElementById('newPlaylistName');
  const newPlaylistCancel = document.getElementById('newPlaylistCancel');
  const librarySearchInput = document.getElementById('librarySearch');
  const librarySearchClear = document.getElementById('librarySearchClear');
  const libraryMoodChips = document.getElementById('libraryMoodChips');

  // Search/mood filtering only ever changes what renderLibrary() draws —
  // never the underlying tracks/playlist data.
  let librarySearchText = '';
  let libraryMoodFilter = null;
  let librarySearchDebounce = null;

  function moodChipColor(mood) {
    const p = moodPalettes[mood];
    return `hsl(${p.hue}, ${p.sat}%, ${p.light}%)`;
  }

  MOODS.forEach((mood) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lib-mood-chip';
    chip.dataset.mood = mood;
    chip.setAttribute('aria-pressed', 'false');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = moodChipColor(mood);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(mood.charAt(0).toUpperCase() + mood.slice(1)));
    // Clicking the already-active chip clears it — that also covers the
    // "or a Clear chip" case from the brief without a second control.
    chip.addEventListener('click', () => {
      libraryMoodFilter = libraryMoodFilter === mood ? null : mood;
      renderLibrary();
    });
    libraryMoodChips.appendChild(chip);
  });

  function filterTracksForDisplay(list) {
    let out = list;
    if (libraryMoodFilter) out = out.filter((t) => t.mood === libraryMoodFilter);
    const q = librarySearchText.trim().toLowerCase();
    if (q) out = out.filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
    return out;
  }

  librarySearchInput.addEventListener('input', () => {
    librarySearchClear.hidden = librarySearchInput.value.trim() === '';
    // Debounced so a fast typist on a phone isn't re-rendering the list
    // (now somewhat heavier per row, with artwork) on every keystroke.
    clearTimeout(librarySearchDebounce);
    librarySearchDebounce = setTimeout(() => {
      librarySearchText = librarySearchInput.value;
      renderLibrary();
    }, 130);
  });
  librarySearchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  librarySearchClear.addEventListener('click', () => {
    librarySearchInput.value = '';
    librarySearchText = '';
    clearTimeout(librarySearchDebounce);
    librarySearchClear.hidden = true;
    renderLibrary();
    librarySearchInput.focus();
  });

  const ICON_TRASH = deletePlaylistBtn.innerHTML;

  function openLibrary() {
    closeSettings();
    libraryPanel.classList.add('open');
    libraryBtn.setAttribute('aria-pressed', 'true');
  }
  function closeLibrary() {
    libraryPanel.classList.remove('open');
    libraryBtn.setAttribute('aria-pressed', 'false');
    if (editingTrack) cancelEdit();
    if (menuTrack) { menuTrack = null; renderLibrary(); }
  }
  libraryBtn.addEventListener('click', () => {
    if (libraryPanel.classList.contains('open')) closeLibrary(); else openLibrary();
  });

  function openSettings() {
    closeLibrary();
    settingsPanel.classList.add('open');
    settingsBtn.setAttribute('aria-pressed', 'true');
  }
  function closeSettings() {
    settingsPanel.classList.remove('open');
    settingsBtn.setAttribute('aria-pressed', 'false');
  }
  settingsBtn.addEventListener('click', () => {
    if (settingsPanel.classList.contains('open')) closeSettings(); else openSettings();
  });

  // Global shortcuts: space to play/pause, left/right to seek, up/down for
  // volume. Skipped while a form control has focus so native behavior
  // (e.g. arrow keys on a focused range slider) isn't double-handled.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || el.isContentEditable;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLibrary(); closeSettings(); return; }
    if (isTypingTarget(document.activeElement)) return;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const el = activeEl();
      if (el.duration) el.currentTime = Math.min(el.duration, el.currentTime + 5);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const el = activeEl();
      if (el.duration) el.currentTime = Math.max(0, el.currentTime - 5);
    } else if (e.key === 'ArrowUp' && !IS_IOS) {
      e.preventDefault();
      volumeSlider.value = Math.min(100, Number(volumeSlider.value) + 5);
      volumeSlider.dispatchEvent(new Event('input'));
    } else if (e.key === 'ArrowDown' && !IS_IOS) {
      e.preventDefault();
      volumeSlider.value = Math.max(0, Number(volumeSlider.value) - 5);
      volumeSlider.dispatchEvent(new Event('input'));
    }
  });

  const ICON_HANDLE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>';
  const ICON_PLAYLIST_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="14" y2="6"></line><line x1="3" y1="12" x2="14" y2="12"></line><line x1="3" y1="18" x2="10" y2="18"></line><line x1="18" y1="13" x2="18" y2="21"></line><line x1="14" y1="17" x2="22" y2="17"></line></svg>';

  // The list shows either the whole library (in its custom order) or one
  // playlist's tracks in that playlist's own order.
  function currentPlaylist() {
    return currentView === 'all' ? null : (playlists.find((p) => p.id === currentView) || null);
  }

  function viewTracks() {
    const pl = currentPlaylist();
    if (!pl) return tracks;
    return pl.trackIds.map((id) => tracks.find((t) => t.id === id)).filter(Boolean);
  }

  let viewSelectSignature = '';
  function renderViewSelect() {
    if (currentView !== 'all' && !currentPlaylist()) currentView = 'all';
    // Only rebuild the options when the set of playlists changed — this runs
    // on every list render, and rebuilding while a native picker is open
    // would close it.
    const signature = playlists.map((p) => `${p.id}:${p.name}`).join('|');
    if (signature !== viewSelectSignature) {
      viewSelectSignature = signature;
      viewSelect.innerHTML = '';
      viewSelect.appendChild(new Option('All Tracks', 'all'));
      playlists.forEach((p) => viewSelect.appendChild(new Option(p.name, String(p.id))));
    }
    viewSelect.value = String(currentView);
    deletePlaylistBtn.hidden = currentView === 'all';
  }

  function savePlaylist(pl) {
    dbPutPlaylist(pl).catch((err) => console.warn('Pulse: failed to save playlist', err));
  }

  // Edit timestamps (renames, playlist edits, deletes, track order) come from
  // a logical clock, not raw Date.now(). The clock never runs behind any
  // timestamp this device has seen: after receiving someone else's edit, the
  // next local edit is guaranteed to be stamped later than it, even if this
  // device's own clock is running slow. That keeps "the newer edit wins"
  // right whenever one edit happened after seeing the other; only genuinely
  // simultaneous edits fall back to the wall clocks.
  const CLOCK_FLOOR_KEY = 'pulse:clockFloor';
  let clockFloor = 0;
  try { clockFloor = Number(localStorage.getItem(CLOCK_FLOOR_KEY)) || 0; } catch (err) { /* storage unavailable */ }

  function raiseClockFloor(ts) {
    if (ts <= clockFloor) return;
    clockFloor = ts;
    try { localStorage.setItem(CLOCK_FLOOR_KEY, String(clockFloor)); } catch (err) { /* storage unavailable */ }
  }

  function observeStamp(ts) {
    raiseClockFloor(Number(ts) || 0);
  }

  function nextStamp() {
    const stamp = Math.max(Date.now(), clockFloor + 1);
    raiseClockFloor(stamp);
    return stamp;
  }

  // True if the incoming copy should replace the local one. Equal stamps are
  // broken by comparing content, so two devices always pick the same winner.
  function stampWins(incomingAt, localAt, incomingKey, localKey) {
    return incomingAt > localAt || (incomingAt === localAt && incomingAt > 0 && incomingKey > localKey);
  }

  function playlistKey(name, hashes) {
    return `${name}|${hashes.join(',')}`;
  }

  // The whole custom track order is one newest-wins value.
  const LIBRARY_ORDERED_AT_KEY = 'pulse:libraryOrderedAt';
  let libraryOrderedAt = 0;
  try { libraryOrderedAt = Number(localStorage.getItem(LIBRARY_ORDERED_AT_KEY)) || 0; } catch (err) { /* storage unavailable */ }

  function setLibraryOrderedAt(ts) {
    libraryOrderedAt = ts;
    try { localStorage.setItem(LIBRARY_ORDERED_AT_KEY, String(ts)); } catch (err) { /* storage unavailable */ }
  }

  // Playlists sync by stable identity (uid) and track content hash, because
  // local ids differ between devices. Deleting a playlist leaves a tombstone
  // so the other device's older copy can't bring it back.
  const DELETED_PLAYLISTS_KEY = 'pulse:deletedPlaylists';

  function newPlaylistUid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function getPlaylistTombstones() {
    try { return JSON.parse(localStorage.getItem(DELETED_PLAYLISTS_KEY)) || {}; } catch (err) { return {}; }
  }

  function setPlaylistTombstones(map) {
    try { localStorage.setItem(DELETED_PLAYLISTS_KEY, JSON.stringify(map)); } catch (err) { /* storage unavailable */ }
  }

  function togglePlaylistMember(pl, track) {
    const at = pl.trackIds.indexOf(track.id);
    if (at >= 0) pl.trackIds.splice(at, 1); else pl.trackIds.push(track.id);
    pl.updatedAt = nextStamp();
    savePlaylist(pl);
    if (playContext === pl.id) rebuildOrder();
    renderLibrary();
  }

  async function createPlaylist(rawName) {
    const name = rawName.trim();
    if (!name) return false;
    const pl = { uid: newPlaylistUid(), name, trackIds: [], updatedAt: nextStamp() };
    let id = null;
    try { id = await dbAddPlaylist(pl); } catch (err) { console.warn('Pulse: failed to save playlist', err); }
    pl.id = id != null ? id : Date.now();
    playlists.push(pl);
    currentView = pl.id;
    renderLibrary();
    return true;
  }

  function deleteCurrentPlaylist() {
    const pl = currentPlaylist();
    if (!pl) return;
    playlists = playlists.filter((p) => p !== pl);
    const tombstones = getPlaylistTombstones();
    tombstones[pl.uid] = nextStamp();
    setPlaylistTombstones(tombstones);
    dbDeletePlaylist(pl.id).catch((err) => console.warn('Pulse: failed to delete playlist', err));
    currentView = 'all';
    if (playContext === pl.id) { playContext = 'all'; rebuildOrder(); }
    renderLibrary();
  }

  // Puts the whole library into a new order, keeping the loaded track loaded
  // and the play queue pointing at the same tracks.
  function setLibrarySequence(seq) {
    const before = tracks.slice();
    const current = tracks[trackIndex];
    tracks.splice(0, tracks.length, ...seq);
    trackIndex = Math.max(0, tracks.indexOf(current));
    tracks.forEach((t, i) => { t.order = i; });
    dbSetOrders(tracks.filter((t) => t.id != null).map((t) => ({ id: t.id, order: t.order }))).catch((err) => {
      console.warn('Pulse: failed to save track order', err);
    });
    if (playContext === 'all' && !shuffleBtn.classList.contains('toggled')) {
      rebuildOrder();
    } else {
      // The queue holds indices into `tracks`, which just moved underneath it.
      playOrder = playOrder.map((i) => tracks.indexOf(before[i]));
      orderPos = playOrder.indexOf(trackIndex);
    }
  }

  // Applies a zip's order.json. Returns true if the on-screen order changed.
  async function mergeLibraryOrder(data) {
    const at = Number(data && data.at) || 0;
    const hashes = Array.isArray(data && data.tracks) ? data.tracks.filter((h) => typeof h === 'string') : [];
    observeStamp(at);
    if (!at || !hashes.length) return false;

    const byHash = new Map();
    for (const t of tracks) {
      const hash = await ensureTrackHash(t);
      if (hash && !byHash.has(hash)) byHash.set(hash, t);
    }
    // Their order first; anything they don't have (added here since) after.
    const seq = [];
    const used = new Set();
    hashes.forEach((h) => {
      const t = byHash.get(h);
      if (t && !used.has(t)) { seq.push(t); used.add(t); }
    });
    tracks.forEach((t) => { if (!used.has(t)) seq.push(t); });

    const localKey = tracks.map((t) => t.hash || '').join(',');
    if (!stampWins(at, libraryOrderedAt, hashes.join(','), localKey)) return false;
    setLibraryOrderedAt(at);
    const changed = seq.some((t, i) => t !== tracks[i]);
    if (changed) setLibrarySequence(seq);
    return changed;
  }

  // Moves one track within whatever list is on screen. toIndex is the track's
  // position in the resulting list.
  function reorderVisible(track, toIndex) {
    const visible = viewTracks();
    const from = visible.indexOf(track);
    if (from < 0 || toIndex === from) return;
    const seq = visible.filter((t) => t !== track);
    seq.splice(toIndex, 0, track);

    const pl = currentPlaylist();
    if (pl) {
      pl.trackIds = seq.map((t) => t.id);
      pl.updatedAt = nextStamp();
      savePlaylist(pl);
      if (playContext === pl.id) rebuildOrder();
    } else {
      setLibrarySequence(seq);
      setLibraryOrderedAt(nextStamp());
    }
    renderLibrary();
  }

  // ---- drag to reorder ----------------------------------------------------
  // Pointer events on the handle rather than the HTML5 drag-and-drop API:
  // that API doesn't fire from touch on iPhone, which is where this is used.
  let drag = null;
  let renderDeferred = false;

  function updateDropTarget() {
    const rows = [...libraryList.querySelectorAll('.lib-row[data-track-id]')].filter((r) => r !== drag.row);
    rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    drag.target = null;
    if (!rows.length) return;
    const y = drag.lastY;
    const next = rows.find((r) => {
      const rect = r.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    if (next) { drag.target = next; drag.before = true; next.classList.add('drop-before'); }
    else { drag.target = rows[rows.length - 1]; drag.before = false; drag.target.classList.add('drop-after'); }
  }

  function positionDraggedRow() {
    const dy = (drag.lastY - drag.startY) + (libraryList.scrollTop - drag.startScroll);
    drag.row.style.transform = `translateY(${dy}px)`;
  }

  // Keeps scrolling the list while the pointer rests near its top/bottom edge.
  function dragAutoScroll() {
    if (!drag) return;
    const rect = libraryList.getBoundingClientRect();
    const edge = 28;
    let step = 0;
    if (drag.lastY < rect.top + edge) step = -10;
    else if (drag.lastY > rect.bottom - edge) step = 10;
    if (step) {
      libraryList.scrollTop += step;
      positionDraggedRow();
      updateDropTarget();
    }
    drag.raf = requestAnimationFrame(dragAutoScroll);
  }

  function startDrag(e, track, row, handle) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    if (menuTrack) {
      menuTrack = null;
      libraryList.querySelectorAll('.lib-row-menu').forEach((n) => n.remove());
    }
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    drag = { track, row, handle, startY: e.clientY, lastY: e.clientY, startScroll: libraryList.scrollTop, target: null, before: true, raf: 0 };
    row.classList.add('dragging');
    document.body.classList.add('is-dragging');
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragCancel);
    drag.raf = requestAnimationFrame(dragAutoScroll);
  }

  function onDragMove(e) {
    if (!drag) return;
    drag.lastY = e.clientY;
    positionDraggedRow();
    updateDropTarget();
  }

  function finishDrag() {
    const { row, handle, raf } = drag;
    cancelAnimationFrame(raf);
    handle.removeEventListener('pointermove', onDragMove);
    handle.removeEventListener('pointerup', onDragEnd);
    handle.removeEventListener('pointercancel', onDragCancel);
    row.classList.remove('dragging');
    row.style.transform = '';
    libraryList.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    document.body.classList.remove('is-dragging');
    const finished = drag;
    drag = null;
    return finished;
  }

  function onDragEnd() {
    if (!drag) return;
    const { track, target, before } = finishDrag();
    if (target) {
      const others = viewTracks().filter((t) => t !== track);
      const at = others.indexOf(target._track);
      if (at >= 0) reorderVisible(track, at + (before ? 0 : 1));
    }
    if (renderDeferred) { renderDeferred = false; renderLibrary(); }
  }

  function onDragCancel() {
    if (!drag) return;
    finishDrag();
    if (renderDeferred) { renderDeferred = false; renderLibrary(); }
  }

  function moveByKey(track, delta) {
    const visible = viewTracks();
    const from = visible.indexOf(track);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visible.length) return;
    reorderVisible(track, to);
    const handle = libraryList.querySelector(`.lib-row[data-track-id="${track.id}"] .lib-row-handle`);
    if (handle) handle.focus();
  }

  function makeHandle(track, row) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'lib-row-handle';
    handle.title = 'Drag to reorder';
    handle.setAttribute('aria-label', `Reorder ${track.title} — drag, or press the up and down arrow keys`);
    handle.innerHTML = ICON_HANDLE;
    handle.addEventListener('pointerdown', (e) => startDrag(e, track, row, handle));
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveByKey(track, e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    return handle;
  }

  function buildPlaylistMenu(track) {
    const menu = document.createElement('div');
    menu.className = 'lib-row-menu';
    if (!playlists.length) {
      const msg = document.createElement('p');
      msg.className = 'lib-menu-empty';
      msg.textContent = 'No playlists yet — make one with the + above.';
      menu.appendChild(msg);
      return menu;
    }
    playlists.forEach((pl) => {
      const member = pl.trackIds.includes(track.id);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lib-menu-item' + (member ? ' member' : '');
      item.textContent = (member ? '✓ ' : '') + pl.name;
      item.setAttribute('aria-pressed', member ? 'true' : 'false');
      item.title = member ? `Remove from ${pl.name}` : `Add to ${pl.name}`;
      item.addEventListener('click', () => togglePlaylistMember(pl, track));
      menu.appendChild(item);
    });
    return menu;
  }

  function renderLibrary() {
    libCountEl.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    // A drag owns the list DOM until it ends (auto-advance and friends also
    // call this); the pending render runs when the drag finishes.
    if (drag) { renderDeferred = true; return; }
    renderViewSelect();

    // Other code paths re-render this list (adding a track, auto-advance);
    // remember which edit field had focus so a re-render doesn't drop it.
    const focusedEl = document.activeElement;
    const focusedField = editingTrack && libraryList.contains(focusedEl) ? focusedEl.dataset.editField : null;
    const caret = focusedField ? focusedEl.selectionStart : null;
    libraryList.innerHTML = '';

    if (editingTrack && !tracks.includes(editingTrack)) editingTrack = null;
    if (menuTrack && !tracks.includes(menuTrack)) menuTrack = null;

    librarySearchClear.hidden = librarySearchInput.value.trim() === '';
    [...libraryMoodChips.children].forEach((chip) => {
      const isActive = chip.dataset.mood === libraryMoodFilter;
      chip.classList.toggle('active', isActive);
      chip.setAttribute('aria-pressed', String(isActive));
    });

    const pl = currentPlaylist();
    const unfiltered = viewTracks();
    const visible = filterTracksForDisplay(unfiltered);

    if (!unfiltered.length) {
      const empty = document.createElement('p');
      empty.className = 'lib-empty';
      empty.textContent = pl
        ? 'No tracks in this playlist yet — switch to All Tracks and use the playlist button on a track to add it.'
        : 'No tracks yet — use the + or folder button above, or drop mp3 files anywhere on the page.';
      libraryList.appendChild(empty);
      return;
    }
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'lib-empty';
      empty.textContent = 'No tracks match.';
      libraryList.appendChild(empty);
      return;
    }

    visible.forEach((track) => {
      const i = tracks.indexOf(track);
      const row = document.createElement('div');
      row.className = 'lib-row' + (i === trackIndex ? ' active' : '');
      row.dataset.trackId = track.id == null ? '' : track.id;
      row._track = track;

      if (track === editingTrack) {
        buildEditRow(row);
        libraryList.appendChild(row);
        return;
      }

      // Only tracks persisted to IndexedDB (they have an id) can be renamed,
      // reordered, or put in playlists.
      if (track.id != null) row.appendChild(makeHandle(track, row));

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'lib-row-main';

      if (track.artworkUrl) {
        const art = document.createElement('img');
        art.className = 'lib-row-art';
        art.src = track.artworkUrl;
        art.alt = '';
        main.appendChild(art);
      }

      const textWrap = document.createElement('span');
      textWrap.className = 'lib-row-text';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'lib-row-title';
      titleSpan.textContent = track.title;

      const artistSpan = document.createElement('span');
      artistSpan.className = 'lib-row-artist';
      artistSpan.textContent = track.artist;

      textWrap.appendChild(titleSpan);
      textWrap.appendChild(artistSpan);
      main.appendChild(textWrap);
      main.addEventListener('click', () => {
        // Next/previous/auto-advance follow the list this track was started from.
        if (playContext !== currentView) { playContext = currentView; rebuildOrder(); }
        switchTrack(i, true);
        closeLibrary();
      });
      row.appendChild(main);

      if (track.id != null) {
        row.appendChild(makeIconButton('lib-row-icon-btn', `Playlists for ${track.title}`, ICON_PLAYLIST_ADD, (e) => {
          e.stopPropagation();
          menuTrack = menuTrack === track ? null : track;
          renderLibrary();
        }));
        row.appendChild(makeIconButton('lib-row-icon-btn', `Rename ${track.title}`, ICON_PENCIL, (e) => {
          e.stopPropagation();
          startEdit(track);
        }));
      }

      // In a playlist the × takes a track out of the playlist only; in All
      // Tracks it deletes the track from the library.
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'lib-row-remove';
      removeBtn.setAttribute('aria-label', pl ? `Remove ${track.title} from ${pl.name}` : `Remove ${track.title}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pl) togglePlaylistMember(pl, track); else removeTrack(i);
      });
      row.appendChild(removeBtn);
      libraryList.appendChild(row);

      if (track === menuTrack) libraryList.appendChild(buildPlaylistMenu(track));
    });

    if (focusedField) {
      const input = libraryList.querySelector(`[data-edit-field="${focusedField}"]`);
      if (input) {
        input.focus();
        if (caret != null) input.setSelectionRange(caret, caret);
      }
    }
  }

  viewSelect.addEventListener('change', () => {
    const v = viewSelect.value;
    currentView = v === 'all' ? 'all' : Number(v);
    menuTrack = null;
    renderLibrary();
  });

  newPlaylistBtn.addEventListener('click', () => {
    newPlaylistForm.hidden = !newPlaylistForm.hidden;
    if (!newPlaylistForm.hidden) { newPlaylistName.value = ''; newPlaylistName.focus(); }
  });
  newPlaylistCancel.addEventListener('click', () => { newPlaylistForm.hidden = true; });
  newPlaylistName.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); newPlaylistForm.hidden = true; }
  });
  newPlaylistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await createPlaylist(newPlaylistName.value)) newPlaylistForm.hidden = true;
  });

  // Deleting a playlist takes two clicks (the second within 3s), instead of
  // a native confirm() dialog, which webviews handle inconsistently.
  let deleteArmTimer = null;
  deletePlaylistBtn.addEventListener('click', () => {
    if (deleteArmTimer) {
      clearTimeout(deleteArmTimer);
      deleteArmTimer = null;
      deletePlaylistBtn.classList.remove('lib-delete-armed');
      deletePlaylistBtn.textContent = '';
      deletePlaylistBtn.innerHTML = ICON_TRASH;
      deleteCurrentPlaylist();
      return;
    }
    deletePlaylistBtn.classList.add('lib-delete-armed');
    deletePlaylistBtn.textContent = 'Delete?';
    deleteArmTimer = setTimeout(() => {
      deleteArmTimer = null;
      deletePlaylistBtn.classList.remove('lib-delete-armed');
      deletePlaylistBtn.innerHTML = ICON_TRASH;
    }, 3000);
  });

  const ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  function makeIconButton(className, label, svgMarkup, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = svgMarkup;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function makeEditInput(field, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.value = editDraft[field];
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.dataset.editField = field;
    input.addEventListener('input', () => { editDraft[field] = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEdit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        cancelEdit();
      }
    });
    return input;
  }

  function buildEditRow(row) {
    row.classList.add('editing');

    const fields = document.createElement('div');
    fields.className = 'lib-row-edit';
    fields.appendChild(makeEditInput('title', 'Title'));
    fields.appendChild(makeEditInput('artist', 'Artist'));
    if (editError) {
      const msg = document.createElement('p');
      msg.className = 'lib-row-edit-error';
      msg.setAttribute('role', 'alert');
      msg.textContent = editError;
      fields.appendChild(msg);
    }

    row.appendChild(fields);
    row.appendChild(makeIconButton('lib-row-icon-btn', 'Save name', ICON_CHECK, () => saveEdit()));
    row.appendChild(makeIconButton('lib-row-icon-btn', 'Cancel rename', ICON_CLOSE, () => cancelEdit()));
  }

  function startEdit(track) {
    editingTrack = track;
    editDraft = { title: track.title, artist: track.artist };
    editError = '';
    renderLibrary();
    const input = libraryList.querySelector('[data-edit-field="title"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function cancelEdit() {
    editingTrack = null;
    editError = '';
    renderLibrary();
  }

  function saveEdit() {
    const track = editingTrack;
    if (!track) return;

    const title = editDraft.title.trim();
    if (!title) {
      editError = "Title can't be empty.";
      renderLibrary();
      const input = libraryList.querySelector('[data-edit-field="title"]');
      if (input) input.focus();
      return;
    }
    // Same fallback the importer uses when a file has no artist info.
    const artist = editDraft.artist.trim() || 'Unknown Artist';

    const changed = title !== track.title || artist !== track.artist;
    editingTrack = null;
    editError = '';
    // Saving without changing anything isn't a rename: don't stamp it, or
    // it would outrank a genuinely newer rename made on another device.
    if (changed) {
      track.title = title;
      track.artist = artist;
      track.renamedAt = nextStamp();
      if (tracks[trackIndex] === track) setNowPlayingUI(track);
    }
    renderLibrary();

    if (changed && track.id != null) {
      dbUpdateTrack(track.id, { title, artist, renamedAt: track.renamedAt }).catch((err) => {
        console.warn('Pulse: failed to save renamed track to storage', err);
      });
    }
  }

  // Removes a track from the library, storage, and (if it's the one
  // currently loaded) playback — reloading whatever now sits at that
  // position, or clearing to the empty state if the library is empty.
  async function removeTrack(index) {
    if (index < 0 || index >= tracks.length) return;
    const [removed] = tracks.splice(index, 1);
    const wasActive = index === trackIndex;

    knownFileKeys.delete(`${removed.name}:${removed.size}`);
    if (removed.url) URL.revokeObjectURL(removed.url);
    if (removed.artworkUrl) URL.revokeObjectURL(removed.artworkUrl);

    if (removed.id != null) {
      dbDeleteTrack(removed.id).catch((err) => {
        console.warn('Pulse: failed to delete track from storage', err);
      });
      playlists.forEach((pl) => {
        const at = pl.trackIds.indexOf(removed.id);
        if (at >= 0) { pl.trackIds.splice(at, 1); savePlaylist(pl); }
      });
      clearPosition(removed.id);
      if (pendingResume && pendingResume.track === removed) hideResumePrompt();
    }

    if (!tracks.length) {
      trackIndex = 0;
      playOrder = [];
      hardSwitch(0, false);
      return;
    }

    trackIndex = index < trackIndex ? trackIndex - 1 : Math.min(trackIndex, tracks.length - 1);
    rebuildOrder();

    if (wasActive) {
      hardSwitch(trackIndex, isPlaying);
    } else {
      renderLibrary();
    }
  }

  const AUDIO_EXT_RE = /\.(mp3|m4a|wav|ogg|oga|flac|aac|weba)$/i;
  function isAudioFile(file) {
    return (file.type && file.type.startsWith('audio/')) || AUDIO_EXT_RE.test(file.name);
  }

  // "Artist - Title.mp3" (optionally prefixed with a track number) is the
  // most common naming convention; anything else just becomes the title.
  function parseFilenameMeta(filename) {
    const base = filename.replace(/\.[^/.]+$/, '');
    const cleaned = base.replace(/^\s*\d+[\s._-]+/, '').trim();
    const match = cleaned.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (match) {
      return { artist: match[1].trim(), title: match[2].trim() };
    }
    return { artist: 'Unknown Artist', title: cleaned || filename };
  }

  // ---------------------------------------------------------------------
  // Embedded metadata (ID3 tags) — title/artist beyond the filename guess,
  // plus cover art when the file has any.
  // ---------------------------------------------------------------------
  const MAX_ARTWORK_DIMENSION = 300; // a thumbnail, not a wallpaper — keeps IndexedDB/memory light on a phone

  function pictureTagToBlob(picture) {
    if (!picture || !picture.data || !picture.data.length) return null;
    return new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' });
  }

  async function downscaleArtwork(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width <= MAX_ARTWORK_DIMENSION && bitmap.height <= MAX_ARTWORK_DIMENSION) {
        if (bitmap.close) bitmap.close();
        return blob;
      }
      const scale = MAX_ARTWORK_DIMENSION / Math.max(bitmap.width, bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      if (bitmap.close) bitmap.close();
      const resized = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
      return resized || blob;
    } catch (err) {
      return blob; // couldn't downscale (unsupported format, etc.) — keep the original rather than lose the art
    }
  }

  // { title, artist, album, pictureBlob } — any field the file's tags don't
  // have comes back null rather than a placeholder, so the caller decides
  // what to fall back to.
  async function readAudioMetadata(file) {
    const tags = await readTags(file);
    if (!tags) return { title: null, artist: null, album: null, pictureBlob: null };
    let pictureBlob = pictureTagToBlob(tags.picture);
    if (pictureBlob) pictureBlob = await downscaleArtwork(pictureBlob);
    return {
      title: tags.title || null,
      artist: tags.artist || null,
      album: tags.album || null,
      pictureBlob,
    };
  }

  // Reads metadata for a batch of files one at a time with an idle pause
  // between each, rather than firing every jsmediatags read at once — on a
  // big import that would jank the UI, especially on a phone.
  // requestIdleCallback isn't available in iOS Safari/WKWebView, hence the
  // setTimeout fallback.
  function idleGap() {
    return new Promise((resolve) => {
      if (window.requestIdleCallback) requestIdleCallback(() => resolve(), { timeout: 500 });
      else setTimeout(resolve, 60);
    });
  }

  const metadataQueue = [];
  let metadataQueueRunning = false;

  async function runMetadataQueue() {
    metadataQueueRunning = true;
    while (metadataQueue.length) {
      const job = metadataQueue.shift();
      await idleGap();
      try {
        await job();
      } catch (err) {
        // one file's metadata failing shouldn't stop the rest of the batch
      }
    }
    metadataQueueRunning = false;
  }

  function enqueueMetadataRead(job) {
    metadataQueue.push(job);
    if (!metadataQueueRunning) runMetadataQueue();
  }

  // Applies a file's tags to the track that was already added under its
  // filename guess, once they resolve. Guards against the track having been
  // removed in the meantime, and never overwrites a title the user already
  // set by hand (checked via renamedAt, the same flag the rename feature and
  // sync use to mean "this name was deliberately chosen").
  async function upgradeTrackMetadata(track, file) {
    if (!tracks.includes(track)) return;
    const meta = await readAudioMetadata(file);
    if (!tracks.includes(track)) return;

    const changes = {};
    if (!track.renamedAt) {
      const newTitle = meta.title || track.title;
      const newArtist = meta.artist || track.artist;
      if (newTitle !== track.title || newArtist !== track.artist) {
        track.title = newTitle;
        track.artist = newArtist;
        track.mood = pickMood(newTitle, newArtist);
        changes.title = newTitle;
        changes.artist = newArtist;
        changes.mood = track.mood;
        if (tracks[trackIndex] === track) setNowPlayingUI(track);
      }
    }

    if (meta.pictureBlob) {
      track.artworkUrl = URL.createObjectURL(meta.pictureBlob);
      changes.artwork = meta.pictureBlob;
      if (tracks[trackIndex] === track) {
        updateTrackArt(track);
        updateMediaSessionMetadata(track);   // the lock-screen entry was already showing the app-icon fallback
      }
    }

    if (!Object.keys(changes).length) return;
    if (track.id != null) {
      dbUpdateTrack(track.id, changes).catch((err) => console.warn('Pulse: failed to save tag metadata', err));
    }
    renderLibrary();
  }

  function readTags(file) {
    return new Promise((resolve) => {
      if (!window.jsmediatags) { resolve(null); return; }
      window.jsmediatags.read(file, {
        onSuccess: (tag) => resolve(tag.tags),
        onError: () => resolve(null),
      });
    });
  }

  // ---------------------------------------------------------------------
  // Persistence: the imported files themselves live in IndexedDB (as
  // Blobs) so the library survives a reload — object URLs alone don't.
  // ---------------------------------------------------------------------

  const DB_NAME = 'pulse-player';
  const STORE_NAME = 'tracks';
  const PLAYLIST_STORE = 'playlists';
  const POSITION_STORE = 'lastPositions';
  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          }
          if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
            db.createObjectStore(PLAYLIST_STORE, { keyPath: 'id', autoIncrement: true });
          }
          if (!db.objectStoreNames.contains(POSITION_STORE)) {
            db.createObjectStore(POSITION_STORE, { keyPath: 'trackId' });
          }
        };
        req.onsuccess = () => {
          // If a newer version ever needs to upgrade this database, get out of its way.
          req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
          resolve(req.result);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn('Pulse: a database upgrade is waiting for other open Pulse tabs to close');
      }).catch((err) => {
        console.warn('Pulse: library persistence unavailable', err);
        return null;
      });
    }
    return dbPromise;
  }

  async function dbAddTrack(record) {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllTracks() {
    const db = await getDB();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteTrack(id) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbUpdateTrack(id, changes) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) { resolve(); return; }
        const putReq = store.put({ ...rec, ...changes });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // Writes the custom sort position for many tracks in one transaction.
  async function dbSetOrders(pairs) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      pairs.forEach(({ id, order }) => {
        const getReq = store.get(id);
        getReq.onsuccess = () => { if (getReq.result) store.put({ ...getReq.result, order }); };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function dbGetAllPlaylists() {
    const db = await getDB();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const req = db.transaction(PLAYLIST_STORE, 'readonly').objectStore(PLAYLIST_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAddPlaylist(playlist) {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const req = db.transaction(PLAYLIST_STORE, 'readwrite').objectStore(PLAYLIST_STORE).add({ uid: playlist.uid, name: playlist.name, trackIds: playlist.trackIds, updatedAt: playlist.updatedAt || 0 });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutPlaylist(playlist) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const req = db.transaction(PLAYLIST_STORE, 'readwrite').objectStore(PLAYLIST_STORE).put({ id: playlist.id, uid: playlist.uid, name: playlist.name, trackIds: playlist.trackIds, updatedAt: playlist.updatedAt || 0 });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeletePlaylist(id) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const req = db.transaction(PLAYLIST_STORE, 'readwrite').objectStore(PLAYLIST_STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllPositions() {
    const db = await getDB();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const req = db.transaction(POSITION_STORE, 'readonly').objectStore(POSITION_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbSetPosition(trackId, position) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const req = db.transaction(POSITION_STORE, 'readwrite').objectStore(POSITION_STORE).put({ trackId, position, savedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeletePosition(trackId) {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const req = db.transaction(POSITION_STORE, 'readwrite').objectStore(POSITION_STORE).delete(trackId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Guards against re-adding the same file twice (e.g. dropping the same
  // folder again in a later session, once it's already persisted).
  const knownFileKeys = new Set();

  // Position for a newly added track: after everything already in the library.
  function nextOrder() {
    return tracks.reduce((max, t) => Math.max(max, t.order == null ? -1 : t.order), -1) + 1;
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(isAudioFile);
    if (!files.length) return;

    const wasEmpty = tracks.length === 0;
    let added = false;

    for (const file of files) {
      const dedupeKey = `${file.name}:${file.size}`;
      if (knownFileKeys.has(dedupeKey)) continue;
      knownFileKeys.add(dedupeKey);

      // Added under a filename guess immediately — the file is playable
      // right away, rather than making the import wait on a tag read.
      // upgradeTrackMetadata() patches in the real title/artist/artwork
      // (queued, not fired all at once) once jsmediatags resolves.
      const fallback = parseFilenameMeta(file.name);
      const mood = pickMood(fallback.title, fallback.artist);
      const track = { id: null, title: fallback.title, artist: fallback.artist, mood, name: file.name, size: file.size, url: URL.createObjectURL(file), order: nextOrder(), artworkUrl: null };
      tracks.push(track);
      added = true;
      renderLibrary();

      dbAddTrack({ title: fallback.title, artist: fallback.artist, mood, name: file.name, size: file.size, type: file.type, data: file, order: track.order })
        .then((id) => {
          track.id = id;
          if (id != null && tracks[trackIndex] === track) {
            localStorage.setItem('pulse:lastTrackId', id);
          }
          // The row rendered before it had an id, so it had no rename button.
          if (id != null) renderLibrary();
        })
        .catch(() => {});

      enqueueMetadataRead(() => upgradeTrackMetadata(track, file));
    }

    if (!added) return;
    rebuildOrder();
    renderLibrary();
    if (wasEmpty) hardSwitch(0, false);
  }

  async function loadLibraryFromDB() {
    let records = [];
    try {
      records = await dbGetAllTracks();
    } catch (err) {
      records = [];
    }
    // Custom order first; tracks without one (added before reordering
    // existed) sort after them, in the order they were added.
    records.sort((a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) || (a.id - b.id));
    const needsOrder = records.some((rec) => rec.order == null);
    records.forEach((rec, i) => {
      knownFileKeys.add(`${rec.name}:${rec.size}`);
      const mood = rec.mood || pickMood(rec.title, rec.artist);
      tracks.push({ id: rec.id, title: rec.title, artist: rec.artist, mood, name: rec.name, size: rec.size, url: URL.createObjectURL(rec.data), hash: rec.hash || null, renamedAt: rec.renamedAt || 0, order: needsOrder ? i : rec.order, artworkUrl: rec.artwork ? URL.createObjectURL(rec.artwork) : null });
    });
    if (needsOrder && records.length) {
      dbSetOrders(records.map((rec, i) => ({ id: rec.id, order: i }))).catch(() => {});
    }

    try {
      playlists = await dbGetAllPlaylists();
    } catch (err) {
      playlists = [];
    }
    // Playlists made before sync existed have no stable identity or timestamp yet.
    playlists.forEach((pl) => {
      let dirty = false;
      if (!pl.uid) { pl.uid = newPlaylistUid(); dirty = true; }
      if (pl.updatedAt == null) { pl.updatedAt = 0; dirty = true; }
      if (dirty) savePlaylist(pl);
    });

    try {
      (await dbGetAllPositions()).forEach((rec) => positions.set(rec.trackId, rec.position));
    } catch (err) {
      // no saved positions; nothing to offer
    }
  }

  // ---------------------------------------------------------------------
  // Export / import: move the library between browsers or devices as a
  // single .zip file — everything stays client-side, no server involved.
  // ---------------------------------------------------------------------

  const EXT_FOR_TYPE = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'weba',
  };
  function extForType(type) { return EXT_FOR_TYPE[type] || 'mp3'; }

  function sanitizeForFilename(str) {
    return (str || 'track').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'track';
  }

  // Briefly swaps a settings-panel button to a checkmark to confirm an
  // export/import finished, matching the existing toggle-button color
  // language rather than adding new text elements to an icon-only button.
  function flashSuccess(btn) {
    const original = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.classList.add('toggled');
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('toggled');
      btn.disabled = false;
    }, 1600);
  }

  async function buildLibraryZip() {
    const records = await dbGetAllTracks();
    if (!records.length) return null;
    records.sort((a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) || (a.id - b.id));

    // Every exported track carries its content hash so the receiving device
    // can recognise it (even under a different name) without reading it.
    for (const rec of records) {
      if (rec.hash) continue;
      rec.hash = await hashBlob(rec.data);
      if (!rec.hash) continue;
      dbUpdateTrack(rec.id, { hash: rec.hash }).catch(() => {});
      const live = tracks.find((t) => t.id === rec.id);
      if (live) live.hash = rec.hash;
    }

    const zip = new JSZip();
    const metadata = records.map((rec) => {
      const filename = `${rec.id}-${sanitizeForFilename(rec.title)}.${extForType(rec.type)}`;
      zip.file(`audio/${filename}`, rec.data);
      return {
        id: rec.id,
        title: rec.title,
        artist: rec.artist,
        mood: rec.mood,
        type: rec.type,
        filename,
        hash: rec.hash || null,
        size: rec.data.size,
        renamedAt: rec.renamedAt || 0,
      };
    });
    zip.file('metadata.json', JSON.stringify(metadata, null, 2));

    // Playlists live in their own file (older versions ignore it), and refer to
    // tracks by content hash since local ids differ between devices.
    const hashById = new Map(records.filter((r) => r.hash).map((r) => [r.id, r.hash]));
    const deleted = Object.entries(getPlaylistTombstones()).map(([uid, deletedAt]) => ({ uid, deletedAt }));
    if (playlists.length || deleted.length) {
      zip.file('playlists.json', JSON.stringify({
        playlists: playlists.map((pl) => ({
          uid: pl.uid,
          name: pl.name,
          updatedAt: pl.updatedAt || 0,
          tracks: pl.trackIds.map((id) => hashById.get(id)).filter(Boolean),
        })),
        deleted,
      }));
    }
    // The custom track order, by hash, only if it was ever deliberately set.
    if (libraryOrderedAt > 0) {
      zip.file('order.json', JSON.stringify({ at: libraryOrderedAt, tracks: records.map((r) => r.hash).filter(Boolean) }));
    }
    return zip.generateAsync({ type: 'blob' });
  }

  async function exportLibrary() {
    try {
      const blob = await buildLibraryZip();
      if (!blob) {
        alert('No local tracks to export yet.');
        return;
      }
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pulse-library-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flashSuccess(exportBtn);
    } catch (err) {
      console.warn('Pulse: export failed', err);
      alert('Export failed — see the console for details.');
    }
  }

  async function hashBlob(blob) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      return null;
    }
  }

  // A track's identity is its audio content, not its title — so renaming a
  // track on one device can't make it look like a different song on another.
  // Hashes are computed lazily and cached on the record, so tracks added
  // before this existed pick one up the first time they're exported or
  // compared.
  async function ensureTrackHash(track) {
    if (track.hash) return track.hash;
    try {
      const blob = await (await fetch(track.url)).blob();
      const hash = await hashBlob(blob);
      if (hash) {
        track.hash = hash;
        if (track.id != null) dbUpdateTrack(track.id, { hash }).catch(() => {});
      }
    } catch (err) {
      // leave it unhashed; it just won't match by content
    }
    return track.hash || null;
  }

  // Folds a zip's playlists.json into the local playlists. Same rule as track
  // renames: the more recently edited copy of a playlist wins, so a stale
  // snapshot can't undo a newer edit, and a delete beats any older copy.
  // Returns how many local playlists were created, changed, or removed.
  async function mergePlaylists(data) {
    const incoming = Array.isArray(data && data.playlists) ? data.playlists : [];
    const incomingDeleted = Array.isArray(data && data.deleted) ? data.deleted : [];
    const tombstones = getPlaylistTombstones();
    let changed = 0;

    for (const d of incomingDeleted) {
      if (!d || !d.uid) continue;
      const deletedAt = Number(d.deletedAt) || 0;
      observeStamp(deletedAt);
      const local = playlists.find((p) => p.uid === d.uid);
      if (local && deletedAt > (local.updatedAt || 0)) {
        playlists = playlists.filter((p) => p !== local);
        dbDeletePlaylist(local.id).catch((err) => console.warn('Pulse: failed to delete playlist', err));
        if (currentView === local.id) currentView = 'all';
        if (playContext === local.id) { playContext = 'all'; rebuildOrder(); }
        changed++;
      }
      if (deletedAt > (tombstones[d.uid] || 0)) tombstones[d.uid] = deletedAt;
    }

    if (incoming.length) {
      const idByHash = new Map();
      const hashById = new Map();
      for (const t of tracks) {
        const hash = await ensureTrackHash(t);
        if (hash && t.id != null) { idByHash.set(hash, t.id); hashById.set(t.id, hash); }
      }

      for (const inc of incoming) {
        if (!inc || !inc.uid || typeof inc.name !== 'string') continue;
        const updatedAt = Number(inc.updatedAt) || 0;
        observeStamp(updatedAt);
        if (tombstones[inc.uid] && tombstones[inc.uid] >= updatedAt) continue;   // deleted more recently than this copy was edited
        delete tombstones[inc.uid];                                              // a newer edit supersedes an old delete

        const trackIds = (Array.isArray(inc.tracks) ? inc.tracks : []).map((h) => idByHash.get(h)).filter((id) => id != null);
        const local = playlists.find((p) => p.uid === inc.uid);

        if (!local) {
          const pl = { uid: inc.uid, name: inc.name, trackIds, updatedAt };
          let id = null;
          try { id = await dbAddPlaylist(pl); } catch (err) { console.warn('Pulse: failed to save playlist', err); }
          pl.id = id != null ? id : Date.now() + playlists.length;
          playlists.push(pl);
          changed++;
        } else if (stampWins(
          updatedAt,
          local.updatedAt || 0,
          playlistKey(inc.name, Array.isArray(inc.tracks) ? inc.tracks : []),
          playlistKey(local.name, local.trackIds.map((id) => hashById.get(id)).filter(Boolean))
        )) {
          local.name = inc.name;
          local.trackIds = trackIds;
          local.updatedAt = updatedAt;
          savePlaylist(local);
          if (playContext === local.id) rebuildOrder();
          changed++;
        }
      }
    }

    setPlaylistTombstones(tombstones);
    return changed;
  }

  // Returns { imported, renamed, playlists } on success, null if the file was unreadable.
  // A track that's already here (same audio) is never duplicated; if the
  // incoming copy was renamed more recently than the local one, the newer
  // name wins, so a stale snapshot can't undo a newer rename either.
  async function importLibrary(file, { quiet = false } = {}) {
    try {
      const zip = await JSZip.loadAsync(file);
      const metaEntry = zip.file('metadata.json');
      if (!metaEntry) throw new Error('metadata.json not found in zip');
      const metadata = JSON.parse(await metaEntry.async('string'));

      const wasEmpty = tracks.length === 0;
      let importedCount = 0;
      let renamedCount = 0;

      for (const entry of metadata) {
        const type = entry.type || 'audio/mpeg';
        let audio = null;
        const getAudio = async () => {
          if (!audio) {
            const zipEntry = zip.file(`audio/${entry.filename}`);
            if (!zipEntry) return null;
            audio = new Blob([await zipEntry.async('blob')], { type });
          }
          return audio;
        };

        // Newer exports carry each track's hash, so a track that's already
        // here is matched without reading its audio at all.
        let hash = typeof entry.hash === 'string' ? entry.hash : null;
        let match = hash ? tracks.find((t) => t.hash === hash) : null;

        if (!match) {
          const incoming = await getAudio();
          if (!incoming) continue;
          hash = await hashBlob(incoming);
          if (hash) {
            match = tracks.find((t) => t.hash === hash);
            if (!match) {
              // Local tracks from before hashing existed: only the ones with
              // the same byte size can possibly match, so only hash those.
              for (const t of tracks) {
                if (t.hash || t.size !== incoming.size) continue;
                if ((await ensureTrackHash(t)) === hash) { match = t; break; }
              }
            }
          } else {
            // Hashing unavailable (insecure context) — fall back to names.
            match = tracks.find((t) => t.title === entry.title && t.artist === entry.artist);
          }
        }

        if (match) {
          const incomingAt = Number(entry.renamedAt) || 0;
          observeStamp(incomingAt);
          const nameChanged = entry.title !== match.title || entry.artist !== match.artist;
          if (nameChanged && stampWins(incomingAt, match.renamedAt || 0, `${entry.title}|${entry.artist}`, `${match.title}|${match.artist}`)) {
            match.title = entry.title;
            match.artist = entry.artist;
            match.renamedAt = incomingAt;
            if (tracks[trackIndex] === match) setNowPlayingUI(match);
            if (match.id != null) {
              dbUpdateTrack(match.id, { title: entry.title, artist: entry.artist, renamedAt: incomingAt }).catch((err) => {
                console.warn('Pulse: failed to save synced rename', err);
              });
            }
            renamedCount++;
          }
          continue;
        }

        const blob = await getAudio();
        if (!blob) continue;
        const mood = entry.mood || pickMood(entry.title, entry.artist);
        const renamedAt = Number(entry.renamedAt) || 0;
        observeStamp(renamedAt);

        const order = nextOrder();
        const id = await dbAddTrack({
          title: entry.title,
          artist: entry.artist,
          mood,
          name: entry.filename,
          size: blob.size,
          type,
          data: blob,
          hash,
          renamedAt,
          order,
        });

        knownFileKeys.add(`${entry.filename}:${blob.size}`);
        tracks.push({ id, title: entry.title, artist: entry.artist, mood, name: entry.filename, size: blob.size, url: URL.createObjectURL(blob), hash, renamedAt, order });
        importedCount++;
      }

      let playlistChanges = 0;
      const playlistsEntry = zip.file('playlists.json');
      if (playlistsEntry) {
        try {
          playlistChanges = await mergePlaylists(JSON.parse(await playlistsEntry.async('string')));
        } catch (err) {
          console.warn('Pulse: could not read the playlists in that library', err);
        }
      }

      let orderChanged = false;
      const orderEntry = zip.file('order.json');
      if (orderEntry) {
        try {
          orderChanged = await mergeLibraryOrder(JSON.parse(await orderEntry.async('string')));
        } catch (err) {
          console.warn('Pulse: could not read the track order in that library', err);
        }
      }

      if (importedCount || renamedCount || playlistChanges || orderChanged) {
        rebuildOrder();
        renderLibrary();
        if (wasEmpty && importedCount) hardSwitch(0, false);
        flashSuccess(importBtn);
      } else if (!quiet) {
        alert('Nothing new to import — those tracks are already in your library.');
      }
      return { imported: importedCount, renamed: renamedCount, playlists: playlistChanges, reordered: orderChanged };
    } catch (err) {
      console.warn('Pulse: import failed', err);
      alert('Import failed — that file may not be a valid Pulse library export.');
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Sync with code — relay-only for now (no WebRTC/direct device-to-device
  // path yet; that may come later as a faster option when both devices
  // happen to be online at once). One device encrypts its library
  // client-side with a key derived from a short code, then uploads the
  // ciphertext straight to Vercel Blob storage from the browser — bypassing
  // our own serverless functions for the actual bytes, since their
  // request/response bodies are capped well below what a real library
  // reaches (see api/sync-upload.js). The other device enters the same
  // code to fetch and decrypt it. The server only ever sees a SHA-256 hash
  // of the code, never the code itself, the derived key, or the plaintext.
  //
  // Always hits the deployed pulse-player domain directly (not a relative
  // path) — this code also runs inside the Capacitor iOS app, served from
  // its own bundled origin with no /api of its own.
  //
  // @vercel/blob's browser-facing `upload()` helper can't be vendored the
  // way ffmpeg.wasm's wrapper was — its bundle unconditionally imports
  // Node's `crypto`/`undici` at the top level, which only resolves via a
  // CDN that shims Node builtins for the browser (confirmed empirically:
  // esm.sh does this, a raw copy of the package's own dist file does not).
  // upload() itself is plain fetch-based (unlike ffmpeg's worker), so a
  // direct CDN import has no cross-origin-Worker restriction to work around.
  // ---------------------------------------------------------------------
  const SYNC_API_BASE = 'https://pulse-player-eight.vercel.app';
  const SYNC_BLOB_CLIENT_URL = 'https://esm.sh/@vercel/blob@2.8.0/client';
  const SYNC_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const SYNC_PBKDF2_SALT = new TextEncoder().encode('pulse-sync-v1');

  let syncBusy = false;

  function setSyncStatus(text) {
    const el = document.getElementById('syncStatus');
    if (el) el.textContent = text || '';
  }

  function setSyncBusy(busy) {
    syncBusy = busy;
    syncSendBtn.disabled = busy;
    syncReceiveBtn.disabled = busy;
    syncSubmitBtn.disabled = busy;
  }

  function generateSyncCode() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 6; i++) code += SYNC_CODE_CHARS[bytes[i] % SYNC_CODE_CHARS.length];
    return code;
  }

  async function hashSyncCode(code) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // The code itself is the real secret here, so a fixed salt is fine — it
  // just needs to make the derived key unsuitable for other purposes, not
  // to add per-upload entropy.
  async function deriveSyncKey(code) {
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: SYNC_PBKDF2_SALT, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptForSync(key, blob) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await blob.arrayBuffer();
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return new Blob([iv, cipher], { type: 'application/octet-stream' });
  }

  async function decryptFromSync(key, arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const iv = bytes.slice(0, 12);
    const cipher = bytes.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new Blob([plain], { type: 'application/zip' });
  }

  function showSyncSendUI() {
    syncCodeEntry.hidden = true;
    syncCodeDisplay.hidden = false;
  }

  function showSyncReceiveUI() {
    syncCodeDisplay.hidden = true;
    syncCodeEntry.hidden = false;
    syncCodeInput.value = '';
    syncCodeInput.focus();
  }

  function hideSyncUI() {
    syncCodeDisplay.hidden = true;
    syncCodeEntry.hidden = true;
  }

  async function startSync() {
    if (syncBusy) return;
    const zipBlob = await buildLibraryZip();
    if (!zipBlob) {
      alert('No local tracks to sync yet.');
      return;
    }

    setSyncBusy(true);
    showSyncSendUI();
    const code = generateSyncCode();
    syncCodeValue.textContent = code;
    setSyncStatus('Encrypting…');

    try {
      const key = await deriveSyncKey(code);
      const encryptedBlob = await encryptForSync(key, zipBlob);
      const codeHash = await hashSyncCode(code);

      setSyncStatus('Uploading…');
      const { upload } = await import(SYNC_BLOB_CLIENT_URL);
      await upload(`sync/${codeHash}.bin`, encryptedBlob, {
        access: 'public',
        handleUploadUrl: `${SYNC_API_BASE}/api/sync-upload`,
        contentType: 'application/octet-stream',
      });

      setSyncStatus(`Code ${code} — enter it on your other device within 24 hours.`);
    } catch (err) {
      console.warn('Pulse: sync upload failed', err);
      setSyncStatus('Upload failed — check your connection and try again.');
    } finally {
      setSyncBusy(false);
    }
  }

  async function claimSync(rawCode) {
    if (syncBusy) return;
    const code = (rawCode || '').trim().toUpperCase();
    if (code.length !== 6) {
      setSyncStatus('Enter the full 6-character code.');
      return;
    }

    setSyncBusy(true);
    setSyncStatus('Looking up code…');

    try {
      const codeHash = await hashSyncCode(code);
      const lookupResponse = await fetch(`${SYNC_API_BASE}/api/sync-download?codeHash=${codeHash}`);
      if (!lookupResponse.ok) {
        setSyncStatus('Invalid or expired code.');
        return;
      }
      const { url } = await lookupResponse.json();

      setSyncStatus('Downloading…');
      const dataResponse = await fetch(url);
      if (!dataResponse.ok) {
        setSyncStatus('Invalid or expired code.');
        return;
      }
      const buffer = await dataResponse.arrayBuffer();

      let zipBlob;
      try {
        const key = await deriveSyncKey(code);
        zipBlob = await decryptFromSync(key, buffer);
      } catch (err) {
        setSyncStatus('Invalid or expired code.');
        return;
      }

      // Best-effort — the import already succeeded either way; this just
      // tells the server it can delete the blob now that it's been claimed.
      fetch(`${SYNC_API_BASE}/api/sync-claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeHash }),
      }).catch(() => {});

      setSyncStatus('Importing…');
      const result = await importLibrary(zipBlob, { quiet: true });
      if (!result) {
        setSyncStatus('Import failed — that library may be damaged.');
        return;
      }
      hideSyncUI();
      const parts = [];
      if (result.imported) parts.push(`${result.imported} new track${result.imported === 1 ? '' : 's'}`);
      if (result.renamed) parts.push(`${result.renamed} renamed`);
      if (result.reordered) parts.push('track order updated');
      if (result.playlists) parts.push(`${result.playlists} playlist${result.playlists === 1 ? '' : 's'} updated`);
      setSyncStatus(parts.length ? `Synced: ${parts.join(', ')}.` : 'Already up to date.');
    } catch (err) {
      console.warn('Pulse: sync download failed', err);
      setSyncStatus('Invalid or expired code.');
    } finally {
      setSyncBusy(false);
    }
  }

  syncSendBtn.addEventListener('click', () => {
    if (!syncCodeDisplay.hidden && !syncBusy) {
      hideSyncUI();
      setSyncStatus('');
      return;
    }
    startSync();
  });
  syncReceiveBtn.addEventListener('click', () => {
    if (!syncCodeEntry.hidden && !syncBusy) {
      hideSyncUI();
      setSyncStatus('');
      return;
    }
    showSyncReceiveUI();
    setSyncStatus('');
  });
  syncSubmitBtn.addEventListener('click', () => claimSync(syncCodeInput.value));
  syncCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') claimSync(syncCodeInput.value);
  });
  syncCodeInput.addEventListener('input', () => {
    syncCodeInput.value = syncCodeInput.value.toUpperCase();
  });

  // ---------------------------------------------------------------------
  // Google Drive import — a fully optional, opt-in extra alongside local
  // files. Pulse's core pitch is local-only/no-accounts; this never runs
  // unless the user explicitly clicks it, and nothing here is required
  // for the rest of the app to work.
  //
  // REPLACE ME: fill in your own OAuth Client ID and API key from
  // https://console.cloud.google.com before this feature will work.
  // ---------------------------------------------------------------------
  const GOOGLE_CLIENT_ID = '348004527336-88msbtqo2q82ok5608cg79m7lco5i445.apps.googleusercontent.com';
  const GOOGLE_API_KEY = 'AIzaSyAugbTHLIgO10wVGMdl6bes7ngxbM2Yoeg';
  const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const DRIVE_MIME_TYPES = 'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/ogg,audio/flac,audio/aac,audio/webm';

  let driveTokenClient = null;
  let driveAccessToken = null;
  let pickerApiLoaded = false;

  function setDriveStatus(text) {
    const el = document.getElementById('driveStatus');
    if (el) el.textContent = text || '';
  }

  function updateDriveUI() {
    const connected = !!driveAccessToken;
    driveDisconnectBtn.hidden = !connected;
    driveImportBtn.classList.toggle('toggled', connected);
  }

  // The GIS/gapi <script> tags load with defer, so on a slow connection
  // they may not be ready the instant the button is clicked.
  function ensureGoogleScriptsLoaded() {
    if (window.google && window.google.accounts && window.gapi) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (window.google && window.google.accounts && window.gapi) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error('Google sign-in scripts failed to load'));
      }, 10000);
    });
  }

  function getDriveTokenClient() {
    if (!driveTokenClient) {
      driveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_DRIVE_SCOPE,
        callback: () => {}, // replaced per-request in requestDriveToken()
      });
    }
    return driveTokenClient;
  }

  // Requests an access token, triggering Google's sign-in/consent popup the
  // first time (or whenever a previous token has expired/been revoked). A
  // blocked or unsupported popup (a real risk in an embedded WebView) never
  // calls back at all, so this times out instead of hanging forever.
  function requestDriveToken() {
    return new Promise((resolve, reject) => {
      const client = getDriveTokenClient();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('sign-in timed out — the popup may have been blocked'));
      }, 30000);
      client.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (resp.error) { reject(new Error(resp.error)); return; }
        driveAccessToken = resp.access_token;
        resolve(driveAccessToken);
      };
      client.requestAccessToken({ prompt: driveAccessToken ? '' : 'consent' });
    });
  }

  function loadPickerApi() {
    if (pickerApiLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!window.gapi) { reject(new Error('Google API script not loaded')); return; }
      gapi.load('picker', () => { pickerApiLoaded = true; resolve(); });
    });
  }

  function openDrivePicker(token) {
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes(DRIVE_MIME_TYPES)
        .setIncludeFolders(false);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(GOOGLE_API_KEY)
        .addView(view)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) resolve(data.docs || []);
          else if (data.action === google.picker.Action.CANCEL) resolve([]);
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function downloadDriveFile(doc, token) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
    const blob = await res.blob();
    const type = blob.type || doc.mimeType || 'audio/mpeg';
    // Wrapped as a File so it flows through the exact same addFiles()
    // pipeline as a locally-dropped file — same ID3 tag reading,
    // dedupe, mood assignment, and IndexedDB persistence.
    return new File([blob], doc.name, { type });
  }

  async function importFromDrive() {
    try {
      setDriveStatus('Connecting to Google Drive…');
      await ensureGoogleScriptsLoaded();
      const token = await requestDriveToken();
      updateDriveUI();
      await loadPickerApi();

      setDriveStatus('');
      const docs = await openDrivePicker(token);
      if (!docs.length) return;

      setDriveStatus(`Downloading ${docs.length} file${docs.length === 1 ? '' : 's'}…`);
      const files = [];
      for (const doc of docs) {
        try {
          files.push(await downloadDriveFile(doc, token));
        } catch (err) {
          console.warn('Pulse: failed to download a Drive file', doc.name, err);
        }
      }
      if (!files.length) {
        setDriveStatus('Could not download the selected file(s) — see console for details.');
        return;
      }
      await addFiles(files);
      setDriveStatus(`Imported ${files.length} track${files.length === 1 ? '' : 's'} from Drive.`);
    } catch (err) {
      console.warn('Pulse: Drive import failed', err);
      const reason = (err && err.message) || 'see console for details';
      setDriveStatus(`Drive import failed — ${reason}.`);
    }
  }

  function disconnectDrive() {
    if (driveAccessToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(driveAccessToken, () => {});
    }
    driveAccessToken = null;
    updateDriveUI();
    setDriveStatus('Disconnected from Google Drive.');
  }

  // ---------------------------------------------------------------------
  // Video-to-MP3 conversion — another fully optional, opt-in extra.
  // Runs entirely client-side via ffmpeg.wasm, loaded from a CDN as an
  // ES module (no bundler needed here, and the exact same dynamic
  // import() works unchanged in the Vite-bundled iOS copy).
  //
  // Deliberately the single-threaded @ffmpeg/core, not @ffmpeg/core-mt:
  // the multi-threaded core needs SharedArrayBuffer, which needs
  // Cross-Origin-Embedder-Policy/Cross-Origin-Opener-Policy response
  // headers that a Capacitor-served iOS WebView can't reliably provide,
  // and iOS Safari doesn't support SharedArrayBuffer in Web Workers at
  // all. Single-threaded is slower but needs zero special headers.
  // ---------------------------------------------------------------------

  const FFMPEG_CORE_VERSION = '0.12.10';
  // The ESM build specifically — our worker is type:"module" (required
  // for it to use dynamic import() at all, since importScripts() throws
  // in a module worker), and only the ESM core actually exports a
  // default createFFmpegCore for that import() to receive. The UMD
  // build has no export at all and silently yields undefined here.
  const FFMPEG_CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

  let ffmpegInstance = null;
  let ffmpegLoadPromise = null;
  let ffmpegUtilModule = null;

  function setConvertStatus(text) {
    const el = document.getElementById('convertStatus');
    if (el) el.textContent = text || '';
  }

  // The ffmpeg.wasm *wrapper* (not the big core binary) is vendored
  // locally in vendor/ — it needs a same-origin Worker script, and
  // blob-ifying a CDN-hosted worker.js (the usual cross-origin
  // workaround) breaks that script's own relative imports, since a
  // blob: URL can't be used as a base for resolving them.
  //
  // Resolved against document.baseURI (the page's own URL), not a bare
  // relative path: this code ends up inside a bundled main.js in the
  // iOS build, served from a different location (dist/assets/) than
  // vendor/ (dist/vendor/) — a plain "./vendor/..." would resolve
  // relative to the bundle, landing in the wrong place.
  function vendorURL(path) {
    return new URL(`vendor/${path}`, document.baseURI).href;
  }

  function getFFmpegUtil() {
    if (!ffmpegUtilModule) ffmpegUtilModule = import(vendorURL('ffmpeg-util/index.js'));
    return ffmpegUtilModule;
  }

  // Loads the ffmpeg.wasm JS API and the (single-threaded) core lazily —
  // only when this feature is first used, not on every page load, since
  // the core alone is a ~22MB download.
  async function getFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    if (!ffmpegLoadPromise) {
      ffmpegLoadPromise = (async () => {
        const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
          import(vendorURL('ffmpeg/classes.js')),
          getFFmpegUtil(),
        ]);
        const ffmpeg = new FFmpeg();
        ffmpeg.on('progress', ({ progress }) => {
          if (currentConvertFilename) {
            setConvertStatus(`Converting ${currentConvertFilename}… ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`);
          }
        });
        // The core binary has no imports of its own, so blob-ifying it
        // (the standard CDN-loading pattern) is safe — only the small
        // ESM wrapper files needed vendoring. classWorkerURL is just
        // "worker.js": classes.js resolves it relative to its own
        // (local, same-origin) URL, landing on its sibling in vendor/ffmpeg/.
        await ffmpeg.load({
          coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
          classWorkerURL: 'worker.js',
        });
        ffmpegInstance = ffmpeg;
        return ffmpeg;
      })();
    }
    return ffmpegLoadPromise;
  }

  const VIDEO_EXT_RE = /\.(mov|mp4|m4v|avi|webm|mkv)$/i;
  function isVideoFile(file) {
    return (file.type && file.type.startsWith('video/')) || VIDEO_EXT_RE.test(file.name);
  }

  let currentConvertFilename = null;

  // Extracts and compresses just the audio track — no video processing,
  // to keep this as fast as the single-threaded core allows.
  async function convertVideoToMp3(file) {
    const { fetchFile } = await getFFmpegUtil();
    const ffmpeg = await getFFmpeg();

    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const inputName = `input.${ext}`;
    const outputName = 'output.mp3';

    await ffmpeg.writeFile(inputName, await fetchFile(file));
    try {
      await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', outputName]);
      const data = await ffmpeg.readFile(outputName);
      return new Blob([data], { type: 'audio/mpeg' });
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
  }

  // Processes one file at a time — ffmpeg.wasm handles one job per
  // instance, and this also lets the status line show clear progress
  // per file instead of several conversions racing each other.
  async function convertVideosToLibrary(files) {
    const videos = Array.from(files || []).filter(isVideoFile);
    if (!videos.length) return;

    try {
      setConvertStatus('Loading the converter (first use only, ~32MB)…');
      await getFFmpeg();
    } catch (err) {
      console.warn('Pulse: failed to load ffmpeg.wasm', err);
      setConvertStatus('Could not load the video converter — check your connection and try again.');
      return;
    }

    let converted = 0;
    for (const file of videos) {
      currentConvertFilename = file.name;
      setConvertStatus(`Converting ${file.name}…`);
      try {
        const blob = await convertVideoToMp3(file);
        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const mp3File = new File([blob], `${baseName}.mp3`, { type: 'audio/mpeg' });
        await addFiles([mp3File]);
        converted++;
      } catch (err) {
        console.warn('Pulse: video conversion failed', file.name, err);
        setConvertStatus(`Couldn't convert ${file.name} — it may have no audio track, or be an unsupported format.`);
      }
    }
    currentConvertFilename = null;

    if (converted) {
      setConvertStatus(`Converted ${converted} video${converted === 1 ? '' : 's'} to MP3.`);
    }
  }

  function restoreSettings() {
    if (!IS_IOS) {
      const savedVolume = localStorage.getItem('pulse:volume');
      if (savedVolume !== null) volumeSlider.value = savedVolume;
      applyVolume();
      volumeIcon.style.opacity = Number(volumeSlider.value) === 0 ? '0.4' : '1';
    }

    if (localStorage.getItem('pulse:shuffle') === '1') {
      shuffleBtn.classList.add('toggled');
      shuffleBtn.setAttribute('aria-pressed', 'true');
    }
    if (localStorage.getItem('pulse:repeat') === '1') {
      repeatBtn.classList.add('toggled');
      repeatBtn.setAttribute('aria-pressed', 'true');
    }
    // The old on/off toggle used a fixed 4s fade, so "on" carries over as 4.
    const savedFade = localStorage.getItem('pulse:crossfadeSeconds');
    setCrossfadeSeconds(savedFade !== null ? savedFade : (localStorage.getItem('pulse:crossfade') === '1' ? 4 : 0));

    const savedBass = localStorage.getItem('pulse:eqBass');
    const savedMid = localStorage.getItem('pulse:eqMid');
    const savedTreble = localStorage.getItem('pulse:eqTreble');
    if (savedBass !== null) eqBassSlider.value = savedBass;
    if (savedMid !== null) eqMidSlider.value = savedMid;
    if (savedTreble !== null) eqTrebleSlider.value = savedTreble;
    updateEQPresetHighlight();
  }

  async function init() {
    restoreSettings();
    await loadLibraryFromDB();

    let startIndex = 0;
    const lastId = Number(localStorage.getItem('pulse:lastTrackId'));
    if (lastId) {
      const idx = tracks.findIndex((t) => t.id === lastId);
      if (idx >= 0) startIndex = idx;
    }
    trackIndex = startIndex;
    rebuildOrder();
    hardSwitch(startIndex, false);
  }

  addFilesBtn.addEventListener('click', () => fileInput.click());
  addFolderBtn.addEventListener('click', () => folderInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    addFiles(folderInput.files);
    folderInput.value = '';
  });

  exportBtn.addEventListener('click', () => exportLibrary());
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (importInput.files[0]) importLibrary(importInput.files[0]);
    importInput.value = '';
  });

  driveImportBtn.addEventListener('click', () => importFromDrive());
  driveDisconnectBtn.addEventListener('click', () => disconnectDrive());

  convertVideoBtn.addEventListener('click', () => videoInput.click());
  videoInput.addEventListener('change', () => {
    convertVideosToLibrary(videoInput.files);
    videoInput.value = '';
  });

  // Recursively walks dropped folders (Chrome/Edge/Firefox) via the
  // webkitGetAsEntry API; falls back to the flat file list elsewhere.
  async function collectFilesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items;
    if (!items || !items.length || !items[0].webkitGetAsEntry) {
      return Array.from(dataTransfer.files || []);
    }

    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }

    async function readEntry(entry) {
      if (entry.isFile) {
        return [await new Promise((resolve, reject) => entry.file(resolve, reject))];
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        let allEntries = [];
        let batch;
        do {
          batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          allEntries = allEntries.concat(batch);
        } while (batch.length > 0);
        const nested = await Promise.all(allEntries.map(readEntry));
        return nested.flat();
      }
      return [];
    }

    const results = await Promise.all(entries.map(readEntry));
    return results.flat();
  }

  let dragDepth = 0;
  function isFileDrag(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }
  ['dragenter', 'dragover'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (evt === 'dragenter') dragDepth++;
      dropOverlay.classList.add('active');
    });
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.remove('active');
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('active');
    const files = await collectFilesFromDataTransfer(e.dataTransfer);
    const videos = files.filter(isVideoFile);
    const rest = files.filter((f) => !isVideoFile(f));
    addFiles(rest);
    if (videos.length) convertVideosToLibrary(videos);
  });

  init();
