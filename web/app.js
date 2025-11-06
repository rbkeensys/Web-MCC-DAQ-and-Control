// web/app.js — MCC Web Control (v0.5.2)
// Fixes: no re-mount per tick, one RAF per widget, WS tick only pushes samples.
// Version banner shows UI + /api/diag (mcculw/uldaq + board nums) + session id.

// web/app.js — MCC Web Control (v0.5.1)
// Single-file drop-in with consolidated fixes.
// - UI version banner + optional server/bridge version
// - Widgets render RAW values (no scale/offset in widgets)
// - Per-signal "Cal" editor writes to config.json
// - PID: source (AI/TC) + output (AO/DO) selectors
// - DO buttons: momentary / toggle / buzz with correct channel
// - Resizable widgets (bottom-right handle)
// - Chart: legend, moving red cursor, right-click menu (Current/Cursor + Pause/Resume)
// - Save/Load layout via file dialog (JSON)

const UI_VERSION = "0.5.2";
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ---------- global state ----------
let ws = null;
let sessionDir = null;
let activePageIndex = -1;
const state = {
  pages: [],                       // [{id,name,widgets:[{...}]}]
  ai: new Array(8).fill(0),
  ao: [0,0],
  do: new Array(8).fill(0),
  tc: [],
};
window.lastTelemetry = [];

// ---------- boot ----------
document.addEventListener('DOMContentLoaded', boot);
window.onerror = (m,src,l,c,e)=>console.error('[UI] Error', m, src, l, c, e);
window.onunhandledrejection = e=>console.error('[UI] Rejection', e?.reason||e);

async function boot(){
  wireUI();
  ensureStarterPage();
  await showVersions();
  connect();
}

// ---------- wiring ----------
function wireUI(){
  const btn = $('#connectBtn'); if (btn) btn.onclick = ()=>connect();
  const set = $('#setRate');    if (set) set.onclick = setRate;

  const ec  = $('#editConfig'); if (ec)  ec.onclick = ()=>openJsonEditor('Config','/api/config');
  const ep  = $('#editPID');    if (ep)  ep.onclick = ()=>openJsonEditor('PID','/api/pid');
  const es  = $('#editScript'); if (es)  es.onclick = ()=>openJsonEditor('Script','/api/script');
  const rec = $('#recall');     if (rec) rec.onclick = ()=>openRecall();

  const ap  = $('#addPage');    if (ap)  ap.onclick = ()=>addPageFn();

  $$('.palette [data-add]').forEach(b=> b.onclick = ()=> addWidget(b.dataset.add));

  injectLayoutButtons();
}

function injectLayoutButtons(){
  const pal = document.querySelector('.palette'); if (!pal) return;
  if (pal.querySelector('#saveLayout')) return;
  const wrap = document.createElement('div');
  wrap.style = 'margin-top:10px; border-top:1px solid #1f2330; padding-top:10px;';
  wrap.innerHTML = `
    <h3>Layout</h3>
    <button id="saveLayout">Save Layout</button>
    <button id="loadLayout">Load Layout</button>
  `;
  pal.appendChild(wrap);
  $('#saveLayout').onclick = saveLayout;
  $('#loadLayout').onclick = loadLayout;
}

// ---------- versions banner ----------
async function showVersions(){
  let text = `UI ${UI_VERSION}`;
  try {
    const diag = await fetch('/api/diag', {cache:'no-store'}).then(r=>r.ok?r.json():null);
    if (diag) {
      const b0 = diag.board1608?.boardNum, b1 = diag.boardetc?.boardNum;
      text += ` · mcculw:${diag.mcculw?'yes':'no'} · uldaq:${diag.uldaq?'yes':'no'} · 1608#${b0} etc#${b1}`;
    }
  } catch(_){}
  const s = $('#session'); if (s) s.textContent = text;
}

// ---------- WS ----------
function connect(){
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const url = `ws://${location.host}/ws`;
  ws = new WebSocket(url);

  ws.onopen = ()=> { const b=$('#connectBtn'); if (b) b.textContent='Connected'; };
  ws.onclose= ()=> { const b=$('#connectBtn'); if (b) b.textContent='Connect'; };
  ws.onerror= e  => console.error('[WS] error', e);

  ws.onmessage = (evt)=>{
    let msg; try { msg = JSON.parse(evt.data); } catch(e){ return; }
    if (msg.type === 'session') {
      sessionDir = msg.dir;
      const s = $('#session');
      if (s) s.textContent = (s.textContent? s.textContent+' · ' : '') + `session ${sessionDir}`;
    } else if (msg.type === 'tick') {
      // update state only; DO NOT repaint page here
      if (Array.isArray(msg.ai)) state.ai = msg.ai;
      if (Array.isArray(msg.ao)) state.ao = msg.ao;
      if (Array.isArray(msg.do)) state.do = msg.do;
      if (Array.isArray(msg.tc)) state.tc = msg.tc;
      window.lastTelemetry = Array.isArray(msg.pid)? msg.pid : [];

      // push sample to charts on the active page (no DOM rebuild)
      pushTickToCharts();
    }
  };

  if (!window._wsPing) {
    window._wsPing = setInterval(()=>{ try { if(ws && ws.readyState===WebSocket.OPEN) ws.send('k'); } catch(_){} }, 3000);
  }
}

// ---------- rate ----------
async function setRate(){
  const hz = parseFloat($('#rate')?.value || '100');
  try {
    await fetch('/api/acq/rate', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      cache:'no-store',
      body: JSON.stringify({hz})
    });
  } catch(e) { console.warn('setRate failed', e); }
}

// ---------- pages ----------
function ensureStarterPage(){
  if (state.pages.length===0){
    const id='p'+Date.now();
    const chart = makeWidget('chart',  40, 40);
    const gauge = makeWidget('gauge', 430, 40);
    state.pages.push({id, name:'Page 1', widgets:[chart, gauge]});
    refreshPages();
    setActivePage(0);
  } else {
    refreshPages();
    if (activePageIndex<0) setActivePage(0);
  }
}
function addPageFn(){
  const id = 'p'+Date.now();
  state.pages.push({id, name:`Page ${state.pages.length+1}`, widgets:[]});
  refreshPages(); setActivePage(state.pages.length-1);
}
function refreshPages(){
  const box = $('#pages'); if (!box) return;
  box.innerHTML='';
  state.pages.forEach((p,i)=>{
    const b = document.createElement('button'); b.textContent=p.name; b.onclick=()=>setActivePage(i); box.appendChild(b);
  });
}
function setActivePage(i){
  activePageIndex = i;
  paintActivePage(true);     // only on page switch / structure change
}

// ---------- widgets model ----------
function makeWidget(type,x,y){
  return { id:'w'+Date.now()+Math.floor(Math.random()*999), type, x,y, w:360,h:220, opts: defaultOpts(type) };
}
function defaultOpts(type){
  switch(type){
    case 'chart':   return { title:'Chart', series:[ sel('ai',0) ], span:10, readout:'current', paused:false };
    case 'gauge':   return { title:'Gauge', needles:[ sel('ai',0) ], min:0, max:10 };
    case 'bars':    return { title:'Bars', series:[ sel('ai',0), sel('ai',1) ], min:0, max:10 };
    case 'dobutton':return { title:'DO', doIndex:0, activeHigh:true, mode:'momentary', buzzHz:5 };
    case 'pidpanel':return { title:'PID', loopIndex:0 };
    case 'aoslider':return { title:'AO Slider', aoIndex:0, min:0, max:10, step:0.01, live:true };
  }
}
function sel(kind, index){ return { kind, index, name:`${kind}${index}`, units:'' }; }

// RAW values only — calibration is applied on the server
function valueFor(s){
  if (s.kind==='ai') return state.ai[s.index] ?? 0;
  if (s.kind==='ao') return state.ao[s.index] ?? 0;
  if (s.kind==='do') return state.do[s.index] ?? 0;
  if (s.kind==='tc') return state.tc[s.index] ?? 0;
  return 0;
}

// ---------- paint page once ----------
function paintActivePage(force=false){
  const c = $('#canvas'); if (!c) return;
  c.innerHTML='';
  if (activePageIndex<0) return;
  const p = state.pages[activePageIndex];
  p.widgets.forEach(w => mountWidget(c, p, w));
}

function addWidget(type){
  if (activePageIndex<0) addPageFn();
  const p = state.pages[activePageIndex];
  const w = makeWidget(type, 40+20*p.widgets.length, 40+20*p.widgets.length);
  p.widgets.push(w);
  // mount only the new widget
  mountWidget($('#canvas'), p, w);
}

// ---------- mount single widget (no re-mount on ticks) ----------
function mountWidget(canvas, page, w){
  const el = document.createElement('div'); el.className='widget';
  el.style.left=w.x+'px'; el.style.top=w.y+'px'; el.style.width=w.w+'px'; el.style.height=w.h+'px';
  el.innerHTML = `
    <header><span class="title">${w.opts.title||w.type}</span>
      <span>
        <button data-cfg title="Configure">⚙︎</button>
        <button data-del title="Delete">✕</button>
        <span class="handle" title="Drag">⣿</span>
      </span>
    </header>
    <div class="content"></div>
    <div class="resizer" style="position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.35">◢</div>
  `;
  const content = el.querySelector('.content');

  // drag
  let dx=0,dy=0,drag=false;
  el.querySelector('.handle').onmousedown = (e)=>{ drag=true; dx=e.clientX-w.x; dy=e.clientY-w.y; e.preventDefault(); };
  window.addEventListener('mousemove',(e)=>{ if(!drag) return; w.x=e.clientX-dx; w.y=e.clientY-dy; el.style.left=w.x+'px'; el.style.top=w.y+'px';});
  window.addEventListener('mouseup',()=>drag=false);

  // resize
  let rx=0, ry=0, rw=0, rh=0, resizing=false;
  el.querySelector('.resizer').onmousedown = (e)=>{ resizing=true; rx=e.clientX; ry=e.clientY; rw=w.w; rh=w.h; e.preventDefault(); };
  window.addEventListener('mousemove',(e)=>{ if(!resizing) return; w.w=Math.max(240, rw+(e.clientX-rx)); w.h=Math.max(160, rh+(e.clientY-ry)); el.style.width=w.w+'px'; el.style.height=w.h+'px'; });
  window.addEventListener('mouseup',()=> resizing=false);

  // cfg / delete
  el.querySelector('[data-cfg]').onclick = ()=> openWidgetConfig(page, w, el);
  el.querySelector('[data-del]').onclick = ()=>{ page.widgets = page.widgets.filter(x=>x.id!==w.id); el.remove(); };

  // render
  if (w.type==='chart')    renderChart(content, w);
  if (w.type==='gauge')    renderGauge(content, w);
  if (w.type==='bars')     renderBars(content, w);
  if (w.type==='dobutton') renderDOButton(content, w);
  if (w.type==='pidpanel') renderPID(content, w);
  if (w.type==='aoslider') renderAOSlider(content, w);

  canvas.appendChild(el);
}

// ---------- tick -> charts only ----------
function pushTickToCharts(){
  if (activePageIndex<0) return;
  const p = state.pages[activePageIndex];
  for (const w of p.widgets){
    if (w.type==='chart' && typeof w._onTick === 'function'){
      w._onTick();
    }
  }
}

// ---------- chart (single RAF, tick pushes samples) ----------
function renderChart(content, w){
  content.innerHTML='';
  const cvs = document.createElement('canvas'); cvs.className='chart-canvas'; content.appendChild(cvs);
  const ctx = cvs.getContext('2d');
  const buf = w._buf = [];      // [{t,v:[...]}]
  w._cursorX = null;

  cvs.addEventListener('mousemove', e=>{
    const r = cvs.getBoundingClientRect(); const x = (e.clientX - r.left);
    w._cursorX = Math.max(0, Math.min(1, (x-40)/Math.max(1,(cvs.width-50)) ));
  });
  cvs.addEventListener('mouseleave', ()=> w._cursorX=null);
  cvs.addEventListener('contextmenu', e=>{
    e.preventDefault();
    w.opts.readout = (w.opts.readout==='current') ? 'cursor' : 'current';
  });

  // WS tick hook
  w._onTick = ()=>{
    if (w.opts.paused) return;
    const now = performance.now()/1000;
    const vals = w.opts.series.map(s => valueFor(s));
    buf.push({t:now, v:vals});
    const span = w.opts.span || 10;
    while(buf.length && (now - buf[0].t) > span) buf.shift();
  };

  // single RAF per widget
  if (w._raf) cancelAnimationFrame(w._raf);
  const loop = ()=>{
    const W = cvs.width = content.clientWidth|0; const H = cvs.height = content.clientHeight|0;
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle = '#3b425e'; ctx.lineWidth=1; ctx.strokeRect(40,10,W-50,H-30);

    if (buf.length){
      const t0 = buf[0].t, t1 = buf[buf.length-1].t, dt=t1-t0||1;

      // per-series min/max
      const perMin=[], perMax=[];
      for (let si=0; si<w.opts.series.length; si++){
        let mn=Infinity,mx=-Infinity;
        for (const b of buf){ const y=b.v[si]; if(y<mn) mn=y; if(y>mx) mx=y; }
        perMin[si]=mn; perMax[si]=mx;
      }

      // series lines
      w.opts.series.forEach((s,si)=>{
        ctx.beginPath(); ctx.lineWidth=1.5; ctx.strokeStyle = colorFor(si);
        for (let j=0;j<buf.length;j++){
          const b=buf[j];
          const x = 40 + (W-50)*((b.t - t0)/dt);
          const rng=(perMax[si]-perMin[si])||1;
          const y = 10 + (H-40)*(1 - ((b.v[si]-perMin[si])/rng));
          if (j===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
      });

      // cursor + readout
      let readText = '';
      if (w._cursorX != null){
        const cx = 40 + (W-50)*w._cursorX;
        ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(cx,10); ctx.lineTo(cx,H-20); ctx.stroke();
      }
      if (w.opts.readout==='cursor' && w._cursorX!=null){
        const tx = t0 + (t1-t0)*w._cursorX;
        let k=0, best=Infinity;
        for (let i=0;i<buf.length;i++){ const d=Math.abs(buf[i].t - tx); if (d<best){best=d;k=i;} }
        const b = buf[k];
        readText = w.opts.series.map((s,si)=>`${labelOf(s)}:${fmt(b.v[si])}`).join('  ');
      } else {
        const b = buf[buf.length-1];
        readText = w.opts.series.map((s,si)=>`${labelOf(s)}:${fmt(b.v[si])}`).join('  ');
      }
      drawLegend(ctx, w, W, H, readText);
    } else {
      ctx.fillStyle='#9094a1'; ctx.fillText('Waiting for data…', 50, (H/2|0));
    }

    w._raf = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- gauge (one RAF) ----------
function renderGauge(content, w){
  content.innerHTML='';
  const svgNS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('class','gauge'); content.appendChild(svg);

  if (w._raf) cancelAnimationFrame(w._raf);
  const loop=()=>{
    const W=content.clientWidth|0, H=content.clientHeight|0; svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    svg.replaceChildren();
    const cx=W/2, cy=H*0.9, r=Math.min(W,H)*0.8/2;
    const min=w.opts.min||0, max=w.opts.max||10;
    const arc=document.createElementNS(svgNS,'path');
    arc.setAttribute('d',`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`);
    arc.setAttribute('stroke','#3b425e'); arc.setAttribute('fill','none'); arc.setAttribute('stroke-width','8');
    svg.appendChild(arc);

    (w.opts.needles||[]).forEach((s,si)=>{
      const v=valueFor(s); const frac=(v-min)/(max-min); const ang=Math.PI*(1-frac);
      const x=cx + r*Math.cos(ang); const y=cy - r*Math.sin(ang);
      const ln=document.createElementNS(svgNS,'line');
      ln.setAttribute('x1',cx); ln.setAttribute('y1',cy);
      ln.setAttribute('x2',x); ln.setAttribute('y2',y);
      ln.setAttribute('stroke',colorFor(si)); ln.setAttribute('stroke-width','4');
      svg.appendChild(ln);
    });

    w._raf = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- bars (one RAF) ----------
function renderBars(content, w){
  content.innerHTML='';
  const wrap=document.createElement('div'); wrap.className='bars'; content.appendChild(wrap);
  const min=w.opts.min||0,max=w.opts.max||10;
  const bars = (w.opts.series||[]).map((s,si)=>{
    const bar=document.createElement('div'); bar.className='bar';
    const fill=document.createElement('div'); fill.className='fill'; fill.style.background=colorFor(si);
    bar.appendChild(fill); wrap.appendChild(bar);
    return {fill,sel:s};
  });
  if (w._raf) cancelAnimationFrame(w._raf);
  const loop=()=>{
    bars.forEach(b=>{
      const v=valueFor(b.sel); const frac=(v-min)/(max-min);
      b.fill.style.height = `${100*Math.max(0,Math.min(1,frac))}%`;
    });
    w._raf = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- DO button ----------
function renderDOButton(content, w){
  content.innerHTML='';
  const b=document.createElement('button'); b.className='do-btn'; b.textContent=w.opts.title||`DO${w.opts.doIndex|0}`; content.appendChild(b);
  const idx=w.opts.doIndex|0; const activeHigh=!!w.opts.activeHigh;
  const setDO     = (state)=> fetch('/api/do/set',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({index:idx,state,active_high:activeHigh})});
  const buzzStart = ()=> fetch('/api/do/buzz/start',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({index:idx,hz:w.opts.buzzHz||5,active_high:activeHigh})});
  const buzzStop  = ()=> fetch('/api/do/buzz/stop' ,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({index:idx,hz:w.opts.buzzHz||5,active_high:activeHigh})});

  if (w.opts.mode==='momentary'){
    b.onmousedown=()=> setDO(true);
    b.onmouseup  =()=> setDO(false);
    b.onmouseleave=b.onmouseup;
  } else if (w.opts.mode==='buzz'){
    b.onmousedown=()=> buzzStart();
    b.onmouseup  =()=> buzzStop();
    b.onmouseleave=b.onmouseup;
  } else {
    b.onclick=()=> { const newState = !(state.do[idx]|0); setDO(newState); };
  }
}

// ---------- AO slider ----------
function renderAOSlider(content, w){
  content.innerHTML='';
  const wrap = document.createElement('div'); wrap.style='display:flex;gap:8px;align-items:center;height:100%;justify-content:center';
  const lab  = document.createElement('div'); lab.textContent = (w.opts.title||`AO${w.opts.aoIndex|0}`);
  const val  = document.createElement('input'); val.type='range'; val.min=w.opts.min??0; val.max=w.opts.max??10; val.step=w.opts.step??0.01; val.value=state.ao[w.opts.aoIndex|0]||0; val.style='width:70%';
  const out  = document.createElement('input'); out.type='number'; out.step=w.opts.step??0.01; out.value=val.value; out.style='width:90px';
  wrap.appendChild(lab); wrap.appendChild(val); wrap.appendChild(out); content.appendChild(wrap);

  const send = (v)=> fetch('/api/ao/set',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({index:w.opts.aoIndex|0, volts: parseFloat(v)})});
  val.oninput = ()=>{ out.value = val.value; if (w.opts.live) send(val.value); };
  out.oninput = ()=>{ val.value = out.value; if (w.opts.live) send(out.value); };
  val.onchange = ()=> send(val.value);
  out.onchange = ()=> send(out.value);
}

// ---------- PID panel ----------
async function renderPID(content, w){
  content.innerHTML='';
  const data = await fetch('/api/pid', {cache:'no-store'}).then(r=>r.json()).catch(()=>({loops:[]}));
  const loops = data.loops||[]; const i = Math.min(w.opts.loopIndex|0, loops.length-1);
  if (i<0) { content.textContent='No PID loops defined.'; return; }
  const L = loops[i];

  const grid=document.createElement('div'); grid.className='pid-grid'; content.appendChild(grid);
  grid.innerHTML = `
    <label>Name<input id="nm" value="${L.name||''}"></label>
    <label>Target<input id="tgt" type="number" value="${L.target??0}"></label>
    <label>P<input id="kp" type="number" step="0.01" value="${L.kp??0}"></label>
    <label>I<input id="ki" type="number" step="0.01" value="${L.ki??0}"></label>
    <label>D<input id="kd" type="number" step="0.01" value="${L.kd??0}"></label>
    <label>I limit (|abs|)<input id="ilim" type="number" step="0.01" value="${Math.max(Math.abs(L.i_min||0), Math.abs(L.i_max||0))}"></label>
    <label>Err limit (|abs|)<input id="elim" type="number" step="0.01" value="${Math.max(Math.abs(L.err_min||0), Math.abs(L.err_max||0))}"></label>

    <label>Source
      <select id="src">
        <option ${L.src==='ai'?'selected':''} value="ai">AI</option>
        <option ${L.src==='tc'?'selected':''} value="tc">TC</option>
      </select>
    </label>
    <label>Src ch<input id="ai_ch" type="number" min="0" value="${L.ai_ch|0}"></label>

    <label>Output kind
      <select id="kind">
        <option ${L.kind==='analog'?'selected':''} value="analog">AO (analog)</option>
        <option ${L.kind==='digital'?'selected':''} value="digital">DO (digital)</option>
      </select>
    </label>
    <label>Out ch<input id="out_ch" type="number" min="0" value="${L.out_ch|0}"></label>

    <label>AO min<input id="omin" type="number" step="0.01" value="${L.out_min ?? -10}"></label>
    <label>AO max<input id="omax" type="number" step="0.01" value="${L.out_max ??  10}"></label>

    <button id="save">Save</button>
    <button id="enable">${L.enabled? 'Disable':'Enable'}</button>
    <div id="errtxt">Err: 0</div>
  `;
  const $v=id=>grid.querySelector('#'+id);

  $v('kind').onchange=()=>{
    const isAO = $v('kind').value==='analog';
    $v('omin').parentElement.style.display = isAO ? '' : 'none';
    $v('omax').parentElement.style.display = isAO ? '' : 'none';
  };
  $v('kind').dispatchEvent(new Event('change'));

  $v('save').onclick = async ()=>{
    const absI = parseFloat($v('ilim').value||'0');
    const absE = parseFloat($v('elim').value||'0');
    L.name   = $v('nm').value;
    L.target = parseFloat($v('tgt').value||'0');
    L.kp     = parseFloat($v('kp').value||'0');
    L.ki     = parseFloat($v('ki').value||'0');
    L.kd     = parseFloat($v('kd').value||'0');
    L.i_min=-absI; L.i_max=absI; L.err_min=-absE; L.err_max=absE;
    L.src   = $v('src').value;
    L.ai_ch = parseInt($v('ai_ch').value||'0');
    L.kind  = $v('kind').value;
    L.out_ch= parseInt($v('out_ch').value||'0');
    L.out_min = parseFloat($v('omin').value||'-10');
    L.out_max = parseFloat($v('omax').value||'10');
    await fetch('/api/pid',{method:'PUT', headers:{'Content-Type':'application/json'}, cache:'no-store', body: JSON.stringify({loops: loops})});
  };

  $v('enable').onclick = async ()=>{
    L.enabled = !L.enabled;
    await fetch('/api/pid',{method:'PUT', headers:{'Content-Type':'application/json'}, cache:'no-store', body: JSON.stringify({loops: loops})});
    renderPID(content,w);
  };

  const errtxt = grid.querySelector('#errtxt');
  (function update(){
    const tel = window.lastTelemetry||[];
    const rec = tel.find(r=>r.name===L.name);
    if(rec) errtxt.textContent = `Err: ${num(rec.err)}  Out: ${num(rec.out)}`;
    requestAnimationFrame(update);
  })();
}

// ---------- widget config ----------
function openWidgetConfig(page, w, el){
  const m = $('#modal'); m.classList.remove('hidden');
  const card = document.createElement('div'); card.className='card'; m.innerHTML=''; m.appendChild(card);
  const close = ()=>{ m.classList.add('hidden'); m.innerHTML=''; };

  card.innerHTML = `<h3>Configure ${w.type}</h3>`;
  const form=document.createElement('div'); card.appendChild(form);

  if (w.type==='chart' || w.type==='bars' || w.type==='gauge'){
    form.innerHTML = `
      <label>Title <input id="title" value="${w.opts.title||''}"></label>
      <div id="series"></div>
      <button id="addS">+ Add signal</button>
      ${w.type==='chart'? '<label>Span (s) <input id="span" type="number" value="'+(w.opts.span||10)+'"></label>':''}
      ${w.type!=='chart'? '<label>Min <input id="min" type="number" value="'+(w.opts.min||0)+'"></label>':''}
      ${w.type!=='chart'? '<label>Max <input id="max" type="number" value="'+(w.opts.max||10)+'"></label>':''}
    `;
    const S = form.querySelector('#series');
    function drawRows(){
      S.innerHTML='';
      const rows = (w.type==='gauge'? w.opts.needles : w.opts.series);
      rows.forEach((s,i)=>{
        const row=document.createElement('div');
        row.style='display:grid;grid-template-columns: 110px 70px 1fr auto; gap:6px; align-items:center; margin:4px 0;';
        row.innerHTML = `
          <select class="kind">
            <option ${s.kind==='ai'?'selected':''} value="ai">AI</option>
            <option ${s.kind==='ao'?'selected':''} value="ao">AO</option>
            <option ${s.kind==='do'?'selected':''} value="do">DO</option>
            <option ${s.kind==='tc'?'selected':''} value="tc">TC</option>
          </select>
          <input class="index" type="number" min="0" value="${s.index}">
          <input class="name" placeholder="legend (optional)" value="${s.name||''}">
          <button class="del">✕</button>
        `;
        row.querySelector('.del').onclick=()=>{ rows.splice(i,1); drawRows(); };
        ['kind','index','name'].forEach(k=>{
          row.querySelector('.'+k).oninput=(e)=>{ s[k] = (k==='name'||k==='kind')? e.target.value : parseInt(e.target.value||'0'); };
        });
        S.appendChild(row);
      });
    }
    drawRows();
    form.querySelector('#addS').onclick=()=>{ (w.type==='gauge'? w.opts.needles : w.opts.series).push(sel('ai',0)); drawRows(); };
    const title=form.querySelector('#title'); title.oninput=()=>{ w.opts.title=title.value; el.querySelector('.title').textContent = w.opts.title||w.type; };
    const span=form.querySelector('#span'); if(span) span.oninput=()=>{ w.opts.span=parseFloat(span.value||'10'); };
    const min=form.querySelector('#min'); if(min) min.oninput=()=>{ w.opts.min=parseFloat(min.value||'0'); };
    const max=form.querySelector('#max'); if(max) max.oninput=()=>{ w.opts.max=parseFloat(max.value||'10'); };
  }
  else if (w.type==='dobutton'){
    form.innerHTML = `
      <label>Title <input id="title" value="${w.opts.title||''}"></label>
      <label>DO Index <input id="idx" type="number" min="0" max="7" value="${w.opts.doIndex|0}"></label>
      <label><input id="ah" type="checkbox" ${w.opts.activeHigh? 'checked':''}> Active High</label>
      <label>Mode
        <select id="mode">
          <option ${w.opts.mode==='momentary'? 'selected':''} value="momentary">Momentary</option>
          <option ${w.opts.mode==='toggle'? 'selected':''} value="toggle">Toggle</option>
          <option ${w.opts.mode==='buzz'? 'selected':''} value="buzz">Buzz (while held)</option>
        </select>
      </label>
      <label>Buzz Hz <input id="bhz" type="number" value="${w.opts.buzzHz||5}"></label>
    `;
    form.querySelector('#title').oninput=(e)=>{ w.opts.title=e.target.value; el.querySelector('.title').textContent=w.opts.title||w.type; };
    form.querySelector('#idx').oninput  =(e)=> w.opts.doIndex=parseInt(e.target.value||'0');
    form.querySelector('#ah').onchange  =(e)=> w.opts.activeHigh=e.target.checked;
    form.querySelector('#mode').onchange=(e)=> w.opts.mode=e.target.value;
    form.querySelector('#bhz').oninput  =(e)=> w.opts.buzzHz=parseFloat(e.target.value||'5');
  }
  else if (w.type==='pidpanel'){
    form.innerHTML = `<label>Loop Index <input id="idx" type="number" min="0" value="${w.opts.loopIndex|0}"></label>`;
    form.querySelector('#idx').oninput=(e)=> w.opts.loopIndex=parseInt(e.target.value||'0');
  }
  else if (w.type==='aoslider'){
    form.innerHTML = `
      <label>Title <input id="title" value="${w.opts.title||''}"></label>
      <label>AO Index <input id="idx" type="number" min="0" max="1" value="${w.opts.aoIndex|0}"></label>
      <label>Min <input id="mn" type="number" value="${w.opts.min??0}"></label>
      <label>Max <input id="mx" type="number" value="${w.opts.max??10}"></label>
      <label>Step <input id="st" type="number" step="0.001" value="${w.opts.step??0.01}"></label>
      <label><input id="live" type="checkbox" ${w.opts.live?'checked':''}> Live update</label>
    `;
    form.querySelector('#title').oninput=(e)=>{ w.opts.title=e.target.value; el.querySelector('.title').textContent=w.opts.title||w.type; };
    form.querySelector('#idx').oninput  =(e)=> w.opts.aoIndex=parseInt(e.target.value||'0');
    form.querySelector('#mn').oninput   =(e)=> w.opts.min=parseFloat(e.target.value||'0');
    form.querySelector('#mx').oninput   =(e)=> w.opts.max=parseFloat(e.target.value||'10');
    form.querySelector('#st').oninput   =(e)=> w.opts.step=parseFloat(e.target.value||'0.01');
    form.querySelector('#live').onchange=(e)=> w.opts.live=e.target.checked;
  }

  const actions=document.createElement('div'); actions.style="margin-top:8px; display:flex; gap:8px; justify-content:flex-end";
  const ok=document.createElement('button'); ok.textContent='Close'; ok.onclick=close;
  actions.appendChild(ok); card.appendChild(actions);
}

// ---------- helpers ----------
function colorFor(i){ return `hsl(${(i*70)%360} 70% 60%)`; }
function labelOf(s){ return s.name || `${s.kind}${s.index}`; }
function fmt(v){ return (v==null||Number.isNaN(v))? '—' : (Math.abs(v)<1000? v.toFixed(3) : v.toExponential(2)); }
function num(v){ return (v==null||Number.isNaN(v))? '—' : (Math.abs(v)<1000? +v.toFixed(3) : v.toExponential(2)); }

function drawLegend(ctx, w, W, H, text){
  const baseY = H-10;
  let x = 44;
  w.opts.series.forEach((s,si)=>{
    ctx.fillStyle = colorFor(si); ctx.fillRect(x, baseY-8, 10, 10);
    ctx.fillStyle = '#e6e6e6';
    ctx.fillText(` ${labelOf(s)}`, x+12, baseY);
    x += 12 + ctx.measureText(` ${labelOf(s)}`).width + 16;
  });
  ctx.fillStyle = '#e6e6e6';
  const tw = ctx.measureText(text).width;
  ctx.fillText(text, Math.max(42, W-50 - tw), baseY);
}

// ---------- JSON editor ----------
async function openJsonEditor(title, url){
  const data = await fetch(url, {cache:'no-store'}).then(r=>r.json());
  const m = $('#modal'); m.classList.remove('hidden');
  const card = document.createElement('div'); card.className='card'; m.innerHTML=''; m.appendChild(card);
  card.innerHTML = `<h3>${title}</h3>`;
  const ta=document.createElement('textarea'); ta.style.width='100%'; ta.style.height='60vh'; ta.value = JSON.stringify(data, null, 2);
  const row=document.createElement('div'); row.style='display:flex; gap:8px; justify-content:flex-end; margin-top:8px;';
  const save=document.createElement('button'); save.textContent='Save';
  const cancel=document.createElement('button'); cancel.textContent='Close';
  cancel.onclick = ()=>{ m.classList.add('hidden'); m.innerHTML=''; };
  save.onclick = async ()=>{
    try{
      const body = JSON.parse(ta.value);
      await fetch(url,{method:'PUT', headers:{'Content-Type':'application/json'}, cache:'no-store', body: JSON.stringify(body)});
      cancel.onclick();
    }catch(e){ alert('Invalid JSON: '+e.message); }
  };
  row.appendChild(save); row.appendChild(cancel);
  card.appendChild(ta); card.appendChild(row);
}

// ---------- logs ----------
async function openRecall(){
  const list = await fetch('/api/logs', {cache:'no-store'}).then(r=>r.json());
  const m = $('#modal'); m.classList.remove('hidden');
  const card = document.createElement('div'); card.className='card'; m.innerHTML=''; m.appendChild(card);
  card.innerHTML = `<h3>Logs</h3>`;
  const ul=document.createElement('ul');
  list.forEach(s=>{ const li=document.createElement('li'); li.innerHTML=`<a href="/api/logs/${s}/csv">${s}</a>`; ul.appendChild(li); });
  const close=document.createElement('button'); close.textContent='Close'; close.onclick=()=>{ m.classList.add('hidden'); m.innerHTML=''; };
  card.appendChild(ul); card.appendChild(close);
}

// ---------- layout ----------
function saveLayout(){
  const blob = new Blob([JSON.stringify({version:UI_VERSION, pages: state.pages}, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `layout_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function loadLayout(){
  const inp = document.createElement('input'); inp.type='file'; inp.accept='application/json';
  inp.onchange = ()=>{
    const f = inp.files?.[0]; if(!f) return;
    const rd = new FileReader();
    rd.onload = ()=>{
      try{
        const obj = JSON.parse(rd.result);
        if (!obj.pages || !Array.isArray(obj.pages)) throw new Error('Invalid layout file');
        state.pages = obj.pages;
        refreshPages(); setActivePage(0);
      }catch(e){ alert('Load failed: '+e.message); }
    };
    rd.readAsText(f);
  };
  inp.click();
}
