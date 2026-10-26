const {_electron:electron}=require('playwright');
const path=require('path');
(async()=>{
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.resolve('.')],env});
try{
const main=await app.firstWindow();await main.waitForFunction(()=>document.getElementById('monitorPage').textContent);
const opened=app.waitForEvent('window');await main.locator('#openProgress').click();const page=await opened;
const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.getElementById('monitorPage').textContent);
await page.setViewportSize({width:1366,height:768});
const snapshot=await page.evaluate(()=>window.electron.getRunProgress());
console.log('Loaded saved groups:',Object.keys(snapshot.groups).length);
if(await page.locator('.monitor-group').count()===0)throw Error('Saved groups missing');
await page.locator('#monitorTrackFilter').selectOption('nontechnical');
if(!(await page.locator('.monitor-group summary').first().innerText()).includes('Non-Technical'))throw Error('Track filter failed');
await page.locator('#monitorTrackFilter').selectOption('all');
if(await page.locator('.monitor-group:not([open])').count())throw Error('Groups should open by default');
await page.locator('#monitorNext').click();
if(await page.locator('.monitor-group:not([open])').count())throw Error('Next page collapsed');
await page.locator('#monitorPrev').click();
await page.locator('#collapseGroups').click();
if(await page.locator('.monitor-group[open]').count())throw Error('Collapse all failed');
await page.locator('#expandGroups').click();
if(await page.locator('.monitor-group:not([open])').count())throw Error('Expand all failed');
await page.screenshot({path:'tests/progress-window-preview.png'});
const height=await page.locator('#monitorGroups').evaluate(el=>el.getBoundingClientRect().height);if(height<320)throw Error('List too short');
await main.evaluate(()=>window.electron.openProgress());if(app.windows().length!==2)throw Error('Duplicate monitor window');
await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())win.webContents.send('run-progress',{groups:{demo:{key:'demo',name:'LIVE_TEST',track:'technical',status:'checked',folderCount:0,sessions:{}}},running:false,exitCode:0,endedAt:Date.now(),lastUpdate:Date.now(),phases:{check:'done'}});});
await page.locator('summary').filter({hasText:'LIVE_TEST'}).waitFor();if(await page.locator('.monitor-group:not([open])').count())throw Error('New live groups collapsed');await main.locator('summary').filter({hasText:'LIVE_TEST'}).waitFor();
await page.close();if(app.windows().length!==1)throw Error('Closing monitor closed controls');
if(errors.length)throw Error(errors.join('\n'));
console.log('Separate window: saved snapshot, roomy layout, tracks, expand, reuse, live broadcast, independent close passed');
}finally{await app.close()}
})().catch(e=>{console.error(e);process.exit(1)});
