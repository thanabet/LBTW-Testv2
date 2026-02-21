// src/scene/roomManager.js
// Continuous keyframe blend like Sky:
// - Uses room_config.json "slots" as keyframes
// - Always blends between current slot and next slot based on time within interval
// - Supports roomLight on/off with 0.5s crossfade (requires 2 layers × 2 sprites = 4 sprites total)

export class RoomManager {
  constructor(container){
    this.container = container;

    // Two layers for light crossfade:
    // layer0 = current light
    // layer1 = previous light during fade
    this.layer0 = new PIXI.Container();
    this.layer1 = new PIXI.Container();
    this.container.addChild(this.layer1); // behind
    this.container.addChild(this.layer0); // in front

    // Each layer uses 2 sprites for time keyframe blend
    this.l0A = new PIXI.Sprite();
    this.l0B = new PIXI.Sprite();
    this.layer0.addChild(this.l0A, this.l0B);

    this.l1A = new PIXI.Sprite();
    this.l1B = new PIXI.Sprite();
    this.layer1.addChild(this.l1A, this.l1B);

    // default alphas
    this.layer0.alpha = 1;
    this.layer1.alpha = 0;

    this._slots = []; // [{key,startMin}]
    this._basePath = "assets/scene/room/";
    this._filePattern = "{key}_{light}.png";

    // used only for light toggle fade
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

    // cover all sprites
    this._cover(this.l0A);
    this._cover(this.l0B);
    this._cover(this.l1A);
    this._cover(this.l1B);
  }

  update(now, dtSec, storyState){
    if(!this._slots.length) return;

    const desiredLight =
      (storyState?.roomLight ?? storyState?.state?.roomLight ?? "off") === "on"
        ? "on"
        : "off";

    // Handle light toggle fade (0.5s) without breaking continuous time blend
    if(desiredLight !== this._currentLight){
      this._prevLight = this._currentLight;
      this._currentLight = desiredLight;

      this._lightFading = true;
      this._lightFadeT = 0;
      this._lightFadeDur = this._lightFadeSec;

      // At the start of fade:
      // layer1 shows previous light, layer0 shows current light
      this.layer1.alpha = 1;
      this.layer0.alpha = 0;
    }

    // Always compute continuous time blend for both layers
    const { keyA, keyB, t } = this._computeBlend(now);

    // Update layer0 textures (current light)
    this._setSprite(this.l0A, keyA, this._currentLight);
    this._setSprite(this.l0B, keyB, this._currentLight);
    this.l0A.alpha = 1 - t;
    this.l0B.alpha = t;

    // Update layer1 textures (prev light) only if fading
    if(this._lightFading){
      this._setSprite(this.l1A, keyA, this._prevLight);
      this._setSprite(this.l1B, keyB, this._prevLight);
      this.l1A.alpha = 1 - t;
      this.l1B.alpha = t;

      this._lightFadeT += dtSec;
      const u = Math.min(1, this._lightFadeT / Math.max(0.01, this._lightFadeDur));

      // crossfade between lights
      this.layer0.alpha = u;
      this.layer1.alpha = 1 - u;

      if(u >= 1){
        this._lightFading = false;
        this.layer0.alpha = 1;
        this.layer1.alpha = 0;
      }
    } else {
      // not fading: keep only layer0 visible
      this.layer0.alpha = 1;
      this.layer1.alpha = 0;
    }
  }

  // --- continuous blend between current slot and next slot ---
  _computeBlend(now){
    const tMin = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() / 60);

    // pick current slot = last slot whose startMin <= tMin
    let idxA = 0;
    for(let i=0;i<this._slots.length;i++){
      if(tMin >= this._slots[i].startMin) idxA = i;
      else break;
    }

    const idxB = (idxA + 1) % this._slots.length;

    const a = this._slots[idxA];
    const b = this._slots[idxB];

    // interval length (wrap midnight)
    let startA = a.startMin;
    let startB = b.startMin;

    let span;
    if(idxB > idxA){
      span = startB - startA;
    } else {
      // wrap: e.g. 22:00 -> 05:30
      span = (1440 - startA) + startB;
    }
    span = Math.max(1, span);

    // elapsed since startA (wrap if needed)
    let elapsed = tMin - startA;
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