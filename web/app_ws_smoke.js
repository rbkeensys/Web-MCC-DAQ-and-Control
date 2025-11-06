// /web/app_ws_smoke.js
'use strict';
(function(){
  const $ = s => document.querySelector(s);
  const log = (m, cls='') => { const el=$('#log'); const line = document.createElement('div'); if(cls) line.className=cls; line.textContent = `[${new Date().toLocaleTimeString()}] ${m}`; el.appendChild(line); el.scrollTop = el.scrollHeight; console.log(m); };
  const status = m => { const s=$('#status'); s.textContent=m; };
  let ws = null, pinger = null;

  document.addEventListener('DOMContentLoaded', ()=>{
    // Default URL is what the server is actually listening on
    const host = location.host || '127.0.0.1:8000';
    $('#url').value = `ws://${host}/ws`;
    $('#connectBtn').onclick = connect;
    $('#ping').onclick = httpPing;
    log('Smoke page loaded (app_ws_smoke.js)');
  });

  function httpPing(){
    fetch('/api/config').then(r=>r.text()).then(t=>{ $('#http').textContent=t; log('GET /api/config OK','ok');}).catch(e=>{ $('#http').textContent=String(e); log('GET /api/config failed: '+e,'err');});
  }

  function connect(){
    const url = $('#url').value.trim();
    if (!url) return alert('Enter ws://.. URL');
    if (ws && ws.readyState===WebSocket.OPEN) { log('WS already open'); return; }
    log('Connecting to '+url);
    status('connecting…');
    try { ws = new WebSocket(url); } catch(e){ status('error'); log('ctor error: '+e,'err'); return; }

    ws.onopen = ()=>{ status('OPEN'); log('onopen','ok'); $('#connectBtn').textContent='Connected';
      if (!pinger) pinger = setInterval(()=>{ try{ ws.send('k'); }catch(_){} }, 2000);
    };
    ws.onclose = e=>{ status('CLOSED'); log(`onclose code=${e.code} reason=${e.reason}`,'warn'); $('#connectBtn').textContent='Connect';
      if (pinger) { clearInterval(pinger); pinger=null; }
    };
    ws.onerror = e=>{ status('ERROR'); log('onerror: '+(e?.message||e),'err'); };
    ws.onmessage = e=>{
      let txt = e.data;
      // keep log compact
      if (typeof txt === 'string' && txt.length > 180) txt = txt.slice(0,180)+'…';
      log('onmessage: '+txt);
    };
  }
})();