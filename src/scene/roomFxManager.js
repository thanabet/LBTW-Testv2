// src/scene/roomFxManager.js
// SAFE MODE: Missing PNGs will NOT crash boot.
// - Preload textures with Promise.allSettled
// - Any missing frames => clip becomes "unavailable" => layer hides silently

class SpriteClip {
  constructor({ name, frames, durationsMs, loop = true }){
    this.name = name;
    this.frames = frames;              // array of texture URLs
    this.durationsMs = durationsMs;    // array of ms per frame
    this.loop = loop;

    // runtime: resolved textures for available frames only
    this._textures = [];
  }
}

class SpriteAnimator {
  constructor(sprite){
    this.sprite = sprite;

    this.clip = null;
    this._frameIndex = 0;
    this._accMs = 0;
    this._playing = false;
  }

  setTextures(textures){
    const arr = Array.isArray(textures) ? textures.filter(Boolean) : [];
    this._frameIndex = 0;
    this._accMs = 0;

    // If no textures, keep sprite invisible
    if(arr.length === 0){
      this.sprite.visible = false;
      this.sprite.texture = PIXI.Texture.EMPTY;
      this._playing = false;
      return;
    }

    this.sprite.visible = true;
    this.sprite.texture = arr[0];
    this._textures = arr;
  }

  play(){
    if(!this._textures || this._textures.length === 0) return;
    this._playing = true;
  }

  stop(){
    this._playing = false;
    this._frameIndex = 0;
    this._accMs = 0;

    if(this._textures && this._textures[0]){
      this.sprite.texture = this._textures[0];
    }
  }

  isPlaying(){
    return this._playing;
  }

  update(dtSec){
    if(!this._playing || !this.clip) return;
    if(!this._textures || this._textures.length === 0) return;

    this._accMs += dtSec * 1000;

    const durations = this.clip.durationsMs;
    const safeDur = (i) => Math.max(1, Number(durations?.[i] ?? 100) || 100);

    while(this._accMs >= safeDur(this._frameIndex)){
      this._accMs -= safeDur(this._frameIndex);
      this._frameIndex += 1;

      if(this._frameIndex >= this._textures.length){
        if(this.clip.loop){
          this._frameIndex = 0;
        } else {
          // play once end
          this._frameIndex = this._textures.length - 1;
          this._playing = false;
          break;
        }
      }

      this.sprite.texture = this._textures[this._frameIndex];
    }
  }
}

export class RoomFxManager {
  constructor(container){
    this.container = container;

    this._rect = { x:0, y:0, w:100, h:100 };

    this.layers = {};
    this._layerOrder = ["fx1","fx2","fx3","fx4","fx5"];

    this._basePath = "assets/scene/roomfx/";
    this._clipsByName = new Map();      // clipName -> SpriteClip
    this._texturesByUrl = new Map();    // url -> texture (only if loaded OK)
  }

  async load(cfg){
    // SAFE: cfg may be missing or invalid — do not throw
    cfg = cfg && typeof cfg === "object" ? cfg : {};

    this._basePath = cfg.basePath ?? this._basePath;

    const layerDefs = (Array.isArray(cfg.layers) && cfg.layers.length)
      ? cfg.layers
      : this._layerOrder.map(name => ({ name }));

    // rebuild layer containers/sprites
    this.container.removeChildren();
    this.layers = {};

    for(const ld of layerDefs){
      const name = ld?.name;
      if(!name) continue;

      const layerC = new PIXI.Container();
      this.container.addChild(layerC);

      const spr = new PIXI.Sprite();
      spr.visible = false;
      layerC.addChild(spr);

      layerC.visible = false;

      const animator = new SpriteAnimator(spr);

      this.layers[name] = {
        name,
        container: layerC,
        sprite: spr,
        animator,
        currentClipName: null,
        requestedClipName: null,
        requestedPlay: false
      };
    }

    // build clips
    this._clipsByName.clear();
    this._texturesByUrl.clear();

    const clips = (cfg.clips && typeof cfg.clips === "object") ? cfg.clips : {};

    const urlsToLoad = new Set();

    for(const [clipName, def] of Object.entries(clips)){
      const frames = Array.isArray(def?.frames) ? def.frames.map(f => this._resolveUrl(f)) : [];
      const durationsMs = Array.isArray(def?.durationsMs) ? def.durationsMs : [];
      const loop = (def?.loop !== undefined) ? !!def.loop : true;

      const clip = new SpriteClip({ name: clipName, frames, durationsMs, loop });
      this._clipsByName.set(clipName, clip);

      frames.forEach(u => urlsToLoad.add(u));
    }

    // SAFE preload: do not reject if any URL missing
    const tasks = [...urlsToLoad].map(async (u)=>{
      try{
        const tex = await PIXI.Assets.load(u);
        if(tex){
          this._texturesByUrl.set(u, tex);
        }
      }catch(e){
        // swallow: missing file should not crash
        // console.warn("[RoomFx] Failed to load", u, e);
      }
    });

    // Use allSettled to guarantee completion
    await Promise.allSettled(tasks);

    // Resolve clip textures list now (only keep successfully loaded frames)
    for(const clip of this._clipsByName.values()){
      clip._textures = clip.frames
        .map(u => this._texturesByUrl.get(u))
        .filter(Boolean);
    }
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;

    for(const layer of Object.values(this.layers)){
      this._cover(layer.sprite);
    }
  }

  applyStoryState(storyState, { immediate = false } = {}){
    const roomFx =
      storyState?.roomFx ??
      storyState?.state?.roomFx ??
      null;

    const desired = {};

    if(Array.isArray(roomFx)){
      for(let i=0;i<this._layerOrder.length;i++){
        const layerName = this._layerOrder[i];
        const clipName = roomFx[i];
        if(clipName){
          desired[layerName] = { clip: String(clipName), play: true };
        }
      }
    } else if(roomFx && typeof roomFx === "object"){
      for(const [layerName, v] of Object.entries(roomFx)){
        if(v == null){
          desired[layerName] = null;
          continue;
        }
        if(typeof v === "string"){
          desired[layerName] = { clip: v, play: true };
          continue;
        }
        const clip = v.clip ? String(v.clip) : null;
        const play = (v.play !== undefined) ? !!v.play : true;
        desired[layerName] = clip ? { clip, play } : null;
      }
    }

    for(const [layerName, layer] of Object.entries(this.layers)){
      const want = desired[layerName];

      if(!want){
        layer.container.visible = false;
        layer.requestedClipName = null;
        layer.requestedPlay = false;

        if(immediate){
          layer.animator.stop();
          layer.currentClipName = null;
        }
        continue;
      }

      layer.container.visible = true;
      layer.requestedClipName = want.clip;
      layer.requestedPlay = want.play;

      if(immediate){
        this._applyLayerRequestNow(layer);
      }
    }
  }

  update(dtSec){
    for(const layer of Object.values(this.layers)){
      if(!layer.container.visible) continue;

      // apply pending request
      if(layer.requestedClipName && layer.requestedClipName !== layer.currentClipName){
        this._applyLayerRequestNow(layer);
      } else if(layer.requestedClipName && layer.requestedClipName === layer.currentClipName){
        // ensure play state matches
        if(layer.requestedPlay && !layer.animator.isPlaying()){
          layer.animator.play();
        }
        if(!layer.requestedPlay && layer.animator.isPlaying()){
          layer.animator.stop();
        }
      }

      layer.animator.update(dtSec);
    }
  }

  _applyLayerRequestNow(layer){
    const clipName = layer.requestedClipName;
    const clip = this._clipsByName.get(clipName);

    // Unknown clip or no textures loaded => hide silently
    if(!clip || !clip._textures || clip._textures.length === 0){
      layer.container.visible = false;
      layer.currentClipName = null;
      layer.requestedClipName = null;
      layer.requestedPlay = false;
      layer.animator.stop();
      layer.sprite.visible = false;
      return;
    }

    layer.animator.clip = clip;
    layer.animator.setTextures(clip._textures);
    layer.currentClipName = clipName;

    this._cover(layer.sprite);

    if(layer.requestedPlay){
      layer.animator.play();
    } else {
      layer.animator.stop();
    }

    // Ensure visible if textures exist
    layer.container.visible = true;
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