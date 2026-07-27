import { ServerResponse } from "node:http";

export function handleDemoPage(res: ServerResponse): void {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SilverVisit AI Demo</title>
  <style>
    body{font-family:Inter,Arial,sans-serif;background:#f4f7fb;color:#162033;margin:0}
    .wrap{max-width:980px;margin:0 auto;padding:32px 20px}
    .hero{background:#fff;border-radius:20px;padding:28px;box-shadow:0 10px 35px rgba(24,43,77,.09)}
    h1{margin:0 0 8px;font-size:36px}.sub{color:#5e6b7f;margin-bottom:24px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 8px 24px rgba(24,43,77,.07)}
    textarea{width:100%;min-height:92px;box-sizing:border-box;border:1px solid #cfd7e6;border-radius:12px;padding:12px;font-size:16px}
    button{border:0;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}.primary{background:#2563eb;color:#fff}.secondary{background:#edf2ff;color:#1e40af}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}.status{margin-top:14px;padding:12px;border-radius:12px;background:#eef6ff;white-space:pre-wrap}.appointment{border:1px solid #d9e1ef;border-radius:14px;padding:16px;margin-top:12px}.highlight{outline:4px solid #22c55e;outline-offset:3px}.muted{color:#6b7280;font-size:14px}.ok{color:#166534;font-weight:700}.bad{color:#991b1b;font-weight:700}
    @media(max-width:760px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="muted">YC Fall 2026 production demo</div>
    <h1>SilverVisit AI</h1>
    <div class="sub">An AI navigator that helps older adults complete telehealth visits step by step.</div>
    <textarea id="goal">Help me join my doctor appointment today.</textarea>
    <div class="actions"><button class="primary" id="start">Run AI navigator</button><button class="secondary" id="reset">Reset</button></div>
    <div id="status" class="status">Ready. This demo uses the live Vercel backend, Supabase, and Gemini.</div>
  </section>
  <div class="grid" style="margin-top:18px">
    <section class="card">
      <h2>Patient portal</h2>
      <div id="patient" class="muted">Loading fictional patient fixture…</div>
      <div class="appointment">
        <strong>Today at 1:30 PM</strong><br/>Dr. Naomi Patel · Video Check-in
        <div class="actions">
          <button id="details-start-echeckin-btn" class="secondary">Start eCheck-In</button>
          <button id="details-open-device-setup-btn" class="secondary">Open Device Setup</button>
          <button id="cancel-appointment-btn" class="secondary">Cancel appointment</button>
        </div>
      </div>
    </section>
    <section class="card">
      <h2>AI decision</h2>
      <div id="result" class="muted">The grounded action selected by Gemini will appear here.</div>
    </section>
  </div>
</div>
<script>
const statusEl=document.getElementById('status');
const resultEl=document.getElementById('result');
const buttons=[...document.querySelectorAll('.appointment button')];
let fixture=null;
function clearHighlight(){buttons.forEach(b=>b.classList.remove('highlight'))}
async function json(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Request-Id':crypto.randomUUID(),...(options.headers||{})}});const t=await r.text();let b={};try{b=JSON.parse(t)}catch{}if(!r.ok)throw new Error(b.error||b.message||('HTTP '+r.status));return b}
async function loadFixture(){const data=await json('/api/sandbox/fixture?seed=2');fixture=data.fixture;document.getElementById('patient').textContent=fixture.patientName+' · Fictional demo patient';}
async function run(){clearHighlight();statusEl.textContent='Starting production session…';resultEl.textContent='Waiting for Gemini…';try{
 const goal=document.getElementById('goal').value.trim();
 const session=await json('/api/session/start',{method:'POST',body:JSON.stringify({userGoal:goal})});
 await json('/api/sandbox/run/start',{method:'POST',body:JSON.stringify({seed:2,source:'sandbox',navigatorSessionId:session.sessionId})});
 const elements=buttons.map((b,i)=>({id:b.id,text:b.textContent,role:'button',x:100,y:300+i*70,width:220,height:48,visible:true,enabled:true}));
 const plan=await json('/api/plan-action',{method:'POST',body:JSON.stringify({sessionId:session.sessionId,userGoal:goal,pageUrl:location.href,pageTitle:document.title,visibleText:['SilverVisit Virtual Clinic','Today at 1:30 PM','Dr. Naomi Patel - Video Check-in','eCheck-In is required before joining','Start eCheck-In','Open Device Setup'],elements,sandboxFixture:fixture})});
 if(plan.action&&plan.action.targetId){document.getElementById(plan.action.targetId)?.classList.add('highlight')}
 resultEl.innerHTML='<div class="ok">Production AI call passed</div><p><b>Action:</b> '+(plan.action?.type||'none')+' '+(plan.action?.targetId||'')+'</p><p><b>Confidence:</b> '+Math.round((plan.confidence||0)*100)+'%</p><p><b>Why:</b> '+(plan.grounding?.reasoningSummary||plan.message)+'</p>';
 statusEl.textContent='Done. Gemini selected a grounded next step and Supabase stored the session.';
 }catch(e){resultEl.innerHTML='<div class="bad">Demo error</div><p>'+e.message+'</p>';statusEl.textContent='Something failed. Refresh and try again.'}}
document.getElementById('start').addEventListener('click',run);document.getElementById('reset').addEventListener('click',()=>{clearHighlight();resultEl.textContent='The grounded action selected by Gemini will appear here.';statusEl.textContent='Ready.'});
loadFixture().catch(e=>{statusEl.textContent='Fixture load failed: '+e.message});
</script>
</body></html>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}
