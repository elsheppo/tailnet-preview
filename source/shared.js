const $=s=>document.querySelector(s);
const icons={more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',studio:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 3v18M8 8h13"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',pin:'<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6Zm3 12v6"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',phone:'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',tablet:'<rect x="3" y="2" width="18" height="20" rx="2"/><path d="M10 18h4"/>',desktop:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',rotate:'<rect x="4" y="7" width="10" height="14" rx="2"/><path d="M9 3h8a4 4 0 0 1 4 4v6m-4-4 4 4 2-4"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',sliders:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',chevron:'<path d="m8 10 4 4 4-4"/>',moon:'<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',sidebar:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'};
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.studio}</svg>`}
for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=icon(el.dataset.icon);
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function readLocal(key,fallback){try{return JSON.parse(localStorage.getItem('tailnet-studio:'+key))??fallback}catch{return fallback}}
function saveLocal(key,value){try{localStorage.setItem('tailnet-studio:'+key,JSON.stringify(value));return true}catch{return false}}
let toastTimer;function toast(message){const box=$('#toast');box.textContent=message;box.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.classList.remove('show'),3500)}
async function copyText(value,message='Link copied'){try{await navigator.clipboard.writeText(value);toast(message)}catch{const d=$('#copy-dialog');$('#copy-value').value=value;d.showModal();$('#copy-value').select()}}
function friendly(name){return name==='default'?'Overview':name.split('-').map(v=>/^v\d+$/.test(v)?v:v.charAt(0).toUpperCase()+v.slice(1)).join(' ')}
function viewHref(project,view){return `/p/${encodeURIComponent(project.id)}/${encodeURIComponent(view||project.primaryView||Object.keys(project.views)[0])}`}
function statusFor(project){return project.state==='sleeping'?[project.mode==='attached'?'Disconnected':'Stopped','sleeping']:project.healthy?['Available','']:['Unavailable','unavailable']}
function statusNode(project){const [label,kind]=statusFor(project);return el('span','status '+kind,label)}
function initials(name){return name.split(/\s+/).slice(0,2).map(v=>v[0]).join('').toUpperCase()}
function dateLabel(value){const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function localMap(key){const value=readLocal(key,{});return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>button.closest('dialog').close();

// The gateway provides only fixed lifecycle actions for registered projects.

icons.play='<path d="m8 5 11 7-11 7Z"/>';
icons.stop='<rect x="6" y="6" width="12" height="12" rx="1"/>';
icons.trash='<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>';
const managementDialog=el('dialog','management-dialog');managementDialog.setAttribute('aria-labelledby','management-title');document.body.append(managementDialog);
let actionPending=false;
managementDialog.addEventListener('cancel',event=>{if(actionPending)event.preventDefault()});
function manageProject(project, options={}){
 managementDialog.replaceChildren();managementDialog.classList.remove('confirming');managementDialog.setAttribute('aria-labelledby','management-title');managementDialog.removeAttribute('aria-describedby');
 const head=el('div','management-head'),identity=el('div','management-identity'),eyebrow=el('p','management-label','Instance controls'),title=el('h2','',project.name);title.id='management-title';eyebrow.id='management-question';title.tabIndex=-1;identity.append(eyebrow,title);
 const tools=el('div','management-tools'),close=el('button','icon-btn');close.innerHTML=icon('close');close.setAttribute('aria-label','Close instance controls');close.onclick=()=>managementDialog.close();
 if(options.onPin){const pin=el('button','icon-btn dialog-pin');pin.innerHTML=icon('pin');pin.setAttribute('aria-label',options.isPinned?'Unpin project':'Pin project');pin.setAttribute('aria-pressed',String(!!options.isPinned));pin.title=pin.getAttribute('aria-label');pin.onclick=()=>{managementDialog.close();options.onPin()};tools.append(pin)}tools.append(close);head.append(identity,tools);
 const state=el('div','management-state');state.append(statusNode(project),el('span','ownership',project.mode==='supervised'?'Managed app':'External app'));
 const actions=el('div','management-actions'),footer=el('div','management-footer'),message=el('p','action-message');message.setAttribute('role','status');
 managementDialog.append(head,state,actions,footer,message);
 const definitions=[];
 if(project.mode==='supervised'){
  if(project.state==='sleeping'||!project.healthy)definitions.push(['start','Start app','Bring this preview online','play']);
  if(project.state!=='sleeping')definitions.push(['restart','Restart','Briefly interrupt the app','refresh'],['stop','Stop app','Keep project and saved views','stop']);
 }else{
  const note=el('p','external-note',project.state==='sleeping'?'The preview is disconnected. Its app is managed elsewhere.':'This app is managed elsewhere. Disconnecting only turns off preview access.');actions.before(note);
  if(project.state!=='sleeping')definitions.push(['disconnect','Disconnect','Leave the external app running','stop']);
 }
 for(const [action,label,description,glyph] of definitions){const button=el('button','management-action '+(action==='start'?'start-action':''));const symbol=el('span','action-symbol');symbol.innerHTML=icon(glyph);button.append(symbol,el('strong','',label),el('span','action-description',description));button.dataset.action=action;button.onclick=()=>action==='start'?run(action,label):confirmAction(action);actions.append(button)}
 if(definitions.length){const note=el('p','management-hint',project.mode==='supervised'?'Changes apply to everyone using this preview.':'The external app keeps running.');actions.after(note)}
 const removal=el('button','remove-action');removal.append(el('span','','Remove from library'));const arrow=el('span','icon');arrow.innerHTML=icon('arrow');removal.append(arrow);removal.dataset.action='remove';removal.onclick=()=>confirmAction('remove');footer.append(removal);
 function confirmAction(action){
  const confirmations={
   stop:{question:'Stop app?',label:'Stop app',copy:'This will stop the app for everyone using this preview. Active work will be interrupted, and unsaved or in-memory state may be lost.',retained:'The project, saved views, and source files will stay. You can start the app again.'},
   restart:{question:'Restart app?',label:'Restart app',copy:'This will stop the app and start it again for everyone using this preview. Active work will be interrupted, and unsaved or in-memory state may be lost.',retained:'Your preview links, saved views, and source files will stay.'},
   disconnect:{question:'Disconnect preview?',label:'Disconnect preview',copy:'This will turn off preview access for everyone. Anyone using this preview will lose their connection.',retained:'The external app will keep running. Reconnecting this preview requires the Tailnet Preview helper.'},
   remove:{question:'Remove project?',label:'Remove project',copy:project.mode==='supervised'?'This will stop the app for everyone and remove its saved views and preview links. Unsaved or in-memory state may be lost.':'This will remove the saved views and preview links for everyone. The external app will keep running.',retained:'Your source files will stay intact.'}
  };
  const detail=confirmations[action];if(!detail)return;
  managementDialog.classList.add('confirming');eyebrow.textContent=detail.question;managementDialog.setAttribute('aria-labelledby','management-question management-title');managementDialog.setAttribute('aria-describedby','confirmation-copy');state.hidden=true;managementDialog.querySelector('.management-hint')?.remove();managementDialog.querySelector('.external-note')?.remove();tools.querySelector('.dialog-pin')?.remove();actions.replaceChildren();footer.replaceChildren();
  const copy=el('p','removal-copy',detail.copy);copy.id='confirmation-copy';const retained=el('p','retained-note',detail.retained);actions.append(copy,retained);
  const back=el('button','btn','Cancel'),confirm=el('button','btn '+(action==='remove'?'danger':'primary'),detail.label);
  back.onclick=()=>{manageProject(project,options);managementDialog.querySelector(`[data-action="${action}"]`)?.focus()};confirm.onclick=()=>run(action,detail.label);footer.append(back,confirm);back.focus();
 }
 async function run(action,label){
  if(actionPending)return;actionPending=true;managementDialog.setAttribute('aria-busy','true');for(const b of managementDialog.querySelectorAll('button'))b.disabled=true;
  message.textContent={start:'Starting app…',stop:'Stopping app…',restart:'Restarting app…',disconnect:'Disconnecting preview…',remove:'Removing project…'}[action];message.classList.remove('error');
  try{const response=await fetch('/_tailnet-preview/action',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':config.managementToken},body:JSON.stringify({id:project.id,action})});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'The action did not finish.');try{sessionStorage.setItem('preview-receipt',JSON.stringify({message:`${project.name}: ${{start:'started',stop:'stopped',restart:'restarted',disconnect:'disconnected',remove:'removed'}[action]}`}))}catch{}if(action==='remove')location.assign('/');else location.reload();
  }catch(error){message.textContent=(error instanceof TypeError?'The connection was interrupted. Refresh to check the current state before trying again.':error.message);message.classList.add('error');actions.replaceChildren();footer.replaceChildren();const refresh=el('button','btn','Refresh current state');refresh.onclick=()=>location.reload();actions.append(refresh);actionPending=false;close.disabled=false;managementDialog.removeAttribute('aria-busy')}
 }
 if(!managementDialog.open)managementDialog.showModal();title.focus();
}
try{const receipt=JSON.parse(sessionStorage.getItem('preview-receipt'));sessionStorage.removeItem('preview-receipt');if(receipt?.message)setTimeout(()=>toast(receipt.message),100)}catch{}
