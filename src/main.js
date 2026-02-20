// src/main.js
import { SceneEngine } from "./scene/sceneEngine.js";
import { HudEngine } from "./hud/hudEngine.js";
import { StoryEngine } from "./story/storyEngine.js";
import { AudioManager } from "./audio/audioManager.js";

const TEMPLATE_W = 1595;
const TEMPLATE_H = 3457;
const RATIO = TEMPLATE_H / TEMPLATE_W;

const STAGE_Y_OFFSET_PX = 20;

async function loadJSON(url){
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error(`Failed to load ${url}`);
  return await res.json();
}

function setVisualViewportHeight(){
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--vvh", `${h * 0.01}px`);
}

function setStageByRatio(){
  const vw = window.innerWidth;
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);

  const stageH = vw * RATIO;
  document.documentElement.style.setProperty("--stage-h", `${stageH}px`);

  let y = (vh - stageH) / 2;
  y += STAGE_Y_OFFSET_PX;

  y = Math.min(0, y);
  y = Math.max(vh - stageH, y);

  document.documentElement.style.setProperty("--stage-y", `${y}px`);
}

async function boot(){
  setVisualViewportHeight();
  setStageByRatio();

  const sceneLayout = await loadJSON("./data/scene_layout.json");
  const hudLayout = await loadJSON("./data/hud_layout.json");

  const scene = new SceneEngine({
    hostEl: document.getElementById("scene-host"),
    sceneLayout
  });

  const hud = new HudEngine({
    overlayEl: document.getElementById("overlay"),
    hudLayout
  });

  const story = new StoryEngine({
    storyUrl: "./data/story/2026-02-14.json"
  });

  await story.init();

  hud.setState(story.getCurrentState());
  hud.enableDialogueToggle(() => hud.toggleDialogueLang());

  const reflow = () => {
    setVisualViewportHeight();
    setStageByRatio();
    scene.resize();
    hud.resize();
  };

  if(window.visualViewport){
    window.visualViewport.addEventListener("resize", reflow);
    window.visualViewport.addEventListener("scroll", reflow);
  }
  window.addEventListener("resize", reflow);

  // --- SKY ---
  const skyCfg = await loadJSON("./data/sky_config.json");
  const urls = [...new Set(skyCfg.keyframes.map(k => k.src))];

  await scene.initSky({
    urls,
    keyframes: skyCfg.keyframes,
    mode: "keyframes"
  });

  // --- CLOUDS ---
  const cloudCfg = await loadJSON("./data/cloud_config.json");
  await scene.initClouds(cloudCfg);

  // --- RAIN (NEW) ---
  const rainCfg = await loadJSON("./data/rain_config.json");
  await scene.initRain(rainCfg);

  // --- AUDIO (NEW) ---
  const audioCfg = await loadJSON("./data/audio_config.json");
  const audio = new AudioManager(audioCfg);
  hud.setAudioManager(audio);

  // thunder sync with lightning flashes (from RainManager)
  window.addEventListener("lbtw:lightning", () => {
    audio.playSfx("thunder", { volume: 1.0 });
  });

  // first layout
  scene.resize();
  hud.resize();

  // set initial clouds instantly (no fade-in on refresh)
  const now0 = new Date();
  const initialState = story.computeStateAt(now0);
  const initialProfile =
    initialState?.cloudProfile ??
    initialState?.state?.cloudProfile ??
    "none";
  scene.setInitialCloudProfile(initialProfile);

  let lastTs = performance.now();

  function tick(){
    const now = new Date();
    const ts = performance.now();
    const dtSec = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    const nextState = story.computeStateAt(now);

    scene.update(now, dtSec, nextState);

    hud.setState(nextState);
    hud.setCalendar(now);
    hud.setClockHands(now);

    // ✅ NEW: Audio follows state (starts silent; user must tap buttons)
    audio.applyStoryState(now, nextState);

    requestAnimationFrame(tick);
  }

  tick();
}

boot().catch(err => {
  console.error(err);
  document.body.style.background = "#111";
});
