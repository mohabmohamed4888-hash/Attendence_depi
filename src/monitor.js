(() => {
  let state = {groups:{}}, page=0, expanded=new Set(), collapsed=new Set(), retryPending=false;
  let expandByDefault=document.body.classList.contains('progress-page');
  const isExpanded=key=>expandByDefault?!collapsed.has(key):expanded.has(key);
  const phases=['export','check','sync','upload'], labels={export:'Export',check:'Check',sync:'Add / Sync',upload:'Upload'};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errors=s=>Object.values(s.stages).some(x=>['error','interrupted'].includes(x));
  const sessions=g=>Object.values(g.sessions||{});
  const done=g=>sessions(g).length>0&&sessions(g).every(s=>s.stages.upload==='done'&&!errors(s));
  const bad=g=>g.status==='error'||g.status==='interrupted'||sessions(g).some(errors);
  function dot(status,label){return `<span class="stage-dot ${esc(status||'unknown')}" title="${esc(label)}: ${esc(status||'Not checked')}">${status==='done'?'✓':['error','interrupted'].includes(status)?'!':status==='running'?'●':'○'}</span><span>${esc(label)}<small>${esc(status||'Not checked')}</small></span>`;}
  function reportError(message){
    if(typeof addLogEntry==='function') addLogEntry(message,'warning');
    const notice=document.getElementById('monitorNotice');
    if(notice){notice.hidden=false;notice.textContent=message;}
  }
  function runningItems(){
    if(!state.running) return [];
    return Object.values(state.groups||{}).flatMap(g=>{
      const active=sessions(g).flatMap(s=>phases.filter(p=>s.stages[p]==='running').map(phase=>({group:g.name,track:g.track,date:s.date,title:s.title,phase,stages:s.stages})));
      return active.length?active:g.status==='running'?[{group:g.name,track:g.track,phase:g.phase||state.phase,title:'Checking group sessions…'}]:[];
    });
  }
  function renderRunning(items){
    const panel=document.getElementById('monitorRunning');
    if(!panel) return;
    panel.innerHTML=`<div class="running-heading"><strong>${state.running?'● Running now':'Current work'}</strong><span>${items.length?items.length+' active operation'+(items.length===1?'':'s'):state.running?'Process running':'No active operation'}</span></div>`+
      (items.length?`<div class="running-items">${items.map(item=>`<article class="running-item"><div class="running-label"><strong>${esc(item.group)}</strong><span>${esc(item.track==='technical'?'Technical':'Non-Technical')} · ${esc(labels[item.phase]||item.phase||state.task)} <b>Running</b></span></div><div class="running-title">${item.date?`<strong>${esc(item.date)}</strong> `:''}${esc(item.title)}</div>${item.stages?`<div class="session-stages">${phases.map(p=>`<div>${dot(item.stages[p],labels[p])}</div>`).join('')}</div>`:''}</article>`).join('')}</div>`:`<p class="running-empty">${state.running?esc(labels[state.phase]||state.task)+' · Waiting for the next group or session update…':state.endedAt?'Run ended. No session is running.':'Start a run to see the current group and session here.'}</p>`);
  }
  function render(){
    const active=runningItems();
    renderRunning(active);
    document.getElementById('monitorRunStatus').textContent = state.running ? `Running · ${labels[state.phase]||state.task}` : state.endedAt ? (state.exitCode===0?(Object.values(state.groups||{}).some(bad)?'Finished · needs attention':'Run finished'):'Run stopped / failed') : 'Ready';
    document.getElementById('monitorCurrent').textContent = state.saveError || state.reason || (state.running && active.length ? `${active[0].group} · ${labels[active[0].phase] || active[0].phase} · ${active[0].title}` : state.running?'Waiting for the next update…':(expandByDefault?'Sessions and verified steps are shown below each group.':'Expand a group to see its sessions and verified steps.'));
    const groups=Object.values(state.groups||{});
    document.getElementById('monitorStages').innerHTML=phases.map(p=>`<div class="monitor-stage">${dot(groups.some(g=>sessions(g).some(s=>['error','interrupted'].includes(s.stages[p])))?'error':state.phases?.[p] || (state.phase===p&&state.running?'running':undefined),labels[p])}</div>`).join('');
    document.getElementById('monitorTracks').innerHTML=['technical','nontechnical'].map(t=>{
      const gs=groups.filter(g=>g.track===t), ss=gs.flatMap(sessions), complete=ss.filter(s=>s.stages.upload==='done'&&!errors(s)).length, checked=gs.filter(g=>!['queued','running'].includes(g.status)).length;
      return `<div class="track-progress"><strong>${t==='technical'?'Technical':'Non-Technical'}</strong><span>${checked}/${gs.length} groups checked · ${complete}/${ss.length} uploaded / on LMS · ${gs.filter(bad).length} groups with errors</span><progress max="${ss.length||1}" value="${complete}" aria-label="${t} upload progress"></progress></div>`;
    }).join('');
    const q=document.getElementById('monitorSearch').value.toLowerCase(), filter=document.getElementById('monitorFilter').value;
    const track=document.getElementById('monitorTrackFilter')?.value || 'all';
    const filtered=groups.filter(g=>track==='all'||g.track===track).filter(g=>(g.name+' '+sessions(g).map(s=>s.title).join(' ')).toLowerCase().includes(q)).filter(g=>filter==='all'||filter==='error'&&bad(g)||filter==='empty'&&g.folderCount===0||filter==='done'&&done(g)||filter==='pending'&&!done(g)&&!bad(g));
    const pages=Math.max(1,Math.ceil(filtered.length/25)); page=Math.min(page,pages-1);
    document.getElementById('monitorPage').textContent=`${filtered.length} groups · Page ${page+1} / ${pages}`;
    document.getElementById('monitorPrev').disabled=page===0; document.getElementById('monitorNext').disabled=page===pages-1;
    document.getElementById('monitorGroups').innerHTML=filtered.slice(page*25,page*25+25).map(g=>{
      const ss=sessions(g), failures=ss.filter(errors).length;
      return `<details class="monitor-group ${bad(g)?'has-error':''}" data-group="${esc(g.key)}" ${isExpanded(g.key)?'open':''}><summary><strong>${esc(g.name)}</strong><span>${esc(g.track==='technical'?'Technical':'Non-Technical')}</span><span class="group-state">${ss.some(s=>Object.values(s.stages).includes('running'))?'● '+labels[ss.find(s=>Object.values(s.stages).includes('running')).phase]:bad(g)?'⚠ Needs attention':done(g)?'✓ Uploaded / up to date':g.status==='checked'?'Checked':esc(g.status)}</span><small>${ss.length} sessions · ${failures} errors${g.folderCount===0?' · No sessions in folder':''}</small></summary>${g.reason?`<p class="monitor-reason">${esc(g.reason)}</p>`:''}<div class="session-list">${ss.length?ss.map(s=>`<div class="monitor-session"><div class="session-title"><strong>${esc(s.date)}</strong><span>${esc(s.title)}</span></div><div class="session-stages">${phases.map(p=>`<div>${dot(s.stages[p],labels[p])}</div>`).join('')}</div>${s.reason?`<p class="monitor-reason">${esc(s.reason)}</p>`:''}${errors(s)&&s.retryable?`<button type="button" class="session-retry" data-retry="${esc(s.id)}" ${state.running||retryPending?'disabled':''}>Retry this session</button>`:''}</div>`).join(''):'<p class="monitor-reason">No sessions checked yet. Check Missing reads the LMS and lists any missing files.</p>'}</div></details>`;
    }).join('') || `<div class="monitor-empty">${groups.length?'No groups match this filter.':'Start Check Missing, Fast Sync, Sync / Edit or Upload to see live group progress.'}</div>`;
    for(const el of document.querySelectorAll('[data-group]')) el.addEventListener('toggle',()=>{if(!el.isConnected)return; const key=el.dataset.group; if(el.open){expanded.add(key);collapsed.delete(key);}else{expanded.delete(key);collapsed.add(key);}});
    for(const el of document.querySelectorAll('[data-retry]')) el.addEventListener('click',async()=>{
      retryPending=true;render();
      try {const result=await window.electron.retrySession(el.dataset.retry); if(result.ok) { if(typeof beginRun==='function') beginRun('session-retry','Retrying session'); } else reportError(result.reason);}
      catch(e){reportError(e.message);} finally{retryPending=false;render();}
    });
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    const log=document.getElementById('logViewer'), monitor=document.getElementById('runMonitor'); if(log) log.style.display='none';
    if(document.getElementById('showMonitor')) document.getElementById('showMonitor').onclick=()=>{log.style.display='none';monitor.hidden=false;};
    if(document.getElementById('showActivity')) document.getElementById('showActivity').onclick=()=>{log.style.display='';monitor.hidden=true;};
    for(const id of ['monitorSearch','monitorFilter','monitorTrackFilter']) document.getElementById(id)?.addEventListener('input',()=>{page=0;render();});
    document.getElementById('monitorPrev').onclick=()=>{page--;render();};document.getElementById('monitorNext').onclick=()=>{page++;render();};
    document.getElementById('expandGroups')?.addEventListener('click',()=>{expandByDefault=true;collapsed.clear();render();});
    document.getElementById('collapseGroups')?.addEventListener('click',()=>{expandByDefault=false;expanded.clear();collapsed.clear();render();});
    document.getElementById('showControls')?.addEventListener('click',()=>window.electron.showControls());
    window.electron.onRunProgress(s=>{
      state=s;
      if(s.running && typeof beginRun==='function' && !isRunning) beginRun(s.task,'Running '+(labels[s.phase]||s.task));
      render();
    });
    state=await window.electron.getRunProgress();render();
    setInterval(()=>{document.getElementById('monitorHeartbeat').textContent=state.running?`Process running · last update ${Math.floor((Date.now()-(state.lastUpdate||Date.now()))/1000)}s ago${state.reason?' · '+state.reason:''}`:state.lastUpdate?`Last update ${new Date(state.lastUpdate).toLocaleString()}`:'No run yet';},1000);
  });
})();
