import { ServerResponse } from "node:http";

export function handleDemoPage(res: ServerResponse): void {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SilverVisit AI Demo</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f3f6fb}
    *{box-sizing:border-box}body{margin:0}.wrap{max-width:1080px;margin:0 auto;padding:28px 18px 48px}
    .hero,.card{background:#fff;border:1px solid #e3e8f2;border-radius:20px;box-shadow:0 12px 38px rgba(31,48,80,.08)}
    .hero{padding:26px}.eyebrow{font-size:13px;font-weight:700;color:#52627a;text-transform:uppercase;letter-spacing:.08em}
    h1{font-size:38px;margin:5px 0 6px}.sub{color:#5c6a7f;margin-bottom:20px}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-top:18px}
    .card{padding:22px}textarea{width:100%;min-height:78px;border:1px solid #ccd5e4;border-radius:13px;padding:13px;font-size:17px;resize:vertical}
    button{border:0;border-radius:12px;padding:12px 17px;font-weight:750;cursor:pointer;font-size:15px}.primary{background:#2563eb;color:#fff}.secondary{background:#eaf0ff;color:#1e40af}.danger{background:#fff;border:1px solid #c9d2e1;color:#334155}
    button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.status{margin-top:14px;padding:13px 15px;border-radius:12px;background:#edf5ff;color:#20324f;white-space:pre-wrap}
    .portal{border:1px solid #d7dfec;border-radius:16px;padding:18px;margin-top:14px;min-height:285px}.portal-title{font-size:20px;font-weight:800}.muted{color:#67758a;font-size:14px}.screen-copy{margin:12px 0 4px;line-height:1.55}
    .choice{transition:all .22s ease}.highlight{outline:4px solid #22c55e;outline-offset:3px;transform:translateY(-1px)}.executed{background:#dcfce7!important;color:#166534!important}
    .progress{height:10px;background:#e8edf5;border-radius:999px;overflow:hidden;margin-top:16px}.progress>div{height:100%;width:0;background:#2563eb;transition:width .35s ease}
    .log{display:flex;flex-direction:column;gap:10px;margin-top:12px}.log-item{border:1px solid #dde4ef;border-radius:13px;padding:12px;background:#fafcff}.log-item strong{display:block;margin-bottom:4px}.ok{color:#166534;font-weight:800}.bad{color:#991b1b;font-weight:800}.complete{padding:20px;border-radius:16px;background:#ecfdf3;border:1px solid #86efac;color:#14532d;text-align:center}.complete .big{font-size:30px;font-weight:900;margin-bottom:6px}
    @media(max-width:800px){.grid{grid-template-columns:1fr}h1{font-size:32px}}
  </style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">YC Fall 2026 production demo</div>
    <h1>SilverVisit AI</h1>
    <div class="sub">A grounded AI navigator that completes a fictional telehealth workflow one safe step at a time.</div>
    <textarea id="goal">Help me join my doctor appointment today.</textarea>
    <div class="actions"><button class="primary" id="start">Run full AI navigator</button><button class="secondary" id="reset">Reset</button></div>
    <div class="progress"><div id="progressBar"></div></div>
    <div id="status" class="status">Ready. The production demo uses Vercel, Supabase, and the live Gemini API.</div>
  </section>

  <div class="grid">
    <section class="card">
      <h2 style="margin-top:0">Patient portal</h2>
      <div id="patient" class="muted">Loading fictional patient fixture…</div>
      <div id="portal" class="portal"></div>
    </section>
    <section class="card">
      <h2 style="margin-top:0">AI activity</h2>
      <div class="muted">Every step below is selected by Gemini from the buttons currently visible on the fictional portal.</div>
      <div id="log" class="log"><div class="log-item muted">No actions yet.</div></div>
    </section>
  </div>
</div>
<script>
const statusEl=document.getElementById('status');
const portalEl=document.getElementById('portal');
const logEl=document.getElementById('log');
const startBtn=document.getElementById('start');
const progressBar=document.getElementById('progressBar');
let fixture=null;
let running=false;
let stage=0;
let sessionId='';
let runId='';

const stages=[
  {
    key:'pre_check_in', title:'Today at 1:30 PM', copy:'Dr. Naomi Patel · Video Check-in. eCheck-In is required before you can join.',
    buttons:[
      {id:'details-start-echeckin-btn',text:'Start eCheck-In',next:1},
      {id:'cancel-appointment-btn',text:'Cancel appointment',danger:true}
    ]
  },
  {
    key:'echeckin_in_progress', title:'eCheck-In', copy:'Your contact and insurance information are ready for confirmation.',
    buttons:[
      {id:'echeckin-confirm-information-btn',text:'Confirm information',next:2},
      {id:'echeckin-cancel-btn',text:'Cancel eCheck-In',danger:true}
    ]
  },
  {
    key:'device_setup', title:'Device setup', copy:'A camera and microphone check is required before entering the waiting room.',
    buttons:[
      {id:'device-run-check-btn',text:'Run device check',next:3},
      {id:'device-cancel-visit-btn',text:'Cancel visit',danger:true}
    ]
  },
  {
    key:'waiting_room', title:'Pre-visit steps complete', copy:'The appointment is ready. Enter the waiting room for Dr. Naomi Patel.',
    buttons:[
      {id:'waiting-enter-room-btn',text:'Enter waiting room',next:4},
      {id:'waiting-leave-btn',text:'Leave appointment',danger:true}
    ]
  },
  {
    key:'provider_ready', title:'Provider is ready', copy:'Dr. Naomi Patel is ready to begin the secure video visit.',
    buttons:[
      {id:'provider-join-video-btn',text:'Join video visit',next:5},
      {id:'provider-leave-room-btn',text:'Leave waiting room',danger:true}
    ]
  }
];

function escapeHtml(value){return String(value).replace(/[&<>"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]})}
function sleep(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
async function json(path,options){options=options||{};const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Request-Id':crypto.randomUUID(),...(options.headers||{})}});const text=await response.text();let body={};try{body=JSON.parse(text)}catch{}if(!response.ok)throw new Error(body.error||body.message||('HTTP '+response.status));return body}

function renderStage(){
  progressBar.style.width=(stage/5*100)+'%';
  if(stage>=5){
    portalEl.innerHTML='<div class="complete"><div class="big">Visit joined</div><div>SilverVisit completed eCheck-In, device setup, waiting-room entry, and the final join action.</div></div>';
    progressBar.style.width='100%';
    return;
  }
  const current=stages[stage];
  const buttonHtml=current.buttons.map(function(button){return '<button class="choice '+(button.danger?'danger':'secondary')+'" id="'+button.id+'">'+escapeHtml(button.text)+'</button>'}).join('');
  portalEl.innerHTML='<div class="portal-title">'+escapeHtml(current.title)+'</div><div class="screen-copy">'+escapeHtml(current.copy)+'</div><div class="actions">'+buttonHtml+'</div>';
}

function addLog(index,plan){
  if(index===0)logEl.innerHTML='';
  const item=document.createElement('div');
  item.className='log-item';
  item.innerHTML='<strong>Step '+(index+1)+': '+escapeHtml(plan.action.type)+' '+escapeHtml(plan.action.targetId||'')+'</strong><div>Confidence: '+Math.round((plan.confidence||0)*100)+'%</div><div class="muted">'+escapeHtml((plan.grounding&&plan.grounding.reasoningSummary)||plan.message||'Grounded in the visible page.')+'</div>';
  logEl.appendChild(item);
  item.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function currentElements(){
  return Array.from(portalEl.querySelectorAll('button')).map(function(button,index){
    const rect=button.getBoundingClientRect();
    return {id:button.id,text:button.textContent||'',role:'button',x:Math.round(rect.x||100),y:Math.round(rect.y||260+index*60),width:Math.round(rect.width||220),height:Math.round(rect.height||48),visible:true,enabled:!button.disabled};
  });
}

function visibleText(){
  if(stage>=5)return ['Visit joined','Telehealth visit connected'];
  const current=stages[stage];
  return ['SilverVisit Virtual Clinic',current.title,current.copy].concat(current.buttons.map(function(button){return button.text}));
}

function fixtureForStage(){
  const clone=JSON.parse(JSON.stringify(fixture));
  clone.portalState=stage>=5?'joined':stages[stage].key;
  return clone;
}

async function executePlan(plan){
  if(!plan.action||plan.action.type!=='click'||!plan.action.targetId)throw new Error('Gemini did not return a clickable grounded action.');
  const target=document.getElementById(plan.action.targetId);
  if(!target)throw new Error('Gemini targeted an element that is not visible.');
  const current=stages[stage];
  const button=current.buttons.find(function(candidate){return candidate.id===plan.action.targetId});
  if(!button)throw new Error('The returned action did not match the current screen.');
  if(button.danger)throw new Error('Safety check blocked a destructive action: '+button.text);
  target.classList.add('highlight');
  await sleep(700);
  target.classList.remove('highlight');
  target.classList.add('executed');
  await json('/api/sandbox/run/event',{method:'POST',body:JSON.stringify({runId:runId,step:current.key,eventType:'ai_action_executed',metadata:{targetId:button.id,confidence:plan.confidence}})});
  await sleep(450);
  stage=button.next;
  renderStage();
}

async function run(){
  if(running)return;
  running=true;startBtn.disabled=true;document.getElementById('goal').disabled=true;
  stage=0;renderStage();logEl.innerHTML='<div class="log-item muted">Starting live production session…</div>';
  try{
    const goal=document.getElementById('goal').value.trim();
    if(!goal)throw new Error('Enter a goal first.');
    statusEl.textContent='Creating a production session in Supabase…';
    const session=await json('/api/session/start',{method:'POST',body:JSON.stringify({userGoal:goal})});
    sessionId=session.sessionId;
    const run=await json('/api/sandbox/run/start',{method:'POST',body:JSON.stringify({seed:2,source:'sandbox',navigatorSessionId:sessionId})});
    runId=run.runId;
    for(let index=0;index<5;index+=1){
      statusEl.textContent='Gemini is reading step '+(index+1)+' of 5…';
      const elements=currentElements();
      const plan=await json('/api/plan-action',{method:'POST',body:JSON.stringify({sessionId:sessionId,userGoal:goal,pageUrl:location.href,pageTitle:document.title,visibleText:visibleText(),elements:elements,sandboxFixture:fixtureForStage()})});
      addLog(index,plan);
      await executePlan(plan);
    }
    statusEl.innerHTML='<span class="ok">Completed.</span> The AI executed all five grounded steps and reached the joined visit state.';
  }catch(error){
    statusEl.innerHTML='<span class="bad">Demo stopped:</span> '+escapeHtml(error.message||String(error));
    const item=document.createElement('div');item.className='log-item';item.innerHTML='<div class="bad">Integration failure</div><div>'+escapeHtml(error.message||String(error))+'</div>';logEl.appendChild(item);
  }finally{
    running=false;startBtn.disabled=false;document.getElementById('goal').disabled=false;
  }
}

function reset(){
  if(running)return;stage=0;sessionId='';runId='';renderStage();progressBar.style.width='0';logEl.innerHTML='<div class="log-item muted">No actions yet.</div>';statusEl.textContent='Ready. The production demo uses Vercel, Supabase, and the live Gemini API.';
}

async function loadFixture(){
  const data=await json('/api/sandbox/fixture?seed=2');fixture=data.fixture;document.getElementById('patient').textContent=fixture.patientName+' · Fictional demo patient';renderStage();
}
startBtn.addEventListener('click',run);document.getElementById('reset').addEventListener('click',reset);
loadFixture().catch(function(error){statusEl.innerHTML='<span class="bad">Fixture load failed:</span> '+escapeHtml(error.message||String(error))});
</script>
</body></html>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}
