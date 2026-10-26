const { chromium }=require('playwright');
const path=require('path'),fs=require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1440,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   const callbacks={};window.testCallbacks=callbacks;window.retryIds=[];
   window.electron={getGroups:async()=>[],getGroupBatches:async()=>({}),getGroupTracks:async()=>({}),getRunProgress:async()=>({groups:{}}),onRunProgress:f=>callbacks.progress=f,onProcessEnded:f=>callbacks.end=f,onLog:()=>{},retrySession:async id=>{window.retryIds.push(id);return {ok:true}},getLogs:async()=>'',clearLogs:async()=>true};
 });
 await page.goto('file:///'+path.resolve('src/index.html').replace(/\\/g,'/'));
 await page.evaluate(()=>{const groups={};for(let i=0;i<120;i++){const id=`session${i}`,track=i%2?'nontechnical':'technical';groups[`g${i}`]={key:`g${i}`,name:`CAI5_AIS${i}_S1`,track,status:'checked',folderCount:i===2?0:2,sessions:{[id]:{id,date:'2026-10-10',title:`Week 10 | ${i===1?'Freelancing':'Technical'}`,retryable:true,stages:{check:'done',sync:'done',upload:i===1?'error':'done'},reason:i===1?'Upload could not be verified':''}}};}window.testCallbacks.progress({groups,phase:'upload',phases:{check:'done',sync:'done',upload:'done'},lastUpdate:Date.now(),endedAt:Date.now(),running:false,exitCode:0});});
 await page.locator('#monitorFilter').selectOption('error');
 if(await page.locator('.monitor-group').count()!==1)throw Error('error filter failed');
 await page.locator('.monitor-group summary').click();
 await page.screenshot({path:'tests/monitor-preview.png'});
 await page.locator('.session-retry').click();if(await page.evaluate(()=>window.retryIds[0])!=='session1')throw Error('retry target wrong');
 await page.evaluate(()=>window.testCallbacks.end({code:0}));
 await page.locator('#monitorFilter').selectOption('all');
 if(await page.locator('.monitor-group').count()!==25)throw Error('pagination failed');
 await page.locator('#monitorNext').click();if(!(await page.locator('#monitorPage').innerText()).includes('Page 2'))throw Error('next page failed');
 await page.locator('#monitorSearch').fill('CAI5_AIS119_');if(await page.locator('.monitor-group').count()!==1)throw Error('search failed');
 await page.locator('#monitorFilter').selectOption('empty');await page.locator('#monitorSearch').fill('');if(await page.locator('.monitor-group').count()!==1)throw Error('empty folder failed');
 await page.locator('#showActivity').click();if(!(await page.locator('#logViewer').isVisible()))throw Error('log tab failed');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('GUI: 120 groups, pagination, search, errors, empty folders, retry ID and logs passed');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

