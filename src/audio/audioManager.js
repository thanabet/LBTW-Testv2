// src/audio/audioManager.js
// SFX: WebAudio ✅ (with iOS background/foreground recovery)
// MUSIC: HTMLAudio ✅ (random no-repeat per time slot, ended->next)
// Fix added:
// - After leaving Safari, WebAudio AudioContext is often suspended/closed.
// - Ensure we RESUME context whenever SFX is enabled (not only first unlock).
// - Recreate AudioContext if it became "closed".
// - Track "needsResume" flag on pageshow/visibilitychange; resume on next user toggle.

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function once(el, evt, timeoutMs = 2000){
  return new Promise((resolve) => {
    let done = false;
    const on = () => {
      if(done) return;
      done = true;
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      el.removeEventListener(evt, on);
      if(tid) clearTimeout(tid);
    };
    el.addEventListener(evt, on, { once: true });
    const tid = setTimeout(() => {
      if(done) return;
      done = true;
      cleanup();
      resolve(false);
    }, timeoutMs);
  });
}

export class AudioManager {
  constructor(config){
    this.cfg = config || {};
    this.paths = {
      sfxBase:  this.cfg.sfxBasePath  || "assets/audio/sfx/",
      musicBase:this.cfg.musicBasePath|| "assets/audio/music/"
    };

    // enabled flags (truth for UI)
    this._sfxEnabled = false;
    this._musicEnabled = false;

    // unlock flags
    this._unlockedSfx = false;
    this._unlockedMusic = false;

    // volumes
    this._musicVol = clamp01(this.cfg.defaults?.musicVolume ?? 0.55);
    this._sfxVol   = clamp01(this.cfg.defaults?.sfxVolume ?? 1.0);
    this._musicFadeSec = Math.max(0.01, Number(this.cfg.defaults?.musicFadeSec ?? 1.0));

    // WebAudio for SFX
    this._ctx = null;
    this._sfxGain = null;
    this._buffers = new Map();
    this._loopNodes = new Map();

    // NEW: iOS background recovery
    this._sfxNeedsResume = false;

    // HTMLAudio for Music
    this._musicEl = new Audio();
    this._musicEl.loop = false;       // manage loop/end ourselves
    this._musicEl.preload = "auto";
    this._musicEl.crossOrigin = "anonymous";
    this._musicEl.volume = 0;
    this._musicEl.muted = false;
    this._musicEl.playsInline = true;

    this._musicKey = null;
    this._musicSwapLock = false;
    this._musicToggleLock = false;

    // cancelable fade
    this._fadeToken = 0;
    this._rafId = null;

    // Async start worker lock
    this._musicStartWorkerId = 0;

    // Auto music
    this._auto = this.cfg.autoMusic || {
      enabled: true,
      slots: [
        { start: "06:00", key: "lofi_morning" },
        { start: "10:00", key: "lofi_day" },
        { start: "17:00", key: "lofi_evening" },
        { start: "21:00", key: "lofi_night" }
      ]
    };

    // Track which slot is currently active (by start time string)
    this._activeSlotId = null;

    // Remember last played track per slot (to avoid repeats)
    this._lastTrackBySlot = new Map(); // slotId -> key

    // Story override
    this._storyMusicOverride = undefined;

    // rain follow cloudProfile overcast
    this._rainActive = false;

    // bind ended handler
    this._onMusicEnded = this._onMusicEnded.bind(this);
    this._musicEl.addEventListener("ended", this._onMusicEnded);

    // NEW: Listen for background/foreground changes (iOS suspends WebAudio)
    this._bindLifecycleHandlers();
  }

  isSfxEnabled(){ return this._sfxEnabled; }
  isMusicEnabled(){ return this._musicEnabled; }

  /* ---------------- lifecycle (NEW) ---------------- */

  _bindLifecycleHandlers(){
    // When returning to Safari, WebAudio often becomes suspended/needs user gesture to resume
    const markNeedsResume = () => {
      this._sfxNeedsResume = true;
    };

    document.addEventListener("visibilitychange", () => {
      if(document.visibilityState === "hidden") {
        // mark + optionally suspend (not required)
        this._sfxNeedsResume = true;
      } else {
        // visible again
        this._sfxNeedsResume = true;
      }
    });

    // iOS fires pageshow when coming back from app switch / bfcache
    window.addEventListener("pageshow", markNeedsResume);
    window.addEventListener("pagehide", markNeedsResume);
    window.addEventListener("focus", markNeedsResume);
  }

  /* ---------------- unlock SFX (WebAudio) ---------------- */

  async _createSfxContext(){
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return false;

    this._ctx = new AudioCtx();
    this._sfxGain = this._ctx.createGain();
    this._sfxGain.gain.value = this._sfxEnabled ? this._sfxVol : 0;
    this._sfxGain.connect(this._ctx.destination);

    // reset caches tied to old context
    this._buffers = new Map();

    // stop any old loops map (safety)
    this._loopNodes = new Map();

    return true;
  }

  async _resumeSfxContextIfNeeded(){
    if(!this._ctx) return;

    // If iOS closed it, recreate
    if(this._ctx.state === "closed"){
      await this._createSfxContext();
    }

    // Resume if suspended or flagged by lifecycle
    if(this._ctx && (this._ctx.state === "suspended" || this._sfxNeedsResume)){
      try { await this._ctx.resume(); } catch(_){}
      this._sfxNeedsResume = false;

      // tiny blip (helps on some iOS)
      try{
        const buf = this._ctx.createBuffer(1, 1, 22050);
        const src = this._ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this._ctx.destination);
        src.start(0);
      }catch(_){}
    }
  }

  async _ensureSfxUnlocked(){
    // IMPORTANT: do NOT early-return when unlocked, because iOS can suspend later.
    if(!this._ctx || !this._sfxGain){
      const ok = await this._createSfxContext();
      if(!ok) {
        this._unlockedSfx = true;
        return true;
      }
    }

    await this._resumeSfxContextIfNeeded();

    this._unlockedSfx = true;
    return true;
  }

  /* ---------------- unlock MUSIC (HTMLAudio) ---------------- */

  async _ensureMusicUnlocked(){
    if(this._unlockedMusic) return true;
    this._unlockedMusic = true;
    return true;
  }

  /* ---------------- toggles ---------------- */

  async toggleSfx(){
    this._sfxEnabled = !this._sfxEnabled;

    if(this._sfxEnabled){
      // NEW: always ensure + resume when enabling
      await this._ensureSfxUnlocked();
    }

    if(this._sfxGain){
      this._sfxGain.gain.value = this._sfxEnabled ? this._sfxVol : 0;
    }

    if(!this._sfxEnabled){
      this.stopLoop("rain_loop");
    } else {
      // if rain is active, restart after resume
      if(this._rainActive) {
        await this.playLoop("rain_loop", { fadeSec: 0.6 });
      }
    }

    return this._sfxEnabled;
  }

  async toggleMusic(){
    if(this._musicToggleLock) return this._musicEnabled;
    this._musicToggleLock = true;

    try{
      const wantOn = !this._musicEnabled;

      if(wantOn){
        await this._ensureMusicUnlocked();
        this._musicEnabled = true;

        this._kickMusicStartWorker({ forcePlay: true });
        return true;
      }

      this._musicEnabled = false;

      this._musicStartWorkerId++;
      this._cancelFade();

      await this._fadeMusicTo(0, 0.20);
      try{ this._musicEl.pause(); }catch(_){}
      return false;

    } finally {
      setTimeout(()=>{ this._musicToggleLock = false; }, 220);
    }
  }

  _kickMusicStartWorker({ forcePlay }){
    const myId = ++this._musicStartWorkerId;

    (async () => {
      if(!this._musicEnabled) return;
      if(myId !== this._musicStartWorkerId) return;

      const ok = await this._applyDesiredMusic(new Date(), { forcePlay: !!forcePlay });
      if(!ok){
        if(myId !== this._musicStartWorkerId) return;
        this._musicEnabled = false;
        this._cancelFade();
        await this._fadeMusicTo(0, 0.10);
        try{ this._musicEl.pause(); }catch(_){}
        return;
      }

      if(!this._musicEnabled) return;
      if(myId !== this._musicStartWorkerId) return;

      await this._fadeMusicTo(this._musicVol, 0.30);
    })().catch(()=>{});
  }

  /* ---------------- URL helpers ---------------- */

  _sfxUrl(key){
    const file = this.cfg.sfx?.[key];
    if(!file) return null;
    return this.paths.sfxBase + file;
  }

  _musicUrl(key){
    const file = this.cfg.music?.[key];
    if(!file) return null;
    return this.paths.musicBase + file;
  }

  _timeToMin(hhmm){
    const [h,m] = String(hhmm).split(":").map(n=>parseInt(n,10));
    return (h*60)+(m||0);
  }

  _getActiveSlot(now){
    const slots = (this._auto?.slots || []).slice().map(s => {
      const start = s.start ?? "00:00";
      return {
        start,
        startMin: this._timeToMin(start),
        key: s.key,
        keys: Array.isArray(s.keys) ? s.keys.slice() : null
      };
    }).sort((a,b)=>a.startMin-b.startMin);

    if(!slots.length) return null;

    const t = now.getHours()*60 + now.getMinutes();
    let pick = slots[0];
    for(const s of slots){
      if(t >= s.startMin) pick = s;
    }
    return pick;
  }

  _pickRandomNoRepeat(list, last){
    if(!Array.isArray(list) || list.length === 0) return null;
    if(list.length === 1) return list[0];

    for(let i=0;i<6;i++){
      const k = list[Math.floor(Math.random()*list.length)];
      if(k !== last) return k;
    }
    let idx = list.indexOf(last);
    if(idx < 0) idx = 0;
    return list[(idx + 1) % list.length];
  }

  /* ---------------- SFX ---------------- */

  async _loadBuffer(cacheKey, url){
    if(this._buffers.has(cacheKey)) return this._buffers.get(cacheKey);

    try{
      const res = await fetch(url, { cache: "force-cache" });
      if(!res.ok) return null;
      const arr = await res.arrayBuffer();
      const buf = await this._ctx.decodeAudioData(arr);
      this._buffers.set(cacheKey, buf);
      return buf;
    }catch(_){
      return null;
    }
  }

  async playSfx(key, { volume=1.0 } = {}){
    if(!this._sfxEnabled) return;
    await this._ensureSfxUnlocked();
    if(!this._ctx || !this._sfxGain) return;

    const url = this._sfxUrl(key);
    if(!url) return;

    const buf = await this._loadBuffer(key, url);
    if(!buf) return;

    const src = this._ctx.createBufferSource();
    src.buffer = buf;

    const g = this._ctx.createGain();
    g.gain.value = clamp01(volume);

    src.connect(g);
    g.connect(this._sfxGain);
    try { src.start(0); } catch(_){}
  }

  async playLoop(key, { volume=1.0, fadeSec=0.6 } = {}){
    if(!this._sfxEnabled) return;
    await this._ensureSfxUnlocked();
    if(!this._ctx || !this._sfxGain) return;
    if(this._loopNodes.has(key)) return;

    const url = this._sfxUrl(key);
    if(!url) return;

    const buf = await this._loadBuffer(key, url);
    if(!buf) return;

    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const g = this._ctx.createGain();
    g.gain.value = 0;

    src.connect(g);
    g.connect(this._sfxGain);

    try { src.start(0); } catch(_){}

    this._loopNodes.set(key, { src, gain: g });

    const target = clamp01(volume);
    const now = this._ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(target, now + Math.max(0.01, fadeSec));
  }

  stopLoop(key, { fadeSec=0.4 } = {}){
    if(!this._ctx){
      this._loopNodes.delete(key);
      return;
    }
    const node = this._loopNodes.get(key);
    if(!node) return;

    const now = this._ctx.currentTime;
    const g = node.gain;
    const dur = Math.max(0.01, fadeSec);

    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + dur);

    setTimeout(()=>{
      try{ node.src.stop(); }catch(_){}
      try{ node.src.disconnect(); }catch(_){}
      try{ node.gain.disconnect(); }catch(_){}
      this._loopNodes.delete(key);
    }, (dur*1000)+120);
  }

  /* ---------------- MUSIC (HTMLAudio) ---------------- */

  _cancelFade(){
    this._fadeToken++;
    if(this._rafId){
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _fadeMusicTo(target, sec){
    const endVol = clamp01(target);
    const startVol = this._musicEl.volume;
    const durMs = Math.max(10, sec*1000);
    const t0 = performance.now();
    const myToken = ++this._fadeToken;

    if(this._rafId){
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    return new Promise((resolve)=>{
      const step = (t)=>{
        if(myToken !== this._fadeToken) return resolve();
        const k = Math.min(1, (t - t0) / durMs);
        this._musicEl.volume = startVol + (endVol - startVol) * k;
        if(k >= 1){
          this._rafId = null;
          return resolve();
        }
        this._rafId = requestAnimationFrame(step);
      };
      this._rafId = requestAnimationFrame(step);
    });
  }

  async _ensureMusicPlaying(url){
    const same = this._musicEl.src && this._musicEl.src.includes(url);

    if(this._musicSwapLock) return true;
    this._musicSwapLock = true;

    try{
      this._cancelFade();
      this._musicEl.volume = 0;
      try{ this._musicEl.pause(); }catch(_){}

      if(!same){
        this._musicEl.src = url;
        this._musicEl.loop = false;
        this._musicEl.preload = "auto";
        try{ this._musicEl.load(); }catch(_){}
        await once(this._musicEl, "canplay", 2200);
      }

      try{
        const p = this._musicEl.play();
        if(p && typeof p.then === "function") await p;
      }catch(_){
        return false;
      }

      await once(this._musicEl, "playing", 1200);
      return true;
    } finally {
      this._musicSwapLock = false;
    }
  }

  async playMusic(key){
    const url = this._musicUrl(key);
    if(!url) return false;

    const ok = await this._ensureMusicPlaying(url);
    if(!ok) return false;

    this._musicKey = key;
    return true;
  }

  async _onMusicEnded(){
    if(!this._musicEnabled) return;

    if(typeof this._storyMusicOverride === "string"){
      if(this._musicKey){
        try{
          this._musicEl.currentTime = 0;
          const p = this._musicEl.play();
          if(p && typeof p.then === "function") await p;
        }catch(_){}
      }
      return;
    }

    if(this._auto?.enabled === false) return;

    const now = new Date();
    const slot = this._getActiveSlot(now);
    if(!slot) return;

    if(slot.start !== this._activeSlotId){
      this._kickMusicStartWorker({ forcePlay: true });
      return;
    }

    const list = Array.isArray(slot.keys) ? slot.keys : (slot.key ? [slot.key] : []);
    if(!list.length) return;

    const last = this._lastTrackBySlot.get(slot.start) || null;
    const nextKey = this._pickRandomNoRepeat(list, last) || list[0];

    this._lastTrackBySlot.set(slot.start, nextKey);
    this._musicKey = nextKey;

    this._kickMusicStartWorker({ forcePlay: true });
  }

  /* ---------------- STORY + AUTO ---------------- */

  async applyStoryState(now, state){
    const profile = state?.cloudProfile || "none";
    const shouldRain = (profile === "overcast");

    if(shouldRain !== this._rainActive){
      this._rainActive = shouldRain;
      if(this._sfxEnabled){
        if(shouldRain) await this.playLoop("rain_loop", { fadeSec: 1.0 });
        else this.stopLoop("rain_loop", { fadeSec: 1.0 });
      }
    }

    const musicTrack = state?.audio?.musicTrack;
    if(typeof musicTrack !== "undefined"){
      this._storyMusicOverride = musicTrack;
    }

    if(this._musicEnabled){
      this._kickMusicStartWorker({ forcePlay: false });
    }
  }

  async _applyDesiredMusic(now, { forcePlay=false } = {}){
    let desiredKey = null;

    if(typeof this._storyMusicOverride === "string"){
      desiredKey = this._storyMusicOverride;
      this._activeSlotId = null;
    } else {
      if(this._auto?.enabled === false){
        desiredKey = null;
        this._activeSlotId = null;
      } else {
        const slot = this._getActiveSlot(now);
        if(!slot){
          desiredKey = null;
          this._activeSlotId = null;
        } else {
          const slotId = slot.start;
          this._activeSlotId = slotId;

          const list = Array.isArray(slot.keys) ? slot.keys : (slot.key ? [slot.key] : []);
          if(!list.length){
            desiredKey = null;
          } else {
            const last = this._lastTrackBySlot.get(slotId) || null;
            desiredKey = this._pickRandomNoRepeat(list, last) || list[0];
            this._lastTrackBySlot.set(slotId, desiredKey);
          }
        }
      }
    }

    if(!desiredKey){
      this._cancelFade();
      await this._fadeMusicTo(0, 0.20);
      try{ this._musicEl.pause(); }catch(_){}
      this._musicKey = null;
      return true;
    }

    if(forcePlay || desiredKey !== this._musicKey){
      const ok = await this.playMusic(desiredKey);
      if(!ok) return false;
      return true;
    }

    return true;
  }
}