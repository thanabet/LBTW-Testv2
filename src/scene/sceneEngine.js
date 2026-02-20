import { SkyManager } from "./skyManager.js";
import { CloudManager } from "./cloudManager.js";
import { RainManager } from "./rainManager.js";

const CLOUD_PROFILE_FADE_SEC = 60.0;

export class SceneEngine {
  constructor({ hostEl, sceneLayout }){
    this.hostEl = hostEl;
    this.layout = sceneLayout;

    this.app = null;

    this.sky = null;

    // cloud crossfade system
    this.cloudContainer = null;
    this.cloudLayerA = null;
    this.cloudLayerB = null;
    this.cloudsA = null;
    this.cloudsB = null;

    this._activeCloud = "A";
    this._currentCloudProfile = "none";
    this._targetCloudProfile = "none";
    this._xfading = false;
    this._fadeT = 0;
    this._fadeDur = CLOUD_PROFILE_FADE_SEC;

    this._hasSetInitialCloud = false;

    // rain layer (above clouds)
    this.rainContainer = null;
    this.rain = null;
    this._rainReady = false;

    // ✅ remember current lightning state to avoid spamming setters
    this._lastLightningEnabled = null;

    this.skyContainer = null;
    this.sceneRectPx = null;

    this._maskG = null;
  }

  _percentRectToPx(rectPct, w, h){
    return {
      x: (rectPct.x/100) * w,
      y: (rectPct.y/100) * h,
      w: (rectPct.w/100) * w,
      h: (rectPct.h/100) * h
    };
  }

  async _ensurePixi(){
    if(this.app) return;

    this.app = new PIXI.Application();
    await this.app.init({
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.max(1, window.devicePixelRatio || 1),
      autoDensity: true
    });

    this.hostEl.appendChild(this.app.canvas);

    // stage layers
    this.skyContainer = new PIXI.Container();
    this.cloudContainer = new PIXI.Container();
    this.rainContainer = new PIXI.Container();

    // order: sky -> clouds -> rain
    this.app.stage.addChild(this.skyContainer);
    this.app.stage.addChild(this.cloudContainer);
    this.app.stage.addChild(this.rainContainer);

    // 2 alpha layers for clouds
    this.cloudLayerA = new PIXI.Container();
    this.cloudLayerB = new PIXI.Container();
    this.cloudContainer.addChild(this.cloudLayerA);
    this.cloudContainer.addChild(this.cloudLayerB);

    // initial visibility (A visible)
    this.cloudLayerA.alpha = 1;
    this.cloudLayerB.alpha = 0;
  }

  async initSky(arg){
    await this._ensurePixi();

    this.sky = new SkyManager(this.skyContainer);

    if(Array.isArray(arg)){
      await this.sky.load({ urls: arg });
    } else {
      await this.sky.load(arg);
    }
  }

  async initClouds(cloudConfig){
    await this._ensurePixi();

    this.cloudsA = new CloudManager(this.cloudLayerA);
    this.cloudsB = new CloudManager(this.cloudLayerB);

    await this.cloudsA.loadConfig(cloudConfig);
    await this.cloudsB.loadConfig(cloudConfig);

    this.cloudsA.setProfile("none");
    this.cloudsB.setProfile("none");

    this._activeCloud = "A";
    this._currentCloudProfile = "none";
    this._targetCloudProfile = "none";
    this._xfading = false;
    this._fadeT = 0;
    this._fadeDur = CLOUD_PROFILE_FADE_SEC;

    this._hasSetInitialCloud = false;

    if(this.sceneRectPx){
      this.cloudsA.resizeToRect(this.sceneRectPx);
      this.cloudsB.resizeToRect(this.sceneRectPx);
    }
  }

  async initRain(rainConfig){
    await this._ensurePixi();

    this.rain = new RainManager(this.rainContainer);
    await this.rain.load(rainConfig);

    this.rain.setEnabled(false);
    this._rainReady = true;

    this._lastLightningEnabled = null;

    if(this.sceneRectPx){
      this.rain.resizeToRect(this.sceneRectPx);
    }
  }

  _normalizeProfile(p){
    const s = (p && String(p).trim()) ? String(p).trim() : "none";
    return s;
  }

  _easeInOut(t){
    return t*t*(3 - 2*t);
  }

  setInitialCloudProfile(profile){
    if(!this.cloudsA || !this.cloudsB) return;

    const p = this._normalizeProfile(profile);

    this.cloudsA.setProfile(p);
    this.cloudsB.setProfile(p);

    if(this.sceneRectPx){
      this.cloudsA.resizeToRect(this.sceneRectPx);
      this.cloudsB.resizeToRect(this.sceneRectPx);
    }

    this.cloudLayerA.alpha = 1;
    this.cloudLayerB.alpha = 0;

    this._activeCloud = "A";
    this._currentCloudProfile = p;
    this._targetCloudProfile = p;

    this._xfading = false;
    this._fadeT = 0;

    this._hasSetInitialCloud = true;
  }

  _transitionCloudProfile(nextProfile){
    if(!this.cloudsA || !this.cloudsB) return;

    const next = this._normalizeProfile(nextProfile);

    if(!this._hasSetInitialCloud){
      this.setInitialCloudProfile(next);
      return;
    }

    if(next === this._targetCloudProfile) return;

    this._targetCloudProfile = next;

    const front = (this._activeCloud === "A")
      ? { layer: this.cloudLayerA, mgr: this.cloudsA }
      : { layer: this.cloudLayerB, mgr: this.cloudsB };

    const back = (this._activeCloud === "A")
      ? { layer: this.cloudLayerB, mgr: this.cloudsB }
      : { layer: this.cloudLayerA, mgr: this.cloudsA };

    back.mgr.setProfile(next);
    if(this.sceneRectPx) back.mgr.resizeToRect(this.sceneRectPx);

    back.layer.alpha = 0;
    front.layer.alpha = 1;

    this._xfading = true;
    this._fadeT = 0;
    this._fadeDur = CLOUD_PROFILE_FADE_SEC;
  }

  resize(){
    if(!this.app) return;

    const rect = this.hostEl.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    this.app.renderer.resize(w, h);

    this.sceneRectPx = this._percentRectToPx(this.layout.sceneRect, w, h);

    if(!this._maskG){
      this._maskG = new PIXI.Graphics();
      this.app.stage.addChild(this._maskG);
      this.app.stage.mask = this._maskG;
    }

    this._maskG.clear();
    this._maskG.rect(this.sceneRectPx.x, this.sceneRectPx.y, this.sceneRectPx.w, this.sceneRectPx.h);
    this._maskG.fill({ color: 0xffffff, alpha: 1 });

    if(this.sky) this.sky.resizeToRect(this.sceneRectPx);
    if(this.cloudsA) this.cloudsA.resizeToRect(this.sceneRectPx);
    if(this.cloudsB) this.cloudsB.resizeToRect(this.sceneRectPx);

    if(this.rain) this.rain.resizeToRect(this.sceneRectPx);
  }

  // rain override:
  // storyState.rain or storyState.state.rain (true/false/undefined)
  _resolveRainEnabled(profile, storyState){
    const override =
      (storyState?.rain !== undefined) ? storyState.rain :
      (storyState?.state?.rain !== undefined) ? storyState.state.rain :
      undefined;

    if(override === true) return true;
    if(override === false) return false;

    const p = String(profile).trim().toLowerCase();
    return (p === "overcast");
  }

  // ✅ NEW: lightning override:
  // storyState.lightning or storyState.state.lightning (true/false/undefined)
  // default: ON (but only meaningful when rain is visible)
  _resolveLightningEnabled(storyState){
    const override =
      (storyState?.lightning !== undefined) ? storyState.lightning :
      (storyState?.state?.lightning !== undefined) ? storyState.state.lightning :
      undefined;

    if(override === true) return true;
    if(override === false) return false;

    return true; // default ON
  }

  update(now, dtSec, storyState){
    if(this.sky) this.sky.updateByTime(now);

    const profile =
      storyState?.cloudProfile ??
      storyState?.state?.cloudProfile ??
      "none";

    this._transitionCloudProfile(profile);

    // update clouds motion
    if(this.cloudsA) this.cloudsA.update(now, dtSec);
    if(this.cloudsB) this.cloudsB.update(now, dtSec);

    // cloud crossfade
    if(this._xfading){
      this._fadeT += dtSec;
      const dur = Math.max(0.001, this._fadeDur);
      const t = Math.max(0, Math.min(1, this._fadeT / dur));
      const s = this._easeInOut(t);

      if(this._activeCloud === "A"){
        this.cloudLayerA.alpha = 1 - s;
        this.cloudLayerB.alpha = s;
      } else {
        this.cloudLayerB.alpha = 1 - s;
        this.cloudLayerA.alpha = s;
      }

      if(t >= 1){
        this._xfading = false;
        this._activeCloud = (this._activeCloud === "A") ? "B" : "A";
        this._currentCloudProfile = this._targetCloudProfile;

        if(this._activeCloud === "A"){
          this.cloudLayerA.alpha = 1;
          this.cloudLayerB.alpha = 0;
        } else {
          this.cloudLayerB.alpha = 1;
          this.cloudLayerA.alpha = 0;
        }
      }
    }

    // rain + lightning auto/override
    if(this._rainReady && this.rain){
      const rainOn = this._resolveRainEnabled(profile, storyState);
      this.rain.setEnabled(rainOn);

      // lightning can be overridden; if rain is off it doesn't matter but safe
      const lightningOn = this._resolveLightningEnabled(storyState);

      // avoid calling setter every frame
      if(this._lastLightningEnabled !== lightningOn){
        this.rain.setLightningEnabled(lightningOn);
        this._lastLightningEnabled = lightningOn;
      }

      this.rain.update(dtSec);
    }
  }
}
