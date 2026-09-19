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

  const CROSSFADE_SECONDS = 4;
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
    if (audioCtx) return;
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
  const progressFill = document.getElementById('progressFill');
  const progressHandle = document.getElementById('progressHandle');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeIcon = document.getElementById('volumeIcon');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const repeatBtn = document.getElementById('repeatBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const crossfadeBtn = document.getElementById('crossfadeBtn');
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
  function rebuildOrder() {
    const indices = tracks.map((_, i) => i);
    if (shuffleBtn.classList.contains('toggled')) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const pos = indices.indexOf(trackIndex);
      if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
    }
    playOrder = indices;
    orderPos = Math.max(0, playOrder.indexOf(trackIndex));
  }

  function stepTrack(delta, autoplay) {
    if (!tracks.length) return;
    if (!playOrder.length) rebuildOrder();
    orderPos = (orderPos + delta + playOrder.length) % playOrder.length;
    switchTrack(playOrder[orderPos], autoplay);
  }

  function updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({ title: track.title, artist: track.artist })
      : null;
  }

  function setNowPlayingUI(track) {
    document.getElementById('trackTitle').textContent = track.title;
    document.getElementById('trackArtist').textContent = track.artist;
    updateMediaSessionMetadata(track);
    applyMoodTheme(track.mood);
  }

  function resetProgressUI() {
    progressFill.style.width = '0%';
    progressHandle.style.left = '0%';
    currentTimeEl.textContent = '0:00';
    durationEl.textContent = '0:00';
  }

  // Hard cut: used whenever crossfade is off, unavailable, or nothing is
  // currently playing (nothing to fade out of).
  function hardSwitch(index, autoplay) {
    if (!tracks.length) {
      trackIndex = 0;
      activeEl().pause();
      activeEl().removeAttribute('src');
      document.getElementById('trackTitle').textContent = '—';
      document.getElementById('trackArtist').textContent = 'Add a track to get started';
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
    orderPos = Math.max(0, playOrder.indexOf(trackIndex));
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
      crossfadeBtn.classList.contains('toggled') &&
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

    const now = audioCtx.currentTime;
    fromGain.cancelScheduledValues(now);
    fromGain.setValueAtTime(fromGain.value, now);
    fromGain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
    toGain.cancelScheduledValues(now);
    toGain.setValueAtTime(0, now);
    toGain.linearRampToValueAtTime(1, now + CROSSFADE_SECONDS);

    activeSlot = toKey;
    trackIndex = index;
    orderPos = Math.max(0, playOrder.indexOf(trackIndex));
    if (track.id != null) localStorage.setItem('pulse:lastTrackId', track.id);
    setNowPlayingUI(track);
    renderLibrary();

    setTimeout(() => {
      fromEl.pause();
      fromEl.currentTime = 0;
      fromEl.removeAttribute('src');
      fromGain.value = 1;
      crossfadeInProgress = false;
    }, CROSSFADE_SECONDS * 1000 + 150);
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
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const el = activeEl();
    if (isPlaying) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  });

  function handleTimeUpdate(el) {
    if (!isActive(el) || isSeeking) return;
    const pct = el.duration ? (el.currentTime / el.duration) * 100 : 0;
    progressFill.style.width = pct + '%';
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
      crossfadeBtn.classList.contains('toggled') &&
      !crossfadeInProgress &&
      !repeatBtn.classList.contains('toggled') &&
      tracks.length > 1 &&
      el.duration &&
      remaining > 0 &&
      remaining <= CROSSFADE_SECONDS
    ) {
      const nextIndex = playOrder[(orderPos + 1) % playOrder.length];
      switchTrack(nextIndex, true);
    }
  }

  function handleEnded(el) {
    if (!isActive(el)) return;
    if (repeatBtn.classList.contains('toggled')) {
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    if (!crossfadeInProgress) stepTrack(1, true);
  }

  [audioA, audioB].forEach((el) => {
    el.addEventListener('play', () => { if (isActive(el)) setPlayingUI(true); });
    el.addEventListener('pause', () => { if (isActive(el)) setPlayingUI(false); });
    el.addEventListener('loadedmetadata', () => {
      if (isActive(el)) durationEl.textContent = formatTime(el.duration);
    });
    el.addEventListener('timeupdate', () => handleTimeUpdate(el));
    el.addEventListener('ended', () => handleEnded(el));
  });

  // Lets the OS/browser media notification show track info and respond to
  // hardware media keys (headphones, lock screen, etc).
  if ('mediaSession' in navigator) {
    const setHandler = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (err) { /* unsupported action */ }
    };
    setHandler('play', () => playBtn.click());
    setHandler('pause', () => playBtn.click());
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
    progressFill.style.width = (pct * 100) + '%';
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

  function applyVolume() {
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

  crossfadeBtn.addEventListener('click', () => {
    const active = crossfadeBtn.classList.toggle('toggled');
    crossfadeBtn.setAttribute('aria-pressed', active);
    localStorage.setItem('pulse:crossfade', active ? '1' : '0');
  });

  function applyEQ() {
    if (!audioCtx) return;
    ['A', 'B'].forEach((key) => {
      webAudioSlots[key].bass.gain.value = Number(eqBassSlider.value);
      webAudioSlots[key].mid.gain.value = Number(eqMidSlider.value);
      webAudioSlots[key].treble.gain.value = Number(eqTrebleSlider.value);
    });
  }

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

  function openLibrary() {
    closeSettings();
    libraryPanel.classList.add('open');
    libraryBtn.setAttribute('aria-pressed', 'true');
  }
  function closeLibrary() {
    libraryPanel.classList.remove('open');
    libraryBtn.setAttribute('aria-pressed', 'false');
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
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      volumeSlider.value = Math.min(100, Number(volumeSlider.value) + 5);
      volumeSlider.dispatchEvent(new Event('input'));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      volumeSlider.value = Math.max(0, Number(volumeSlider.value) - 5);
      volumeSlider.dispatchEvent(new Event('input'));
    }
  });

  function renderLibrary() {
    libCountEl.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    libraryList.innerHTML = '';

    if (!tracks.length) {
      const empty = document.createElement('p');
      empty.className = 'lib-empty';
      empty.textContent = 'No tracks yet — use the + or folder button above, or drop mp3 files anywhere on the page.';
      libraryList.appendChild(empty);
      return;
    }

    tracks.forEach((track, i) => {
      const row = document.createElement('div');
      row.className = 'lib-row' + (i === trackIndex ? ' active' : '');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'lib-row-main';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'lib-row-title';
      titleSpan.textContent = track.title;

      const artistSpan = document.createElement('span');
      artistSpan.className = 'lib-row-artist';
      artistSpan.textContent = track.artist;

      main.appendChild(titleSpan);
      main.appendChild(artistSpan);
      main.addEventListener('click', () => {
        switchTrack(i, true);
        closeLibrary();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'lib-row-remove';
      removeBtn.setAttribute('aria-label', `Remove ${track.title}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      row.appendChild(main);
      row.appendChild(removeBtn);
      libraryList.appendChild(row);
    });
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

    if (removed.id != null) {
      dbDeleteTrack(removed.id).catch((err) => {
        console.warn('Pulse: failed to delete track from storage', err);
      });
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
  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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

  // Guards against re-adding the same file twice (e.g. dropping the same
  // folder again in a later session, once it's already persisted).
  const knownFileKeys = new Set();

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(isAudioFile);
    if (!files.length) return;

    const wasEmpty = tracks.length === 0;
    let added = false;

    for (const file of files) {
      const dedupeKey = `${file.name}:${file.size}`;
      if (knownFileKeys.has(dedupeKey)) continue;
      knownFileKeys.add(dedupeKey);

      const fallback = parseFilenameMeta(file.name);
      const tags = await readTags(file);
      const title = (tags && tags.title) || fallback.title;
      const artist = (tags && tags.artist) || fallback.artist;

      const mood = pickMood(title, artist);
      const track = { id: null, title, artist, mood, name: file.name, size: file.size, url: URL.createObjectURL(file) };
      tracks.push(track);
      added = true;
      renderLibrary();

      dbAddTrack({ title, artist, mood, name: file.name, size: file.size, type: file.type, data: file })
        .then((id) => {
          track.id = id;
          if (id != null && tracks[trackIndex] === track) {
            localStorage.setItem('pulse:lastTrackId', id);
          }
        })
        .catch(() => {});
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
    records.forEach((rec) => {
      knownFileKeys.add(`${rec.name}:${rec.size}`);
      const mood = rec.mood || pickMood(rec.title, rec.artist);
      tracks.push({ id: rec.id, title: rec.title, artist: rec.artist, mood, name: rec.name, size: rec.size, url: URL.createObjectURL(rec.data) });
    });
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

    const zip = new JSZip();
    const metadata = records.map((rec) => {
      const filename = `${rec.id}-${sanitizeForFilename(rec.title)}.${extForType(rec.type)}`;
      zip.file(`audio/${filename}`, rec.data);
      return { id: rec.id, title: rec.title, artist: rec.artist, mood: rec.mood, type: rec.type, filename };
    });
    zip.file('metadata.json', JSON.stringify(metadata, null, 2));
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

  async function importLibrary(file) {
    try {
      const zip = await JSZip.loadAsync(file);
      const metaEntry = zip.file('metadata.json');
      if (!metaEntry) throw new Error('metadata.json not found in zip');
      const metadata = JSON.parse(await metaEntry.async('string'));

      const wasEmpty = tracks.length === 0;
      let importedCount = 0;

      for (const entry of metadata) {
        const alreadyExists = tracks.some((t) => t.title === entry.title && t.artist === entry.artist);
        if (alreadyExists) continue;

        const zipEntry = zip.file(`audio/${entry.filename}`);
        if (!zipEntry) continue;

        const rawBlob = await zipEntry.async('blob');
        const type = entry.type || 'audio/mpeg';
        const blob = new Blob([rawBlob], { type });
        const mood = entry.mood || pickMood(entry.title, entry.artist);

        const id = await dbAddTrack({
          title: entry.title,
          artist: entry.artist,
          mood,
          name: entry.filename,
          size: blob.size,
          type,
          data: blob,
        });

        knownFileKeys.add(`${entry.filename}:${blob.size}`);
        tracks.push({ id, title: entry.title, artist: entry.artist, mood, name: entry.filename, size: blob.size, url: URL.createObjectURL(blob) });
        importedCount++;
      }

      if (!importedCount) {
        alert('Nothing new to import — those tracks are already in your library.');
        return;
      }

      rebuildOrder();
      renderLibrary();
      if (wasEmpty) hardSwitch(0, false);
      flashSuccess(importBtn);
    } catch (err) {
      console.warn('Pulse: import failed', err);
      alert('Import failed — that file may not be a valid Pulse library export.');
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
      await importLibrary(zipBlob);
      hideSyncUI();
      setSyncStatus('Synced from your other device.');
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
    const savedVolume = localStorage.getItem('pulse:volume');
    if (savedVolume !== null) volumeSlider.value = savedVolume;
    applyVolume();
    volumeIcon.style.opacity = Number(volumeSlider.value) === 0 ? '0.4' : '1';

    if (localStorage.getItem('pulse:shuffle') === '1') {
      shuffleBtn.classList.add('toggled');
      shuffleBtn.setAttribute('aria-pressed', 'true');
    }
    if (localStorage.getItem('pulse:repeat') === '1') {
      repeatBtn.classList.add('toggled');
      repeatBtn.setAttribute('aria-pressed', 'true');
    }
    if (localStorage.getItem('pulse:crossfade') === '1') {
      crossfadeBtn.classList.add('toggled');
      crossfadeBtn.setAttribute('aria-pressed', 'true');
    }

    const savedBass = localStorage.getItem('pulse:eqBass');
    const savedMid = localStorage.getItem('pulse:eqMid');
    const savedTreble = localStorage.getItem('pulse:eqTreble');
    if (savedBass !== null) eqBassSlider.value = savedBass;
    if (savedMid !== null) eqMidSlider.value = savedMid;
    if (savedTreble !== null) eqTrebleSlider.value = savedTreble;
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
