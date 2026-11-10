/* PulseBoard — Live infrastructure & system monitor dashboard (v2.0 PRO) */
(function(){
"use strict";
var LS_HOSTS="pulseboard.hosts.v1", LS_SET="pulseboard.settings.v1", LS_WATCH="pulseboard.watch.v1";
var POLL_DEFAULT=3000, MAX_HIST=120;

var S = {
  view:"overview", hosts:[], activeId:null, settings:{pollMs:POLL_DEFAULT, proxy:false, pauseFs:false, pauseLogs:false},
  watch:[], alerts:[], fsFilter:"all", fsQ:"", logQ:"", logLevel:"all", contQ:"", appQ:"",
  contFilter:"all", contView:"grid",
  modal:null, charts:{}, pollTimers:{}
};

function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function fmtB(b){if(b==null||isNaN(b))return "0 B";var u=["B","KB","MB","GB","TB","PB"],i=0;while(b>=1024&&i<u.length-1){b/=1024;i++;}return (b>=100?Math.round(b):b.toFixed(1))+" "+u[i];}
function fmtBps(b){return fmtB(b)+"/s";}
function fmtUp(s){if(s==null)return "-";s=Math.floor(s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);if(d>0)return d+"d "+h+"h";if(h>0)return h+"h "+m+"m";return m+"m "+(s%60)+"s";}
function fmtT(t){try{return new Date(t).toLocaleTimeString();}catch(e){return "?";}}
function pct(v){return (v==null?"0.0%":Number(v).toFixed(1)+"%");}
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

/* ---------- alerts & notifications ---------- */
function addAlert(host,msg,sev){
  S.alerts.unshift({t:Date.now(),host:host?host.name:"-",msg:msg,sev:sev||"info"});
  if(S.alerts.length>60)S.alerts.length=60;
  toast(msg,sev);
}
function toast(msg,sev){
  var w=$("toastWrap");if(!w)return;
  var d=document.createElement("div");d.className="toast "+(sev||"");
  d.innerHTML='<span>'+esc(msg)+'</span><span style="cursor:pointer;opacity:0.6;font-size:16px;line-height:1" onclick="this.parentElement.remove()">×</span>';
  w.appendChild(d);
  setTimeout(function(){
    d.style.opacity="0";
    d.style.transform="translateX(20px)";
    d.style.transition="all .3s ease";
    setTimeout(function(){d.remove();},350);
  },4200);
}

/* ---------- persistence ---------- */
function saveHosts(){
  try{
    localStorage.setItem(LS_HOSTS,JSON.stringify(S.hosts.filter(function(h){return h.kind==="live";}).map(function(h){return {name:h.name,base:h.base,token:h.token||"",pollMs:h.pollMs||S.settings.pollMs};})));
  }catch(e){}
}
function loadPersist(){
  try{var s=JSON.parse(localStorage.getItem(LS_SET)||"null");if(s)Object.assign(S.settings,s);}catch(e){}
  try{var w=JSON.parse(localStorage.getItem(LS_WATCH)||"[]");if(Array.isArray(w))S.watch=w;}catch(e){}
}
function saveSettings(){
  try{localStorage.setItem(LS_SET,JSON.stringify(S.settings));}catch(e){}
  try{localStorage.setItem(LS_WATCH,JSON.stringify(S.watch));}catch(e){}
}

/* ---------- live polling ---------- */
function normBase(u){
  u=(u||"").trim();if(!u)return "";
  if(!/^https?:\/\//i.test(u))u="http://"+u;
  return u.replace(/\/+$/,"");
}
async function fetchSummary(host){
  var url=host.base+"/api/summary";
  var headers={};
  if(host.token)headers["Authorization"]="Bearer "+host.token;
  var ctrl=new AbortController();var to=setTimeout(function(){ctrl.abort();},9000);
  var t0=performance.now();
  try{
    var res;
    var sf=(typeof window!=="undefined"&&window.superFetch)||(typeof root!=="undefined"&&root.superFetch);
    if(S.settings.proxy&&sf){
      res=await sf(url,{headers:headers,signal:ctrl.signal});
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
  if(data.hostname && !host._renamed){
    if(/^[0-9a-f]{12}$/i.test(data.hostname)){
      host.name = (host.ip && host.ip !== "127.0.0.1") ? ("VPS (" + host.ip + ")") : (host.name && !/^[0-9a-f]{12}$/i.test(host.name) ? host.name : "VPS Node");
    } else {
      host.name = data.hostname;
    }
  }
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
  if(Array.isArray(data.fsEvents)){
    data.fsEvents.slice(0,80).reverse().forEach(function(e){
      host.fsEvents.unshift({t:e.t||Date.now(),op:e.op||"read",path:e.path||"?",proc:e.proc||"",size:e.size||0});
    });
    if(host.fsEvents.length>500)host.fsEvents.length=500;
  }
  if(Array.isArray(data.logs)){
    data.logs.slice(0,80).reverse().forEach(function(l){
      host.logs.unshift({t:l.t||Date.now(),level:l.level||"info",src:l.src||"",msg:l.msg||""});
    });
    if(host.logs.length>800)host.logs.length=800;
  }
  if(Array.isArray(data.ports))host.ports=data.ports;
  if(data.db)host.db=data.db;
  checkThresholds(host);
}

function checkThresholds(host){
  var m=host.metrics;if(!m)return;
  
  // High RAM alert (debounced)
  host._prevMemAlert = host._prevMemAlert || false;
  if(m.mem && m.mem.pct > 92){
    if(!host._prevMemAlert){
      addAlert(host,"High RAM load on "+host.name+": "+Number(m.mem.pct).toFixed(1)+"%","bad");
      host._prevMemAlert = true;
    }
  } else {
    host._prevMemAlert = false;
  }

  (m.gpu||[]).forEach(function(g){if(g.temp>84)addAlert(host,"GPU thermal warning on "+host.name+" ("+(g.name||"gpu")+": "+Math.round(g.temp)+"C)","warn");});
  
  host._prevStates=host._prevStates||{};
  (host.containers||[]).forEach(function(c){
    var id=c.id||c.name;
    var prev=host._prevStates[id];
    // Only alert if a running container crashes or stops unexpectedly (transition from running to stopped)
    if(prev==="running" && (c.state==="exited"||c.state==="dead")){
      addAlert(host,"Container stopped: "+c.name+" on "+host.name,"bad");
    }
    host._prevStates[id]=c.state;
  });
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

/* ---------- charts rendering ---------- */
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
  
  // grid lines
  ctx.strokeStyle="rgba(255,255,255,0.06)";ctx.lineWidth=1;
  for(var g=0;g<=3;g++){var y=6+(h-12)*g/3;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  if(!series.length)return;
  
  ctx.beginPath();
  var n=series.length;
  for(var i=0;i<n;i++){
    var x=n===1?w-2:4+(w-8)*i/(Math.max(1,(opts.span||MAX_HIST)-1));
    var v=series[clamp(i,0,n-1)];
    var yy=h-6-((clamp(v,min,max)-min)/(max-min))*(h-12);
    if(i===0)ctx.moveTo(x,yy);else ctx.lineTo(x,yy);
  }
  var grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,opts.fill||"rgba(6,182,212,0.25)");grad.addColorStop(1,"rgba(6,182,212,0)");
  ctx.save();
  ctx.lineTo(w,h);ctx.lineTo(4,h);ctx.closePath();
  ctx.fillStyle=grad;ctx.fill();ctx.restore();
  
  // line stroke
  ctx.beginPath();
  for(var j=0;j<n;j++){
    var x2=n===1?w-2:4+(w-8)*j/(Math.max(1,(opts.span||MAX_HIST)-1));
    var v2=series[clamp(j,0,n-1)];
    var y2=h-6-((clamp(v2,min,max)-min)/(max-min))*(h-12);
    if(j===0)ctx.moveTo(x2,y2);else ctx.lineTo(x2,y2);
  }
  ctx.strokeStyle=opts.color||"#06b6d4";ctx.lineWidth=2;ctx.shadowColor=opts.color||"#06b6d4";ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;
  
  // active pulse point
  var lx=w-4,lv=series[n-1];
  var ly=h-6-((clamp(lv,min,max)-min)/(max-min))*(h-12);
  ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(lx,ly,3.5,0,7);ctx.fill();
  if(opts.label!=null){ctx.fillStyle="#94a3b8";ctx.font="10px monospace";ctx.fillText(opts.label,6,12);}
}

function activeHost(){
  return S.hosts.find(function(h){return h.id===S.activeId;})||S.hosts[0]||null;
}
function allLogs(){
  var arr=[];S.hosts.forEach(function(h){(h.logs||[]).forEach(function(l){arr.push(Object.assign({host:h.name},l));});});
  return arr.sort(function(a,b){return (b.t||0)-(a.t||0);});
}

function statusBadge(s){
  s=(s||"").toLowerCase();
  if(s==="running"||s==="online"||s==="healthy")return '<span class="badge ok"><span class="dot ok"></span> Running</span>';
  if(s==="polling")return '<span class="badge info"><span class="dot ok"></span> Polling</span>';
  if(s==="exited"||s==="stopped"||s==="offline"||s==="dead")return '<span class="badge bad"><span class="dot bad"></span> Stopped</span>';
  if(s==="restarting"||s==="paused")return '<span class="badge warn"><span class="dot warn"></span> '+esc(s)+'</span>';
  return '<span class="badge"><span class="dot"></span> '+esc(s)+'</span>';
}
function opBadge(op){
  op=(op||"").toLowerCase();
  if(op==="read")return '<span class="badge info">READ</span>';
  if(op==="write")return '<span class="badge ok">WRITE</span>';
  if(op==="edit")return '<span class="badge warn">EDIT</span>';
  if(op==="delete")return '<span class="badge bad">DEL</span>';
  return '<span class="badge">'+esc(op)+'</span>';
}

function hostHealthLine(h){
  return '<span class="hostLine">'+
    '<span class="hostName">'+esc(h.name)+'</span> '+
    '<span class="chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg> '+esc(h.ip||"")+'</span>'+
    (h.base?'<span class="chip ghost">'+esc(h.base)+'</span>':'')+
    (h.ms!=null?'<span class="chip">'+h.ms+'ms</span>':'')+
    (h.status!=="online"?'<span class="badge bad"><span class="dot bad"></span> '+esc(h.status)+'</span>':'<span class="badge ok"><span class="dot ok"></span> Live Stream</span>')+
  '</span>';
}

/* ---------- Container Branding & Port Helpers ---------- */
function getContainerBrand(name, image){
  var str=(name+" "+image).toLowerCase();
  if(str.includes("mongo")){
    return {
      name:"MongoDB",
      color:"#10b981",
      icon:'<svg viewBox="0 0 24 24" fill="currentColor" color="#10b981"><path d="M17.193 9.555c-1.264-5.01-4.281-7.46-5.193-8.555-.913 1.095-3.929 3.545-5.193 8.555-1.508 5.975 1.258 11.233 4.887 13.445h.612c3.629-2.212 6.395-7.47 4.887-13.445zm-5.193 11.662c-2.883-1.89-4.839-6.075-3.663-10.741 1.002-3.978 3.238-6.177 4.01-6.848.771.671 3.008 2.87 4.01 6.848 1.176 4.666-.78 8.851-3.663 10.741h-.694z"/></svg>'
    };
  }
  if(str.includes("nginx")||str.includes("frontend")){
    return {
      name:"Nginx Web",
      color:"#06b6d4",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="4"/><path d="M7 17V7l10 10V7"/></svg>'
    };
  }
  if(str.includes("node")||str.includes("backend")){
    return {
      name:"Node.js API",
      color:"#22c55e",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2z"/><path d="M12 12l8-4.5M12 12v8M12 12L4 7.5"/></svg>'
    };
  }
  if(str.includes("vps-agent")||str.includes("agent")){
    return {
      name:"SysMon Agent",
      color:"#38bdf8",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="3"/></svg>'
    };
  }
  if(str.includes("minio")){
    return {
      name:"MinIO Object",
      color:"#f43f5e",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
    };
  }
  if(str.includes("mariadb")||str.includes("mysql")){
    return {
      name:"MariaDB / SQL",
      color:"#0284c7",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>'
    };
  }
  if(str.includes("whatsi")||str.includes("chat")){
    return {
      name:"Messaging App",
      color:"#a855f7",
      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };
  }
  return {
    name:"Docker Container",
    color:"#06b6d4",
    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12.5c0 4.14-3.36 7.5-7.5 7.5H4c-.55 0-1-.45-1-1 0-1.5 1-3 3-3h11.5c1.38 0 2.5-1.12 2.5-2.5 0-.75-.33-1.42-.86-1.88l.86-.12z"/><rect x="2" y="8" width="3" height="3" rx="0.5"/><rect x="6" y="8" width="3" height="3" rx="0.5"/><rect x="10" y="8" width="3" height="3" rx="0.5"/><rect x="6" y="4" width="3" height="3" rx="0.5"/><rect x="10" y="4" width="3" height="3" rx="0.5"/></svg>'
  };
}

function parseCleanPorts(portStr, hostIp){
  if(!portStr||typeof portStr!=="string")return [];
  var seen={};var out=[];
  var parts=portStr.split(/[\s,]+/);
  parts.forEach(function(p){
    p=p.trim();if(!p)return;
    var m=p.match(/(?:[\d.]+|\[[\da-fA-F:]+\])?:(\d+)->(\d+)(?:\/(\w+))?/);
    if(m){
      var hostP=m[1],contP=m[2],proto=m[3]||"tcp";
      var key=hostP+":"+contP;
      if(!seen[key]){
        seen[key]=true;
        var isHttp=(hostP!=="22"&&hostP!=="3306"&&hostP!=="27017"&&hostP!=="5432"&&hostP!=="6379");
        out.push({
          hostPort:hostP,
          contPort:contP,
          proto:proto,
          label:hostP===contP?hostP:(hostP+" → "+contP),
          url:isHttp?("http://"+hostIp+":"+hostP):null
        });
      }
    }else{
      var m2=p.match(/(\d+)(?:\/(\w+))?/);
      if(m2){
        var port=m2[1];
        if(!seen[port]){
          seen[port]=true;
          out.push({hostPort:null,contPort:port,proto:m2[2]||"tcp",label:port,url:null});
        }
      }
    }
  });
  return out;
}

/* ---------- 1. Overview View ---------- */
function vOverview(h){
  var m=h.metrics;
  var contRun=h.containers.filter(function(c){return c.state==="running";}).length;
  var appsRun=h.apps.filter(function(a){return a.status==="running";}).length;
  
  var alerts=S.alerts.slice(0,5).map(function(a){
    return '<div class="alertItem '+(a.sev||"info")+'">'+
      '<div class="row" style="gap:10px">'+
        '<span class="dot '+(a.sev||"info")+'"></span>'+
        '<span style="font-weight:600">'+esc(a.msg)+'</span>'+
      '</div>'+
      '<span class="mono muted small">'+fmtT(a.t)+'</span>'+
    '</div>';
  }).join("")||'<div class="muted small" style="padding:14px 0">All systems operating within nominal operational thresholds.</div>';
  
  var cards=S.hosts.map(function(x){
    var xm=x.metrics||{cpu:{},mem:{},gpu:[]};
    return '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px">'+
        '<div class="row" style="gap:8px">'+
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--cyan-bright)" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>'+
          '<span style="font-weight:700;font-size:14px">'+esc(x.name)+'</span>'+
        '</div>'+
        statusBadge(x.status)+
      '</div>'+
      '<div class="row" style="justify-content:space-between"><span class="big">'+pct(xm.cpu.usage)+'</span><span class="mono muted small">'+esc(x.ip||"")+'</span></div>'+
      '<div class="sub" style="margin-top:2px">RAM '+pct(xm.mem.pct)+' · GPU '+(xm.gpu&&xm.gpu[0]?pct(xm.gpu[0].util):"—")+'</div>'+
      '<div class="bar'+(xm.cpu.usage>85?" bad":xm.cpu.usage>65?" warn":"")+'"><i style="width:'+clamp(xm.cpu.usage||0,0,100)+'%"></i></div>'+
      '<div class="row" style="margin-top:14px;justify-content:space-between">'+
        '<button class="btn sm primary" data-act="focus" data-id="'+x.id+'">Inspect Node</button>'+
        '<span class="muted small mono">'+x.containers.filter(function(c){return c.state==="running";}).length+'/'+x.containers.length+' containers</span>'+
      '</div>'+
    '</div>';
  }).join("");

  return ''+
  '<div class="overviewHero">'+
    '<div class="heroLeft">'+
      '<div class="heroTitle">'+
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--cyan-bright)" stroke-width="2.2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>'+
        '<span>Infrastructure Overview</span>'+
      '</div>'+
      '<div class="heroSub">'+hostHealthLine(h)+' · Active Cluster Node Control</div>'+
    '</div>'+
    '<div class="heroRight">'+
      '<button class="btn sm primary" data-act="addHost">+ Add Node</button>'+
      '<button class="btn sm" data-act="pollNow" data-id="'+h.id+'">↻ Poll All</button>'+
      '<button class="btn sm" data-act="exportCfg">⬇ Export Config</button>'+
    '</div>'+
  '</div>'+
  '<div class="dockerKpiGrid">'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">CPU Compute Load</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div></div>'+
      '<div class="kpiValue">'+pct(m.cpu.usage)+'</div>'+
      '<div class="kpiSub"><span class="chip" style="font-size:10px;padding:1px 6px">'+(h.specs.cpuCores||"?")+' cores</span> '+(m.cpu.load1?m.cpu.load1.toFixed(1):"0.0")+' load avg</div>'+
      '<div class="bar" style="margin-top:6px"><i style="width:'+clamp(m.cpu.usage||0,0,100)+'%"></i></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Memory Footprint</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg></div></div>'+
      '<div class="kpiValue">'+pct(m.mem.pct)+'</div>'+
      '<div class="kpiSub"><span class="mono">'+fmtB(m.mem.used)+' / '+fmtB(m.mem.total)+'</span></div>'+
      '<div class="bar" style="margin-top:6px"><i style="width:'+clamp(m.mem.pct||0,0,100)+'%"></i></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Container Fleet</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12.5c0 4.14-3.36 7.5-7.5 7.5H4c-.55 0-1-.45-1-1 0-1.5 1-3 3-3h11.5c1.38 0 2.5-1.12 2.5-2.5 0-.75-.33-1.42-.86-1.88l.86-.12z"/></svg></div></div>'+
      '<div class="kpiValue">'+contRun+' <span style="font-size:16px;color:var(--muted)">/ '+h.containers.length+'</span></div>'+
      '<div class="kpiSub"><span class="badge ok" style="padding:1px 7px;font-size:10px">● '+contRun+' Active</span> <span class="badge bad" style="padding:1px 7px;font-size:10px">○ '+(h.containers.length-contRun)+' Stopped</span></div>'+
      '<div class="bar" style="margin-top:6px"><i style="width:'+(h.containers.length?(contRun/h.containers.length*100):0)+'%"></i></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Network In/Out</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/></svg></div></div>'+
      '<div class="kpiValue" style="font-size:20px;line-height:1.2">↓ '+fmtBps(m.net.rxBps)+'</div>'+
      '<div class="kpiSub"><span style="color:var(--vio-bright)">↑ '+fmtBps(m.net.txBps)+'</span> · IO '+fmtBps((m.disk.readBps||0)+(m.disk.writeBps||0))+'</div>'+
    '</div>'+
  '</div>'+
  '<div class="grid g2" style="margin-top:16px">'+
    '<div class="card"><h3>Active Cluster Compute Nodes</h3><div class="grid g2" style="margin-top:10px">'+cards+'</div></div>'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Combined Telemetry Waveform</h3><span class="mono muted small">Last '+MAX_HIST+' intervals</span></div>'+
      '<canvas class="chart tall" data-multi="1" data-host="'+h.id+'"></canvas>'+
      '<hr style="border:0;border-top:1px solid var(--border);margin:16px 0">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Operational Alert Stream</h3><span class="badge info">Real-Time</span></div>'+
      '<div class="alertFeed">'+alerts+'</div>'+
    '</div>'+
  '</div>';
}

/* ---------- 2. Docker View ---------- */
function vDocker(h){
  var q=(S.contQ||"").toLowerCase();
  var filter=S.contFilter||"all";
  
  var total=h.containers.length;
  var running=h.containers.filter(function(c){return c.state==="running";}).length;
  var stopped=total-running;
  var totalMem=h.containers.reduce(function(acc,c){return acc+(c.memUsed||0);},0);
  var hostMemTotal=(h.specs&&h.specs.memTotal)||(h.metrics&&h.metrics.mem&&h.metrics.mem.total)||12220477440;
  var memPct=hostMemTotal?((totalMem/hostMemTotal)*100).toFixed(1):0;
  var totalCpu=(h.containers.reduce(function(acc,c){return acc+(c.cpu||0);},0)).toFixed(1);
  var netRx=h.containers.reduce(function(acc,c){return acc+(c.netRx||0);},0);
  var netTx=h.containers.reduce(function(acc,c){return acc+(c.netTx||0);},0);

  var list=h.containers.filter(function(c){
    if(filter==="running"&&c.state!=="running")return false;
    if(filter==="stopped"&&c.state==="running")return false;
    if(!q)return true;
    return (c.name||"").toLowerCase().includes(q)||(c.image||"").toLowerCase().includes(q)||(c.ports||"").toLowerCase().includes(q);
  });

  var kpiHtml='<div class="dockerKpiGrid">'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Total Containers</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12.5c0 4.14-3.36 7.5-7.5 7.5H4c-.55 0-1-.45-1-1 0-1.5 1-3 3-3h11.5c1.38 0 2.5-1.12 2.5-2.5 0-.75-.33-1.42-.86-1.88l.86-.12z"/></svg></div></div>'+
      '<div class="kpiValue">'+total+'</div>'+
      '<div class="kpiSub"><span class="badge ok" style="padding:1px 7px;font-size:10px">● '+running+' Active</span> <span class="badge bad" style="padding:1px 7px;font-size:10px">○ '+stopped+' Stopped</span></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Memory Allocated</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg></div></div>'+
      '<div class="kpiValue">'+fmtB(totalMem)+'</div>'+
      '<div class="kpiSub"><span class="mono">'+memPct+'% of Host ('+fmtB(hostMemTotal)+')</span></div>'+
      '<div class="bar" style="margin-top:6px"><i style="width:'+clamp(memPct,0,100)+'%"></i></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Compute Load (CPU)</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div></div>'+
      '<div class="kpiValue">'+totalCpu+'%</div>'+
      '<div class="kpiSub">Aggregated container cycles</div>'+
      '<div class="bar" style="margin-top:6px"><i style="width:'+clamp(totalCpu,0,100)+'%"></i></div>'+
    '</div>'+
    '<div class="kpiCard">'+
      '<div class="kpiHeader"><span class="kpiTitle">Aggregate Network</span><div class="kpiIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/></svg></div></div>'+
      '<div class="kpiValue" style="font-size:20px;line-height:1.2">↓ '+fmtB(netRx)+'</div>'+
      '<div class="kpiSub" style="font-family:var(--mono)">↑ '+fmtB(netTx)+' transferred</div>'+
    '</div>'+
  '</div>';

  var toolbarHtml='<div class="dockerToolbar">'+
    '<div class="searchBox">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'+
      '<input id="contQInput" placeholder="Filter containers by name, image, or ports..." value="'+esc(S.contQ)+'">'+
    '</div>'+
    '<div class="row" style="gap:10px">'+
      '<div class="filterTabs">'+
        '<button class="filterTab'+(filter==="all"?" active":"")+'" data-act="setContFilter" data-val="all">All ('+total+')</button>'+
        '<button class="filterTab'+(filter==="running"?" active":"")+'" data-act="setContFilter" data-val="running">Running ('+running+')</button>'+
        '<button class="filterTab'+(filter==="stopped"?" active":"")+'" data-act="setContFilter" data-val="stopped">Stopped ('+stopped+')</button>'+
      '</div>'+
      '<div class="viewToggle">'+
        '<button class="viewToggleBtn'+(S.contView!=="table"?" active":"")+'" data-act="setContView" data-val="grid" title="Card View">'+
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>'+
        '</button>'+
        '<button class="viewToggleBtn'+(S.contView==="table"?" active":"")+'" data-act="setContView" data-val="table" title="Table View">'+
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'+
        '</button>'+
      '</div>'+
      '<button class="btn sm" data-act="pollNow" data-id="'+h.id+'" title="Reload Docker Status">'+
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>'+
        '<span>Refresh</span>'+
      '</button>'+
    '</div>'+
  '</div>';

  var bodyHtml="";
  if(!list.length){
    bodyHtml='<div class="card" style="text-align:center;padding:48px 20px">'+
      '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" stroke-width="1.5" style="margin-bottom:12px"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2M9 9h.01M15 9h.01"/></svg>'+
      '<h3 style="justify-content:center;font-size:16px;color:#fff">No Containers Match Filter</h3>'+
      '<p class="muted" style="margin-top:6px;font-size:13px">Try clearing search keywords or checking if the Docker socket is mounted.</p>'+
    '</div>';
  } else if(S.contView==="table"){
    var rows=list.map(function(c){
      var brand=getContainerBrand(c.name,c.image);
      var ports=parseCleanPorts(c.ports,h.ip);
      var portTags=ports.map(function(p){
        if(p.url)return '<a href="'+p.url+'" target="_blank" rel="noopener" class="portTag" title="Open HTTP port in browser">'+esc(p.label)+' <span style="font-size:9px">↗</span></a>';
        return '<span class="portTag" style="opacity:0.75">'+esc(p.label)+'</span>';
      }).join(" ")||"—";

      var memPct=c.memLimit?clamp((c.memUsed/c.memLimit*100),0,100).toFixed(1):(c.memPct||0);
      var isRunning=c.state==="running";

      return '<tr>'+
        '<td>'+statusBadge(c.state)+'</td>'+
        '<td>'+
          '<div class="row" style="gap:10px">'+
            '<div class="cCardIcon" style="width:32px;height:32px;border-radius:8px">'+brand.icon+'</div>'+
            '<div style="min-width:0">'+
              '<div style="font-weight:700;color:#fff" class="mono">'+esc(c.name)+'</div>'+
              '<div class="muted small mono" style="font-size:11px">'+esc(c.image)+'</div>'+
            '</div>'+
          '</div>'+
        '</td>'+
        '<td>'+
          '<div style="width:110px">'+
            '<div class="row" style="justify-content:space-between;font-size:11.5px"><span class="mono">'+(c.cpu!=null?c.cpu.toFixed(1)+"%":"0.0%")+'</span></div>'+
            '<div class="bar" style="margin-top:4px"><i style="width:'+clamp(c.cpu||0,0,100)+'%"></i></div>'+
          '</div>'+
        '</td>'+
        '<td>'+
          '<div style="width:140px">'+
            '<div class="row" style="justify-content:space-between;font-size:11px"><span class="mono">'+fmtB(c.memUsed)+'</span><span class="mono muted">'+memPct+'%</span></div>'+
            '<div class="bar" style="margin-top:4px"><i style="width:'+clamp(memPct,0,100)+'%"></i></div>'+
          '</div>'+
        '</td>'+
        '<td class="mono small" style="white-space:nowrap">'+
          '<span style="color:var(--cyan-bright)">↓ '+fmtB(c.netRx)+'</span> · <span style="color:var(--vio-bright)">↑ '+fmtB(c.netTx)+'</span>'+
        '</td>'+
        '<td><div class="portBadges">'+portTags+'</div></td>'+
        '<td class="small muted mono" style="white-space:nowrap">'+esc(c.status||"")+'</td>'+
        '<td>'+
          '<div class="row" style="gap:6px">'+
            '<button class="btn sm" data-act="contLogs" data-id="'+c.id+'" title="View Container Logs">'+
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> Logs'+
            '</button>'+
            '<button class="btn sm" data-act="contRestart" data-id="'+c.id+'" title="Restart Container">'+
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>'+
            '</button>'+
            (isRunning?
              '<button class="btn sm danger" data-act="contStop" data-id="'+c.id+'" title="Stop Container"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>':
              '<button class="btn sm primary" data-act="contStart" data-id="'+c.id+'" title="Start Container"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>'
            )+
          '</div>'+
        '</td>'+
      '</tr>';
    }).join("");

    bodyHtml='<div class="contTableWrap">'+
      '<table class="contTable">'+
        '<thead><tr><th>Status</th><th>Container / Image</th><th>CPU Load</th><th>Memory In-Use</th><th>Network I/O</th><th>Exposed Ports</th><th>Uptime</th><th>Actions</th></tr></thead>'+
        '<tbody>'+rows+'</tbody>'+
      '</table>'+
    '</div>';
  } else {
    var cards=list.map(function(c){
      var brand=getContainerBrand(c.name,c.image);
      var ports=parseCleanPorts(c.ports,h.ip);
      var portTags=ports.map(function(p){
        if(p.url)return '<a href="'+p.url+'" target="_blank" rel="noopener" class="portTag" title="Open HTTP port in browser">'+esc(p.label)+' <span style="font-size:9px">↗</span></a>';
        return '<span class="portTag" style="opacity:0.75">'+esc(p.label)+'</span>';
      }).join("")||'<span class="muted small" style="font-family:var(--mono)">No exposed ports</span>';

      var cpuPct=clamp(c.cpu||0,0,100).toFixed(1);
      var memPct=c.memLimit?clamp((c.memUsed/c.memLimit*100),0,100).toFixed(1):(c.memPct||0);
      var isRunning=c.state==="running";

      return '<div class="cCard'+(isRunning?"":" stopped")+'">'+
        '<div class="cCardHead">'+
          '<div class="cCardIcon">'+brand.icon+'</div>'+
          '<div class="cCardMeta">'+
            '<div class="cCardTitleRow">'+
              '<div class="cCardName" title="'+esc(c.name)+'">'+esc(c.name)+'</div>'+
              statusBadge(c.state)+
            '</div>'+
            '<div class="cCardImage" title="'+esc(c.image)+'">'+esc(c.image)+'</div>'+
          '</div>'+
        '</div>'+
        '<div class="cCardMetrics">'+
          '<div class="mRow">'+
            '<div class="mRowHead"><span class="mLabel">CPU Utilization</span><span class="mVal">'+cpuPct+'%</span></div>'+
            '<div class="mBar"><div class="mBarFill" style="width:'+cpuPct+'%"></div></div>'+
          '</div>'+
          '<div class="mRow">'+
            '<div class="mRowHead"><span class="mLabel">Memory Footprint</span><span class="mVal">'+fmtB(c.memUsed)+' <span class="muted">/ '+fmtB(c.memLimit)+'</span></span></div>'+
            '<div class="mBar"><div class="mBarFill" style="width:'+memPct+'%"></div></div>'+
          '</div>'+
          '<div class="cCardNetPorts">'+
            '<div class="row" style="justify-content:space-between;padding-top:2px">'+
              '<span class="mLabel">Network I/O</span>'+
              '<div class="netPill">'+
                '<span style="color:var(--cyan-bright)">↓ '+fmtB(c.netRx)+'</span>'+
                '<span style="color:var(--vio-bright)">↑ '+fmtB(c.netTx)+'</span>'+
              '</div>'+
            '</div>'+
            '<div style="padding-top:4px">'+
              '<div class="mLabel" style="margin-bottom:4px">Ports &amp; Access</div>'+
              '<div class="portBadges">'+portTags+'</div>'+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div class="cCardFooter">'+
          '<div class="cCardStatusText mono">'+esc(c.status||"")+'</div>'+
          '<div class="cCardActions">'+
            '<button class="btn sm" data-act="contLogs" data-id="'+c.id+'" title="View Real-Time Logs">'+
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> Logs'+
            '</button>'+
            '<button class="btn sm" data-act="contRestart" data-id="'+c.id+'" title="Restart Container">'+
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>'+
            '</button>'+
            (isRunning?
              '<button class="btn sm danger icon-only" data-act="contStop" data-id="'+c.id+'" title="Stop Container"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>':
              '<button class="btn sm primary icon-only" data-act="contStart" data-id="'+c.id+'" title="Start Container"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>'
            )+
          '</div>'+
        '</div>'+
      '</div>';
    }).join("");

    bodyHtml='<div class="contGrid">'+cards+'</div>';
  }

  return ''+
  '<div class="viewHead"><h2>Docker Container Fleet</h2><p>'+hostHealthLine(h)+' — Complete container telemetry, resource quotas, port bindings, and live log tailing.</p></div>'+
  kpiHtml+
  toolbarHtml+
  bodyHtml;
}

/* ---------- 3. Systems View ---------- */
function vSystems(h){
  var s=h.specs,m=h.metrics;
  var gpuRows=m.gpu.map(function(g){
    return '<tr><td><b>'+esc(g.name)+'</b></td><td class="mono">'+pct(g.util)+'</td><td class="mono">'+fmtB(g.memUsed)+' / '+fmtB(g.memTotal)+'</td><td class="mono">'+Math.round(g.temp)+'°C</td><td class="mono">'+Math.round(g.power||0)+'W · '+Math.round(g.fan||0)+'%</td></tr>';
  }).join("")||'<tr><td colspan="5" class="muted" style="padding:18px 14px">No dedicated GPU device detected. The agent continuously queries <code>nvidia-smi</code> and <code>rocm-smi</code>.</td></tr>';
  
  var mounts=h.mounts.map(function(d){
    return '<div class="diskTile">'+
      '<div class="diskTileHead">'+
        '<div><div class="diskMountName">'+esc(d.mount)+'</div><div class="diskDevName">'+esc(d.dev||"")+'</div></div>'+
        '<span class="mono" style="font-weight:700">'+pct(d.pct)+'</span>'+
      '</div>'+
      '<div class="bar'+(d.pct>90?" bad":d.pct>75?" warn":"")+'" style="margin-top:2px"><i style="width:'+clamp(d.pct,0,100)+'%"></i></div>'+
      '<div class="row" style="justify-content:space-between;font-size:11px;color:var(--dim)">'+
        '<span class="mono">'+fmtB(d.used)+' used</span>'+
        '<span class="mono">'+fmtB(d.total)+' total capacity</span>'+
      '</div>'+
    '</div>';
  }).join("");

  return '<div class="viewHead"><h2>System Architecture &amp; Hardware Profile</h2><p>'+hostHealthLine(h)+'</p></div>'+
  '<div class="grid g2">'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:12px"><h3>Host Hardware Profile</h3><span class="badge ok">● Online Host</span></div>'+
      '<table class="contTable">'+
        '<tr><td class="muted" style="width:160px">Hostname</td><td class="mono"><b>'+esc(h.name)+'</b></td></tr>'+
        '<tr><td class="muted">Operating System</td><td><span class="chip" style="font-size:11px">'+esc(s.os||"-")+'</span> <span class="muted mono small">('+esc(s.kernel||"")+')</span></td></tr>'+
        '<tr><td class="muted">Processor (CPU)</td><td><b>'+esc(s.cpuModel||"")+'</b> <span class="badge info" style="font-size:10px;padding:1px 6px">'+(s.cpuCores||"?")+' Cores</span></td></tr>'+
        '<tr><td class="muted">Installed Memory</td><td class="mono" style="color:var(--cyan-bright);font-weight:700">'+fmtB(s.memTotal||(m.mem&&m.mem.total))+'</td></tr>'+
        '<tr><td class="muted">Hardware Arch</td><td class="mono">'+esc(s.arch||"x64")+'</td></tr>'+
        '<tr><td class="muted">System Uptime</td><td class="mono">'+fmtUp(m.uptime)+'</td></tr>'+
        '<tr><td class="muted">Collector Socket</td><td class="mono"><span class="chip ghost">'+esc(h.base||"local")+'</span></td></tr>'+
        '<tr><td class="muted">MongoDB State</td><td>'+(h.db?(h.db.connected?'<span class="badge ok">● Connected ('+esc(h.db.db||"sysmon")+')</span>':'<span class="badge info">○ Memory Cache Mode</span>'):"—")+'</td></tr>'+
      '</table>'+
    '</div>'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:12px"><h3>Storage Volumes &amp; Disk IO</h3><span class="mono muted small">↓ '+fmtBps(m.disk.readBps)+' · ↑ '+fmtBps(m.disk.writeBps)+'</span></div>'+
      '<div class="diskMatrix">'+mounts+'</div>'+
      '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">'+
        '<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="mLabel">Real-Time Disk IO History</span></div>'+
        '<canvas class="chart" data-hist="dio"></canvas>'+
      '</div>'+
    '</div>'+
  '</div>'+
  '<div class="card" style="margin-top:16px">'+
    '<div class="row" style="justify-content:space-between;margin-bottom:10px"><h3>Graphics Processing Hardware (GPUs)</h3><span class="badge info">PCIe Acceleration</span></div>'+
    '<table class="contTable"><thead><tr><th>Accelerator Model</th><th>Compute Load</th><th>VRAM Utilization</th><th>Thermal Temp</th><th>Power Draw &amp; Fan</th></tr></thead><tbody>'+gpuRows+'</tbody></table>'+
  '</div>';
}

/* ---------- 4. Performance View ---------- */
function vPerf(h){
  var m=h.metrics;
  var cores=(m.cpu.perCore||[]).map(function(v,i){
    return '<div class="coreTile">'+
      '<div class="coreHead"><span class="coreLabel">Core '+i+'</span><span class="coreVal">'+Math.round(v)+'%</span></div>'+
      '<div class="bar" style="margin-top:2px"><i style="width:'+clamp(v,0,100)+'%"></i></div>'+
    '</div>';
  }).join("");

  return '<div class="viewHead"><h2>Resource Performance &amp; Scheduler Analytics</h2><p>'+hostHealthLine(h)+' — Per-core CPU thread distribution, memory saturation, and IO waveforms.</p></div>'+
  '<div class="dockerKpiGrid">'+
    '<div class="kpiCard"><div class="kpiHeader"><span class="kpiTitle">CPU Compute Load</span></div><div class="kpiValue">'+pct(m.cpu.usage)+'</div><div class="bar"><i style="width:'+clamp(m.cpu.usage||0,0,100)+'%"></i></div></div>'+
    '<div class="kpiCard"><div class="kpiHeader"><span class="kpiTitle">Memory Saturation</span></div><div class="kpiValue">'+pct(m.mem.pct)+'</div><div class="bar"><i style="width:'+clamp(m.mem.pct||0,0,100)+'%"></i></div></div>'+
    '<div class="kpiCard"><div class="kpiHeader"><span class="kpiTitle">Network Bandwidth</span></div><div class="kpiValue" style="font-size:20px">↓ '+fmtBps(m.net.rxBps)+'</div><div class="kpiSub">↑ '+fmtBps(m.net.txBps)+' outbound</div></div>'+
    '<div class="kpiCard"><div class="kpiHeader"><span class="kpiTitle">Storage IO Operations</span></div><div class="kpiValue" style="font-size:20px">'+fmtBps((m.disk.readBps||0)+(m.disk.writeBps||0))+'</div><div class="kpiSub">↓ '+fmtBps(m.disk.readBps)+' · ↑ '+fmtBps(m.disk.writeBps)+'</div></div>'+
  '</div>'+
  '<div class="grid g2" style="margin-top:16px">'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>CPU Compute Load Waveform</h3><span class="mono big" style="font-size:22px">'+pct(m.cpu.usage)+'</span></div>'+
      '<canvas class="chart tall" data-hist="cpu"></canvas>'+
      '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">'+
        '<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="mLabel">Per-Core CPU Distribution</span><span class="mono muted small">'+(m.cpu.perCore||[]).length+' Logical Threads</span></div>'+
        '<div class="coreMatrix">'+cores+'</div>'+
      '</div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Memory Footprint Waveform</h3><span class="mono big" style="font-size:22px">'+pct(m.mem.pct)+'</span></div>'+
      '<canvas class="chart tall" data-hist="mem"></canvas>'+
      '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">'+
        '<div class="mLabel" style="margin-bottom:8px">Memory Allocation Breakdown</div>'+
        '<table class="contTable">'+
          '<tr><td class="muted" style="width:160px">Active RAM Usage</td><td class="mono"><b>'+fmtB(m.mem.used)+'</b> of '+fmtB(m.mem.total)+'</td></tr>'+
          '<tr><td class="muted">Available Free RAM</td><td class="mono">'+fmtB((m.mem.total||0)-(m.mem.used||0))+'</td></tr>'+
          '<tr><td class="muted">Swap Allocation</td><td class="mono">'+fmtB(m.mem.swapUsed)+' / '+fmtB(m.mem.swapTotal)+'</td></tr>'+
          '<tr><td class="muted">CPU Thermal Reading</td><td class="mono">'+(m.cpu.temp?Math.round(m.cpu.temp)+"°C":"—")+'</td></tr>'+
          '<tr><td class="muted">1m System Load Average</td><td class="mono">'+(m.cpu.load1?m.cpu.load1.toFixed(2):"0.00")+'</td></tr>'+
        '</table>'+
      '</div>'+
    '</div>'+
  '</div>'+
  '<div class="grid g2" style="margin-top:16px">'+
    '<div class="card"><h3>Bandwidth Throughput Waveform</h3><canvas class="chart tall" data-hist="rx"></canvas><div class="sub" style="margin-top:6px">Inbound: ↓ '+fmtBps(m.net.rxBps)+' · Outbound: ↑ '+fmtBps(m.net.txBps)+'</div></div>'+
    '<div class="card"><h3>Storage IO Operations Waveform</h3><canvas class="chart tall" data-hist="dio"></canvas><div class="sub" style="margin-top:6px">Read: '+fmtBps(m.disk.readBps)+' · Write: '+fmtBps(m.disk.writeBps)+'</div></div>'+
  '</div>';
}

/* ---------- 5. Network View ---------- */
function vNetwork(h){
  var m=h.metrics;
  var ifaces=(m.net.ifaces||[]).map(function(n){
    return '<tr>'+
      '<td class="mono"><b>'+esc(n.name)+'</b></td>'+
      '<td class="mono"><span class="chip">'+esc(n.ip||"")+'</span></td>'+
      '<td class="mono" style="color:var(--cyan-bright)">↓ '+fmtBps(n.rxBps||m.net.rxBps)+'</td>'+
      '<td class="mono" style="color:var(--vio-bright)">↑ '+fmtBps(n.txBps||m.net.txBps)+'</td>'+
    '</tr>';
  }).join("")||'<tr><td colspan="4" class="muted">No network interfaces enumerated.</td></tr>';
  
  var ports=(h.ports||[]).map(function(p){
    return '<tr>'+
      '<td class="mono"><b>'+esc(p.ip||h.ip)+':'+p.port+'</b></td>'+
      '<td><span class="badge info">'+esc(p.service||"service")+'</span> <span class="muted small">'+esc(p.proto||"tcp")+'</span></td>'+
      '<td>'+(p.open?'<span class="badge ok">● Open</span>':'<span class="badge bad">○ Closed</span>')+'</td>'+
      '<td class="mono">'+(p.ms!=null?p.ms+" ms":"—")+'</td>'+
    '</tr>';
  }).join("");

  var watch=S.watch.map(function(w,i){
    return '<tr>'+
      '<td class="mono"><b>'+esc(w.host)+':'+esc(w.port)+'</b></td>'+
      '<td>'+esc(w.label||"")+'</td>'+
      '<td><button class="btn sm danger" data-act="unwatch" data-i="'+i+'">Remove</button></td>'+
    '</tr>';
  }).join("")||'<tr><td colspan="3" class="muted" style="padding:16px 12px">Watchlist is currently empty. Add host IP and target port below.</td></tr>';

  return '<div class="viewHead"><h2>Network Traffic &amp; Socket Probes</h2><p>'+hostHealthLine(h)+' — Network interfaces, active listening ports, and target ping watchlist.</p></div>'+
  '<div class="grid g2">'+
    '<div class="card"><h3>Bandwidth Chart</h3><canvas class="chart tall" data-hist="rx"></canvas><div class="sub" style="margin-top:6px">Live traffic: ↓ RX '+fmtBps(m.net.rxBps)+' · ↑ TX '+fmtBps(m.net.txBps)+'</div></div>'+
    '<div class="card"><h3>Active Interfaces</h3><table class="contTable"><thead><tr><th>Interface</th><th>IP Address</th><th>Inbound</th><th>Outbound</th></tr></thead><tbody>'+ifaces+'</tbody></table></div>'+
  '</div>'+
  '<div class="grid g2" style="margin-top:16px">'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Listening Sockets on '+esc(h.name)+'</h3><button class="btn sm primary" data-act="checkPorts">Probe Sockets</button></div>'+
      '<table class="contTable"><thead><tr><th>Socket</th><th>Service</th><th>State</th><th>Latency</th></tr></thead><tbody>'+ports+'</tbody></table>'+
    '</div>'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Custom Service Watchlist</h3><span class="badge info">Local Storage</span></div>'+
      '<table class="contTable"><thead><tr><th>Target Socket</th><th>Description</th><th>Action</th></tr></thead><tbody>'+watch+'</tbody></table>'+
      '<div class="toolbar" style="margin-top:14px">'+
        '<input id="watchHostInput" placeholder="192.168.101.116" style="width:140px;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
        '<input id="watchPortInput" placeholder="55555" style="width:90px;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
        '<input id="watchLabelInput" placeholder="SysMon VPS Agent" style="flex:1;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
        '<button class="btn sm primary" data-act="addWatch">Add to Watch</button>'+
      '</div>'+
    '</div>'+
  '</div>';
}

/* ---------- 6. Filesystem View ---------- */
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

  var rows=list.map(function(e){
    return '<tr>'+
      '<td class="mono muted">'+fmtT(e.t)+'</td>'+
      '<td>'+opBadge(e.op)+'</td>'+
      '<td class="mono"><b>'+esc(e.path)+'</b></td>'+
      '<td class="muted">'+esc(e.proc||"")+'</td>'+
      '<td class="mono">'+(e.size?fmtB(e.size):"—")+'</td>'+
    '</tr>';
  }).join("")||'<tr><td colspan="5" class="muted" style="padding:24px 14px;text-align:center">No filesystem access events logged in current buffer. The collector monitors /srv, /etc, /data, and /var/log.</td></tr>';

  return '<div class="viewHead"><h2>Filesystem Event Audit Stream</h2><p>'+hostHealthLine(h)+' — Real-time inotify / file access tracker.</p></div>'+
  '<div class="grid g4">'+
    '<div class="card"><h3>File Reads</h3><div class="big" style="color:var(--cyan-bright)">'+counts.read+'</div><div class="sub">read access operations</div></div>'+
    '<div class="card"><h3>File Writes</h3><div class="big" style="color:var(--mint-bright)">'+counts.write+'</div><div class="sub">new files written</div></div>'+
    '<div class="card"><h3>Modifications</h3><div class="big" style="color:var(--warn-bright)">'+counts.edit+'</div><div class="sub">existing files modified</div></div>'+
    '<div class="card"><h3>Deletions</h3><div class="big" style="color:var(--bad-bright)">'+counts.delete+'</div><div class="sub">files removed / unlinked</div></div>'+
  '</div>'+
  '<div class="card" style="margin-top:16px">'+
    '<div class="dockerToolbar">'+
      '<div class="row" style="gap:8px">'+
        '<select id="fsFilterSel" style="background:#0a0e1a;border:1px solid var(--border2);color:#fff;border-radius:8px;padding:8px 12px;outline:none">'+
          '<option value="all">All Operations</option><option value="read">Read Only</option><option value="write">Write Only</option><option value="edit">Edit Only</option><option value="delete">Delete Only</option>'+
        '</select>'+
        '<input id="fsQInput" placeholder="Filter path or process..." value="'+esc(S.fsQ)+'" style="min-width:240px;background:#0a0e1a;border:1px solid var(--border2);color:#fff;border-radius:8px;padding:8px 12px;outline:none">'+
      '</div>'+
      '<button class="btn sm" data-act="pauseFs">'+(S.settings.pauseFs?"Resume Feed":"Pause Stream")+'</button>'+
    '</div>'+
    '<div style="max-height:460px;overflow:auto">'+
      '<table class="contTable"><thead><tr><th>Timestamp</th><th>Action</th><th>File Path</th><th>Process</th><th>Size</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '</div>'+
  '</div>';
}

/* ---------- 7. Applications View ---------- */
function vApps(h){
  var q=(S.appQ||"").toLowerCase();
  var list=h.apps.filter(function(a){return !q||(a.name||"").toLowerCase().includes(q)||String(a.port).includes(q);});
  
  var rows=list.map(function(a){
    var link=a.port?'<a href="http://'+esc(a.ip||h.ip)+':'+a.port+'" target="_blank" rel="noopener" class="portTag">'+a.port+' ↗</a>':"—";
    return '<tr>'+
      '<td><b>'+esc(a.name)+'</b><br><span class="muted small mono">'+esc(a.cmd||"")+'</span></td>'+
      '<td><span class="badge info">'+esc(a.type||"app")+'</span></td>'+
      '<td class="mono">'+esc(a.ip||h.ip)+':'+a.port+'</td>'+
      '<td>'+statusBadge(a.status)+'</td>'+
      '<td class="mono">'+fmtUp(a.uptime)+'</td>'+
      '<td class="mono">'+(a.cpu!=null?a.cpu.toFixed(1)+"%":"—")+' · '+(a.mem!=null?a.mem.toFixed(1)+"%":"—")+'</td>'+
      '<td class="mono">'+(a.latencyMs!=null?a.latencyMs+" ms":"—")+'</td>'+
      '<td><div class="row">'+link+' <button class="btn sm" data-act="appLogs" data-id="'+a.id+'">Logs</button></div></td>'+
    '</tr>';
  }).join("")||'<tr><td colspan="8" class="muted" style="padding:24px 14px;text-align:center">No independent host processes registered. Containerized services are managed under the Docker tab.</td></tr>';

  return '<div class="viewHead"><h2>Applications &amp; Native Host Services</h2><p>'+hostHealthLine(h)+' — Discovered Node.js, Python, and system daemon services.</p></div>'+
  '<div class="card">'+
    '<div class="dockerToolbar">'+
      '<input id="appQInput" placeholder="Filter application by name or port..." value="'+esc(S.appQ)+'" style="min-width:280px;background:#0a0e1a;border:1px solid var(--border2);color:#fff;border-radius:8px;padding:8px 12px;outline:none">'+
      '<button class="btn sm primary" data-act="checkPorts">Probe HTTP Latency</button>'+
    '</div>'+
    '<div style="overflow:auto"><table class="contTable"><thead><tr><th>Service / Executable</th><th>Runtime</th><th>Bind Address</th><th>Status</th><th>Uptime</th><th>CPU / RAM</th><th>Probe Latency</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
  '</div>';
}

/* ---------- 8. Logs View ---------- */
function vLogs(h){
  var all=allLogs();
  var q=S.logQ.toLowerCase();
  var list=all.filter(function(l){
    if(S.logLevel!=="all"&&l.level!==S.logLevel)return false;
    if(q&&((l.msg||"").toLowerCase().indexOf(q)<0&&(l.src||"").toLowerCase().indexOf(q)<0&&(l.host||"").toLowerCase().indexOf(q)<0))return false;
    return true;
  }).slice(0,250);

  var linesHtml=list.map(function(l){
    var lvl=(l.level||"info").toLowerCase();
    return '<div class="logLine"><span class="t">'+fmtT(l.t)+'</span> <span class="chip" style="font-size:10px;padding:1px 6px">'+esc(l.host)+'</span> <span class="lv-'+lvl+'">['+lvl.toUpperCase()+']</span> <span class="muted mono">'+esc(l.src)+':</span> '+esc(l.msg||"")+'</div>';
  }).join("")||'<div class="muted" style="padding:20px;text-align:center">No log messages currently match the query.</div>';

  return '<div class="viewHead"><h2>Aggregated Cluster Telemetry &amp; Logs</h2><p>'+hostHealthLine(h)+' — Real-time event log collector stream.</p></div>'+
  '<div class="card">'+
    '<div class="dockerToolbar">'+
      '<div class="row" style="gap:8px">'+
        '<select id="logLevelSel" style="background:#0a0e1a;border:1px solid var(--border2);color:#fff;border-radius:8px;padding:8px 12px;outline:none">'+
          '<option value="all">All Severities</option><option value="info">Info Only</option><option value="warn">Warnings Only</option><option value="error">Errors Only</option>'+
        '</select>'+
        '<input id="logQInput" placeholder="Filter log text, source, or host..." value="'+esc(S.logQ)+'" style="min-width:260px;background:#0a0e1a;border:1px solid var(--border2);color:#fff;border-radius:8px;padding:8px 12px;outline:none">'+
      '</div>'+
      '<div class="row">'+
        '<button class="btn sm" data-act="pauseLogs">'+(S.settings.pauseLogs?"Resume Stream":"Pause Stream")+'</button>'+
        '<button class="btn sm primary" data-act="dlLogs">Export Log Stream</button>'+
      '</div>'+
    '</div>'+
    '<div class="terminalBox" style="max-height:560px">'+linesHtml+'</div>'+
  '</div>';
}

/* ---------- 9. Agents / Setup View ---------- */
function vSetup(h){
  return '<div class="viewHead"><h2>Agent Fleet &amp; Compute Node Setup</h2><p>Deploy lightweight agents onto remote Linux or VPS instances to stream real-time metrics to this dashboard.</p></div>'+
  '<div class="grid g2">'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:12px"><h3>Active Monitored Nodes</h3><span class="badge ok">● '+S.hosts.length+' Registered</span></div>'+
      S.hosts.map(function(x){
        return '<div class="row" style="justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)">'+
          '<div><div style="font-weight:700;font-size:14px">'+esc(x.name)+'</div><div class="muted small mono">'+esc(x.base||"local")+'</div></div>'+
          '<div class="row">'+
            '<button class="btn sm" data-act="pollNow" data-id="'+x.id+'">Poll</button>'+
            '<button class="btn sm" data-act="editHost" data-id="'+x.id+'">Edit</button>'+
            (S.hosts.length>1?'<button class="btn sm danger" data-act="delHost" data-id="'+x.id+'">Delete</button>':"")+
          '</div>'+
        '</div>';
      }).join("")+
      '<div class="toolbar" style="margin-top:16px">'+
        '<button class="btn sm primary" data-act="addHost">+ Add Remote Node</button>'+
        '<button class="btn sm" data-act="pasteJson">Import JSON Snapshot</button>'+
      '</div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="row" style="justify-content:space-between;margin-bottom:12px"><h3>Instant Docker Deployment</h3><span class="badge info">Port 55555</span></div>'+
      '<p class="muted small" style="margin-bottom:12px">Run this single Docker command on any target server to expose host metrics &amp; Docker container telemetry:</p>'+
      '<div class="codeCard">docker run -d \\<br>&nbsp;&nbsp;--name sysmon-vps-agent \\<br>&nbsp;&nbsp;--restart unless-stopped \\<br>&nbsp;&nbsp;-p 55555:55555 \\<br>&nbsp;&nbsp;-v /var/run/docker.sock:/var/run/docker.sock:ro \\<br>&nbsp;&nbsp;-v /proc:/host/proc:ro \\<br>&nbsp;&nbsp;sysmon-vps-agent</div>'+
      '<p class="muted small" style="margin:12px 0 6px">Verify the agent is responding:</p>'+
      '<div class="codeCard">curl http://&lt;HOST_IP&gt;:55555/api/summary</div>'+
    '</div>'+
  '</div>';
}

/* ---------- Navigation & Master Chrome ---------- */
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
var NAVGROUPS=[["Observe",["overview"]],["Measure",["systems","perf","network"]],["Inspect",["docker","apps","fs","logs"]],["Configure",["setup"]]];

function paintNav(){
  var n=$("sideNav");if(!n)return;
  var h=activeHost();
  var contCount=(h&&h.containers)?h.containers.filter(function(c){return c.state==="running";}).length:0;

  var html="";
  NAVGROUPS.forEach(function(g){
    html+='<div class="navSec">'+g[0]+'</div>';
    g[1].forEach(function(id){
      var m=NAVMETA[id];
      var badgeHtml="";
      if(id==="docker"&&contCount>0){
        badgeHtml='<span class="navBadge">'+contCount+' live</span>';
      }
      html+='<button class="navBtn'+(S.view===id?" on":"")+'" data-nav="'+id+'"><span class="ico">'+m.icon+'</span>'+m.label+badgeHtml+'</button>';
    });
  });
  n.innerHTML=html;
}

function paintHostPicker(){
  var sel=$("hostSel");
  var cur=activeHost();
  if(sel){
    var targetHtml=S.hosts.map(function(h){
      var isSsh = (h.base && h.base.includes("/ssh")) || (h.name && h.name.includes("SSH"));
      var isVps = (h.base && h.base.includes("192.168.101.116")) || (h.ip === "192.168.101.116") || isSsh;
      var isLocal = (h.base && (h.base.includes("localhost") || h.base.includes("127.0.0.1")) && !isSsh) || (h.ip === "127.0.0.1" && !isSsh);
      var icon = isSsh ? "🔑 " : (isVps ? "☁️ " : (isLocal ? "💻 " : "🖥️ "));
      var title = h.name || "Server";
      if(isSsh && !title.includes("SSH")) title = "VPS · admin (SSH Agentless)";
      else if(isVps && !title.includes("192.168.101.116") && !isSsh) title = "VPS · " + (h.name||"admin") + " (192.168.101.116)";
      else if(isLocal && !title.toLowerCase().includes("local")) title = "Localhost (" + (h.ip||"127.0.0.1") + ")";
      var stat = h.status==="online" ? "● Online ("+(h.ms!=null?h.ms+"ms":"ok")+")" : (h.status==="polling" ? "◌ Sync" : "○ Offline");
      return '<option value="'+h.id+'"'+(h.id===S.activeId?" selected":"")+'>'+icon+esc(title)+' — '+stat+'</option>';
    }).join("");

    if(sel.dataset.lastHtml !== targetHtml || sel.value !== S.activeId){
      sel.innerHTML = targetHtml;
      sel.value = S.activeId;
      sel.dataset.lastHtml = targetHtml;
    }
  }

  // Update quick switch pills
  var pillVps = $("pillVps");
  var pillLocal = $("pillLocal");
  if(pillVps && pillLocal && cur){
    var isCurVps = (cur.base && (cur.base.includes("192.168.101.116") || cur.base.includes("/ssh"))) || (cur.ip === "192.168.101.116") || (cur.name && cur.name.includes("VPS"));
    if(isCurVps){
      pillVps.classList.add("active");
      pillLocal.classList.remove("active");
    } else {
      pillLocal.classList.add("active");
      pillVps.classList.remove("active");
    }
    // Update live status dots on pills
    var vpsH = S.hosts.find(function(h){ return (h.base && (h.base.includes("192.168.101.116") || h.base.includes("/ssh"))) || h.ip === "192.168.101.116" || (h.name && h.name.includes("VPS")); });
    var localH = S.hosts.find(function(h){ return (h.base && (h.base.includes("localhost") || h.base.includes("127.0.0.1")) && !h.base.includes("/ssh")) || h.ip === "127.0.0.1"; });
    if(vpsH){
      var vDot = pillVps.querySelector(".dot");
      if(vDot) vDot.className = "dot " + (vpsH.status==="online"?"ok":vpsH.status==="polling"?"warn":"bad");
    }
    if(localH){
      var lDot = pillLocal.querySelector(".dot");
      if(lDot) lDot.className = "dot " + (localH.status==="online"?"ok":localH.status==="polling"?"warn":"bad");
    }
  }

  var b=$("connBadge");
  if(b&&cur){
    var cls=cur.status==="online"?"ok":cur.status==="polling"?"warn":"bad";
    b.className="badge "+cls;
    b.textContent=cur.status.toUpperCase()+(cur.ms!=null?" "+cur.ms+"ms":"");
  }
}

/* ---------- Modal Windows & Log Terminal ---------- */
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
  openModal(
    '<div class="dlgHeader">'+
      '<div class="dlgTitle">Add Remote Compute Node</div>'+
      '<span class="badge info">Collector HTTP</span>'+
    '</div>'+
    '<div class="dlgBody">'+
      '<label class="mLabel" style="display:block;margin-bottom:4px">Server Friendly Name</label>'+
      '<input id="mName" value="'+esc(h.name||"")+'" placeholder="Production VPS" style="width:100%;margin-bottom:12px;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
      '<label class="mLabel" style="display:block;margin-bottom:4px">Collector Base URL (e.g. 192.168.101.116:55555 or 192.168.101.116:22222)</label>'+
      '<input id="mBase" value="'+esc(h.base||"")+'" placeholder="http://192.168.101.116:55555" style="width:100%;margin-bottom:12px;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
      '<label class="mLabel" style="display:block;margin-bottom:4px">Bearer Auth Token (if required, else blank)</label>'+
      '<input id="mToken" value="'+esc(h.token||"")+'" placeholder="optional" style="width:100%;background:#060910;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:#fff">'+
    '</div>'+
    '<div class="dlgFooter">'+
      '<button class="btn sm" data-act="closeModal">Cancel</button>'+
      '<button class="btn primary sm" data-act="saveHost" data-id="'+(edit?edit.id:"")+'">Save &amp; Connect</button>'+
    '</div>'
  );
}

function modalLogs(title,lines){
  var formattedHtml=(lines||[]).slice(-400).map(function(l){
    if(typeof l==="string")return '<div class="logLine">'+esc(l)+'</div>';
    var lvl=(l.level||"info").toLowerCase();
    return '<div class="logLine"><span class="t">'+fmtT(l.t)+'</span> <span class="lv-'+lvl+'">['+lvl.toUpperCase()+']</span> '+esc(l.msg||"")+'</div>';
  }).join("")||'<div class="muted">No recent container logs captured.</div>';

  openModal(
    '<div class="dlgHeader">'+
      '<div class="macDots"><span class="macDot red" onclick="closeModal()"></span><span class="macDot yellow"></span><span class="macDot green"></span></div>'+
      '<div class="dlgTitle">'+
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'+
        '<span>'+esc(title)+'</span>'+
      '</div>'+
      '<span class="badge info">'+(lines||[]).length+' entries</span>'+
    '</div>'+
    '<div class="dlgBody" style="padding:14px 18px">'+
      '<div class="row" style="margin-bottom:12px;justify-content:space-between">'+
        '<input id="modalLogFilter" placeholder="Filter output in real time..." style="background:rgba(0,0,0,0.6);border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:12px;color:#fff;width:280px;outline:none">'+
        '<button class="btn sm" data-act="copyLogs">'+
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Logs'+
        '</button>'+
      '</div>'+
      '<div id="modalLogBox" class="terminalBox">'+formattedHtml+'</div>'+
    '</div>'+
    '<div class="dlgFooter">'+
      '<span class="muted small">Tailing live output via Docker daemon socket</span>'+
      '<button class="btn primary sm" data-act="closeModal">Close Terminal</button>'+
    '</div>'
  );

  setTimeout(function(){
    var fi=$("modalLogFilter");
    if(fi){
      fi.focus();
      fi.addEventListener("input",function(){
        var q=fi.value.toLowerCase();
        var linesDom=document.querySelectorAll("#modalLogBox .logLine");
        linesDom.forEach(function(el){
          if(!q||el.textContent.toLowerCase().includes(q)) el.style.display="";
          else el.style.display="none";
        });
      });
    }
    var box=$("modalLogBox");
    if(box)box.scrollTop=box.scrollHeight;
  },50);
}

/* ---------- Render Engine ---------- */
function render(full){
  paintNav();
  paintHostPicker();
  var h=activeHost();
  var el=$("viewCtn");
  if(!el)return;
  if(!h){
    el.innerHTML='<div class="card" style="text-align:center;padding:48px 20px"><h3>No compute hosts connected.</h3><button class="btn primary" style="margin-top:14px" data-act="addHost">+ Add VPS Host</button></div>';
    return;
  }
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
  if(full){
    el.classList.remove("enter");void el.offsetWidth;el.classList.add("enter");
    clearTimeout(el._et);el._et=setTimeout(function(){el.classList.remove("enter");},600);
  }
}

function tickClock(){
  var c=$("liveClock");
  if(c){try{c.textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){}}
}

function afterRender(h){
  document.querySelectorAll("canvas[data-hist]").forEach(function(cv){
    var key=cv.getAttribute("data-hist");
    var hid=cv.getAttribute("data-host")||h.id;
    var host=S.hosts.find(function(x){return x.id===hid;})||h;
    var series=(host.hist&&host.hist[key])||[];
    if(key==="tx")drawLine(cv,series.slice(-MAX_HIST),{color:"#60a5fa",fill:"rgba(96,165,250,.24)"});
    else if(key==="dio")drawLine(cv,series.slice(-MAX_HIST),{color:"#8b5cf6",fill:"rgba(139,92,246,.24)"});
    else if(key==="rx")drawLine(cv,series.slice(-MAX_HIST),{color:"#06b6d4",fill:"rgba(6,182,212,.24)"});
    else drawLine(cv,series.slice(-MAX_HIST),{max:100,color:key==="mem"?"#8b5cf6":key==="gpu"?"#10b981":"#06b6d4",fill:key==="mem"?"rgba(139,92,246,.24)":key==="gpu"?"rgba(16,185,129,.24)":"rgba(6,182,212,.24)"});
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
  ctx.strokeStyle="rgba(255,255,255,0.06)";
  for(var g=0;g<=3;g++){var y=6+(h-12)*g/3;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  var defs=[{k:"cpu",c:"#06b6d4"},{k:"mem",c:"#8b5cf6"},{k:"gpu",c:"#10b981"}];
  defs.forEach(function(d){
    var s=(host.hist[d.k]||[]).slice(-MAX_HIST);if(!s.length)return;
    ctx.beginPath();
    for(var i=0;i<s.length;i++){
      var x=4+(w-8)*i/(MAX_HIST-1);
      var yy=h-6-(clamp(s[i],0,100)/100)*(h-12);
      if(i===0)ctx.moveTo(x,yy);else ctx.lineTo(x,yy);
    }
    ctx.strokeStyle=d.c;ctx.lineWidth=2;ctx.stroke();
  });
  ctx.fillStyle="#94a3b8";ctx.font="10px monospace";
  ctx.fillText("CPU — (Cyan)   MEM — (Violet)   GPU — (Mint)",8,14);
}

/* ---------- Global Click Actions ---------- */
document.addEventListener("click",async function(e){
  var pv=e.target.closest("#pillVps");
  if(pv){
    var vHost=S.hosts.find(function(x){return (x.base&&(x.base.includes("192.168.101.116")||x.base.includes("/ssh")))||x.ip==="192.168.101.116"||(x.name&&x.name.includes("VPS"));});
    if(vHost && S.activeId!==vHost.id){
      S.activeId=vHost.id;
      localStorage.setItem("pulseboard.activeBase.v1",vHost.base);
      pollHost(vHost);
      render(true);
      paintHostPicker();
      toast("Switched to Remote VPS (192.168.101.116)","info");
    }
    return;
  }
  var pl=e.target.closest("#pillLocal");
  if(pl){
    var lHost=S.hosts.find(function(x){return (x.base&&(x.base.includes("localhost")||x.base.includes("127.0.0.1"))&&!x.base.includes("/ssh"))||x.ip==="127.0.0.1";});
    if(lHost && S.activeId!==lHost.id){
      S.activeId=lHost.id;
      localStorage.setItem("pulseboard.activeBase.v1",lHost.base);
      pollHost(lHost);
      render(true);
      paintHostPicker();
      toast("Switched to Local Machine","info");
    }
    return;
  }

  var nb=e.target.closest("[data-nav]");
  if(nb){S.view=nb.getAttribute("data-nav");render(true);return;}
  var t=e.target.closest("[data-act]");if(!t)return;
  var act=t.getAttribute("data-act"),id=t.getAttribute("data-id");
  var h=activeHost();

  if(act==="closeModal")closeModal();
  else if(act==="focus"){
    S.activeId=id;
    var fh=activeHost();
    if(fh){
      localStorage.setItem("pulseboard.activeBase.v1",fh.base);
      pollHost(fh);
    }
    S.view="overview";
    render(true);
    paintHostPicker();
  }
  else if(act==="addHost")modalAddHost(null);
  else if(act==="editHost"){var eh=S.hosts.find(function(x){return x.id===id;});modalAddHost(eh);}
  else if(act==="saveHost"){
    var name=($("mName").value||"").trim()||"server";
    var base=normBase($("mBase").value||"");
    var token=($("mToken").value||"").trim();
    if(!base){toast("Please enter a collector base URL","bad");return;}
    if(id){
      var ex=S.hosts.find(function(x){return x.id===id;});
      ex.name=name;ex.base=base;ex.token=token;startPolling(ex);saveHosts();
    }else{
      var nh=createHostObj({name:name,base:base,token:token});
      S.hosts.push(nh);S.activeId=nh.id;startPolling(nh);saveHosts();
    }
    closeModal();render(true);toast("Target host saved — streaming telemetry...");
  }
  else if(act==="delHost"){
    var dh=S.hosts.find(function(x){return x.id===id;});
    stopPolling(dh);S.hosts=S.hosts.filter(function(x){return x.id!==id;});
    if(S.activeId===id)S.activeId=S.hosts[0]?S.hosts[0].id:null;
    saveHosts();closeModal();render(true);
  }
  else if(act==="pollNow"){
    var ph=S.hosts.find(function(x){return x.id===id;})||h;
    if(ph){toast("Polling live telemetry...");pollHost(ph);}
  }
  else if(act==="setContFilter"){
    S.contFilter=t.getAttribute("data-val")||"all";render(false);
  }
  else if(act==="setContView"){
    S.contView=t.getAttribute("data-val")||"grid";render(false);
  }
  else if(act==="copyLogs"){
    var box=$("modalLogBox");
    if(box){
      navigator.clipboard.writeText(box.innerText||box.textContent).then(function(){toast("Terminal logs copied to clipboard");});
    }
  }
  else if(act==="contLogs"){
    var c=h.containers.find(function(x){return x.id===id;});
    if(!c)return;
    if(h.base){
      try{
        var hd2={};if(h.token)hd2["Authorization"]="Bearer "+h.token;
        var r2=await fetch(h.base+"/api/logs?container="+encodeURIComponent(c.name)+"&tail=300",{headers:hd2});
        var j2=await r2.json();
        var lines=(j2.lines||j2.logs||[]);
        if(!lines.length)lines=[{t:Date.now(),level:"info",msg:"No recent log events for container "+c.name}];
        modalLogs(c.name+" ("+c.image+")",lines);return;
      }catch(err2){toast("Log fetch failed: "+err2.message,"bad");return;}
    }else{
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
      toast("Restart command delivered to "+c2.name);pollHost(h);
    }catch(err3){toast("Restart failed: "+err3.message,"bad");}
  }
  else if(act==="contStop"){
    var c3=h.containers.find(function(x){return x.id===id;});
    if(!h.base){toast("Stop needs a live host","warn");return;}
    if(!confirm("Stop container "+c3.name+" on "+h.name+"?"))return;
    try{
      var hd4={"Content-Type":"application/json"};if(h.token)hd4["Authorization"]="Bearer "+h.token;
      var r4=await fetch(h.base+"/api/containers/"+encodeURIComponent(c3.id||c3.name)+"/stop",{method:"POST",headers:hd4});
      if(!r4.ok)throw new Error("HTTP "+r4.status);
      toast("Stop signal delivered to "+c3.name);pollHost(h);
    }catch(err4){toast("Stop failed: "+err4.message,"bad");}
  }
  else if(act==="contStart"){
    var c4=h.containers.find(function(x){return x.id===id;});
    if(!h.base){toast("Start needs a live host","warn");return;}
    try{
      var hd5={"Content-Type":"application/json"};if(h.token)hd5["Authorization"]="Bearer "+h.token;
      var r5=await fetch(h.base+"/api/containers/"+encodeURIComponent(c4.id||c4.name)+"/start",{method:"POST",headers:hd5});
      if(!r5.ok)throw new Error("HTTP "+r5.status);
      toast("Start signal delivered to "+c4.name);pollHost(h);
    }catch(err5){toast("Start failed: "+err5.message,"bad");}
  }
  else if(act==="addWatch"){
    var wh=($("watchHostInput").value||"").trim(),wp=parseInt(($("watchPortInput").value||"").trim(),10),wl=($("watchLabelInput").value||"").trim();
    if(!wh||!wp){toast("Please enter IP and port","warn");return;}
    S.watch.push({host:wh,port:wp,label:wl});saveSettings();render(true);
  }
  else if(act==="unwatch"){
    S.watch.splice(parseInt(t.getAttribute("data-i"),10),1);saveSettings();render(true);
  }
  else if(act==="exportCfg"){
    download("pulseboard-hosts.json",JSON.stringify(S.hosts.filter(function(x){return x.kind==="live";}).map(function(x){return {name:x.name,base:x.base,token:x.token};}),null,2));
  }
  else if(act==="pauseFs"){
    S.settings.pauseFs=!S.settings.pauseFs;saveSettings();render(true);
  }
  else if(act==="pauseLogs"){
    S.settings.pauseLogs=!S.settings.pauseLogs;saveSettings();render(true);
  }
  else if(act==="dlLogs"){
    download("pulseboard-"+h.name+".log",allLogs().map(function(l){return new Date(l.t).toISOString()+" ["+l.level+"] "+l.host+"/"+l.src+" "+l.msg;}).join("\n"));
  }
  else if(act==="checkPorts"){
    toast("Probing host ports…");
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
        var j=await r.json();modalLogs(a.name+" ("+h.name+")",(j.lines||j.logs||[]));return;
      }catch(err){modalLogs(a.name+" (fetch failed: "+err.message+")",[]);return;}
    }
    modalLogs(a.name+" ("+h.name+")",h.logs.filter(function(l){return (l.src||"").includes(a.name);}));
  }
});

function download(name,text){
  var b=new Blob([text],{type:"text/plain"});
  var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=name;a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);},4000);
}

async function probeHttp(host,app){
  var url="http://"+(app.ip||host.ip)+":"+app.port+"/";
  var t0=performance.now();
  try{
    await fetch(url,{mode:"no-cors",signal:AbortSignal.timeout(6000)});
    app.latencyMs=Math.round(performance.now()-t0);
    if(app.status==="stopped"){app.status="running";}
  }catch(e){app.latencyMs=null;}
}

document.addEventListener("change",function(e){
  if(e.target.id==="hostSel"){
    S.activeId=e.target.value;
    var nh=activeHost();
    if(nh){
      localStorage.setItem("pulseboard.activeBase.v1",nh.base);
      pollHost(nh);
    }
    render(true);
    paintHostPicker();
  }
  if(e.target.id==="fsFilterSel"){S.fsFilter=e.target.value;render(true);}
  if(e.target.id==="logLevelSel"){S.logLevel=e.target.value;render(true);}
});

document.addEventListener("input",function(e){
  if(e.target.id==="contQInput"){
    S.contQ=e.target.value;render(false);
    var el=$("contQInput");if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}
  }
  if(e.target.id==="appQInput"){
    S.appQ=e.target.value;render(false);
    var a2=$("appQInput");if(a2){a2.focus();a2.setSelectionRange(a2.value.length,a2.value.length);}
  }
  if(e.target.id==="fsQInput"){
    S.fsQ=e.target.value;render(false);
    var f2=$("fsQInput");if(f2){f2.focus();f2.setSelectionRange(f2.value.length,f2.value.length);}
  }
  if(e.target.id==="logQInput"){S.logQ=e.target.value;}
});

/* ---------- Application Bootstrap ---------- */
function boot(){
  loadPersist();
  S.hosts=[];
  try{
    var saved=JSON.parse(localStorage.getItem(LS_HOSTS)||"[]");
    if(!Array.isArray(saved)) saved=[];

    var currentOrigin=(window.location&&window.location.origin&&!window.location.origin.startsWith("file:"))?window.location.origin:"";
    var isOnVps = currentOrigin.includes("192.168.101.116");

    var localBase = (currentOrigin && !isOnVps) ? currentOrigin : "http://localhost:22222";
    var vpsSshBase = localBase + "/api/ssh";
    var vpsDirectBase = "http://192.168.101.116:22222";

    var hasSshVps = saved.some(function(h){
      return (h.base && h.base.includes("/ssh")) || (h.name && h.name.includes("SSH"));
    });
    var hasLocal = saved.some(function(h){
      return (h.base && (h.base.includes("localhost") || h.base.includes("127.0.0.1")) && !h.base.includes("/ssh")) || (h.name && h.name.toLowerCase().includes("local"));
    });

    if(!hasSshVps){
      saved.unshift({name:"VPS (192.168.101.116) [SSH Agentless]", base:vpsSshBase, token:""});
    }
    if(!hasLocal){
      saved.push({name:"Local Machine (localhost)", base:localBase, token:""});
    }

    // Standardize friendly names & clean up old container ID hashes
    saved.forEach(function(c){
      if(c.base && c.base.includes("/ssh")){
        c.name = "VPS (192.168.101.116) [SSH Agentless]";
      } else if(c.base && c.base.includes("192.168.101.116")){
        c.name = "VPS (192.168.101.116)";
      } else if(c.base && (c.base.includes("localhost") || c.base.includes("127.0.0.1"))){
        c.name = "Local Machine (localhost)";
      }
      var nh=createHostObj(c);
      S.hosts.push(nh);
      startPolling(nh);
    });
    saveHosts();
  }catch(e){}

  // Select initial active host: prioritize saved preference, then VPS
  var savedBase = localStorage.getItem("pulseboard.activeBase.v1");
  var matchedHost = savedBase ? S.hosts.find(function(h){return h.base===savedBase;}) : null;
  if(matchedHost){
    S.activeId = matchedHost.id;
  } else {
    var vHost = S.hosts.find(function(h){return (h.base && (h.base.includes("/ssh") || h.base.includes("192.168.101.116")));});
    S.activeId = vHost ? vHost.id : (S.hosts[0] ? S.hosts[0].id : null);
  }
  
  render(true);
  var be=$("bootEl");if(be)be.remove();

  setInterval(tickClock,1000);
  tickClock();

  // Polling loop
  setInterval(function(){
    if(S.view&&!S.settings.pauseFs&&!S.settings.pauseLogs){
      render(false);
    }
  },2000);

  var qb=$("quickRefreshBtn");
  if(qb){
    qb.addEventListener("click",function(){
      var h=activeHost();
      if(h){toast("Refreshing metrics...");pollHost(h);}
    });
  }

  window.addEventListener("resize",function(){render(false);});
}

if(document.readyState!=="loading")boot();
else document.addEventListener("DOMContentLoaded",boot);
})();
