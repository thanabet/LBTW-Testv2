// src/scene/actorManager.js
import { CatActor } from "./actors/catActor.js";

export class ActorManager {
  constructor(container){
    this.container = container;
    this._rect = { x:0, y:0, w:100, h:100 };
    this.actors = [];
  }

  async load(cfg){
    // cfg: { actors: [...] }
    const actors = Array.isArray(cfg?.actors) ? cfg.actors : [];
    this.actors = [];

    // Clear container
    this.container.removeChildren();

    for(const a of actors){
      const type = String(a?.type || "").trim().toLowerCase();
      if(type === "cat"){
        const cat = new CatActor(this.container);
        await cat.load(a); // safe load (missing png won't crash)
        this.actors.push(cat);
      } else {
        // ignore unknown actors safely
      }
    }
  }

  resizeToRect(sceneRectPx){
    this._rect = sceneRectPx;
    for(const a of this.actors){
      a.resizeToRect(sceneRectPx);
    }
  }

  update(now, dtSec, storyState){
    for(const a of this.actors){
      a.update(now, dtSec, storyState);
    }
  }

  onPointerTap(globalX, globalY){
    // route click to top-most actor first (reverse)
    for(let i=this.actors.length-1; i>=0; i--){
      const a = this.actors[i];
      if(a.onPointerTap(globalX, globalY)){
        return true;
      }
    }
    return false;
  }
}