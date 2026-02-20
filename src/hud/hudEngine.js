import { calcHandAngles } from "./clockHands.js";

function el(tag){
  return document.createElement(tag);
}

// iOS-safe tap handler: use POINTER ONLY to avoid double-fire (touchend/click duplication)
function onTap(target, fn){
  let last = 0;
  target.style.touchAction = "manipulation";

  target.addEventListener("pointerup", (e) => {
    const now = Date.now();
    if (now - last < 350) return;
    last = now;
    try { fn(e); } catch(_) {}
  }, { passive: true });
}

export class HudEngine {
  constructor({ overlayEl, hudLayout }){
    this.root = overlayEl;
    this.layout = hudLayout;
    this.state = {};
    this.dialogueLang = "th";

    this.stageEl = document.getElementById("stage");

    this.monthEl = el("div");
    this.dayEl = el("div");
    this.statusEl = el("div");
    this.moodEl = el("div");
    this.dialogueEl = el("div");
    this.inRoomWrap = el("div");

    this.hourHand = el("div");
    this.minHand = el("div");

    // portrait
    this.portraitEl = el("img");
    this.portraitEl.style.position = "absolute";
    this.portraitEl.style.objectFit = "contain";
    this.portraitEl.style.userSelect = "none";
    this.portraitEl.style.cursor = "pointer";
    this.portraitEl.style.pointerEvents = "auto";

    this._portraitAnimTimer = null;
    this._portraitAnimIndex = 0;
    this._portraitAnimSig = null;
    this._lastEmotion = null;

    // status icon
    this.statusIconEl = el("img");
    this.statusIconEl.style.position = "absolute";
    this.statusIconEl.style.objectFit = "contain";
    this.statusIconEl.style.userSelect = "none";
    this.statusIconEl.style.pointerEvents = "none";
    this.statusIconEl.style.display = "none";

    this._statusAnimTimer = null;
    this._statusAnimIndex = 0;
    this._statusAnimSig = null;
    this._lastStatusIcon = null;

    // logo hotspot
    this.logoHotspotEl = el("div");
    this.logoHotspotEl.style.position = "absolute";
    this.logoHotspotEl.style.background = "transparent";
    this.logoHotspotEl.style.cursor = "pointer";
    this.logoHotspotEl.style.pointerEvents = "auto";
    this.logoHotspotEl.style.display = "none";

    /* ---------- audio buttons hotspots + slash overlays ---------- */
    this.audio = null; // AudioManager instance (optional)
    this._sfxEnabledUI = false;
    this._musicEnabledUI = false;

    this.sfxBtnEl = el("div");
    this.musicBtnEl = el("div");
    for(const b of [this.sfxBtnEl, this.musicBtnEl]){
      b.style.position = "absolute";
      b.style.background = "transparent";
      b.style.cursor = "pointer";
      b.style.pointerEvents = "auto";
      b.style.display = "none";
    }

    // draw slash overlay as a div line (no extra PNG needed)
    this.sfxSlashEl = el("div");
    this.musicSlashEl = el("div");
    for(const sl of [this.sfxSlashEl, this.musicSlashEl]){
      Object.assign(sl.style, {
        position: "absolute",
        left: "12%",
        top: "50%",
        width: "76%",
        height: "10%",
        background: "rgba(40,40,40,0.92)",
        transform: "translateY(-50%) rotate(-35deg)",
        borderRadius: "999px",
        pointerEvents: "none",
        display: "block"
      });
    }
    this.sfxBtnEl.appendChild(this.sfxSlashEl);
    this.musicBtnEl.appendChild(this.musicSlashEl);

    this.root.append(
      this.monthEl, this.dayEl,
      this.statusEl, this.moodEl,
      this.dialogueEl,
      this.inRoomWrap,
      this.hourHand, this.minHand,
      this.portraitEl,
      this.statusIconEl,
      this.logoHotspotEl,
      this.sfxBtnEl,
      this.musicBtnEl
    );

    for(const e of [this.monthEl,this.dayEl,this.statusEl,this.moodEl,this.dialogueEl]){
      e.style.position = "absolute";
      e.style.color = "#2a2a2a";
      e.style.fontWeight = "700";
      e.style.userSelect = "none";
    }

    // calendar clickable
    this.monthEl.style.cursor = "pointer";
    this.dayEl.style.cursor = "pointer";
    this.monthEl.style.pointerEvents = "auto";
    this.dayEl.style.pointerEvents = "auto";

    this.dialogueEl.style.cursor = "pointer";
    this.dialogueEl.style.display = "flex";
    this.dialogueEl.style.alignItems = "center";
    this.dialogueEl.style.justifyContent = "center";
    this.dialogueEl.style.textAlign = "center";
    this.dialogueEl.style.padding = "0.5rem";

    for(const h of [this.hourHand, this.minHand]){
      h.style.position = "absolute";
      h.style.transformOrigin = "50% 90%";
      h.style.background = "rgba(40,40,40,0.9)";
      h.style.borderRadius = "999px";
      h.style.pointerEvents = "none";
    }

    this.inRoomWrap.style.position = "absolute";
    this.inRoomWrap.style.display = "flex";
    this.inRoomWrap.style.gap = "0.5rem";
    this.inRoomWrap.style.pointerEvents = "auto";

    // modal
    this._initModal();

    // interactions
    onTap(this.portraitEl, () => {
      const src = this.state.profileCardSrc || "assets/cards/profile_card.png";
      this._openModal(src);
    });

    const openSchedule = () => {
      const src = this.state.scheduleCardSrc || "assets/cards/schedule_card.png";
      this._openModal(src);
    };
    onTap(this.monthEl, openSchedule);
    onTap(this.dayEl, openSchedule);

    onTap(this.logoHotspotEl, () => {
      if(this.layout.intromieUrl){
        window.open(this.layout.intromieUrl, "_blank", "noopener,noreferrer");
      }
    });

    // audio button taps
    onTap(this.sfxBtnEl, async () => {
      if(!this.audio) return;
      const on = await this.audio.toggleSfx();
      this._sfxEnabledUI = !!on;
      this._applyAudioUI();
    });

    onTap(this.musicBtnEl, async () => {
      if(!this.audio) return;
      const on = await this.audio.toggleMusic();
      this._musicEnabledUI = !!on;
      this._applyAudioUI();
    });

    this.setPortrait("normal");
    this._applyAudioUI();
  }

  // called by main after creating AudioManager
  setAudioManager(audioManager){
    this.audio = audioManager;
    this._sfxEnabledUI = !!audioManager?.isSfxEnabled?.();
    this._musicEnabledUI = !!audioManager?.isMusicEnabled?.();
    this._applyAudioUI();
  }

  _applyAudioUI(){
    // slash visible when OFF
    this.sfxSlashEl.style.display = this._sfxEnabledUI ? "none" : "block";
    this.musicSlashEl.style.display = this._musicEnabledUI ? "none" : "block";
  }

  /* ---------- MODAL (Smooth + Premium) ---------- */

  _initModal(){
    // inject CSS once (safe, self-contained, no dependency on external css)
    if(!document.getElementById("hud-modal-style")){
      const style = el("style");
      style.id = "hud-modal-style";
      style.textContent = `
.hudModalBackdrop {
  opacity: 0;
  transition: opacity 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: opacity;
}

.hudModalCard {
  transform: translateY(18px) scale(0.94);
  opacity: 0;
  transition:
    transform 420ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform, opacity;
}

.hudModalBackdrop.show { opacity: 1; }

.hudModalCard.show {
  transform: translateY(0) scale(1);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .hudModalBackdrop, .hudModalCard {
    transition: none !important;
  }
}
      `;
      document.head.appendChild(style);
    }

    this.modalBackdrop = el("div");
    this.modalBackdrop.className = "hudModalBackdrop";
    Object.assign(this.modalBackdrop.style,{
      position:"fixed",
      inset:"0",
      display:"none",
      alignItems:"center",
      justifyContent:"center",
      background:"rgba(0,0,0,0.55)",
      zIndex:"999999",
      pointerEvents:"auto"
    });

    this.modalCard = el("div");
    this.modalCard.className = "hudModalCard";
    Object.assign(this.modalCard.style,{
      position:"relative",
      pointerEvents:"auto",
      maxWidth:"92vw",
      maxHeight:"88vh"
    });

    this.modalImg = el("img");
    Object.assign(this.modalImg.style,{
      maxWidth:"92vw",
      maxHeight:"88vh",
      borderRadius:"16px",
      display:"block",
      pointerEvents:"none",
      userSelect:"none",
      WebkitUserSelect:"none"
    });

    this.modalClose = el("button");
    Object.assign(this.modalClose.style,{
      position:"absolute",
      right:"10px",
      top:"10px",
      width:"36px",
      height:"36px",
      borderRadius:"999px",
      border:"none",
      cursor:"pointer",
      background:"rgba(0,0,0,0.7)",
      color:"#fff",
      fontSize:"18px",
      pointerEvents:"auto"
    });
    this.modalClose.type = "button";
    this.modalClose.textContent="✕";

    this.modalCard.append(this.modalImg,this.modalClose);
    this.modalBackdrop.appendChild(this.modalCard);
    document.body.appendChild(this.modalBackdrop);

    // close interactions
    onTap(this.modalClose, ()=>this._closeModal());
    onTap(this.modalBackdrop, (e)=>{
      if(e.target===this.modalBackdrop) this._closeModal();
    });

    this._modalClosingTimer = null;
    this._modalIsOpen = false;
  }

  _openModal(src){
    // cancel pending close timer
    if(this._modalClosingTimer){
      clearTimeout(this._modalClosingTimer);
      this._modalClosingTimer = null;
    }

    this.modalImg.src = src;
    this.modalBackdrop.style.display = "flex";

    // force initial state (hidden) then animate in next frame
    this.modalBackdrop.classList.remove("show");
    this.modalCard.classList.remove("show");

    requestAnimationFrame(() => {
      this.modalBackdrop.classList.add("show");
      this.modalCard.classList.add("show");
      this._modalIsOpen = true;
    });
  }

  _closeModal(){
    if(!this._modalIsOpen) {
      this.modalBackdrop.style.display = "none";
      return;
    }

    // animate out
    this.modalBackdrop.classList.remove("show");
    this.modalCard.classList.remove("show");

    // after animation, hide completely
    this._modalClosingTimer = setTimeout(() => {
      this.modalBackdrop.style.display = "none";
      this._modalIsOpen = false;
    }, 460);
  }

  /* ---------- LAYOUT ---------- */

  resize(){ this._applyLayout(); }

  _stageRect(){ return this.stageEl.getBoundingClientRect(); }

  _applyRectPx(elm, rectPct){
    const r=this._stageRect();
    elm.style.left=(rectPct.x/100)*r.width+"px";
    elm.style.top=(rectPct.y/100)*r.height+"px";
    elm.style.width=(rectPct.w/100)*r.width+"px";
    elm.style.height=(rectPct.h/100)*r.height+"px";
  }

  _applyLayout(){
    const L=this.layout;

    this._applyRectPx(this.monthEl,L.calendar.month);
    this._applyRectPx(this.dayEl,L.calendar.day);
    this._applyRectPx(this.statusEl,L.statusText);
    this._applyRectPx(this.moodEl,L.moodText);
    this._applyRectPx(this.dialogueEl,L.dialogue);

    if(L.portrait) this._applyRectPx(this.portraitEl,L.portrait);
    if(L.statusIcon) this._applyRectPx(this.statusIconEl,L.statusIcon);

    if(L.logoHotspot){
      this.logoHotspotEl.style.display="block";
      this._applyRectPx(this.logoHotspotEl,L.logoHotspot);
    }

    // audio buttons layout
    if(L.audioButtons?.sfx){
      this.sfxBtnEl.style.display = "block";
      this._applyRectPx(this.sfxBtnEl, L.audioButtons.sfx);
    }else{
      this.sfxBtnEl.style.display = "none";
    }
    if(L.audioButtons?.music){
      this.musicBtnEl.style.display = "block";
      this._applyRectPx(this.musicBtnEl, L.audioButtons.music);
    }else{
      this.musicBtnEl.style.display = "none";
    }

    const slots=L.inRoom.slots;
    if(slots?.length){
      const r=this._stageRect();
      this.inRoomWrap.style.left=(slots[0].x/100)*r.width+"px";
      this.inRoomWrap.style.top=(slots[0].y/100)*r.height+"px";
    }

    const c=L.clock.center;
    const r=this._stageRect();
    const cx=(c.x/100)*r.width;
    const cy=(c.y/100)*r.height;

    const hourLen=(L.clock.hourLenPctOfScreenW/100)*window.innerWidth;
    const minLen=(L.clock.minLenPctOfScreenW/100)*window.innerWidth;
    const t=L.clock.thicknessPx;

    this.hourHand.style.width=`${t}px`;
    this.hourHand.style.height=`${hourLen}px`;
    this.hourHand.style.left=`${cx-t/2}px`;
    this.hourHand.style.top=`${cy-hourLen*0.9}px`;

    this.minHand.style.width=`${t}px`;
    this.minHand.style.height=`${minLen}px`;
    this.minHand.style.left=`${cx-t/2}px`;
    this.minHand.style.top=`${cy-minLen*0.9}px`;
  }

  /* ---------- TIME / TEXT ---------- */

  setCalendar(now){
    const m=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    this.monthEl.textContent=m[now.getMonth()];
    this.dayEl.textContent=now.getDate();
  }

  setClockHands(now){
    const {hourDeg,minDeg}=calcHandAngles(now);
    this.hourHand.style.transform=`rotate(${hourDeg}deg)`;
    this.minHand.style.transform=`rotate(${minDeg}deg)`;
  }

  /* ---------- PORTRAIT ANIM ---------- */

  _stopPortraitAnim(){
    if(this._portraitAnimTimer){
      clearTimeout(this._portraitAnimTimer);
      this._portraitAnimTimer=null;
    }
  }

  _makeAnimSig(anim){
    return (anim.frames||[]).join("|")+"::"+
           (anim.durationsMs||[]).join(",")+"::"+
           (anim.loop?"1":"0");
  }

  _playPortraitAnim(anim){
    this._stopPortraitAnim();
    if(!anim?.frames?.length) return;
    this._portraitAnimIndex=0;
    const play=()=>{
      const frame=anim.frames[this._portraitAnimIndex];
      const dur=anim.durationsMs?.[this._portraitAnimIndex]??500;
      this.portraitEl.src=`assets/portrait/${frame}.png`;
      this._portraitAnimIndex++;
      if(this._portraitAnimIndex>=anim.frames.length){
        if(anim.loop) this._portraitAnimIndex=0;
        else return;
      }
      this._portraitAnimTimer=setTimeout(play,dur);
    };
    play();
  }

  setPortrait(emotion){
    this._stopPortraitAnim();
    this._portraitAnimSig=null;
    this.portraitEl.src=`assets/portrait/${emotion}.png`;
  }

  /* ---------- STATUS ICON ANIM ---------- */

  _stopStatusAnim(){
    if(this._statusAnimTimer){
      clearTimeout(this._statusAnimTimer);
      this._statusAnimTimer=null;
    }
  }

  _playStatusAnim(anim){
    this._stopStatusAnim();
    if(!anim?.frames?.length) return;
    this._statusAnimIndex=0;
    this.statusIconEl.style.display="block";
    const play=()=>{
      const frame=anim.frames[this._statusAnimIndex];
      const dur=anim.durationsMs?.[this._statusAnimIndex]??400;
      this.statusIconEl.src=`assets/icons/${frame}.png`;
      this._statusAnimIndex++;
      if(this._statusAnimIndex>=anim.frames.length){
        if(anim.loop) this._statusAnimIndex=0;
        else return;
      }
      this._statusAnimTimer=setTimeout(play,dur);
    };
    play();
  }

  setStatusIcon(iconKey){
    this._stopStatusAnim();
    this._statusAnimSig=null;
    if(!iconKey){
      this.statusIconEl.style.display="none";
      this.statusIconEl.removeAttribute("src");
      return;
    }
    this.statusIconEl.src=`assets/icons/${iconKey}.png`;
    this.statusIconEl.style.display="block";
  }

  /* ---------- STATE ---------- */

  setState(state){
    this.state=state||{};
    this.statusEl.textContent=this.state.status||"";
    this.moodEl.textContent=this.state.mood||"";

    const dlg=this.state.dialogue||{};
    this.dialogueEl.textContent=dlg[this.dialogueLang]||"";

    if(this.state.portraitAnim){
      const sig=this._makeAnimSig(this.state.portraitAnim);
      if(sig!==this._portraitAnimSig){
        this._portraitAnimSig=sig;
        this._playPortraitAnim(this.state.portraitAnim);
      }
    }else if(this.state.emotion){
      if(this.state.emotion!==this._lastEmotion){
        this._lastEmotion=this.state.emotion;
        this.setPortrait(this.state.emotion);
      }
    }

    if(this.state.statusIconAnim){
      const sig=this._makeAnimSig(this.state.statusIconAnim);
      if(sig!==this._statusAnimSig){
        this._statusAnimSig=sig;
        this._playStatusAnim(this.state.statusIconAnim);
      }
    }else{
      if(this.state.statusIcon!==this._lastStatusIcon){
        this._lastStatusIcon=this.state.statusIcon;
        this.setStatusIcon(this.state.statusIcon);
      }
    }

    this._renderInRoom(this.state.inRoom||[]);
  }

  enableDialogueToggle(cb){
    this.dialogueEl.onclick=cb;
  }

  toggleDialogueLang(){
    this.dialogueLang=this.dialogueLang==="th"?"en":"th";
    this.setState(this.state);
  }

  _renderInRoom(list){
    this.inRoomWrap.innerHTML="";
    const slots=this.layout.inRoom.slots;
    const r=this._stageRect();
    list.slice(0,slots.length).forEach((id,i)=>{
      const s=slots[i];
      const card=el("img");
      card.src=`assets/characters/${id}.png`;
      card.style.width=(s.w/100)*r.width+"px";
      card.style.height=(s.h/100)*r.height+"px";
      card.style.objectFit="contain";
      card.style.borderRadius="8px";
      card.style.cursor="pointer";
      card.style.pointerEvents="auto";

      onTap(card, ()=>{
        this._openModal(`assets/cards/characters/${id}.png`);
      });

      this.inRoomWrap.appendChild(card);
    });
  }
}
