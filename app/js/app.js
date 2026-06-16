/* ============================================================
   CREATIS STUDIO — CRM  ·  Version Supabase / Vercel
   Auteur : MonWe Infinity LLC pour Creatis Studio
   ============================================================ */
"use strict";

/* ============================================================
   SUPABASE CLIENT
   ============================================================ */
const SB = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   ÉTAT LOCAL (cache en mémoire — hydraté depuis Supabase)
   ============================================================ */
let DB = { settings:{}, roles:[], users:[], clients:[], products:[], devis:[], factures:[], commandes:[], depenses:[] };
let USER = null;
let usersTab = "comptes";
let clientSearch = "";
let current = "dashboard";
const SESSION_KEY = "creatis_session_v2";

/* ============================================================
   TRANSFORMATION CHAMPS  camelCase ↔ snake_case Supabase
   ============================================================ */
const FIELD_TO_DB = {
  clientId:"client_id", devisId:"devis_id", factureId:"facture_id",
  montantHT:"montant_ht", montantTVA:"montant_tva", montantTTC:"montant_ttc",
  createdAt:"created_at", roleId:"role_id",
  seqDevis:"seq_devis", seqFacture:"seq_facture", seqCommande:"seq_commande",
  systemRole:"system_role"
};
const FIELD_FROM_DB = Object.fromEntries(Object.entries(FIELD_TO_DB).map(([a,b])=>[b,a]));

function toDb(obj){
  const r={};
  for(const [k,v] of Object.entries(obj)){
    const dk=FIELD_TO_DB[k]||k;
    if(dk!=="updated_at") r[dk]=v;
  }
  delete r.updated_at;
  return r;
}
function fromDb(row){
  if(!row)return row;
  const r={};
  for(const [k,v] of Object.entries(row)){
    const ak=FIELD_FROM_DB[k]||k;
    r[ak]= v===null?undefined:v;
  }
  delete r.updated_at;
  return r;
}
function mapRows(rows){ return (rows||[]).map(fromDb); }

/* ============================================================
   COUCHE DB SUPABASE (CRUD)
   ============================================================ */
async function dbFetch(table, order="created_at"){
  const {data,error} = await SB.from(table).select("*").order(order, {ascending:false});
  if(error){ console.error("dbFetch",table,error); return []; }
  return mapRows(data||[]);
}
async function dbFetchOne(table){
  const {data,error} = await SB.from(table).select("*").limit(1).maybeSingle();
  if(error){ console.error("dbFetchOne",table,error); return null; }
  return fromDb(data);
}
async function dbUpsert(table, obj){
  const row = toDb(obj);
  const {error} = await SB.from(table).upsert(row, {onConflict:"id"});
  if(error){ console.error("dbUpsert",table,error); toast("Erreur de sauvegarde ("+table+")"); return false; }
  return true;
}
async function dbUpdate(table, id, patch){
  const row = toDb(patch);
  const {error} = await SB.from(table).update(row).eq("id",id);
  if(error){ console.error("dbUpdate",table,error); return false; }
  return true;
}
async function dbDelete(table, id){
  const {error} = await SB.from(table).delete().eq("id",id);
  if(error){ console.error("dbDelete",table,error); toast("Erreur de suppression"); return false; }
  return true;
}
async function dbUpsertSettings(settings){
  const row = toDb({...settings});
  delete row.id;
  if(!DB._settingsId){ const r=await SB.from("app_settings").select("id").limit(1).maybeSingle(); DB._settingsId=r?.data?.id; }
  if(DB._settingsId){
    const {error}=await SB.from("app_settings").update(row).eq("id",DB._settingsId);
    if(error) console.error("settings update",error);
  } else {
    const {data,error}=await SB.from("app_settings").insert(row).select("id").maybeSingle();
    if(!error) DB._settingsId=data?.id;
  }
}

// Sync optimiste : met à jour l'état local PUIS sync Supabase en fond
function sync(table, obj){
  const supaTable = {users:"profiles", settings:"app_settings"}[table]||table;
  if(table==="settings"){ dbUpsertSettings(DB.settings).catch(e=>console.error(e)); return; }
  dbUpsert(supaTable, obj).catch(e=>console.error(e));
}
function syncDel(table, id){
  const supaTable = {users:"profiles"}[table]||table;
  dbDelete(supaTable, id).catch(e=>console.error(e));
}

/* ============================================================
   CHARGEMENT INITIAL
   ============================================================ */
async function loadAll(){
  const [settingsRow, rolesRows, usersRows, clientsRows, productsRows,
         devisRows, facturesRows, commandesRows, depensesRows] = await Promise.all([
    dbFetchOne("app_settings"),
    dbFetch("roles","created_at"),
    dbFetch("profiles","created_at"),
    dbFetch("clients","created_at"),
    dbFetch("products","designation"),
    dbFetch("devis","created_at"),
    dbFetch("factures","created_at"),
    dbFetch("commandes","created_at"),
    dbFetch("depenses","created_at"),
  ]);

  // Settings — reconstruire au format attendu par l'app
  if(settingsRow){
    DB._settingsId = settingsRow.id;
    DB.settings = {
      company: settingsRow.company||defaultCompany(),
      tva: settingsRow.tva||18,
      devise: settingsRow.devise||"F CFA",
      year: settingsRow.year||new Date().getFullYear(),
      seqDevis: settingsRow.seqDevis||1,
      seqFacture: settingsRow.seqFacture||1,
      seqCommande: settingsRow.seqCommande||1,
    };
  } else {
    DB.settings = defaultSettings();
    dbUpsertSettings(DB.settings).catch(e=>console.error(e));
  }

  // Rôles — si aucun, injecter les rôles par défaut
  if(rolesRows.length){
    DB.roles = rolesRows.map(r=>({...r, system: r.systemRole}));
  } else {
    DB.roles = defaultRoles();
    DB.roles.forEach(r=>{
      SB.from("roles").upsert(toDb({...r, systemRole:r.system}),{onConflict:"id"}).catch(e=>console.error(e));
    });
  }

  DB.users     = usersRows;
  DB.clients   = clientsRows;
  DB.products  = productsRows;
  DB.devis     = devisRows;
  DB.factures  = facturesRows;
  DB.commandes = commandesRows;
  DB.depenses  = depensesRows;
}

/* ============================================================
   DEFAULTS
   ============================================================ */
function defaultCompany(){
  return {name:"Creatis Studio",activite:"Création · Impression · Fournitures de bureau · Gadgets",forme:"SARL",capital:"1 000 000 F CFA",siege:"Cocody Val Doyen 4 — Duplex Appartement 135",tel:"27 22 44 23 06",cel:"07 07 96 40 01",email:"infos@creatis-ci.com",site:"www.creatis-ci.com",rc:"CI-ABJ-2007-B-3172",cc:"0811105V",banque:"SGCI N° CI008 01111 011151700304 93",regime:"Réel Simplifié",centre:"II Plateaux 2",mentions:"SARL au capital de 1 000 000 F CFA"};
}
function defaultSettings(){
  return {company:defaultCompany(),tva:18,devise:"F CFA",year:new Date().getFullYear(),seqDevis:1,seqFacture:1,seqCommande:1};
}
function defaultRoles(){
  const full={};["dashboard","clients","devis","factures","commandes","compta","catalogue","users","parametres"].forEach(m=>full[m]="edit");
  const mk=(map)=>{const o={};["dashboard","clients","devis","factures","commandes","compta","catalogue","users","parametres"].forEach(m=>o[m]=map[m]||"none");return o};
  return [
    {id:"administrateur",name:"Administrateur",system:true,color:"noir",perms:full,widgets:["kpi_encaisse","kpi_reste","kpi_devis","kpi_leads","chart_ca","pipe_devis","list_relance","list_echeances"]},
    {id:"commercial",name:"Commercial",color:"cyan",perms:mk({dashboard:"view",clients:"edit",devis:"edit",factures:"edit",commandes:"edit",catalogue:"edit"}),widgets:["kpi_devis","kpi_leads","kpi_encaisse","kpi_prod","pipe_devis","list_relance"]},
    {id:"comptable",name:"Comptable",color:"mag",perms:mk({dashboard:"view",clients:"view",devis:"view",factures:"edit",commandes:"view",compta:"edit",catalogue:"view"}),widgets:["kpi_encaisse","kpi_reste","kpi_tva","kpi_depenses","chart_ca","list_echeances"]},
    {id:"production",name:"Production",color:"jaune",perms:mk({dashboard:"view",clients:"view",devis:"view",commandes:"edit",catalogue:"view"}),widgets:["kpi_prod","kpi_devis","list_prod"]},
    {id:"accueil",name:"Accueil / Information",color:"cyan",perms:mk({dashboard:"view",clients:"edit",devis:"view",commandes:"view",catalogue:"view"}),widgets:["kpi_leads","kpi_devis","list_relance"]}
  ];
}

/* ============================================================
   AUTH — custom SHA-256 (stocké dans Supabase profiles)
   ============================================================ */
async function passHash(login, pwd){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("creatis::v2::"+login.toLowerCase()+"::"+pwd));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

const LOGO_SVG=`<svg width="34" height="34" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="17" stroke="#FFC400" stroke-width="3.4" stroke-dasharray="58 90" transform="rotate(-30 20 20)"/><circle cx="20" cy="20" r="13.5" stroke="#EC008C" stroke-width="3.4" stroke-dasharray="44 90" transform="rotate(110 20 20)"/><circle cx="20" cy="20" r="13.5" stroke="#00AEEF" stroke-width="3.4" stroke-dasharray="40 120" transform="rotate(-110 20 20)"/><text x="20" y="26" font-family="Space Grotesk,sans-serif" font-size="20" font-weight="700" fill="#1A1A1C" text-anchor="middle">C</text></svg>`;

function renderAuth(){
  document.body.classList.add("auth-on");
  const onboard=!(DB.users&&DB.users.length);
  const co=DB.settings.company||{};
  $("#auth").innerHTML=`<div class="auth-bg"></div><div class="auth-card"><div class="auth-cmyk"><i></i><i></i><i></i><i></i></div>
    <div class="auth-body">
      <div class="auth-brand">${LOGO_SVG}<div><div class="ab-n">CREATIS STUDIO</div><div class="ab-s">CRM</div></div></div>
      ${onboard?`
        <h3>Bienvenue 👋</h3><p class="muted">Créez le compte administrateur pour démarrer.</p>
        <form id="f-onb" onsubmit="return false">
          <div class="field"><label>Votre nom</label><input id="onb-name" autocomplete="name" required></div>
          <div class="field"><label>Identifiant de connexion</label><input id="onb-login" autocomplete="username" required></div>
          <div class="row2">
            <div class="field"><label>Mot de passe</label><input id="onb-pwd" type="password" required></div>
            <div class="field"><label>Confirmer</label><input id="onb-pwd2" type="password" required></div>
          </div>
          <div id="onb-err" class="auth-err"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doOnboard()">Créer le compte & entrer</button>
        </form>`:`
        <h3>Connexion</h3><p class="muted">Espace ${esc(co.name||"Creatis Studio")}</p>
        <form id="f-login" onsubmit="return false">
          <div class="field"><label>Identifiant</label><input id="li-login" autocomplete="username" required></div>
          <div class="field"><label>Mot de passe</label><input id="li-pwd" type="password" autocomplete="current-password" required></div>
          <div id="login-err" class="auth-err"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">Se connecter</button>
        </form>`}
    </div></div>`;
  $("#auth").classList.add("show");
  setTimeout(()=>{ const i=$("#auth input"); if(i)i.focus(); },60);
}

async function doOnboard(){
  const name=($("#onb-name")||{}).value?.trim();
  const login=($("#onb-login")||{}).value?.trim();
  const pw=($("#onb-pwd")||{}).value||"";
  const pw2=($("#onb-pwd2")||{}).value||"";
  const err=$("#onb-err");
  if(!name||!login||!pw){if(err)err.textContent="Remplissez tous les champs.";return}
  if(pw!==pw2){if(err)err.textContent="Les mots de passe ne correspondent pas.";return}
  if(err)err.textContent="Création…";
  const u={id:uid(),name,login,roleId:"administrateur",active:true,pass:await passHash(login,pw),createdAt:Date.now()};
  const ok = await dbUpsert("profiles", u);
  if(!ok){if(err)err.textContent="Erreur de création. Vérifiez Supabase.";return}
  DB.users.push(u);
  enterApp(u);
  toast("Compte administrateur créé");
}
async function doLogin(){
  const login=($("#li-login")||{}).value?.trim().toLowerCase()||"";
  const pw=($("#li-pwd")||{}).value||"";
  const u=DB.users.find(x=>(x.login||"").toLowerCase()===login&&x.active!==false);
  const errEl=$("#login-err");
  if(!u){if(errEl)errEl.textContent="Identifiant ou mot de passe incorrect.";return}
  const h=await passHash(u.login,pw);
  if(u.pass!==h){if(errEl)errEl.textContent="Identifiant ou mot de passe incorrect.";return}
  enterApp(u);
}
function enterApp(u){
  USER=u;
  try{localStorage.setItem(SESSION_KEY,u.id)}catch(e){}
  document.body.classList.remove("auth-on");
  $("#auth").classList.remove("show");
  applyNav();refreshUserChip();refreshBadges();go(firstAllowedRoute());
}
function logout(){
  USER=null;
  try{localStorage.removeItem(SESSION_KEY)}catch(e){}
  closeOverlays();
  const b=$("#userchip"); if(b)b.innerHTML="";
  renderAuth();
}

/* ============================================================
   RBAC
   ============================================================ */
const MODS=[
  {k:"dashboard",label:"Tableau de bord"},{k:"clients",label:"Clients & prospects"},
  {k:"devis",label:"Devis"},{k:"factures",label:"Factures"},
  {k:"commandes",label:"Commandes & projets"},{k:"compta",label:"Comptabilité & TVA"},
  {k:"catalogue",label:"Catalogue"},{k:"users",label:"Utilisateurs & rôles"},
  {k:"parametres",label:"Paramètres"}
];
const WIDGETS=[
  {k:"kpi_encaisse",label:"Encaissé (mois/année)"},{k:"kpi_reste",label:"Reste à encaisser"},
  {k:"kpi_devis",label:"Devis en attente"},{k:"kpi_leads",label:"Nouveaux contacts"},
  {k:"kpi_tva",label:"TVA à reverser"},{k:"kpi_depenses",label:"Dépenses"},
  {k:"kpi_prod",label:"Production en cours"},{k:"chart_ca",label:"Graphe CA 6 mois"},
  {k:"pipe_devis",label:"Pipeline devis"},{k:"list_relance",label:"Devis à relancer"},
  {k:"list_echeances",label:"Échéances factures"},{k:"list_prod",label:"Commandes en cours"}
];

function roleOf(u){ return (DB.roles||[]).find(r=>r.id===((u&&u.roleId)||(u&&u.role_id)))||null; }
function permLevel(mod){ const r=roleOf(USER); if(!r)return"none"; return(r.perms&&r.perms[mod])||"none"; }
function vis(mod){ return permLevel(mod)!=="none"; }
function wr(mod){ return permLevel(mod)==="edit"; }
function isAdmin(){ return wr("users"); }
function guard(mod){ if(!wr(mod)){toast("Action en lecture seule pour votre profil");return false}return true; }
function firstAllowedRoute(){ for(const m of MODS){if(vis(m.k))return m.k}return "dashboard"; }

function applyNav(){
  const nav=$("#nav"); if(!nav)return;
  const kids=[...nav.children];
  kids.forEach(el=>{if(el.tagName==="A")el.style.display=vis(el.dataset.route)?"":"none"});
  kids.forEach((el,i)=>{if(el.classList&&el.classList.contains("sec")){
    let any=false;for(let j=i+1;j<kids.length;j++){const n=kids[j];if(n.classList&&n.classList.contains("sec"))break;if(n.tagName==="A"&&n.style.display!=="none"){any=true;break}}
    el.style.display=any?"":"none";}});
}
function refreshUserChip(){
  const box=$("#userchip"); if(!box)return;
  if(!USER){box.innerHTML="";return}
  const r=roleOf(USER);
  const ini=(USER.name||"?").trim().split(/\s+/).map(w=>w[0]||"").slice(0,2).join("").toUpperCase();
  box.innerHTML=`<div class="uchip"><div class="uava cc-${(r&&r.color)||"noir"}">${esc(ini)}</div>
    <div class="uinfo"><div class="un">${esc(USER.name)}</div><div class="ur">${esc(r?r.name:"—")}</div></div>
    <button class="btn btn-sm btn-ghost" title="Se déconnecter" onclick="logout()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 17l5-5-5-5M15 12H3"/></svg></button></div>`;
}

/* ============================================================
   HELPERS
   ============================================================ */
const $=s=>document.querySelector(s);
function fcfa(n){n=Math.round(n||0);return n.toLocaleString("fr-FR").replace(/\u202f/g," ")+" F"}
function fcfaPlain(n){n=Math.round(n||0);if(n>=1000000)return (n/1000000).toFixed(1).replace(".",",")+"M";if(n>=1000)return(n/1000).toFixed(0)+"k";return n+""}
function fdate(d){if(!d)return"—";return new Date(d).toLocaleDateString("fr-FR",{day:"2-digit",month:"short",year:"2-digit"})}
function todayISO(){return new Date().toISOString().slice(0,10)}
function clientName(id){const c=DB.clients.find(x=>x.id===id);return c?c.nom:"—"}
function esc(s){if(s==null||s===undefined)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function toast(msg,dur=2800){const t=$("#toast");if(!t)return;t.textContent=msg;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),dur)}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function calcLignes(lignes,tvaRate){let ht=0;(lignes||[]).forEach(l=>ht+=((+l.qte||0)*(+l.pu||0))*(1-((+l.remise||0)/100)));const tv=ht*(tvaRate/100);return{montantHT:Math.round(ht),montantTVA:Math.round(tv),montantTTC:Math.round(ht+tv)}}
function factPaid(f){return((f.paiements||[]).reduce((s,p)=>s+(+p.montant||0),0))}
function factStatut(f){const p=factPaid(f);if(p<=0)return"impayée";if(p>=f.montantTTC)return"payée";return"partielle"}
const PILL={
  "brouillon":["p-grey","Brouillon"],"envoyé":["p-cyan","Envoyé"],"accepté":["p-green","Accepté"],
  "refusé":["p-red","Refusé"],"annulé":["p-red","Annulé"],"payée":["p-green","Payée"],
  "impayée":["p-red","Impayée"],"partielle":["p-yellow","Partielle"],"facturée":["p-green","Facturée"],
  "devis":["p-grey","Devis"],"production":["p-cyan","Production"],"controle":["p-yellow","Contrôle Q."],
  "livré":["p-green","Livré"],"facturé":["p-green","Facturé"]
};
function pill(k){const p=PILL[k]||["p-grey",k];return`<span class="pill ${p[0]}"><span class="dot"></span>${p[1]}</span>`}
function tableMini(rows,fn,empty){if(!rows.length)return`<div class="empty-sm">${empty}</div>`;return`<div style="overflow-x:auto"><table><tbody>${rows.map(fn).join("")}</tbody></table></div>`}

/* ============================================================
   ROUTING
   ============================================================ */
const ROUTES={
  dashboard:{t:"Tableau de bord",render:viewDashboard},
  clients:{t:"Clients & prospects",render:viewClients},
  devis:{t:"Devis",render:viewDevis},
  factures:{t:"Factures",render:viewFactures},
  commandes:{t:"Commandes & projets",render:viewCommandes},
  compta:{t:"Comptabilité & TVA",render:viewCompta},
  catalogue:{t:"Catalogue produits",render:viewCatalogue},
  users:{t:"Utilisateurs & rôles",render:viewUsers},
  parametres:{t:"Paramètres",render:viewParametres},
};
function go(route){
  if(!ROUTES[route]||!vis(route))route=firstAllowedRoute();
  current=route;
  document.body.classList.toggle("ro",!wr(route));
  document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active",a.dataset.route===route));
  $("#pg-title").textContent=ROUTES[route].t;
  $("#pg-sub").textContent="";
  $("#pg-actions").innerHTML="";
  $("#sidebar").classList.remove("open");
  window.scrollTo(0,0);
  ROUTES[route].render();
}
function refreshBadges(){
  const bc=$("#b-clients"),bd=$("#b-devis"),bf=$("#b-factures"),bco=$("#b-commandes");
  if(bc)bc.textContent=DB.clients.length;
  if(bd)bd.textContent=DB.devis.filter(d=>d.statut==="brouillon"||d.statut==="envoyé").length;
  if(bf)bf.textContent=DB.factures.filter(f=>factStatut(f)!=="payée").length;
  if(bco)bco.textContent=DB.commandes.filter(c=>c.statut!=="livré"&&c.statut!=="facturé").length;
}

/* ============================================================
   TABLEAU DE BORD (adapté au rôle)
   ============================================================ */
function viewDashboard(){
  $("#pg-sub").textContent=(DB.settings.company||{}).name+" — "+new Date().toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
  const role=roleOf(USER);
  const wl=(role&&role.widgets&&role.widgets.length)?role.widgets:["kpi_encaisse","kpi_reste","kpi_devis","kpi_leads","chart_ca","list_relance"];
  const now=new Date(),m=now.getMonth(),y=now.getFullYear();
  const inMonth=s=>{const d=new Date(s);return d.getMonth()===m&&d.getFullYear()===y};
  let caMois=0,caAnnee=0;
  DB.factures.forEach(f=>(f.paiements||[]).forEach(p=>{const d=new Date(p.date);if(d.getFullYear()===y){caAnnee+=+p.montant||0;if(d.getMonth()===m)caMois+=+p.montant||0}}));
  const impaye=DB.factures.reduce((s,f)=>s+(factStatut(f)!=="payée"?(f.montantTTC-factPaid(f)):0),0);
  const ouvertes=DB.factures.filter(f=>factStatut(f)!=="payée").length;
  const devisAttente=DB.devis.filter(d=>d.statut==="envoyé").length;
  const prospects=DB.clients.filter(c=>c.type==="prospect").length;
  const leadsMois=DB.clients.filter(c=>inMonth(c.createdAt||c.created_at)).length;
  const enProd=DB.commandes.filter(c=>c.statut==="production"||c.statut==="controle").length;
  let tvaColl=0,tvaDed=0,depTTC=0;
  DB.factures.forEach(f=>{const paid=factPaid(f);if(paid>0&&f.montantTTC)tvaColl+=f.montantTVA*(paid/f.montantTTC)});
  DB.depenses.forEach(d=>{tvaDed+=d.tva||0;depTTC+=d.ttc||0});
  const tvaDue=tvaColl-tvaDed;
  const months=[];for(let i=5;i>=0;i--){const d=new Date(y,m-i,1);months.push({k:d.getMonth()+"-"+d.getFullYear(),lab:d.toLocaleDateString("fr-FR",{month:"short"}),v:0})}
  DB.factures.forEach(f=>(f.paiements||[]).forEach(p=>{const d=new Date(p.date);const key=d.getMonth()+"-"+d.getFullYear();const mm=months.find(x=>x.k===key);if(mm)mm.v+=+p.montant||0}));
  const maxV=Math.max(1,...months.map(x=>x.v));
  const pipe=[["brouillon","Brouillon"],["envoyé","Envoyé"],["accepté","Accepté"]].map(([k,l])=>({l,v:DB.devis.filter(d=>d.statut===k).reduce((s,d)=>s+d.montantTTC,0),n:DB.devis.filter(d=>d.statut===k).length}));

  const KPI={
    kpi_encaisse:`<div class="card kpi c-cyan"><span class="tick"></span><div class="lab">Encaissé ce mois</div><div class="val tabnum">${fcfa(caMois)}</div><div class="delta">${fcfa(caAnnee)} sur l'année</div></div>`,
    kpi_reste:`<div class="card kpi c-mag"><span class="tick"></span><div class="lab">Reste à encaisser</div><div class="val tabnum">${fcfa(impaye)}</div><div class="delta">${ouvertes} facture(s) ouverte(s)</div></div>`,
    kpi_devis:`<div class="card kpi c-jaune"><span class="tick"></span><div class="lab">Devis en attente</div><div class="val tabnum">${devisAttente}</div><div class="delta">à relancer</div></div>`,
    kpi_leads:`<div class="card kpi c-noir"><span class="tick"></span><div class="lab">Nouveaux contacts (mois)</div><div class="val tabnum">${leadsMois}</div><div class="delta">${prospects} prospect(s) au total</div></div>`,
    kpi_tva:`<div class="card kpi c-mag"><span class="tick"></span><div class="lab">TVA à reverser</div><div class="val tabnum">${fcfa(tvaDue)}</div><div class="delta">collectée − déductible</div></div>`,
    kpi_depenses:`<div class="card kpi c-noir"><span class="tick"></span><div class="lab">Dépenses (total)</div><div class="val tabnum">${fcfa(depTTC)}</div><div class="delta">TTC</div></div>`,
    kpi_prod:`<div class="card kpi c-cyan"><span class="tick"></span><div class="lab">Production en cours</div><div class="val tabnum">${enProd}</div><div class="delta">commande(s)</div></div>`
  };
  const kpis=wl.filter(k=>KPI[k]).map(k=>KPI[k]).join("");
  const chart=`<div class="card panel"><div class="panel-h"><h3>Chiffre d'affaires encaissé</h3><div class="spacer"></div><span class="micro">6 derniers mois</span></div><div style="display:flex;align-items:flex-end;gap:14px;height:190px;padding-top:8px">${months.map((mm,i)=>{const h=Math.max(4,Math.round(mm.v/maxV*150));const col=["var(--cyan)","var(--magenta)","var(--jaune)","var(--cyan)","var(--magenta)","var(--jaune)"][i];return`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px"><div class="tabnum" style="font-size:11px;color:var(--txt-2);font-weight:600">${mm.v?fcfaPlain(mm.v):""}</div><div style="width:100%;max-width:46px;height:${h}px;background:${col};border-radius:7px 7px 0 0"></div><div class="micro">${mm.lab}</div></div>`}).join("")}</div></div>`;
  const pipeP=`<div class="card panel"><div class="panel-h"><h3>Pipeline devis</h3></div>${pipe.map((p,i)=>{const tot=Math.max(1,...pipe.map(x=>x.v));const col=["#9aa0a8","var(--cyan)","var(--ok)"][i];return`<div class="barrow"><div class="lab">${p.l} <span class="muted">(${p.n})</span></div><div class="bar"><i style="width:${Math.round(p.v/tot*100)}%;background:${col}"></i></div><div class="v tabnum">${fcfaPlain(p.v)}</div></div>`}).join("")}</div>`;
  const relance=`<div class="card panel"><div class="panel-h"><h3>Devis à relancer</h3><div class="spacer"></div>${vis("devis")?`<span class="linkish" onclick="go('devis')">Tout voir</span>`:""}</div>${tableMini(DB.devis.filter(d=>d.statut==="envoyé").slice(0,5),d=>`<tr class="clk" onclick="openDevis('${d.id}')"><td><div class="nm">${esc(d.numero)}</div><div class="meta">${esc(clientName(d.clientId))}</div></td><td class="r tabnum">${fcfa(d.montantTTC)}</td><td class="r meta">${fdate(d.validite)}</td></tr>`,"Aucun devis en attente.")}</div>`;
  const echeances=`<div class="card panel"><div class="panel-h"><h3>Échéances factures</h3><div class="spacer"></div>${vis("factures")?`<span class="linkish" onclick="go('factures')">Tout voir</span>`:""}</div>${tableMini(DB.factures.filter(f=>factStatut(f)!=="payée").sort((a,b)=>(a.echeance||"")>(b.echeance||"")?1:-1).slice(0,5),f=>`<tr class="clk" onclick="openFacture('${f.id}')"><td><div class="nm">${esc(f.numero)}</div><div class="meta">${esc(clientName(f.clientId))}</div></td><td class="r tabnum">${fcfa(f.montantTTC-factPaid(f))}</td><td class="r">${pill(factStatut(f))}</td></tr>`,"Tout est réglé. 🎉")}</div>`;
  const prodList=`<div class="card panel"><div class="panel-h"><h3>Commandes en cours</h3><div class="spacer"></div>${vis("commandes")?`<span class="linkish" onclick="go('commandes')">Tout voir</span>`:""}</div>${tableMini(DB.commandes.filter(c=>c.statut!=="livré"&&c.statut!=="facturé").slice(0,6),c=>`<tr class="clk" onclick="openCmd('${c.id}')"><td><div class="nm">${esc(c.titre)}</div><div class="meta">${esc(clientName(c.clientId))}</div></td><td class="r">${pill(c.statut)}</td><td class="r meta">${fdate(c.deadline)}</td></tr>`,"Aucune commande en cours.")}</div>`;

  const bigMap={chart_ca:chart,pipe_devis:pipeP};const listMap={list_relance:relance,list_echeances:echeances,list_prod:prodList};
  const bigs=wl.filter(k=>bigMap[k]).map(k=>bigMap[k]);const lists=wl.filter(k=>listMap[k]).map(k=>listMap[k]);
  let html="";
  if(kpis)html+=`<div class="grid kpis">${kpis}</div>`;
  if(bigs.length>=2)html+=`<div class="two-13">${bigs[0]}${bigs[1]}</div>`;else if(bigs.length===1)html+=`<div style="margin-bottom:16px">${bigs[0]}</div>`;
  if(lists.length>=2)html+=`<div class="two" style="margin-top:16px">${lists[0]}${lists[1]}</div>`;else if(lists.length===1)html+=`<div style="margin-top:16px">${lists[0]}</div>`;
  if(lists.length===3)html+=`<div style="margin-top:16px">${lists[2]}</div>`;
  if(!html)html=`<div class="card panel"><div class="empty"><h4>Tableau de bord</h4><div>Aucun indicateur configuré pour ce profil.</div></div></div>`;
  $("#view").innerHTML=html;
}

/* ============================================================
   CLIENTS & PROSPECTS
   ============================================================ */
function viewClients(){
  if(!vis("clients"))return;
  $("#pg-actions").innerHTML=`<button class="btn btn-primary act-edit" onclick="editClient()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau contact</button>`;
  const segs=["PME","Start-up","Collectivité","Grand compte"];const sources=["Bouche-à-oreille","LinkedIn","Salon/événement","Webinaire","Appel d'offres","Site web","Autre"];
  const q=(clientSearch||"").toLowerCase();
  const list=DB.clients.filter(c=>!q||c.nom.toLowerCase().includes(q)||(c.contact||"").toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q));
  if(!list.length){$("#view").innerHTML=emptyState("Aucun client","Ajoutez vos premiers contacts.","Nouveau contact","editClient()");return}
  $("#view").innerHTML=`<div style="overflow-x:auto"><table><thead><tr><th>Nom / contact</th><th>Segment</th><th>Type</th><th>Email</th><th>Tel</th><th></th></tr></thead><tbody>
    ${list.map(c=>`<tr class="clk" onclick="openClient('${c.id}')">
      <td><div class="nm">${esc(c.nom)}</div><div class="meta">${esc(c.contact||"")}</div></td>
      <td><span class="seg">${esc(c.segment||"—")}</span></td>
      <td>${pill(c.type==="client"?"accepté":"envoyé").replace("Accepté","Client").replace("Envoyé","Prospect")}</td>
      <td class="meta">${esc(c.email||"—")}</td><td class="meta">${esc(c.tel||"—")}</td>
      <td class="r" onclick="event.stopPropagation()"><button class="btn btn-sm btn-ghost act-edit" onclick="editClient('${c.id}')">Modifier</button></td>
    </tr>`).join("")}
  </tbody></table></div>`;
}
function openClient(id){
  if(!vis("clients"))return;
  const c=DB.clients.find(x=>x.id===id);if(!c)return;
  const devis=DB.devis.filter(d=>d.clientId===id);
  const factures=DB.factures.filter(f=>f.clientId===id);
  drawer(c.nom,c.contact||"",
    kv("Type",pill(c.type))+kv("Segment",c.segment)+kv("Téléphone",c.tel)+kv("Email",c.email)+kv("Adresse",c.adresse)+kv("Source",c.source)+kv("Notes",c.notes)+
    (devis.length?`<div class="fieldset" style="margin-top:16px"><div class="fs-t">Devis</div>${devis.slice(0,3).map(d=>`<div style="display:flex;justify-content:space-between;padding:4px 0"><span>${esc(d.numero)}</span><span>${pill(d.statut)}</span></div>`).join("")}</div>`:"")+
    (factures.length?`<div class="fieldset" style="margin-top:12px"><div class="fs-t">Factures</div>${factures.slice(0,3).map(f=>`<div style="display:flex;justify-content:space-between;padding:4px 0"><span>${esc(f.numero)}</span><span>${pill(factStatut(f))}</span></div>`).join("")}</div>`:""),
    [c.type==="prospect"?{label:"Convertir en client",cls:"btn-mag",edit:1,fn:`convertClient('${id}')`}:null,{label:"Modifier",cls:"btn-primary",edit:1,fn:`closeOverlays();editClient('${id}')`}].filter(Boolean)
  );
}
function convertClient(id){if(!guard("clients"))return;const c=DB.clients.find(x=>x.id===id);c.type="client";sync("clients",c);closeOverlays();toast("Converti en client");go("clients")}
function editClient(id){
  if(!guard("clients"))return;
  const c=id?DB.clients.find(x=>x.id===id):{type:"prospect",nom:"",contact:"",segment:"PME",tel:"",email:"",adresse:"",source:"",notes:""};
  const segs=["PME","Start-up","Collectivité","Grand compte","Autre"];const sources=["Bouche-à-oreille","LinkedIn","Salon/événement","Webinaire","Appel d'offres","Site web","Autre"];
  drawer(id?"Modifier le contact":"Nouveau contact","",
    `<form id="f-client"><div class="row2">
      <div class="field"><label>Nom entreprise *</label><input name="nom" value="${esc(c.nom)}" required></div>
      <div class="field"><label>Interlocuteur</label><input name="contact" value="${esc(c.contact||"")}"></div>
    </div><div class="row2">
      <div class="field"><label>Segment</label><select name="segment">${segs.map(s=>`<option ${c.segment===s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label>Type</label><select name="type"><option value="prospect" ${c.type==="prospect"?"selected":""}>Prospect</option><option value="client" ${c.type==="client"?"selected":""}>Client</option></select></div>
    </div><div class="row2">
      <div class="field"><label>Téléphone</label><input name="tel" value="${esc(c.tel||"")}"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(c.email||"")}"></div>
    </div>
    <div class="field"><label>Adresse</label><input name="adresse" value="${esc(c.adresse||"")}"></div>
    <div class="field"><label>Source</label><select name="source">${sources.map(s=>`<option ${c.source===s?"selected":""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(c.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delClient('${id}')`}:null,{label:id?"Enregistrer":"Créer",cls:"btn-primary",fn:`saveClient('${id||""}')`}].filter(Boolean)
  );
}
function saveClient(id){
  if(!guard("clients"))return;
  const f=$("#f-client");const fd=new FormData(f);
  const nom=fd.get("nom")||"";if(!nom.trim()){toast("Nom obligatoire");return}
  if(id){const c=DB.clients.find(x=>x.id===id);Object.assign(c,{nom:nom.trim(),contact:fd.get("contact"),segment:fd.get("segment"),type:fd.get("type"),tel:fd.get("tel"),email:fd.get("email"),adresse:fd.get("adresse"),source:fd.get("source"),notes:fd.get("notes")});sync("clients",c);}
  else{const c={id:uid(),nom:nom.trim(),contact:fd.get("contact"),segment:fd.get("segment"),type:fd.get("type"),tel:fd.get("tel"),email:fd.get("email"),adresse:fd.get("adresse"),source:fd.get("source"),notes:fd.get("notes"),createdAt:Date.now()};DB.clients.push(c);sync("clients",c);}
  closeOverlays();toast(id?"Contact mis à jour":"Contact créé");refreshBadges();go(current);
}
function delClient(id){if(!guard("clients"))return;confirmModal("Supprimer ce contact ?","Les devis et factures liés ne seront pas supprimés.",()=>{DB.clients=DB.clients.filter(x=>x.id!==id);syncDel("clients",id);closeOverlays();toast("Contact supprimé");refreshBadges();go("clients")})}

/* ============================================================
   DEVIS & FACTURES
   ============================================================ */
function viewDevis(){docList("devis")}
function viewFactures(){docList("factures")}
function docList(kind){
  if(!vis(kind))return;
  const isF=kind==="factures";const list=DB[kind];
  $("#pg-actions").innerHTML=`<button class="btn btn-primary act-edit" onclick="editDoc('${kind}')"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>${isF?"Nouvelle facture":"Nouveau devis"}</button>`;
  if(!list.length){$("#view").innerHTML=emptyState(isF?"Aucune facture":"Aucun devis","",isF?"Nouvelle facture":"Nouveau devis",`editDoc('${kind}')`);return}
  $("#view").innerHTML=`<div style="overflow-x:auto"><table><thead><tr><th>Numéro</th><th>Client</th><th>Date</th><th>${isF?"Échéance":"Validité"}</th><th class="r">Total TTC</th><th>Statut</th><th></th></tr></thead><tbody>
    ${list.map(d=>`<tr class="clk" onclick="${isF?`openFacture`:`openDevis`}('${d.id}')">
      <td><div class="nm tabnum">${esc(d.numero)}</div></td>
      <td class="meta">${esc(clientName(d.clientId))}</td>
      <td class="meta">${fdate(d.date)}</td>
      <td class="meta">${isF?fdate(d.echeance):fdate(d.validite)}</td>
      <td class="r tabnum">${fcfa(d.montantTTC)}</td>
      <td>${pill(isF?factStatut(d):d.statut)}</td>
      <td class="r" onclick="event.stopPropagation()"><button class="btn btn-sm btn-ghost act-edit" onclick="editDoc('${kind}','${d.id}')">Modifier</button></td>
    </tr>`).join("")}
  </tbody></table></div>`;
}
function openDevis(id){
  if(!vis("devis"))return;
  const d=DB.devis.find(x=>x.id===id);if(!d)return;
  drawer(d.numero,clientName(d.clientId),docView(d,"devis"),
    [d.statut==="brouillon"?{label:"Marquer envoyé",cls:"btn",edit:1,fn:`setDevisStatut('${id}','envoyé')`}:null,
     d.statut==="envoyé"?{label:"Marquer accepté",cls:"btn",edit:1,fn:`setDevisStatut('${id}','accepté')`}:null,
     (d.statut==="accepté"||d.statut==="envoyé")?{label:"→ Facturer",cls:"btn-mag",edit:1,fn:`devisToFacture('${id}')`}:null,
     {label:"Imprimer",cls:"btn-ghost",fn:`printDoc('devis','${id}')`}
    ].filter(Boolean));
}
function openFacture(id){
  if(!vis("factures"))return;
  const f=DB.factures.find(x=>x.id===id);if(!f)return;
  const st=factStatut(f);
  drawer(f.numero,clientName(f.clientId),docView(f,"factures"),
    [st!=="payée"?{label:"Enregistrer paiement",cls:"btn-mag",edit:1,fn:`payModal('${id}')`}:null,
     {label:"Imprimer",cls:"btn-ghost",fn:`printDoc('factures','${id}')`}
    ].filter(Boolean));
}
function setDevisStatut(id,s){if(!guard("devis"))return;DB.devis.find(x=>x.id===id).statut=s;sync("devis",DB.devis.find(x=>x.id===id));closeOverlays();toast("Statut mis à jour");go("devis")}
function devisToFacture(id){
  if(!guard("factures"))return;
  const dv=DB.devis.find(x=>x.id===id);
  const seq=DB.settings.seqFacture; const year=DB.settings.year;
  const num="FAC-"+year+"-"+String(seq).padStart(4,"0");
  const f={id:uid(),numero:num,clientId:dv.clientId,devisId:dv.id,date:todayISO(),echeance:"",lignes:JSON.parse(JSON.stringify(dv.lignes)),tva:dv.tva,statut:"impayée",paiements:[],montantHT:dv.montantHT,montantTVA:dv.montantTVA,montantTTC:dv.montantTTC,notes:dv.notes,createdAt:Date.now()};
  DB.factures.push(f); DB.settings.seqFacture=seq+1;
  dv.statut="facturée"; sync("devis",dv); sync("factures",f); sync("settings",DB.settings);
  closeOverlays(); toast("Facture "+num+" créée"); refreshBadges(); go("factures"); setTimeout(()=>openFacture(f.id),200);
}
function payModal(id){
  if(!guard("factures"))return;
  const f=DB.factures.find(x=>x.id===id);const reste=f.montantTTC-factPaid(f);
  modal(`<h3>Enregistrer un paiement</h3><form id="f-pay"><div class="row2">
    <div class="field"><label>Montant (F CFA)</label><input name="montant" type="number" value="${reste}" min="1" required></div>
    <div class="field"><label>Mode</label><select name="mode"><option>Virement</option><option>Espèces</option><option>Chèque</option><option>Mobile Money</option></select></div>
    </div><div class="field"><label>Date</label><input name="date" type="date" value="${todayISO()}"></div></form>`,
    [{label:"Annuler",fn:"closeModal()"},{label:"Enregistrer",cls:"btn-primary",fn:`doPay('${id}')`}]);
}
function doPay(id){
  if(!guard("factures"))return;
  const f=DB.factures.find(x=>x.id===id);const m=$("#f-pay");const fd=new FormData(m);
  f.paiements.push({date:fd.get("date"),montant:+fd.get("montant"),mode:fd.get("mode")});
  f.statut=factStatut(f);sync("factures",f);closeModal();closeOverlays();toast("Paiement enregistré");refreshBadges();go("factures");
}
function editDoc(kind,id){
  if(!guard(kind))return;
  const isF=kind==="factures";
  const existing=id?DB[kind].find(x=>x.id===id):null;
  const doc=existing||{clientId:"",date:todayISO(),lignes:[{designation:"",qte:1,pu:0,remise:0}],tva:DB.settings.tva||18,notes:"",...(isF?{echeance:"",paiements:[],statut:"impayée"}:{validite:"",statut:"brouillon"})};
  window._editing={kind,id:id||null,doc};
  const clientOpts=DB.clients.map(c=>`<option value="${c.id}" ${doc.clientId===c.id?"selected":""}>${esc(c.nom)}</option>`).join("");
  const lignesHTML=doc.lignes.map((l,i)=>`<tr>
    <td><input style="width:100%" value="${esc(l.designation)}" onchange="updLigne(${i},'designation',this.value)"></td>
    <td><input type="number" value="${l.qte}" min="0" style="width:64px" onchange="updLigne(${i},'qte',+this.value)"></td>
    <td><input type="number" value="${l.pu}" min="0" style="width:90px" onchange="updLigne(${i},'pu',+this.value)"></td>
    <td><input type="number" value="${l.remise||0}" min="0" max="100" style="width:60px" onchange="updLigne(${i},'remise',+this.value)"></td>
    <td class="tabnum r">${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</td>
    <td><button class="btn btn-sm btn-ghost" onclick="delLigne(${i})">✕</button></td>
  </tr>`).join("");
  const totals=calcLignes(doc.lignes,doc.tva);
  drawer(id?(isF?"Facture "+existing.numero:"Devis "+existing.numero):(isF?"Nouvelle facture":"Nouveau devis"),"",
    `<form id="f-doc"><div class="row2">
      <div class="field"><label>Client</label><select name="clientId"><option value="">— Choisir —</option>${clientOpts}</select></div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${doc.date||todayISO()}"></div>
    </div><div class="row2">
      <div class="field"><label>${isF?"Échéance":"Validité"}</label><input name="${isF?"echeance":"validite"}" type="date" value="${isF?(doc.echeance||""):(doc.validite||"")}"></div>
      <div class="field"><label>TVA %</label><input name="tva" type="number" value="${doc.tva}" min="0" onchange="updTva(+this.value)"></div>
    </div>
    <div class="fieldset" style="margin-top:8px"><div class="fs-t">Lignes</div>
    <div style="overflow-x:auto"><table id="t-lignes"><thead><tr><th>Désignation</th><th>Qté</th><th>PU</th><th>Rem %</th><th>Total HT</th><th></th></tr></thead>
    <tbody id="lignes-body">${lignesHTML}</tbody></table></div>
    <button class="btn btn-sm" style="margin-top:8px" onclick="addLigne()">+ Ligne</button></div>
    <div class="kv-block" id="doc-totals" style="margin-top:12px">${docTotalsHTML(totals,doc.tva)}</div>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(doc.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delDoc('${kind}','${id}')`}:null,{label:id?"Enregistrer":(isF?"Créer la facture":"Créer le devis"),cls:"btn-primary",fn:`saveDoc()`}].filter(Boolean)
  );
}
function docTotalsHTML(t,tva){return`${kv("Montant HT",fcfa(t.montantHT))}${kv("TVA "+tva+"%",fcfa(t.montantTVA))}${kv("<strong>Total TTC</strong>","<strong class='tabnum'>"+fcfa(t.montantTTC)+"</strong>")}`}
function updLigne(i,k,v){const e=window._editing;e.doc.lignes[i][k]=v;const t=calcLignes(e.doc.lignes,e.doc.tva);$("#doc-totals").innerHTML=docTotalsHTML(t,e.doc.tva);const tds=[...document.querySelectorAll("#lignes-body tr")];if(tds[i]){const cells=[...tds[i].querySelectorAll("td")];const l=e.doc.lignes[i];if(cells[4])cells[4].textContent=fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}}
function updTva(v){const e=window._editing;e.doc.tva=v;const t=calcLignes(e.doc.lignes,v);$("#doc-totals").innerHTML=docTotalsHTML(t,v)}
function addLigne(){const e=window._editing;e.doc.lignes.push({designation:"",qte:1,pu:0,remise:0});const i=e.doc.lignes.length-1;const tr=document.createElement("tr");tr.innerHTML=`<td><input style="width:100%" onchange="updLigne(${i},'designation',this.value)"></td><td><input type="number" value="1" min="0" style="width:64px" onchange="updLigne(${i},'qte',+this.value)"></td><td><input type="number" value="0" min="0" style="width:90px" onchange="updLigne(${i},'pu',+this.value)"></td><td><input type="number" value="0" min="0" max="100" style="width:60px" onchange="updLigne(${i},'remise',+this.value)"></td><td class="tabnum r">0 F</td><td><button class="btn btn-sm btn-ghost" onclick="delLigne(${i})">✕</button></td>`;document.getElementById("lignes-body").appendChild(tr)}
function delLigne(i){const e=window._editing;e.doc.lignes.splice(i,1);editDoc(e.kind,e.id)}
function saveDoc(){
  const e=window._editing,isF=e.kind==="factures";
  if(!guard(e.kind))return;
  const f=$("#f-doc");const fd=new FormData(f);
  const totals=calcLignes(e.doc.lignes,e.doc.tva);
  if(e.id){
    const doc=DB[e.kind].find(x=>x.id===e.id);
    Object.assign(doc,{clientId:fd.get("clientId"),date:fd.get("date"),lignes:e.doc.lignes,tva:e.doc.tva,...totals,notes:fd.get("notes")});
    if(isF)doc.echeance=fd.get("echeance"); else doc.validite=fd.get("validite");
    sync(e.kind,doc);
  } else {
    const seq=isF?DB.settings.seqFacture:DB.settings.seqDevis;const year=DB.settings.year;
    const num=(isF?"FAC-":"DEV-")+year+"-"+String(seq).padStart(4,"0");
    const doc={id:uid(),numero:num,clientId:fd.get("clientId"),date:fd.get("date"),lignes:e.doc.lignes,tva:e.doc.tva,...totals,notes:fd.get("notes"),createdAt:Date.now()};
    if(isF){doc.echeance=fd.get("echeance");doc.paiements=[];doc.statut="impayée";DB.settings.seqFacture=seq+1}
    else{doc.validite=fd.get("validite");doc.statut="brouillon";DB.settings.seqDevis=seq+1}
    DB[e.kind].push(doc);sync(e.kind,doc);sync("settings",DB.settings);
  }
  closeOverlays();toast(e.id?"Enregistré":(isF?"Facture créée":"Devis créé"));refreshBadges();go(e.kind);
}
function delDoc(kind,id){if(!guard(kind))return;confirmModal("Supprimer ?"," ",()=>{DB[kind]=DB[kind].filter(x=>x.id!==id);syncDel(kind,id);closeOverlays();toast("Supprimé");refreshBadges();go(kind)})}
function docView(doc,kind){
  const isF=kind==="factures";const co=DB.settings.company||{};const tva=doc.tva||DB.settings.tva||18;
  const paid=isF?factPaid(doc):0;const st=isF?factStatut(doc):doc.statut;
  return`<div class="doc-view">${kv("Client",clientName(doc.clientId))}${kv("Date",fdate(doc.date))}${kv(isF?"Échéance":"Validité",fdate(isF?doc.echeance:doc.validite))}${kv("Statut",pill(st))}
    <div style="overflow-x:auto;margin:12px 0"><table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">PU</th><th class="r">Remise</th><th class="r">Total HT</th></tr></thead><tbody>
    ${(doc.lignes||[]).map(l=>`<tr><td>${esc(l.designation)}</td><td class="r tabnum">${l.qte}</td><td class="r tabnum">${fcfa(l.pu)}</td><td class="r">${l.remise?l.remise+"%":"—"}</td><td class="r tabnum">${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</td></tr>`).join("")}
    </tbody></table></div>
    ${kv("Montant HT",fcfa(doc.montantHT))}${kv("TVA "+tva+"%",fcfa(doc.montantTVA))}${kv("<strong>Total TTC</strong>","<strong class='tabnum'>"+fcfa(doc.montantTTC)+"</strong>")}
    ${isF&&doc.paiements.length?`<div class="fieldset" style="margin-top:12px"><div class="fs-t">Paiements</div>${doc.paiements.map(p=>`<div style="display:flex;justify-content:space-between;padding:4px 0"><span>${fdate(p.date)} — ${esc(p.mode)}</span><span class="tabnum">${fcfa(p.montant)}</span></div>`).join("")}${kv("Reste à régler",fcfa(doc.montantTTC-paid))}</div>`:""}
    ${doc.notes?`<div class="fieldset" style="margin-top:12px"><div class="fs-t">Notes</div><div>${esc(doc.notes)}</div></div>`:""}
  </div>`;
}
function printDoc(kind,id){
  const d=kind==="factures"?DB.factures.find(x=>x.id===id):DB.devis.find(x=>x.id===id);
  if(!d)return; const co=DB.settings.company||{};const isF=kind==="factures";const tva=d.tva||DB.settings.tva;
  const paid=isF?factPaid(d):0;
  const w=window.open("","_blank");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${d.numero}</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:30px;color:#1a1a1c}table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border:1px solid #ddd}th{background:#f5f5f5}.r{text-align:right}.h{font-size:9px;color:#666;margin-bottom:4px}.tot{font-weight:bold;font-size:13px}</style></head><body>
    <div class="h">${esc(co.name||"")} · ${esc(co.siege||"")} · Tél: ${esc(co.tel||"")} · RC: ${esc(co.rc||"")} · CC: ${esc(co.cc||"")}</div>
    <h2>${isF?"FACTURE":"DEVIS"} ${esc(d.numero)}</h2>
    <p><strong>Client :</strong> ${esc(clientName(d.clientId))}<br><strong>Date :</strong> ${fdate(d.date)}<br><strong>${isF?"Échéance":"Validité"} :</strong> ${fdate(isF?d.echeance:d.validite)}</p>
    <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">PU (F)</th><th class="r">Remise</th><th class="r">Total HT (F)</th></tr></thead><tbody>
    ${(d.lignes||[]).map(l=>`<tr><td>${esc(l.designation)}</td><td class="r">${l.qte}</td><td class="r">${fcfa(l.pu)}</td><td class="r">${l.remise?l.remise+"%":"—"}</td><td class="r">${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</td></tr>`).join("")}
    </tbody></table>
    <p class="r">Montant HT : ${fcfa(d.montantHT)}<br>TVA ${tva}% : ${fcfa(d.montantTVA)}<br><span class="tot">Total TTC : ${fcfa(d.montantTTC)}</span>${isF&&paid?`<br>Payé : ${fcfa(paid)}<br>Reste : ${fcfa(d.montantTTC-paid)}`:""}
    </p>${d.notes?`<p><em>Notes : ${esc(d.notes)}</em></p>`:""}
    <hr><div class="h">${esc(co.mentions||co.name||"")} — Banque : ${esc(co.banque||"")} — Régime : ${esc(co.regime||"")} — Centre : ${esc(co.centre||"")}</div>
    <script>window.print();window.onafterprint=()=>window.close()<\/script></body></html>`);
  w.document.close();
}

/* ============================================================
   COMMANDES & PROJETS (Kanban)
   ============================================================ */
const CMD_FLOW=[["devis","Devis"],["production","Production"],["controle","Contrôle Q."],["livré","Livré"],["facturé","Facturé"]];
function viewCommandes(){
  if(!vis("commandes"))return;
  $("#pg-actions").innerHTML=`<button class="btn btn-primary act-edit" onclick="editCmd()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouvelle commande</button>`;
  if(!DB.commandes.length){$("#view").innerHTML=emptyState("Aucune commande","Créez votre première commande.","Nouvelle commande","editCmd()");return}
  const cols=CMD_FLOW.map(([k,l])=>({k,l,items:DB.commandes.filter(c=>c.statut===k)}));
  $("#view").innerHTML=`<div class="kanban">${cols.map(col=>`
    <div class="kol"><div class="kol-h">${col.l} <span class="badge" style="background:rgba(255,255,255,.15)">${col.items.length}</span></div>
    ${col.items.map(c=>{const late=c.deadline&&new Date(c.deadline)<new Date()&&c.statut!=="livré"&&c.statut!=="facturé";return`<div class="kard ${late?"late":""}" onclick="openCmd('${c.id}')">
      <div class="kard-t">${esc(c.titre)}</div>
      <div class="kard-m"><span>${esc(clientName(c.clientId))}</span>${c.deadline?`<span class="${late?"text-danger":""}">${fdate(c.deadline)}</span>`:""}</div>
    </div>`}).join("")}
    </div>`).join("")}</div>`;
}
function openCmd(id){
  if(!vis("commandes"))return;
  const c=DB.commandes.find(x=>x.id===id);if(!c)return;
  const late=c.deadline&&new Date(c.deadline)<new Date()&&c.statut!=="livré"&&c.statut!=="facturé";
  drawer(c.numero,c.titre,
    kv("Client",clientName(c.clientId))+kv("Statut",pill(c.statut))+kv("Deadline",fdate(c.deadline))+(late?"<div class='pill p-red' style='margin-top:8px'><span class='dot'></span>En retard</div>":"")+
    kv("Devis lié",c.devisId?DB.devis.find(x=>x.id===c.devisId)?.numero:"—")+kv("Notes",c.notes||"")+
    `<div class="fieldset act-edit" style="margin-top:16px"><div class="fs-t">Changer le statut</div>
      <div class="filters" style="margin:0">${CMD_FLOW.map(([k,l])=>`<button class="filter-btn ${c.statut===k?"active":""}" onclick="setCmd('${id}','${k}')">${l}</button>`).join("")}</div></div>`,
    [{label:"Modifier",cls:"btn-primary",edit:1,fn:`closeOverlays();editCmd('${id}')`}]
  );
}
function setCmd(id,s){if(!guard("commandes"))return;const c=DB.commandes.find(x=>x.id===id);c.statut=s;sync("commandes",c);closeOverlays();toast("Statut mis à jour");go("commandes")}
function editCmd(id){
  if(!guard("commandes"))return;
  const c=id?DB.commandes.find(x=>x.id===id):{titre:"",clientId:"",statut:"devis",deadline:"",notes:""};
  const clientOpts=DB.clients.map(cl=>`<option value="${cl.id}" ${c.clientId===cl.id?"selected":""}>${esc(cl.nom)}</option>`).join("");
  const devisOpts=DB.devis.map(d=>`<option value="${d.id}" ${c.devisId===d.id?"selected":""}>${esc(d.numero)} — ${esc(clientName(d.clientId))}</option>`).join("");
  drawer(id?"Modifier la commande":"Nouvelle commande","",
    `<form id="f-cmd"><div class="field"><label>Titre du projet *</label><input name="titre" value="${esc(c.titre)}" required></div>
    <div class="row2">
      <div class="field"><label>Client</label><select name="clientId"><option value="">— Choisir —</option>${clientOpts}</select></div>
      <div class="field"><label>Deadline</label><input name="deadline" type="date" value="${c.deadline||""}"></div>
    </div>
    <div class="field"><label>Devis associé (optionnel)</label><select name="devisId"><option value="">— Aucun —</option>${devisOpts}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(c.notes||"")}</textarea></div></form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delCmd('${id}')`}:null,{label:id?"Enregistrer":"Créer",cls:"btn-primary",fn:`saveCmd('${id||""}')`}].filter(Boolean)
  );
}
function saveCmd(id){
  if(!guard("commandes"))return;
  const f=$("#f-cmd");const fd=new FormData(f);
  const titre=fd.get("titre")||"";if(!titre.trim()){toast("Titre obligatoire");return}
  if(id){const c=DB.commandes.find(x=>x.id===id);Object.assign(c,{titre:titre.trim(),clientId:fd.get("clientId"),deadline:fd.get("deadline"),devisId:fd.get("devisId")||null,notes:fd.get("notes")});sync("commandes",c);}
  else{const seq=DB.settings.seqCommande;const year=DB.settings.year;const num="CMD-"+year+"-"+String(seq).padStart(4,"0");const c={id:uid(),numero:num,titre:titre.trim(),clientId:fd.get("clientId"),statut:"devis",deadline:fd.get("deadline"),devisId:fd.get("devisId")||null,factureId:null,notes:fd.get("notes"),createdAt:Date.now()};DB.commandes.push(c);DB.settings.seqCommande=seq+1;sync("commandes",c);sync("settings",DB.settings);}
  closeOverlays();toast(id?"Commande mise à jour":"Commande créée");refreshBadges();go(current);
}
function delCmd(id){if(!guard("commandes"))return;confirmModal("Supprimer cette commande ?","",()=>{DB.commandes=DB.commandes.filter(x=>x.id!==id);syncDel("commandes",id);closeOverlays();toast("Commande supprimée");refreshBadges();go("commandes")})}

/* ============================================================
   COMPTABILITÉ & TVA
   ============================================================ */
function viewCompta(){
  if(!vis("compta"))return;
  $("#pg-actions").innerHTML=`<button class="btn btn-primary act-edit" onclick="editDepense()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouvelle dépense</button>`;
  const now=new Date(),m=now.getMonth(),y=now.getFullYear();
  let tvaColl=0,tvaDed=0,recettes=0,depTTC=0,depHT=0;
  DB.factures.forEach(f=>{const paid=factPaid(f);if(paid>0&&f.montantTTC){tvaColl+=f.montantTVA*(paid/f.montantTTC);recettes+=paid}});
  DB.depenses.forEach(d=>{tvaDed+=d.tva||0;depTTC+=d.ttc||0;depHT+=d.ht||0});
  const tvaReverse=tvaColl-tvaDed;const resultat=recettes-depTTC;
  const modes={};
  DB.factures.forEach(f=>(f.paiements||[]).forEach(p=>{modes[p.mode]=(modes[p.mode]||0)+(+p.montant||0)}));
  const cats={};DB.depenses.forEach(d=>{cats[d.categorie||"Autre"]=(cats[d.categorie||"Autre"]||0)+(+d.ttc||0)});
  $("#view").innerHTML=`<div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><div class="lab">Recettes encaissées</div><div class="val tabnum">${fcfa(recettes)}</div></div>
    <div class="card kpi c-mag"><div class="lab">Dépenses TTC</div><div class="val tabnum">${fcfa(depTTC)}</div></div>
    <div class="card kpi ${tvaReverse>=0?"c-jaune":"c-noir"}"><div class="lab">TVA à reverser</div><div class="val tabnum">${fcfa(tvaReverse)}</div><div class="delta">Collectée ${fcfa(Math.round(tvaColl))} − Déductible ${fcfa(Math.round(tvaDed))}</div></div>
    <div class="card kpi ${resultat>=0?"c-cyan":"c-mag"}"><div class="lab">Résultat (recettes − dép.)</div><div class="val tabnum">${fcfa(resultat)}</div></div>
  </div>
  <div class="two" style="margin-bottom:16px">
    <div class="card panel"><div class="panel-h"><h3>Recettes par mode</h3></div>${Object.entries(modes).map(([k,v])=>kv(k,fcfa(v))).join("")||"<div class='muted'>Aucun paiement enregistré.</div>"}</div>
    <div class="card panel"><div class="panel-h"><h3>Dépenses par catégorie</h3></div>${Object.entries(cats).map(([k,v])=>kv(k,fcfa(v))).join("")||"<div class='muted'>Aucune dépense.</div>"}</div>
  </div>
  <div class="card panel"><div class="panel-h"><h3>Journal des dépenses</h3></div>
    ${!DB.depenses.length?"<div class='muted'>Aucune dépense enregistrée.</div>":`<div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Libellé</th><th>Catégorie</th><th>Fournisseur</th><th class="r">HT</th><th class="r">TVA</th><th class="r">TTC</th><th></th></tr></thead><tbody>
    ${DB.depenses.map(d=>`<tr><td class="meta">${fdate(d.date)}</td><td class="nm">${esc(d.libelle)}</td><td><span class="seg">${esc(d.categorie||"—")}</span></td><td class="meta">${esc(d.fournisseur||"—")}</td><td class="r tabnum">${fcfa(d.ht)}</td><td class="r tabnum">${fcfa(d.tva)}</td><td class="r tabnum">${fcfa(d.ttc)}</td>
    <td class="r"><button class="btn btn-sm btn-ghost act-edit" onclick="editDepense('${d.id}')">Modifier</button></td></tr>`).join("")}</tbody></table></div>`}
  </div>`;
}
function editDepense(id){
  if(!guard("compta"))return;
  const d=id?DB.depenses.find(x=>x.id===id):{date:todayISO(),libelle:"",categorie:"",fournisseur:"",ht:0,tva:0,ttc:0};
  const cats=["Achats matières","Charges fixes","Services externes","Frais de déplacement","Marketing","Autre"];
  drawer(id?"Modifier la dépense":"Nouvelle dépense","",
    `<form id="f-dep"><div class="row2">
      <div class="field"><label>Libellé *</label><input name="libelle" value="${esc(d.libelle)}" required></div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${d.date||todayISO()}"></div>
    </div><div class="row2">
      <div class="field"><label>Catégorie</label><select name="categorie">${cats.map(c=>`<option ${d.categorie===c?"selected":""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Fournisseur</label><input name="fournisseur" value="${esc(d.fournisseur||"")}"></div>
    </div><div class="row2">
      <div class="field"><label>Montant HT (F)</label><input name="ht" type="number" value="${d.ht||0}" min="0" onchange="autoTTC()"></div>
      <div class="field"><label>TVA (F)</label><input name="tva" type="number" value="${d.tva||0}" min="0" onchange="autoTTC()"></div>
    </div><div class="field"><label>Total TTC (F)</label><input name="ttc" id="dep-ttc" type="number" value="${d.ttc||0}" min="0"></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delDepense('${id}')`}:null,{label:id?"Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveDepense('${id||""}')`}].filter(Boolean)
  );
}
function autoTTC(){const ht=+($("[name=ht]")||{}).value||0;const tv=+($("[name=tva]")||{}).value||0;const el=$("#dep-ttc");if(el)el.value=ht+tv}
function saveDepense(id){
  if(!guard("compta"))return;
  const f=$("#f-dep");const fd=new FormData(f);
  if(!fd.get("libelle").trim()){toast("Libellé obligatoire");return}
  const dep={id:id||uid(),date:fd.get("date"),libelle:fd.get("libelle"),categorie:fd.get("categorie"),fournisseur:fd.get("fournisseur"),ht:+fd.get("ht")||0,tva:+fd.get("tva")||0,ttc:+fd.get("ttc")||0,createdAt:id?(DB.depenses.find(x=>x.id===id)||{}).createdAt||Date.now():Date.now()};
  if(id)DB.depenses=DB.depenses.map(x=>x.id===id?dep:x); else DB.depenses.push(dep);
  sync("depenses",dep);closeOverlays();toast(id?"Dépense mise à jour":"Dépense ajoutée");go(current);
}
function delDepense(id){if(!guard("compta"))return;confirmModal("Supprimer cette dépense ?","",()=>{DB.depenses=DB.depenses.filter(x=>x.id!==id);syncDel("depenses",id);closeOverlays();toast("Dépense supprimée");go("compta")})}

/* ============================================================
   CATALOGUE
   ============================================================ */
function viewCatalogue(){
  if(!vis("catalogue"))return;
  $("#pg-actions").innerHTML=`<button class="btn btn-primary act-edit" onclick="editProduct()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau produit</button>`;
  if(!DB.products.length){$("#view").innerHTML=emptyState("Catalogue vide","Ajoutez vos produits et tarifs.","Nouveau produit","editProduct()");return}
  const cats=[...new Set(DB.products.map(p=>p.categorie||"Autre"))].sort();
  $("#view").innerHTML=cats.map(cat=>{const prods=DB.products.filter(p=>(p.categorie||"Autre")===cat);return`<div class="card" style="margin-bottom:16px"><div class="panel-h" style="padding:14px 16px 10px"><h3 style="font-size:13px;color:var(--txt-2)">${esc(cat)}</h3></div><div style="overflow-x:auto"><table><thead><tr><th>Désignation</th><th class="r">Prix unitaire</th><th>Unité</th><th></th></tr></thead><tbody>${prods.map(p=>`<tr><td class="nm">${esc(p.designation)}</td><td class="r tabnum">${fcfa(p.pu)}</td><td class="meta">${esc(p.unite)}</td><td class="r"><button class="btn btn-sm btn-ghost act-edit" onclick="editProduct('${p.id}')">Modifier</button></td></tr>`).join("")}</tbody></table></div></div>`}).join("");
}
function editProduct(id){
  if(!guard("catalogue"))return;
  const p=id?DB.products.find(x=>x.id===id):{designation:"",categorie:"",pu:0,unite:"unité"};
  const cats=["Impression","Grand format","Gadgets","Fournitures","Création","Autre"];
  drawer(id?"Modifier le produit":"Nouveau produit","",
    `<form id="f-prod"><div class="field"><label>Désignation *</label><input name="designation" value="${esc(p.designation)}" required></div>
    <div class="row2">
      <div class="field"><label>Catégorie</label><select name="categorie">${cats.map(c=>`<option ${p.categorie===c?"selected":""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Unité</label><input name="unite" value="${esc(p.unite||"unité")}"></div>
    </div>
    <div class="field"><label>Prix unitaire (F CFA)</label><input name="pu" type="number" value="${p.pu||0}" min="0"></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delProduct('${id}')`}:null,{label:id?"Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveProduct('${id||""}')`}].filter(Boolean)
  );
}
function saveProduct(id){
  if(!guard("catalogue"))return;
  const f=$("#f-prod");const fd=new FormData(f);
  if(!fd.get("designation").trim()){toast("Désignation obligatoire");return}
  const p={id:id||uid(),designation:fd.get("designation"),categorie:fd.get("categorie"),pu:+fd.get("pu")||0,unite:fd.get("unite")||"unité",createdAt:id?(DB.products.find(x=>x.id===id)||{}).createdAt||Date.now():Date.now()};
  if(id)DB.products=DB.products.map(x=>x.id===id?p:x); else DB.products.push(p);
  sync("products",p);closeOverlays();toast(id?"Produit mis à jour":"Produit ajouté");go(current);
}
function delProduct(id){if(!guard("catalogue"))return;confirmModal("Supprimer ce produit ?","",()=>{DB.products=DB.products.filter(x=>x.id!==id);syncDel("products",id);closeOverlays();toast("Produit supprimé");go("catalogue")})}

/* ============================================================
   PARAMÈTRES
   ============================================================ */
function viewParametres(){
  if(!vis("parametres"))return;
  const c=DB.settings.company||{}; const s=DB.settings;
  const fi=(k,v,t="text")=>`<input name="${k}" value="${esc(v||"")}" type="${t}">`;
  $("#view").innerHTML=`<div class="card panel"><div class="panel-h"><h3>Identité de la société</h3></div>
    <form id="f-set">
    <div class="row2"><div class="field"><label>Nom de la société</label>${fi("name",c.name)}</div><div class="field"><label>Activité</label>${fi("activite",c.activite)}</div></div>
    <div class="row2"><div class="field"><label>Forme juridique</label>${fi("forme",c.forme)}</div><div class="field"><label>Capital</label>${fi("capital",c.capital)}</div></div>
    <div class="field"><label>Adresse siège</label>${fi("siege",c.siege)}</div>
    <div class="row2"><div class="field"><label>Téléphone fixe</label>${fi("tel",c.tel)}</div><div class="field"><label>Téléphone mobile</label>${fi("cel",c.cel)}</div></div>
    <div class="row2"><div class="field"><label>Email</label>${fi("email",c.email)}</div><div class="field"><label>Site web</label>${fi("site",c.site)}</div></div>
    <div class="row2"><div class="field"><label>RC N°</label>${fi("rc",c.rc)}</div><div class="field"><label>CC N°</label>${fi("cc",c.cc)}</div></div>
    <div class="field"><label>Banque & N° de compte</label>${fi("banque",c.banque)}</div>
    <div class="row2"><div class="field"><label>Régime d'imposition</label>${fi("regime",c.regime)}</div><div class="field"><label>Centre des impôts</label>${fi("centre",c.centre)}</div></div>
    </form></div>
  <div class="card panel" style="margin-top:16px"><div class="panel-h"><h3>Paramètres de facturation</h3></div>
    <form id="f-set2"><div class="row2">
      <div class="field"><label>TVA par défaut (%)</label><input name="tva" type="number" value="${s.tva||18}" min="0" max="100"></div>
      <div class="field"><label>Devise</label><input name="devise" value="${esc(s.devise||"F CFA")}"></div>
    </div></form>
  </div>
  <div class="card panel" style="margin-top:16px"><div class="panel-h"><h3>Sauvegarde</h3></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" onclick="exportData()"><svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Exporter (.json)</button>
      <label class="btn" style="cursor:pointer"><svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 21V9M7 14l5-5 5 5M5 3h14"/></svg>Importer<input type="file" accept=".json" style="display:none" onchange="importData(this)"></label>
    </div>
  </div>
  <div class="card panel" style="margin-top:16px"><div class="panel-h"><h3>Actions</h3></div>
    <button class="btn btn-primary act-edit" onclick="saveSettings()">Enregistrer les paramètres</button>
  </div>`;
}
function saveSettings(){
  if(!guard("parametres"))return;
  const f=$("#f-set"),f2=$("#f-set2"); if(!f||!f2)return;
  const fd=new FormData(f),fd2=new FormData(f2);
  const c=DB.settings.company||{};
  ["name","activite","forme","capital","siege","tel","cel","email","site","rc","cc","banque","regime","centre"].forEach(k=>{c[k]=fd.get(k)||""});
  DB.settings.tva=+fd2.get("tva")||18;
  DB.settings.devise=fd2.get("devise")||"F CFA";
  sync("settings",DB.settings);
  toast("Paramètres enregistrés");
}
function exportData(){
  const blob=new Blob([JSON.stringify({settings:DB.settings,roles:DB.roles,users:DB.users,clients:DB.clients,products:DB.products,devis:DB.devis,factures:DB.factures,commandes:DB.commandes,depenses:DB.depenses},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="creatis-crm-backup-"+todayISO()+".json";a.click();toast("Sauvegarde exportée");
}
function importData(input){
  const file=input.files[0];if(!file)return;
  const r=new FileReader();r.onload=()=>{try{const o=JSON.parse(r.result);if(!o.settings||!o.clients)throw 0;
    confirmModal("Importer et écraser toutes les données ?","Les données actuelles seront remplacées.",async ()=>{
      Object.assign(DB,o);closeModal();toast("Import en cours…");
      // Sync everything to Supabase
      await Promise.all([
        dbUpsertSettings(DB.settings),
        ...DB.clients.map(x=>dbUpsert("clients",x)),
        ...DB.products.map(x=>dbUpsert("products",x)),
        ...DB.devis.map(x=>dbUpsert("devis",x)),
        ...DB.factures.map(x=>dbUpsert("factures",x)),
        ...DB.commandes.map(x=>dbUpsert("commandes",x)),
        ...DB.depenses.map(x=>dbUpsert("depenses",x)),
      ]);
      toast("Données importées et synchronisées");refreshBadges();go("dashboard");
    });
  }catch(e){toast("Fichier invalide")}};r.readAsText(file);
}

/* ============================================================
   UTILISATEURS & RÔLES
   ============================================================ */
function viewUsers(){
  if(!isAdmin()){$("#view").innerHTML=`<div class="card panel"><div class="empty"><h4>Accès réservé</h4><div>Cette section est réservée aux administrateurs.</div></div></div>`;return}
  $("#pg-actions").innerHTML=usersTab==="comptes"
    ?`<button class="btn btn-primary" onclick="editUser()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau compte</button>`
    :`<button class="btn btn-primary" onclick="editRole()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau rôle</button>`;
  $("#view").innerHTML=`<div class="tabs">
    <button class="${usersTab==="comptes"?"active":""}" onclick="usersTab='comptes';viewUsers()">Comptes</button>
    <button class="${usersTab==="roles"?"active":""}" onclick="usersTab='roles';viewUsers()">Rôles & droits</button>
  </div><div id="users-body"></div>`;
  $("#users-body").innerHTML=usersTab==="comptes"?usersTable():rolesTable();
}
function usersTable(){
  if(!DB.users.length)return emptyState("Aucun compte","Créez les comptes de votre équipe.","Nouveau compte","editUser()");
  return`<div class="card"><div style="overflow-x:auto"><table><thead><tr><th>Utilisateur</th><th>Identifiant</th><th>Rôle</th><th>Statut</th><th></th></tr></thead><tbody>${DB.users.map(u=>{const r=roleOf(u);return`<tr><td><div class="nm">${esc(u.name)}</div>${u.id===USER.id?'<div class="meta">vous</div>':''}</td><td class="meta tabnum">${esc(u.login)}</td><td><span class="rdot cc-${(r&&r.color)||"noir"}"></span>${esc(r?r.name:"—")}</td><td>${u.active===false?'<span class="pill p-grey"><span class="dot"></span>Inactif</span>':'<span class="pill p-green"><span class="dot"></span>Actif</span>'}</td><td class="r"><button class="btn btn-sm btn-ghost" onclick="editUser('${u.id}')">Modifier</button></td></tr>`}).join("")}</tbody></table></div></div>`;
}
function rolesTable(){
  return`<div class="card"><div style="overflow-x:auto"><table><thead><tr><th>Rôle</th><th>Accès</th><th>Comptes</th><th></th></tr></thead><tbody>${DB.roles.map(r=>{const n=DB.users.filter(u=>(u.roleId||u.role_id)===r.id).length;const mods=MODS.filter(m=>r.perms[m.k]&&r.perms[m.k]!=="none").length;return`<tr><td><span class="rdot cc-${r.color||"noir"}"></span><span class="nm">${esc(r.name)}</span>${r.system?' <span class="seg">système</span>':''}</td><td class="meta">${mods} module(s)</td><td class="tabnum">${n}</td><td class="r"><button class="btn btn-sm btn-ghost" onclick="editRole('${r.id}')">Configurer</button></td></tr>`}).join("")}</tbody></table></div></div>`;
}
function editUser(id){
  const u=id?DB.users.find(x=>x.id===id):{active:true,roleId:(DB.roles[0]||{}).id,name:"",login:""};
  drawer(id?"Modifier le compte":"Nouveau compte","Utilisateur",`<form id="f-user">
    <div class="field"><label>Nom complet *</label><input name="name" value="${esc(u.name)}" required></div>
    <div class="row2"><div class="field"><label>Identifiant *</label><input name="login" value="${esc(u.login)}" required></div>
    <div class="field"><label>Rôle</label><select name="roleId">${DB.roles.map(r=>`<option value="${r.id}" ${(u.roleId||u.role_id)===r.id?"selected":""}>${esc(r.name)}</option>`).join("")}</select></div></div>
    <div class="field"><label>${id?"Nouveau mot de passe (vide = inchangé)":"Mot de passe *"}</label><input name="pwd" type="password"></div>
    <div class="field"><label>Statut</label><select name="active"><option value="1" ${u.active!==false?"selected":""}>Actif</option><option value="0" ${u.active===false?"selected":""}>Inactif</option></select></div>
  </form>`,
  [(id&&u.id!==USER.id)?{label:"Supprimer",cls:"btn-danger",fn:`delUser('${id}')`}:null,{label:id?"Enregistrer":"Créer le compte",cls:"btn-primary",fn:`saveUser('${id||""}')`}].filter(Boolean));
}
function adminCount(){return DB.users.filter(u=>(u.roleId||u.role_id)==="administrateur"&&u.active!==false).length}
async function saveUser(id){
  const f=$("#f-user");const fd=new FormData(f);
  const name=fd.get("name")?.trim()||"";const login=fd.get("login")?.trim()||"";
  if(!name||!login){toast("Nom et identifiant obligatoires");return}
  if(DB.users.some(x=>x.id!==id&&(x.login||"").toLowerCase()===login.toLowerCase())){toast("Cet identifiant existe déjà");return}
  const active=fd.get("active")==="1";const pw=fd.get("pwd")||"";
  if(id){
    const u=DB.users.find(x=>x.id===id);
    if((u.roleId||u.role_id)==="administrateur"&&(fd.get("roleId")!=="administrateur"||!active)&&adminCount()<=1){toast("Au moins un administrateur actif requis");return}
    u.name=name;u.login=login;u.roleId=fd.get("roleId");u.role_id=fd.get("roleId");u.active=active;
    if(pw)u.pass=await passHash(login,pw);
    if(u.id===USER.id){USER=u;refreshUserChip();applyNav()}
    sync("users",u);
  } else {
    if(!pw){toast("Mot de passe obligatoire");return}
    const u={id:uid(),name,login,roleId:fd.get("roleId"),role_id:fd.get("roleId"),active,pass:await passHash(login,pw),createdAt:Date.now()};
    DB.users.push(u);sync("users",u);
  }
  closeOverlays();toast(id?"Compte mis à jour":"Compte créé");go("users");
}
function delUser(id){
  if(id===USER.id){toast("Vous ne pouvez pas supprimer votre propre compte");return}
  const u=DB.users.find(x=>x.id===id);if((u.roleId||u.role_id)==="administrateur"&&adminCount()<=1){toast("Au moins un administrateur requis");return}
  confirmModal("Supprimer ce compte ?","",()=>{DB.users=DB.users.filter(x=>x.id!==id);syncDel("users",id);closeOverlays();toast("Compte supprimé");go("users")});
}
function editRole(id){
  const r=id?DB.roles.find(x=>x.id===id):{name:"",color:"cyan",perms:Object.fromEntries(MODS.map(m=>[m.k,"none"])),widgets:["kpi_encaisse"]};
  const sysAdmin=!!(r.system&&r.id==="administrateur");
  const colors={cyan:"Cyan",mag:"Magenta",jaune:"Jaune",noir:"Noir"};
  drawer(id?"Rôle · "+r.name:"Nouveau rôle","Droits d'accès",`<form id="f-role">
    <div class="row2"><div class="field"><label>Nom du rôle *</label><input name="name" value="${esc(r.name)}" required></div>
    <div class="field"><label>Couleur</label><select name="color">${Object.keys(colors).map(c=>`<option value="${c}" ${r.color===c?"selected":""}>${colors[c]}</option>`).join("")}</select></div></div>
    <div class="fieldset"><div class="fs-t">Droits par module</div>
      ${sysAdmin?'<p class="muted">L\'administrateur dispose de tous les droits (non modifiable).</p>':''}
      <table class="perms"><thead><tr><th>Module</th><th class="c">Aucun</th><th class="c">Lecture</th><th class="c">Édition</th></tr></thead>
      <tbody>${MODS.map(m=>{const lvl=r.perms[m.k]||"none";return`<tr><td>${m.label}</td>${["none","view","edit"].map(L=>`<td class="c"><input type="radio" name="perm_${m.k}" value="${L}" ${lvl===L?"checked":""} ${sysAdmin?"disabled":""}></td>`).join("")}</tr>`}).join("")}</tbody></table>
    </div>
    <div class="fieldset"><div class="fs-t">Indicateurs du tableau de bord</div>
      <div class="wgrid">${WIDGETS.map(w=>`<label class="wopt"><input type="checkbox" name="w_${w.k}" ${(r.widgets||[]).includes(w.k)?"checked":""}> ${w.label}</label>`).join("")}</div>
    </div>
  </form>`,
  [(id&&!r.system)?{label:"Supprimer",cls:"btn-danger",fn:`delRole('${id}')`}:null,{label:id?"Enregistrer":"Créer",cls:"btn-primary",fn:`saveRole('${id||""}')`}].filter(Boolean));
}
function saveRole(id){
  const f=$("#f-role");const fd=new FormData(f);const name=fd.get("name")?.trim()||"";if(!name){toast("Nom obligatoire");return}
  const existing=id?DB.roles.find(x=>x.id===id):null;
  const sysAdmin=!!(existing&&existing.system&&existing.id==="administrateur");
  const perms={};MODS.forEach(m=>{const sel=f.querySelector('input[name="perm_'+m.k+'"]:checked');perms[m.k]=sel?sel.value:"none"});
  if(sysAdmin)MODS.forEach(m=>perms[m.k]="edit");
  const widgets=WIDGETS.filter(w=>{const el=f.querySelector('input[name="w_'+w.k+'"]');return el&&el.checked}).map(w=>w.k);
  const color=fd.get("color")||"noir";
  if(id){Object.assign(existing,{name,color,perms,widgets});sync("roles",existing)}
  else{const rid=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"role";const r={id:rid+"-"+Math.random().toString(36).slice(2,5),name,color,perms,widgets,system:false};DB.roles.push(r);sync("roles",r)}
  closeOverlays();toast(id?"Rôle mis à jour":"Rôle créé");
  if(USER&&id===(USER.roleId||USER.role_id)){applyNav();refreshUserChip()}
  go("users");
}
function delRole(id){
  const r=DB.roles.find(x=>x.id===id);if(r.system){toast("Rôle système non supprimable");return}
  const n=DB.users.filter(u=>(u.roleId||u.role_id)===id).length;if(n){toast("Réaffectez d'abord les "+n+" compte(s)");return}
  confirmModal("Supprimer ce rôle ?","",()=>{DB.roles=DB.roles.filter(x=>x.id!==id);syncDel("roles",id);closeOverlays();toast("Rôle supprimé");go("users")});
}

/* ============================================================
   UI PRIMITIVES
   ============================================================ */
function drawer(title,sub,body,actions){
  const d=$("#drawer");
  d.innerHTML=`<div class="drawer-h"><div style="flex:1"><h3>${esc(title)}</h3>${sub?`<div class="sub">${esc(sub)}</div>`:""}</div>
    <button class="btn btn-ghost no-print" onclick="closeOverlays()"><svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="drawer-b">${body}</div>
    ${actions&&actions.length?`<div class="drawer-f">${actions.map(a=>`<button class="btn ${a.cls||""} ${a.edit?"act-edit":""}" onclick="${a.fn}">${esc(a.label)}</button>`).join("")}</div>`:""}`;
  $("#scrim").classList.add("show");d.classList.add("show");
}
function modal(body,actions){const m=$("#modal");m.innerHTML=`<div class="modal-b">${body}<div class="modal-f">${(actions||[]).map(a=>`<button class="btn ${a.cls||""}" onclick="${a.fn}">${esc(a.label)}</button>`).join("")}</div></div>`;$("#scrim").classList.add("show");m.classList.add("show")}
function confirmModal(title,text,onYes){window._confirmCb=onYes;modal(`<h3>${esc(title)}</h3>${text?`<p>${esc(text)}</p>`:"<p></p>"}`,[{label:"Annuler",fn:"closeModal()"},{label:"Confirmer",cls:"btn-danger",fn:"runConfirm()"}])}
function runConfirm(){const cb=window._confirmCb;closeModal();cb&&cb()}
function closeModal(){$("#modal").classList.remove("show");if(!$("#drawer").classList.contains("show"))$("#scrim").classList.remove("show")}
function closeOverlays(){$("#drawer").classList.remove("show");$("#modal").classList.remove("show");$("#scrim").classList.remove("show")}
function kv(k,v){return`<div style="display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid var(--ligne-2)"><span class="muted">${k}</span><span class="strong" style="text-align:right">${v==null||v===""?"—":v}</span></div>`}
function emptyState(title,text,btn,fn){return`<div class="empty"><svg class="em-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><h4>${esc(title)}</h4><div>${esc(text)}</div>${btn?`<button class="btn btn-primary" onclick="${fn}">${esc(btn)}</button>`:""}</div>`}

/* ============================================================
   RECHERCHE GLOBALE
   ============================================================ */
document.getElementById("globalSearch").addEventListener("input",e=>{
  const q=e.target.value.toLowerCase().trim();
  if(current==="clients"){clientSearch=q;viewClients()}
});

/* ============================================================
   NAV CLICK
   ============================================================ */
document.querySelectorAll("#nav a").forEach(a=>a.addEventListener("click",()=>go(a.dataset.route)));

/* ============================================================
   CSS RBAC + AUTH (injecté ici pour éviter un fichier supplémentaire)
   ============================================================ */
(function(){
  const style=document.createElement("style");
  style.textContent=`
body.ro .act-edit{display:none!important}
.uchip{display:flex;align-items:center;gap:10px;background:var(--carte);border:1px solid var(--ligne);border-radius:30px;padding:5px 8px 5px 6px}
.uava{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;font-family:var(--disp);flex:0 0 auto}
.uinfo{line-height:1.15}.uinfo .un{font-weight:600;font-size:13px}.uinfo .ur{font-size:11px;color:var(--txt-2)}
.cc-cyan{background:var(--cyan)}.cc-mag{background:var(--magenta)}.cc-jaune{background:var(--jaune);color:#1A1A1C}.cc-noir{background:var(--noir)}
.rdot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle;background:#9aa0a8}
table.perms td,table.perms th{padding:8px 6px}
table.perms input[type=radio]{width:auto;margin:0}
.wgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.wopt{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}.wopt input{width:auto}
body.auth-on{overflow:hidden}
#auth{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;padding:20px}
#auth.show{display:flex}
.auth-bg{position:absolute;inset:0;background:linear-gradient(135deg,#1A1A1C,#26262A)}
.auth-bg::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 18% 22%,rgba(0,174,239,.20),transparent 42%),radial-gradient(circle at 82% 28%,rgba(236,0,140,.18),transparent 42%),radial-gradient(circle at 60% 92%,rgba(255,196,0,.16),transparent 42%)}
.auth-card{position:relative;width:min(420px,94vw);background:var(--carte);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow-lg)}
.auth-cmyk{height:6px;display:flex}.auth-cmyk i{flex:1}.auth-cmyk i:nth-child(1){background:var(--cyan)}.auth-cmyk i:nth-child(2){background:var(--magenta)}.auth-cmyk i:nth-child(3){background:var(--jaune)}.auth-cmyk i:nth-child(4){background:#000}
.auth-body{padding:30px 30px 32px}
.auth-brand{display:flex;align-items:center;gap:11px;margin-bottom:22px}
.auth-brand .ab-n{font-family:var(--disp);font-weight:700;font-size:16px;letter-spacing:.02em}
.auth-brand .ab-s{font-size:9.5px;letter-spacing:.42em;color:var(--txt-3);font-weight:600;margin-top:2px}
.auth-body h3{font-family:var(--disp);font-size:21px;font-weight:700;margin-bottom:4px}
.auth-body p{margin-bottom:18px}
.auth-err{color:var(--danger);font-size:12.5px;min-height:16px;margin-bottom:8px;font-weight:500}
@media(max-width:760px){#userchip.hide-sm{display:flex}.uinfo{display:none}}
.tabs{display:flex;gap:4px;margin-bottom:16px}
.tabs button{padding:7px 16px;border-radius:var(--r);background:var(--carte);border:1px solid var(--ligne);cursor:pointer;font-size:13px;font-weight:500;color:var(--txt-2)}
.tabs button.active{background:var(--magenta);color:#fff;border-color:var(--magenta)}
.empty-sm{padding:20px;color:var(--txt-2);font-size:13px;text-align:center}
.doc-view .fieldset{background:var(--papier);border-radius:var(--r);padding:10px 12px}
  `;
  document.head.appendChild(style);
})();

/* ============================================================
   BOOT ASYNC
   ============================================================ */
(async function boot(){
  try {
    await loadAll();
    // Vérifier session en cache
    let sessionUser = null;
    try {
      const sid = localStorage.getItem(SESSION_KEY);
      if(sid) sessionUser = DB.users.find(u => u.id === sid && u.active !== false) || null;
    } catch(e){}

    if(sessionUser){ enterApp(sessionUser); }
    else { renderAuth(); }
  } catch(err){
    console.error("Boot error:", err);
    // Afficher message d'erreur si Supabase injoignable
    document.getElementById("view").innerHTML=`<div class="empty" style="margin-top:80px">
      <svg class="em-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 9v4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
      <h4>Impossible de se connecter à Supabase</h4>
      <div>Vérifiez les clés dans <code>js/config.js</code> et la connexion internet.</div>
    </div>`;
  }
})();
