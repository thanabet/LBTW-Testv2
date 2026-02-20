export class SkyManager {
  constructor(stage){
    this.stage = stage;
    this.textures = [];
    this.a = new PIXI.Sprite();
    this.b = new PIXI.Sprite();

    this.a.alpha = 1;
    this.b.alpha = 0;

    this.stage.addChild(this.a, this.b);

    this.rect = { x:0, y:0, w:100, h:100 };

    // --- old discrete-fade mode (ยังอยู่) ---
    this.currentIndex = 0;
    this.targetIndex = 0;
    this.fadeStart = 0;
    this.fadeDurationMs = 90_000;
    this.isFading = false;
    this._fadeToken = 0;

    // --- NEW keyframe mode ---
    this.mode = "discrete"; // "keyframes" | "discrete"
    this.keyframes = [];    // [{ minute, texIndex }]
  }

  async load({ urls, keyframes = null, mode = null }){
    // โหลด texture
    this.textures = await Promise.all(urls.map(u => PIXI.Assets.load(u)));

    // ตั้งโหมด
    if(mode) this.mode = mode;
    if(keyframes?.length){
      this.mode = "keyframes";
      this._buildKeyframes(keyframes, urls);
    }

    // set initial sky correctly at first frame
    const now = new Date();
    if(this.mode === "keyframes"){
      this._applyKeyframeBlend(now); // ตั้งให้ตรงเวลาปัจจุบันทันที
    }else{
      const idx = this._timeToIndex(now);
      this.currentIndex = idx;
      this.targetIndex = idx;
      this.a.texture = this.textures[idx];
      this.b.texture = this.textures[idx];
      this.a.alpha = 1;
      this.b.alpha = 0;
    }
  }

  resizeToRect(rect){
    this.rect = rect;
    this._cover(this.a, rect);
    this._cover(this.b, rect);
  }

  _cover(sprite, rect){
    if(!sprite.texture?.width) return;

    const tw = sprite.texture.width;
    const th = sprite.texture.height;

    const s = Math.max(rect.w / tw, rect.h / th);
    sprite.scale.set(s);

    sprite.x = rect.x + (rect.w - tw * s) / 2;
    sprite.y = rect.y + (rect.h - th * s) / 2;
  }

  // ---------- NEW: keyframes ----------
  _parseTimeToMinute(str){
    const [hh, mm] = str.split(":").map(n => parseInt(n, 10));
    return (hh * 60) + (mm || 0);
  }

  _buildKeyframes(keyframes, urls){
    // keyframes: [{ time:"HH:MM", src:"./assets/sky/xxx.png" }]
    // map src -> index in urls
    const map = new Map();
    urls.forEach((u, i)=> map.set(u, i));

    this.keyframes = keyframes
      .map(k => ({
        minute: this._parseTimeToMinute(k.time),
        texIndex: map.get(k.src)
      }))
      .filter(k => typeof k.texIndex === "number")
      .sort((a,b)=>a.minute-b.minute);
  }

  _smoothstep(t){
    return t*t*(3-2*t);
  }

  _applyKeyframeBlend(now){
    if(!this.keyframes.length) return;

    const m = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;

    // หา keyframe ก่อนหน้า + ถัดไป (wrap ข้ามวัน)
    const kfs = this.keyframes;

    let i1 = kfs.findIndex(k => k.minute > m);
    if(i1 === -1) i1 = 0;               // wrap ไปตัวแรกของวันถัดไป
    const i0 = (i1 - 1 + kfs.length) % kfs.length;

    const k0 = kfs[i0];
    const k1 = kfs[i1];

    const m0 = k0.minute;
    const m1 = (k1.minute > m0) ? k1.minute : (k1.minute + 1440); // wrap
    const mm = (m >= m0) ? m : (m + 1440);

    const t = (mm - m0) / (m1 - m0);
    const s = this._smoothstep(Math.min(1, Math.max(0, t)));

    // set textures
    this.a.texture = this.textures[k0.texIndex];
    this.b.texture = this.textures[k1.texIndex];
    this._cover(this.a, this.rect);
    this._cover(this.b, this.rect);

    // blend
    this.a.alpha = 1 - s;
    this.b.alpha = s;
  }

  // ---------- old discrete mode ----------
  _timeToIndex(now){
    const h = now.getHours() + now.getMinutes()/60;
    if(h >= 5.5 && h < 8) return 0;
    if(h >= 8 && h < 17.5) return 1;
    if(h >= 17.5 && h < 19) return 2;
    if(h >= 19 && h < 22.5) return 3;
    return 4;
  }

  updateByTime(now){
    if(this.mode === "keyframes"){
      // continuous blend (no RAF fade needed)
      this._applyKeyframeBlend(now);
      return;
    }

    // discrete mode (ของเดิม + fix กันซ้ำ)
    const idx = this._timeToIndex(now);

    if(this.isFading){
      if(idx === this.targetIndex) return;
      return;
    } else {
      if(idx === this.currentIndex) return;
    }

    this.isFading = true;
    const token = ++this._fadeToken;

    this.targetIndex = idx;
    this.fadeStart = performance.now();

    this.b.texture = this.textures[this.targetIndex];
    this._cover(this.b, this.rect);

    this.b.alpha = 0;
    this.a.alpha = 1;

    const animateFade = () => {
      if(token !== this._fadeToken) return;

      const t = (performance.now() - this.fadeStart) / this.fadeDurationMs;
      const clamped = Math.min(1, t);
      const s = this._smoothstep(clamped);

      this.b.alpha = s;
      this.a.alpha = 1 - s;

      if(clamped < 1){
        requestAnimationFrame(animateFade);
      } else {
        this.currentIndex = this.targetIndex;
        this.a.texture = this.textures[this.currentIndex];
        this._cover(this.a, this.rect);
        this.a.alpha = 1;
        this.b.alpha = 0;

        this.isFading = false;
      }
    };

    requestAnimationFrame(animateFade);
  }
}
