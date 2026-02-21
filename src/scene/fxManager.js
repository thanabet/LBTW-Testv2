// src/scene/fxManager.js
// 5 FX layers, each layer plays 1 clip at a time.
// Clip = frames[] + durationsMs[] (per-frame speed) + loop (true/false)
// Story control:
//   storyState.fxLayers = { fx1:{clip,visible}, fx2:{...} ... }
// Notes:
// - If clip changes -> restart from frame 0
// - If loop:false -> play once and hold on last frame (still visible unless you set visible=false)

export class FxManager {
  constructor(container, layerIds = ["fx1","fx2","fx3","fx4","fx5"]){
    this.container = container;

    this._rect = { x:0, y:0, w:100, h:100 };

    this._layerIds = layerIds;
    this._layers = new Map(); // id -> { container, sprite, visible, clipId, ... }
    this._clips = new Map();  // clipId -> { frames, durationsMs, loop }

    for(const id of this._layerIds){
      const c = new PIXI.Container();
      c.visible = false;
      this.container.addChild(c);

      const s = new PIXI.Sprite();
      c.addChild(s);

      this._layers.set(id, {
        id,
        container: c,
        sprite: s,
        visible: false,
        clipId: null,
        playing: false,
        frameIdx: 0,
        frameT: 0 // seconds
      });
    }
  }

  async loadConfig(cfg){
    // cfg:
    // {
    //   basePath:"assets/scene/fx/",
    //   layers:["fx1"...],
    //   clips:{ clipId:{ frames:["laundry/01.png"...] OR ["01.png"...], durationsMs:[..], loop:true } }
    // }

    this._basePath = cfg.basePath ?? "assets/scene/fx/";
    const layers = cfg.layers ?? this._layerIds;

    // if config layer count differs, keep existing but only control those in config
    this._controlledLayerIds = layers;

    // build clips
    const clips = cfg.clips || {};
    for(const [clipId, c] of Object.entries(clips)){
      const frames = Array.isArray(c.frames) ? c.frames.slice() : [];
      const durationsMs = Array.isArray(c.durationsMs) ? c.durationsMs.slice() : [];
      const loop = (c.loop !== false); // default true

      // normalize durations: if durations length mismatch -> fallback to 120ms each
      const dMs = (durationsMs.length === frames.length)
        ? durationsMs
        : frames.map(()=>120);

      // preload textures
      const texArr = [];
      for(const f of frames){
        const url = this._joinUrl(this._basePath, f);
        const tex = await PIXI.Assets.load(url);
        texArr.push(tex);
      }

      this._clips.set(clipId, {
        id: clipId,
        textures: texArr,
        durationsMs: dMs,
        loop
      });
    }
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;
    for(const layer of this._layers.values()){
      this._cover(layer.sprite);
    }
  }

  applyStoryState(storyState){
    const fx = storyState?.fxLayers ?? storyState?.state?.fxLayers ?? null;

    // no fxLayers => do nothing (don’t break old stories)
    if(!fx) return;

    for(const id of this._controlledLayerIds || this._layerIds){
      const layer = this._layers.get(id);
      if(!layer) continue;

      const spec = fx[id] ?? null;

      const wantVisible = !!(spec && spec.visible);
      const wantClip = (spec && typeof spec.clip === "string" && spec.clip.trim())
        ? spec.clip.trim()
        : null;

      // visibility
      layer.visible = wantVisible && !!wantClip;
      layer.container.visible = layer.visible;

      // clip change
      if(wantClip && layer.clipId !== wantClip){
        layer.clipId = wantClip;
        layer.frameIdx = 0;
        layer.frameT = 0;
        layer.playing = true;

        // set first frame immediately
        const clip = this._clips.get(wantClip);
        if(clip && clip.textures.length){
          layer.sprite.texture = clip.textures[0];
          layer.sprite.visible = true;
          this._cover(layer.sprite);
        } else {
          layer.sprite.visible = false;
        }
      }

      // if hidden, stop playing to save CPU
      if(!layer.visible){
        layer.playing = false;
      } else {
        // if visible but clip missing, keep not playing
        const clip = this._clips.get(layer.clipId);
        if(!clip || !clip.textures.length){
          layer.playing = false;
          layer.sprite.visible = false;
        }
      }
    }
  }

  update(dtSec){
    for(const id of this._controlledLayerIds || this._layerIds){
      const layer = this._layers.get(id);
      if(!layer || !layer.visible || !layer.playing) continue;

      const clip = this._clips.get(layer.clipId);
      if(!clip || clip.textures.length === 0) continue;

      const frameCount = clip.textures.length;

      // hold if play-once finished
      if(!clip.loop && layer.frameIdx >= frameCount - 1){
        layer.playing = false;
        continue;
      }

      layer.frameT += dtSec;

      // current frame duration
      const durMs = clip.durationsMs[layer.frameIdx] ?? 120;
      const durSec = Math.max(0.01, durMs / 1000);

      while(layer.frameT >= durSec){
        layer.frameT -= durSec;
        layer.frameIdx += 1;

        if(layer.frameIdx >= frameCount){
          if(clip.loop){
            layer.frameIdx = 0;
          } else {
            layer.frameIdx = frameCount - 1;
            layer.playing = false;
            break;
          }
        }

        layer.sprite.texture = clip.textures[layer.frameIdx];
      }
    }
  }

  _joinUrl(base, rel){
    if(!base.endsWith("/")) base += "/";
    return rel.startsWith("/") ? (base + rel.slice(1)) : (base + rel);
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