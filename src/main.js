import { HudEngine } from "./hud/hudEngine.js";
import { SceneEngine } from "./scene/sceneEngine.js";
import { loadStory } from "./story/storyEngine.js";
import { AudioManager } from "./audio/audioManager.js";

/* =========================
   Small helpers
========================= */
async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

/** Debug overlay on screen (no need to edit index.html) */
function ensureDebugOverlay() {
  let el = document.getElementById("debugOverlay");
  if (el) return el;

  el = document.createElement("div");
  el.id = "debugOverlay";
  el.style.position = "fixed";
  el.style.left = "12px";
  el.style.right = "12px";
  el.style.top = "12px";
  el.style.zIndex = "999999";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "10px";
  el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.35";
  el.style.whiteSpace = "pre-wrap";
  el.style.background = "rgba(140,0,0,0.85)";
  el.style.color = "#fff";
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function showDebug(msg) {
  const el = ensureDebugOverlay();
  el.textContent = msg;
  el.style.display = "block";
}

function hideDebug() {
  const el = document.getElementById("debugOverlay");
  if (el) el.style.display = "none";
}

/** Always keep RAF loop alive even if something throws */
function safeCall(label, fn) {
  try {
    fn();
  } catch (err) {
    const msg =
      `❌ Runtime error in ${label}\n\n` +
      (err?.stack ? err.stack : String(err));
    showDebug(msg);
    // don't rethrow — keep loop running
  }
}

/* =========================
   Main
========================= */
let hud, scene, story, audio;
let lastTs = 0;

function getNowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function computeStateAtMinute(storyObj, minute) {
  // storyEngine.js export: loadStory() gives { date, events, ... }
  // each event: { time:"HH:MM", state:{...} }
  const events = Array.isArray(storyObj?.events) ? storyObj.events : [];
  if (events.length === 0) return {};

  // convert "HH:MM" -> minutes
  const timeToMin = (t) => {
    if (typeof t !== "string") return 0;
    const [hh, mm] = t.split(":");
    const H = Number(hh);
    const M = Number(mm);
    if (!Number.isFinite(H) || !Number.isFinite(M)) return 0;
    return H * 60 + M;
  };

  let chosen = events[0];
  for (const ev of events) {
    if (timeToMin(ev.time) <= minute) chosen = ev;
  }
  return chosen?.state || {};
}

function resizeAll() {
  safeCall("resizeAll()", () => {
    const stage = document.getElementById("stage");
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    if (scene) scene.resize(w, h);
    if (hud) hud.resize(w, h);
  });
}

function tick(ts) {
  // ALWAYS schedule next frame first (so even if something breaks, we keep looping)
  requestAnimationFrame(tick);

  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;

  const nowMin = getNowMinutes();

  // state
  let state = {};
  safeCall("computeStateAtMinute()", () => {
    state = computeStateAtMinute(story, nowMin) || {};
  });

  // update
  safeCall("scene.update()", () => {
    if (scene) scene.update(state, dt);
  });

  safeCall("hud.update()", () => {
    if (hud) hud.update(state, dt);
  });

  safeCall("audio.applyStoryState()", () => {
    if (audio) audio.applyStoryState(state);
  });
}

async function boot() {
  try {
    hideDebug();

    // Engines
    hud = new HudEngine({
      stageEl: document.getElementById("stage"),
      templateEl: document.getElementById("template"),
    });

    scene = new SceneEngine({
      stageEl: document.getElementById("stage"),
      sceneEl: document.getElementById("scene"),
    });

    audio = new AudioManager();

    // Load configs (NO-STORE to avoid stale cache)
    const [hudLayout, storyObj] = await Promise.all([
      loadJSON("./data/hud_layout.json"),
      loadStory("./data/2026-02-14.json"),
    ]);

    story = storyObj;

    // Init (order matters)
    await scene.init();
    await hud.init(hudLayout);
    await audio.init();

    resizeAll();
    window.addEventListener("resize", resizeAll);

    // Start loop
    requestAnimationFrame(tick);
  } catch (err) {
    const msg =
      `❌ BOOT ERROR\n\n` +
      (err?.stack ? err.stack : String(err)) +
      `\n\n` +
      `เช็คบ่อยสุด:\n` +
      `- path ไฟล์ ./data/*.json หรือรูป/เสียง 404\n` +
      `- json พัง (comma/quote)\n` +
      `- import path ไม่ตรงโฟลเดอร์`;
    showDebug(msg);
    console.error(err);
  }
}

boot();
