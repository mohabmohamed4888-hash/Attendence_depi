const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('vm'),fs=require('fs'),path=require('path');const {EventEmitter}=require('events');
function harness(source){
 const handlers={},calls=[],messages=[],writes={};
 class Monitor{
  constructor(){this.state={groups:{},running:false};this.target={group:{name:'CAI5_TEST_S1',track:'technical'},session:{retryable:true,date:'2026-10-10',title:'Week 1 | Technical',stages:source==='dashboard'?{export:'error'}:{upload:'error'},exportId:'dashboard-123'}};}
  find(id){return id==='known'?this.target:null}start(){this.state.running=true}save(){}apply(){}end(){this.state.running=false}
 }
 const fakeFs={...fs,writeFileSync:(p,v)=>writes[p]=v,existsSync:()=>false};
 const realRequire=require('module').createRequire(path.resolve('main.js'));
 const req=id=>id==='electron'?{app:{commandLine:{appendSwitch(){}},on(){}},BrowserWindow:class{static getAllWindows(){return [{isDestroyed:()=>false,webContents:{send:(...args)=>messages.push(args)}}]}},ipcMain:{on(){},handle:(n,f)=>handlers[n]=f}}:id==='./run_monitor'?{RunMonitor:Monitor,lineDecoder:require('../run_monitor').lineDecoder}:id==='fs'?fakeFs:id==='child_process'?{spawn:(command,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();calls.push({command,args,options,child});return child}}:realRequire(id);
 vm.runInNewContext(fs.readFileSync('main.js','utf8'),{require:req,__dirname:path.resolve('.'),process,setTimeout:()=>1,clearTimeout(){},console});
 const event={sender:{isDestroyed:()=>false,send:(...args)=>messages.push(args)}};
 return {handlers,event,calls,writes};
}
test('LMS retry uses only the stored group and exact date/title, then rejects concurrent retry',()=>{
 const h=harness('lms');assert.equal(h.handlers['retry-session'](h.event,'known').ok,true);
 assert.equal(h.calls[0].command,'python');assert.equal(h.calls[0].options.env.ONLY_GROUPS,'CAI5_TEST_S1');assert.deepEqual(JSON.parse(h.calls[0].options.env.RETRY_SESSION),{date:'2026-10-10',title:'Week 1 | Technical'});
 assert.equal(h.calls[0].options.env.FORCE_REUPLOAD,'false');assert.equal(h.handlers['retry-session'](h.event,'known').ok,false);h.calls[0].child.emit('close',0,null);
});
test('Dashboard retry sends the stored session id to the exporter',()=>{
 const h=harness('dashboard');assert.equal(h.handlers['retry-session'](h.event,'known').ok,true);assert.equal(h.calls[0].command,'node');
 const config=JSON.parse(Object.values(h.writes)[0]);assert.equal(config.retrySessionId,'dashboard-123');assert.equal(config.groupFilter,'CAI5_TEST_S1');h.calls[0].child.emit('close',0,null);
});
