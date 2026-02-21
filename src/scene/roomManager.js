// src/scene/roomManager.js
// Continuous keyframe blend like Sky BUT without see-through:
// - Base image alpha stays 1
// - Overlay image alpha = t
// Supports roomLight on/off with 0.5s light crossfade (two layers)

export class RoomManager {
  constructor(container){
    this.container = container;

    // Two layers for light crossfade:
    // layer0 = current light
    // layer1 = previous light during fade
    this.layer0 = new PIXI.Container();
    this.layer1 = new PIXI.Container();
    this.container.addChild(this.layer1); // behind
    this.container.addChild(this.layer0); // front

    // Each layer uses 2 sprites:
    // base = current slot (alpha 1)
    // over = next slot (alpha t)
    this.l0Base = new PIXI.Sprite();
    this.l0Over = new PIXI.Sprite();
    this.layer0.addChild(this.l0Base, this.l0Over);

    this.l1Base = new PIXI.Sprite();
    this.l1Over = new PIXI.Sprite();
    this.layer1.addChild(this.l1Base, this.l1Over);

    this.layer0.alpha = 1;
    this.layer1.alpha = 0;

    this._slots = []; // [{key,startMin}]
    this._basePath = "assets/scene/room/";
    this._filePattern = "{key}_{light}.png";

    // light toggle fade only
    this._lightFadeSec = 0.5;

    this._rect = { x:0, y:0, w:100, h:100 };
    this._texByUrl = new Map();

    // light state
    this._currentLight = "off";
    this._prevLight = "off";
    this._lightFading = false;
    this._lightFadeT = 0;
    this._lightFadeDur = 0.5;
  }

  async load(roomConfig){
    this._basePath = roomConfig.basePath ?? this._basePath;
    this._filePattern = roomConfig.filePattern ?? this._filePattern;

    this._lightFadeSec = Math.max(
      0.01,
      Number(roomConfig.lightFadeSec ?? this._lightFadeSec) || this._lightFadeSec
    );

    this._slots = (roomConfig.slots || [])
      .map(s => ({
        key: s.key,
        startMin: RoomManager._parseTimeToMinute(s.start)
      }))
      .filter(s => s.key && s.startMin !== null)
      .sort((a,b)=>a.startMin-b.startMin);

    // preload all required textures (slots × {off,on})
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
    this._cover(this.l0Base);
    this._cover(this.l0Over);
    this._cover(this.l1Base);
    this._cover(this.l1Over);
  }

  update(now, dtSec, storyState){
    if(!this._slots.length) return;

    const desiredLight =
      (storyState?.roomLight ?? storyState?.state?.roomLight ?? "off") === "on"
        ? "on"
        : "off";

    // Start light fade if needed
    if(desiredLight !== this._currentLight){
      this._prevLight = this._currentLight;
      this._currentLight = desiredLight;

      this._lightFading = true;
      this._lightFadeT = 0;
      this._lightFadeDur = this._lightFadeSec;

      // layer1 shows previous light, layer0 shows current light
      this.layer1.alpha = 1;
      this.layer0.alpha = 0;
    }

    // Continuous time blend (keyA = current slot, keyB = next slot, t=0..1)
    const { keyA, keyB, t } = this._computeBlend(now);

    // ---- Layer0 (current light): base alpha 1, overlay alpha t
    this._setSprite(this.l0Base, keyA, this._currentLight);
    this._setSprite(this.l0Over, keyB, this._currentLight);
    this.l0Base.alpha = 1;
    this.l0Over.alpha = t;

    // ---- Layer1 (prev light) only if fading
    if(this._lightFading){
      this._setSprite(this.l1Base, keyA, this._prevLight);
      this._setSprite(this.l1Over, keyB, this._prevLight);
      this.l1Base.alpha = 1;
      this.l1Over.alpha = t;

      // crossfade between lights
      this._lightFadeT += dtSec;
      const u = Math.min(1, this._lightFadeT / Math.max(0.01, this._lightFadeDur));

      this.layer0.alpha = u;
      this.layer1.alpha = 1 - u;

      if(u >= 1){
        this._lightFading = false;
        this.layer0.alpha = 1;
        this.layer1.alpha = 0;
      }
    } else {
      this.layer0.alpha = 1;
      this.layer1.alpha = 0;
    }
  }

  _computeBlend(now){
    const tMin = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() / 60);

    // current slot = last slot start <= now
    let idxA = 0;
    for(let i=0;i<this._slots.length;i++){
      if(tMin >= this._slots[i].startMin) idxA = i;
      else break;
    }
    const idxB = (idxA + 1) % this._slots.length;

    const a = this._slots[idxA];
    const b = this._slots[idxB];

    // span (wrap midnight)
    let span;
    if(idxB > idxA){
      span = b.startMin - a.startMin;
    } else {
      span = (1440 - a.startMin) + b.startMin;
    }
    span = Math.max(1, span);

    // elapsed since a.start (wrap)
    let elapsed = tMin - a.startMin;
    if(elapsed < 0) elapsed += 1440;

    const t = Math.max(0, Math.min(1, elapsed / span));
    return { keyA: a.key, keyB: b.key, t };
  }

  _setSprite(sprite, slotKey, light){
    const url = this._buildUrl(slotKey, light);
    const tex = this._texByUrl.get(url);
    if(tex){
      if(sprite.texture !== tex) sprite.texture = tex;
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

  static _parseTimeToMinute(str){
    const parts = String(str || "").split(":");
    if(parts.length < 1) return null;
    const hh = parseInt(parts[0], 10);
    const mm = parseFloat(parts[1] ?? "0");
    if(Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  }
}