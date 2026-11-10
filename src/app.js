/* PulseBoard — Live infrastructure & system monitor dashboard */
(function(){
"use strict";
var LS_HOSTS="pulseboard.hosts.v1", LS_SET="pulseboard.settings.v1", LS_WATCH="pulseboard.watch.v1";
var POLL_DEFAULT=5000, MAX_HIST=120;

var S = {
  view:"overview", hosts:[], activeId:null, settings:{pollMs:POLL_DEFAULT, proxy:false, pauseFs:false, pauseLogs:false},
  watch:[], alerts:[], fsFilter:"all", fsQ:"", logQ:"", logLevel:"all", contQ:"", appQ:"",
  modal:null, charts:{}, pollTimers:{}
};

function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function fmtB(b){if(b==null||isNaN(b))return "-";var u=["B","KB","MB","GB","TB","PB"],i=0;while(b>=1024&&i<u.length-1){b/=1024;i++;}return (b>=100?Math.round(b):b.toFixed(1))+" "+u[i];}
function fmtBps(b){return fmtB(b)+"/s";}
function fmtUp(s){if(s==null)return "-";s=Math.floor(s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);if(d>0)return d+"d "+h+"h";if(h>0)return h+"h "+m+"m";return m+"m "+(s%60)+"s";}
function fmtT(t){try{return new Date(t).toLocaleTimeString();}catch(e){return "?";}}
function pct(v){return (v==null?"-":Number(v).toFixed(1)+"%");}
function uid(p){return (p||"h")+"-"+Math.random().toString(36).slice(2,8);}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

function createHostObj(c){
  var base=normBase(c.base||"");
  var ip=base.replace(/^https?:\/\//i,"").split("/")[0].split(":")[0]||"127.0.0.1";
  return {
    id:c.id||uid("host"),
    name:c.name||"Server",
    kind:"live",
    ip:ip,
    base:base,
    token:c.token||"",
    status:"polling",
    ms:null,
    specs:{os:"—"},
    metrics:{cpu:{usage:0,perCore:[],load1:0},mem:{pct:0,total:0,used:0},gpu:[],disk:{readBps:0,writeBps:0},net:{rxBps:0,txBps:0,ifaces:[]},uptime:0},
    hist:{cpu:[],mem:[],gpu:[],rx:[],tx:[],dio:[]},
    containers:[],
    apps:[],
    mounts:[],
    fsEvents:[],
    logs:[],
    ports:[],
    pollMs:c.pollMs||S.settings.pollMs
  };
}
function pushHist(a,v){a.push(v);if(a.length>MAX_HIST)a.shift();}

/* ---------- alerts ---------- */
function addAlert(host,msg,sev){
  S.alerts.unshift({t:Date.now(),host:host?host.name:"-",msg:msg,sev:sev||"info"});
  if(S.alerts.length>60)S.alerts.length=60;
  toast(msg,sev);
}
function toast(msg,sev){
  var w=$("toastWrap");if(!w)return;
  var d=document.createElement("div");d.className="toast "+(sev||"");
  d.textContent=msg;w.appendChild(d);
  setTimeout(function(){d.style.opacity="0";d.style.transition="opacity .4s";setTimeout(function(){d.remove();},450);},4200);
}

/* ---------- persistence ---------- */
function saveHosts(){try{localStorage.setItem(LS_HOSTS,JSON.stringify(S.hosts.filter(function(h){return h.kind==="live";}).map(function(h){return {name:h.name,base:h.base,token:h.token||"",pollMs:h.pollMs||S.settings.pollMs};})));}catch(e){}}
function loadPersist(){
  try{var s=JSON.parse(localStorage.getItem(LS_SET)||"null");if(s)Object.assign(S.settings,s);}catch(e){}
  try{var w=JSON.parse(localStorage.getItem(LS_WATCH)||"[]");if(Array.isArray(w))S.watch=w;}catch(e){}
}
function saveSettings(){try{localStorage.setItem(LS_SET,JSON.stringify(S.settings));}catch(e){}try{localStorage.setItem(LS_WATCH,JSON.stringify(S.watch));}catch(e){}}

/* ---------- live polling ---------- */
function normBase(u){
  u=(u||"").trim();if(!u)return "";
  if(!/^https?:\/\//i.test(u))u="http://"+u;
  return u.replace(/\/+$/,"");
}
function withTimeout(ms){
  var c=null;var p=new Promise(function(_,rej){c=setTimeout(function(){rej(new Error("timeout after "+ms+"ms"));},ms);});
  p.clear=function(){clearTimeout(c);};return p;
}
async function fetchSummary(host){
  var url=host.base+"/api/summary";
  var headers={};
  if(host.token)headers["Authorization"]="Bearer "+host.token;
  var ctrl=new AbortController();var to=setTimeout(function(){ctrl.abort();},9000);
  var t0=performance.now();
  try{
    var res;
    var sf = (typeof window !== "undefined" && window.superFetch) || (typeof root !== "undefined" && root.superFetch);
    if(S.settings.proxy && sf){
      res=await sf(url,{headers:headers,signal:ctrl.signal}).then(function(r){return r;});
      // superFetch returns Response-like
      var txt=await res.text();
      var ms=performance.now()-t0;
      return {data:JSON.parse(txt),ms:ms};
    }else{
      res=await fetch(url,{headers:headers,signal:ctrl.signal});
      if(!res.ok)throw new Error("HTTP "+res.status);
      var data=await res.json();
      var ms2=performance.now()-t0;
      return {data:data,ms:ms2};
    }
  }finally{clearTimeout(to);}
}
function applyLive(host,data,ms){
  host.status="online";host.ms=Math.round(ms);host.lastOk=Date.now();host.lastError=null;
  if(data.hostname&&!host._renamed)host.name=data.hostname;
  if(data.specs)host.specs=data.specs;
  host.uptime=data.uptime!=null?data.uptime:(host.uptime||0);
  host.metrics={
    t:Date.now(),
    cpu:data.cpu||{usage:0},mem:data.mem||{pct:0},gpu:data.gpu||[],
    disk:data.disk||{readBps:0,writeBps:0},net:data.net||{rxBps:0,txBps:0,ifaces:[]},
    uptime:host.uptime
  };
  pushHist(host.hist.cpu,host.metrics.cpu.usage||0);
  pushHist(host.hist.mem,host.metrics.mem.pct||0);
  pushHist(host.hist.gpu,host.metrics.gpu&&host.metrics.gpu[0]?host.metrics.gpu[0].util:0);
  pushHist(host.hist.rx,host.metrics.net.rxBps||0);
  pushHist(host.hist.tx,host.metrics.net.txBps||0);
  pushHist(host.hist.dio,((host.metrics.disk.readBps||0)+(host.metrics.disk.writeBps||0)));
  if(Array.isArray(data.containers))host.containers=data.containers;
  if(Array.isArray(data.apps))host.apps=data.apps;
  if(data.disk&&Array.isArray(data.disk.mounts))host.mounts=data.disk.mounts;
  if(Array.isArray(data.fsEvents)){data.fsEvents.slice(0,80).reverse().forEach(function(e){host.fsEvents.unshift({t:e.t||Date.now(),op:e.op||"read",path:e.path||"?",proc:e.proc||"",size:e.size||0});});if(host.fsEvents.length>500)host.fsEvents.length=500;}
  if(Array.isArray(data.logs)){data.logs.slice(0,80).reverse().forEach(function(l){host.logs.unshift({t:l.t||Date.now(),level:l.level||"info",src:l.src||"",msg:l.msg||""});});if(host.logs.length>800)host.logs.length=800;}
  if(Array.isArray(data.ports))host.ports=data.ports;
  if(data.db)host.db=data.db;
  checkThresholds(host);
}
function checkThresholds(host){
  var m=host.metrics;if(!m)return;
  if(m.mem.pct>90)addAlert(host,"High RAM on "+host.name+": "+Number(m.mem.pct).toFixed(1)+"%","bad");
  (m.gpu||[]).forEach(function(g){if(g.temp>84)addAlert(host,"GPU hot on "+host.name+" ("+(g.name||"gpu")+": "+Math.round(g.temp)+"C)","warn");});
  (host.containers||[]).forEach(function(c){if(c.state==="exited"&&!c._alerted){c._alerted=true;addAlert(host,"Container down: "+c.name+" on "+host.name,"bad");}if(c.state==="running")c._alerted=false;});
}
async function pollHost(host){
  if(host.kind!=="live"||!host.base)return;
  host.status="polling";paintHostPicker();
  try{
    var r=await fetchSummary(host);
    applyLive(host,r.data,r.ms);
  }catch(e){
    host.status="offline";host.lastError=String(e&&e.message||e);
  }
  if(S.view)render(false);
  paintHostPicker();
}
function startPolling(host){
  stopPolling(host);
  if(host.kind!=="live")return;
  pollHost(host);
  host._timer=setInterval(function(){pollHost(host);},host.pollMs||S.settings.pollMs);
}
function stopPolling(host){if(host._timer){clearInterval(host._timer);host._timer=null;}}

/* ---------- charts ---------- */
function drawLine(cv,series,opts){
  opts=opts||{};
  var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=cv.clientWidth||cv.parentElement.clientWidth||300;
  var h=cv.clientHeight||110;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);}
  var ctx=cv.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  var max=opts.max!=null?opts.max:Math.max.apply(null,series.concat([opts.min||0,1]))*1.15;
  var min=opts.min!=null?opts.min:0;
  if(max<=min)max=min+1;
  // grid
  ctx.strokeStyle="rgba(148,163,184,.14)";ctx.lineWidth=1;
  for(var g=0;g<=3;g++){var y=6+(h-12)*g/3;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  if(!series.length)return;
  ctx.beginPath();
  var n=series.length;
  for(var i=0;i<n;i++){
    var x=n===1?w-2:4+(w-8)*i/(Math.max(1,(opts.span||MAX_HIST)-1));
    // align right: show last `span` points
    var v=series[clamp(i,0,n-1)];
    var yy=h-6-((clamp(v,min,max)-min)/(max-min))*(h-12);
    if(i===0)ctx.moveTo(x,yy);else ctx.lineTo(x,yy);
  }
  var grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,opts.fill||"rgba(34,211,238,.30)");grad.addColorStop(1,"rgba(34,211,238,0)");
  ctx.save();
  ctx.lineTo(w,h);ctx.lineTo(4,h);ctx.closePath();
  ctx.fillStyle=grad;ctx.fill();ctx.restore();
  // stroke again
  ctx.beginPath();
  for(var j=0;j<n;j++){
    var x2=n===1?w-2:4+(w-8)*j/(Math.max(1,(opts.span||MAX_HIST)-1));
    var v2=series[clamp(j,0,n-1)];
    var y2=h-6-((clamp(v2,min,max)-min)/(max-min))*(h-12);
    if(j===0)ctx.moveTo(x2,y2);else ctx.lineTo(x2,y2);
  }
  ctx.strokeStyle=opts.color||"#22d3ee";ctx.lineWidth=2;ctx.shadowColor=opts.color||"#22d3ee";ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;
  // last dot
  var lx=w-4,lv=series[n-1];
  var ly=h-6-((clamp(lv,min,max)-min)/(max-min))*(h-12);
  ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(lx,ly,3,0,7);ctx.fill();
  if(opts.label!=null){ctx.fillStyle="#93a1bd";ctx.font="10px monospace";ctx.fillText(opts.label,6,12);}
}

/* ---------- views ---------- */
function activeHost(){
  return S.hosts.find(function(h){return h.id===S.activeId;})||S.hosts[0];
}
function allFs(){
  var out=[];
  S.hosts.forEach(function(h){(h.fsEvents||[]).forEach(function(e){out.push(Object.assign({host:h.name},e));});});
  out.sort(function(a,b){return b.t-a.t;});return out.slice(0,300);
}
function allLogs(){
  var out=[];
  S.hosts.forEach(function(h){(h.logs||[]).forEach(function(l){out.push(Object.assign({host:h.name},l));});});
  out.sort(function(a,b){return b.t-a.t;});return out.slice(0,400);
}
function statusBadge(st){
  if(st==="running"||st==="online"||st==="open")return '<span class="badge ok">● '+esc(st)+'</span>';
  if(st==="degraded"||st==="paused")return '<span class="badge warn">● '+esc(st)+'</span>';
  return '<span class="badge bad">● '+esc(st)+'</span>';
}
function opBadge(op){
  var c={read:"fs-read",write:"fs-write",edit:"fs-edit",delete:"fs-delete"}[op]||"";
  return '<b class="'+c+'">'+esc(op).toUpperCase()+'</b>';
}

function render(full){
  var h=activeHost();if(!h)return;
  paintNav();paintHostPicker();tickClock();
  var el=$("viewCtn");if(!el)return;
  if(S.view==="overview")el.innerHTML=vOverview(h);
  else if(S.view==="systems")el.innerHTML=vSystems(h);
  else if(S.view==="perf")el.innerHTML=vPerf(h);
  else if(S.view==="network")el.innerHTML=vNetwork(h);
  else if(S.view==="fs")el.innerHTML=vFs(h);
  else if(S.view==="apps")el.innerHTML=vApps(h);
  else if(S.view==="docker")el.innerHTML=vDocker(h);
  else if(S.view==="logs")el.innerHTML=vLogs(h);
  else if(S.view==="setup")el.innerHTML=vSetup(h);
  afterRender(h);
  if(full){el.classList.remove("enter");void el.offsetWidth;el.classList.add("enter");clearTimeout(el._et);el._et=setTimeout(function(){el.classList.remove("enter");},650);}
}
function tickClock(){var c=$("liveClock");if(c){try{c.textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){}}}
function afterRender(h){
  // draw charts
  document.querySelectorAll("canvas[data-hist]").forEach(function(cv){
    var key=cv.getAttribute("data-hist");
    var hid=cv.getAttribute("data-host")||h.id;
    var host=S.hosts.find(function(x){return x.id===hid;})||h;
    var series=(host.hist&&host.hist[key])||[];
    var isNet=(key==="rx"||key==="tx"||key==="dio");
    if(key==="tx")drawLine(cv,series.slice(-MAX_HIST),{color:"#60a5fa",fill:"rgba(96,165,250,.28)"});
    else if(key==="dio")drawLine(cv,series.slice(-MAX_HIST),{color:"#a78bfa",fill:"rgba(167,139,250,.28)"});
    else if(key==="rx")drawLine(cv,series.slice(-MAX_HIST),{color:"#22d3ee",fill:"rgba(34,211,238,.28)"});
    else drawLine(cv,series.slice(-MAX_HIST),{max:100,color:key==="mem"?"#a78bfa":key==="gpu"?"#34d399":"#22d3ee",fill:key==="mem"?"rgba(167,139,250,.28)":key==="gpu"?"rgba(52,211,153,.28)":"rgba(34,211,238,.28)"});
  });
  var ov=document.querySelector("canvas[data-multi]");
  if(ov){
    var host2=S.hosts.find(function(x){return x.id===ov.getAttribute("data-host");})||h;
    drawMulti(ov,host2);
  }
}
function drawMulti(cv,host){
  var dpr=Math.min(2,window.devicePixelRatio||1);
  var w=cv.clientWidth||600,h=170;
  if(cv.width!==Math.round(w*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);}
  var ctx=cv.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle="rgba(148,163,184,.14)";for(var g=0;g<=3;g++){var y=6+(h-12)*g/3;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  var defs=[{k:"cpu",c:"#22d3ee"},{k:"mem",c:"#a78bfa"},{k:"gpu",c:"#34d399"}];
  defs.forEach(function(d){
    var s=(host.hist[d.k]||[]).slice(-MAX_HIST);if(!s.length)return;
    ctx.beginPath();
    for(var i=0;i<s.length;i++){var x=4+(w-8)*i/(MAX_HIST-1);var yy=h-6-(clamp(s[i],0,100)/100)*(h-12);if(i===0)ctx.moveTo(x,yy);else ctx.lineTo(x,yy);}
    ctx.strokeStyle=d.c;ctx.lineWidth=1.6;ctx.stroke();
  });
  ctx.fillStyle="#93a1bd";ctx.font="10px monospace";ctx.fillText("CPU —   MEM —   GPU —  (%, last "+MAX_HIST+" samples)",6,12);
}

function hostHealthLine(h){
  var m=h.metrics||{};
  return '<span class="hostLine"><span class="connDot">'+(h.status==="online"?'<span class="dot ok"></span>':'<span class="dot bad"></span>')+'</span> '+
    '<span class="hostName">'+esc(h.name)+'</span> <span class="chip">'+esc(h.ip||"")+'</span>'+(h.base?'<span class="chip">'+esc(h.base)+'</span>':'')+(h.ms!=null?'<span class="chip">'+h.ms+'ms</span>':"")+' '+
    (h.status!=="online"?'<span class="badge bad">● '+esc(h.status)+'</span>':'<span class="badge ok">● live</span>')+'</span>';
}

function vOverview(h){
  var m=h.metrics;
  var contRun=h.containers.filter(function(c){return c.state==="running";}).length;
  var appsRun=h.apps.filter(function(a){return a.status==="running";}).length;
  var alerts=S.alerts.slice(0,5).map(function(a){
    return '<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a2436"><span>'+esc(a.msg)+'</span><span class="muted small">'+fmtT(a.t)+'</span></div>';
  }).join("")||'<div class="muted small">No alerts. Thresholds: RAM &gt; 90%, GPU temp &gt; 84°C, container exits.</div>';
  var cards=S.hosts.map(function(x){
    var xm=x.metrics||{cpu:{},mem:{},gpu:[]};
    return '<div class="card"><h3>'+esc(x.name)+' · '+esc(x.ip||"")+'</h3>'+
    '<div class="row" style="justify-content:space-between"><span class="big">'+pct(xm.cpu.usage)+'</span>'+statusBadge(x.status)+'</div>'+
    '<div class="sub">CPU · RAM '+pct(xm.mem.pct)+' · GPU '+(xm.gpu&&xm.gpu[0]?pct(xm.gpu[0].util):"—")+'</div>'+
    '<div class="bar'+(xm.cpu.usage>85?"bad":xm.cpu.usage>65?"warn":"")+'"><i style="width:'+clamp(xm.cpu.usage||0,0,100)+'%"></i></div>'+
    '<div class="row" style="margin-top:8px"><button class="btn sm" data-act="focus" data-id="'+x.id+'">Open</button>'+
    '<span class="muted small">'+x.containers.filter(function(c){return c.state==="running";}).length+'/'+x.containers.length+' containers · '+x.apps.filter(function(a){return a.status==="running";}).length+'/'+x.apps.length+' apps</span></div></div>';
  }).join("");
  return ''+
  '<div class="viewHead"><h2>Overview</h2><p>'+hostHealthLine(h)+' — All hosts, live health, and recent alerts. Switch host with the picker above.</p></div>'+
  '<div class="alertStrip">'+S.hosts.map(function(x){return '<span class="badge '+(x.status==="online"?"ok":"bad")+'">'+esc(x.name)+' '+(x.status==="online"?"●":"○")+'</span>';}).join("")+'</div>'+
  '<div class="grid g4">'+
    '<div class="card"><h3>CPU · '+esc(h.name)+'</h3><div class="big">'+pct(m.cpu.usage)+'</div><div class="sub">'+esc(h.specs.cpuModel||"")+' · '+m.cpu.load1?.toFixed?.(1)+' load</div><canvas class="chart" data-hist="cpu"></canvas></div>'+
    '<div class="card"><h3>RAM live</h3><div class="big">'+pct(m.mem.pct)+'</div><div class="sub">'+fmtB(m.mem.used)+' / '+fmtB(m.mem.total)+'</div><canvas class="chart" data-hist="mem"></canvas></div>'+
    '<div class="card"><h3>GPU live</h3><div class="big">'+(m.gpu&&m.gpu[0]?pct(m.gpu[0].util):"—")+'</div><div class="sub">'+esc(m.gpu&&m.gpu[0]?m.gpu[0].name:"no gpu")+(m.gpu&&m.gpu[0]?" · "+Math.round(m.gpu[0].temp)+"°C":"")+'</div><canvas class="chart" data-hist="gpu"></canvas></div>'+
    '<div class="card"><h3>Network throughput</h3><div class="big" style="font-size:15px">↓ '+fmtBps(m.net.rxBps)+'<br>↑ '+fmtBps(m.net.txBps)+'</div><div class="sub">uptime '+fmtUp(m.uptime)+' · disk IO '+fmtBps((m.disk.readBps||0)+(m.disk.writeBps||0))+'</div><canvas class="chart" data-hist="rx"></canvas></div>'+
  '</div>'+
  '<div class="grid g2" style="margin-top:12px">'+
    '<div class="card"><h3>All hosts</h3><div class="grid g2">'+cards+'</div></div>'+
    '<div class="card"><h3>CPU / MEM / GPU combined — '+esc(h.name)+'</h3><canvas class="chart tall" data-multi="1" data-host="'+h.id+'"></canvas>'+
    '<hr class="sep"><h3>Recent alerts</h3>'+alerts+'</div>'+
  '</div>'+
  '<div class="grid g3" style="margin-top:12px">'+
    '<div class="card"><h3>Containers</h3><div class="big">'+contRun+' / '+h.containers.length+'</div><div class="sub">running on '+esc(h.name)+'</div></div>'+
    '<div class="card"><h3>Applications</h3><div class="big">'+appsRun+' / '+h.apps.length+'</div><div class="sub">node · python · system ports reporting</div></div>'+
    '<div class="card"><h3>Filesystem events (buffered)</h3><div class="big">'+h.fsEvents.length+'</div><div class="sub">read / write / edit / delete — see Filesystem tab</div></div>'+
  '</div>';
}

function vSystems(h){
  var s=h.specs,m=h.metrics;
  var gpuRows=m.gpu.map(function(g){
    return '<tr><td>'+esc(g.name)+'</td><td class="mono">'+pct(g.util)+'</td><td class="mono">'+fmtB(g.memUsed)+' / '+fmtB(g.memTotal)+'</td><td class="mono">'+Math.round(g.temp)+'°C</td><td class="mono">'+Math.round(g.power||0)+'W · '+Math.round(g.fan||0)+'%</td></tr>';
  }).join("")||'<tr><td colspan="5" class="muted">No GPU reported. Collector sends nvidia-smi / rocm-smi data here.</td></tr>';
  var mounts=h.mounts.map(function(d){
    return '<div class="row" style="justify-content:space-between"><span class="mono">'+esc(d.mount)+' <span class="muted">'+esc(d.dev||"")+'</span></span><span class="mono">'+pct(d.pct)+'</span></div><div class="bar'+(d.pct>90?"bad":d.pct>75?"warn":"")+'"><i style="width:'+clamp(d.pct,0,100)+'%"></i></div>';
  }).join("");
  return '<div class="viewHead"><h2>System specs</h2><p>'+hostHealthLine(h)+'</p></div>'+
  '<div class="grid g2"><div class="card"><h3>Specs</h3><div class="kv">'+
  '<b>Hostname</b><span class="mono">'+esc(h.name)+'</span>'+
  '<b>OS / kernel</b><span>'+esc(s.os||"-")+' · '+esc(s.kernel||"")+'</span>'+
  '<b>Arch</b><span class="mono">'+esc(s.arch||"")+'</span>'+
  '<b>CPU</b><span>'+esc(s.cpuModel||"")+' ('+(s.cpuCores||"?")+' cores)</span>'+
  '<b>RAM total</b><span class="mono">'+fmtB(s.memTotal||(m.mem&&m.mem.total))+'</span>'+
  '<b>Uptime</b><span class="mono">'+fmtUp(m.uptime)+'</span>'+
  '<b>Collector</b><span class="mono">'+esc(h.base||"local")+'</span>'+
  (h.db?'<b>Database</b><span class="mono">'+(h.db.connected?'<span class="badge ok">● MongoDB connected</span>':'<span class="badge info">○ MongoDB disabled / memory mode</span>')+'</span>':"")+
  '</div></div>'+
  '<div class="card"><h3>Filesystems</h3>'+mounts+'<div class="sub" style="margin-top:8px">Disk IO now: ↓ '+fmtBps(m.disk.readBps)+' ↑ '+fmtBps(m.disk.writeBps)+'</div><canvas class="chart" data-hist="dio"></canvas></div></div>'+
  '<div class="card" style="margin-top:12px"><h3>GPUs — live</h3><table class="tbl"><tr><th>GPU</th><th>Util</th><th>VRAM</th><th>Temp</th><th>Power / fan</th></tr>'+gpuRows+'</table>'+
  '<div class="sub">Collectors read <code class="inline">nvidia-smi</code> every 2s (AMD: <code class="inline">rocm-smi</code>, fallback: synthetic). Each GPU gets util / memory / temp / power.</div></div>';
}

function vPerf(h){
  var m=h.metrics;
  var cores=(m.cpu.perCore||[]).map(function(v,i){return '<div class="row" style="gap:6px"><span class="mono muted" style="width:52px">cpu'+i+'</span><div class="bar" style="flex:1;margin:0"><i style="width:'+clamp(v,0,100)+'%"></i></div><span class="mono" style="width:52px;text-align:right">'+Math.round(v)+'%</span></div>';}).join("");
  return '<div class="viewHead"><h2>Performance</h2><p>'+hostHealthLine(h)+' — per-core CPU, memory, GPU and IO history.</p></div>'+
  '<div class="grid g2"><div class="card"><h3>CPU '+pct(m.cpu.usage)+' · '+esc(h.specs.cpuModel||"")+'</h3><canvas class="chart tall" data-hist="cpu"></canvas><div style="margin-top:8px;max-height:190px;overflow:auto">'+cores+'</div></div>'+
  '<div class="card"><h3>Memory '+pct(m.mem.pct)+' ('+fmtB(m.mem.used)+' / '+fmtB(m.mem.total)+')</h3><canvas class="chart tall" data-hist="mem"></canvas><div class="kv" style="margin-top:8px"><b>Swap</b><span class="mono">'+fmtB(m.mem.swapUsed)+' / '+fmtB(m.mem.swapTotal)+'</span><b>CPU temp</b><span class="mono">'+Math.round(m.cpu.temp||0)+'°C</span><b>Load 1m</b><span class="mono">'+(m.cpu.load1||0)+'</span></div></div></div>'+
  '<div class="grid g2" style="margin-top:12px"><div class="card"><h3>Network ↓ '+fmtBps(m.net.rxBps)+' ↑ '+fmtBps(m.net.txBps)+'</h3><canvas class="chart tall" data-hist="rx"></canvas><div class="sub">TX series overlays on the Network tab.</div></div>'+
  '<div class="card"><h3>Disk IO '+fmtBps((m.disk.readBps||0)+(m.disk.writeBps||0))+'</h3><canvas class="chart tall" data-hist="dio"></canvas><div class="sub">read '+fmtBps(m.disk.readBps)+' · write '+fmtBps(m.disk.writeBps)+'</div></div></div>';
}

function vNetwork(h){
  var m=h.metrics;
  var ifaces=(m.net.ifaces||[]).map(function(n){return '<tr><td class="mono">'+esc(n.name)+'</td><td class="mono">'+esc(n.ip||"")+'</td><td class="mono">↓ '+fmtBps(n.rxBps||m.net.rxBps)+'</td><td class="mono">↑ '+fmtBps(n.txBps||m.net.txBps)+'</td></tr>';}).join("")||'<tr><td colspan="4" class="muted">No interfaces reported.</td></tr>';
  var ports=(h.ports||[]).map(function(p){
    return '<tr><td class="mono">'+esc(p.ip||h.ip)+':'+p.port+'</td><td>'+esc(p.service||"")+' <span class="muted">'+esc(p.proto||"tcp")+'</span></td><td>'+(p.open?'<span class="badge ok">open</span>':'<span class="badge bad">closed</span>')+'</td><td class="mono">'+(p.ms!=null?p.ms+" ms":"—")+'</td></tr>';
  }).join("");
  var watch=S.watch.map(function(w,i){return '<tr><td class="mono">'+esc(w.host)+':'+esc(w.port)+'</td><td>'+esc(w.label||"")+'</td><td><button class="btn sm" data-act="unwatch" data-i="'+i+'">remove</button></td></tr>';}).join("")||'<tr><td colspan="3" class="muted">No watched ports yet. Add IP + port below (e.g. your Node :3000 or Python :8000).</td></tr>';
  return '<div class="viewHead"><h2>Network</h2><p>'+hostHealthLine(h)+' — interfaces, per-IP port checks, and your watchlist.</p></div>'+
  '<div class="grid g2"><div class="card"><h3>Throughput</h3><canvas class="chart tall" data-hist="rx"></canvas><div class="sub">↓ RX '+fmtBps(m.net.rxBps)+' · ↑ TX '+fmtBps(m.net.txBps)+' (collector measures per-interface bytes/s)</div></div>'+
  '<div class="card"><h3>Interfaces</h3><table class="tbl"><tr><th>iface</th><th>ip</th><th>rx</th><th>tx</th></tr>'+ifaces+'</table></div></div>'+
  '<div class="grid g2" style="margin-top:12px"><div class="card"><h3>Ports served by '+esc(h.name)+'</h3><table class="tbl"><tr><th>ip:port</th><th>service</th><th>state</th><th>rtt</th></tr>'+ports+'</table>'+
  '<div class="toolbar" style="margin-top:10px"><button class="btn sm" data-act="checkPorts">re-check now</button><span class="muted small">Browser can only HTTP-fetch; collectors do real TCP connects and report here.</span></div></div>'+
  '<div class="card"><h3>Watchlist (persists locally)</h3><table class="tbl"><tr><th>ip:port</th><th>label</th><th></th></tr>'+watch+'</table>'+
  '<div class="toolbar" style="margin-top:10px"><input id="watchHostInput" placeholder="192.168.1.20" style="width:140px"><input id="watchPortInput" placeholder="3000" style="width:80px"><input id="watchLabelInput" placeholder="api-gateway (node)" style="flex:1"><button class="btn sm primary" data-act="addWatch">watch</button></div>'+
  '<div class="sub">Tip: for LAN <code class="inline">http://</code> hosts, browsers block <code class="inline">https → http</code> polling. Expose the collector via Cloudflare Tunnel / ngrok / Tailscale-serve to get an <code class="inline">https://</code> URL, then add it as a host. See Setup tab.</div></div></div>';
}

function vFs(h){
  var evs=h.fsEvents||[];
  var q=S.fsQ.toLowerCase();
  var list=evs.filter(function(e){
    if(S.fsFilter!=="all"&&e.op!==S.fsFilter)return false;
    if(q&&(e.path||"").toLowerCase().indexOf(q)<0&&(e.proc||"").toLowerCase().indexOf(q)<0)return false;
    return true;
  }).slice(0,200);
  var counts={read:0,write:0,edit:0,delete:0};
  evs.forEach(function(e){if(counts[e.op]!=null)counts[e.op]++;});
  var rows=list.map(function(e){return '<tr><td class="mono muted">'+fmtT(e.t)+'</td><td>'+opBadge(e.op)+'</td><td class="mono">'+esc(e.path)+'</td><td class="muted">'+esc(e.proc||"")+'</td><td class="mono">'+(e.size?fmtB(e.size):"—")+'</td></tr>';}).join("")||'<tr><td colspan="5" class="muted">No events match. Live agents stream fs events here (chokidar / watchdog).</td></tr>';
  return '<div class="viewHead"><h2>Filesystem access</h2><p>'+hostHealthLine(h)+' — every read / write / edit / delete reported by the collector\'s file watcher.</p></div>'+
  '<div class="grid g4">'+["read","write","edit","delete"].map(function(k){return '<div class="card"><h3>'+k+'s (buffered)</h3><div class="big">'+counts[k]+'</div></div>';}).join("")+'</div>'+
  '<div class="card" style="margin-top:12px"><div class="toolbar">'+
  '<select id="fsFilterSel"><option value="all">all ops</option><option value="read">read</option><option value="write">write</option><option value="edit">edit</option><option value="delete">delete</option></select>'+
  '<input id="fsQInput" placeholder="filter path or process…" value="'+esc(S.fsQ)+'">'+
  '<button class="btn sm" data-act="pauseFs">'+(S.settings.pauseFs?"resume feed":"pause feed")+'</button>'+
  '<span class="muted small">'+evs.length+' buffered · watch paths configured in collector (default: /srv, /etc, /var/log, /data)</span></div>'+
  '<div style="max-height:460px;overflow:auto"><table class="tbl"><tr><th>time</th><th>op</th><th>path</th><th>process</th><th>size</th></tr>'+rows+'</table></div></div>';
}

function vApps(h){
  var q=S.appQ.toLowerCase();
  var list=h.apps.filter(function(a){return !q||(a.name||"").toLowerCase().includes(q)||String(a.port).includes(q);});
  var rows=list.map(function(a){
    var link=a.port?'<a href="http://'+esc(a.ip||h.ip)+':'+a.port+'" target="_blank" rel="noopener">open</a>':"";
    return '<tr><td><b>'+esc(a.name)+'</b><br><span class="muted small mono">'+esc(a.cmd||"")+'</span></td>'+
    '<td><span class="badge info">'+esc(a.type||"app")+'</span></td>'+
    '<td class="mono">'+esc(a.ip||h.ip)+':'+a.port+'</td><td>'+statusBadge(a.status)+'</td>'+
    '<td class="mono">'+fmtUp(a.uptime)+'</td><td class="mono">'+(a.cpu!=null?a.cpu.toFixed(1)+"%":"—")+' · '+(a.mem!=null?a.mem.toFixed(1)+"%":"—")+'</td>'+
    '<td class="mono">'+(a.latencyMs!=null?a.latencyMs+" ms":"—")+'</td>'+
    '<td><div class="row">'+link+' <button class="btn sm" data-act="appLogs" data-id="'+a.id+'">logs</button></div></td></tr>';
  }).join("")||'<tr><td colspan="8" class="muted">No apps. Collector auto-discovers node/python processes + listening ports.</td></tr>';
  return '<div class="viewHead"><h2>Applications</h2><p>'+hostHealthLine(h)+' — Node, Python and system services per IP:port, with status, uptime and latency.</p></div>'+
  '<div class="card"><div class="toolbar"><input id="appQInput" placeholder="search name or port…" value="'+esc(S.appQ)+'"><button class="btn sm" data-act="checkPorts">probe http now</button><span class="muted small">probes do an HTTP GET and time it; non-HTTP ports are reported by the collector\'s TCP check.</span></div>'+
  '<div style="overflow:auto"><table class="tbl"><tr><th>app / cmd</th><th>type</th><th>ip:port</th><th>status</th><th>uptime</th><th>cpu / mem</th><th>rtt</th><th></th></tr>'+rows+'</table></div></div>';
}

function vDocker(h){
  var q=S.contQ.toLowerCase();
  var list=h.containers.filter(function(c){return !q||(c.name||"").toLowerCase().includes(q)||(c.image||"").toLowerCase().includes(q);});
  var cards=list.map(function(c){
    return '<div class="card"><div class="row" style="justify-content:space-between"><b class="mono">'+esc(c.name)+'</b>'+statusBadge(c.state)+'</div>'+
    '<div class="muted small mono">'+esc(c.image)+'</div>'+
    '<div class="kv" style="margin-top:8px"><b>CPU</b><span class="mono">'+(c.cpu!=null?c.cpu.toFixed(1)+"%":"—")+'</span>'+
    '<b>MEM</b><span class="mono">'+fmtB(c.memUsed)+' / '+fmtB(c.memLimit)+'</span>'+
    '<b>NET</b><span class="mono">↓ '+fmtB(c.netRx)+' ↑ '+fmtB(c.netTx)+'</span>'+
    '<b>Ports</b><span class="mono">'+esc(c.ports||"—")+'</span>'+
    '<b>Status</b><span>'+esc(c.status||"")+' · restarts '+(c.restartCount||0)+'</span></div>'+
    '<div class="row" style="margin-top:10px"><button class="btn sm" data-act="contLogs" data-id="'+c.id+'">logs</button>'+
    '<button class="btn sm" data-act="contRestart" data-id="'+c.id+'">restart</button></div></div>';
  }).join("")||'<div class="card muted">No containers match. Live hosts report via the Docker socket.</div>';
  return '<div class="viewHead"><h2>Docker</h2><p>'+hostHealthLine(h)+' — every container with status, resources and logs.</p></div>'+
  '<div class="toolbar"><input id="contQInput" placeholder="search containers…" value="'+esc(S.contQ)+'" style="min-width:220px"><span class="muted small">'+h.containers.filter(function(c){return c.state==="running";}).length+' running / '+h.containers.length+' total</span></div>'+
  '<div class="contGrid">'+cards+'</div>';
}

function vLogs(h){
  var all=allLogs();
  var q=S.logQ.toLowerCase();
  var list=all.filter(function(l){
    if(S.logLevel!=="all"&&l.level!==S.logLevel)return false;
    if(q&&((l.msg||"").toLowerCase().indexOf(q)<0&&(l.src||"").toLowerCase().indexOf(q)<0&&(l.host||"").toLowerCase().indexOf(q)<0))return false;
    return true;
  }).slice(0,250);
  var html=list.map(function(l){
    return '<div class="logLine"><span class="t">'+fmtT(l.t)+' · '+esc(l.host)+' · '+esc(l.src)+'</span> <span class="lv-'+l.level+'">['+l.level+']</span> '+esc(l.msg)+'</div>';
  }).join("")||'<div class="muted">No logs match.</div>';
  return '<div class="viewHead"><h2>Logs</h2><p>Aggregated across hosts, containers and apps. Live hosts tail via the collector.</p></div>'+
  '<div class="card"><div class="toolbar"><select id="logLevelSel"><option value="all">all levels</option><option value="debug">debug</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option></select>'+
  '<input id="logQInput" placeholder="search logs…" value="'+esc(S.logQ)+'"><button class="btn sm" data-act="pauseLogs">'+(S.settings.pauseLogs?"resume":"pause")+'</button>'+
  '<button class="btn sm" data-act="dlLogs">download .log</button></div>'+
  '<div class="logBox" id="aggLogBox">'+html+'</div></div>';
}

function vSetup(h){
  var live=S.hosts.filter(function(x){return x.kind==="live";});
  var liveRows=live.map(function(x){
    return '<tr><td><b>'+esc(x.name)+'</b><br><span class="muted small mono">'+esc(x.base)+'</span>'+(x.lastError?'<br><span class="badge bad">'+esc(x.lastError).slice(0,120)+'</span>':"")+'</td><td>'+statusBadge(x.status)+'</td><td class="mono">'+(x.ms!=null?x.ms+" ms":"—")+'</td><td><div class="row"><button class="btn sm" data-act="pollNow" data-id="'+x.id+'">poll</button><button class="btn sm" data-act="editHost" data-id="'+x.id+'">edit</button><button class="btn sm danger" data-act="delHost" data-id="'+x.id+'">delete</button></div></td></tr>';
  }).join("")||'<tr><td colspan="4" class="muted">No hosts connected yet. Add your VPS or server collector URL below.</td></tr>';
  return '<div class="viewHead"><h2>Agents & setup</h2><p>Run a collector on each machine you want to monitor. It exposes <code class="inline">/api/summary</code> JSON; this dashboard polls it. Nothing to install here.</p></div>'+
  '<div class="grid g2"><div class="card"><h3>Live hosts</h3><table class="tbl"><tr><th>host</th><th>status</th><th>rtt</th><th></th></tr>'+liveRows+'</table>'+
  '<div class="toolbar" style="margin-top:10px"><button class="btn sm primary" data-act="addHost">+ add host (IP / URL)</button><button class="btn sm" data-act="pasteJson">paste collector JSON</button><button class="btn sm" data-act="exportCfg">export</button><button class="btn sm" data-act="importCfg">import</button></div>'+
  '<div class="toolbar"><input id="pollMsInput" placeholder="poll ms" value="'+S.settings.pollMs+'" style="width:100px"><button class="btn sm" data-act="savePoll">set interval</button>'+
  '<button class="btn sm" data-act="toggleProxy">'+(S.settings.proxy?"proxy: ON (superFetch)":"proxy: OFF (direct)")+'</button></div>'+
  '<div class="sub">Direct mode: browser → collector (needs CORS *, collectors send it). Proxy mode: Perchance server → collector (fixes CORS, but can\'t reach LAN IPs — use it for public https URLs).</div></div>'+
  '<div class="card"><h3>Quick start</h3><ol class="steps">'+
  '<li>On the machine to monitor: <code>node src/agent/node-collector.js --port 9100 --token SECRET</code> (or <code>python3 src/agent/python-collector.py</code>).</li>'+
  '<li>Check <code>curl localhost:9100/api/summary</code> returns JSON.</li>'+
  '<li>For remote access expose it: <code>cloudflared tunnel --url http://localhost:9100</code> → copy the <code>https://…</code> URL.</li>'+
  '<li>Here: <b>+ add host</b> → paste the URL + token. Done — specs, RAM/GPU, fs events, apps, docker appear.</li>'+
  '<li>Docker: mount <code>/var/run/docker.sock</code> or run the collector with docker CLI available.</li>'+
  '</ol><div class="toolbar"><a class="btn sm" href="src/agent/node-collector.js" download>download node collector</a><a class="btn sm" href="src/agent/python-collector.py" download>download python collector</a></div>'+
  '<div class="sub">Collectors are dependency-free by default (optional <code class="inline">psutil/docker</code> in Python for richer data, <code class="inline">nvidia-smi</code> for GPUs).</div></div></div>'+
  '<div class="card" style="margin-top:12px"><h3>Collector API schema (what /api/summary returns)</h3><pre class="code">GET /api/summary  →  { hostname, uptime, specs:{os,kernel,arch,cpuModel,cpuCores,memTotal,gpus,disks,nics},\n  cpu:{usage,perCore,temp,load1}, mem:{total,used,pct,swapTotal,swapUsed},\n  gpu:[{index,name,util,memUsed,memTotal,temp,power,fan}],\n  disk:{mounts:[{mount,dev,total,used,pct}],readBps,writeBps},\n  net:{rxBps,txBps,ifaces:[{name,ip,rxBps,txBps}]},\n  apps:[{id,name,type,ip,port,status,uptime,cpu,mem,latencyMs,cmd}],\n  containers:[{id,name,image,state,status,cpu,memUsed,memLimit,netRx,netTx,ports,uptime,restartCount}],\n  fsEvents:[{t,op,path,proc,size}], logs:[{t,level,src,msg}], ports:[{port,ip,proto,service,open,ms}] }\nGET /api/logs?container=NAME&amp;tail=200   POST /api/containers/:id/restart (Bearer token)</pre>'+
  '<div class="sub">Mixed-content note: an <code class="inline">https://</code> dashboard cannot poll <code class="inline">http://192.168.x.x</code> (browser blocks it). Use an https tunnel URL, Tailscale-serve with certs, or run the dashboard itself over http on your LAN. Paste-JSON mode always works offline.</div></div>';
}

/* ---------- nav / chrome ---------- */
var NAVMETA={
overview:{label:"Overview",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/></svg>'},
systems:{label:"Systems",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/></svg>'},
perf:{label:"Performance",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>'},
network:{label:"Network",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.3 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.3-3.9-8.5s1.3-6.1 3.9-8.5z"/></svg>'},
fs:{label:"Filesystem",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>'},
apps:{label:"Apps",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5 20.5 8 12 12.5 3.5 8z"/><path d="M3.5 12.5 12 17l8.5-4.5"/></svg>'},
docker:{label:"Docker",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/></svg>'},
logs:{label:"Logs",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 3-3 3M12.5 15.5H17"/></svg>'},
setup:{label:"Agents",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/></svg>'}
};
var NAVGROUPS=[["Observe",["overview"]],["Measure",["systems","perf","network"]],["Inspect",["fs","apps","docker","logs"]],["Configure",["setup"]]];
function paintNav(){
  var n=$("sideNav");if(!n)return;
  var html="";
  NAVGROUPS.forEach(function(g){
    html+='<div class="navSec">'+g[0]+'</div>';
    g[1].forEach(function(id){
      var m=NAVMETA[id];
      html+='<button class="navBtn'+(S.view===id?" on":"")+'" data-nav="'+id+'"><span class="ico">'+m.icon+'</span>'+m.label+'</button>';
    });
  });
  n.innerHTML=html;
}
function paintHostPicker(){
  var sel=$("hostSel");if(!sel)return;
  sel.innerHTML=S.hosts.map(function(h){return '<option value="'+h.id+'"'+(h.id===S.activeId?" selected":"")+'>'+esc(h.name)+' '+(h.status==="online"?"●":"○")+'</option>';}).join("");
  var b=$("connBadge");
  if(b){var h=activeHost();b.innerHTML=h?(h.status==="online"?'<span class="badge ok">● live</span>':'<span class="badge bad">● '+esc(h.status)+'</span>'):"";}
}

/* ---------- modal ---------- */
function openModal(html){
  closeModal();
  var w=document.createElement("div");w.className="dlgWrap";w.id="dlgWrap";
  w.innerHTML='<div class="dlg">'+html+'</div>';
  w.addEventListener("click",function(e){if(e.target===w)closeModal();});
  document.body.appendChild(w);
}
function closeModal(){var w=$("dlgWrap");if(w)w.remove();}
function modalAddHost(edit){
  var h=edit||{name:"",base:"",token:""};
  openModal('<h3>'+(edit?"Edit host":"Add host — collector URL")+'</h3>'+
  '<label>Name</label><input id="mName" value="'+esc(h.name||"")+'" placeholder="homelab-server">'+
  '<label>Collector base URL (IP:port or https tunnel URL)</label><input id="mBase" value="'+esc(h.base||"")+'" placeholder="https://abc.trycloudflare.com  or  192.168.1.20:9100">'+
  '<label>Token (must match --token on the collector, else blank)</label><input id="mToken" value="'+esc(h.token||"")+'" placeholder="optional">'+
  '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn" data-act="closeModal">cancel</button> <button class="btn primary" data-act="saveHost" data-id="'+(edit?edit.id:"")+'">save & poll</button></div>'+
  '<p class="muted small">The collector exposes <code class="inline">/api/summary</code>. Examples: <code class="inline">192.168.1.20:9100</code>, <code class="inline">http://10.0.0.5:9100</code>, <code class="inline">https://xyz.ngrok.io</code>.</p>');
}
function modalPaste(){
  openModal('<h3>Paste collector JSON</h3><p class="muted small">Paste the output of <code class="inline">/api/summary</code> (e.g. copied from curl). It becomes/updates a live-shaped host instantly — handy when the browser can\'t reach the machine.</p>'+
  '<textarea id="mJson" rows="10" placeholder=\'{"hostname":"…","specs":{…}}\'></textarea>'+
  '<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-act="closeModal">cancel</button> <button class="btn primary" data-act="doPaste">import</button></div>');
}
function modalLogs(title,lines){
  var html=(lines||[]).slice(-300).map(function(l){
    if(typeof l==="string")return esc(l);
    return '<div class="logLine"><span class="t">'+fmtT(l.t)+'</span> <span class="lv-'+(l.level||"info")+'">['+(l.level||"info")+']</span> '+esc(l.msg||"")+'</div>';
  }).join("")||'<div class="muted">No log lines.</div>';
  openModal('<h3 class="mono" style="font-size:14px">'+esc(title)+'</h3><div class="logBox" style="max-height:50vh">'+html+'</div>'+
  '<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-act="closeModal">close</button></div>');
}

/* ---------- actions ---------- */
async function probeHttp(host,app){
  var url="http://"+(app.ip||host.ip)+":"+app.port+"/";
  var t0=performance.now();
  try{
    await fetch(url,{mode:"no-cors",signal:AbortSignal.timeout(6000)});
    app.latencyMs=Math.round(performance.now()-t0);
    if(app.status==="stopped"){app.status="running";}
  }catch(e){app.latencyMs=null;}
}
function download(name,text){
  var b=new Blob([text],{type:"text/plain"});
  var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=name;a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);},4000);
}

document.addEventListener("click",async function(e){
  var nb=e.target.closest("[data-nav]");
  if(nb){S.view=nb.getAttribute("data-nav");render(true);return;}
  var t=e.target.closest("[data-act]");if(!t)return;
  var act=t.getAttribute("data-act"),id=t.getAttribute("data-id");
  var h=activeHost();
  if(act==="closeModal")closeModal();
  else if(act==="focus"){S.activeId=id;S.view="overview";render(true);}
  else if(act==="addHost")modalAddHost(null);
  else if(act==="editHost"){var eh=S.hosts.find(function(x){return x.id===id;});modalAddHost(eh);}
  else if(act==="saveHost"){
    var name=($("mName").value||"").trim()||"server";
    var base=normBase($("mBase").value||"");
    var token=($("mToken").value||"").trim();
    if(!base){toast("Enter a collector URL or IP:port","bad");return;}
    if(id){var ex=S.hosts.find(function(x){return x.id===id;});ex.name=name;ex.base=base;ex.token=token;startPolling(ex);saveHosts();}
    else{
      var nh={id:uid("live"),name:name,kind:"live",ip:base.replace(/^https?:\/\//,"").split("/")[0].split(":")[0],base:base,token:token,status:"polling",ms:null,specs:{},metrics:{cpu:{usage:0},mem:{pct:0},gpu:[],disk:{},net:{rxBps:0,txBps:0}},hist:{cpu:[],mem:[],gpu:[],rx:[],tx:[],dio:[]},containers:[],apps:[],mounts:[],fsEvents:[],logs:[],ports:[],pollMs:S.settings.pollMs};
      S.hosts.push(nh);S.activeId=nh.id;startPolling(nh);saveHosts();
    }
    closeModal();render(true);toast("Host saved — polling /api/summary…");
  }
  else if(act==="delHost"){var dh=S.hosts.find(function(x){return x.id===id;});stopPolling(dh);S.hosts=S.hosts.filter(function(x){return x.id!==id;});if(S.activeId===id)S.activeId=S.hosts[0].id;saveHosts();closeModal();render(true);}
  else if(act==="pollNow"){var ph=S.hosts.find(function(x){return x.id===id;});if(ph)pollHost(ph);}
  else if(act==="pasteJson")modalPaste();
  else if(act==="doPaste"){
    try{
      var data=JSON.parse($("mJson").value);
      var hn=data.hostname||"pasted-host";
      var ex2=S.hosts.find(function(x){return x.name===hn&&x.kind==="live";});
      if(!ex2){ex2={id:uid("live"),name:hn,kind:"live",ip:(data.apps&&data.apps[0]&&data.apps[0].ip)||"0.0.0.0",base:"",status:"online",ms:0,specs:{},metrics:{},hist:{cpu:[],mem:[],gpu:[],rx:[],tx:[],dio:[]},containers:[],apps:[],mounts:[],fsEvents:[],logs:[],ports:[]};S.hosts.push(ex2);}
      ex2.base=ex2.base||"";applyLive(ex2,data,1);S.activeId=ex2.id;closeModal();render(true);toast("Imported snapshot for "+hn);
    }catch(err){toast("Invalid JSON: "+err.message,"bad");}
  }
  else if(act==="exportCfg"){download("pulseboard-hosts.json",JSON.stringify(S.hosts.filter(function(x){return x.kind==="live";}).map(function(x){return {name:x.name,base:x.base,token:x.token};}),null,2));}
  else if(act==="importCfg"){
    var inp=document.createElement("input");inp.type="file";inp.accept=".json";
    inp.onchange=function(){var f=inp.files[0];if(!f)return;var r=new FileReader();r.onload=function(){
      try{var arr=JSON.parse(r.result);arr.forEach(function(c){var nh={id:uid("live"),name:c.name||"server",kind:"live",ip:String(c.base||"").replace(/^https?:\/\//,"").split("/")[0].split(":")[0],base:normBase(c.base),token:c.token||"",status:"polling",ms:null,specs:{},metrics:{cpu:{usage:0},mem:{pct:0},gpu:[],disk:{},net:{}},hist:{cpu:[],mem:[],gpu:[],rx:[],tx:[],dio:[]},containers:[],apps:[],mounts:[],fsEvents:[],logs:[],ports:[],pollMs:S.settings.pollMs};S.hosts.push(nh);startPolling(nh);});saveHosts();render(true);}catch(err2){toast("Bad config file","bad");}
    };r.readAsText(f);};inp.click();
  }
  else if(act==="savePoll"){var v=parseInt(($("pollMsInput").value||"5000"),10);if(v>=1000&&v<=60000){S.settings.pollMs=v;saveSettings();S.hosts.forEach(function(x){if(x.kind==="live"){x.pollMs=v;startPolling(x);}});toast("Poll interval "+v+"ms");}else toast("Use 1000–60000 ms","warn");}
  else if(act==="toggleProxy"){S.settings.proxy=!S.settings.proxy;saveSettings();render(true);toast(S.settings.proxy?"Proxy via superFetch ON":"Direct browser fetch");}
  else if(act==="pauseFs"){S.settings.pauseFs=!S.settings.pauseFs;saveSettings();render(true);}
  else if(act==="pauseLogs"){S.settings.pauseLogs=!S.settings.pauseLogs;saveSettings();render(true);}
  else if(act==="dlLogs"){download("pulseboard-"+h.name+".log",allLogs().map(function(l){return new Date(l.t).toISOString()+" ["+l.level+"] "+l.host+"/"+l.src+" "+l.msg;}).join("\n"));}
  else if(act==="checkPorts"){
    toast("Probing http ports…");
    for(var i=0;i<h.apps.length;i++){await probeHttp(h,h.apps[i]);}
    render(true);
  }
  else if(act==="appLogs"){
    var a=h.apps.find(function(x){return x.id===id;});
    if(!a) return;
    if(h.base){
      try{
        var hd={};if(h.token)hd["Authorization"]="Bearer "+h.token;
        var r=await fetch(h.base+"/api/logs?app="+encodeURIComponent(a.name)+"&tail=200",{headers:hd});
        var j=await r.json();modalLogs(a.name+" — "+h.name,(j.lines||j.logs||[]));return;
      }catch(err){modalLogs(a.name+" (fetch failed: "+err.message+")",[]);return;}
    }
    modalLogs(a.name+" — "+h.name,h.logs.filter(function(l){return (l.src||"").includes(a.name);}));
  }
  else if(act==="contLogs"){
    var c=h.containers.find(function(x){return x.id===id;});
    if(!c) return;
    if(h.base){
      try{
        var hd2={};if(h.token)hd2["Authorization"]="Bearer "+h.token;
        var r2=await fetch(h.base+"/api/logs?container="+encodeURIComponent(c.name)+"&tail=300",{headers:hd2});
        var j2=await r2.json();
        var lines=(j2.lines||j2.logs||[]);
        if(!lines.length)lines=[{t:Date.now(),level:"info",msg:"No recent logs found for container "+c.name}];
        modalLogs("docker logs "+c.name,lines);return;
      }catch(err2){toast("Log fetch failed: "+err2.message,"bad");return;}
    } else {
      toast("Host collector URL not configured","warn");
    }
  }
  else if(act==="contRestart"){
    var c2=h.containers.find(function(x){return x.id===id;});
    if(!h.base){toast("Restart needs a live host","warn");return;}
    if(!confirm("Restart container "+c2.name+" on "+h.name+"?"))return;
    try{
      var hd3={"Content-Type":"application/json"};if(h.token)hd3["Authorization"]="Bearer "+h.token;
      var r3=await fetch(h.base+"/api/containers/"+encodeURIComponent(c2.id||c2.name)+"/restart",{method:"POST",headers:hd3});
      if(!r3.ok)throw new Error("HTTP "+r3.status);
      toast("Restart sent to "+c2.name);pollHost(h);
    }catch(err3){toast("Restart failed: "+err3.message,"bad");}
  }
  else if(act==="addWatch"){
    var wh=($("watchHostInput").value||"").trim(),wp=parseInt(($("watchPortInput").value||"").trim(),10),wl=($("watchLabelInput").value||"").trim();
    if(!wh||!wp){toast("Enter IP and port","warn");return;}
    S.watch.push({host:wh,port:wp,label:wl});saveSettings();render(true);
  }
  else if(act==="unwatch"){S.watch.splice(parseInt(t.getAttribute("data-i"),10),1);saveSettings();render(true);}
});
document.addEventListener("change",function(e){
  if(e.target.id==="hostSel"){S.activeId=e.target.value;render(true);}
  if(e.target.id==="fsFilterSel"){S.fsFilter=e.target.value;render(true);}
  if(e.target.id==="logLevelSel"){S.logLevel=e.target.value;render(true);}
});
document.addEventListener("input",function(e){
  if(e.target.id==="fsQInput"){S.fsQ=e.target.value;var tb=e.target;var pos=tb.selectionStart;render(false);var n=$("fsQInput");if(n){n.focus();n.setSelectionRange(pos,pos);}paintHostPickerKeep();}
  if(e.target.id==="logQInput"){S.logQ=e.target.value;}
  if(e.target.id==="appQInput"){S.appQ=e.target.value;render(false);var a2=$("appQInput");if(a2){a2.focus();a2.setSelectionRange(a2.value.length,a2.value.length);}}
  if(e.target.id==="contQInput"){S.contQ=e.target.value;render(false);var c3=$("contQInput");if(c3){c3.focus();c3.setSelectionRange(c3.value.length,c3.value.length);}}
});
function paintHostPickerKeep(){/* keep picker stable during typing */}

/* ---------- boot ---------- */
function boot(){
  loadPersist();
  S.hosts=[];
  try{
    var saved=JSON.parse(localStorage.getItem(LS_HOSTS)||"[]");
    if(!Array.isArray(saved)||saved.length===0){
      var localBase=(window.location&&window.location.origin&&!window.location.origin.startsWith("file:"))?window.location.origin:"http://localhost:22222";
      saved=[{name:"Local System",base:localBase,token:""}];
    }
    saved.forEach(function(c){
      var nh=createHostObj(c);
      S.hosts.push(nh);
      startPolling(nh);
    });
  }catch(e){}
  if(S.hosts.length>0)S.activeId=S.hosts[0].id;
  render(true);
  var be=$("bootEl");if(be)be.remove();
  setInterval(function(){
    if(S.view&&!S.settings.pauseFs&&!S.settings.pauseLogs){
      render(false);
    }
  },2000);
  window.addEventListener("resize",function(){render(false);});
}
if(document.readyState!=="loading")boot();
else document.addEventListener("DOMContentLoaded",boot);
})();
