import {calculate,picksFor,settle,ROOT,ODDS,day,window} from './arena-engine.mjs';
const endpoint=process.env.AI_WORKER_URL?.replace(/\/$/,'');
const token=process.env.AI_ADMIN_TOKEN;
if(!endpoint||!token)throw Error('Missing worker configuration');
const auth={Authorization:'Bearer '+token};
async function api(path,body){const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{...auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Worker HTTP '+r.status);return r.json();}
const cache=new Map(); let requests=0;
async function read(url,headers={}){requests++;for(let i=0;i<3;i++){try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});if(r.status===404)return null;if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,1000*(i+1)));}}}
let failures=new Set();
const io={json:async path=>{if(!cache.has(path))cache.set(path,read(new URL(path,ROOT)).catch(e=>{failures.add(path);cache.delete(path);throw e;}));return structuredClone(await cache.get(path));}};
const catalog=await io.json('./data/pitch/leagues.json');if(!Array.isArray(catalog))throw Error('Invalid catalog');
const leagues=[...new Set(catalog.map(l=>l.id).filter(x=>/^l_[A-Za-z0-9]+$/.test(x)))];if(leagues.length!==77)throw Error('Expected 77 leagues, got '+leagues.length);
const files=new Map();for(let i=0;i<leagues.length;i+=8)await Promise.all(leagues.slice(i,i+8).map(async id=>{const j=await io.json('./data/pitch/'+id+'.json');if(j?.data?.league?.id!==id||!Array.isArray(j.data.matches))throw Error('Invalid league '+id);files.set(id,j.data.matches);}));
const known=new Set((await api('/known')).ids);const now=Date.now();const upcoming=[...files].flatMap(([league_id,ms])=>ms.filter(m=>m.status==='not_started'&&Date.parse(m.time_utc)>now&&day(m.time_utc)===day(now)&&m.home_team?.id&&m.away_team?.id&&!known.has(m.id)).map(m=>({...m,league_id}))).sort((a,b)=>Date.parse(a.time_utc)-Date.parse(b.time_utc));
let saved=0,settled=0,errors=0;
for(const m of upcoming.slice(0,20)){try{const kickoff=Date.parse(m.time_utc);if(Date.now()>=kickoff)continue;failures=new Set();let odds=null;if(process.env.ODDS_TEST_TOKEN&&window.taArenaOdds.leagueMap.has(m.league_id)){try{const h={Authorization:'Bearer '+process.env.ODDS_TEST_TOKEN};const list=await read(ODDS+'?at='+encodeURIComponent(m.time_utc),h);const x=window.taArenaOdds.resolve(m,list?.maclar||[],files.get(m.league_id));const d=await read(ODDS+'?id='+encodeURIComponent(x.fixture_id),h);const t=Date.parse(d?.updated_at);if(d?.success&&d.fixture_id===x.fixture_id&&t<=Date.now()&&t<kickoff&&Date.now()-t<=86400000)odds=d;}catch{console.warn('Odds unavailable',m.id);}}
const out=await calculate(m,io,odds);if(failures.size)throw Error('Incomplete source reads');const picks=picksFor(m,out.data,out.teamData,out.result);if(!picks.length||Date.now()>=kickoff)continue;const r=await api('/prediction',{id:m.id,league:m.league_id,name:m.home_team.name+' – '+m.away_team.name,home:m.home_team.id,away:m.away_team.id,kickoff,picks,verification:out.result});saved+=r.saved;}catch(e){errors++;console.warn(m.id,e.message);}}
const pending=(await api('/unsettled')).rows;
// Use the same current-day feed as the application's match screen.
const liveById=new Map();let liveAvailable=false;
if(pending.length){try{
  const j=await read('https://tahminarena-live.admalkan007.workers.dev/',{'Cache-Control':'no-cache'});
  if(j?.success!==true||!Array.isArray(j.matches))throw Error('Invalid live feed');
  for(const m of j.matches){if(!m?.id)continue;const list=liveById.get(m.id)||[];list.push(m);liveById.set(m.id,list);}
  liveAvailable=true;
}catch(e){errors++;console.warn('LIVE_FEED_ERROR',e.message);}}
console.log('SETTLEMENT_SOURCE '+JSON.stringify({liveAvailable,matches:liveById.size}));
const diag={pending:pending.length,matched:0,missingLeague:0,missingId:0,teamMismatch:0,kickoffMismatch:0,notFinished:0,invalidScore:0,attempted:0,notSaved:0,failed:0};
console.log('SETTLEMENT_QUEUE '+JSON.stringify({count:pending.length,now:new Date().toISOString()}));
for(const row of pending){
  try{
    const r=JSON.parse(row.payload);
    const report=(reason,extra={})=>console.log('SETTLEMENT_CHECK '+JSON.stringify({id:r.id,name:r.name,league:r.league,reason,...extra}));
    const currentDay=day(r.kickoff)===day(now);
    const liveMatches=liveById.get(r.id);
    if(currentDay&&!liveMatches){report(liveAvailable?'missing_live_match':'live_feed_unavailable');diag.missingId++;continue;}
    const source=liveMatches?'live':'archive';
    const matches=liveMatches||files.get(r.league);
    if(!matches){diag.missingLeague++;report('missing_league');continue;}
    const candidates=matches.filter(x=>x.id===r.id&&(source!=='live'||(x.league?.id??x.league_id)===r.league));
    if(!candidates.length){diag.missingId++;report('missing_match_id');continue;}
    const teams=candidates.filter(x=>x.home_team?.id===r.home&&x.away_team?.id===r.away);
    if(!teams.length){diag.teamMismatch++;report('team_mismatch',{expected:[r.home,r.away],found:candidates.map(x=>[x.home_team?.id,x.away_team?.id])});continue;}
    const exact=teams.filter(x=>Date.parse(x.time_utc)===r.kickoff);
    const m=exact.length===1?exact[0]:null;
    if(!m){diag.kickoffMismatch++;report('kickoff_mismatch',{expected:r.kickoff,found:teams.map(x=>x.time_utc)});continue;}
    diag.matched++;
    if(!['finished','ended','full_time'].includes(m.status)){diag.notFinished++;report('not_finished',{status:m.status,score:[m.score_home,m.score_away]});continue;}
    if(!Number.isInteger(m.score_home)||!Number.isInteger(m.score_away)){diag.invalidScore++;report('invalid_score',{score:[m.score_home,m.score_away],types:[typeof m.score_home,typeof m.score_away]});continue;}
    diag.attempted++;
    await settle(r,{...m,status:'finished'},p=>io.json(p));
    const result=await api('/settlement',r);
    settled+=result.saved;
    if(!result.saved)diag.notSaved++;
    report(result.saved?'saved':'not_saved',{source,score:[m.score_home,m.score_away],saved:result.saved});
  }catch(e){errors++;diag.failed++;console.warn('SETTLEMENT_ERROR',row.id,e.message);}
}
console.log('SETTLEMENT_SUMMARY '+JSON.stringify(diag));
// Compare finished matches already known to the worker with the current settlement queue.
const pendingIds=new Set(pending.map(r=>r.id));
for(const [league,ms] of files)for(const m of ms){
  if(m.status==='finished'&&known.has(m.id)&&day(m.time_utc)===day(now))console.log('KNOWN_FINISHED '+JSON.stringify({id:m.id,league,name:m.home_team?.name+' – '+m.away_team?.name,score:[m.score_home,m.score_away],inQueue:pendingIds.has(m.id)}));
}

console.log(JSON.stringify({mode:'pilot-v6',catalog:leagues.length,requests,upcoming:upcoming.length,saved,settled,errors}));

if(errors===0)await api("/run-complete",{catalog:leagues.length,errors});
