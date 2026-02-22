// src/scene/actors/catActor.js
// Interactive Cat Actor
// - Appears randomly 08:00-18:00, 2-3 sessions/day, ~1 hour each
// - Has 4 clips: enter (once), idle (loop), react (once on tap), exit (once)
// - Tap only works when in idle
// - If rain is ON -> do not appear; if currently visible:
//     - exit_only: wait rainExitDelaySec then play exit then hide
//     - react_then_exit: play react (scared) + optional meow, then wait rainExitDelaySec then play exit then hide
// - Hitbox is percent inside sceneRect
// - Safe load: missing PNG frames won't crash, cat just won't show.

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function parseHHMM(s){
  const m = String(s||"").trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const hh = clamp(Number(m[1]), 0, 23);
  const mm = clamp(Number(m[2]), 0, 59);
  return hh*60 + mm;
}

function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str){
  // FNV-1a 32-bit
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Clip {
  constructor({ name, frames, durationsMs, loop }){
    this.name = name;
    this.frames = frames;
    this.durationsMs = durationsMs;
    this.loop = loop;
    this._textures = [];
  }
}

class Animator {
  constructor(sprite){
    this.sprite = sprite;
    this.clip = null;
    this._textures = [];
    this._i = 0;
    this._accMs = 0;
    this._playing = false;
    this._finishedOnce = false;
  }

  setClip(clip){
    this.clip = clip;
    this._textures = Array.isArray(clip?._textures) ? clip._textures : [];
    this._i = 0;
    this._accMs = 0;
    this._finishedOnce = false;

    if(this._textures.length === 0){
      this.sprite.visible = false;
      this.sprite.texture = PIXI.Texture.EMPTY;
      this._playing = false;
      return;
    }

    this.sprite.visible = true;
    this.sprite.texture = this._textures[0];
    this._playing = true;
  }

  stopAndHide(){
    this._playing = false;
    this._finishedOnce = false;
    this._i = 0;
    this._accMs = 0;
    this.sprite.visible = false;
    this.sprite.texture = PIXI.Texture.EMPTY;
  }

  isFinishedOnce(){
    return this._finishedOnce;
  }

  update(dtSec){
    if(!this._playing || !this.clip) return;
    if(this._textures.length === 0) return;

    const dtMs = dtSec * 1000;
    this._accMs += dtMs;

    const dur = this.clip.durationsMs || [];
    const getDur = (idx) => Math.max(1, Number(dur[idx] ?? 100) || 100);

    while(this._accMs >= getDur(this._i)){
      this._accMs -= getDur(this._i);
      this._i += 1;

      if(this._i >= this._textures.length){
        if(this.clip.loop){
          this._i = 0;
        } else {
          this._i = this._textures.length - 1;
          this.sprite.texture = this._textures[this._i];
          this._playing = false;
          this._finishedOnce = true;
          return;
        }
      }

      this.sprite.texture = this._textures[this._i];
    }
  }
}

export class CatActor {
  constructor(parentContainer){
    this.parent = parentContainer;

    this.container = new PIXI.Container();
    this.container.visible = false;

    this.sprite = new PIXI.Sprite();
    this.sprite.visible = false;
    this.container.addChild(this.sprite);

    this.parent.addChild(this.container);

    this._rect = { x:0, y:0, w:100, h:100 };

    this._basePath = "assets/scene/actors/cat/";
    this._id = "cat";

    this._hitboxPct = { x: 70, y: 30, w: 20, h: 20 };
    this._hitboxPx = { x:0, y:0, w:0, h:0 };

    this._dayWindow = { startMin: 480, endMin: 1080 };
    this._sessionsPerDay = { min: 2, max: 3 };
    this._sessionDurationMin = 60;
    this._sessionDurationJitterMin = 0;
    this._skipWhenRain = true;

    // rain exit behavior
    this._rainExitMode = "exit_only"; // "exit_only" | "react_then_exit"
    this._rainExitDelaySec = 0;

    // NEW: rain meow options
    this._rainPlayMeow = false;
    this._rainMeowSfxKey = "cat_meow";

    // rain state helpers
    this._rainPhase = "none"; // none | reacting | waiting | exiting
    this._rainExitTimer = 0;
    this._rainTriggered = false;
    this._rainMeowPlayed = false;

    this._clips = new Map();
    this._texturesByUrl = new Map();

    this.anim = new Animator(this.sprite);

    this._state = "hidden"; // hidden | enter | idle | react | exit
    this._currentDateKey = null;
    this._todaySessions = [];
    this._activeSession = null;
  }

  async load(cfg){
    cfg = cfg && typeof cfg === "object" ? cfg : {};

    this._id = String(cfg.id ?? "cat").trim() || "cat";
    this._basePath = cfg.basePath ?? this._basePath;

    if(cfg.hitboxPct && typeof cfg.hitboxPct === "object"){
      this._hitboxPct = {
        x: Number(cfg.hitboxPct.x ?? this._hitboxPct.x),
        y: Number(cfg.hitboxPct.y ?? this._hitboxPct.y),
        w: Number(cfg.hitboxPct.w ?? this._hitboxPct.w),
        h: Number(cfg.hitboxPct.h ?? this._hitboxPct.h)
      };
    }

    const startMin = parseHHMM(cfg.activeBetween?.start ?? "08:00");
    const endMin = parseHHMM(cfg.activeBetween?.end ?? "18:00");
    this._dayWindow.startMin = (startMin == null ? 480 : startMin);
    this._dayWindow.endMin = (endMin == null ? 1080 : endMin);

    this._sessionsPerDay.min = Number(cfg.sessionsPerDay?.min ?? 2);
    this._sessionsPerDay.max = Number(cfg.sessionsPerDay?.max ?? 3);

    this._sessionDurationMin = Number(cfg.sessionDurationMin ?? 60);
    this._sessionDurationJitterMin = Number(cfg.sessionDurationJitterMin ?? 0);

    this._skipWhenRain = (cfg.skipWhenRain !== undefined) ? !!cfg.skipWhenRain : true;

    const mode = String(cfg.rainExitMode ?? "exit_only").trim().toLowerCase();
    this._rainExitMode = (mode === "react_then_exit") ? "react_then_exit" : "exit_only";

    this._rainExitDelaySec = Number(cfg.rainExitDelaySec ?? 0);
    if(!Number.isFinite(this._rainExitDelaySec) || this._rainExitDelaySec < 0) this._rainExitDelaySec = 0;

    // NEW: rain meow config
    this._rainPlayMeow = !!cfg.rainPlayMeow;
    this._rainMeowSfxKey = String(cfg.rainMeowSfxKey ?? "cat_meow").trim() || "cat_meow";

    this._rainPhase = "none";
    this._rainExitTimer = 0;
    this._rainTriggered = false;
    this._rainMeowPlayed = false;

    this._clips.clear();
    this._texturesByUrl.clear();

    const clipsObj = (cfg.clips && typeof cfg.clips === "object") ? cfg.clips : {};
    const urlsToLoad = new Set();

    for(const [name, def] of Object.entries(clipsObj)){
      const frames = Array.isArray(def?.frames) ? def.frames.map(f => this._resolveUrl(f)) : [];
      const durationsMs = Array.isArray(def?.durationsMs) ? def.durationsMs : [];
      const loop = def?.loop !== undefined ? !!def.loop : true;

      const clip = new Clip({ name, frames, durationsMs, loop });
      this._clips.set(name, clip);
      frames.forEach(u => urlsToLoad.add(u));
    }

    const tasks = [...urlsToLoad].map(async (u)=>{
      try{
        const tex = await PIXI.Assets.load(u);
        if(tex) this._texturesByUrl.set(u, tex);
      }catch(e){
        // ignore missing
      }
    });
    await Promise.allSettled(tasks);

    for(const clip of this._clips.values()){
      clip._textures = clip.frames.map(u => this._texturesByUrl.get(u)).filter(Boolean);
    }

    this._forceHidden();
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;

    const r = this._rect;
    const hp = this._hitboxPct;

    this._hitboxPx = {
      x: r.x + (hp.x/100) * r.w,
      y: r.y + (hp.y/100) * r.h,
      w: (hp.w/100) * r.w,
      h: (hp.h/100) * r.h
    };

    this._cover(this.sprite);
  }

  update(now, dtSec, storyState){
    const rainOn = this._resolveRainEnabled(storyState);

    // ---------- RAIN GATING (cinematic) ----------
    if(this._skipWhenRain && rainOn){
      if(this._state === "hidden"){
        this._activeSession = null;
        return;
      }

      if(!this._rainTriggered){
        this._rainTriggered = true;
        this._rainExitTimer = 0;
        this._rainMeowPlayed = false;

        if(this._rainExitMode === "react_then_exit"){
          this._rainPhase = "reacting";
          if(this._state !== "react"){
            this._playState("react");
          }

          // NEW: play meow once at rain start (when we trigger react)
          if(this._rainPlayMeow && !this._rainMeowPlayed){
            this._rainMeowPlayed = true;
            window.dispatchEvent(new CustomEvent("lbtw:actorSfx", {
              detail: { key: this._rainMeowSfxKey, actorId: this._id }
            }));
          }
        } else {
          this._rainPhase = "waiting";
        }
      }

      // advance animation
      this.anim.update(dtSec);

      if(this._rainExitMode === "react_then_exit"){
        if(this._rainPhase === "reacting"){
          if(this._state === "react" && this.anim.isFinishedOnce()){
            this._rainPhase = "waiting";
            this._rainExitTimer = 0;

            // go idle while waiting (looks alive)
            this._playState("idle");
          }
          return;
        }

        if(this._rainPhase === "waiting"){
          if(this._rainExitTimer < this._rainExitDelaySec){
            this._rainExitTimer += dtSec;
            this.anim.update(dtSec);
            return;
          }
          this._rainPhase = "exiting";
        }

        if(this._rainPhase === "exiting"){
          if(this._state !== "exit"){
            this._playState("exit");
          }
          this.anim.update(dtSec);

          if(this._state === "exit" && this.anim.isFinishedOnce()){
            this._forceHidden();
            this._activeSession = null;
          }
          return;
        }

        return;
      }

      // exit_only mode
      if(this._rainPhase === "waiting"){
        if(this._rainExitTimer < this._rainExitDelaySec){
          this._rainExitTimer += dtSec;
          this.anim.update(dtSec);
          return;
        }
        this._rainPhase = "exiting";
      }

      if(this._rainPhase === "exiting"){
        if(this._state !== "exit"){
          this._playState("exit");
        }
        this.anim.update(dtSec);

        if(this._state === "exit" && this.anim.isFinishedOnce()){
          this._forceHidden();
          this._activeSession = null;
        }
        return;
      }

      return;
    }

    // rain stopped -> reset rain sequence flags
    this._rainTriggered = false;
    this._rainPhase = "none";
    this._rainExitTimer = 0;
    this._rainMeowPlayed = false;

    // ---------- DAILY SCHEDULE ----------
    const dateKey = this._getDateKey(now);
    if(dateKey !== this._currentDateKey){
      this._currentDateKey = dateKey;
      this._todaySessions = this._buildSessionsForDate(now, dateKey);
      this._activeSession = null;
      this._forceHidden();
    }

    const tMs = now.getTime();
    let active = null;
    for(const s of this._todaySessions){
      if(tMs >= s.startMs && tMs < s.endMs){
        active = s;
        break;
      }
    }

    if(!active){
      if(this._state !== "hidden"){
        if(this._state !== "exit"){
          this._playState("exit");
        }
        this.anim.update(dtSec);
        if(this.anim.isFinishedOnce()){
          this._forceHidden();
        }
      }
      return;
    }

    this._activeSession = active;

    if(this._state === "hidden"){
      this._playState("enter");
    }

    this.anim.update(dtSec);

    if(this._state === "enter" && this.anim.isFinishedOnce()){
      this._playState("idle");
    }

    if(this._state === "react" && this.anim.isFinishedOnce()){
      this._playState("idle");
    }

    if(tMs >= active.endMs && this._state !== "exit"){
      this._playState("exit");
    }

    if(this._state === "exit"){
      if(this.anim.isFinishedOnce()){
        this._forceHidden();
      }
    }
  }

  onPointerTap(globalX, globalY){
    if(this._state !== "idle") return false;
    if(!this.container.visible) return false;

    const hb = this._hitboxPx;
    const inside =
      globalX >= hb.x && globalX <= (hb.x + hb.w) &&
      globalY >= hb.y && globalY <= (hb.y + hb.h);

    if(!inside) return false;

    this._playState("react");

    window.dispatchEvent(new CustomEvent("lbtw:actorSfx", {
      detail: { key: "cat_meow", actorId: this._id }
    }));

    return true;
  }

  // ---------- internals ----------
  _playState(state){
    const clip = this._clips.get(state);

    if(!clip || !clip._textures || clip._textures.length === 0){
      this._forceHidden();
      return;
    }

    this._state = state;
    this.container.visible = true;
    this.sprite.visible = true;

    this.anim.setClip(clip);
    this._cover(this.sprite);
  }

  _forceHidden(){
    this._state = "hidden";
    this.container.visible = false;
    this.sprite.visible = false;
    this.anim.stopAndHide();
  }

  _getDateKey(now){
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,"0");
    const d = String(now.getDate()).padStart(2,"0");
    return `${y}-${m}-${d}`;
  }

  _buildSessionsForDate(now, dateKey){
    const seed = hashStringToSeed(`${dateKey}::${this._id}`);
    const rand = mulberry32(seed);

    const startMin = this._dayWindow.startMin;
    const endMin = this._dayWindow.endMin;
    const windowMinutes = Math.max(1, endMin - startMin);

    const countMin = Math.max(0, Math.floor(this._sessionsPerDay.min));
    const countMax = Math.max(countMin, Math.floor(this._sessionsPerDay.max));
    const sessionCount = countMin + Math.floor(rand() * (countMax - countMin + 1));

    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const sessions = [];

    const durBase = Math.max(1, this._sessionDurationMin);
    const durJit = Math.max(0, this._sessionDurationJitterMin);

    for(let i=0;i<sessionCount;i++){
      const dur = durBase + (durJit ? Math.floor((rand()*2 - 1) * durJit) : 0);
      const durClamped = clamp(dur, 5, windowMinutes);

      const maxStart = Math.max(startMin, endMin - durClamped);
      const sMin = startMin + Math.floor(rand() * (maxStart - startMin + 1));
      const eMin = sMin + durClamped;

      const startMs = baseDate.getTime() + sMin * 60 * 1000;
      const endMs = baseDate.getTime() + eMin * 60 * 1000;

      sessions.push({ startMs, endMs });
    }

    sessions.sort((a,b) => a.startMs - b.startMs);

    for(let i=1;i<sessions.length;i++){
      const prev = sessions[i-1];
      const cur = sessions[i];

      if(cur.startMs < prev.endMs){
        const shift = prev.endMs - cur.startMs;
        cur.startMs += shift;
        cur.endMs += shift;

        const windowEndMs = baseDate.getTime() + endMin * 60 * 1000;
        if(cur.endMs > windowEndMs){
          sessions.splice(i, 1);
          i -= 1;
        }
      }
    }

    return sessions;
  }

  _resolveRainEnabled(storyState){
    const profile =
      storyState?.cloudProfile ??
      storyState?.state?.cloudProfile ??
      "none";

    const override =
      (storyState?.rain !== undefined) ? storyState.rain :
      (storyState?.state?.rain !== undefined) ? storyState.state.rain :
      undefined;

    if(override === true) return true;
    if(override === false) return false;

    const p = String(profile).trim().toLowerCase();
    return (p === "overcast");
  }

  _resolveUrl(frame){
    const f = String(frame || "");
    if(!f) return "";
    if(f.startsWith("http://") || f.startsWith("https://") || f.startsWith("./") || f.startsWith("/")){
      return f;
    }
    return `${this._basePath}${f}`;
  }

  _cover(sprite){
    const r = this._rect;
    if(!sprite.texture || !sprite.texture.width || !sprite.texture.height) return;

    const tw = sprite.texture.width;
    const th = sprite.texture.height;

    const sx = r.w / tw;
    const sy = r.h / th;
    const s = Math.max(sx, sy);

    sprite.scale.set(s, s);

    const w = tw * s;
    const h = th * s;

    sprite.x = r.x + (r.w - w) / 2;
    sprite.y = r.y + (r.h - h) / 2;
  }
}