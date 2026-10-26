const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {RunMonitor,lineDecoder}=require('../run_monitor');
test('partial lines do not lose or duplicate progress events',()=>{const got=[];const d=lineDecoder(l=>got.push(l));d.push('@@PRO');d.push('GRESS {"kind":"phase"}\r\nlog');d.push(' line\nfinal');d.flush();assert.deepEqual(got,['@@PROGRESS {"kind":"phase"}','log line','final']);});
test('one session keeps independent stages and becomes interrupted on Stop',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'attendance-monitor-')); const file=path.join(dir,'state.json');
 const m=new RunMonitor(file);m.start('lms');
 const event={kind:'session',group:'CAI5_TEST_S1',track:'technical',date:'2026-10-10',title:'Session 1',retryable:true};
 m.apply({...event,phase:'check',status:'done'});m.apply({...event,phase:'sync',status:'done'});m.apply({...event,phase:'upload',status:'running'});m.end(null);
 const s=Object.values(m.state.groups['technical:CAI5_TEST_S1'].sessions)[0];assert.equal(s.stages.upload,'interrupted');assert.equal(s.stages.sync,'done');
 const loaded=new RunMonitor(file); assert.equal(loaded.state.running,false); assert.ok(loaded.find(s.id));
 loaded.start('retry',true);loaded.apply({...event,phase:'upload',status:'done'});assert.equal(Object.keys(loaded.state.groups['technical:CAI5_TEST_S1'].sessions).length,1);assert.equal(loaded.find(s.id).session.reason,'');
 fs.rmSync(dir,{recursive:true});
});
