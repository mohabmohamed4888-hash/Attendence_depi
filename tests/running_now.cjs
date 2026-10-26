const {chromium}=require('playwright');const path=require('path');
(async()=>{
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
const page=await browser.newPage({viewport:{width:1366,height:768}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.electron={onRunProgress:f=>window.progress=f,getRunProgress:async()=>({groups:{}}),showControls:async()=>{},retrySession:async()=>({ok:true})};});
await page.goto('file:///'+path.resolve('src/progress.html').replace(/\\/g,'/'));
await page.evaluate(()=>{
const groups={};for(let i=0;i<60;i++)groups['g'+i]={key:'g'+i,name:'GROUP_'+i,track:i===55?'nontechnical':'technical',status:'checked',sessions:{['s'+i]:{id:'s'+i,date:'2026-10-04',title:'Session '+i,stages:{export:'done',check:'done',sync:'done',upload:i===55?'running':'done'}}}};
window.fixture={groups,running:true,phase:'upload',lastUpdate:Date.now()};window.progress(window.fixture);
});
await page.locator('#monitorSearch').fill('GROUP_0');await page.locator('#monitorTrackFilter').selectOption('technical');await page.locator('#monitorFilter').selectOption('done');
if(await page.locator('#monitorGroups').innerText().then(t=>t.includes('GROUP_55')))throw Error('Fixture running group should be hidden by filters');
if(!(await page.locator('#monitorRunning').innerText()).includes('GROUP_55'))throw Error('Active session hidden by filters');
for(const phase of ['export','check','sync','upload']){
await page.evaluate(phase=>{const s=window.fixture.groups.g55.sessions.s55;s.stages={export:'done',check:'done',sync:'done',upload:'done',[phase]:'running'};window.fixture.phase=phase;window.progress(window.fixture);},phase);
if(!(await page.locator('#monitorRunning .running-label').innerText()).includes({export:'Export',check:'Check',sync:'Add / Sync',upload:'Upload'}[phase]))throw Error('Missing phase '+phase);
}
await page.locator('#monitorSearch').fill('');await page.locator('#monitorTrackFilter').selectOption('all');await page.locator('#monitorFilter').selectOption('all');
await page.locator('#monitorNext').click();if(!(await page.locator('#monitorPage').innerText()).includes('Page 2'))throw Error('Pagination failed');
await page.evaluate(()=>window.scrollTo(0,2000));
const rect=await page.locator('#monitorRunning').boundingBox();if(rect.y<0||rect.y>12)throw Error('Running panel did not stay pinned');
await page.screenshot({path:'tests/running-now-preview.png'});
await page.evaluate(()=>{window.fixture.groups.g55.sessions.s55.stages.upload='done';window.fixture.groups.g58.status='running';window.fixture.groups.g58.phase='check';window.fixture.groups.g59.status='running';window.fixture.groups.g59.phase='check';window.progress(window.fixture);});
if(await page.locator('#monitorRunning .running-item').count()!==2)throw Error('Concurrent group scans missing or completed session stale');
await page.evaluate(()=>{window.fixture.running=false;window.fixture.endedAt=Date.now();window.fixture.exitCode=null;window.progress(window.fixture);});
if(await page.locator('#monitorRunning .running-item').count())throw Error('Stopped work still running');
if(errors.length)throw Error(errors.join('\n'));console.log('Running panel: all four phases, filters, pagination, sticky scrolling, concurrent scans, completion and stop passed');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
