// src/scene/roomFxManager.js

class SpriteClip {
  constructor({ name, frames, durationsMs, loop = true }){
    this.name = name;
    this.frames = frames;              // array of texture URLs
    this.durationsMs = durationsMs;    // array of ms per frame
    this.loop = loop;
  }
}

class SpriteAnimator {
  constructor(sprite){
    this.sprite = sprite;

    this.clip = null;
    this._frameIndex = 0;
    this._accMs = 0;
    this._playing = false;

    this._textures = []; // PIXI.Textures for current clip
  }

  setTextures(textures){
    this._textures = textures || [];
    this._frameIndex = 0;
    this._accMs = 0;
    if(this._textures[0]){
      this.sprite.texture = this._textures[0];
    }
  }

  play(){
    this._playing = true;
  }

  stop(){
    this._playing = false;
    this._frameIndex = 0;
    this._accMs = 0;
    if(this._textures[0]){
      this.sprite.texture = this._textures[0];
    }
  }

  isPlaying(){
    return this._playing;
  }

  update(dtSec){
    if(!this._playing || !this.clip) return;
    if(!this._textures.length) return;

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

    // 5 layers
    this.layers = {};
    this._layerOrder = ["fx1","fx2","fx3","fx4","fx5"];

    // config
    this._basePath = "assets/scene/roomfx/";
    this._clipsByName = new Map();      // clipName -> SpriteClip
    this._texturesByUrl = new Map();    // url -> texture

    // per layer runtime
    // { container, sprite, animator, currentClipName, visible }
  }

  async load(cfg){
    this._basePath = cfg.basePath ?? this._basePath;

    const layerNames = cfg.layers && Array.isArray(cfg.layers) && cfg.layers.length
      ? cfg.layers
      : this._layerOrder.map(name => ({ name }));

    // build layer containers/sprites
    this.container.removeChildren();
    this.layers = {};

    for(const ln of layerNames){
      const name = ln.name;
      if(!name) continue;

      const layerC = new PIXI.Container();
      this.container.addChild(layerC);

      const spr = new PIXI.Sprite();
      layerC.addChild(spr);

      // default hidden until story says otherwise
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

    // load clips
    // cfg.clips = { clipName: { frames:[...], durationsMs:[...], loop:true } }
    const clips = cfg.clips || {};

    const urlsToLoad = new Set();

    for(const [clipName, def] of Object.entries(clips)){
      const frames = (def.frames || []).map(f => this._resolveUrl(f));
      const durationsMs = def.durationsMs || [];
      const loop = (def.loop !== undefined) ? !!def.loop : true;

      const clip = new SpriteClip({
        name: clipName,
        frames,
        durationsMs,
        loop
      });

      this._clipsByName.set(clipName, clip);

      frames.forEach(u => urlsToLoad.add(u));
    }

    // preload textures
    await Promise.all([...urlsToLoad].map(async (u)=>{
      const tex = await PIXI.Assets.load(u);
      this._texturesByUrl.set(u, tex);
    }));
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;

    for(const layer of Object.values(this.layers)){
      this._cover(layer.sprite);
    }
  }

  // storyState.roomFx or storyState.state.roomFx
  // supported shapes:
  // 1) { fx1:{clip:"bird_perch", play:true}, fx2:null, ... }
  // 2) { fx1:"bird_perch", fx2:"laundry_loop" }  (string shorthand = play true)
  // 3) ["bird_perch","laundry_loop"]  (auto fill fx1..fxN)
  applyStoryState(storyState, { immediate = false } = {}){
    const roomFx =
      storyState?.roomFx ??
      storyState?.state?.roomFx ??
      null;

    // normalize into map layerName -> {clip, play}
    const desired = {};

    if(Array.isArray(roomFx)){
      // array shorthand
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
        // object form
        const clip = v.clip ? String(v.clip) : null;
        const play = (v.play !== undefined) ? !!v.play : true;
        desired[layerName] = clip ? { clip, play } : null;
      }
    } else {
      // no roomFx in state => all off
    }

    for(const [layerName, layer] of Object.entries(this.layers)){
      const want = desired[layerName];

      if(!want){
        // hide layer
        layer.container.visible = false;
        layer.requestedClipName = null;
        layer.requestedPlay = false;

        if(immediate){
          layer.animator.stop();
          layer.currentClipName = null;
        }
        continue;
      }

      // show layer
      layer.container.visible = true;
      layer.requestedClipName = want.clip;
      layer.requestedPlay = want.play;

      if(immediate){
        this._applyLayerRequestNow(layer);
      }
    }

    if(!immediate){
      // defer actual clip swap to update() so it's stable per frame
      // (we still keep visibility updated immediately)
    }
  }

  update(dtSec){
    for(const layer of Object.values(this.layers)){
      if(!layer.container.visible){
        continue;
      }

      // apply pending request if needed
      if(layer.requestedClipName && layer.requestedClipName !== layer.currentClipName){
        this._applyLayerRequestNow(layer);
      } else if(layer.requestedClipName && layer.requestedClipName === layer.currentClipName){
        // just ensure play/stop matches
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

    if(!clip){
      // unknown clip => hide to avoid weird empty sprite
      layer.container.visible = false;
      layer.currentClipName = null;
      layer.requestedClipName = null;
      layer.requestedPlay = false;
      layer.animator.stop();
      return;
    }

    const textures = clip.frames.map(u => this._texturesByUrl.get(u)).filter(Boolean);
    layer.animator.clip = clip;
    layer.animator.setTextures(textures);
    layer.currentClipName = clipName;

    // ensure cover after new texture
    this._cover(layer.sprite);

    if(layer.requestedPlay){
      layer.animator.play();
    } else {
      layer.animator.stop();
    }
  }

  _resolveUrl(frame){
    // if already absolute or contains "/" treat as direct url
    const f = String(frame);
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