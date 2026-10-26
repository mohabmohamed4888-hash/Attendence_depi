const {_electron:electron}=require('playwright');
const path=require('path');
(async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve('.')],env});
 try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.electron&&document.getElementById('monitorPage').textContent);
 const state=await page.evaluate(()=>window.electron.getRunProgress());
 if(!state.groups)throw Error('preload progress IPC failed');
 const rejected=await page.evaluate(()=>window.electron.retrySession('not-a-session'));
 if(rejected.ok)throw Error('unknown retry accepted');
 await page.locator('#showActivity').click();await page.locator('#showMonitor').click();
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Electron preload, snapshot IPC, invalid retry rejection and tabs passed');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exit(1)});
