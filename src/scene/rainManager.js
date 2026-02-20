// src/scene/rainManager.js
export class RainManager {
  constructor(container){
    this.container = container;

    // rain frames (sprites)
    this.frames = [];
    this.frameUrls = [];
    this.frameDurationsSec = [];

    this._frameIndex = 0;
    this._frameT = 0;

    // fade in/out
    this._targetAlpha = 0;
    this._alpha = 0;
    this._fadeSec = 3.0;

    // state
    this._enabled = false;

    // scene rect (px)
    this.rect = { x:0, y:0, w:100, h:100 };

    // lightning overlay (white flash)
    this.flash = new PIXI.Graphics();
    this.flash.alpha = 0;
    this.container.addChild(this.flash);

    // lightning random scheduler (only when raining visible)
    this._lightningEnabled = true;          // global enable (config + overrides)
    this._lightningMinSec = 10;
    this._lightningMaxSec = 35;

    this._nextLightningIn = this._rand(this._lightningMinSec, this._lightningMaxSec);
    this._flashSeq = null; // [{a,d}] queue
    this._flashT = 0;
    this._flashStep = 0;
  }

  async load(config){
    // config: { frames:[...], durationsMs:[...], fadeSec, lightning:{...} }
    this.frameUrls = config.frames || [];
    const dms = config.durationsMs || [];
    this.frameDurationsSec = this.frameUrls.map((_, i) => ((dms[i] ?? 120) / 1000));

    this._fadeSec = Math.max(0.01, Number(config.fadeSec ?? 3.0) || 3.0);

    const L = config.lightning || {};
    this._lightningEnabled = L.enabled !== false;
    this._lightningMinSec = Math.max(0.1, Number(L.minIntervalSec ?? 10) || 10);
    this._lightningMaxSec = Math.max(this._lightningMinSec, Number(L.maxIntervalSec ?? 35) || 35);

    // preload textures
    const textures = await Promise.all(this.frameUrls.map(u => PIXI.Assets.load(u)));

    // clear old sprites
    this.frames.forEach(s => this.container.removeChild(s));
    this.frames = [];

    // build sprites
    for(const tex of textures){
      const s = new PIXI.Sprite(tex);
      s.alpha = 0;
      this.frames.push(s);
      this.container.addChildAt(s, 0); // behind flash overlay
    }

    // reset
    this._frameIndex = 0;
    this._frameT = 0;
    this._alpha = 0;
    this._targetAlpha = 0;
    this._enabled = false;

    this._nextLightningIn = this._rand(this._lightningMinSec, this._lightningMaxSec);
    this._flashSeq = null;
    this.flash.alpha = 0;

    // apply layout if rect already set
    this.resizeToRect(this.rect);
  }

  setEnabled(on){
    this._enabled = !!on;
    this._targetAlpha = this._enabled ? 1 : 0;

    // if turning off, also kill any flash sequence immediately (optional but feels clean)
    if(!this._enabled){
      this._flashSeq = null;
      this.flash.alpha = 0;
    }
  }

  // ✅ NEW: override lightning on/off (true/false)
  setLightningEnabled(on){
    this._lightningEnabled = !!on;

    if(!this._lightningEnabled){
      // stop any ongoing flashes immediately
      this._flashSeq = null;
      this.flash.alpha = 0;
    }else{
      // reschedule
      this._nextLightningIn = this._rand(this._lightningMinSec, this._lightningMaxSec);
    }
  }

  setFadeSec(sec){
    this._fadeSec = Math.max(0.01, Number(sec) || 3.0);
  }

  resizeToRect(sceneRectPx){
    this.rect = sceneRectPx;

    // cover fit each frame within scene rect
    for(const s of this.frames){
      this._cover(s, this.rect);
      s.x = this.rect.x + (this.rect.w - s.width) / 2;
      s.y = this.rect.y + (this.rect.h - s.height) / 2;
    }

    // rebuild flash rect
    this.flash.clear();
    this.flash.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    this.flash.fill({ color: 0xffffff, alpha: 1 });
  }

  update(dtSec){
    if(!this.frames.length) return;

    // fade alpha
    const speed = dtSec / this._fadeSec;
    if(this._alpha < this._targetAlpha){
      this._alpha = Math.min(this._targetAlpha, this._alpha + speed);
    }else if(this._alpha > this._targetAlpha){
      this._alpha = Math.max(this._targetAlpha, this._alpha - speed);
    }

    // apply alpha & frame visibility
    for(let i=0; i<this.frames.length; i++){
      this.frames[i].alpha = (i === this._frameIndex ? this._alpha : 0);
    }

    // animate frames only when visible
    if(this._alpha > 0.001){
      const dur = this.frameDurationsSec[this._frameIndex] ?? 0.12;
      this._frameT += dtSec;
      if(this._frameT >= dur){
        this._frameT = 0;
        this._frameIndex = (this._frameIndex + 1) % this.frames.length;
      }
    }

    // lightning
    this._updateLightning(dtSec);
  }

  /* ---------------- lightning ---------------- */

  _updateLightning(dtSec){
    // play flash sequence if active
    if(this._flashSeq){
      this._flashT += dtSec;
      const step = this._flashSeq[this._flashStep];
      if(!step){
        // done
        this._flashSeq = null;
        this.flash.alpha = 0;
        this._flashT = 0;
        this._flashStep = 0;
        this._nextLightningIn = this._rand(this._lightningMinSec, this._lightningMaxSec);
        return;
      }

      this.flash.alpha = step.a;

      if(this._flashT >= step.d){
        this._flashT = 0;
        this._flashStep++;
      }
      return;
    }

    // schedule next lightning
    if(!this._lightningEnabled) return;
    if(this._alpha < 0.15) return; // only when rain is actually seen

    this._nextLightningIn -= dtSec;
    if(this._nextLightningIn <= 0){
      this._startLightningFlash();
    }
  }

  _startLightningFlash(){
    // 🔔 NEW: emit global event so audio can sync thunder
    try{
      window.dispatchEvent(new CustomEvent("lbtw:lightning"));
    }catch(_){}

    // 2–3 quick flashes
    const patterns = [
      // 2 flashes
      [
        { a: 0.00, d: 0.02 },
        { a: 0.95, d: 0.05 },
        { a: 0.00, d: 0.06 },
        { a: 0.75, d: 0.04 },
        { a: 0.00, d: 0.10 }
      ],
      // 3 flashes
      [
        { a: 0.00, d: 0.02 },
        { a: 0.95, d: 0.05 },
        { a: 0.00, d: 0.05 },
        { a: 0.65, d: 0.04 },
        { a: 0.00, d: 0.05 },
        { a: 0.85, d: 0.03 },
        { a: 0.00, d: 0.12 }
      ]
    ];

    const pick = (Math.random() < 0.5) ? 0 : 1;
    this._flashSeq = patterns[pick];
    this._flashT = 0;
    this._flashStep = 0;
  }

  /* ---------------- utils ---------------- */

  _cover(sprite, rect){
    if(!sprite.texture?.width) return;
    const tw = sprite.texture.width;
    const th = sprite.texture.height;
    const s = Math.max(rect.w / tw, rect.h / th);
    sprite.scale.set(s);
  }

  _rand(a, b){
    return a + Math.random() * (b - a);
  }
}
