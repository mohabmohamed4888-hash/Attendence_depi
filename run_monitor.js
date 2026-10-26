const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PHASES = ['export', 'check', 'sync', 'upload'];
class RunMonitor {
  constructor(file) {
    this.file = file;
    try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { this.state = { groups: {}, running: false, phase: 'check' }; }
    if (this.state.running) this.end(null);
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive:true});
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state));
      fs.renameSync(this.file + '.tmp', this.file);
      delete this.state.saveError;
    } catch (error) { this.state.saveError = `Progress is visible but could not be saved: ${error.message}`; }
  }
  start(task, retry = false) {
    if (!retry) this.state = { groups: {}, phase: 'check', startedAt: Date.now() };
    this.state.running = true; this.state.task = task; this.state.lastUpdate = Date.now();
    delete this.state.reason;
  }
  apply(e) {
    this.state.lastUpdate = Date.now();
    if(e.status === 'running' && e.group) this.state.active = {group:e.group,title:e.title||'',phase:e.phase};
    if (e.kind === 'phase') { this.state.phase = e.phase; this.state.phaseStatus = e.status; (this.state.phases ||= {})[e.phase] = e.status; if(e.reason) this.state.reason=e.reason; return; }
    if (!e.group) return;
    const key = `${e.track || 'technical'}:${e.group}`;
    const g = this.state.groups[key] ||= { key, name: e.group, track: e.track || 'technical', sessions: {}, status: 'queued' };
    if (e.kind === 'group') { Object.assign(g, Object.fromEntries(Object.entries(e).filter(([k]) => !['kind','group','track'].includes(k)))); return; }
    if (e.kind !== 'session' || !PHASES.includes(e.phase)) return;
    const id = crypto.createHash('sha256').update(`${key}|${e.date}|${String(e.title||'').replace(/\s+/g,' ').trim().toLowerCase()}`).digest('hex').slice(0,24);
    const session = g.sessions[id] ||= { id, date: e.date, title: e.title, stages: {} };
    session.stages[e.phase] = e.status;
    session.phase = e.phase;
    session.reason = e.reason || '';
    session.retryable = e.retryable;
    if(e.exportId) session.exportId=e.exportId;
    if(e.source) session.source=e.source;
    session.updatedAt = Date.now();
  }
  end(code) {
    for (const p of Object.keys(this.state.phases || {})) if (this.state.phases[p] === 'running') this.state.phases[p] = code === 0 ? 'done' : 'interrupted';
    this.state.running = false; this.state.exitCode = code; this.state.endedAt = Date.now(); delete this.state.active;
    for (const g of Object.values(this.state.groups)) {
      if (g.status === 'running' || g.status === 'queued') g.status = code === 0 ? 'checked' : 'interrupted';
      for (const s of Object.values(g.sessions)) for (const phase of PHASES) if (s.stages[phase] === 'running') { s.stages[phase] = 'interrupted'; s.reason='Stopped before verification. Retry to check this session again.'; }
    }
    this.save();
  }
  find(id) { for (const g of Object.values(this.state.groups)) if (g.sessions[id]) return { group:g, session:g.sessions[id] }; }
}
function lineDecoder(onLine) {
  let buffer='';
  return { push(chunk) { buffer += chunk; let i; while ((i=buffer.indexOf('\n'))>=0) { onLine(buffer.slice(0,i).replace(/\r$/, '')); buffer=buffer.slice(i+1); } }, flush() { if(buffer) onLine(buffer); buffer=''; } };
}
module.exports = { RunMonitor, lineDecoder };
