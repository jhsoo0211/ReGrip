const test=require('node:test');
const assert=require('node:assert/strict');
const {AuthService,DataService,GamificationEngine,resendOutbox}=require('../shared.js');
function storage(){const map=new Map();global.localStorage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};DataService.setBackend('local');return map;}
const snapshot={version:2,source:'ble',unit:'adc_12bit',channel:'fsr',baseline0:400,baseline100:2400,capturedAt:'2026-09-05T00:00:00Z'};
const row=(inputSource,maxForce=50)=>({date:new Date().toISOString(),gameId:'balloon',label:'풍선',durationSec:30,sets:1,avgForce:30,maxForce,stars:1,inputSource,calibrationSnapshot:inputSource==='ble'?structuredClone(snapshot):null});
function login(user='A',base='http://localhost:8000') { DataService.setBackend('rest',base); AuthService._store({accessToken:'fixture-'+user,user:{id:user}}); }
const response=(data={},status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(data),json:async()=>data});
test('sensor statistics exclude simulation and unlabelled history while XP stays global',async()=>{
 storage();
 await DataService.saveSession(row('ble',50));await DataService.saveSession(row('simulation',100));await DataService.saveSession(row(undefined,90));
 const all=await GamificationEngine.getStats();const real=await GamificationEngine.getStats('real');
 assert.equal(real.totalSessions,1);assert.equal(real.maxForce,50);assert.equal(real.totalXp,all.totalXp);
 assert.equal((await DataService.getSessions('unknown')).length,1);
});
test('offline session payload freezes provenance and calibration through retry',async()=>{
 const map=storage();let sent;global.fetch=async(url,opt)=>{sent=JSON.parse(opt.body);throw Error('offline')};
 login();
 const session=row('ble');await DataService.saveSession(session);
 const queue=DataService._readOutbox();
 assert.equal(queue[0].inputSource,'ble');assert.deepEqual(queue[0].calibrationSnapshot,snapshot);
 assert.deepEqual(sent.calibrationSnapshot,snapshot);
 session.calibrationSnapshot.baseline0=888;
 assert.equal(queue[0].calibrationSnapshot.baseline0,400);
});
test('filtered REST reads retain complete cached history and server metadata',async()=>{
 const map=storage();login();DataService._writeLocal('regrip_sessions',[row('simulation'),row('unknown')]);
 let requested;
 global.fetch=async url=>{requested=url;return {ok:true,status:200,text:async()=>JSON.stringify({data:[{id:'a',exerciseType:'game_balloon',date:new Date().toISOString(),sets:1,inputSource:'ble',calibrationSnapshot:snapshot}],meta:{nextCursor:null}})};};
 const rows=await DataService.getSessions('real');
 assert.match(requested,/source=real/);assert.equal(rows[0].inputSource,'ble');assert.deepEqual(rows[0].calibrationSnapshot,snapshot);
 assert.equal(DataService._readLocal('regrip_sessions',[]).filter(s=>s.inputSource==='simulation').length,1);
});

test('history dates and streak day buckets follow the user timezone across Korean midnight',()=>{
 const map=storage(); map.set('regrip_settings',JSON.stringify({timezone:'Asia/Seoul'}));
 const {dayNum,formatKoreanDate}=require('../shared.js');
 assert.equal(dayNum('2026-09-04T15:00:00Z')-dayNum('2026-09-04T14:59:59Z'),1);
 assert.equal(formatKoreanDate('2026-09-04T15:00:00Z'),'2026.09.05');
 map.set('regrip_settings',JSON.stringify({timezone:'America/Los_Angeles'}));
 assert.equal(formatKoreanDate('2026-09-04T15:00:00Z'),'2026.09.04');
});

test('a history read during the first POST preserves both the record and its durable retry payload',async()=>{
 const map=storage();login();
 let finish;
 global.fetch=async(url,opts)=>opts.method==='POST'?new Promise(resolve=>{finish=resolve;}):{ok:true,status:200,text:async()=>JSON.stringify({data:[],meta:{nextCursor:null}})};
 const saving=DataService.saveSession(row('ble'));
 assert.equal(DataService._readOutbox().length,1);
 const pending=DataService._readOutbox()[0];
 assert.equal((await DataService.getSessions()).length,1);
 finish({ok:true,status:201,text:async()=>JSON.stringify({session:{id:'saved'}})});await saving;
 assert.equal(DataService._readOutbox().length,0);
 assert.equal(DataService._readLocal('regrip_sessions',[])[0].clientSessionId,pending.clientSessionId);
});

test('outbox drain retains a new queued session arriving while an earlier retry is pending',async()=>{
 const map=storage();login();
 const first={clientSessionId:'first',inputSource:'ble',calibrationSnapshot:snapshot};
 const next={clientSessionId:'next',inputSource:'simulation',calibrationSnapshot:null};
 DataService._enqueueOutbox(first);
 let finish;global.fetch=async()=>new Promise(resolve=>{finish=resolve;});
 const drain=require('../shared.js').resendOutbox();
 DataService._enqueueOutbox(next);
 finish({ok:true,status:201});await drain;
 assert.deepEqual(DataService._readOutbox(),[next]);
});

test('offline records and retries remain isolated by account and API without deleting local history',async()=>{
 const map=storage();await DataService.saveSession(row('simulation'));
 const local=map.get('regrip_sessions');login('A');global.fetch=async()=>{throw Error('offline')};
 await DataService.saveSession(row('ble'));const original=DataService._readOutbox()[0];
 login('B');let sends=0;global.fetch=async()=>{sends++;throw Error('offline')};
 await resendOutbox();assert.equal(sends,0);assert.equal(DataService._readOutbox().length,0);
 assert.equal((await GamificationEngine.getStats('real')).totalSessions,0);
 login('A','http://localhost:9000');assert.equal(DataService._readOutbox().length,0);
 login('A');assert.deepEqual(DataService._readOutbox(),[original]);
 assert.equal((await DataService.getSessions('real')).length,1);
 DataService.disconnectServer();assert.equal((await DataService.getSessions()).length,1);assert.equal(map.get('regrip_sessions'),local);
});

test('legacy unowned queues and cache are preserved without automatic attribution after login',async()=>{
 const map=storage();const legacy=[{...row('ble'),clientSessionId:'legacy'}];
 map.set('regrip_sessions',JSON.stringify(legacy));map.set('regrip_outbox',JSON.stringify([{clientSessionId:'legacy'}]));
 const saved=[map.get('regrip_sessions'),map.get('regrip_outbox')];login('B');
 let posts=0;global.fetch=async(url,opts)=>{if(opts.method==='POST')posts++;return response({data:[],meta:{nextCursor:null}})};
 await resendOutbox();assert.equal(posts,0);assert.deepEqual(await DataService.getSessions(),[]);
 assert.deepEqual([map.get('regrip_sessions'),map.get('regrip_outbox')],saved);
});

test('an old POST acknowledgement after logout clears only its original account queue',async()=>{
 storage();login('A');let finish;
 global.fetch=async()=>new Promise(resolve=>{finish=resolve});
 const first=DataService.saveSession({...row('ble'),clientSessionId:'same-id'});
 AuthService._clearTokens();login('B');global.fetch=async()=>{throw Error('offline')};
 await DataService.saveSession({...row('simulation'),clientSessionId:'same-id'});
 finish(response({session:{id:'saved'}},201));await first;
 assert.equal(DataService._readOutbox().length,1);assert.equal(DataService._readOutbox()[0].inputSource,'simulation');
 login('A');assert.equal(DataService._readOutbox().length,0);
 assert.equal(DataService._readLocal('regrip_sessions',[])[0].inputSource,'ble');
});

test('a drain stops when the account changes and preserves each account latest queue',async()=>{
 storage();login('A');global.fetch=async()=>response();await DataService._fetch('/users/me/stats');
 DataService._enqueueOutbox({clientSessionId:'A1'});DataService._enqueueOutbox({clientSessionId:'A2'});
 let finish;const sent=[];global.fetch=async(url,opts)=>{sent.push(opts.headers.Authorization);return sent.length===1?new Promise(resolve=>{finish=resolve}):response({},201);};
 const draining=resendOutbox();login('B');DataService._enqueueOutbox({clientSessionId:'B1'});
 finish(response({},201));await draining;
 assert.deepEqual(sent,['Bearer fixture-A']);assert.deepEqual(DataService._readOutbox(),[{clientSessionId:'B1'}]);
 login('A');assert.deepEqual(DataService._readOutbox(),[{clientSessionId:'A2'}]);
});

test('a late history response cannot replace the next account cache',async()=>{
 storage();login('A');let finish;global.fetch=async()=>new Promise(resolve=>{finish=resolve});
 const reading=DataService.getSessions();login('B');DataService._writeLocal('regrip_sessions',[row('simulation')]);
 finish(response({data:[{id:'A-record',inputSource:'ble',exerciseType:'game_balloon',date:new Date().toISOString()}],meta:{nextCursor:null}}));
 await reading;assert.equal(DataService._readLocal('regrip_sessions',[])[0].inputSource,'simulation');
});

test('explicit local migration uses the confirmed account and sends no ownership metadata',async()=>{
 const map=storage();await DataService.saveSession(row('simulation'));
 const local=DataService._readLocal('regrip_sessions',[]);login('A');const scope=DataService._storageScope();
 const sent=[];global.fetch=async(url,opts)=>{sent.push(JSON.parse(opts.body));return response({},201)};
 const {_migrateSessions}=require('../shared.js');await _migrateSessions(local,scope);
 assert.equal(sent.length,1);assert.equal(sent[0].inputSource,'simulation');
 assert.equal(Object.keys(sent[0]).some(k=>/owner|scope|userId|apiBase/i.test(k)),false);
 assert.equal(JSON.parse(map.get('regrip_sessions')).length,1);
 assert.equal(DataService._readLocal('regrip_sessions',[]).length,1);assert.equal(DataService._readOutbox().length,0);
 login('B');await _migrateSessions(local,scope);assert.equal(sent.length,1);assert.equal(DataService._readLocal('regrip_sessions',[]).length,0);
});

test('late token refresh and unauthorized replies cannot restore a logged-out owner or retry as a new one',async()=>{
 storage();login('A');let finish;global.fetch=async()=>new Promise(resolve=>{finish=resolve});
 const refreshing=AuthService.refresh();AuthService._clearTokens();login('B');
 finish(response({accessToken:'old-A',user:{id:'A'}}));assert.equal(await refreshing,false);assert.equal(AuthService.getUser().id,'B');
 login('A');const calls=[];global.fetch=async(url,opts)=>{calls.push(opts.headers.Authorization);return new Promise(resolve=>{finish=resolve});};
 const sending=DataService.saveSession(row('ble'));AuthService._clearTokens();login('B');finish(response({},401));await sending;
 assert.deepEqual(calls,['Bearer fixture-A']);assert.equal(AuthService.getUser().id,'B');assert.equal(DataService._readOutbox().length,0);
 login('A');assert.equal(DataService._readOutbox().length,1);
});
