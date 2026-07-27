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
    .log{display:flex;flex-direction:column;gap:10px;margin-top:12px}.log-item{border:1px solid #dde4ef;border-radius:13px;padding:12px;background:#fafcff}.log-item strong{display:block;margin-bottom:4px}.engine{display:inline-block;padding:2px 8px;border-radius:999px;background:#e0e7ff;color:#3730a3;font-size:12px;font-weight:800;margin-bottom:5px}.ok{color:#166534;font-weight:800}.bad{color:#991b1b;font-weight:800}.complete{padding:20px;border-radius:16px;background:#ecfdf3;border:1px solid #86efac;color:#14532d;text-align:center}.complete .big{font-size:30px;font-weight:900;margin-bottom:6px}
    @media(max-width:800px){.grid{grid-template-columns:1fr}h1{font-size:32px}}
  </style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">YC Fall 2026 production demo</div>
    <h1>SilverVisit AI</h1>
    <div class="sub">Gemini identifies the telehealth workflow; SilverVisit's safety engine completes only validated, non-destructive prerequisites.</div>
    <textarea id="goal">Help me join my doctor appointment today.</textarea>
    <div class="actions"><button class="primary" id="start">Run full AI navigator</button><button class="secondary" id="reset">Reset</button></div>
    <div class="progress"><div id="progressBar"></div></div>
    <div id="status" class="status">Ready. This production demo uses Vercel, Supabase, Gemini, and SilverVisit's deterministic safety engine.</div>
  </section>

  <div class="grid">
    <section class="card">
      <h2 style="margin-top:0">Patient portal</h2>
      <div id="patient" class="muted">Loading fictional patient fixture…</div>
      <div id="portal" class="portal"></div>
    </section>
    <section class="card">
      <h2 style="margin-top:0">Navigator activity</h2>
      <div class="muted">The server verifies every target against the controls visible on the current fictional screen.</div>
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

const stages=[
  {key:'pre_check_in',title:'Today at 1:30 PM',copy:'Dr. Naomi Patel · Video Check-in. eCheck-In is required before you can join.',safeId:'details-start-echeckin-btn',buttons:[{id:'details-start-echeckin-btn',text:'Start eCheck-In',next:1},{id:'cancel-appointment-btn',text:'Cancel appointment',danger:true}]},
  {key:'echeckin_in_progress',title:'eCheck-In',copy:'The fictional patient information is ready. Finish eCheck-In to continue.',safeId:'echeckin-finish-btn',buttons:[{id:'echeckin-finish-btn',text:'Finish eCheck-In',next:2},{id:'echeckin-cancel-btn',text:'Cancel eCheck-In',danger:true}]},
  {key:'device_setup',title:'Device setup',copy:'Camera and microphone checks are complete. Continue to the waiting room.',safeId:'finish-device-test-btn',buttons:[{id:'finish-device-test-btn',text:'Continue to waiting room',next:3},{id:'device-cancel-visit-btn',text:'Cancel visit',danger:true}]},
  {key:'provider_ready',title:'Provider is ready',copy:'Dr. Naomi Patel is ready. Enter the secure video call to complete the goal.',safeId:'enter-call-btn',buttons:[{id:'enter-call-btn',text:'Enter Call',next:4},{id:'provider-leave-room-btn',text:'Leave waiting room',danger:true}]}
];

function escapeHtml(value){return String(value).replace(/[&<>"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]})}
function sleep(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
async function json(path,options){options=options||{};const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Request-Id':crypto.randomUUID(),...(options.headers||{})}});const text=await response.text();let body={};try{body=JSON.parse(text)}catch{}if(!response.ok)throw new Error(body.error||body.message||('HTTP '+response.status));return body}

function renderStage(){
  progressBar.style.width=(stage/stages.length*100)+'%';
  if(stage>=stages.length){portalEl.innerHTML='<div class="complete"><div class="big">Visit joined</div><div>SilverVisit completed eCheck-In, device setup, waiting-room progression, and the final Enter Call action.</div></div>';progressBar.style.width='100%';return}
  const current=stages[stage];
  const buttonHtml=current.buttons.map(function(button){return '<button class="choice '+(button.danger?'danger':'secondary')+'" id="'+button.id+'">'+escapeHtml(button.text)+'</button>'}).join('');
  portalEl.innerHTML='<div class="portal-title">'+escapeHtml(current.title)+'</div><div class="screen-copy">'+escapeHtml(current.copy)+'</div><div class="actions">'+buttonHtml+'</div>';
}

function addLog(index,result){
  if(index===0)logEl.innerHTML='';
  const item=document.createElement('div');item.className='log-item';
  const engine=result.engine==='gemini'?'Gemini intent planner':'SilverVisit safety engine';
  item.innerHTML='<span class="engine">'+escapeHtml(engine)+'</span><strong>Step '+(index+1)+': click '+escapeHtml(result.actualTargetId||'')+'</strong><div>Confidence: '+Math.round((result.confidence||0)*100)+'%</div><div class="muted">Target validated against the current visible controls.</div>';
  logEl.appendChild(item);item.scrollIntoView({behavior:'smooth',block:'nearest'});
}

async function animateResult(index,result){
  const current=stages[index];
  if(!result.passed||result.actualTargetId!==current.safeId)throw new Error('Server verification failed at step '+(index+1)+'.');
  const target=document.getElementById(result.actualTargetId);if(!target)throw new Error('Verified target is not visible on step '+(index+1)+'.');
  const button=current.buttons.find(function(candidate){return candidate.id===result.actualTargetId});if(!button||button.danger)throw new Error('Safety check rejected the returned action.');
  addLog(index,result);target.classList.add('highlight');await sleep(700);target.classList.remove('highlight');target.classList.add('executed');await sleep(400);stage=button.next;renderStage();
}

async function run(){
  if(running)return;running=true;startBtn.disabled=true;document.getElementById('goal').disabled=true;stage=0;renderStage();logEl.innerHTML='<div class="log-item muted">Starting verified production workflow…</div>';
  try{
    statusEl.textContent='Gemini is identifying the workflow and SilverVisit is validating the safe path…';
    const result=await json('/api/demo/run');
    if(!result.ok||result.finalState!=='joined'||result.completedSteps!==stages.length||!Array.isArray(result.results))throw new Error('The production workflow did not verify successfully.');
    for(let index=0;index<result.results.length;index+=1){statusEl.textContent='Executing verified step '+(index+1)+' of '+stages.length+'…';await animateResult(index,result.results[index])}
    statusEl.innerHTML='<span class="ok">Completed.</span> Gemini identified the workflow, SilverVisit executed all four validated actions, and the fictional visit was joined.';
  }catch(error){statusEl.innerHTML='<span class="bad">Demo stopped:</span> '+escapeHtml(error.message||String(error));const item=document.createElement('div');item.className='log-item';item.innerHTML='<div class="bad">Integration failure</div><div>'+escapeHtml(error.message||String(error))+'</div>';logEl.appendChild(item)}finally{running=false;startBtn.disabled=false;document.getElementById('goal').disabled=false}
}

function reset(){if(running)return;stage=0;renderStage();progressBar.style.width='0';logEl.innerHTML='<div class="log-item muted">No actions yet.</div>';statusEl.textContent="Ready. This production demo uses Vercel, Supabase, Gemini, and SilverVisit's deterministic safety engine."}
async function loadFixture(){const data=await json('/api/sandbox/fixture?seed=2');fixture=data.fixture;document.getElementById('patient').textContent=fixture.patientName+' · Fictional demo patient';renderStage()}
startBtn.addEventListener('click',run);document.getElementById('reset').addEventListener('click',reset);loadFixture().catch(function(error){statusEl.innerHTML='<span class="bad">Fixture load failed:</span> '+escapeHtml(error.message||String(error))});
</script>
</body></html>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}
