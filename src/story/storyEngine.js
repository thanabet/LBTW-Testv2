export class StoryEngine {
  constructor({ storyUrl }){
    this.storyUrl = storyUrl;
    this.story = null;
    this.lang = "th";
  }

  async init(){
    const res = await fetch(this.storyUrl, { cache: "no-store" });
    if(!res.ok) throw new Error("Story load failed");
    this.story = await res.json();
    this.story.events.sort((a,b)=>a.time.localeCompare(b.time));
  }

  _timeToMinutes(t){
    const [hh, mm] = t.split(":").map(Number);
    return hh*60 + mm;
  }

  computeStateAt(now){
    if(!this.story) return {};
    const nowMin = now.getHours()*60 + now.getMinutes();

    let chosen = this.story.events[0]?.state || {};
    for(const ev of this.story.events){
      if(this._timeToMinutes(ev.time) <= nowMin){
        chosen = ev.state;
      } else break;
    }
    return chosen;
  }

  getCurrentState(){
    return this.computeStateAt(new Date());
  }
}
