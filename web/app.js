// app.js — UI v0.6.3
const UI_VERSION = "0.6.3";
let hwReady = false;
let configCache = null;

const $ = sel => document.querySelector(sel);
const el = (tag, props={}, children=[]) => {
  const n = Object.assign(document.createElement(tag), props||{});
  if (props && props.className===undefined && props.class) n.className = props.class;
  if (!Array.isArray(children)) children = [children];
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(c));
  return n;
};
function colorFor(i){ const p=['#7aa2f7','#9ece6a','#f7768e','#bb9af7','#e0af68','#73daca','#f4b8e4','#ffd479']; return p[i%p.length]; }
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

let ws=null, sessionDir='', connected=false;
const state={ pages:[], ai:Array(8).fill(0), ao:Array(2).fill(0), do:Array(8).fill(0), tc:[], pid:[] };

window.addEventListener('DOMContentLoaded',()=>{ wireUI(); ensureStarterPage(); showVersions(); loadConfigCache(); connect(); });

function wireUI(){
  $('#connectBtn')?.addEventListener('click', connect);
  $('#setRate')?.addEventListener('click', setRate);
  $('#editConfig')?.addEventListener('click', ()=>openConfigForm());
  $('#editPID')?.addEventListener('click', ()=>openPidForm());
  $('#editScript')?.addEventListener('click', ()=>openScriptEditor());
  $('#saveLayout')?.addEventListener('click', saveLayoutToFile);
  $('#loadLayout')?.addEventListener('click', loadLayoutFromFile);
  $('#addPage')?.addEventListener('click', addPage);
  $('#delPage')?.addEventListener('click', removeActivePage);
  document.querySelectorAll('[data-add]').forEach(btn=>btn.addEventListener('click',()=>addWidget(btn.dataset.add)));
}

async function showVersions(){
  const versions=[`UI ${UI_VERSION}`];
  try{ const r=await fetch('/api/diag'); if(r.ok){ const d=await r.json();
    if(d.server) versions.push(`Server ${d.server}`);
    if(d.bridge) versions.push(`Bridge ${d.bridge}`);
    if(typeof d.have_mcculw!=='undefined') hwReady=!!d.have_mcculw;
  }}catch{}
  $('#versions').textContent=versions.join(' • ');
}

async function loadConfigCache(){
  try { const r=await fetch('/api/config'); if (r.ok) configCache = await r.json(); } catch (_e) {}
}

async function setRate(){
  const hz=parseFloat($('#rate').value)||0;
  if(hz>=1){ try{ await fetch('/api/acq/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hz})}); }catch(e){ alert('Set rate failed: '+e.message);}}
}

function connect(){
  if(ws) try{ws.close();}catch{}
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  ws.onopen=()=>{ connected=true; updateDOButtons(); };
  ws.onclose=()=>{ connected=false; updateDOButtons(); };
  ws.onmessage=(ev)=>{
    const msg=JSON.parse(ev.data);
    if(msg.type==='session'){ sessionDir=msg.dir; $('#session').textContent=sessionDir; }
    if(msg.type==='tick'){ state.ai=msg.ai||state.ai; state.ao=msg.ao||state.ao; state.do=msg.do||state.do; state.tc=msg.tc||state.tc; state.pid=msg.pid||state.pid; onTick(); }
  };
}

let activePageIndex=0;
function ensureStarterPage(){ if(!state.pages.length){ state.pages=[{id:crypto.randomUUID(),name:'Page 1',widgets:[]}]; } refreshPages(); setActivePage(0); }
function refreshPages(){ const cont=$('#pages'); cont.innerHTML=''; state.pages.forEach((p,idx)=>{ const b=el('button',{className:'btn',onclick:()=>setActivePage(idx)}, p.name||('Page '+(idx+1))); if(idx===activePageIndex) b.classList.add('active'); cont.append(b); }); }
function setActivePage(idx){ activePageIndex=clamp(idx,0,state.pages.length-1); refreshPages(); renderPage(); }
function addPage(){ state.pages.push({id:crypto.randomUUID(),name:`Page ${state.pages.length+1}`,widgets:[]}); setActivePage(state.pages.length-1); }
function removeActivePage(){ if(state.pages.length<=1){ alert('At least one page is required.'); return; } state.pages.splice(activePageIndex,1); setActivePage(Math.max(0,activePageIndex-1)); }

function addWidget(type){ const w={id:crypto.randomUUID(), type, x:40, y:40, w:460, h:280, opts:defaultsFor(type)}; state.pages[activePageIndex].widgets.push(w); renderPage(); }
function defaultsFor(type){
  switch(type){
    case 'chart': return { title:'Chart', series:[], span:10, paused:false, scale:'auto', min:0, max:10, filterHz:0 };
    case 'gauge': return { title:'Gauge', needles:[], scale:'manual', min:0, max:10 };
    case 'bars':  return { title:'Bars', series:[], scale:'manual', min:0, max:10 };
    case 'dobutton': return { title:'DO', doIndex:0, activeHigh:true, mode:'toggle', buzzHz:2 };
    case 'pidpanel': return { title:'PID', loopIndex:0, showControls:true };
    case 'aoslider': return { title:'AO', aoIndex:0, min:0, max:10, step:0.0025, live:true };
  } return {};
}
function renderPage(){
  const cv=$('#canvas'); cv.innerHTML='';
  const page=state.pages[activePageIndex];
  for(const w of page.widgets){
    const node=renderWidget(w);
    node.style.left=(w.x||0)+'px'; node.style.top=(w.y||0)+'px';
    node.style.width=(w.w||300)+'px'; node.style.height=(w.h||200)+'px';
    cv.append(node);
    makeDragResize(node,w, node.querySelector('header'), node.querySelector('.resize'));
  } updateDOButtons();
}
function renderWidget(w){
  const box=el('div',{className:'widget',id:'w_'+w.id});
  const tools=el('div',{className:'tools'},[
    el('span',{className:'icon',title:'Settings',onclick:()=>openWidgetSettings(w)},'⚙'),
    el('span',{className:'icon',title:'Close',onclick:()=>removeWidget(w.id)},'×')
  ]);
  const header=el('header',{},[ el('span',{className:'title'}, w.opts.title||w.type), el('div',{className:'spacer'}), el('div',{className:'opts'}, widgetOptions(w)), tools ]);
  const body=el('div',{className:'body'});
  const rez=el('div',{className:'resize'});
  box.append(header,body,rez);
  switch(w.type){
    case 'chart': mountChart(w,body); break;
    case 'gauge': mountGauge(w,body); break;
    case 'bars':  mountBars(w,body); break;
    case 'dobutton': mountDOButton(w,body); break;
    case 'pidpanel': mountPIDPanel(w,body); break;
    case 'aoslider': mountAOSlider(w,body); break;
  }
  return box;
}
function removeWidget(id){
  const page=state.pages[activePageIndex];
  const idx=page.widgets.findIndex(x=>x.id===id);
  if(idx>=0){ page.widgets.splice(idx,1); renderPage(); }
}
function widgetOptions(w){
  const opts=[];
  if (w.type==='chart'||w.type==='gauge'||w.type==='bars'){
    const sel=el('select',{value:w.opts.scale},[el('option',{value:'auto'},'Auto'), el('option',{value:'manual'},'Manual')]);
    sel.onchange=e=>{ w.opts.scale=e.target.value; };
    const min=el('input',{type:'number',value:w.opts.min,step:'any',style:'width:90px'}),
          max=el('input',{type:'number',value:w.opts.max,step:'any',style:'width:90px'});
    const sync=()=>{ w.opts.min=parseFloat(min.value)||0; w.opts.max=parseFloat(max.value)||0; };
    min.oninput=sync; max.oninput=sync;
    opts.push(el('span',{},'Scale:'), sel, el('span',{},'Min:'), min, el('span',{},'Max:'), max);
  }
  if (w.type==='chart'){
    const span=el('input',{type:'number',value:w.opts.span,min:1,step:1,style:'width:70px'}); span.oninput=()=>{ w.opts.span=parseFloat(span.value)||10; };
    const filt=el('input',{type:'number',value:w.opts.filterHz||0,min:0,step:'any',style:'width:80px'}); filt.oninput=()=>{ w.opts.filterHz=parseFloat(filt.value)||0; };
    const pause=el('button',{className:'btn',onclick:()=>{ w.opts.paused=!w.opts.paused; pause.textContent=w.opts.paused?'Resume':'Pause'; }}, w.opts.paused?'Resume':'Pause');
    opts.push(el('span',{},'Span[s]:'), span, el('span',{},'Filter[Hz]:'), filt, pause);
  }
  return opts;
}

// chart
const chartBuffers=new Map();
const chartFilters=new Map(); // per widget: { _t, si -> y }
function mountChart(w, body){
  const legend=el('div',{className:'legend'}); body.append(legend);
  const canvas=el('canvas'); body.append(canvas); const ctx=canvas.getContext('2d');
  function draw(){
    if (w.opts.paused){ requestAnimationFrame(draw); return; }
    const buf=chartBuffers.get(w.id)||[]; const W=canvas.clientWidth,H=canvas.clientHeight; canvas.width=W; canvas.height=H;
    ctx.clearRect(0,0,W,H); ctx.strokeStyle='#3b425e'; ctx.lineWidth=1; ctx.strokeRect(40,10,W-50,H-30);
    if(buf.length){
      const t0=buf[0].t,t1=buf[buf.length-1].t,dt=Math.max(1e-6,t1-t0);
      let ymin=Infinity,ymax=-Infinity; for(let si=0;si<w.opts.series.length;si++){ for(const b of buf){ const y=b.v[si]; if(y<ymin) ymin=y; if(y>ymax) ymax=y; } }
      if (w.opts.scale==='manual'){ ymin=w.opts.min; ymax=w.opts.max; }
      if(!(isFinite(ymin)&&isFinite(ymax))||ymin===ymax){ ymin-=1; ymax+=1; }
      const yscale=(H-40)/(ymax-ymin), xscale=(W-60)/dt;
      legend.innerHTML='';
      w.opts.series.forEach((s,si)=>{
        ctx.beginPath(); ctx.lineWidth=1.5; ctx.strokeStyle=colorFor(si);
        let first=true; for(const b of buf){ const x=40+(b.t-t0)*xscale, y=H-30-(b.v[si]-ymin)*yscale; if(first){ctx.moveTo(x,y); first=false;} else ctx.lineTo(x,y); } ctx.stroke();
        const lab = s.name && s.name.length ? s.name : labelFor(s);
        legend.append(el('div',{className:'item'},[el('span',{className:'swatch', style:`background:${colorFor(si)}`},''), lab]));
      });
    } requestAnimationFrame(draw);
  } draw();
}
function updateChartBuffers(){
  for (const p of state.pages){
    for (const w of p.widgets){
      if (w.type!=='chart') continue;
      const buf=chartBuffers.get(w.id)||[]; const t=performance.now()/1000;
      const raw=(w.opts.series||[]).map(sel=>readSelection(sel));
      let filtered=raw;
      const fc = w.opts.filterHz||0;
      if (fc>0){
        const RC = 1/(2*Math.PI*fc);
        const cf = chartFilters.get(w.id) || { _t: t };
        const dt = Math.max(1e-6, t - (cf._t||t));
        const alpha = dt/(RC+dt);
        filtered = raw.map((v,si)=>{
          const prev = (cf[si]===undefined)? v : cf[si];
          const y = prev + alpha*(v - prev);
          cf[si]=y; return y;
        });
        cf._t = t;
        chartFilters.set(w.id, cf);
      }
      buf.push({t, v: filtered});
      const span=Math.max(1,w.opts.span||10);
      while(buf.length&&(t-buf[0].t)>span) buf.shift();
      chartBuffers.set(w.id,buf);
    }
  }
}

function labelFor(sel){
  if (!configCache) return `${sel.kind.toUpperCase()}${sel.index}`;
  try{
    if(sel.kind==='ai'){ return configCache.analogs?.[sel.index]?.name || `AI${sel.index}`; }
    if(sel.kind==='ao'){ return configCache.analogOutputs?.[sel.index]?.name || `AO${sel.index}`; }
    if(sel.kind==='do'){ return configCache.digitalOutputs?.[sel.index]?.name || `DO${sel.index}`; }
    if(sel.kind==='tc'){ return configCache.thermocouples?.[sel.index]?.name || `TC${sel.index}`; }
  }catch(_e){}
  return `${sel.kind.toUpperCase()}${sel.index}`;
}

// gauge
function mountGauge(w, body){
  const legend=el('div',{className:'legend'}); body.append(legend);
  const canvas=el('canvas'); body.append(canvas); const ctx=canvas.getContext('2d');
  function draw(){
    const W=canvas.clientWidth,H=canvas.clientHeight; canvas.width=W; canvas.height=H; ctx.clearRect(0,0,W,H);
    const cx=W/2,cy=H*0.7,r=Math.min(W,H)*0.45,start=Math.PI,end=0;
    let lo=w.opts.min, hi=w.opts.max;
    if (w.opts.scale==='auto'){ const vals=(w.opts.needles||[]).map(sel=>readSelection(sel)); lo=Math.min(...vals,0); hi=Math.max(...vals,1); if(lo===hi){lo-=1;hi+=1;} }
    // arc + ticks (drawn on TOP semicircle)
    ctx.strokeStyle='#3b425e'; ctx.lineWidth=10; ctx.beginPath(); ctx.arc(cx,cy,r,start,end); ctx.stroke();
    ctx.fillStyle='#a8b3cf'; ctx.font='12px system-ui';
    for(let t=0;t<=5;t++){
      const frac=t/5, ang=Math.PI - frac*Math.PI;
      const x1=cx+Math.cos(ang)*(r-8), y1=cy- Math.sin(ang)*(r-8);
      const x2=cx+Math.cos(ang)*(r+2), y2=cy- Math.sin(ang)*(r+2);
      ctx.strokeStyle='#3b425e'; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      const val=(lo+frac*(hi-lo)).toFixed(2);
      ctx.fillText(val, cx+Math.cos(ang)*(r-30)-12, cy- Math.sin(ang)*(r-30)+4);
    }
    legend.innerHTML='';
    (w.opts.needles||[]).forEach((s,si)=>{
      const v=readSelection(s), frac=clamp((v-lo)/(hi-lo),0,1), ang=Math.PI-frac*Math.PI;
      ctx.strokeStyle=colorFor(si); ctx.lineWidth=3; ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.lineTo(cx+Math.cos(ang)*(r-18), cy- Math.sin(ang)*(r-18)); // NOTE the minus to draw upward
      ctx.stroke();
      const lab = s.name && s.name.length ? s.name : labelFor(s);
      legend.append(el('div',{className:'item'},[el('span',{className:'swatch', style:`background:${colorFor(si)}`},''), `${lab}: ${v.toFixed(3)}`]));
    });
    requestAnimationFrame(draw);
  } draw();
}

// bars
function mountBars(w, body){
  const canvas=el('canvas'); body.append(canvas); const ctx=canvas.getContext('2d');
  function draw(){
    const W=canvas.clientWidth,H=canvas.clientHeight; canvas.width=W; canvas.height=H; ctx.clearRect(0,0,W,H);
    const N=Math.max(1,(w.opts.series||[]).length), barW=Math.max(10,(W-40)/N-10);
    let lo=w.opts.min, hi=w.opts.max;
    if (w.opts.scale==='auto'){ const vals=(w.opts.series||[]).map(sel=>readSelection(sel)); lo=Math.min(...vals,0); hi=Math.max(...vals,1); if(lo===hi){lo-=1;hi+=1;} }
    ctx.strokeStyle='#3b425e'; ctx.lineWidth=1; ctx.strokeRect(30,10,W-50,H-30);
    (w.opts.series||[]).forEach((s,si)=>{
      const v=readSelection(s), frac=clamp((v-lo)/(hi-lo),0,1), x=30+si*(barW+10)+10, y=H-30-frac*(H-40);
      ctx.fillStyle=colorFor(si); ctx.fillRect(x,y,barW,(H-30)-y);
      const lab = s.name && s.name.length ? s.name : labelFor(s);
      ctx.fillStyle='#a8b3cf'; ctx.font='12px system-ui'; ctx.fillText(lab, x, H-12);
    });
    requestAnimationFrame(draw);
  } draw();
}

// DO
function logicalActive(bit,activeHigh){ return activeHigh ? !!bit : !bit; }
function mountDOButton(w, body){
  const b=el('button',{className:'do-btn default'}, w.opts.title||'DO');
  body.append(b);

  const startBuzz = async()=>{
    try{ await fetch('/api/do/buzz/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.doIndex,hz:w.opts.buzzHz||2,active_high:w.opts.activeHigh})}); b.dataset.buzz='1'; }catch(e){ console.warn('Buzz start failed', e); }
  };
  const stopBuzz = async()=>{
    try{ await fetch('/api/do/buzz/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.doIndex})}); b.dataset.buzz='0'; }catch(e){ console.warn('Buzz stop failed', e); }
  };

  const setMomentary = async(stateBit)=>{
    try{ await fetch('/api/do/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.doIndex,state:!!stateBit,active_high:!!w.opts.activeHigh})}); }catch(e){ console.warn('DO set failed', e); }
  };

  // Toggle clicks only affect 'toggle' mode; buzz uses press+release
  b.addEventListener('click', ()=>{
    if(!connected) return;
    if(w.opts.mode==='toggle'){
      const bit=state.do[w.opts.doIndex]|0; const want=!bit;
      fetch('/api/do/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.doIndex,state:!!want,active_high:!!w.opts.activeHigh})}).catch(()=>{});
    }
  });

  const down = ()=>{
    if(!connected) return;
    if(w.opts.mode==='momentary'){ setMomentary(true); }
    if(w.opts.mode==='buzz'){ startBuzz(); }
  };
  const up = ()=>{
    if(!connected) return;
    if(w.opts.mode==='momentary'){ setMomentary(false); }
    if(w.opts.mode==='buzz'){ stopBuzz(); }
  };

  b.addEventListener('mousedown', down);
  b.addEventListener('mouseup', up);
  window.addEventListener('mouseup', up);
  b.addEventListener('mouseleave', up);
  b.addEventListener('touchstart', (e)=>{ e.preventDefault(); down(); }, {passive:false});
  b.addEventListener('touchend', (e)=>{ e.preventDefault(); up(); }, {passive:false});

  updateDOButtons();
}
function updateDOButtons(){
  document.querySelectorAll('.do-btn').forEach(b=>{
    if(!connected||!hwReady){ b.className='do-btn default'; return; }
    const id=b.closest('.widget').id.slice(2); const page=state.pages[activePageIndex]; const w=page.widgets.find(x=>x.id===id);
    if(!w){ b.className='do-btn default'; return; }
    const bit=state.do[w.opts.doIndex]|0; const active=logicalActive(bit,!!w.opts.activeHigh); b.className='do-btn '+(active?'active':'inactive');
    // Also reflect current title
    b.textContent = w.opts.title || 'DO';
  });
}

// PID
function mountPIDPanel(w, body){
  const line=el('div',{className:'small', id:'pid_'+w.id}, 'pv=—, err=—, out=—');
  body.append(line);

  if (w.opts.showControls){
    const ctr=el('div',{className:'compact'});
    const tbl=el('table',{className:'form'}); const tb=el('tbody');
    const row = (label, input)=>{ const tr=el('tr'); tr.append(el('th',{},label), el('td',{},input)); tb.append(tr); };
    const L = {enabled: false,name:'',kind:'analog',src:'ai',ai_ch:0,out_ch:0,target:0,kp:0,ki:0,kd:0,out_min:0,out_max:1,err_min:-1,err_max:1,i_min:-1,i_max:1};
    // Load current loop from server
    fetch('/api/pid').then(r=>r.json()).then(pid=>{
      const idx=w.opts.loopIndex|0; Object.assign(L, pid.loops?.[idx]||{});
      const selKind=selectEnum(['analog','digital','tc','calc'], L.kind||'analog', v=>L.kind=v);
      const selSrc=selectEnum(['ai','tc','calc'], L.src||'ai', v=>L.src=v);
      row('enabled', chk(L,'enabled'));
      row('name', txt(L,'name'));
      row('kind', selKind);
      row('src', selSrc);
      row('ai_ch', num(L,'ai_ch',1));
      row('out_ch', num(L,'out_ch',1));
      row('target', num(L,'target',0.0001));
      row('kp', num(L,'kp',0.0001));
      row('ki', num(L,'ki',0.0001));
      row('kd', num(L,'kd',0.0001));
      row('out_min', num(L,'out_min',0.0001));
      row('out_max', num(L,'out_max',0.0001));
      row('err_min', num(L,'err_min',0.0001));
      row('err_max', num(L,'err_max',0.0001));
      row('i_min', num(L,'i_min',0.0001));
      row('i_max', num(L,'i_max',0.0001));
      tbl.append(tb);
      const save=el('button',{className:'btn',onclick:async()=>{ const pid2=await (await fetch('/api/pid')).json(); pid2.loops = pid2.loops||[]; pid2.loops[w.opts.loopIndex|0] = L; await fetch('/api/pid',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(pid2)}); }}, 'Apply');
      ctr.append(tbl, el('div',{style:'margin-top:6px'}, save));
    });
    body.append(ctr);
  }

  (function update(){ const loop=state.pid[w.opts.loopIndex]||null; const p=$('#pid_'+w.id); if(loop&&p){ p.textContent=`pv=${(loop.pv??0).toFixed(3)}, err=${(loop.err??0).toFixed(3)}, out=${(loop.out??0).toFixed(3)}`; } requestAnimationFrame(update); })();
}
function selectEnum(options, value, onChange){
  const s=el('select',{}); options.forEach(opt=>s.append(el('option',{value:opt},opt))); s.value=value; s.onchange=()=>onChange(s.value); return s;
}
function txt(o,k){ const i=el('input',{type:'text',value:o[k]??''}); i.oninput=()=>o[k]=i.value; return i; }
function num(o,k,step){ const i=el('input',{type:'number',step:step??'any',value:o[k]??0}); i.oninput=()=>o[k]=parseFloat(i.value)||0; return i; }
function chk(o,k){ const i=el('input',{type:'checkbox',checked:!!o[k]}); i.onchange=()=>o[k]=!!i.checked; return i; }

// AO slider
function mountAOSlider(w, body){
  const step=w.opts.step ?? 0.0025;
  const cur=el('input',{type:'number', min:w.opts.min, max:w.opts.max, step:step, value:state.ao[w.opts.aoIndex]||0, style:'width:90px'});
  const rng=el('input',{type:'range', min:w.opts.min, max:w.opts.max, step:step, value:state.ao[w.opts.aoIndex]||0, style:'width:100%'});
  const send=async(v)=>{ try{ await fetch('/api/ao/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.aoIndex, volts:parseFloat(v)})}); }catch(e){ console.warn('AO set failed', e); } };
  rng.oninput=()=>{ cur.value=rng.value; if (w.opts.live) send(rng.value); };
  cur.onchange=()=>{ rng.value=cur.value; send(cur.value); };
  body.append(el('div',{className:'row'},[rng,cur]));
}

// tick + helpers
function onTick(){ updateChartBuffers(); updateDOButtons(); }
function readSelection(sel){ if(!sel) return 0;
  switch(sel.kind){ case 'ai': return state.ai[sel.index|0]??0; case 'ao': return state.ao[sel.index|0]??0; case 'do': return (state.do[sel.index|0]?1:0); case 'tc': return state.tc[sel.index|0]??0; }
  return 0;
}

// drag/resize — block drag when interacting with inputs
function makeDragResize(node,w, header, handle){
  let dragging=false,resizing=false,sx=0,sy=0,ox=0,oy=0,ow=0,oh=0;
  header.addEventListener('mousedown', (e)=>{
    const tag=(e.target.tagName||'').toUpperCase();
    if (['INPUT','SELECT','BUTTON','TEXTAREA','LABEL','OPTION','SPAN'].includes(tag)) return;
    dragging=true; ox=w.x; oy=w.y; sx=e.clientX; sy=e.clientY; e.preventDefault();
  });
  handle.addEventListener('mousedown', (e)=>{ resizing=true; ow=w.w; oh=w.h; sx=e.clientX; sy=e.clientY; e.preventDefault(); });
  window.addEventListener('mousemove',(e)=>{
    if(dragging){ w.x=ox+(e.clientX-sx); w.y=oy+(e.clientY-sy); node.style.left=w.x+'px'; node.style.top=w.y+'px'; }
    if(resizing){ w.w=Math.max(280,ow+(e.clientX-sx)); w.h=Math.max(180,oh+(e.clientY-sy)); node.style.width=w.w+'px'; node.style.height=w.h+'px'; }
  });
  window.addEventListener('mouseup',()=>{ dragging=false; resizing=false; });
}

// modal/editors
function showModal(content, onClose){
  const m=$('#modal'); m.classList.remove('hidden'); m.innerHTML='';
  const panel=el('div',{className:'panel'});
  const closeBtn=el('button',{className:'btn',onclick:()=>{ m.classList.add('hidden'); if (typeof onClose==='function') onClose(); }},'Close');
  const close=el('div',{style:'text-align:right;margin-bottom:8px;'}, closeBtn);
  panel.append(close,content); m.append(panel);
}
function openJsonEditor(title,url){
  fetch(url).then(r=>r.json()).then(obj=>{
    const ta=el('textarea',{style:'width:100%;height:60vh'}, JSON.stringify(obj,null,2));
    const save=el('button',{className:'btn',onclick:async()=>{
      try{ await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:ta.value}); alert('Saved'); }
      catch(e){ alert('Save failed: '+e.message);} }},'Save');
    showModal(el('div',{},[el('h2',{},title), ta, el('div',{style:'margin-top:8px'},save)]), ()=>{ renderPage(); });
  }).catch(_e=>{
    // Fallback editor if /api/script not present
    const ta=el('textarea',{style:'width:100%;height:60vh'}, '// Paste your script JSON here');
    const save=el('button',{className:'btn',onclick:()=>alert('No /api/script endpoint; server needs implementing.')},'Save');
    showModal(el('div',{},[el('h2',{},title), ta, el('div',{style:'margin-top:8px'},save)]));
  });
}
function openScriptEditor(){ openJsonEditor('Script','/api/script'); }

// structured forms
async function openConfigForm(){
  const cfg=await (await fetch('/api/config')).json();
  configCache = cfg; // refresh cache so labels pick up
  const root=el('div',{});

  const boards=fieldset('Boards', tableForm([
    ['E-1608 boardNum', inputNum(cfg.board1608,'boardNum',0)],
    ['E-1608 sampleRateHz', inputNum(cfg.board1608,'sampleRateHz',1)],
    ['E-1608 blockSize', inputNum(cfg.board1608,'blockSize',1)],
    ['E-TC boardNum', inputNum(cfg.boardetc,'boardNum',0)],
    ['E-TC sampleRateHz', inputNum(cfg.boardetc,'sampleRateHz',1)],
    ['E-TC blockSize', inputNum(cfg.boardetc,'blockSize',1)]
  ]));

  const analogRows=(cfg.analogs||[]).map((a,i)=>[
    `AI${i} name`,inputText(a,'name'),
    `slope`,inputNum(a,'slope',0.000001),
    `offset`,inputNum(a,'offset',0.000001),
    `cutoffHz`,inputNum(a,'cutoffHz',0.1),
    `units`,inputText(a,'units'),
    `include`,inputChk(a,'include')
  ]);
  const analogs=fieldset('Analogs (server scales Y = m·X + b)', tableFormRows(analogRows));

  // Normalize legacy momentary->mode
  (cfg.digitalOutputs||[]).forEach(d=>{
    if (!d.mode){
      d.mode = d.momentary ? 'momentary' : 'toggle';
    }
  });
  const DO_MODES=['toggle','momentary','buzz'];
  const doRows=(cfg.digitalOutputs||[]).map((d,i)=>[
    `DO${i} name`,inputText(d,'name'),
    `mode`,selectEnum(DO_MODES,d.mode||'toggle',v=>{ d.mode=v; d.momentary = (v==='momentary'); }),
    `normallyOpen`,inputChk(d,'normallyOpen'),
    `actuationTime`,inputNum(d,'actuationTime',0.1),
    `include`,inputChk(d,'include')
  ]);
  const dig=fieldset('Digital Outputs', tableFormRows(doRows));

  const aoRows=(cfg.analogOutputs||[]).map((a,i)=>[
    `AO${i} name`,inputText(a,'name'),
    `minV`,inputNum(a,'minV',0.001),
    `maxV`,inputNum(a,'maxV',0.001),
    `startupV`,inputNum(a,'startupV',0.001),
    `include`,inputChk(a,'include')
  ]);
  const aos=fieldset('Analog Outputs (0–10 V)', tableFormRows(aoRows));

  const tcRows=(cfg.thermocouples||[]).map((t,i)=>[
    `TC${i} include`,inputChk(t,'include'),
    `ch`,inputNum(t,'ch',1),
    `name`,inputText(t,'name'),
    `type`,selectEnum(['K','J','T','E','R','S','B','N','C'], t.type||'K', v=>t.type=v),
    `offset`,inputNum(t,'offset',0.001)
  ]);
  const tcs=fieldset('Thermocouples', tableFormRows(tcRows));

  const save=el('button',{className:'btn',onclick:async()=>{
    try{ await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); alert('Saved'); }
    catch(e){ alert('Save failed: '+e.message); }
  }},'Save');

  showModal(el('div',{},[boards,analogs,dig,aos,tcs, el('div',{style:'margin-top:8px'}, save)]), ()=>{ renderPage(); });
}

async function openPidForm(){
  const pid=await (await fetch('/api/pid')).json();
  const rows=(pid.loops||[]).map((L,idx)=>[
    `Loop ${idx} enabled`,inputChk(L,'enabled'),
    `name`,inputText(L,'name'),
    `kind`,selectEnum(['analog','digital','tc','calc'], L.kind||'analog', v=>L.kind=v),
    `src`,selectEnum(['ai','tc','calc'], L.src||'ai', v=>L.src=v),
    `ai_ch`,inputNum(L,'ai_ch',1),
    `out_ch`,inputNum(L,'out_ch',1),
    `target`,inputNum(L,'target',0.0001),
    `kp`,inputNum(L,'kp',0.0001),
    `ki`,inputNum(L,'ki',0.0001),
    `kd`,inputNum(L,'kd',0.0001),
    `out_min`,inputNum(L,'out_min',0.0001),
    `out_max`,inputNum(L,'out_max',0.0001),
    `err_min`,inputNum(L,'err_min',0.0001),
    `err_max`,inputNum(L,'err_max',0.0001),
    `i_min`,inputNum(L,'i_min',0.0001),
    `i_max`,inputNum(L,'i_max',0.0001)
  ]);
  const fs=fieldset('PID Loops', tableFormRows(rows));
  const root=el('div',{});
  const save=el('button',{className:'btn',onclick:async()=>{ try{ await fetch('/api/pid',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(pid)}); alert('Saved'); }catch(e){ alert('Save failed: '+e.message);} }},'Save');
  showModal(el('div',{},[fs, el('div',{style:'margin-top:8px'}, save)]), ()=>{ renderPage(); });
}

function fieldset(title, inner){ const fs=el('fieldset',{}); fs.append(el('legend',{},title), inner); return fs; }
function tableForm(pairs){ const tbl=el('table',{className:'form'}), tbody=el('tbody'); for(const [label,input] of pairs){ const tr=el('tr'); tr.append(el('th',{},label), el('td',{},input)); tbody.append(tr); } tbl.append(el('thead',{}, el('tr',{},[el('th',{},'Field'), el('th',{},'Value')])), tbody); return tbl; }
function tableFormRows(rows){ const tbl=el('table',{className:'form'}), tbody=el('tbody'); for(const row of rows){ const tr=el('tr'); for(let i=0;i<row.length;i+=2){ tr.append(el('th',{},row[i]), el('td',{},row[i+1])); } tbody.append(tr);} tbl.append(el('thead',{}, el('tr',{},[el('th',{},'Field'), el('th',{},'Value'), el('th',{},'Field'), el('th',{},'Value'), el('th',{},'Field'), el('th',{},'Value'), el('th',{},'Field'), el('th',{},'Value')])), tbody); return tbl; }
function inputText(obj,key){ const i=el('input',{type:'text',value:obj[key]??''}); i.oninput=()=>obj[key]=i.value; return i; }
function inputNum(obj,key,step){ const i=el('input',{type:'number',step:step??'any',value:obj[key]??0}); i.oninput=()=>obj[key]=parseFloat(i.value)||0; return i; }
function inputChk(obj,key){ const i=el('input',{type:'checkbox',checked:!!obj[key]}); i.onchange=()=>obj[key]=!!i.checked; return i; }
function selectEnum(options, value, onChange){ const s=el('select',{}); options.forEach(opt=>s.append(el('option',{value:opt},opt))); s.value=value; s.onchange=()=>onChange(s.value); return s; }
function saveLayoutToFile(){ const blob=new Blob([JSON.stringify({pages:state.pages},null,2)],{type:'application/json'}); const a=el('a',{href:URL.createObjectURL(blob),download:'layout.json'}); a.click(); }
function loadLayoutFromFile(){ const inp=el('input',{type:'file',accept:'.json'}); inp.onchange=()=>{ const f=inp.files?.[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>{ try{ const obj=JSON.parse(rd.result); if(!obj.pages||!Array.isArray(obj.pages)) throw new Error('Invalid layout file'); state.pages=obj.pages; refreshPages(); setActivePage(0);}catch(e){ alert('Load failed: '+e.message);} }; rd.readAsText(f); }; inp.click(); }

// Widget settings modal per type
function openWidgetSettings(w){
  const root=el('div',{});
  const titleHeader=el('h3',{}, (w.opts.title||w.type)+' — Settings');
  const titleInput=inputText(w.opts,'title');
  titleInput.oninput = ()=>{ w.opts.title = titleInput.value; const t=document.querySelector('#w_'+w.id+' header .title'); if(t) t.textContent = w.opts.title || w.type; const b=document.querySelector('#w_'+w.id+' .do-btn'); if(b) b.textContent = w.opts.title || 'DO'; };
  const nameRow=tableForm([['Title', titleInput]]);
  root.append(el('div',{},[titleHeader]), nameRow, el('hr',{className:'soft'}));

  if (w.type==='chart'||w.type==='bars'||w.type==='gauge'){
    const list=el('div',{});
    const items=(w.type==='gauge')?(w.opts.needles=w.opts.needles||[]):(w.opts.series=w.opts.series||[]);
    function redrawList(){
      list.innerHTML='';
      items.forEach((s,idx)=>{
        const kindSel=selectEnum(['ai','ao','do','tc'], s.kind||'ai', v=>{ s.kind=v; s.name = s.name || labelFor(s); });
        const idxInput=el('input',{type:'number',min:0,step:1,value:s.index|0,style:'width:90px'}); idxInput.onchange=()=>{ s.index=parseInt(idxInput.value)||0; s.name = s.name || labelFor(s); };
        const nameInput=el('input',{type:'text',value:(s.name && s.name.length)? s.name : labelFor(s),placeholder:'label'}); nameInput.oninput=()=>s.name=nameInput.value;
        const rm=el('span',{className:'icon',onclick:()=>{ items.splice(idx,1); redrawList(); }}, '−');
        list.append(el('div',{className:'row'},[kindSel, idxInput, nameInput, rm]));
      });
    }
    const add=el('span',{className:'icon',onclick:()=>{ const s={kind:'ai',index:0,name: labelFor({kind:'ai',index:0})}; items.push(s); redrawList(); }}, '+ Add');
    redrawList();
    root.append(el('h4',{}, (w.type==='gauge'?'Needles':'Series')), list, el('div',{style:'margin-top:8px'}, add));
  }

  if (w.type==='dobutton'){
    const modeSel=selectEnum(['toggle','momentary','buzz'], w.opts.mode||'toggle', v=>w.opts.mode=v);
    root.append(tableForm([
      ['Title', titleInput],
      ['Index', inputNum(w.opts,'doIndex',1)],
      ['Active High', inputChk(w.opts,'activeHigh')],
      ['Mode', modeSel],
      ['Buzz Hz', inputNum(w.opts,'buzzHz',0.1)]
    ]));
  }

  if (w.type==='aoslider'){
    const minI = inputNum(w.opts,'min',0.001);
    const maxI = inputNum(w.opts,'max',0.001);
    const stepI = inputNum(w.opts,'step',0.0001);
    const applyAOdom = ()=>{
      const node=document.querySelector('#w_'+w.id);
      if(!node) return;
      const rng=node.querySelector('input[type="range"]');
      const cur=node.querySelector('input[type="number"]');
      if(rng){ rng.min=w.opts.min; rng.max=w.opts.max; rng.step=w.opts.step; }
      if(cur){ cur.min=w.opts.min; cur.max=w.opts.max; cur.step=w.opts.step; }
      const hdr=node.querySelector('header .title'); if(hdr) hdr.textContent=w.opts.title||'AO';
    };
    minI.oninput = ()=>{ w.opts.min=parseFloat(minI.value)||0; applyAOdom(); };
    maxI.oninput = ()=>{ w.opts.max=parseFloat(maxI.value)||10; applyAOdom(); };
    stepI.oninput= ()=>{ w.opts.step=parseFloat(stepI.value)||0.0001; applyAOdom(); };

    root.append(tableForm([
      ['Title', titleInput],
      ['AO Index', inputNum(w.opts,'aoIndex',1)],
      ['Min V', minI],
      ['Max V', maxI],
      ['Step V', stepI],
      ['Live (send on move)', inputChk(w.opts,'live')]
    ]));
  }

  if (w.type==='pidpanel'){
    root.append(tableForm([
      ['Loop Index', inputNum(w.opts,'loopIndex',1)],
      ['Show Controls', inputChk(w.opts,'showControls')]
    ]));
  }

  showModal(root, ()=>{ renderPage(); });
}
