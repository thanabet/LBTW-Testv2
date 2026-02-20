class CloudLayer {
  constructor(container){
    this.container = container;

    // 2 groups: current + next (crossfade by group alpha)
    this.group0 = new PIXI.Container();
    this.group1 = new PIXI.Container();
    this.container.addChild(this.group0, this.group1);

    this.group0.alpha = 0;
    this.group1.alpha = 0;

    this.rect = { x:0, y:0, w:100, h:100 };
    this.bandRect = { x:0, y:0, w:100, h:100 };

    this._texByUrl = null;

    this._enabled = false;
    this._speed = 0;
    this._scale = 1;
    this._baseAlpha = 1;

    // ✅ new: overlap in px between tiles
    this._overlapPx = 0;

    // vertical placement controls
    this._bandRectPct = null;
    this._yAlign = "center";
    this._yOffsetPct = 0;

    // keyframes
    this._kfs = [];

    // active urls
    this._curUrl = null;
    this._nextUrl = null;

    // scrolling offset (in px)
    this._x = 0;

    // dynamic tiling sprites
    this.tiles0 = [];
    this.tiles1 = [];

    // cached tile step (width minus overlap) for each group
    this._step0 = 0;
    this._step1 = 0;
  }

  bindTextureMap(texByUrl){
    this._texByUrl = texByUrl;
  }

  setProfileLayer(cfg){
    if(!cfg){
      this._enabled = false;
      this.group0.alpha = 0;
      this.group1.alpha = 0;

      this._kfs = [];
      this._bandRectPct = null;
      this._yAlign = "center";
      this._yOffsetPct = 0;

      this._curUrl = null;
      this._nextUrl = null;

      this._overlapPx = 0;

      this._setTileCount(this.group0, this.tiles0, 0);
      this._setTileCount(this.group1, this.tiles1, 0);
      this._step0 = 0;
      this._step1 = 0;

      return;
    }

    this._enabled = true;
    this._speed = cfg.speedPxPerSec ?? 0;
    this._scale = cfg.scale ?? 1;
    this._baseAlpha = cfg.baseAlpha ?? 1;

    // ✅ overlap per layer (default 0)
    this._overlapPx = Math.max(0, Number(cfg.overlapPx ?? 0) || 0);

    this._bandRectPct = cfg.bandRectPct || null;
    this._yAlign = cfg.yAlign || "center";
    this._yOffsetPct = cfg.yOffsetPct ?? 0;

    this._kfs = (cfg.keyframes || [])
      .map(k => ({ minute: CloudManager._parseTimeToMinute(k.time), url: k.src }))
      .filter(k => typeof k.minute === "number" && !!k.url && this._texByUrl?.has(k.url))
      .sort((a,b)=>a.minute-b.minute);

    this._applyBandRect();
    this._applyBlend(new Date(), true);
    this._resetScroll();
  }

  resizeToRect(sceneRectPx){
    this.rect = sceneRectPx;
    this._applyBandRect();

    // Re-apply textures so we can recompute steps & counts
    if(this._curUrl) this._applyTextureToGroup(this.group0, this.tiles0, this._curUrl, true);
    if(this._nextUrl) this._applyTextureToGroup(this.group1, this.tiles1, this._nextUrl, true);

    this._resetScroll();
  }

  update(now, dtSec){
    if(!this._enabled || !this._kfs.length) return;

    // blend by time (group alpha)
    this._applyBlend(now, false);

    // move left
    this._x -= this._speed * dtSec;

    // wrap based on max step (safe)
    const step = Math.max(this._step0, this._step1);
    if(step > 0){
      while(this._x <= -step) this._x += step;

      this._positionTiles(this.tiles0, this._x);
      this._positionTiles(this.tiles1, this._x);
    }
  }

  /* ------------------ internal ------------------ */

  _applyBandRect(){
    const r = this.rect;
    if(!this._bandRectPct){
      this.bandRect = { x:r.x, y:r.y, w:r.w, h:r.h };
      return;
    }

    const p = this._bandRectPct;
    const x = r.x + (p.x/100) * r.w;
    const y = r.y + (p.y/100) * r.h;
    const w = (p.w/100) * r.w;
    const h = (p.h/100) * r.h;

    const yOffset = (this._yOffsetPct/100) * r.h;
    this.bandRect = { x, y: y + yOffset, w, h };
  }

  _smoothstep(t){
    return t*t*(3-2*t);
  }

  _applyBlend(now, force){
    const kfs = this._kfs;
    if(!kfs.length) return;

    const m = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;

    let i1 = kfs.findIndex(k => k.minute > m);
    if(i1 === -1) i1 = 0;
    const i0 = (i1 - 1 + kfs.length) % kfs.length;

    const k0 = kfs[i0];
    const k1 = kfs[i1];

    const m0 = k0.minute;
    const m1 = (k1.minute > m0) ? k1.minute : (k1.minute + 1440);
    const mm = (m >= m0) ? m : (m + 1440);

    const t = (mm - m0) / (m1 - m0);
    const s = this._smoothstep(Math.max(0, Math.min(1, t)));

    if(force || this._curUrl !== k0.url){
      this._curUrl = k0.url;
      this._applyTextureToGroup(this.group0, this.tiles0, this._curUrl, true);
      this._resetScroll();
    }
    if(force || this._nextUrl !== k1.url){
      this._nextUrl = k1.url;
      this._applyTextureToGroup(this.group1, this.tiles1, this._nextUrl, true);
      this._resetScroll();
    }

    this.group0.alpha = (1 - s) * this._baseAlpha;
    this.group1.alpha = s * this._baseAlpha;
  }

  _computeY(sprite){
    const r = this.bandRect;
    if(this._yAlign === "top") return r.y;
    if(this._yAlign === "bottom") return r.y + (r.h - sprite.height);
    return r.y + (r.h - sprite.height) / 2;
  }

  _coverSprite(sprite){
    if(!sprite.texture?.width) return;

    const tw = sprite.texture.width;
    const th = sprite.texture.height;
    const r = this.bandRect;

    const s = Math.max(r.w / tw, r.h / th) * this._scale;
    sprite.scale.set(s);
  }

  _desiredTileCount(step){
    // Need enough tiles to cover band width + 2 extra for smooth wrap
    const r = this.bandRect;
    if(step <= 0) return 0;
    return Math.max(2, Math.ceil(r.w / step) + 2);
  }

  _setTileCount(group, tiles, count){
    while(tiles.length > count){
      const spr = tiles.pop();
      group.removeChild(spr);
      spr.destroy();
    }
    while(tiles.length < count){
      const spr = new PIXI.Sprite();
      tiles.push(spr);
      group.addChild(spr);
    }
  }

  _applyTextureToGroup(group, tiles, url, recomputeTiling){
    const tex = this._texByUrl.get(url);
    if(!tex) return;

    // ensure at least 2 tiles to measure
    if(tiles.length < 2) this._setTileCount(group, tiles, 2);

    // apply texture + cover scale to sample
    tiles[0].texture = tex;
    this._coverSprite(tiles[0]);

    const tileW = tiles[0].width || 0;
    if(tileW <= 0) return;

    // ✅ step = width - overlapPx (never <= 1)
    const overlap = Math.min(this._overlapPx, Math.max(0, tileW - 2));
    const step = Math.max(2, tileW - overlap);

    // update cached step
    if(group === this.group0) this._step0 = step;
    else this._step1 = step;

    // compute needed tile count
    const need = recomputeTiling ? this._desiredTileCount(step) : tiles.length;
    this._setTileCount(group, tiles, need);

    // apply texture + scale to all tiles
    for(const spr of tiles){
      spr.texture = tex;
      this._coverSprite(spr);
    }

    // position now
    this._positionTiles(tiles, this._x);
  }

  _positionTiles(tiles, xOffset){
    if(!tiles.length) return;

    const r = this.bandRect;
    const y = this._computeY(tiles[0]);

    // choose correct step
    const step = (tiles === this.tiles0) ? this._step0 : this._step1;
    if(step <= 0) return;

    for(let i=0; i<tiles.length; i++){
      tiles[i].x = r.x + xOffset + (i * step);
      tiles[i].y = y;
    }
  }

  _resetScroll(){
    this._x = 0;
    this._positionTiles(this.tiles0, 0);
    this._positionTiles(this.tiles1, 0);
  }
}

export class CloudManager {
  constructor(container){
    this.container = container;

    this._profiles = {};
    this._profileName = "none";
    this._enabled = false;

    this._texByUrl = new Map();

    this.layerFar = new CloudLayer(this.container);
    this.layerNear = new CloudLayer(this.container);

    this.layerFar.bindTextureMap(this._texByUrl);
    this.layerNear.bindTextureMap(this._texByUrl);

    this.rect = { x:0, y:0, w:100, h:100 };
  }

  async loadConfig(cloudConfig){
    this._profiles = cloudConfig.profiles || {};
    this._profileName = cloudConfig.defaultProfile || "none";

    const allUrls = new Set();
    for(const p of Object.values(this._profiles)){
      const layers = p?.layers || [];
      for(const layer of layers){
        for(const k of (layer.keyframes || [])){
          if(k?.src) allUrls.add(k.src);
        }
      }
    }

    const urls = [...allUrls];
    await Promise.all(urls.map(async (u)=>{
      const tex = await PIXI.Assets.load(u);
      this._texByUrl.set(u, tex);
    }));

    this.setProfile(this._profileName);
  }

  setProfile(name){
    const p = this._profiles?.[name] || this._profiles?.["none"] || { enabled:false };
    this._profileName = name;
    this._enabled = !!p.enabled;

    if(!this._enabled){
      this.layerFar.setProfileLayer(null);
      this.layerNear.setProfileLayer(null);
      return;
    }

    const layers = p.layers || [];
    this.layerFar.setProfileLayer(layers[0] || null);
    this.layerNear.setProfileLayer(layers[1] || null);

    this.layerFar.resizeToRect(this.rect);
    this.layerNear.resizeToRect(this.rect);
  }

  resizeToRect(sceneRectPx){
    this.rect = sceneRectPx;
    this.layerFar.resizeToRect(sceneRectPx);
    this.layerNear.resizeToRect(sceneRectPx);
  }

  update(now, dtSec){
    if(!this._enabled) return;
    this.layerFar.update(now, dtSec);
    this.layerNear.update(now, dtSec);
  }

  static _parseTimeToMinute(str){
    const [hh, mm] = String(str).split(":").map(n => parseInt(n, 10));
    if(Number.isNaN(hh)) return null;
    return hh * 60 + (Number.isNaN(mm) ? 0 : mm);
  }
}



