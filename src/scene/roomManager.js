// src/scene/roomManager.js
// Room system: time-slot + roomLight (on/off) using 2-sprite crossfade.
// - Slots decide base key by time (dawn/day/sunset/evening/night)
// - roomLight decides suffix (_off/_on)
// - If time-slot changes -> crossfade
// - If only light changes -> instant switch (NO fade)

export class RoomManager {
  constructor(container){
    this.container = container;

    this.spriteA = new PIXI.Sprite();
    this.spriteB = new PIXI.Sprite();
    this.container.addChild(this.spriteA);
    this.container.addChild(this.spriteB);

    this.spriteA.alpha = 0;
    this.spriteB.alpha = 0;

    this._active = "A";

    this._slots = [];
    this._basePath = "assets/scene/room/";
    this._filePattern = "{key}_{light}.png";

    this._fadeSec = 3.0;
    this._lightFadeSec = 0.5; // ไม่ใช้แล้ว แต่เก็บไว้เผื่อ config เดิม

    this._rect = { x: 0, y: 0, w: 100, h: 100 };
    this._texByUrl = new Map();

    this._currentSlotKey = null;
    this._currentLight = "off";

    this._isFading = false;
    this._fadeT = 0;
    this._fadeDur = 1;
    this._from = this.spriteA;
    this._to = this.spriteB;
  }

  async load(roomConfig){
    this._basePath = roomConfig.basePath ?? this._basePath;
    this._filePattern = roomConfig.filePattern ?? this._filePattern;

    this._fadeSec = Math.max(0.01, Number(roomConfig.fadeSec ?? this._fadeSec) || this._fadeSec);
    this._lightFadeSec = Math.max(0.01, Number(roomConfig.lightFadeSec ?? this._lightFadeSec) || this._lightFadeSec);

    this._slots = (roomConfig.slots || [])
      .map(s => ({
        key: s.key,
        start: s.start,
        startMin: RoomManager._parseTimeToMinute(s.start)
      }))
      .filter(s => s.key && s.startMin !== null)
      .sort((a,b)=>a.startMin-b.startMin);

    const urls = new Set();
    for(const s of this._slots){
      urls.add(this._buildUrl(s.key, "off"));
      urls.add(this._buildUrl(s.key, "on"));
    }

    await Promise.all([...urls].map(async (u)=>{
      const tex = await PIXI.Assets.load(u);
      this._texByUrl.set(u, tex);
    }));
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;
    this._cover(this.spriteA);
    this._cover(this.spriteB);
  }

  update(now, dtSec, storyState){
    if(!this._slots.length) return;

    const slotKey = this._getSlotKey(now);
    const light = (storyState?.roomLight ?? storyState?.state?.roomLight ?? "off") === "on" ? "on" : "off";

    if(this._currentSlotKey === null){
      this._currentSlotKey = slotKey;
      this._currentLight = light;

      this._setSprite(this.spriteA, slotKey, light);
      this.spriteA.alpha = 1;
      this.spriteB.alpha = 0;
      this._active = "A";
      this._isFading = false;
      return;
    }

    if(this._isFading){
      this._fadeT += dtSec;
      const t = Math.min(1, this._fadeT / this._fadeDur);
      this._from.alpha = 1 - t;
      this._to.alpha = t;

      if(t >= 1){
        this._from.alpha = 0;
        this._to.alpha = 1;
        this._active = (this._active === "A") ? "B" : "A";
        this._isFading = false;
      }
      return;
    }

    const slotChanged = (slotKey !== this._currentSlotKey);
    const lightChanged = (light !== this._currentLight);

    if(!slotChanged && !lightChanged) return;

    // ✅ ถ้าเปลี่ยนช่วงเวลา → crossfade เหมือนเดิม
    if(slotChanged){
      this._startFade(slotKey, light, this._fadeSec);
      this._currentSlotKey = slotKey;
      this._currentLight = light;
      return;
    }

    // ✅ ถ้าเปลี่ยนแค่ไฟ → instant switch (ไม่มี fade)
    if(lightChanged){
      const activeSpr = (this._active === "A") ? this.spriteA : this.spriteB;

      this._setSprite(activeSpr, slotKey, light);
      activeSpr.alpha = 1;

      this._currentLight = light;
      return;
    }
  }

  _startFade(slotKey, light, fadeDur){
    const fromSpr = (this._active === "A") ? this.spriteA : this.spriteB;
    const toSpr   = (this._active === "A") ? this.spriteB : this.spriteA;

    this._setSprite(toSpr, slotKey, light);

    this._from = fromSpr;
    this._to = toSpr;
    this._fadeT = 0;
    this._fadeDur = Math.max(0.01, fadeDur || this._fadeSec);

    fromSpr.alpha = 1;
    toSpr.alpha = 0;
    this._isFading = true;
  }

  _setSprite(sprite, slotKey, light){
    const url = this._buildUrl(slotKey, light);
    const tex = this._texByUrl.get(url);
    if(tex){
      sprite.texture = tex;
      sprite.visible = true;
      this._cover(sprite);
    }else{
      sprite.visible = false;
    }
  }

  _buildUrl(slotKey, light){
    const name = this._filePattern
      .replace("{key}", slotKey)
      .replace("{light}", light);
    return `${this._basePath}${name}`;
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

  _getSlotKey(now){
    const tMin = now.getHours() * 60 + now.getMinutes();
    let pick = this._slots[0];
    for(const s of this._slots){
      if(tMin >= s.startMin) pick = s;
      else break;
    }
    return pick.key;
  }

  static _parseTimeToMinute(str){
    const parts = String(str || "").split(":");
    if(parts.length < 1) return null;
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1] ?? "0", 10);
    if(Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  }
}
