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
let DB = { settings:{}, roles:[], users:[], clients:[], products:[], fournisseurs:[], devis:[], factures:[], commandes:[], depenses:[] };
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
  createdAt:"created_at", roleId:"role_id", caisseId:"caisse_id",
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
  const supaTable = {users:"crm_users", roles:"crm_roles", settings:"app_settings"}[table]||table;
  if(table==="settings"){ dbUpsertSettings(DB.settings).catch(e=>console.error(e)); return; }
  dbUpsert(supaTable, obj).catch(e=>console.error(e));
}
function syncDel(table, id){
  const supaTable = {users:"crm_users", roles:"crm_roles", "journal":"journal_entries"}[table]||table;
  dbDelete(supaTable, id).catch(e=>console.error(e));
}

/* ============================================================
   CHARGEMENT INITIAL
   ============================================================ */
async function loadAll(){
  const [settingsRow, rolesRows, usersRows, clientsRows, productsRows,
         fournisseursRows, devisRows, facturesRows, commandesRows, depensesRows,
         employesRows, congesRows,
         stockMvtRows, caissesRows, caisseMvtRows,
         planComptaRows, journalRows,
         prodEtapesRows, prodActiviteRows,
         emailLogsRows, bonsAchatRows] = await Promise.all([
    dbFetchOne("app_settings"),
    dbFetch("crm_roles","created_at"),
    dbFetch("crm_users","created_at"),
    dbFetch("clients","created_at"),
    dbFetch("products","designation"),
    dbFetch("fournisseurs","created_at"),
    dbFetch("devis","created_at"),
    dbFetch("factures","created_at"),
    dbFetch("commandes","created_at"),
    dbFetch("depenses","created_at"),
    dbFetch("crm_employes","created_at"),
    dbFetch("crm_conges","created_at"),
    dbFetch("crm_stock_mouvements","date"),
    dbFetch("crm_caisses","created_at"),
    dbFetch("crm_caisse_mvt","date"),
    dbFetch("crm_plan_comptable","compte"),
    dbFetch("journal_entries","date"),
    dbFetch("crm_prod_etapes","created_at"),
    dbFetch("crm_prod_activite","created_at"),
    dbFetch("crm_email_logs","created_at"),
    dbFetch("crm_bons_achat","created_at"),
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
      SB.from("crm_roles").upsert(toDb({...r, systemRole:r.system}),{onConflict:"id"}).catch(e=>console.error(e));
    });
  }

  DB.users        = usersRows;
  DB.clients      = clientsRows;
  DB.products     = productsRows;
  DB.fournisseurs = fournisseursRows;
  DB.devis     = devisRows;
  DB.factures  = facturesRows;
  DB.commandes = commandesRows;
  DB.depenses  = depensesRows;
  DB.employes    = employesRows;
  DB.conges      = congesRows;
  DB.stockMvt    = stockMvtRows;
  DB.caisses     = caissesRows;
  DB.caisseMvt   = caisseMvtRows;
  DB.planCompta   = planComptaRows;
  DB.journal      = journalRows;
  DB.prodEtapes   = prodEtapesRows;
  DB.prodActivite = prodActiviteRows;
  DB.emailLogs   = emailLogsRows;
  DB.bonsAchat     = bonsAchatRows;
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
  const full={};["dashboard","clients","devis","factures","commandes","compta","catalogue","users","fournisseurs","fiscalite","depenses","crh","entrepot","caisses","infographistes","production","parametres"].forEach(m=>full[m]="edit");
  const mk=(map)=>{const o={};["dashboard","clients","devis","factures","commandes","compta","catalogue","users","fournisseurs","fiscalite","depenses","crh","entrepot","caisses","parametres"].forEach(m=>o[m]=map[m]||"none");return o};
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

const LOGO_SVG=`<img src="logo.png" alt="Creatis Studio" style="width:44px;height:44px;object-fit:contain">`;

function renderAuth(){
  document.body.classList.add("auth-on");
  const co=DB.settings?.company||{};
  $("#auth").innerHTML=`<div class="auth-bg"></div><div class="auth-card"><div class="auth-cmyk"><i></i><i></i><i></i><i></i></div>
    <div class="auth-body">
      <div class="auth-brand">${LOGO_SVG}<div><div class="ab-n">CREATIS STUDIO</div><div class="ab-s">CRM</div></div></div>
      <h3>Connexion</h3>
      <p class="muted">Espace ${esc(co.name||"Creatis Studio")}</p>
      <form id="f-login" onsubmit="return false">
        <div class="field"><label>Identifiant</label><input id="li-login" autocomplete="username" required></div>
        <div class="field"><label>Mot de passe</label><input id="li-pwd" type="password" autocomplete="current-password" required></div>
        <div id="login-err" class="auth-err"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="doLogin()">Se connecter</button>
      </form>
    </div></div>`;
  $("#auth").classList.add("show");
  setTimeout(()=>{ const i=$("#auth input"); if(i)i.focus(); },60);
}
async function doLogin(){
  const login=($("#li-login")||{}).value?.trim().toLowerCase()||"";
  const pw=($("#li-pwd")||{}).value||"";
  const errEl=$("#login-err");
  if(!DB.users||!DB.users.length){
    if(errEl)errEl.textContent="Connexion Supabase impossible. Vérifiez config.js et rechargez.";return;
  }
  const u=DB.users.find(x=>(x.login||"").toLowerCase()===login&&x.active!==false);
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
  {k:"parametres",label:"Paramètres"},
  {k:"fournisseurs",label:"Fournisseurs"},
  {k:"fiscalite",label:"Fiscalité"},
  {k:"depenses",label:"Dépenses"},
  {k:"crh",label:"RH / Employés"},
  {k:"entrepot",label:"Entrepôt"},
  {k:"caisses",label:"Caisses"},
  {k:"infographistes",label:"Infographistes"},
  {k:"production",label:"Atelier Production"}
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
const BAT_LABELS={non_demarre:"⚪ Pas démarré",en_cours:"🎨 En création",bat_envoye:"📤 BAT envoyé",en_revision:"🔄 Révisions",bat_approuve:"✅ BAT approuvé",en_impression:"🖨️ En impression"};
const BAT_COLORS={non_demarre:"var(--txt-3)",en_cours:"var(--cyan)",bat_envoye:"var(--jaune)",en_revision:"var(--mag)",bat_approuve:"var(--ok)",en_impression:"#7D3C98"};

// Workflow kanban commandes clients (statuts)
const CMD_FLOW=[
  ["devis",     "📋 Devis / Accepté"],
  ["production","🏭 Production"],
  ["controle",  "🔍 Contrôle / BAT"],
  ["livré",     "📦 Livré"],
  ["facturé",   "✅ Facturé"]
];
const CMD_COLORS={
  "devis":"var(--cyan)",
  "production":"#7D3C98",
  "controle":"var(--jaune)",
  "livré":"var(--ok)",
  "facturé":"var(--txt-2)"
};

// Statuts bons d'achat fournisseur
const BA_FLOW=[
  ["brouillon",   "📝 Brouillon"],
  ["envoyé",      "📤 Envoyé"],
  ["confirmé",    "✅ Confirmé"],
  ["reçu_partiel","📦 Reçu partiel"],
  ["reçu",        "✔️ Reçu"],
  ["annulé",      "❌ Annulé"]
];
function batBadge(st){const l=BAT_LABELS[st]||st,c=BAT_COLORS[st]||"var(--txt-2)";return`<span style="padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:${c}18;color:${c};border:1px solid ${c}40">${l}</span>`;}
function clientName(id){const c=DB.clients.find(x=>x.id===id);return c?c.nom:"—"}
function esc(s){if(s==null||s===undefined)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function toast(msg,dur=2800){const t=$("#toast");if(!t)return;t.textContent=msg;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),dur)}
function uid(){
  if(typeof crypto!=="undefined"&&crypto.randomUUID){return crypto.randomUUID()}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{
    const r=Math.random()*16|0;return(c==="x"?r:(r&0x3|0x8)).toString(16);
  });
}
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
   MODULE FNE — Certification DGI Côte d'Ivoire
   API REST : /api/index.php → /api/fne (proxy Vercel)
   Doc DGI : https://www.dgi.gouv.ci/assets/documents/FNE-procedureapi.pdf
   ============================================================ */

const FNE_CONFIG_KEY = "creatis_fne_config";
function getFneConfig(){ try{return JSON.parse(localStorage.getItem(FNE_CONFIG_KEY)||"{}")}catch(e){return{}} }
function saveFneConfig(c){ try{localStorage.setItem(FNE_CONFIG_KEY,JSON.stringify(c))}catch(e){} }

// Statut FNE → badge HTML
function fneBadge(f){
  const st = f.fneStatus || f.fne_status || "non_certifiee";
  const map = {
    "certifiee":     `<span class="pill p-green" style="font-size:10px"><span class="dot"></span>FNE Certifiée ✓</span>`,
    "en_attente":    `<span class="pill p-amber" style="font-size:10px"><span class="dot"></span>FNE En attente</span>`,
    "erreur":        `<span class="pill p-red"   style="font-size:10px"><span class="dot"></span>FNE Erreur</span>`,
    "non_certifiee": `<span class="pill p-grey"  style="font-size:10px"><span class="dot"></span>Non certifiée</span>`,
  };
  return map[st] || map["non_certifiee"];
}

// Certifier une facture via l'API FNE DGI
async function certifierFNE(factureId){
  const cfg = getFneConfig();
  if(!cfg.apiKey || !cfg.apiUrl){
    toast("⚠️ Configurez d'abord la clé API FNE dans Paramètres → FNE");
    return go("parametres");
  }
  const f = DB.factures.find(x=>x.id===factureId);
  if(!f){ toast("Facture introuvable"); return; }
  const co = DB.settings.company || {};
  const cli = DB.clients.find(x=>x.id===f.clientId) || {};

  // Mettre en attente
  f.fneStatus = "en_attente";
  sync("factures", f);
  toast("⏳ Certification FNE en cours…");

  // Construire le payload DGI
  const payload = {
    invoiceType:        "SALE",
    paymentMethod:      cfg.paymentMethod || "TRANSFER",
    template:           cli.ncc ? "B2B" : "B2C",
    isRne:              false,
    clientNcc:          cli.ncc || "",
    clientCompanyName:  cli.nom || clientName(f.clientId),
    clientPhone:        parseInt((cli.tel||"").replace(/\D/g,"")) || 0,
    clientEmail:        cli.email || "",
    pointOfSale:        cfg.pointOfSale || co.name || "CREATIS STUDIO",
    establishment:      co.name || "CREATIS STUDIO",
    commercialMessage:  f.notes || "",
    items: (f.lignes||[]).map(l=>({
      description: l.designation || "",
      quantity:    parseFloat(l.qte) || 1,
      unitPrice:   parseFloat(l.pu) || 0,
      discount:    parseFloat(l.remise) || 0,
      taxType:     ["TVA"],
    })),
  };

  try {
    const resp = await fetch("/api/fne", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, action: "sign", payload }),
    });
    const data = await resp.json();

    if(!resp.ok || data.error){
      f.fneStatus = "erreur";
      sync("factures", f);
      toast("❌ Erreur FNE : " + (data.error || data.message || resp.status));
      return;
    }

    // Succès — stocker les données FNE
    f.fneStatus      = "certifiee";
    f.fneNumber      = data.invoiceNumber || data.fneNumber || data.number || "";
    f.fneQrUrl       = data.qrCodeUrl     || data.qrCode   || data.tokenUrl || "";
    f.fneInvoiceId   = data.id            || data.invoiceId || "";
    f.fneCertifiedAt = new Date().toISOString();
    sync("factures", f);
    refreshBadges();
    toast("✅ Facture FNE certifiée : " + f.fneNumber);
    closeOverlays();
    go("factures");
  } catch(err){
    f.fneStatus = "erreur";
    sync("factures", f);
    toast("❌ Erreur réseau : " + err.message);
  }
}

// Section FNE dans viewParamètres
function renderFneSettings(){
  const cfg = getFneConfig();
  return `
  <div class="card panel" style="margin-top:16px;border-left:3px solid #00843D">
    <div class="panel-h">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;background:#00843D;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:14px">f</div>
        <div>
          <h3>Facture Normalisée Électronique (FNE)</h3>
          <div style="font-size:11px;color:var(--txt-2)">Intégration API DGI — Côte d'Ivoire</div>
        </div>
      </div>
      <div class="spacer"></div>
      <a href="https://services.fne.dgi.gouv.ci" target="_blank" class="btn btn-sm btn-ghost" style="font-size:11px">🔗 Plateforme FNE</a>
    </div>
    <div class="two" style="gap:12px;margin-bottom:14px">
      <div class="field">
        <label>URL API DGI</label>
        <select id="fne-url-select" onchange="document.getElementById('fne-url').value=this.value">
          <option value="http://54.247.95.108/ws" ${(cfg.apiUrl||"")==="http://54.247.95.108/ws"?"selected":""}>Environnement TEST — http://54.247.95.108/ws</option>
          <option value="custom" ${cfg.apiUrl&&cfg.apiUrl!=="http://54.247.95.108/ws"?"selected":""}>Production (URL fournie par DGI)</option>
        </select>
        <input id="fne-url" style="margin-top:6px;font-family:monospace;font-size:11px"
          placeholder="URL de production fournie par la DGI"
          value="${esc(cfg.apiUrl||"http://54.247.95.108/ws")}">
      </div>
      <div class="field">
        <label>Clé API (Bearer Token)</label>
        <input id="fne-key" type="password" placeholder="Disponible dans Paramétrage de votre espace FNE"
               value="${esc(cfg.apiKey||"")}">
        <div style="font-size:10.5px;color:var(--txt-3);margin-top:3px">
          Espace FNE → onglet <strong>Paramétrage</strong> → Clé API
        </div>
      </div>
    </div>
    <div class="row2" style="gap:12px;margin-bottom:14px">
      <div class="field">
        <label>Point de vente</label>
        <input id="fne-pdv" placeholder="ex : Siège Social Cocody" value="${esc(cfg.pointOfSale||"")}">
      </div>
      <div class="field">
        <label>Mode de paiement par défaut</label>
        <select id="fne-payment">
          <option value="TRANSFER" ${(cfg.paymentMethod||"TRANSFER")==="TRANSFER"?"selected":""}>Virement bancaire</option>
          <option value="CASH"     ${(cfg.paymentMethod||"")==="CASH"?"selected":""}>Espèces</option>
          <option value="CHECK"    ${(cfg.paymentMethod||"")==="CHECK"?"selected":""}>Chèque</option>
          <option value="MOBILE"   ${(cfg.paymentMethod||"")==="MOBILE"?"selected":""}>Mobile Money</option>
        </select>
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" style="background:#00843D;border-color:#00843D" onclick="saveFneSettings()">💾 Enregistrer</button>
      <button class="btn" onclick="testFneConnection()">🔌 Tester la connexion</button>
      <div style="font-size:11px;color:var(--txt-3);flex:1">
        <strong>Étapes :</strong>
        1) S'inscrire sur <a href="https://services.fne.dgi.gouv.ci" target="_blank" style="color:var(--cyan)">services.fne.dgi.gouv.ci</a> —
        2) Récupérer la clé API dans Paramétrage —
        3) Tester ici —
        4) Envoyer les spécimens à <a href="mailto:support.fne@dgi.gouv.ci" style="color:var(--cyan)">support.fne@dgi.gouv.ci</a> —
        5) Recevoir l'URL de production
      </div>
    </div>
    <div id="fne-status" style="margin-top:10px;font-size:12.5px"></div>
  </div>`;
}

function saveFneSettings(){
  const cfg = {
    apiUrl:        document.getElementById("fne-url")?.value?.trim()||"",
    apiKey:        document.getElementById("fne-key")?.value?.trim()||"",
    pointOfSale:   document.getElementById("fne-pdv")?.value?.trim()||"",
    paymentMethod: document.getElementById("fne-payment")?.value||"TRANSFER",
  };
  saveFneConfig(cfg);
  const s=document.getElementById("fne-status");
  if(s)s.innerHTML=`<span style="color:var(--ok)">✅ Configuration FNE enregistrée</span>`;
  toast("Configuration FNE sauvegardée");
}

async function testFneConnection(){
  saveFneSettings();
  const s=document.getElementById("fne-status");
  if(s)s.innerHTML="⏳ Test de connexion à la DGI…";
  const cfg=getFneConfig();
  if(!cfg.apiKey||!cfg.apiUrl){if(s)s.innerHTML=`<span style="color:var(--danger)">❌ URL et clé API requises</span>`;return;}
  try{
    const resp=await fetch("/api/fne",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({apiKey:cfg.apiKey,apiUrl:cfg.apiUrl,action:"sign",
        payload:{invoiceType:"SALE",paymentMethod:"TRANSFER",template:"B2C",isRne:false,
          clientCompanyName:"TEST",clientPhone:0,clientEmail:"test@test.ci",
          pointOfSale:"TEST",establishment:"TEST",items:[{description:"TEST",quantity:1,unitPrice:0,discount:0,taxType:["TVA"]}]}})});
    const data=await resp.json();
    if(resp.status===401){if(s)s.innerHTML=`<span style="color:var(--danger)">❌ Clé API invalide (401) — Vérifiez votre clé dans l'espace FNE</span>`;return;}
    if(resp.status===400&&data){if(s)s.innerHTML=`<span style="color:var(--ok)">✅ Connexion DGI établie (réponse : ${JSON.stringify(data).slice(0,80)})</span>`;return;}
    if(s)s.innerHTML=`<span style="color:var(--ok)">✅ API DGI accessible — Code : ${resp.status}</span>`;
  }catch(e){
    if(s)s.innerHTML=`<span style="color:var(--danger)">❌ ${esc(e.message)}</span>
      <div style="font-size:11.5px;color:var(--txt-2);margin-top:6px">
        Si le proxy renvoie une erreur réseau, vérifiez que l'URL DGI est accessible.<br>
        Environnement TEST : http://54.247.95.108/ws (disponible uniquement après inscription)
      </div>`;
  }
}

/* ============================================================
   MODULE FISCALITÉ — BIC, IMF, Patente, Acomptes (CGI CI)
   RSI : BIC 25% / IMF 2% CA TTC / MAX(BIC,IMF)
   ============================================================ */
function viewFiscalite(){
  const co  = DB.settings.company || {};
  const y   = new Date().getFullYear();
  const dev = DB.settings.devise || "F CFA";
  const fmt = n => Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ") + " " + dev;

  // ── Données comptables ──────────────────────────────────────────
  let caTTC=0, caHT=0, depHT=0, tvaCollectee=0;
  DB.factures.forEach(f=>{
    if(new Date(f.date||f.createdAt||0).getFullYear()===y){
      caTTC += f.montantTTC||0;
      caHT  += f.montantHT||0;
      tvaCollectee += f.montantTVA||0;
    }
  });
  DB.depenses.forEach(d=>{
    if(new Date(d.date||d.createdAt||0).getFullYear()===y){
      depHT += d.ht||0;
    }
  });

  // ── Calcul BIC ──────────────────────────────────────────────────
  const resultatComptable = caHT - depHT;
  const bicBrut  = Math.max(0, resultatComptable * 0.25);   // 25% bénéfice net
  const imfRSI   = Math.max(400000, caTTC * 0.02);          // 2% CA TTC, min 400 000 F
  const impotDu  = Math.max(bicBrut, imfRSI);
  const acompte  = Math.round(impotDu / 3);
  const regime   = co.regime || "Réel Simplifié";

  // ── Patente (barème simplifié sur CA HT) ────────────────────────
  // Droit sur CA : progressif selon CGI
  let droitCA = 0;
  if(caHT <= 5000000)          droitCA = caHT * 0.004;
  else if(caHT <= 20000000)    droitCA = 20000  + (caHT-5000000)  * 0.005;
  else if(caHT <= 100000000)   droitCA = 95000  + (caHT-20000000) * 0.006;
  else if(caHT <= 500000000)   droitCA = 575000 + (caHT-100000000)* 0.007;
  else                          droitCA = 3375000+ (caHT-500000000)* 0.008;
  const droitVL  = 18000; // valeur locative estimée (à renseigner manuellement)
  const patente  = Math.round(droitCA + droitVL);

  // ── Déclarations TVA ──────────────────────────────────────────
  let tvaQ = Array(4).fill(null).map(()=>({coll:0,ded:0}));
  DB.factures.forEach(f=>{
    (f.paiements||[]).forEach(p=>{
      const d=new Date(p.date); if(d.getFullYear()!==y) return;
      const qi=Math.floor(d.getMonth()/3);
      tvaQ[qi].coll += f.montantTVA?f.montantTVA*(+p.montant/(f.montantTTC||1)):0;
    });
  });
  DB.depenses.forEach(d=>{ if(d.date){const dd=new Date(d.date);if(dd.getFullYear()===y){const qi=Math.floor(dd.getMonth()/3);tvaQ[qi].ded+=d.tva||0;}} });

  const now = new Date(), mois = now.getMonth(), qCour = Math.floor(mois/3);
  const echeances = [
    {label:"Patente",         date:`31/03/${y}`,  montant:patente,              statut:"fiscale",   note:"Droit CA + Droit VL"},
    {label:"BIC/IMF — 1ʳᵉ fraction", date:`20/04/${y}`,montant:acompte,        statut:"bic",       note:"1/3 de l'impôt dû"},
    {label:"TVA — T1",        date:`20/04/${y}`,  montant:Math.max(0,Math.round(tvaQ[0].coll-tvaQ[0].ded)), statut:"tva", note:"Jan–Mar"},
    {label:"BIC/IMF — 2ᵉ fraction",  date:`20/07/${y}`,montant:acompte,        statut:"bic",       note:"1/3 de l'impôt dû"},
    {label:"TVA — T2",        date:`20/07/${y}`,  montant:Math.max(0,Math.round(tvaQ[1].coll-tvaQ[1].ded)), statut:"tva", note:"Avr–Jun"},
    {label:"BIC/IMF — 3ᵉ fraction",  date:`20/09/${y}`,montant:acompte,        statut:"bic",       note:"1/3 de l'impôt dû"},
    {label:"TVA — T3",        date:`20/10/${y}`,  montant:Math.max(0,Math.round(tvaQ[2].coll-tvaQ[2].ded)), statut:"tva", note:"Jul–Sep"},
    {label:"Déclaration BIC annuelle",date:`31/05/${y+1}`,montant:impotDu,     statut:"bic",       note:"Solde après acomptes"},
    {label:"TVA — T4",        date:`20/01/${y+1}`,montant:Math.max(0,Math.round(tvaQ[3].coll-tvaQ[3].ded)), statut:"tva", note:"Oct–Déc"},
  ].map(e=>({...e, isLate: new Date(e.date.split("/").reverse().join("-")) < now}));

  const stColor = {bic:"var(--cyan)",tva:"var(--mag)",fiscale:"var(--jaune)"};
  const stLabel = {bic:"BIC/IMF",tva:"TVA",fiscale:"Patente"};

  $("#pg-title").textContent = "Fiscalité & Obligations";
  $("#pg-sub").textContent   = `${co.name||"Creatis Studio"} — Régime ${regime} — Exercice ${y}`;
  $("#pg-actions").innerHTML = `
    <button class="btn" style="border-color:#1D6F42;color:#1D6F42" onclick="exportFiscaliteExcel()">📊 Excel</button>
    <button class="btn" onclick="printFiscalite()">Fiche fiscale</button>
    ${wr("fiscalite")?`<button class="btn btn-primary" onclick="openAcompte()">Enregistrer un acompte</button>`:""}
  `;

  $("#view").innerHTML = `

  <!-- KPIs fiscaux -->
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">CA TTC ${y}</div>
      <div class="val tabnum">${fmt(Math.round(caTTC))}</div>
      <div class="delta">HT : ${fmt(Math.round(caHT))}</div>
    </div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">Résultat comptable</div>
      <div class="val tabnum" style="color:${resultatComptable>=0?"var(--ok)":"var(--danger)"}">${fmt(Math.round(resultatComptable))}</div>
      <div class="delta">${resultatComptable>=0?"Bénéfice":"Déficit"} avant impôt</div>
    </div>
    <div class="card kpi c-jaune"><span class="tick"></span>
      <div class="lab">BIC estimé (25%)</div>
      <div class="val tabnum">${fmt(Math.round(bicBrut))}</div>
      <div class="delta">IMF (2% CA TTC) : ${fmt(Math.round(imfRSI))}</div>
    </div>
    <div class="card kpi c-noir"><span class="tick"></span>
      <div class="lab">Impôt dû MAX(BIC,IMF)</div>
      <div class="val tabnum">${fmt(Math.round(impotDu))}</div>
      <div class="delta">Acompte (1/3) : ${fmt(acompte)}</div>
    </div>
  </div>

  <!-- BIC + IMF + Patente -->
  <div class="two-13" style="margin-bottom:16px">
    <div class="card panel">
      <div class="panel-h"><h3>📊 Calcul BIC / IMF — RSI ${y}</h3><div class="spacer"></div><span class="micro">Art. 34 & 90 CGI</span></div>

      <!-- Résultat -->
      <div style="background:var(--papier);border-radius:var(--r);padding:14px 16px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt-2);margin-bottom:10px">Compte de résultat simplifié</div>
        ${kv("Chiffre d'affaires HT",fmt(Math.round(caHT)))}
        ${kv("Charges déductibles HT","− "+fmt(Math.round(depHT)))}
        <div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-top:2px solid var(--encre);margin-top:4px">
          <span style="font-weight:700">Résultat fiscal</span>
          <span style="font-weight:700;font-family:monospace;color:${resultatComptable>=0?"var(--ok)":"var(--danger)"}">${fmt(Math.round(resultatComptable))}</span>
        </div>
      </div>

      <!-- BIC vs IMF -->
      <div class="two" style="gap:12px;margin-bottom:14px">
        <div style="padding:12px 14px;background:${bicBrut>=imfRSI?"#E3F6EC":"var(--papier)"};border-radius:var(--r);border:${bicBrut>=imfRSI?"2px solid var(--ok)":"1px solid var(--ligne)"}">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--txt-2);margin-bottom:6px">BIC — 25% du bénéfice</div>
          <div style="font-size:20px;font-weight:700;font-family:monospace">${fmt(Math.round(bicBrut))}</div>
          <div style="font-size:11px;color:var(--txt-2);margin-top:4px">${fmt(Math.round(resultatComptable))} × 25%</div>
          ${bicBrut>=imfRSI?`<div class="pill p-green" style="margin-top:6px;font-size:10px"><span class="dot"></span>Montant retenu</div>`:""}
        </div>
        <div style="padding:12px 14px;background:${imfRSI>bicBrut?"#FEF3E2":"var(--papier)"};border-radius:var(--r);border:${imfRSI>bicBrut?"2px solid var(--warn)":"1px solid var(--ligne)"}">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--txt-2);margin-bottom:6px">IMF — 2% du CA TTC</div>
          <div style="font-size:20px;font-weight:700;font-family:monospace">${fmt(Math.round(imfRSI))}</div>
          <div style="font-size:11px;color:var(--txt-2);margin-top:4px">${fmt(Math.round(caTTC))} × 2% (min 400 000 F)</div>
          ${imfRSI>bicBrut?`<div class="pill p-amber" style="margin-top:6px;font-size:10px"><span class="dot"></span>Montant retenu</div>`:""}
        </div>
      </div>

      <!-- Acomptes -->
      <div style="background:#1A1A1C;border-radius:var(--r);padding:14px 16px;color:#fff">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:10px">Acomptes provisionnels (3 fractions égales)</div>
        <div style="display:flex;justify-content:space-between;gap:8px">
          ${[["1ʳᵉ fraction","20/04"],["2ᵉ fraction","20/07"],["3ᵉ fraction","20/09"]].map(([l,d])=>`
          <div style="flex:1;background:rgba(255,255,255,.07);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:9.5px;color:rgba(255,255,255,.5);margin-bottom:4px">${l}</div>
            <div style="font-family:monospace;font-size:14px;font-weight:700;color:#FFC400">${fmt(acompte)}</div>
            <div style="font-size:9.5px;color:rgba(255,255,255,.4);margin-top:4px">avant le ${d}/${y}</div>
          </div>`).join("")}
        </div>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;font-size:12px">
          <span style="color:rgba(255,255,255,.6)">Total impôt dû</span>
          <span style="font-family:monospace;font-weight:700;color:#FFC400">${fmt(Math.round(impotDu))}</span>
        </div>
      </div>
    </div>

    <!-- Patente + Infos régime -->
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card panel">
        <div class="panel-h"><h3>🏢 Patente ${y}</h3><div class="spacer"></div><span class="micro">Art. 261 CGI</span></div>
        ${kv("Droit sur CA (barème)",fmt(Math.round(droitCA)))}
        ${kv("Droit valeur locative","estimé "+fmt(droitVL))}
        <div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-top:2px solid var(--encre);margin-top:4px;font-weight:700">
          <span>Patente estimée</span><span style="font-family:monospace;color:var(--jaune)">${fmt(patente)}</span>
        </div>
        <div style="margin-top:8px;padding:7px 10px;background:#FFF3CD;border-radius:6px;font-size:10.5px;color:#856404">
          ⚠️ Montant indicatif. La patente définitive est établie par la DGI sur la base du CA de l'année précédente. Échéance : <strong>31 mars ${y}</strong>.
        </div>
      </div>

      <div class="card panel">
        <div class="panel-h"><h3>📋 Régime fiscal</h3></div>
        ${kv("Régime",co.regime||"Réel Simplifié")}
        ${kv("Centre des impôts",co.centre||"II Plateaux 2")}
        ${kv("NCC / CC",co.cc||"0811105V")}
        ${kv("RCCM",co.rc||"CI-ABJ-2007-B-3172")}
        ${kv("Taux BIC","25% (personnes morales)")}
        ${kv("Taux IMF RSI","2% CA TTC (min 400 000 F)")}
        ${kv("TVA","18% (collectée et déclarée par trimestre)")}
        <div style="margin-top:10px;padding:7px 10px;background:var(--papier);border-radius:6px;font-size:10.5px;color:var(--txt-2)">
          RSI applicable entre 200 M et 500 M FCFA de CA TTC.
        </div>
      </div>
    </div>
  </div>

  <!-- Calendrier fiscal -->
  <div class="card panel" style="margin-bottom:16px">
    <div class="panel-h"><h3>📅 Calendrier fiscal ${y}</h3><div class="spacer"></div><span class="micro">Échéances DGI</span></div>
    <div style="overflow-x:auto"><table><thead><tr>
      <th>Obligation</th><th>Échéance</th><th>Type</th><th class="r">Montant estimé</th><th>Statut</th>
    </tr></thead><tbody>
    ${echeances.map(e=>`<tr>
      <td><div class="nm">${e.label}</div><div class="meta">${e.note||""}</div></td>
      <td class="meta" style="white-space:nowrap;font-weight:${e.isLate?"700":"400"};color:${e.isLate?"var(--danger)":"inherit"}">${e.date}</td>
      <td><span class="pill" style="background:${stColor[e.statut]||"var(--cyan)"}18;color:${stColor[e.statut]||"var(--cyan)"};font-size:10px;border:1px solid ${stColor[e.statut]||"var(--cyan)"}30"><span class="dot" style="background:${stColor[e.statut]||"var(--cyan)"}"></span>${stLabel[e.statut]||e.statut}</span></td>
      <td class="r tabnum">${e.montant?fmt(e.montant):"—"}</td>
      <td>${e.isLate?`<span class="pill p-red" style="font-size:10px"><span class="dot"></span>Passée</span>`:`<span class="pill p-blue" style="font-size:10px"><span class="dot"></span>À venir</span>`}</td>
    </tr>`).join("")}
    </tbody></table></div>
    <div style="margin-top:12px;padding:8px 12px;background:var(--papier);border-radius:6px;font-size:10.5px;color:var(--txt-2)">
      <strong>Note :</strong> Tous les montants sont des estimations basées sur les données saisies dans le CRM.
      Consulter un expert-comptable pour les déclarations officielles.
    </div>
  </div>

  <!-- TVA par trimestre -->
  <div class="card panel">
    <div class="panel-h"><h3>💼 Déclarations TVA — ${y}</h3><div class="spacer"></div><span class="micro">18% — Art. 339 CGI</span></div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
    ${tvaQ.map((q,i)=>{
      const net=Math.round(q.coll-q.ded);
      const labels=["T1 — Jan/Mar","T2 — Avr/Jun","T3 — Jul/Sep","T4 — Oct/Déc"];
      const dates=[`20/04/${y}`,`20/07/${y}`,`20/10/${y}`,`20/01/${y+1}`];
      const isCur=i===qCour;
      return`<div style="padding:14px;border-radius:var(--r);border:${isCur?"2px solid var(--cyan)":"1px solid var(--ligne)"};background:${isCur?"rgba(0,174,239,.05)":"var(--carte)"}">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${isCur?"var(--cyan)":"var(--txt-2)"};margin-bottom:8px">${labels[i]} ${isCur?"·  En cours":""}</div>
        <div style="font-size:10.5px;color:var(--txt-2);line-height:1.9">
          <div>Collectée : <strong>${fmt(Math.round(q.coll))}</strong></div>
          <div>Déductible : <strong>${fmt(Math.round(q.ded))}</strong></div>
        </div>
        <div style="margin-top:8px;padding:6px 10px;border-radius:6px;text-align:center;background:${net>=0?"#FEF3E2":"#E3F6EC"};font-size:12px;font-weight:700;color:${net>=0?"#856404":"var(--ok)"}">
          ${net>=0?"À reverser":"Crédit"}<br>${fmt(Math.abs(net))}
        </div>
        <div style="font-size:9px;color:var(--txt-3);text-align:center;margin-top:5px">Avant le ${dates[i]}</div>
      </div>`;
    }).join("")}
    </div>
  </div>`;
}
/* ============================================================
   MODULE DÉPENSES
   ============================================================ */
const CAT_DEP = ["Fournitures","Loyer","Salaires","Transport","Sous-traitance",
                  "Équipement","Communication","Frais bancaires","Taxes & impôts","Divers"];

function viewDepenses(){
  if(!vis("depenses"))return;
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";

  const totalHT  = DB.depenses.reduce((s,d)=>s+(+d.ht||0),0);
  const totalTTC = DB.depenses.reduce((s,d)=>s+(+d.ttc||0),0);
  const nbImpaye = DB.depenses.filter(d=>d.statut_paiement==="impayee"||d.statut_paiement==="en_attente").length;

  $("#pg-title").textContent="Dépenses";
  $("#pg-sub").textContent=`${DB.depenses.length} dépense(s) enregistrée(s)`;
  const _depCats=[...new Set(DB.depenses.map(d=>d.categorie).filter(Boolean))].sort();
  $("#pg-actions").innerHTML=`
    <input id="srch-dep" placeholder="🔍 Rechercher..." oninput="filterDep()" style="padding:7px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:160px;font-size:12px">
    <select id="fil-dep-cat" onchange="filterDep()" style="padding:7px 10px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);font-size:12px;min-width:130px">
      <option value="">Toutes catégories</option>
      ${_depCats.map(c=>`<option>${esc(c)}</option>`).join("")}
    </select>
    <select id="fil-dep-st" onchange="filterDep()" style="padding:7px 10px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);font-size:12px">
      <option value="">Tous statuts</option>
      <option value="payee">Payée</option>
      <option value="en_attente">En attente</option>
      <option value="impayee">Impayée</option>
    </select>
    <button class="btn" onclick="exportExcel('depenses')" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
    ${wr("depenses")?`<button class="btn btn-primary" onclick="openDepense()">+ Nouvelle dépense</button>`:""}
  ` ;

  $("#view").innerHTML=`
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-rouge"><span class="tick"></span>
      <div class="lab">Total dépenses HT</div>
      <div class="val tabnum">${fmt(totalHT)}</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">Total TTC</div>
      <div class="val tabnum">${fmt(totalTTC)}</div></div>
    <div class="card kpi c-jaune"><span class="tick"></span>
      <div class="lab">En attente de paiement</div>
      <div class="val">${nbImpaye}</div></div>
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">TVA déductible</div>
      <div class="val tabnum">${fmt(DB.depenses.reduce((s,d)=>s+(+d.tva||0),0))}</div></div>
  </div>
  <div class="card panel">
    <div class="panel-h"><h3>Toutes les dépenses</h3><div class="spacer"></div>
      <select id="fil-dep-cat" onchange="renderDepList()" style="width:160px"><option value="">Toutes catégories</option>${CAT_DEP.map(c=>`<option>${c}</option>`).join("")}</select>
      <select id="fil-dep-st" onchange="renderDepList()" style="width:140px"><option value="">Tous statuts</option><option value="payee">Payée</option><option value="impayee">Impayée</option><option value="en_attente">En attente</option></select>
    </div>
    <div id="dep-list"></div>
  </div>`;
  renderDepList();
}

function renderDepList(){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";
  const _q=(document.getElementById("srch-dep")?.value||window._depSrch||"").toLowerCase();
  const _cat=document.getElementById("fil-dep-cat")?.value||window._depCat||"";
  const _st=document.getElementById("fil-dep-st")?.value||window._depSt||"";
  if(document.getElementById("srch-dep")){window._depSrch=document.getElementById("srch-dep").value;}
  const cat=document.getElementById("fil-dep-cat")?.value||"";
  const st =document.getElementById("fil-dep-st")?.value||"";
  const stPill={payee:`<span class="pill p-green"><span class="dot"></span>Payée</span>`,
    impayee:`<span class="pill p-red"><span class="dot"></span>Impayée</span>`,
    en_attente:`<span class="pill p-amber"><span class="dot"></span>En attente</span>`};
  let rows=DB.depenses.filter(d=>(!cat||d.categorie===cat)&&(!st||d.statut_paiement===st))
    .sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const el=document.getElementById("dep-list");
  if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty">Aucune dépense</div>`;return;}
  el.innerHTML=`<table><thead><tr>
    <th>Date</th><th>N° Pièce</th><th>Libellé</th><th>Catégorie</th><th>Fournisseur</th>
    <th class="r">HT</th><th class="r">TVA</th><th class="r">TTC</th>
    <th>Mode</th><th>Statut</th><th>Échéance</th><th></th>
  </tr></thead><tbody>
  ${rows.map(d=>`<tr>
    <td class="meta">${fmtD(d.date)}</td>
    <td class="meta">${esc(d.numero_piece||"—")}</td>
    <td><div class="nm">${esc(d.libelle||"")}</div></td>
    <td><span class="pill p-grey" style="font-size:10px">${esc(d.categorie||"—")}</span></td>
    <td class="meta">${esc(d.fournisseur||"—")}</td>
    <td class="r tabnum">${fmt(d.ht)}</td>
    <td class="r tabnum" style="color:var(--cyan)">${fmt(d.tva)}</td>
    <td class="r tabnum"><strong>${fmt(d.ttc)}</strong></td>
    <td class="meta">${esc(d.mode_paiement||"—")}</td>
    <td>${stPill[d.statut_paiement]||`<span class="pill p-grey">${esc(d.statut_paiement||"—")}</span>`}</td>
    <td class="meta" style="color:${d.echeance&&new Date(d.echeance)<new Date()?"var(--danger)":"inherit"}">${fmtD(d.echeance)}</td>
    <td>${wr("depenses")?`<button class="btn btn-sm btn-ghost" onclick="openDepense('${d.id}')">✏️</button> <button class="btn btn-sm btn-ghost" onclick="delDepense('${d.id}')">🗑</button>`:""}
    </td>
  </tr>`).join("")}
  </tbody></table>`;
}

function openDepense(id){
  if(!wr("depenses"))return;
  const d=id?DB.depenses.find(x=>x.id===id)||{}:{};
  const fournOpts=DB.fournisseurs.map(f=>`<option value="${f.nom||""}" ${d.fournisseur===f.nom?"selected":""}>${esc(f.nom||"")}</option>`).join("");
  modal(`<h2>${id?"Modifier":"Nouvelle"} dépense</h2>
  <div class="two">
    <div class="field"><label>Date *</label><input id="dep-date" type="date" value="${d.date||todayISO()}"></div>
    <div class="field"><label>N° Pièce</label><input id="dep-piece" value="${esc(d.numero_piece||"")}"></div>
  </div>
  <div class="field"><label>Libellé *</label><input id="dep-lib" value="${esc(d.libelle||"")}"></div>
  <div class="two">
    <div class="field"><label>Catégorie</label><select id="dep-cat">${CAT_DEP.map(c=>`<option ${d.categorie===c?"selected":""}>${c}</option>`).join("")}</select></div>
    <div class="field"><label>Fournisseur</label><input id="dep-four" list="four-list" value="${esc(d.fournisseur||"")}"><datalist id="four-list">${fournOpts}</datalist></div>
  </div>
  <div class="three">
    <div class="field"><label>Montant HT *</label><input id="dep-ht" type="number" step="1" value="${d.ht||0}" oninput="calcDep()"></div>
    <div class="field"><label>TVA (F)</label><input id="dep-tva" type="number" step="1" value="${d.tva||0}" oninput="calcDep()"></div>
    <div class="field"><label>Total TTC</label><input id="dep-ttc" type="number" step="1" value="${d.ttc||0}" readonly style="background:var(--papier)"></div>
  </div>
  <div class="two">
    <div class="field"><label>Mode de paiement</label>
      <select id="dep-mode"><option value="virement" ${d.mode_paiement==="virement"?"selected":""}>Virement</option><option value="cheque" ${d.mode_paiement==="cheque"?"selected":""}>Chèque</option><option value="especes" ${d.mode_paiement==="especes"?"selected":""}>Espèces</option><option value="mobile" ${d.mode_paiement==="mobile"?"selected":""}>Mobile Money</option></select>
    </div>
    <div class="field"><label>Statut paiement</label>
      <select id="dep-st"><option value="payee" ${d.statut_paiement==="payee"?"selected":""}>Payée</option><option value="en_attente" ${d.statut_paiement==="en_attente"?"selected":""}>En attente</option><option value="impayee" ${(!d.statut_paiement||d.statut_paiement==="impayee")?"selected":""}>Impayée</option></select>
    </div>
  </div>
  <div class="field"><label>Échéance</label><input id="dep-ech" type="date" value="${d.echeance||""}"></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveDepense('${id||""}')">Enregistrer</button>
  </div>`);
  calcDep();
}
function calcDep(){
  const ht=+document.getElementById("dep-ht")?.value||0;
  const tv=+document.getElementById("dep-tva")?.value||0;
  const el=document.getElementById("dep-ttc");
  if(el)el.value=Math.round(ht+tv);
}
async function saveDepense(id){
  const rec={
    date:          document.getElementById("dep-date").value,
    libelle:       document.getElementById("dep-lib").value.trim(),
    categorie:     document.getElementById("dep-cat").value,
    fournisseur:   document.getElementById("dep-four").value.trim(),
    ht:            +document.getElementById("dep-ht").value||0,
    tva:           +document.getElementById("dep-tva").value||0,
    ttc:           +document.getElementById("dep-ttc").value||0,
    numero_piece:  document.getElementById("dep-piece").value.trim(),
    mode_paiement: document.getElementById("dep-mode").value,
    statut_paiement:document.getElementById("dep-st").value,
    echeance:      document.getElementById("dep-ech").value||null,
  };
  if(!rec.libelle||!rec.date){toast("Libellé et date requis");return;}
  const obj = id ? {id,...rec} : {...rec, id:crypto.randomUUID()};
  const ok = await dbUpsert("depenses", obj);
  if(!ok) return;
  if(id){ const i=DB.depenses.findIndex(x=>x.id===id); if(i>=0) DB.depenses[i]=obj; }
  else   { DB.depenses.push(obj); }
  toast(id?"Dépense modifiée":"Dépense ajoutée");
  closeOverlays();
  // Mise à jour douce : reste sur l'onglet/vue actuel
  if(document.getElementById("dep-list")) renderDepList();
  else if(document.getElementById("compta-tab-content")) renderComptaTab();
  else go("depenses");
}
async function delDepense(id){
  if(!confirm("Supprimer cette dépense ?"))return;
  await dbDelete("depenses",id);
  DB.depenses = DB.depenses.filter(x=>x.id!==id);
  toast("Dépense supprimée");
  if(document.getElementById("dep-list")) renderDepList();
  else if(document.getElementById("compta-tab-content")) renderComptaTab();
  else go("depenses");
}

/* ============================================================
   MODULE CRH — Ressources Humaines
   Employés, contrats, salaires, congés, CNPS
   ============================================================ */
function viewCrh(){
  if(!vis("crh"))return;
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;

  const actifs    = DB.employes.filter(e=>e.statut==="actif");
  const masseSal  = actifs.reduce((s,e)=>s+(+e.salaire_brut||0),0);
  const cnpsPatr  = masseSal * 0.1825; // 18.25% part patronale
  const cnpsSal   = masseSal * 0.036;  // 3.6% part salariale

  const stPill={
    actif:`<span class="pill p-green"><span class="dot"></span>Actif</span>`,
    conge:`<span class="pill p-amber"><span class="dot"></span>En congé</span>`,
    inactif:`<span class="pill p-grey"><span class="dot"></span>Inactif</span>`
  };
  const ctrPill={
    CDI:`<span class="pill p-cyan" style="font-size:10px">CDI</span>`,
    CDD:`<span class="pill p-amber" style="font-size:10px">CDD</span>`,
    Stage:`<span class="pill p-blue" style="font-size:10px">Stage</span>`,
    Freelance:`<span class="pill p-mag" style="font-size:10px">Freelance</span>`
  };

  $("#pg-title").textContent="Ressources Humaines";
  $("#pg-sub").textContent=`${actifs.length} employé(s) actif(s) — Masse salariale : ${fmt(masseSal)}/mois`;
  $("#pg-actions").innerHTML=`
    <button class="btn" onclick="exportCrhExcel()" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
    ${wr("crh")?`
    <button class="btn" onclick="openConge()">+ Congé / Absence</button>
    <button class="btn btn-primary" onclick="openEmploye()">+ Ajouter employé</button>`:""}
  `;

  $("#view").innerHTML=`
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">Effectif actif</div>
      <div class="val">${actifs.length}</div>
      <div class="delta">${DB.employes.length} au total</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">Masse salariale brute</div>
      <div class="val tabnum">${fmt(masseSal)}/mois</div>
      <div class="delta">Annuel : ${fmt(masseSal*12)}</div></div>
    <div class="card kpi c-jaune"><span class="tick"></span>
      <div class="lab">CNPS patronal (18.25%)</div>
      <div class="val tabnum">${fmt(cnpsPatr)}/mois</div>
      <div class="delta">Salarial 3.6% : ${fmt(cnpsSal)}</div></div>
    <div class="card kpi c-noir"><span class="tick"></span>
      <div class="lab">Coût total employeur</div>
      <div class="val tabnum">${fmt(masseSal+cnpsPatr)}/mois</div>
      <div class="delta">Salaire + charges patronales</div></div>
  </div>

  <div class="two-13" style="margin-bottom:14px">
    <div class="card panel">
      <div class="panel-h"><h3>👥 Équipe</h3><div class="spacer"></div>
        <select id="fil-emp-dep" onchange="renderEmpList()" style="width:160px"><option value="">Tous départements</option>
        ${[...new Set(DB.employes.map(e=>e.departement).filter(Boolean))].map(d=>`<option>${d}</option>`).join("")}
        </select>
      </div>
      <div id="emp-list"></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card panel">
        <div class="panel-h"><h3>📊 Répartition</h3></div>
        ${["CDI","CDD","Stage","Freelance"].map(t=>{
          const n=DB.employes.filter(e=>e.type_contrat===t).length;
          return n?`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--ligne)">
            ${ctrPill[t]||t} <strong>${n} personne${n>1?"s":""}</strong></div>`:"";
        }).join("")}
      </div>
      <div class="card panel">
        <div class="panel-h"><h3>🏖️ Congés en cours</h3><div class="spacer"></div>
          ${wr("crh")?`<button class="btn btn-sm" onclick="openConge()">+ Congé</button>`:""}
        </div>
        ${(DB.conges||[]).filter(c=>c.statut!=="refuse"&&new Date(c.date_fin)>=new Date()).slice(0,5)
          .map(c=>{const e=DB.employes.find(x=>x.id===c.employe_id)||{};
          return`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--ligne);font-size:12px">
            <span><strong>${esc(e.nom||"")} ${esc(e.prenom||"")}</strong> — ${esc(c.type_conge||"")}</span>
            <span class="meta">${new Date(c.date_debut).toLocaleDateString("fr-FR")} → ${new Date(c.date_fin).toLocaleDateString("fr-FR")}</span>
          </div>`;}).join("") || `<div class="meta" style="padding:8px 0">Aucun congé en cours</div>`}
      </div>
      <div class="card panel">
        <div class="panel-h"><h3>📋 CNPS / Charges sociales</h3></div>
        <div style="font-size:11px;color:var(--txt-2);line-height:2">
          <div style="display:flex;justify-content:space-between"><span>Part patronale (18.25%)</span><strong>${fmt(cnpsPatr)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Part salariale (3.6%)</span><strong>${fmt(cnpsSal)}</strong></div>
          <div style="display:flex;justify-content:space-between;padding-top:5px;border-top:1px solid var(--ligne);"><span>Total charges</span><strong>${fmt(cnpsPatr+cnpsSal)}</strong></div>
        </div>
        <div style="margin-top:8px;padding:6px 10px;background:#FFF3CD;border-radius:6px;font-size:10.5px;color:#856404">
          Taux CNPS CI : Patronal 18.25% — Salarial 3.6% (sur salaire brut)
        </div>
      </div>
    </div>
  </div>`;
  renderEmpList();
}

function renderEmpList(){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const dep=document.getElementById("fil-emp-dep")?.value||"";
  const stPill={actif:`<span class="pill p-green"><span class="dot"></span>Actif</span>`,
    conge:`<span class="pill p-amber"><span class="dot"></span>Congé</span>`,
    inactif:`<span class="pill p-grey"><span class="dot"></span>Inactif</span>`};
  const rows=DB.employes.filter(e=>!dep||e.departement===dep)
    .sort((a,b)=>(a.nom||"").localeCompare(b.nom||""));
  const el=document.getElementById("emp-list");if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty">Aucun employé enregistré<br><span class="meta">Ajoutez votre équipe via le bouton ci-dessus</span></div>`;return;}
  el.innerHTML=`<table><thead><tr>
    <th>Nom & Prénom</th><th>Poste</th><th>Département</th><th>Contrat</th>
    <th class="r">Salaire brut</th><th>Statut</th><th>CNPS</th><th></th>
  </tr></thead><tbody>
  ${rows.map(e=>`<tr>
    <td><div class="nm">${esc(e.nom||"")} ${esc(e.prenom||"")}</div><div class="meta">${esc(e.email||e.tel||"")}</div></td>
    <td>${esc(e.poste||"—")}</td>
    <td class="meta">${esc(e.departement||"—")}</td>
    <td><span class="pill p-cyan" style="font-size:10px">${esc(e.type_contrat||"CDI")}</span></td>
    <td class="r tabnum"><strong>${fmt(e.salaire_brut)}</strong></td>
    <td>${stPill[e.statut]||`<span class="pill p-grey">${esc(e.statut||"")}</span>`}</td>
    <td class="meta">${esc(e.cnps_number||"—")}</td>
    <td>${wr("crh")?`<button class="btn btn-sm btn-ghost" onclick="openEmploye('${e.id}')">✏️</button> <button class="btn btn-sm btn-ghost" onclick="delEmploye('${e.id}')">🗑</button>`:""}</td>
  </tr>`).join("")}
  </tbody></table>`;
}

function openEmploye(id){
  if(!wr("crh"))return;
  const e=id?DB.employes.find(x=>x.id===id)||{}:{};
  modal(`<h2>${id?"Modifier":"Ajouter"} un employé</h2>
  <div class="two">
    <div class="field"><label>Nom *</label><input id="emp-nom" value="${esc(e.nom||"")}"></div>
    <div class="field"><label>Prénom *</label><input id="emp-prenom" value="${esc(e.prenom||"")}"></div>
  </div>
  <div class="two">
    <div class="field"><label>Poste / Fonction</label><input id="emp-poste" value="${esc(e.poste||"")}"></div>
    <div class="field"><label>Département</label>
      <input id="emp-dep" list="dep-list" value="${esc(e.departement||"")}">
      <datalist id="dep-list"><option>Direction</option><option>Commercial</option><option>Production</option><option>Comptabilité</option><option>Logistique</option></datalist>
    </div>
  </div>
  <div class="two">
    <div class="field"><label>Type de contrat</label>
      <select id="emp-ctr"><option ${(e.type_contrat||"CDI")==="CDI"?"selected":""}>CDI</option><option ${e.type_contrat==="CDD"?"selected":""}>CDD</option><option ${e.type_contrat==="Stage"?"selected":""}>Stage</option><option ${e.type_contrat==="Freelance"?"selected":""}>Freelance</option></select>
    </div>
    <div class="field"><label>Date d'embauche</label><input id="emp-date" type="date" value="${e.date_embauche||""}"></div>
  </div>
  <div class="two">
    <div class="field"><label>Salaire brut (F CFA/mois)</label><input id="emp-sal" type="number" step="1000" value="${e.salaire_brut||0}"></div>
    <div class="field"><label>Statut</label>
      <select id="emp-st"><option value="actif" ${(e.statut||"actif")==="actif"?"selected":""}>Actif</option><option value="conge" ${e.statut==="conge"?"selected":""}>En congé</option><option value="inactif" ${e.statut==="inactif"?"selected":""}>Inactif</option></select>
    </div>
  </div>
  <div class="two">
    <div class="field"><label>Email</label><input id="emp-email" type="email" value="${esc(e.email||"")}"></div>
    <div class="field"><label>Téléphone</label><input id="emp-tel" value="${esc(e.tel||"")}"></div>
  </div>
  <div class="two">
    <div class="field"><label>N° CNPS</label><input id="emp-cnps" value="${esc(e.cnps_number||"")}"></div>
    <div class="field"><label>RIB / Banque</label><input id="emp-rib" value="${esc(e.rib||"")}"></div>
  </div>
  <div class="field"><label>Notes</label><textarea id="emp-notes" rows="2">${esc(e.notes||"")}</textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveEmploye('${id||""}')">Enregistrer</button>
  </div>`);
}

async function saveEmploye(id){
  const gv = sid => document.getElementById(sid)?.value?.trim()||"";
  const rec={
    nom:           gv("emp-nom"),
    prenom:        gv("emp-prenom"),
    poste:         gv("emp-poste"),
    departement:   gv("emp-dep"),
    type_contrat:  gv("emp-ctr"),
    date_embauche: document.getElementById("emp-date").value||null,
    salaire_brut:  +document.getElementById("emp-sal").value||0,
    statut:        gv("emp-st"),
    email:         gv("emp-email"),
    tel:           gv("emp-tel"),
    cnps_number:   gv("emp-cnps"),
    rib:           gv("emp-rib"),
    notes:         document.getElementById("emp-notes")?.value?.trim()||"",
  };
  if(!rec.nom||!rec.prenom){toast("Nom et prénom requis");return;}
  const obj = id ? {id,...rec} : {...rec, id:crypto.randomUUID()};
  const ok = await dbUpsert("crm_employes", obj);
  if(!ok) return;
  if(id){ const i=DB.employes.findIndex(x=>x.id===id); if(i>=0) DB.employes[i]=obj; }
  else   { DB.employes.push(obj); }
  toast(id?"Employé modifié":"Employé ajouté");
  closeOverlays(); go("crh");
}

async function delEmploye(id){
  if(!confirm("Supprimer cet employé ?"))return;
  await dbDelete("crm_employes",id);
  DB.employes = DB.employes.filter(x=>x.id!==id);
  toast("Employé supprimé"); go("crh");
}

function openConge(id){
  if(!wr("crh"))return;
  const c=id?DB.conges.find(x=>x.id===id)||{}:{};
  const empOpts=DB.employes.map(e=>`<option value="${e.id}" ${c.employe_id===e.id?"selected":""}>${esc(e.nom||"")} ${esc(e.prenom||"")}</option>`).join("");
  modal(`<h2>${id?"Modifier":"Nouveau"} congé / absence</h2>
  <div class="field"><label>Employé *</label><select id="cg-emp"><option value="">-- Choisir --</option>${empOpts}</select></div>
  <div class="two">
    <div class="field"><label>Type</label>
      <select id="cg-type"><option value="conge_paye" ${(c.type_conge||"conge_paye")==="conge_paye"?"selected":""}>Congé payé</option><option value="maladie" ${c.type_conge==="maladie"?"selected":""}>Maladie</option><option value="sans_solde" ${c.type_conge==="sans_solde"?"selected":""}>Sans solde</option><option value="maternite" ${c.type_conge==="maternite"?"selected":""}>Maternité</option></select>
    </div>
    <div class="field"><label>Statut</label>
      <select id="cg-st"><option value="en_attente" ${(c.statut||"en_attente")==="en_attente"?"selected":""}>En attente</option><option value="approuve" ${c.statut==="approuve"?"selected":""}>Approuvé</option><option value="refuse" ${c.statut==="refuse"?"selected":""}>Refusé</option></select>
    </div>
  </div>
  <div class="two">
    <div class="field"><label>Début</label><input id="cg-deb" type="date" value="${c.date_debut||todayISO()}"></div>
    <div class="field"><label>Fin</label><input id="cg-fin" type="date" value="${c.date_fin||todayISO()}"></div>
  </div>
  <div class="field"><label>Motif</label><input id="cg-motif" value="${esc(c.motif||"")}"></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveConge('${id||""}')">Enregistrer</button>
  </div>`);
}

async function saveConge(id){
  const emp=document.getElementById("cg-emp").value;
  if(!emp){toast("Sélectionnez un employé");return;}
  const rec={employe_id:emp,type_conge:document.getElementById("cg-type").value,
    statut:document.getElementById("cg-st").value,
    date_debut:document.getElementById("cg-deb").value,
    date_fin:document.getElementById("cg-fin").value,
    motif:document.getElementById("cg-motif")?.value?.trim()||""};
  const obj = id ? {id,...rec} : {...rec, id:crypto.randomUUID()};
  const ok = await dbUpsert("crm_conges", obj);
  if(!ok) return;
  if(id){ const i=DB.conges.findIndex(x=>x.id===id); if(i>=0) DB.conges[i]=obj; }
  else   { DB.conges.push(obj); }
  toast(id?"Congé modifié":"Congé enregistré");
  closeOverlays(); go("crh");
}

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
  parametres:{t:"Paramètres",render:viewParamètres},
  fournisseurs:{t:"Fournisseurs",render:viewFournisseurs},
  fiscalite:{t:"Fiscalité & Obligations",render:viewFiscalite},
  depenses:{t:"Dépenses",render:viewDepenses},
  crh:{t:"Ressources Humaines",render:viewCrh},
  entrepot:{t:"Entrepôt & Stock",render:viewEntrepot},
  caisses:{t:"Caisses & Trésorerie",render:viewCaisses},
  infographistes:{t:"Suivi infographistes",render:viewInfographistes},
  production:{t:"Atelier & Production",render:viewProduction},
};
function go(route){
  if(!USER)return;
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
  $("#pg-sub").textContent=(DB.settings?.company?.name||"Creatis Studio")+" — "+new Date().toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
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
  $("#pg-actions").innerHTML=`<input id="srch-clients" placeholder="🔍 Rechercher..." oninput="renderClientList()" style="padding:8px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:200px;font-size:13px"><select id="fil-client-type" onchange="renderClientList()" style="padding:8px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);font-size:13px"><option value="">Tous</option><option value="client">Clients</option><option value="prospect">Prospects</option></select><button class="btn" onclick="exportExcel('clients')" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button><button class="btn btn-primary act-edit" onclick="editClient()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau contact</button>`;
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
    kv("Type",pill(c.type))+kv("Segment",c.segment)+kv("Téléphone",c.tel)+kv("Email",c.email)+(c.ncc?kv("NCC",c.ncc):"")+kv("Régime",c.regime||"—")+kv("Adresse",c.adresse)+kv("Source",c.source)+kv("Notes",c.notes)+
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
    <div class="row2">
      <div class="field"><label>NCC / IFU (DGI)</label><input name="ncc" placeholder="ex: 6104401U" value="${esc(c.ncc||"")}"></div>
      <div class="field"><label>Régime fiscal</label><select name="regime"><option value="">—</option>${["RSI","RNI","RSIMF","Exonéré"].map(r=>`<option value="${r}" ${(c.regime||"")==r?"selected":""}>${r}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label>Adresse</label><input name="adresse" value="${esc(c.adresse||"")}"></div>
    <div class="field"><label>Source</label><select name="source">${sources.map(s=>`<option ${c.source===s?"selected":""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(c.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delClient('${id}')`}:null,{label:id?"💾 Enregistrer":"Créer",cls:"btn-primary",fn:`saveClient('${id||""}')`}].filter(Boolean)
  );
}
function saveClient(id){
  if(!guard("clients"))return;
  const f=$("#f-client");const fd=new FormData(f);
  const nom=fd.get("nom")||"";if(!nom.trim()){toast("Nom obligatoire");return}
  if(id){const c=DB.clients.find(x=>x.id===id);Object.assign(c,{nom:nom.trim(),contact:fd.get("contact"),segment:fd.get("segment"),type:fd.get("type"),tel:fd.get("tel"),email:fd.get("email"),adresse:fd.get("adresse"),source:fd.get("source"),notes:fd.get("notes"),ncc:fd.get("ncc")||"",regime:fd.get("regime")||""});sync("clients",c);}
  else{const c={id:uid(),nom:nom.trim(),contact:fd.get("contact"),segment:fd.get("segment"),type:fd.get("type"),tel:fd.get("tel"),email:fd.get("email"),adresse:fd.get("adresse"),source:fd.get("source"),notes:fd.get("notes"),ncc:fd.get("ncc")||"",regime:fd.get("regime")||"",createdAt:Date.now()};DB.clients.push(c);sync("clients",c);}
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
  const isF=kind==="factures";
  window._docFil=window._docFil||{};
  window._docFil[kind]=window._docFil[kind]||{statut:"",q:""};
  $("#pg-actions").innerHTML=`
    <input id="doc-srch-${kind}" placeholder="🔍 Client, numéro…" value="${window._docFil[kind].q||""}"
      oninput="window._docFil['${kind}'].q=this.value;renderDocList('${kind}')"
      style="padding:8px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:200px;font-size:13px">
    <button class="btn" onclick="exportExcel('${kind}')" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
    ${wr(kind)?`<button class="btn btn-primary act-edit" onclick="editDoc('${kind}')">＋ ${isF?"Nouvelle facture":"Nouveau devis"}</button>`:""}
  `;
  renderDocList(kind);
}

function renderDocList(kind){
  const isF=kind==="factures";
  const all=DB[kind]||[];
  const fil=(window._docFil&&window._docFil[kind])||{statut:"",q:""};
  const today=new Date().toISOString().slice(0,10);

  // KPIs
  const totalTTC=all.reduce((s,d)=>s+(d.montantTTC||0),0);
  const impaye=isF?all.filter(f=>factStatut(f)!=="payée").reduce((s,f)=>s+(f.montantTTC-factPaid(f)),0):0;
  const enAttente=isF?all.filter(f=>factStatut(f)==="impayée").length:all.filter(d=>d.statut==="envoyé").length;
  const enRetard=isF?all.filter(f=>{const e=f.echeance;return e&&e<today&&factStatut(f)!=="payée";}).length:0;

  // Tabs statuts
  const statuts=isF?
    [["","Tous"],["impayée","Impayée"],["partielle","Partielle"],["payée","Payée"],["annulé","Annulée"]]:
    [["","Tous"],["brouillon","Brouillon"],["envoyé","Envoyé"],["accepté","Accepté"],["refusé","Refusé"],["facturée","Facturée"]];

  // Filtrer + trier
  let list=all;
  if(fil.statut)list=list.filter(d=>isF?factStatut(d)===fil.statut:d.statut===fil.statut);
  if(fil.q){const q=fil.q.toLowerCase();list=list.filter(d=>(d.numero||"").toLowerCase().includes(q)||(clientName(d.clientId)||"").toLowerCase().includes(q)||(d.objet||"").toLowerCase().includes(q));}
  list=[...list].sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));

  // HTML KPIs
  let kpiHtml="<div style='display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px'>";
  kpiHtml+="<div class='card kpi c-cyan' style='padding:14px 16px'><div class='lab'>"+(isF?"Total facturé":"Total devis")+"</div><div class='val tabnum' style='font-size:22px'>"+fcfa(totalTTC)+"</div><div class='delta'>"+all.length+" document(s)</div></div>";
  if(isF){
    kpiHtml+="<div class='card kpi c-mag' style='padding:14px 16px'><div class='lab'>Reste à encaisser</div><div class='val tabnum' style='font-size:22px'>"+fcfa(impaye)+"</div><div class='delta'>"+enAttente+" facture(s) impayée(s)</div></div>";
    kpiHtml+="<div class='card kpi "+(enRetard>0?"c-mag":"c-noir")+"' style='padding:14px 16px'><div class='lab'>En retard</div><div class='val tabnum' style='font-size:22px'>"+enRetard+"</div><div class='delta'>échéance(s) dépassée(s)</div></div>";
  } else {
    kpiHtml+="<div class='card kpi c-jaune' style='padding:14px 16px'><div class='lab'>En attente réponse</div><div class='val tabnum' style='font-size:22px'>"+enAttente+"</div><div class='delta'>devis envoyé(s)</div></div>";
  }
  kpiHtml+="</div>";

  // HTML Tabs
  let tabsHtml="<div style='display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px'>";
  statuts.forEach(function(sv){
    const v=sv[0],l=sv[1];
    const active=fil.statut===v;
    tabsHtml+="<button onclick=\"window._docFil['"+kind+"'].statut='"+v+"';renderDocList('"+kind+"')\" style='padding:5px 14px;border-radius:20px;border:1.5px solid "+(active?"var(--cyan)":"var(--ligne)")+";background:"+(active?"var(--cyan)":"var(--carte)")+";color:"+(active?"#fff":"var(--txt-2)")+";font-size:12px;font-weight:600;cursor:pointer'>"+l+"</button>";
  });
  tabsHtml+="</div>";

  // HTML Table
  let tableHtml="";
  if(!list.length){
    tableHtml="<div style='padding:40px;text-align:center;color:var(--txt-3)'>Aucun résultat pour ce filtre</div>";
  } else {
    tableHtml="<div style='overflow-x:auto'><table><thead><tr><th>Numéro</th><th>Objet</th><th>Client</th><th>Date</th><th>"+(isF?"Échéance":"Validité")+"</th><th class='r'>Total TTC</th><th>Statut</th>"+(isF?"<th>FNE</th>":"")+"<th></th></tr></thead><tbody>";
    list.forEach(function(d){
      const st=isF?factStatut(d):d.statut;
      const dateCol=isF?d.echeance:d.validite;
      const retard=isF&&d.echeance&&d.echeance<today&&st!=="payée";
      const opener=isF?"openFacture":"openDevis";
      let tr="<tr class='clk' onclick=\""+opener+"('"+d.id+"')\">";
      tr+="<td><div class='nm tabnum'>"+esc(d.numero)+"</div></td>";
      tr+="<td class='meta' style='max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>"+esc(d.objet||"")+"</td>";
      tr+="<td class='meta'>"+esc(clientName(d.clientId))+"</td>";
      tr+="<td class='meta'>"+fdate(d.date)+"</td>";
      tr+="<td class='meta' style='color:"+(retard?"var(--danger)":"")+"'>"+fdate(dateCol)+(retard?" ⚠️":"")+"</td>";
      tr+="<td class='r tabnum'>"+fcfa(d.montantTTC)+"</td>";
      tr+="<td>"+pill(st)+"</td>";
      if(isF) tr+="<td style='font-size:10px'>"+fneBadge(d)+"</td>";
      tr+="<td class='r' onclick='event.stopPropagation()'>";
      if(wr(kind)){
        tr+="<button class='btn btn-sm btn-ghost act-edit' onclick=\"editDoc('"+kind+"','"+d.id+"')\">✏️</button> ";
        tr+="<button class='btn btn-sm btn-ghost' title='Dupliquer' onclick=\"dupliquerDoc('"+kind+"','"+d.id+"')\">⧉</button>";
      }
      tr+="</td></tr>";
      tableHtml+=tr;
    });
    tableHtml+="</tbody></table></div>";
  }

  const el=document.getElementById("view");
  if(el) el.innerHTML=kpiHtml+tabsHtml+tableHtml;
}

function openDevis(id){
  if(!vis("devis"))return;
  const d=DB.devis.find(x=>x.id===id);if(!d)return;
  const st=d.statut;
  drawer(d.numero,clientName(d.clientId),docView(d,"devis"),
    [
     wr("devis")&&st==="brouillon"?{label:"📤 Marquer envoyé",cls:"btn",fn:`setDevisStatut('${id}','envoyé')`}:null,
     wr("devis")&&st==="envoyé"?{label:"✅ Accepté",cls:"btn",fn:`setDevisStatut('${id}','accepté')`}:null,
     wr("devis")&&st==="envoyé"?{label:"❌ Refusé",cls:"btn",fn:`setDevisStatut('${id}','refusé')`}:null,
     wr("devis")&&(st==="accepté"||st==="envoyé")?{label:"→ Facturer",cls:"btn-mag",fn:`devisToFacture('${id}')`}:null,
     {label:"🖨️ Imprimer",cls:"btn-ghost",fn:`printDoc('devis','${id}')`},
     {label:"📧 Envoyer",cls:"btn",fn:`openEmailDoc('devis','${id}')`},
     wr("devis")?{label:"⧉ Dupliquer",cls:"btn",fn:`dupliquerDoc('devis','${id}')`}:null,
     wr("devis")?{label:"✏️ Modifier",cls:"btn",fn:`closeOverlays();editDoc('devis','${id}')`}:null
    ].filter(Boolean));
}
function openFacture(id){
  if(!vis("factures"))return;
  const f=DB.factures.find(x=>x.id===id);if(!f)return;
  const st=factStatut(f);
  const paid=factPaid(f);
  const now=new Date().toISOString().slice(0,10);
  const retard=f.echeance&&f.echeance<now&&st!=="payée";
  drawer(f.numero,clientName(f.clientId),docView(f,"factures"),
    [
     wr("factures")&&st!=="payée"&&st!=="annulé"?{label:"💳 Enregistrer paiement",cls:"btn-mag",fn:`payModal('${id}')`}:null,
     wr("factures")&&retard&&st!=="annulé"?{label:"🔔 Relancer",cls:"btn",fn:`openRelanceEmail('${id}')`}:null,
     wr("factures")&&(f.fneStatus||f.fne_status)!=="certifiee"&&st!=="annulé"?{label:"🔒 Certifier FNE",cls:"btn",fn:`certifierFNE('${id}')`}:null,
     {label:"🖨️ Imprimer",cls:"btn-ghost",fn:`printDoc('factures','${id}')`},
     {label:"📧 Envoyer",cls:"btn",fn:`openEmailDoc('factures','${id}')`},
     wr("factures")?{label:"⧉ Dupliquer",cls:"btn",fn:`dupliquerDoc('factures','${id}')`}:null,
     wr("factures")?{label:"✏️ Modifier",cls:"btn",fn:`closeOverlays();editDoc('factures','${id}')`}:null,
     wr("factures")&&st!=="payée"&&st!=="annulé"?{label:"Annuler la facture",cls:"btn-danger",fn:`annulerDoc('factures','${id}')`}:null
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
    [{label:"Annuler",fn:"closeModal()"},{label:"💾 Enregistrer",cls:"btn-primary",fn:`doPay('${id}')`}]);
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
  const doc=existing||{clientId:"",date:todayISO(),objet:"",lignes:[{reference:"",designation:"",unite:"U",qte:1,pu:0,remise:0}],tva:DB.settings.tva||18,notes:"",...(isF?{echeance:"",paiements:[],statut:"impayée"}:{validite:"",statut:"brouillon"})};
  window._editing={kind,id:id||null,doc};
  const clientOpts=DB.clients.map(c=>`<option value="${c.id}" ${doc.clientId===c.id?"selected":""}>${esc(c.nom)}</option>`).join("");
  const lignesHTML=buildLignesHTML(doc.lignes);
  const totals=calcLignes(doc.lignes,doc.tva);
  drawer(id?(isF?"Facture "+existing.numero:"Devis "+existing.numero):(isF?"Nouvelle facture":"Nouveau devis"),"",
    `<form id="f-doc">
    <div class="row2">
      <div class="field"><label>Client *</label><select name="clientId" onchange="showClientInfo(this.value)"><option value="">— Choisir —</option>${clientOpts}</select></div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${doc.date||todayISO()}"></div>
    </div>
    <div id="cli-info" style="margin:-6px 0 10px;font-size:12px;color:var(--txt-2)"></div>
    <div class="row2">
      <div class="field"><label>${isF?"Échéance paiement":"Validité du devis"}</label><input name="${isF?"echeance":"validite"}" type="date" value="${isF?(doc.echeance||""):(doc.validite||"")}"></div>
      <div class="field"><label>TVA %</label><input name="tva" type="number" value="${doc.tva}" min="0" style="width:80px" onchange="updTva(+this.value)"></div>
    </div>
    <div class="field"><label>Objet / Titre</label><input name="objet" value="${esc(doc.objet||"")}" placeholder="ex: Impression flyers A5 — 500 ex."></div>
    <div class="fieldset" style="margin-top:10px">
      <div class="fs-t" style="display:flex;align-items:center;justify-content:space-between">
        Lignes
        <button type="button" class="btn btn-sm" onclick="openCataloguePicker()" style="font-size:11px">📦 Depuis catalogue</button>
      </div>
      <div style="overflow-x:auto"><table id="t-lignes">
        <thead><tr><th style="width:80px">Réf.</th><th>Désignation</th><th style="width:65px">Unité</th><th style="width:56px">Qté</th><th style="width:90px">PU HT</th><th style="width:55px">Rem%</th><th style="width:90px" class="r">Total HT</th><th style="width:48px"></th></tr></thead>
        <tbody id="lignes-body">${lignesHTML}</tbody>
      </table></div>
      <button type="button" class="btn btn-sm" style="margin-top:8px" onclick="addLigne()">+ Ligne vide</button>
    </div>
    <div class="kv-block" id="doc-totals" style="margin-top:12px">${docTotalsHTML(totals,doc.tva)}</div>
    <div class="field"><label>Notes / Conditions</label><textarea name="notes">${esc(doc.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delDoc('${kind}','${id}')`}:null,
     id?{label:"⧉ Dupliquer",cls:"btn",fn:`dupliquerDoc('${kind}','${id}')`}:null,
     {label:id?"💾 Enregistrer":(isF?"Créer la facture":"Créer le devis"),cls:"btn-primary",fn:`saveDoc()`}
    ].filter(Boolean)
  );
  showClientInfo(doc.clientId);
}

function buildLignesHTML(lignes){
  const UNITES=["U","M²","ML","M³","Kg","L","H","Fft","Pcs","Ex.","Lot"];
  return (lignes||[]).map((l,i)=>{
    const unitOpts=UNITES.map(u=>`<option value="${u}" ${(l.unite||"U")===u?"selected":""}>${u}</option>`).join("");
    return `<tr>
      <td><input style="width:78px;font-family:monospace;font-size:11px" value="${esc(l.reference||"")}" placeholder="Réf" onchange="updLigne(${i},'reference',this.value)"></td>
      <td><input style="width:100%" value="${esc(l.designation)}" placeholder="Désignation *" onchange="updLigne(${i},'designation',this.value)"></td>
      <td><select style="width:63px;font-size:11px" onchange="updLigne(${i},'unite',this.value)">${unitOpts}</select></td>
      <td><input type="number" value="${l.qte}" min="0" style="width:54px" onchange="updLigne(${i},'qte',+this.value)"></td>
      <td><input type="number" value="${l.pu}" min="0" style="width:88px" onchange="updLigne(${i},'pu',+this.value)"></td>
      <td><input type="number" value="${l.remise||0}" min="0" max="100" style="width:53px" onchange="updLigne(${i},'remise',+this.value)"></td>
      <td class="tabnum r" style="font-size:12px">${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</td>
      <td><button type="button" class="btn btn-sm btn-ghost" onclick="delLigne(${i})" style="padding:4px 7px">✕</button></td>
    </tr>`;
  }).join("");
}

function showClientInfo(clientId){
  const cli=(DB.clients||[]).find(c=>c.id===clientId);
  const el=document.getElementById("cli-info");
  if(!el)return;
  if(!cli){el.textContent="";return;}
  const parts=[cli.adresse,cli.ncc?"NCC "+cli.ncc:"",cli.tel].filter(Boolean);
  el.textContent=parts.join(" · ");
}

function openCataloguePicker(){
  const prods=(DB.products||[]).filter(p=>p.designation);
  if(!prods.length){toast("Catalogue vide — ajoutez des produits d'abord");return;}
  modal(`<h2>📦 Choisir depuis le catalogue</h2>
    <input id="cat-srch" placeholder="🔍 Rechercher…" oninput="filterCatPicker()" style="width:100%;padding:8px 12px;margin:8px 0;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1)">
    <div id="cat-list" style="max-height:320px;overflow-y:auto">
      ${prods.map(p=>`<div class="clk" onclick="insertLigneFromProd('${p.id}')"
        style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;margin-bottom:3px;cursor:pointer;hover:background:var(--papier)">
        <div>
          <div style="font-weight:600;font-size:13px">${esc(p.designation)}</div>
          <div style="font-size:11px;color:var(--txt-2)">${esc(p.reference||"")} ${p.unite?("· "+p.unite):""}</div>
        </div>
        <div class="tabnum" style="font-size:13px;font-weight:600;color:var(--cyan)">${fcfa(p.prixVente||p.prix_vente||p.pu||0)}</div>
      </div>`).join("")}
    </div>`,
    [{l:"Fermer",c:"closeModal()"}]);
}

function filterCatPicker(){
  const q=(document.getElementById("cat-srch")?.value||"").toLowerCase();
  document.querySelectorAll("#cat-list .clk").forEach(el=>{
    el.style.display=el.textContent.toLowerCase().includes(q)?"":"none";
  });
}

function insertLigneFromProd(prodId){
  const p=(DB.products||[]).find(x=>x.id===prodId);
  if(!p||!window._editing)return;
  const ligne={
    reference:p.reference||p.ref||"",
    designation:p.designation||p.nom||"",
    unite:p.unite||"U",
    qte:1,
    pu:p.prixVente||p.prix_vente||p.pu||p.prixHT||0,
    remise:0
  };
  window._editing.doc.lignes.push(ligne);
  const i=window._editing.doc.lignes.length-1;
  const tbody=document.getElementById("lignes-body");
  if(tbody){
    const tmp=document.createElement("tbody");
    tmp.innerHTML=buildLignesHTML([ligne]).replace(/updLigne\(0,/g,`updLigne(${i},`).replace(/delLigne\(0\)/g,`delLigne(${i})`);
    while(tmp.firstChild) tbody.appendChild(tmp.firstChild);
  }
  const t=calcLignes(window._editing.doc.lignes,window._editing.doc.tva);
  const td=document.getElementById("doc-totals");
  if(td)td.innerHTML=docTotalsHTML(t,window._editing.doc.tva);
  closeModal();
  toast(p.designation+" ajouté ✓");
}
function docTotalsHTML(t,tva){return`${kv("Montant HT",fcfa(t.montantHT))}${kv("TVA "+tva+"%",fcfa(t.montantTVA))}${kv("<strong>Total TTC</strong>","<strong class='tabnum'>"+fcfa(t.montantTTC)+"</strong>")}`}
function updLigne(i,k,v){const e=window._editing;e.doc.lignes[i][k]=v;const t=calcLignes(e.doc.lignes,e.doc.tva);$("#doc-totals").innerHTML=docTotalsHTML(t,e.doc.tva);const tds=[...document.querySelectorAll("#lignes-body tr")];if(tds[i]){const cells=[...tds[i].querySelectorAll("td")];const l=e.doc.lignes[i];if(cells[4])cells[4].textContent=fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}}
function updTva(v){const e=window._editing;e.doc.tva=v;const t=calcLignes(e.doc.lignes,v);$("#doc-totals").innerHTML=docTotalsHTML(t,v)}
function addLigne(){
  const e=window._editing;
  const newLigne={reference:"",designation:"",unite:"U",qte:1,pu:0,remise:0};
  e.doc.lignes.push(newLigne);
  const i=e.doc.lignes.length-1;
  const tbody=document.getElementById("lignes-body");
  if(tbody){
    const tmp=document.createElement("tbody");
    tmp.innerHTML=buildLignesHTML([newLigne]).replace(/updLigne\(0,/g,`updLigne(${i},`).replace(/delLigne\(0\)/g,`delLigne(${i})`);
    while(tmp.firstChild) tbody.appendChild(tmp.firstChild);
  }
}
function delLigne(i){const e=window._editing;e.doc.lignes.splice(i,1);editDoc(e.kind,e.id)}
function saveDoc(){
  const e=window._editing,isF=e.kind==="factures";
  if(!guard(e.kind))return;
  const f=$("#f-doc");const fd=new FormData(f);
  const totals=calcLignes(e.doc.lignes,e.doc.tva);
  if(e.id){
    const doc=DB[e.kind].find(x=>x.id===e.id);
    Object.assign(doc,{clientId:fd.get("clientId"),date:fd.get("date"),objet:fd.get("objet")||"",lignes:e.doc.lignes,tva:e.doc.tva,...totals,notes:fd.get("notes")});
    if(isF)doc.echeance=fd.get("echeance"); else doc.validite=fd.get("validite");
    sync(e.kind,doc);
  } else {
    const seq=isF?DB.settings.seqFacture:DB.settings.seqDevis;const year=DB.settings.year;
    const num=(isF?"FAC-":"DEV-")+year+"-"+String(seq).padStart(4,"0");
    const doc={id:uid(),numero:num,clientId:fd.get("clientId"),date:fd.get("date"),objet:fd.get("objet")||"",lignes:e.doc.lignes,tva:e.doc.tva,...totals,notes:fd.get("notes"),createdAt:Date.now()};
    if(isF){doc.echeance=fd.get("echeance");doc.paiements=[];doc.statut="impayée";DB.settings.seqFacture=seq+1}
    else{doc.validite=fd.get("validite");doc.statut="brouillon";DB.settings.seqDevis=seq+1}
    DB[e.kind].push(doc);sync(e.kind,doc);sync("settings",DB.settings);
  }
  closeOverlays();toast(e.id?"Enregistré":(isF?"Facture créée":"Devis créé"));refreshBadges();go(e.kind);
}
function delDoc(kind,id){if(!guard(kind))return;confirmModal("Supprimer ?"," ",()=>{DB[kind]=DB[kind].filter(x=>x.id!==id);syncDel(kind,id);closeOverlays();toast("Supprimé");refreshBadges();go(kind)})}

function dupliquerDoc(kind,id){
  if(!guard(kind))return;
  const src=DB[kind].find(x=>x.id===id);if(!src)return;
  const isF=kind==="factures";
  const seq=isF?DB.settings.seqFacture:DB.settings.seqDevis;
  const year=DB.settings.year;
  const num=(isF?"FAC-":"DEV-")+year+"-"+String(seq).padStart(4,"0");
  const doc={
    ...JSON.parse(JSON.stringify(src)),
    id:uid(),numero:num,date:todayISO(),
    statut:isF?"impayée":"brouillon",
    createdAt:Date.now()
  };
  if(isF){doc.echeance="";doc.paiements=[];doc.fneStatus=null;doc.fne_status=null;DB.settings.seqFacture=seq+1;}
  else{doc.validite="";DB.settings.seqDevis=seq+1;}
  DB[kind].push(doc);sync(kind,doc);sync("settings",DB.settings);
  closeOverlays();toast("Document dupliqué — "+num);refreshBadges();go(kind);
}

function annulerDoc(kind,id){
  if(!guard(kind))return;
  confirmModal("Annuler ce document ?","Cette action est irréversible.",()=>{
    const doc=DB[kind].find(x=>x.id===id);if(!doc)return;
    doc.statut="annulé";
    sync(kind,doc);closeOverlays();toast("Document annulé");refreshBadges();go(kind);
  });
}
function docView(doc,kind){
  const isF=kind==="factures";const tva=doc.tva||DB.settings.tva||18;
  const paid=isF?factPaid(doc):0;const st=isF?factStatut(doc):doc.statut;
  const reste=isF?Math.max(0,doc.montantTTC-paid):0;
  const pct=isF&&doc.montantTTC>0?Math.round((paid/doc.montantTTC)*100):0;
  const now=new Date().toISOString().slice(0,10);
  const retard=isF&&doc.echeance&&doc.echeance<now&&st!=="payée";
  const cli=(DB.clients||[]).find(c=>c.id===doc.clientId)||{};

  const payBar=isF?`<div style="margin:8px 0 12px">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--txt-2);margin-bottom:4px">
      <span>Encaissé : <strong>${fcfa(paid)}</strong></span>
      <span>Reste : <strong style="color:${reste>0?"var(--danger)":"var(--ok)"}">${fcfa(reste)}</strong></span>
    </div>
    <div style="height:6px;background:var(--ligne);border-radius:3px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:${pct>=100?"var(--ok)":"var(--cyan)"};border-radius:3px;transition:.3s"></div>
    </div>
    ${retard?`<div style="color:var(--danger);font-size:11px;margin-top:4px">⚠️ Échéance dépassée depuis le ${fdate(doc.echeance)}</div>`:""}
  </div>`:"";

  return`<div class="doc-view">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:12.5px">
      <div>${kv("Client","<strong>"+esc(clientName(doc.clientId))+"</strong>")}</div>
      <div>${kv("Statut",pill(st))}</div>
      ${doc.objet?`<div style="grid-column:1/-1">${kv("Objet",esc(doc.objet))}</div>`:""}
      <div>${kv("Date",fdate(doc.date))}</div>
      <div>${kv(isF?"Échéance":"Validité","<span style='color:"+(retard?"var(--danger)":"inherit")+"'>"+fdate(isF?doc.echeance:doc.validite)+"</span>")}</div>
      ${cli.adresse?`<div style="grid-column:1/-1;font-size:11px;color:var(--txt-2)">${esc(cli.adresse)}${cli.ncc?" · NCC "+cli.ncc:""}</div>`:""}
    </div>
    ${isF?payBar:""}
    <div style="overflow-x:auto;margin:8px 0">
      <table style="font-size:12px"><thead>
        <tr><th style="text-align:left">Réf.</th><th style="text-align:left">Désignation</th><th>Unité</th><th class="r">Qté</th><th class="r">PU HT</th><th class="r">Remise</th><th class="r">Total HT</th></tr>
      </thead><tbody>
      ${(doc.lignes||[]).map(l=>`<tr>
        <td style="font-family:monospace;font-size:11px;color:var(--txt-2)">${esc(l.reference||"")}</td>
        <td>${esc(l.designation)}</td>
        <td style="text-align:center;color:var(--txt-2)">${esc(l.unite||"U")}</td>
        <td class="r tabnum">${l.qte}</td>
        <td class="r tabnum">${fcfa(l.pu)}</td>
        <td class="r">${l.remise?l.remise+"%":"—"}</td>
        <td class="r tabnum"><strong>${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</strong></td>
      </tr>`).join("")}
      </tbody></table>
    </div>
    <div style="border-top:1px solid var(--ligne);padding-top:8px;margin-top:4px">
      ${kv("Montant HT",fcfa(doc.montantHT))}
      ${kv("TVA "+tva+"%",fcfa(doc.montantTVA))}
      ${kv("<strong>Total TTC</strong>","<strong class='tabnum' style='font-size:16px'>"+fcfa(doc.montantTTC)+"</strong>")}
    </div>
    ${isF&&(doc.paiements||[]).length?`<div class="fieldset" style="margin-top:12px">
      <div class="fs-t">Historique des paiements</div>
      ${doc.paiements.map(p=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--ligne-2)">
        <div style="font-size:12px">${fdate(p.date)}</div>
        <div style="font-size:11px;color:var(--txt-2)">${esc(p.mode||"")}</div>
        <div class="tabnum" style="font-weight:600">${fcfa(p.montant)}</div>
      </div>`).join("")}
    </div>`:""}
    ${doc.notes?`<div class="fieldset" style="margin-top:10px"><div class="fs-t">Notes / Conditions</div><div style="font-size:12px;white-space:pre-wrap">${esc(doc.notes)}</div></div>`:""}
  </div>`;
}
function printDoc(kind,id){
  const d=kind==="factures"?DB.factures.find(x=>x.id===id):DB.devis.find(x=>x.id===id);
  if(!d)return;
  const co=DB.settings.company||{};
  const isF=kind==="factures";
  const tva=d.tva||DB.settings.tva||18;
  const cli=DB.clients.find(x=>x.id===d.clientId)||{};
  const paid=isF?factPaid(d):0;
  const reste=Math.max(0,(d.montantTTC||0)-paid);
  const devise=DB.settings.devise||"F CFA";
  const type_label=isF?"Facture de vente":"Devis";
  const fmtDate=s=>s?new Date(s).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"})+" "+(s.length>10?new Date(s).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):""):"—";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");

  // Lignes
  const lignesHTML=(d.lignes||[]).map(l=>{
    const ht=Math.round((+l.qte||0)*(+l.pu||0)*(1-((+l.remise||0)/100)));
    return`<tr>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px">${esc(l.reference||"")}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px">${esc(l.designation||"")}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:right">${fmt(l.pu)}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:center">${l.qte}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:center">${esc(l.unite||"U")}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:center">TVAD (${tva})</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:center">${l.remise||0}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;font-size:11px;text-align:right;font-weight:600">${fmt(ht)}</td>
    </tr>`;
  }).join("");

  // Paiements reçus
  const paiementsHTML=isF&&d.paiements&&d.paiements.length?`
    <div style="margin-top:16px;border:1px solid #ccc;border-radius:4px;overflow:hidden">
      <div style="background:#1A1A1C;color:#fff;padding:6px 10px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Historique des paiements</div>
      <table style="width:100%;border-collapse:collapse">
        ${d.paiements.map(p=>`<tr>
          <td style="padding:5px 10px;border-bottom:1px solid #eee;font-size:11px">${fmtDate(p.date)}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #eee;font-size:11px">${esc(p.mode||"")}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #eee;font-size:11px;text-align:right;font-weight:700">${fmt(p.montant)}</td>
        </tr>`).join("")}
      </table>
    </div>`:"";

  const html=`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>${esc(d.numero||"")} — ${esc(co.name||"Creatis Studio")}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#1A1A1C;font-size:12px;background:#e8e8e8;padding:20px}
  .page{width:794px;background:#fff;margin:0 auto;padding:0;box-shadow:0 2px 20px rgba(0,0,0,.15)}
  table{border-collapse:collapse}
  @media print{body{background:#fff;padding:0}.page{box-shadow:none;width:100%}.no-print{display:none}@page{margin:8mm;size:A4}}
</style></head><body>
<div class="page">

  <!-- BANDE CMJN SUPÉRIEURE -->
  <div style="height:5px;display:flex">
    <div style="flex:1;background:#00AEEF"></div><div style="flex:1;background:#EC008C"></div>
    <div style="flex:1;background:#FFC400"></div><div style="flex:1;background:#1A1A1C"></div>
  </div>

  <div style="padding:20px 24px">

    <!-- BLOC VENDEUR (gauche) + FNE (droite) -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px">

      <!-- VENDEUR -->
      <div style="border:1.5px solid #1A1A1C;border-radius:4px;padding:10px 14px;min-width:240px;font-size:11px;line-height:1.9">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <<img src="data:image/png;base64,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" alt="Creatis Studio" style="width:50px;height:50px;object-fit:contain">
          <div>
            <div style="font-size:14px;font-weight:700;letter-spacing:.02em">${esc(co.name||"CREATIS STUDIO")}</div>
            <div style="font-size:9px;letter-spacing:.12em;color:#555;text-transform:uppercase">${esc(co.activite||"Création · Impression · Fournitures · Gadgets")}</div>
          </div>
        </div>
        <div><strong>NCC :</strong> ${esc(co.cc||"0811105V")}</div>
        <div><strong>Régime d'imposition :</strong> ${esc(co.regime||"Réel Simplifié")}</div>
        <div><strong>Centre des impôts :</strong> ${esc(co.centre||"II Plateaux 2")}</div>
        <div><strong>RCCM :</strong> ${esc(co.rc||"CI-ABJ-2007-B-3172")}</div>
        <div><strong>Références bancaires :</strong> ${esc(co.banque||"")}</div>
        <div><strong>Établissement :</strong> ${esc(co.name||"CREATIS STUDIO")}</div>
        <div><strong>Adresse :</strong> ${esc(co.siege||"Cocody Val Doyen 4 — Duplex Appt 135")}</div>
        <div><strong>N° Tel :</strong> ${esc(co.tel||"")} / ${esc(co.cel||"")}</div>
        <div><strong>Mail :</strong> ${esc(co.email||"infos@creatis-ci.com")}</div>
        <div style="margin-top:6px"><strong>Date et heure :</strong> ${fmtDate(d.date)}</div>
        <div><strong>Mode de paiement :</strong> Virement bancaire</div>
      </div>

      <!-- FNE -->
      <div style="text-align:right">
        <!-- QR Code placeholder -->
        <div style="display:flex;justify-content:flex-end;align-items:flex-start;gap:12px;margin-bottom:10px">
          <!-- QR code FNE (réel si certifiée, simulé sinon) -->
          <div style="width:80px;height:80px;border:2px solid ${d.fneQrUrl||d.fne_qr_url?"#00843D":"#1A1A1C"};display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
          ${d.fneQrUrl||d.fne_qr_url?`<img src="${d.fneQrUrl||d.fne_qr_url}" style="width:76px;height:76px;object-fit:contain" alt="QR FNE">`:`<svg width="70" height="70" viewBox="0 0 70 70" fill="none">
              <!-- Coins QR -->
              <rect x="4" y="4" width="20" height="20" rx="2" stroke="#1A1A1C" stroke-width="3" fill="none"/>
              <rect x="8" y="8" width="12" height="12" fill="#1A1A1C"/>
              <rect x="46" y="4" width="20" height="20" rx="2" stroke="#1A1A1C" stroke-width="3" fill="none"/>
              <rect x="50" y="8" width="12" height="12" fill="#1A1A1C"/>
              <rect x="4" y="46" width="20" height="20" rx="2" stroke="#1A1A1C" stroke-width="3" fill="none"/>
              <rect x="8" y="50" width="12" height="12" fill="#1A1A1C"/>
              <!-- Modules centraux -->
              <rect x="28" y="4" width="4" height="4" fill="#1A1A1C"/>
              <rect x="34" y="4" width="4" height="4" fill="#1A1A1C"/>
              <rect x="28" y="10" width="4" height="4" fill="#1A1A1C"/>
              <rect x="34" y="16" width="4" height="4" fill="#1A1A1C"/>
              <rect x="4" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="10" y="34" width="4" height="4" fill="#1A1A1C"/>
              <rect x="28" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="34" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="40" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="28" y="34" width="4" height="4" fill="#1A1A1C"/>
              <rect x="40" y="34" width="4" height="4" fill="#1A1A1C"/>
              <rect x="28" y="40" width="4" height="4" fill="#1A1A1C"/>
              <rect x="34" y="40" width="4" height="4" fill="#1A1A1C"/>
              <rect x="46" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="52" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="58" y="28" width="4" height="4" fill="#1A1A1C"/>
              <rect x="46" y="34" width="4" height="4" fill="#1A1A1C"/>
              <rect x="52" y="40" width="4" height="4" fill="#1A1A1C"/>
              <rect x="28" y="46" width="4" height="4" fill="#1A1A1C"/>
              <rect x="34" y="52" width="4" height="4" fill="#1A1A1C"/>
              <rect x="46" y="46" width="4" height="4" fill="#1A1A1C"/>
              <rect x="52" y="52" width="4" height="4" fill="#1A1A1C"/>
              <rect x="58" y="46" width="4" height="4" fill="#1A1A1C"/>
              <rect x="58" y="58" width="4" height="4" fill="#1A1A1C"/>
              <rect x="40" y="52" width="4" height="4" fill="#1A1A1C"/>
              <rect x="46" y="58" width="4" height="4" fill="#1A1A1C"/>
            </svg>`}
          </div>
          <!-- Logo FNE -->
          <div style="border:2px solid #1A1A1C;border-radius:4px;padding:4px 8px;width:90px;text-align:center">
            <div style="display:flex;justify-content:center;align-items:center;gap:2px;margin-bottom:4px">
              <div style="width:18px;height:18px;background:#00843D;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:11px">f</div>
              <div style="font-size:16px;font-weight:900;color:#003189">NE</div>
            </div>
            <div style="font-size:7px;font-weight:700;color:#1A1A1C;letter-spacing:.04em;text-transform:uppercase;border-top:1px solid #ccc;padding-top:3px;line-height:1.4">FACTURE<br>NORMALISÉE<br>ÉLECTRONIQUE</div>
          </div>
        </div>

        <!-- Numéro de facture + FNE -->
        <div style="font-size:14px;font-weight:700;color:#1A1A1C;margin-bottom:6px;text-align:right">
          ${type_label} N° ${esc(d.numero||"")}
        </div>
        ${(d.fneNumber||d.fne_number)?`<div style="font-size:10px;font-weight:700;color:#00843D;text-align:right;margin-bottom:8px;font-family:monospace">FNE : ${esc(d.fneNumber||d.fne_number)}</div>`:""}
        ${(d.fneCertifiedAt||d.fne_certified_at)?`<div style="font-size:9px;color:#777;text-align:right">Certifiée le ${new Date(d.fneCertifiedAt||d.fne_certified_at).toLocaleString("fr-FR")}</div>`:""}

        <!-- CLIENT -->
        <div style="border:1px solid #ccc;border-radius:4px;padding:10px 14px;text-align:left;min-width:220px;font-size:11px;line-height:1.9">
          <div style="font-weight:700;font-size:12px;margin-bottom:6px;border-bottom:1px solid #eee;padding-bottom:4px">Client</div>
          <div><strong>Nom :</strong> ${esc(cli.nom||clientName(d.clientId))}</div>
          ${cli.adresse?`<div><strong>Adresse :</strong> ${esc(cli.adresse)}</div>`:""}
          ${cli.email?`<div><strong>Mail :</strong> ${esc(cli.email)}</div>`:""}
          ${cli.tel?`<div><strong>N° Tel :</strong> ${esc(cli.tel)}</div>`:""}
          <div><strong>NCC :</strong> ${esc(cli.ncc||"—")}</div>
          <div><strong>Régime d'imposition :</strong> ${esc(cli.regime||"—")}</div>
        </div>
      </div>
    </div>

    <!-- TABLE DES PRESTATIONS -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:0">
      <thead>
        <tr style="background:#1A1A1C;color:#fff">
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:left;width:50px">Réf</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:left">Désignation</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:right;width:80px">P.U HT</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:center;width:50px">Qté</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:center;width:50px">Unité</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:center;width:80px">Taxes (%)</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:center;width:60px">Rem. (%)</th>
          <th style="border:1px solid #555;padding:7px 8px;font-size:11px;text-align:right;width:100px">Montant HT</th>
        </tr>
      </thead>
      <tbody>${lignesHTML}</tbody>
    </table>

    <!-- TOTAUX (alignés à droite comme le modèle) -->
    <table style="width:100%;border-collapse:collapse;border-top:none">
      <tr>
        <td style="border:1px solid #ccc;border-top:none;padding:6px 8px" colspan="6">&nbsp;</td>
        <td style="border:1px solid #ccc;border-top:none;padding:6px 10px;font-size:11px;font-weight:700;text-align:right;background:#f5f5f5">TOTAL HT</td>
        <td style="border:1px solid #ccc;border-top:none;padding:6px 10px;font-size:11px;font-weight:700;text-align:right;width:100px">${fmt(d.montantHT)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #ccc;padding:6px 8px" colspan="6">&nbsp;</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;font-weight:700;text-align:right;background:#f5f5f5">TVA</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">${fmt(d.montantTVA)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #ccc;padding:6px 8px" colspan="6">&nbsp;</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;font-weight:700;text-align:right;background:#f5f5f5">TOTAL TTC</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;font-weight:700;text-align:right">${fmt(d.montantTTC)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #ccc;padding:6px 8px" colspan="6">&nbsp;</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;font-weight:700;text-align:right;background:#f5f5f5">AUTRES TAXES</td>
        <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">0</td>
      </tr>
      <tr>
        <td style="border:1px solid #ccc;padding:8px 8px;background:#1A1A1C" colspan="6">&nbsp;</td>
        <td style="border:1px solid #1A1A1C;padding:8px 10px;font-size:12px;font-weight:700;text-align:right;background:#1A1A1C;color:#FFC400">TOTAL À PAYER</td>
        <td style="border:1px solid #1A1A1C;padding:8px 10px;font-size:12px;font-weight:700;text-align:right;background:#FFC400;color:#1A1A1C">${fmt(isF?reste:d.montantTTC)}</td>
      </tr>
    </table>

    ${isF&&paid>0?`
    <!-- PAIEMENTS REÇUS -->
    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <div style="border:1px solid #B2DFC5;border-radius:4px;overflow:hidden;min-width:300px">
        <div style="background:#00843D;color:#fff;padding:5px 10px;font-size:10px;font-weight:700;text-align:center">PAIEMENTS REÇUS</div>
        ${d.paiements.map(p=>`<div style="display:flex;justify-content:space-between;padding:5px 10px;border-bottom:1px solid #eee;font-size:11px">
          <span>${fmtDate(p.date)} — ${esc(p.mode||"")}</span>
          <strong>${fmt(p.montant)}</strong>
        </div>`).join("")}
        <div style="display:flex;justify-content:space-between;padding:6px 10px;background:#E3F6EC;font-size:11px;font-weight:700">
          <span>Total payé</span><span style="color:#00843D">${fmt(paid)}</span>
        </div>
      </div>
    </div>`:""}

    <!-- RÉSUMÉ DE LA FACTURE -->
    <div style="margin-top:20px">
      <div style="font-size:11px;font-weight:700;margin-bottom:6px;padding:4px 0;border-bottom:1.5px solid #1A1A1C">RÉSUMÉ DE LA FACTURE</div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:left">CATÉGORIE</th>
            <th style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">SOUS-TOTAL</th>
            <th style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:center">TAUX (%)</th>
            <th style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">TOTAL TAXES</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px">TVA ${tva}% — Régime Réel Simplifié (RSI)</td>
            <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">${fmt(d.montantHT)}</td>
            <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:center">${tva}%</td>
            <td style="border:1px solid #ccc;padding:6px 10px;font-size:11px;text-align:right">${fmt(d.montantTVA)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    ${d.notes?`<div style="margin-top:12px;padding:8px 12px;border:1px solid #E4E6EA;border-radius:4px;font-size:10.5px;color:#555"><strong>Notes : </strong>${esc(d.notes)}</div>`:""}

    <!-- ARRÊTÉ EN LETTRES -->
    <div style="margin-top:14px;padding:8px 12px;background:#F5F5F7;border-radius:4px;font-size:10.5px;color:#555;font-style:italic;border-left:3px solid #EC008C">
      Arrêtée la présente ${isF?"facture":"offre"} à la somme de : <strong style="color:#1A1A1C;font-style:normal">${fmt(d.montantTTC)} ${devise}</strong>
    </div>

    <!-- SIGNATURE -->
    <div style="display:flex;justify-content:flex-end;margin-top:32px;margin-bottom:10px">
      <div style="text-align:center;width:200px;font-size:10px;color:#777">
        <div style="border-top:1px solid #ccc;margin-top:48px;padding-top:5px">Signature & Cachet du vendeur</div>
        <div style="margin-top:3px;font-weight:600;color:#1A1A1C">${esc(co.name||"CREATIS STUDIO")}</div>
      </div>
    </div>
  </div>

  <!-- PIED DE PAGE LÉGAL -->
  <div style="background:#F1F2F4;padding:10px 24px;border-top:1px solid #ddd">
    <div style="font-size:8.5px;color:#777;text-align:center;line-height:1.8">
      ${esc(co.name||"CREATIS STUDIO")} — SARL au capital de ${esc(co.capital||"1 000 000 F CFA")} — Siège : ${esc(co.siege||"")}
      — RC ${esc(co.rc||"")} — CC ${esc(co.cc||"")} — Régime : ${esc(co.regime||"")} — Centre : ${esc(co.centre||"")}
      — Banque : ${esc(co.banque||"")}
    </div>
    <div style="font-size:7.5px;color:#aaa;text-align:center;margin-top:2px">
      Facture générée le ${new Date().toLocaleDateString("fr-FR")} — ${esc(d.numero||"")} — Conforme DGI / FNE Côte d'Ivoire
    </div>
  </div>

  <!-- BANDE CMJN INFÉRIEURE -->
  <div style="height:4px;display:flex">
    <div style="flex:1;background:#00AEEF"></div><div style="flex:1;background:#EC008C"></div>
    <div style="flex:1;background:#FFC400"></div><div style="flex:1;background:#1A1A1C"></div>
  </div>
</div>

<div class="no-print" style="text-align:center;padding:20px;display:flex;justify-content:center;gap:12px">
  <button onclick="window.print()" style="padding:12px 32px;background:#1A1A1C;color:#fff;border:none;border-radius:30px;font-size:14px;font-weight:700;cursor:pointer">🖨️ Imprimer / Exporter PDF</button>
  <button onclick="window.close()" style="padding:12px 24px;background:#fff;color:#1A1A1C;border:1.5px solid #ccc;border-radius:30px;font-size:14px;cursor:pointer">✕ Fermer</button>
</div>
</body></html>`;

  const w=window.open("","_blank","width=900,height=740");
  w.document.write(html);
  w.document.close();
}

function viewCommandes(){
  if(!vis("commandes"))return;
  window._cmdView=window._cmdView||"kanban";
  window._cmdFil=window._cmdFil||{statut:"",q:""};
  const now=new Date();
  const all=DB.commandes||[];
  const enCours=all.filter(c=>c.statut!=="livré"&&c.statut!=="facturé");
  const retard=enCours.filter(c=>c.deadline&&new Date(c.deadline)<now).length;
  const nonFacture=all.filter(c=>c.statut==="livré").length;

  $("#pg-title").textContent="Commandes & Projets";
  $("#pg-sub").textContent=`${all.length} commande(s) · ${enCours.length} en cours · ${retard>0?retard+" en retard ⚠️":"aucun retard"}`;
  $("#pg-actions").innerHTML=`
    <input id="cmd-srch" placeholder="🔍 Titre, client…" value="${window._cmdFil.q||""}"
      oninput="window._cmdFil.q=this.value;renderCmdView()"
      style="padding:8px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:180px;font-size:13px">
    <button class="btn" onclick="window._cmdView=(window._cmdView==='kanban'?'liste':'kanban');renderCmdView()"
      style="font-size:12px">⊞ ${window._cmdView==="kanban"?"Liste":"Kanban"}</button>
    <button class="btn" onclick="exportExcel('commandes')" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
    ${wr("commandes")?`<button class="btn btn-primary act-edit" onclick="editCmd()">＋ Nouvelle commande</button>`:""}
  `;

  // KPIs
  const kpiHtml="<div style='display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px'>"
    +"<div class='card kpi c-cyan' style='padding:14px 16px'><div class='lab'>Total commandes</div><div class='val tabnum' style='font-size:22px'>"+all.length+"</div><div class='delta'>"+enCours.length+" en cours</div></div>"
    +"<div class='card kpi "+(retard>0?"c-mag":"c-noir")+"' style='padding:14px 16px'><div class='lab'>En retard</div><div class='val tabnum' style='font-size:22px'>"+retard+"</div><div class='delta'>deadline dépassée</div></div>"
    +"<div class='card kpi c-jaune' style='padding:14px 16px'><div class='lab'>À facturer</div><div class='val tabnum' style='font-size:22px'>"+nonFacture+"</div><div class='delta'>livrées non facturées</div></div>"
    +"</div>";

  const el=$("#view");
  if(el) el.innerHTML=kpiHtml+"<div id='cmd-content'></div>";
  renderCmdView();
}

function renderCmdView(){
  var now=new Date();
  var today=new Date().toISOString().slice(0,10);
  var view=window._cmdView||"kanban";
  var fil=window._cmdFil||{statut:"",q:""};
  var list=DB.commandes||[];
  if(fil.q){var q=fil.q.toLowerCase();list=list.filter(function(c){return(c.titre||"").toLowerCase().includes(q)||(clientName(c.clientId)||"").toLowerCase().includes(q)||(c.numero||"").toLowerCase().includes(q);});}
  if(fil.statut)list=list.filter(function(c){return c.statut===fil.statut;});

  var el=document.getElementById("cmd-content");
  if(!el)return;

  if(view==="kanban"){
    if(!list.length){el.innerHTML="<div style='padding:40px;text-align:center;color:var(--txt-3)'>Aucune commande</div>";return;}
    var html="<div class='kanban'>";
    CMD_FLOW.forEach(function(kl){
      var k=kl[0],l=kl[1];
      var items=list.filter(function(c){return c.statut===k;});
      var col=CMD_COLORS[k]||"var(--cyan)";
      html+="<div class='kol'>";
      html+="<div class='kol-h' style='border-left:3px solid "+col+";padding-left:8px'>"+l+" <span class='badge' style='background:rgba(0,0,0,.12)'>"+items.length+"</span></div>";
      items.forEach(function(c){
        var late=c.deadline&&c.deadline<today&&k!=="livré"&&k!=="facturé";
        var u=(DB.users||[]).find(function(x){return x.id===(c.responsableId||c.responsable_id);});
        var batSt=c.statutBat||c.statut_bat;
        html+="<div class='kard"+(late?" late":"")+"' onclick='openCmd(\""+c.id+"\")'>";
        html+="<div style='display:flex;justify-content:space-between;align-items:flex-start'>";
        html+="<div class='kard-t' style='flex:1'>"+esc(c.numero||"")+" "+esc(c.titre)+"</div>";
        if(wr("commandes")) html+="<button class='btn btn-sm btn-ghost' style='padding:2px 5px;margin-left:4px' onclick='event.stopPropagation();editCmd(\""+c.id+"\")'>✏️</button>";
        html+="</div>";
        html+="<div class='kard-m'><span>"+esc(clientName(c.clientId))+"</span>"+(c.deadline?"<span class='"+(late?"text-danger":"")+"'>"+fdate(c.deadline)+"</span>":"")+"</div>";
        if(u) html+="<div style='font-size:10px;color:var(--cyan);margin-top:3px;font-weight:600'>👤 "+esc(u.name)+"</div>";
        if(batSt&&batSt!=="non_demarre") html+="<div style='margin-top:4px'>"+batBadge(batSt)+"</div>";
        if(c.montantEstime||c.montant_estime) html+="<div style='font-size:11px;color:var(--txt-2);margin-top:3px;text-align:right'>"+fcfa(c.montantEstime||c.montant_estime)+"</div>";
        html+="</div>";
      });
      html+="</div>";
    });
    html+="</div>";
    el.innerHTML=html;
  } else {
    // Vue liste
    var sorted=[...list].sort(function(a,b){return new Date(b.createdAt||0)-new Date(a.createdAt||0);});
    if(!sorted.length){el.innerHTML="<div style='padding:40px;text-align:center;color:var(--txt-3)'>Aucune commande</div>";return;}
    var tabs="<div style='display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px'>";
    [["","Tous"]].concat(CMD_FLOW).forEach(function(kl){
      var v=kl[0],l=kl[1];
      var active=fil.statut===v;
      tabs+="<button onclick='window._cmdFil.statut=\""+v+"\";renderCmdView()' style='padding:5px 12px;border-radius:20px;border:1.5px solid "+(active?"var(--cyan)":"var(--ligne)")+";background:"+(active?"var(--cyan)":"var(--carte)")+";color:"+(active?"#fff":"var(--txt-2)")+";font-size:12px;font-weight:600;cursor:pointer'>"+l+"</button>";
    });
    tabs+="</div>";
    var tbl="<div style='overflow-x:auto'><table><thead><tr><th>N°</th><th>Titre</th><th>Client</th><th>Deadline</th><th>Montant</th><th>Statut</th><th>BAT</th><th></th></tr></thead><tbody>";
    sorted.forEach(function(c){
      var late=c.deadline&&c.deadline<today&&c.statut!=="livré"&&c.statut!=="facturé";
      var batSt=c.statutBat||c.statut_bat;
      tbl+="<tr class='clk' onclick='openCmd(\""+c.id+"\")'>";
      tbl+="<td><div class='nm tabnum'>"+esc(c.numero||"")+"</div></td>";
      tbl+="<td>"+esc(c.titre)+"</td>";
      tbl+="<td class='meta'>"+esc(clientName(c.clientId))+"</td>";
      tbl+="<td class='meta' style='color:"+(late?"var(--danger)":"")+"'>"+fdate(c.deadline)+(late?" ⚠️":"")+"</td>";
      tbl+="<td class='r tabnum'>"+((c.montantEstime||c.montant_estime)?fcfa(c.montantEstime||c.montant_estime):"—")+"</td>";
      tbl+="<td>"+pill(c.statut)+"</td>";
      tbl+="<td>"+(batSt&&batSt!=="non_demarre"?batBadge(batSt):"")+"</td>";
      tbl+="<td class='r' onclick='event.stopPropagation()'>"+(wr("commandes")?"<button class='btn btn-sm btn-ghost act-edit' onclick='editCmd(\""+c.id+"\")'>✏️</button>":"")+"</td>";
      tbl+="</tr>";
    });
    tbl+="</tbody></table></div>";
    el.innerHTML=tabs+tbl;
  }
}

function openCmd(id){
  if(!vis("commandes"))return;
  const c=DB.commandes.find(x=>x.id===id);if(!c)return;
  const today=new Date().toISOString().slice(0,10);
  const late=c.deadline&&c.deadline<today&&c.statut!=="livré"&&c.statut!=="facturé";
  const devisLie=c.devisId?DB.devis.find(x=>x.id===c.devisId):null;
  const factureLie=c.factureId?DB.factures.find(x=>x.id===c.factureId):null;
  const resp=(DB.users||[]).find(x=>x.id===(c.responsableId||c.responsable_id));
  const fourn=(DB.fournisseurs||[]).find(x=>x.id===(c.fournisseurId||c.fournisseur_id));
  const batSt=c.statutBat||c.statut_bat||"non_demarre";
  const bonsAchat=(DB.bonsAchat||[]).filter(b=>(b.commandeId||b.commande_id)===id);

  let body="<div style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:12.5px'>";
  body+=kv("Client","<strong>"+esc(clientName(c.clientId))+"</strong>");
  body+=kv("Statut",pill(c.statut));
  if(c.montantEstime||c.montant_estime) body+=kv("Montant estimé","<strong class='tabnum'>"+fcfa(c.montantEstime||c.montant_estime)+"</strong>");
  body+=kv("Deadline","<span style='color:"+(late?"var(--danger)":"inherit")+"'>"+fdate(c.deadline)+(late?" ⚠️ En retard":"")+"</span>");
  if(resp) body+=kv("Responsable","👤 "+esc(resp.name));
  if(fourn) body+=kv("Fournisseur","🏭 "+esc(fourn.nom));
  if(devisLie) body+=kv("Devis lié","<span style='cursor:pointer;color:var(--cyan)' onclick='closeOverlays();openDevis(\""+devisLie.id+"\")'>" + esc(devisLie.numero) + "</span>");
  if(factureLie) body+=kv("Facture liée","<span style='cursor:pointer;color:var(--cyan)' onclick='closeOverlays();openFacture(\""+factureLie.id+"\")'>" + esc(factureLie.numero) + "</span>");
  body+="</div>";

  // BAT
  body+="<div class='fieldset' style='margin-bottom:12px'><div class='fs-t'>BAT — Bon à tirer</div>"+batBadge(batSt);
  body+="<div style='display:flex;flex-wrap:wrap;gap:6px;margin-top:8px'>";
  Object.entries(BAT_LABELS).forEach(function(kl){
    const k=kl[0],l=kl[1];
    const active=batSt===k;
    body+="<button onclick='setCmdBat(\""+id+"\",\""+k+"\")' style='padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid "+(active?"var(--cyan)":"var(--ligne)")+";background:"+(active?"var(--cyan)18":"var(--carte)")+";color:"+(active?"var(--cyan)":"var(--txt-2)")+";'>"+(l)+"</button>";
  });
  body+="</div></div>";

  // Changer statut commande
  body+="<div class='fieldset' style='margin-bottom:12px'><div class='fs-t'>Avancement</div><div style='display:flex;flex-wrap:wrap;gap:6px;margin-top:6px'>";
  CMD_FLOW.forEach(function(kl){
    const k=kl[0],l=kl[1];
    const active=c.statut===k;
    body+="<button onclick='setCmd(\""+id+"\",\""+k+"\")' style='padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid "+(active?"var(--cyan)":"var(--ligne)")+";background:"+(active?"var(--cyan)18":"var(--carte)")+";color:"+(active?"var(--cyan)":"var(--txt-2)")+";'>"+(l)+"</button>";
  });
  body+="</div></div>";

  // Bons d'achat liés
  if(bonsAchat.length){
    body+="<div class='fieldset' style='margin-bottom:12px'><div class='fs-t'>Bons d'achat ("+bonsAchat.length+")</div>";
    bonsAchat.forEach(function(b){
      const fo=(DB.fournisseurs||[]).find(x=>x.id===(b.fournisseurId||b.fournisseur_id));
      body+="<div style='display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--ligne-2)'>";
      body+="<div><strong>"+esc(b.numero||"")+"</strong> · "+esc(fo?fo.nom:"—")+"</div>";
      body+="<div style='display:flex;gap:8px;align-items:center'><span class='tabnum'>"+fcfa(b.montantTtc||b.montant_ttc||0)+"</span>"+pill(b.statut||"brouillon");
      body+="<button class='btn btn-sm btn-ghost' onclick='closeOverlays();editBonAchat(\""+b.id+"\")'>✏️</button></div></div>";
    });
    body+="</div>";
  }

  if(c.notes) body+=kv("Notes","<span style='white-space:pre-wrap'>"+esc(c.notes)+"</span>");

  drawer(c.numero||"Commande",c.titre,body,
    [
     wr("commandes")?{label:"✏️ Modifier",cls:"btn",fn:`closeOverlays();editCmd('${id}')`}:null,
     wr("commandes")&&c.statut==="livré"&&!factureLie?{label:"→ Facturer",cls:"btn-mag",fn:`cmdToFacture('${id}')`}:null,
     wr("fournisseurs")?{label:"🛒 Bon d'achat",cls:"btn",fn:`closeOverlays();editBonAchat('',{commandeId:'${id}',fournisseurId:c.fournisseurId||'',clientLabel:clientName(c.clientId)})`}:null,
     {label:"Supprimer",cls:"btn-danger",fn:`delCmd('${id}')`}
    ].filter(Boolean)
  );
}

function setCmdBat(id,batSt){
  if(!guard("commandes"))return;
  const c=DB.commandes.find(x=>x.id===id);if(!c)return;
  c.statutBat=batSt;c.statut_bat=batSt;
  sync("commandes",c);closeOverlays();
  toast("BAT mis à jour : "+BAT_LABELS[batSt]);go("commandes");
}

function cmdToFacture(cmdId){
  if(!guard("factures"))return;
  const c=DB.commandes.find(x=>x.id===cmdId);if(!c)return;
  const seq=DB.settings.seqFacture;const year=DB.settings.year;
  const num="FAC-"+year+"-"+String(seq).padStart(4,"0");
  const f={id:uid(),numero:num,clientId:c.clientId,commandeId:cmdId,date:todayISO(),echeance:"",
    lignes:[{reference:"",designation:c.titre,unite:"Fft",qte:1,pu:c.montantEstime||c.montant_estime||0,remise:0}],
    tva:DB.settings.tva||18,statut:"impayée",paiements:[],notes:"Commande "+c.numero,createdAt:Date.now()};
  const totals=calcLignes(f.lignes,f.tva);Object.assign(f,totals);
  DB.factures.push(f);DB.settings.seqFacture=seq+1;
  c.factureId=f.id;c.statut="facturé";
  sync("factures",f);sync("commandes",c);sync("settings",DB.settings);
  closeOverlays();toast("Facture "+num+" créée ✓");refreshBadges();go("factures");
}
function setCmd(id,s){if(!guard("commandes"))return;const c=DB.commandes.find(x=>x.id===id);c.statut=s;sync("commandes",c);closeOverlays();toast("Statut mis à jour");go("commandes")}
function editCmd(id){
  if(!guard("commandes"))return;
  const c=id?DB.commandes.find(x=>x.id===id):{titre:"",clientId:"",statut:"devis",deadline:"",montantEstime:0,responsableId:"",fournisseurId:"",devisId:"",notes:"",statutBat:"non_demarre"};
  const clientOpts=(DB.clients||[]).map(cl=>`<option value="${cl.id}" ${c.clientId===cl.id?"selected":""}>${esc(cl.nom)}</option>`).join("");
  const devisOpts=(DB.devis||[]).map(d=>`<option value="${d.id}" ${(c.devisId||c.devis_id)===d.id?"selected":""}>${esc(d.numero)} — ${esc(clientName(d.clientId))}</option>`).join("");
  const respOpts=(DB.users||[]).map(u=>`<option value="${u.id}" ${(c.responsableId||c.responsable_id)===u.id?"selected":""}>${esc(u.name)}</option>`).join("");
  const foOpts=(DB.fournisseurs||[]).filter(f=>f.actif!==false).map(f=>`<option value="${f.id}" ${(c.fournisseurId||c.fournisseur_id)===f.id?"selected":""}>${esc(f.nom)}</option>`).join("");
  const statOpts=CMD_FLOW.map(([k,l])=>`<option value="${k}" ${c.statut===k?"selected":""}>${l}</option>`).join("");
  const batOpts=Object.entries(BAT_LABELS).map(([k,l])=>`<option value="${k}" ${(c.statutBat||c.statut_bat||"non_demarre")===k?"selected":""}>${l}</option>`).join("");
  drawer(id?"Modifier la commande":"Nouvelle commande","",
    `<form id="f-cmd">
    <div class="field"><label>Titre / Désignation du projet *</label><input name="titre" value="${esc(c.titre)}" placeholder="ex: Impression catalogue A4 — 1000 ex." required></div>
    <div class="row2">
      <div class="field"><label>Client</label><select name="clientId"><option value="">— Choisir —</option>${clientOpts}</select></div>
      <div class="field"><label>Deadline livraison</label><input name="deadline" type="date" value="${c.deadline||""}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Statut</label><select name="statut">${statOpts}</select></div>
      <div class="field"><label>Montant estimé (HT)</label><input name="montantEstime" type="number" min="0" value="${c.montantEstime||c.montant_estime||0}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Responsable</label><select name="responsableId"><option value="">— Aucun —</option>${respOpts}</select></div>
      <div class="field"><label>Fournisseur principal</label><select name="fournisseurId"><option value="">— Aucun —</option>${foOpts}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Devis associé</label><select name="devisId"><option value="">— Aucun —</option>${devisOpts}</select></div>
      <div class="field"><label>Statut BAT</label><select name="statutBat">${batOpts}</select></div>
    </div>
    <div class="field"><label>Notes / Instructions</label><textarea name="notes">${esc(c.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delCmd('${id}')`}:null,
     {label:id?"💾 Enregistrer":"Créer la commande",cls:"btn-primary",fn:`saveCmd('${id||""}')`}
    ].filter(Boolean)
  );
}
function saveCmd(id){
  if(!guard("commandes"))return;
  const f=$("#f-cmd");const fd=new FormData(f);
  const titre=fd.get("titre")||"";if(!titre.trim()){toast("Titre obligatoire");return}
  const patch={
    titre:titre.trim(),
    clientId:fd.get("clientId")||null,
    deadline:fd.get("deadline")||null,
    statut:fd.get("statut")||"devis",
    montantEstime:+fd.get("montantEstime")||0,
    responsableId:fd.get("responsableId")||null,
    fournisseurId:fd.get("fournisseurId")||null,
    devisId:fd.get("devisId")||null,
    statutBat:fd.get("statutBat")||"non_demarre",
    notes:fd.get("notes")||""
  };
  if(id){const c=DB.commandes.find(x=>x.id===id);Object.assign(c,patch);sync("commandes",c);}
  else{
    const seq=DB.settings.seqCommande;const year=DB.settings.year;
    const num="CMD-"+year+"-"+String(seq).padStart(4,"0");
    const c={id:uid(),numero:num,...patch,factureId:null,createdAt:Date.now()};
    DB.commandes.push(c);DB.settings.seqCommande=seq+1;sync("commandes",c);sync("settings",DB.settings);
  }
  closeOverlays();toast(id?"Commande mise à jour":"Commande créée ✓");refreshBadges();go(current);
}
function delCmd(id){if(!guard("commandes"))return;confirmModal("Supprimer cette commande ?","",()=>{DB.commandes=DB.commandes.filter(x=>x.id!==id);syncDel("commandes",id);closeOverlays();toast("Commande supprimée");refreshBadges();go("commandes")})}

/* ============================================================
   PARAMÈTRES
   ============================================================ */
function viewParamètres(){
  if(!vis("parametres"))return;
  const c=DB.settings.company||{}; const s=DB.settings;
  $("#pg-title").textContent="Paramètres";
  $("#pg-actions").innerHTML=`
    <label class="btn" style="cursor:pointer">Importer<input type="file" accept=".json" style="display:none" onchange="importData(this)"></label>
    <button class="btn" onclick="exportData()">Exporter (.json)</button>
    <button class="btn btn-primary" onclick="saveSettings()">Enregistrer</button>
  `;
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
  ${renderFneSettings()}
  <div class="card panel" style="margin-top:16px"><div class="panel-h"><h3>Sauvegarde</h3></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="exportExcel('all')" style="background:#1D6F42;border-color:#1D6F42;color:#fff">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>
          Exporter tout (Excel)</button>
        <button class="btn" onclick="exportData()"><svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Sauvegarde (.json)</button>
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

/* ============================================================
   EXPORT EXCEL (SheetJS)
   ============================================================ */

// Largeurs de colonnes helpers
const COL = {
  id:6, date:12, num:16, nom:28, contact:20, type:10,
  seg:14, tel:14, email:26, adr:34, src:16, notes:40,
  statut:12, montant:16, taux:8, ref:20, titre:30,
  cat:16, pu:14, unite:10, qty:8, lab:26, fournisseur:20,
};

function _ws(data, cols){
  if(!data.length) return XLSX.utils.json_to_sheet([{"(vide)":"Aucune donnée"}]);
  const ws = XLSX.utils.json_to_sheet(data, {cellDates:true});
  // Largeurs colonnes
  const keys = Object.keys(data[0]);
  ws["!cols"] = keys.map(k => {
    const match = cols?.[k];
    return {wch: match || Math.min(Math.max(k.length+2, 10), 40)};
  });
  // Figer la première ligne (en-têtes)
  ws["!freeze"] = {xSplit:0, ySplit:1};
  return ws;
}

// ── Feuille Clients ──
function _sheetClients(){
  return _ws(DB.clients.map(c => ({
    "Nom / Entreprise"  : c.nom || "",
    "Interlocuteur"     : c.contact || "",
    "Type"              : c.type === "client" ? "Client" : "Prospect",
    "Segment"           : c.segment || "",
    "Téléphone"         : c.tel || "",
    "Email"             : c.email || "",
    "Adresse"           : c.adresse || "",
    "Source"            : c.source || "",
    "Notes"             : c.notes || "",
    "Date création"     : fdate(c.createdAt||c.created_at),
  })), {
    "Nom / Entreprise":28,"Interlocuteur":20,"Type":10,"Segment":14,
    "Téléphone":14,"Email":28,"Adresse":34,"Source":16,"Notes":40,"Date création":14
  });
}

// ── Feuille Devis ──
function _sheetDevis(){
  return _ws(DB.devis.map(d => ({
    "Numéro"          : d.numero || "",
    "Client"          : clientName(d.clientId),
    "Date"            : fdate(d.date),
    "Validité"        : fdate(d.validite),
    "Statut"          : d.statut || "",
    "Montant HT (F)"  : d.montantHT || 0,
    "TVA 18% (F)"     : d.montantTVA || 0,
    "Total TTC (F)"   : d.montantTTC || 0,
    "Lignes (nb)"     : (d.lignes||[]).length,
    "Notes"           : d.notes || "",
  })), {
    "Numéro":16,"Client":28,"Date":12,"Validité":12,"Statut":12,
    "Montant HT (F)":16,"TVA 18% (F)":14,"Total TTC (F)":16,"Lignes (nb)":10,"Notes":30
  });
}

// ── Feuille Factures ──
function _sheetFactures(){
  return _ws(DB.factures.map(f => {
    const paid = factPaid(f);
    return {
      "Numéro"            : f.numero || "",
      "Client"            : clientName(f.clientId),
      "Date"              : fdate(f.date),
      "Échéance"          : fdate(f.echeance),
      "Statut"            : factStatut(f),
      "Montant HT (F)"    : f.montantHT || 0,
      "TVA 18% (F)"       : f.montantTVA || 0,
      "Total TTC (F)"     : f.montantTTC || 0,
      "Payé (F)"          : paid,
      "Reste à régler (F)": Math.max(0, (f.montantTTC||0) - paid),
      "Nb paiements"      : (f.paiements||[]).length,
      "Notes"             : f.notes || "",
    };
  }), {
    "Numéro":16,"Client":28,"Date":12,"Échéance":12,"Statut":12,
    "Montant HT (F)":16,"TVA 18% (F)":14,"Total TTC (F)":16,
    "Payé (F)":14,"Reste à régler (F)":18,"Nb paiements":12,"Notes":30
  });
}

// ── Feuille Commandes ──
function _sheetCommandes(){
  return _ws(DB.commandes.map(c => ({
    "Numéro"      : c.numero || "",
    "Titre"       : c.titre || "",
    "Client"      : clientName(c.clientId),
    "Statut"      : c.statut || "",
    "Deadline"    : fdate(c.deadline),
    "Devis lié"   : c.devisId ? (DB.devis.find(d=>d.id===c.devisId)||{}).numero||"" : "",
    "En retard"   : (c.deadline && new Date(c.deadline)<new Date() && !["livré","facturé"].includes(c.statut)) ? "Oui" : "Non",
    "Notes"       : c.notes || "",
  })), {
    "Numéro":14,"Titre":30,"Client":26,"Statut":12,
    "Deadline":12,"Devis lié":16,"En retard":10,"Notes":30
  });
}

// ── Feuille Dépenses ──
function _sheetDepenses(){
  return _ws(DB.depenses.map(d => ({
    "Date"          : fdate(d.date),
    "Libellé"       : d.libelle || "",
    "Catégorie"     : d.categorie || "",
    "Fournisseur"   : d.fournisseur || "",
    "Montant HT (F)": d.ht || 0,
    "TVA (F)"       : d.tva || 0,
    "Total TTC (F)" : d.ttc || 0,
  })), {
    "Date":12,"Libellé":30,"Catégorie":18,"Fournisseur":22,
    "Montant HT (F)":16,"TVA (F)":12,"Total TTC (F)":16
  });
}

// ── Feuille Catalogue ──
function _sheetCatalogue(){
  return _ws(DB.products.map(p => ({
    "Désignation"       : p.designation || "",
    "Catégorie"         : p.categorie || "",
    "Prix unitaire HT"  : p.pu || 0,
    "Unité"             : p.unite || "",
    "Prix TTC (18%)"    : Math.round((p.pu||0)*1.18),
  })), {
    "Désignation":32,"Catégorie":16,"Prix unitaire HT":18,"Unité":10,"Prix TTC (18%)":16
  });
}

// ── Feuille Résumé comptable ──
function _sheetCompta(){
  let totalEncaisse=0, totalHT=0, totalTVA=0, totalDepenses=0, totalTVADed=0;
  DB.factures.forEach(f=>{
    const paid=factPaid(f);
    totalEncaisse+=paid;
    if(paid>0&&f.montantTTC){ totalTVA+=f.montantTVA*(paid/f.montantTTC); }
    totalHT+=f.montantHT||0;
  });
  DB.depenses.forEach(d=>{ totalDepenses+=d.ttc||0; totalTVADed+=d.tva||0; });
  const rows = [
    {"Indicateur":"Chiffre d'affaires HT (total)","Montant (F)": Math.round(totalHT),"Note":"Somme des factures émises HT"},
    {"Indicateur":"Encaissements","Montant (F)": Math.round(totalEncaisse),"Note":"Paiements effectivement reçus"},
    {"Indicateur":"Reste à encaisser","Montant (F)": Math.round(DB.factures.reduce((s,f)=>s+Math.max(0,(f.montantTTC||0)-factPaid(f)),0)),"Note":"Factures impayées ou partielles"},
    {"Indicateur":"TVA collectée","Montant (F)": Math.round(totalTVA),"Note":"Sur encaissements"},
    {"Indicateur":"TVA déductible (achats)","Montant (F)": Math.round(totalTVADed),"Note":"Sur dépenses"},
    {"Indicateur":"TVA nette à reverser","Montant (F)": Math.round(totalTVA-totalTVADed),"Note":"Collectée - Déductible"},
    {"Indicateur":"Total dépenses TTC","Montant (F)": Math.round(totalDepenses),"Note":"Charges déclarées"},
    {"Indicateur":"Résultat (encaissements - dépenses)","Montant (F)": Math.round(totalEncaisse-totalDepenses),"Note":"Indicatif"},
  ];
  return _ws(rows,{"Indicateur":38,"Montant (F)":16,"Note":40});
}

// ── Export GLOBAL (toutes feuilles) ──
function _sheetFournisseurs(){
  return _ws(DB.fournisseurs.map(f=>({
    "Nom":f.nom||"","Contact":f.contact||"","Secteur":f.secteur||"",
    "Téléphone":f.tel||"","Email":f.email||"","Adresse":f.adresse||"",
    "Conditions":f.conditionsPaiement||f.conditions_paiement||"",
    "N° Contribuable":f.numeroContribuable||f.numero_contribuable||"",
    "Banque":f.compteBancaire||f.compte_bancaire||"",
    "Statut":f.actif!==false?"Actif":"Inactif"
  })),{"Nom":28,"Contact":20,"Secteur":16,"Téléphone":14,"Email":26,"Adresse":34,"Conditions":16,"N° Contribuable":20,"Banque":30,"Statut":8});
}
function exportExcel(scope){
  scope = scope || "all";
  const wb = XLSX.utils.book_new();
  const co = DB.settings?.company||{};
  const now = new Date().toLocaleDateString("fr-FR");

  if(scope==="all"||scope==="fournisseurs") XLSX.utils.book_append_sheet(wb, _sheetFournisseurs(), "Fournisseurs");
  if(scope==="all"||scope==="clients")   XLSX.utils.book_append_sheet(wb, _sheetClients(),   "Clients");
  if(scope==="all"||scope==="devis")     XLSX.utils.book_append_sheet(wb, _sheetDevis(),     "Devis");
  if(scope==="all"||scope==="factures")  XLSX.utils.book_append_sheet(wb, _sheetFactures(),  "Factures");
  if(scope==="all"||scope==="commandes") XLSX.utils.book_append_sheet(wb, _sheetCommandes(), "Commandes");
  if(scope==="all"||scope==="depenses")  XLSX.utils.book_append_sheet(wb, _sheetDepenses(),  "Dépenses");
  if(scope==="all"||scope==="catalogue") XLSX.utils.book_append_sheet(wb, _sheetCatalogue(), "Catalogue");
  if(scope==="all") {
    XLSX.utils.book_append_sheet(wb, _sheetCompta(), "Résumé comptable");
    // Feuille info
    const info = XLSX.utils.aoa_to_sheet([
      ["Creatis Studio — Export CRM"],[""],
      ["Société", co.name||"Creatis Studio"],
      ["RC", co.rc||"CI-ABJ-2007-B-3172"],
      ["CC", co.cc||"0811105V"],
      ["Date d'export", now],
      ["Devise", "Franc CFA (XOF)"],
      ["TVA", "18%"],[""],
      ["Feuilles incluses",""],
      ["Clients","Tous les clients et prospects"],
      ["Devis","Devis émis"],
      ["Factures","Factures avec détail paiements"],
      ["Commandes","Suivi des commandes Kanban"],
      ["Dépenses","Journal des charges"],
      ["Catalogue","Produits et tarifs"],
      ["Résumé comptable","Synthèse TVA et résultats"],
    ]);
    info["!cols"]=[{wch:22},{wch:40}];
    XLSX.utils.book_append_sheet(wb, info, "ℹ️ Infos");
  }

  const filename = scope==="all"
    ? `creatis-crm-complet-${todayISO()}.xlsx`
    : `creatis-${scope}-${todayISO()}.xlsx`;

  XLSX.writeFile(wb, filename);
  toast(`✅ Export Excel "${filename}" téléchargé`);
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
  return`<div class="card"><div style="overflow-x:auto"><table><thead><tr><th>Utilisateur</th><th>Identifiant</th><th>Rôle</th><th>Statut</th><th>Caisse</th><th></th></tr></thead><tbody>${DB.users.map(u=>{const r=roleOf(u);return`<tr><td><div class="nm">${esc(u.name)}</div>${u.id===USER.id?'<div class="meta">vous</div>':''}</td><td class="meta tabnum">${esc(u.login)}</td><td><span class="rdot cc-${(r&&r.color)||"noir"}"></span>${esc(r?r.name:"—")}</td><td>${u.active===false?'<span class="pill p-grey"><span class="dot"></span>Inactif</span>':'<span class="pill p-green"><span class="dot"></span>Actif</span>'}</td><td>${(()=>{const c=(DB.caisses||[]).find(x=>x.id===(u.caisseId||u.caisse_id));return c?`<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${c.couleur||"#00AEEF"}20;color:${c.couleur||"#00AEEF"};border:1px solid ${c.couleur||"#00AEEF"}40">${esc(c.nom)}</span>`:"<span class=\"meta\">—</span>";})()}</td><td class="r"><button class="btn btn-sm btn-ghost" onclick="editUser('${u.id}')">Modifier</button></td></tr>`}).join("")}</tbody></table></div></div>`;
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
    <div class="field"><label>Caisse assignée</label>
      <select name="caisseId">
        <option value="">— Aucune caisse assignée —</option>
        ${(DB.caisses||[]).filter(c=>c.statut==="active").map(c=>`<option value="${c.id}" ${(u.caisseId||u.caisse_id)===c.id?"selected":""}>${esc(c.nom||"")}</option>`).join("")}
      </select>
      <div style="font-size:10.5px;color:var(--txt-2);margin-top:3px">Caisse par défaut lors des mouvements</div>
    </div>
    <div class="field"><label>Statut</label><select name="active"><option value="1" ${u.active!==false?"selected":""}>Actif</option><option value="0" ${u.active===false?"selected":""}>Inactif</option></select></div>
  </form>`,
  [(id&&u.id!==USER.id)?{label:"Supprimer",cls:"btn-danger",fn:`delUser('${id}')`}:null,{label:id?"💾 Enregistrer":"Créer le compte",cls:"btn-primary",fn:`saveUser('${id||""}')`}].filter(Boolean));
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
  [(id&&!r.system)?{label:"Supprimer",cls:"btn-danger",fn:`delRole('${id}')`}:null,{label:id?"💾 Enregistrer":"Créer",cls:"btn-primary",fn:`saveRole('${id||""}')`}].filter(Boolean));
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
   BOOT ASYNC
   ============================================================ */
/* ── Dépenses : filtre live depuis pg-actions ──────────────────── */
function filterDep(){
  const q=(document.getElementById("srch-dep")?.value||"").toLowerCase();
  const cat=document.getElementById("fil-dep-cat")?.value||"";
  const st=document.getElementById("fil-dep-st")?.value||"";
  window._depSrch=q; window._depCat=cat; window._depSt=st;
  renderDepList();
}

/* ── Caisses : export Excel ─────────────────────────────────────── */
function exportCaisseExcel(){
  if(typeof XLSX==="undefined"){toast("Module Excel non chargé");return;}
  const dev=DB.settings.devise||"F CFA";
  const co=DB.settings.company||{};
  const caisses=DB.caisses||[];
  const mvts=DB.caisseMvt||[];
  const wb=XLSX.utils.book_new();
  // Feuille par caisse
  caisses.forEach(c=>{
    const rows=mvts.filter(m=>m.caisse_id===c.id)
      .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0))
      .map(m=>({
        "Date":m.date?new Date(m.date).toLocaleDateString("fr-FR"):"—",
        "Type":m.type_mvt==="entree"?"Entrée":"Sortie",
        "Libellé":m.libelle||"",
        "Catégorie":m.categorie||"",
        "Montant":m.type_mvt==="entree"?+m.montant:-+m.montant,
        "Solde après":+m.solde_apres||0,
        "Référence":m.reference||"",
      }));
    const ws=XLSX.utils.json_to_sheet(rows.length?rows:[{"(vide)":"Aucun mouvement"}]);
    ws["!cols"]=[{wch:12},{wch:8},{wch:30},{wch:16},{wch:14},{wch:14},{wch:16}];
    XLSX.utils.book_append_sheet(wb,ws,(c.nom||"Caisse").slice(0,31));
  });
  XLSX.writeFile(wb,`Caisses_${todayISO()}.xlsx`);
  toast("Export caisses téléchargé");
}

/* ── CRH : export Excel employés ───────────────────────────────── */
function exportCrhExcel(){
  if(typeof XLSX==="undefined"){toast("Module Excel non chargé");return;}
  const wb=XLSX.utils.book_new();
  const wsEmp=XLSX.utils.json_to_sheet((DB.employes||[]).map(e=>({
    "Nom":e.nom||"","Prénom":e.prenom||"","Poste":e.poste||"",
    "Département":e.departement||"","Contrat":e.type_contrat||"",
    "Statut":e.statut||"","Salaire brut":+e.salaire_brut||0,
    "Date embauche":e.date_embauche||"","N° CNPS":e.cnps_number||"",
    "Email":e.email||"","Tél":e.tel||"",
  })));
  wsEmp["!cols"]=[{wch:16},{wch:16},{wch:22},{wch:16},{wch:12},{wch:10},{wch:14},{wch:14},{wch:16},{wch:26},{wch:14}];
  XLSX.utils.book_append_sheet(wb,wsEmp,"Employés");
  if((DB.conges||[]).length){
    const wsCg=XLSX.utils.json_to_sheet(DB.conges.map(c=>{
      const e=(DB.employes||[]).find(x=>x.id===c.employe_id)||{};
      return{"Employé":`${e.nom||""} ${e.prenom||""}`.trim(),"Type":c.type_conge||"",
        "Début":c.date_debut||"","Fin":c.date_fin||"","Statut":c.statut||"","Motif":c.motif||""};
    }));
    XLSX.utils.book_append_sheet(wb,wsCg,"Congés");
  }
  XLSX.writeFile(wb,`RH_Creatis_${todayISO()}.xlsx`);
  toast("Export RH téléchargé");
}


let _pwaPrompt=null;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();_pwaPrompt=e;const b=document.getElementById("pwa-install-btn");if(b)b.style.display="flex";});
function installPWA(){
  if(_pwaPrompt){_pwaPrompt.prompt();_pwaPrompt.userChoice.then(r=>{if(r.outcome==="accepted")toast("✅ Application installée !");_pwaPrompt=null;const b=document.getElementById("pwa-install-btn");if(b)b.style.display="none";});}
  else toast("Installez via le menu de votre navigateur (⋮ → Ajouter à l'écran d'accueil)");
}
async function boot(){
  // Vérifier si les clés Supabase sont des placeholders
  const keysOk = typeof SUPABASE_URL !== "undefined" &&
                 !SUPABASE_URL.includes("VOTRE-ID") &&
                 typeof SUPABASE_ANON_KEY !== "undefined" &&
                 !SUPABASE_ANON_KEY.includes("VOTRE-CLE");
  if(!keysOk){
    console.warn("Clés Supabase manquantes. Configurez app/js/config.js.");
    const v=document.getElementById("view");
    if(v)v.innerHTML=`<div class="empty" style="margin-top:80px">
      <svg class="em-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <h4>Clés Supabase manquantes</h4>
      <div>Ouvrez <code>app/js/config.js</code>, remplissez<br><strong>SUPABASE_URL</strong> et <strong>SUPABASE_ANON_KEY</strong> depuis votre projet Supabase.</div>
    </div>`;
    renderAuth();
    return;
  }
  try { await loadAll(); } catch(err){
    console.error("loadAll:", err);
    document.getElementById("view").innerHTML=`<div class="empty" style="margin-top:80px">
      <svg class="em-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 9v4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
      <h4>Impossible de se connecter à Supabase</h4>
      <div>Vérifiez les clés dans <code>app/js/config.js</code> et la connexion internet.</div>
    </div>`;
  }
  let sessionUser = null;
  try {
    const sid = localStorage.getItem(SESSION_KEY);
    if(sid && DB.users && DB.users.length)
      sessionUser = DB.users.find(u => u.id === sid && u.active !== false) || null;
  } catch(e){}
  if(sessionUser){ enterApp(sessionUser); }
  else { renderAuth(); }
}
boot();
/* ============================================================
   FOURNISSEURS
   ============================================================ */
function fournisseurName(id){ const f=DB.fournisseurs.find(x=>x.id===id); return f?f.nom:"—"; }

function viewFournisseurs(){
  if(!vis("fournisseurs"))return;
  window._foTab=window._foTab||"fournisseurs";
  const tab=window._foTab;
  $("#pg-title").textContent="Fournisseurs & Achats";

  if(tab==="fournisseurs"){
    $("#pg-actions").innerHTML=`
      <input id="srch-fournisseurs" placeholder="🔍 Rechercher..." oninput="renderFournisseurList()" style="padding:8px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:180px;font-size:13px">
      <button class="btn" onclick="exportExcel('fournisseurs')" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
      ${wr("fournisseurs")?`<button class="btn btn-primary act-edit" onclick="editFournisseur()">＋ Nouveau fournisseur</button>`:""}`;
  } else {
    $("#pg-actions").innerHTML=`
      ${wr("fournisseurs")?`<button class="btn btn-primary act-edit" onclick="editBonAchat('')">＋ Nouveau bon d'achat</button>`:""}`;
  }

  // Onglets
  const tabHtml=`<div style="display:flex;gap:2px;border-bottom:2px solid var(--ligne);margin-bottom:14px">
    <button onclick="window._foTab='fournisseurs';viewFournisseurs()" style="padding:8px 18px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;font-weight:600;background:${tab==="fournisseurs"?"var(--carte)":"transparent"};color:${tab==="fournisseurs"?"var(--cyan)":"var(--txt-2)"}">🏭 Fournisseurs (${(DB.fournisseurs||[]).length})</button>
    <button onclick="window._foTab='achats';viewFournisseurs()" style="padding:8px 18px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;font-weight:600;background:${tab==="achats"?"var(--carte)":"transparent"};color:${tab==="achats"?"var(--cyan)":"var(--txt-2)"}">🛒 Bons d'achat (${(DB.bonsAchat||[]).length})</button>
  </div>`;

  if(tab==="fournisseurs"){
    $("#view").innerHTML=tabHtml+"<div id='fo-content'></div>";
    renderFournisseurList();
  } else {
    $("#view").innerHTML=tabHtml+"<div id='view'></div>";
    // Rendre dans un div dédié
    const el=document.createElement("div");
    document.getElementById("view").replaceWith(el);
    el.id="view";
    viewBonsAchat();
  }
}
function renderFournisseurList(){
  if(!vis("fournisseurs"))return;
  const q=(document.getElementById("srch-fournisseurs")?.value||"").toLowerCase();
  let list=(DB.fournisseurs||[]);
  if(q) list=list.filter(f=>(f.nom||"").toLowerCase().includes(q)||(f.contact||"").toLowerCase().includes(q)||(f.secteur||"").toLowerCase().includes(q));
  list=[...list].sort((a,b)=>(a.nom||"").localeCompare(b.nom||""));
  const el=document.getElementById("fo-content")||document.getElementById("view");
  if(!el)return;
  if(!list.length){el.innerHTML=`<div style="padding:40px;text-align:center;color:var(--txt-3)">Aucun fournisseur</div>`;return;}
  const rows=list.map(f=>{
    const deps=(DB.depenses||[]).filter(d=>(d.fournisseurId||d.fournisseur_id)===f.id);
    const tot=deps.reduce((s,d)=>s+(+d.ttc||0),0);
    return `<tr class="clk" onclick="openFournisseur('${f.id}')">
      <td><div class="nm">${esc(f.nom)}</div>${tot>0?`<div class="meta">${fcfa(tot)} achats</div>`:""}</td>
      <td class="meta">${esc(f.contact||"")}</td>
      <td class="meta">${esc(f.secteur||"")}</td>
      <td class="meta">${esc(f.tel||"")}</td>
      <td class="meta">${esc(f.email||"")}</td>
      <td class="meta">${esc(f.conditionsPaiement||f.conditions_paiement||"")}</td>
      <td>${pill(f.actif!==false?"actif":"inactif")}</td>
      <td class="r" onclick="event.stopPropagation()">${wr("fournisseurs")?`<button class="btn btn-sm btn-ghost act-edit" onclick="editFournisseur('${f.id}')">✏️</button>`:""}</td>
    </tr>`;
  }).join("");
  el.innerHTML=`<div style="overflow-x:auto"><table><thead><tr><th>Fournisseur</th><th>Contact</th><th>Secteur</th><th>Téléphone</th><th>Email</th><th>Conditions</th><th>Statut</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function openFournisseur(id){
  const f=DB.fournisseurs.find(x=>x.id===id);if(!f)return;
  const deps=DB.depenses.filter(d=>(d.fournisseurId||d.fournisseur_id)===id);
  const totalDep=deps.reduce((s,d)=>s+(+d.ttc||0),0);
  drawer(f.nom,f.secteur||"",
    kv("Contact",f.contact)+kv("Téléphone",f.tel)+kv("Email",f.email)+
    kv("Adresse",f.adresse)+kv("Secteur",f.secteur)+
    kv("Conditions de paiement",f.conditionsPaiement||f.conditions_paiement)+
    kv("N° Contribuable",f.numeroContribuable||f.numero_contribuable)+
    kv("Compte bancaire",f.compteBancaire||f.compte_bancaire)+
    kv("Notes",f.notes)+
    (deps.length?`<div class="fieldset" style="margin-top:14px"><div class="fs-t">Dépenses (${deps.length}) — ${fcfa(totalDep)} TTC</div>
      ${deps.slice(0,5).map(d=>`<div style="display:flex;justify-content:space-between;padding:4px 0">
        <span>${esc(d.libelle)}</span><span class="tabnum">${fcfa(d.ttc)}</span></div>`).join("")}
    </div>`:""),
    [{label:"Modifier",cls:"btn-primary",edit:1,fn:`closeOverlays();editFournisseur('${id}')`}]
  );
}

function editFournisseur(id){
  if(!guard("fournisseurs"))return;
  const f=id?DB.fournisseurs.find(x=>x.id===id):{nom:"",contact:"",secteur:"",tel:"",email:"",adresse:"",conditionsPaiement:"30 jours",compteBancaire:"",numeroContribuable:"",notes:"",actif:true};
  const secteurs=["Impression","Fournitures de bureau","Informatique","Transport & Logistique","Services","Marketing","Alimentation","Maintenance","Autre"];
  drawer(id?"Modifier le fournisseur":"Nouveau fournisseur","",
    `<form id="f-fourn"><div class="row2">
      <div class="field"><label>Nom *</label><input name="nom" value="${esc(f.nom)}" required></div>
      <div class="field"><label>Interlocuteur</label><input name="contact" value="${esc(f.contact||"")}"></div>
    </div><div class="row2">
      <div class="field"><label>Secteur d'activité</label><select name="secteur">${secteurs.map(s=>`<option ${(f.secteur||"")==s?"selected":""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label>Conditions de paiement</label><input name="conditionsPaiement" value="${esc(f.conditionsPaiement||f.conditions_paiement||"30 jours")}"></div>
    </div><div class="row2">
      <div class="field"><label>Téléphone</label><input name="tel" value="${esc(f.tel||"")}"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(f.email||"")}"></div>
    </div>
    <div class="field"><label>Adresse</label><input name="adresse" value="${esc(f.adresse||"")}"></div>
    <div class="row2">
      <div class="field"><label>N° Contribuable / IFU</label><input name="numeroContribuable" value="${esc(f.numeroContribuable||f.numero_contribuable||"")}"></div>
      <div class="field"><label>Compte bancaire</label><input name="compteBancaire" value="${esc(f.compteBancaire||f.compte_bancaire||"")}"></div>
    </div>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(f.notes||"")}</textarea></div>
    <div class="field"><label>Statut</label><select name="actif"><option value="1" ${f.actif!==false?"selected":""}>Actif</option><option value="0" ${f.actif===false?"selected":""}>Inactif</option></select></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delFournisseur('${id}')`}:null,
     {label:id?"💾 Enregistrer":"Créer",cls:"btn-primary",fn:`saveFournisseur('${id||""}')`}].filter(Boolean)
  );
}
function saveFournisseur(id){
  if(!guard("fournisseurs"))return;
  const f=document.getElementById("f-fourn");const fd=new FormData(f);
  if(!fd.get("nom").trim()){toast("Nom obligatoire");return}
  const data={nom:fd.get("nom").trim(),contact:fd.get("contact"),secteur:fd.get("secteur"),tel:fd.get("tel"),email:fd.get("email"),adresse:fd.get("adresse"),conditionsPaiement:fd.get("conditionsPaiement"),compteBancaire:fd.get("compteBancaire"),numeroContribuable:fd.get("numeroContribuable"),notes:fd.get("notes"),actif:fd.get("actif")==="1"};
  if(id){const x=DB.fournisseurs.find(f=>f.id===id);Object.assign(x,data);sync("fournisseurs",x);}
  else{const x={...data,id:uid(),createdAt:new Date().toISOString()};DB.fournisseurs.push(x);sync("fournisseurs",x);}
  closeOverlays();toast(id?"Fournisseur mis à jour":"Fournisseur créé");go("fournisseurs");
}
function delFournisseur(id){
  if(!guard("fournisseurs"))return;
  confirmModal("Supprimer ce fournisseur ?","Les dépenses liées ne seront pas supprimées.",()=>{
    DB.fournisseurs=DB.fournisseurs.filter(x=>x.id!==id);syncDel("fournisseurs",id);closeOverlays();toast("Fournisseur supprimé");go("fournisseurs");
  });
}

/* ============================================================
   CATALOGUE V2 — Référence, Stock, Prix d'achat, Marge
   ============================================================ */
// ============================================================
// BONS DE COMMANDE FOURNISSEUR
// ============================================================
function viewBonsAchat(){
  if(!vis("fournisseurs"))return;
  window._baFil=window._baFil||{statut:"",q:""};
  const all=DB.bonsAchat||[];
  const enCours=all.filter(b=>b.statut!=="reçu"&&b.statut!=="annulé").length;
  const montantTotal=all.reduce((s,b)=>s+(b.montantTtc||b.montant_ttc||0),0);
  const fil=window._baFil;

  // KPIs
  let html=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px">
    <div class="card kpi c-cyan" style="padding:14px 16px"><div class="lab">Total bons</div><div class="val tabnum" style="font-size:22px">${all.length}</div><div class="delta">${enCours} en cours</div></div>
    <div class="card kpi c-mag" style="padding:14px 16px"><div class="lab">Montant total</div><div class="val tabnum" style="font-size:22px">${fcfa(montantTotal)}</div><div class="delta">TTC</div></div>
  </div>`;

  // Filtres
  html+=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">`;
  [["","Tous"]].concat(BA_FLOW).forEach(([v,l])=>{
    const active=fil.statut===v;
    html+=`<button onclick="window._baFil.statut='${v}';viewBonsAchat()" style="padding:5px 12px;border-radius:20px;border:1.5px solid ${active?"var(--cyan)":"var(--ligne)"};background:${active?"var(--cyan)":"var(--carte)"};color:${active?"#fff":"var(--txt-2)"};font-size:12px;font-weight:600;cursor:pointer">${l}</button>`;
  });
  html+=`</div>`;

  let list=all;
  if(fil.statut) list=list.filter(b=>b.statut===fil.statut);
  if(fil.q){const q=fil.q.toLowerCase();list=list.filter(b=>(b.numero||"").toLowerCase().includes(q)||(fournisseurName(b.fournisseurId||b.fournisseur_id)||"").toLowerCase().includes(q));}
  list=[...list].sort((a,b)=>new Date(b.createdAt||b.created_at||0)-new Date(a.createdAt||a.created_at||0));

  if(!list.length){
    html+=`<div style="padding:40px;text-align:center;color:var(--txt-3)">Aucun bon de commande</div>`;
  } else {
    const today=new Date().toISOString().slice(0,10);
    const rows=list.map(b=>{
      const fo=(DB.fournisseurs||[]).find(x=>x.id===(b.fournisseurId||b.fournisseur_id));
      const cmd=(DB.commandes||[]).find(x=>x.id===(b.commandeId||b.commande_id));
      const retard=(b.echeanceLivraison||b.echeance_livraison)&&(b.echeanceLivraison||b.echeance_livraison)<today&&b.statut!=="reçu"&&b.statut!=="annulé";
      return `<tr class="clk" onclick="openBonAchat('${b.id}')">
        <td><div class="nm tabnum">${esc(b.numero||"")}</div></td>
        <td>${esc(fo?fo.nom:"—")}</td>
        <td class="meta">${fdate(b.date||b.created_at)}</td>
        <td class="meta" style="color:${retard?"var(--danger)":""}">${fdate(b.echeanceLivraison||b.echeance_livraison)}${retard?" ⚠️":""}</td>
        <td class="r tabnum">${fcfa(b.montantTtc||b.montant_ttc||0)}</td>
        <td>${pill(b.statut||"brouillon")}</td>
        <td class="meta">${cmd?`<span style="cursor:pointer;color:var(--cyan)" onclick="event.stopPropagation();closeOverlays();openCmd('${cmd.id}')">${esc(cmd.numero||cmd.titre)}</span>`:"—"}</td>
        <td class="r" onclick="event.stopPropagation()">${wr("fournisseurs")?`<button class="btn btn-sm btn-ghost act-edit" onclick="editBonAchat('${b.id}')">✏️</button>`:""}</td>
      </tr>`;
    }).join("");
    html+=`<div style="overflow-x:auto"><table><thead><tr><th>N°</th><th>Fournisseur</th><th>Date</th><th>Livraison</th><th class="r">Montant TTC</th><th>Statut</th><th>Commande liée</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const el=document.getElementById("view");
  if(el) el.innerHTML=html;
}

function editBonAchat(id, prefill){
  if(!guard("fournisseurs"))return;
  const b=id?(DB.bonsAchat||[]).find(x=>x.id===id)||{}:(prefill||{});
  const lignes=b.lignes||[{reference:"",designation:"",unite:"U",qte:1,pu:0,remise:0}];
  const foOpts=(DB.fournisseurs||[]).filter(f=>f.actif!==false).map(f=>`<option value="${f.id}" ${(b.fournisseurId||b.fournisseur_id||"")===f.id?"selected":""}>${esc(f.nom)}</option>`).join("");
  const cmdOpts=(DB.commandes||[]).map(c=>`<option value="${c.id}" ${(b.commandeId||b.commande_id||prefill?.commandeId||"")===c.id?"selected":""}>${esc(c.numero||"")} — ${esc(clientName(c.clientId))}</option>`).join("");
  const statOpts=BA_FLOW.map(([k,l])=>`<option value="${k}" ${(b.statut||"brouillon")===k?"selected":""}>${l}</option>`).join("");
  const UNITES=["U","M²","ML","M³","Kg","L","H","Fft","Pcs","Resme","Boîte"];
  const lignesHtml=lignes.map((l,i)=>{
    const uOpts=UNITES.map(u=>`<option value="${u}" ${(l.unite||"U")===u?"selected":""}>${u}</option>`).join("");
    return`<tr><td><input style="width:78px;font-size:11px" value="${esc(l.reference||"")}" placeholder="Réf" onchange="updBaLigne(${i},'reference',this.value)"></td><td><input style="width:100%" value="${esc(l.designation)}" placeholder="Désignation" onchange="updBaLigne(${i},'designation',this.value)"></td><td><select style="width:60px;font-size:11px" onchange="updBaLigne(${i},'unite',this.value)">${uOpts}</select></td><td><input type="number" value="${l.qte}" min="0" style="width:54px" onchange="updBaLigne(${i},'qte',+this.value)"></td><td><input type="number" value="${l.pu}" min="0" style="width:88px" onchange="updBaLigne(${i},'pu',+this.value)"></td><td><input type="number" value="${l.remise||0}" min="0" max="100" style="width:50px" onchange="updBaLigne(${i},'remise',+this.value)"></td><td class="tabnum r" style="font-size:12px">${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</td><td><button type="button" class="btn btn-sm btn-ghost" onclick="delBaLigne(${i})">✕</button></td></tr>`;
  }).join("");
  const totals=calcLignes(lignes,DB.settings.tva||18);
  window._editingBa={id:id||null,lignes:JSON.parse(JSON.stringify(lignes))};
  drawer(id?"Modifier le bon d'achat":"Nouveau bon d'achat","",
    `<form id="f-ba">
    <div class="row2">
      <div class="field"><label>Fournisseur *</label><select name="fournisseurId"><option value="">— Choisir —</option>${foOpts}</select></div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${b.date||todayISO()}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Livraison prévue</label><input name="echeanceLivraison" type="date" value="${b.echeanceLivraison||b.echeance_livraison||""}"></div>
      <div class="field"><label>Statut</label><select name="statut">${statOpts}</select></div>
    </div>
    <div class="field"><label>Commande client associée (optionnel)</label><select name="commandeId"><option value="">— Aucune —</option>${cmdOpts}</select></div>
    <div class="fieldset" style="margin-top:10px">
      <div class="fs-t">Lignes à commander</div>
      <div style="overflow-x:auto"><table id="t-ba-lignes">
        <thead><tr><th style="width:80px">Réf.</th><th>Désignation</th><th style="width:65px">Unité</th><th style="width:56px">Qté</th><th style="width:90px">PU HT</th><th style="width:55px">Rem%</th><th style="width:90px" class="r">Total HT</th><th style="width:40px"></th></tr></thead>
        <tbody id="ba-lignes-body">${lignesHtml}</tbody>
      </table></div>
      <button type="button" class="btn btn-sm" style="margin-top:8px" onclick="addBaLigne()">+ Ligne</button>
    </div>
    <div class="kv-block" id="ba-totals" style="margin-top:12px">${docTotalsHTML(totals,DB.settings.tva||18)}</div>
    <div class="field"><label>Notes / Instructions</label><textarea name="notes">${esc(b.notes||"")}</textarea></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delBonAchat('${id}')`}:null,
     {label:id?"💾 Enregistrer":"Créer le bon d'achat",cls:"btn-primary",fn:`saveBonAchat('${id||""}')`}
    ].filter(Boolean)
  );
}

function updBaLigne(i,k,v){
  if(!window._editingBa)return;
  window._editingBa.lignes[i][k]=v;
  const t=calcLignes(window._editingBa.lignes,DB.settings.tva||18);
  const td=document.getElementById("ba-totals");
  if(td) td.innerHTML=docTotalsHTML(t,DB.settings.tva||18);
  const tds=[...document.querySelectorAll("#ba-lignes-body tr")];
  if(tds[i]){const cells=[...tds[i].querySelectorAll("td")];const l=window._editingBa.lignes[i];if(cells[6])cells[6].textContent=fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100));}
}

function addBaLigne(){
  if(!window._editingBa)return;
  const nl={reference:"",designation:"",unite:"U",qte:1,pu:0,remise:0};
  window._editingBa.lignes.push(nl);
  const i=window._editingBa.lignes.length-1;
  const UNITES=["U","M²","ML","M³","Kg","L","H","Fft","Pcs","Resme","Boîte"];
  const uOpts=UNITES.map(u=>`<option value="${u}" ${u==="U"?"selected":""}>${u}</option>`).join("");
  const tbody=document.getElementById("ba-lignes-body");
  if(tbody){const tr=document.createElement("tr");tr.innerHTML=`<td><input style="width:78px;font-size:11px" placeholder="Réf" onchange="updBaLigne(${i},'reference',this.value)"></td><td><input style="width:100%" placeholder="Désignation" onchange="updBaLigne(${i},'designation',this.value)"></td><td><select style="width:60px;font-size:11px" onchange="updBaLigne(${i},'unite',this.value)">${uOpts}</select></td><td><input type="number" value="1" min="0" style="width:54px" onchange="updBaLigne(${i},'qte',+this.value)"></td><td><input type="number" value="0" min="0" style="width:88px" onchange="updBaLigne(${i},'pu',+this.value)"></td><td><input type="number" value="0" min="0" max="100" style="width:50px" onchange="updBaLigne(${i},'remise',+this.value)"></td><td class="tabnum r" style="font-size:12px">0 F</td><td><button type="button" class="btn btn-sm btn-ghost" onclick="delBaLigne(${i})">✕</button></td>`;tbody.appendChild(tr);}
}

function delBaLigne(i){
  if(!window._editingBa)return;
  window._editingBa.lignes.splice(i,1);
  const id=window._editingBa.id;
  if(id){const b=(DB.bonsAchat||[]).find(x=>x.id===id);if(b)editBonAchat(id);}
  else editBonAchat("",null);
}

async function saveBonAchat(id){
  if(!guard("fournisseurs"))return;
  const f=document.getElementById("f-ba");
  if(!f){toast("Formulaire introuvable");return;}
  const fd=new FormData(f);
  if(!fd.get("fournisseurId")){toast("Fournisseur obligatoire");return;}
  const lignes=window._editingBa?window._editingBa.lignes:[{designation:"",qte:1,pu:0,remise:0}];
  const tva=DB.settings.tva||18;
  const totals=calcLignes(lignes,tva);
  const patch={
    fournisseurId:fd.get("fournisseurId"),
    date:fd.get("date")||todayISO(),
    echeanceLivraison:fd.get("echeanceLivraison")||null,
    statut:fd.get("statut")||"brouillon",
    commandeId:fd.get("commandeId")||null,
    lignes:lignes,
    montantHt:totals.montantHT,
    montantTva:totals.montantTVA,
    montantTtc:totals.montantTTC,
    notes:fd.get("notes")||""
  };
  if(id){
    const b=(DB.bonsAchat||[]).find(x=>x.id===id);
    if(b) Object.assign(b,patch);
    await dbUpsert("crm_bons_achat",{id,...patch});
  } else {
    const seq=(DB.settings.seqBonAchat||1);const year=DB.settings.year||new Date().getFullYear();
    const num="BA-"+year+"-"+String(seq).padStart(4,"0");
    const b={id:uid(),numero:num,...patch,createdAt:Date.now()};
    DB.bonsAchat=DB.bonsAchat||[];DB.bonsAchat.push(b);
    DB.settings.seqBonAchat=(seq+1);
    await dbUpsert("crm_bons_achat",b);sync("settings",DB.settings);
  }
  window._editingBa=null;closeOverlays();
  toast(id?"Bon d'achat mis à jour ✓":"Bon d'achat créé ✓");
  go("fournisseurs");
}

function openBonAchat(id){
  if(!vis("fournisseurs"))return;
  const b=(DB.bonsAchat||[]).find(x=>x.id===id);if(!b)return;
  const fo=(DB.fournisseurs||[]).find(x=>x.id===(b.fournisseurId||b.fournisseur_id));
  const cmd=(DB.commandes||[]).find(x=>x.id===(b.commandeId||b.commande_id));
  const today=new Date().toISOString().slice(0,10);
  const retard=(b.echeanceLivraison||b.echeance_livraison)&&(b.echeanceLivraison||b.echeance_livraison)<today&&b.statut!=="reçu"&&b.statut!=="annulé";

  let body=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
    ${kv("Fournisseur","<strong>"+esc(fo?fo.nom:"—")+"</strong>")}
    ${kv("Statut",pill(b.statut||"brouillon"))}
    ${kv("Date commande",fdate(b.date||b.created_at))}
    ${kv("Livraison prévue","<span style='color:"+(retard?"var(--danger)":"inherit")+"'>"+fdate(b.echeanceLivraison||b.echeance_livraison)+(retard?" ⚠️ En retard":"")+"</span>")}
    ${cmd?kv("Commande liée","<span style='cursor:pointer;color:var(--cyan)' onclick=\"closeOverlays();openCmd(\'"+cmd.id+"\')\">"+esc(cmd.numero||cmd.titre)+"</span>"):""}
  </div>`;

  body+=`<div style="overflow-x:auto;margin:8px 0"><table style="font-size:12px"><thead>
    <tr><th>Réf.</th><th>Désignation</th><th>Unité</th><th class="r">Qté</th><th class="r">PU HT</th><th class="r">Total HT</th></tr>
  </thead><tbody>
    ${(b.lignes||[]).map(l=>`<tr>
      <td style="font-family:monospace;font-size:11px">${esc(l.reference||"")}</td>
      <td>${esc(l.designation)}</td>
      <td style="text-align:center">${esc(l.unite||"U")}</td>
      <td class="r tabnum">${l.qte}</td>
      <td class="r tabnum">${fcfa(l.pu)}</td>
      <td class="r tabnum"><strong>${fcfa((l.qte||0)*(l.pu||0)*(1-(l.remise||0)/100))}</strong></td>
    </tr>`).join("")}
  </tbody></table></div>`;

  body+=`<div style="border-top:1px solid var(--ligne);padding-top:8px;margin-top:4px">
    ${kv("Montant HT",fcfa(b.montantHt||b.montant_ht||0))}
    ${kv("TVA",fcfa(b.montantTva||b.montant_tva||0))}
    ${kv("<strong>Total TTC</strong>","<strong class='tabnum' style='font-size:16px'>"+fcfa(b.montantTtc||b.montant_ttc||0)+"</strong>")}
  </div>`;

  if(b.notes) body+=kv("Notes","<span style='white-space:pre-wrap'>"+esc(b.notes)+"</span>");

  // Statuts
  body+=`<div class="fieldset" style="margin-top:12px"><div class="fs-t">Statut</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">`;
  BA_FLOW.forEach(([k,l])=>{
    const active=b.statut===k;
    body+=`<button onclick="setBaStatut('${id}','${k}')" style="padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;border:1.5px solid ${active?"var(--cyan)":"var(--ligne)"};background:${active?"var(--cyan)18":"var(--carte)"};color:${active?"var(--cyan)":"var(--txt-2)"};font-weight:600">${l}</button>`;
  });
  body+=`</div></div>`;

  drawer(b.numero||"Bon d'achat",fo?fo.nom:"",body,
    [
     wr("fournisseurs")?{label:"✏️ Modifier",cls:"btn",fn:`closeOverlays();editBonAchat('${id}')`}:null,
     wr("fournisseurs")?{label:"Supprimer",cls:"btn-danger",fn:`delBonAchat('${id}')`}:null
    ].filter(Boolean)
  );
}

function setBaStatut(id,statut){
  const b=(DB.bonsAchat||[]).find(x=>x.id===id);if(!b)return;
  b.statut=statut;
  dbUpdate("crm_bons_achat",id,{statut}).catch(e=>console.error(e));
  closeOverlays();toast("Statut mis à jour");go("fournisseurs");
}

function delBonAchat(id){
  confirmModal("Supprimer ce bon d'achat ?","",()=>{
    DB.bonsAchat=(DB.bonsAchat||[]).filter(x=>x.id!==id);
    syncDel("crm_bons_achat",id);closeOverlays();toast("Supprimé");go("fournisseurs");
  });
}

function viewCatalogue(){
  if(!vis("catalogue"))return;
  const cats=[...new Set(DB.products.map(p=>p.categorie||"Autre"))].sort();
  const stockAlertes=DB.products.filter(p=>(p.stockActuel||p.stock_actuel||0)<=(p.stockMinimum||p.stock_minimum||0)&&(p.stockMinimum||p.stock_minimum||0)>0);

  $("#pg-actions").innerHTML=`
    <button class="btn" onclick="exportExcel('catalogue')" style="border-color:#1D6F42;color:#1D6F42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>Excel</button>
    <button class="btn btn-primary act-edit" onclick="editProduct()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau produit</button>`;

  if(!DB.products.length){$("#view").innerHTML=emptyState("Catalogue vide","Ajoutez vos produits.","Nouveau produit","editProduct()");return;}

  const totalRef=DB.products.length;
  const valStock=DB.products.reduce((s,p)=>s+((p.stockActuel||p.stock_actuel||0)*(p.pu||0)),0);
  const margeAvg=DB.products.filter(p=>p.prixAchat||p.prix_achat).length?
    Math.round(DB.products.filter(p=>p.prixAchat||p.prix_achat).reduce((s,p)=>{const pa=p.prixAchat||p.prix_achat||0;return pa?s+((p.pu-pa)/p.pu*100):s},0)/DB.products.filter(p=>p.prixAchat||p.prix_achat).length):0;

  let html=`<div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span><div class="lab">Références</div><div class="val tabnum">${totalRef}</div><div class="delta">${cats.length} catégories</div></div>
    <div class="card kpi c-mag"><span class="tick"></span><div class="lab">Valeur stock</div><div class="val tabnum">${fcfa(valStock)}</div><div class="delta">HT</div></div>
    <div class="card kpi ${stockAlertes.length?"c-mag":"c-jaune"}"><span class="tick"></span><div class="lab">Alertes stock</div><div class="val tabnum">${stockAlertes.length}</div><div class="delta">${stockAlertes.length?"articles sous minimum":"Tous les stocks OK"}</div></div>
    <div class="card kpi c-noir"><span class="tick"></span><div class="lab">Marge moyenne</div><div class="val tabnum">${margeAvg}%</div><div class="delta">Sur articles avec prix achat</div></div>
  </div>`;

  if(stockAlertes.length){
    html+=`<div class="card panel" style="margin-bottom:16px;border-left:3px solid var(--danger)">
      <div class="panel-h"><h3 style="color:var(--danger)">⚠️ Alertes stock (${stockAlertes.length} articles)</h3></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${stockAlertes.slice(0,6).map(p=>`<span class="pill p-red"><span class="dot"></span>${esc(p.designation)} — stock: ${p.stockActuel||p.stock_actuel||0}</span>`).join("")}</div>
    </div>`;
  }

  html+=cats.map(cat=>{
    const prods=DB.products.filter(p=>(p.categorie||"Autre")===cat);
    return`<div class="card" style="margin-bottom:16px">
      <div class="panel-h" style="padding:12px 16px 0"><h3 style="font-size:13px;color:var(--txt-2)">${esc(cat)} <span class="micro">${prods.length} articles</span></h3></div>
      <div style="overflow-x:auto"><table><thead><tr>
        <th>Réf.</th><th>Désignation</th><th class="r">Prix vente HT</th><th class="r">Prix achat</th>
        <th class="r">Marge</th><th class="c">TVA</th><th class="r">Prix TTC</th>
        <th class="c">Stock</th><th class="c">Min.</th><th>Fournisseur</th><th></th>
      </tr></thead><tbody>
      ${prods.map(p=>{
        const pa=p.prixAchat||p.prix_achat||0;
        const marge=pa&&p.pu?Math.round((p.pu-pa)/p.pu*100):null;
        const tva=p.tvaTaux||p.tva_taux||18;
        const ttc=Math.round(p.pu*(1+tva/100));
        const stock=p.stockActuel||p.stock_actuel||0;
        const stmin=p.stockMinimum||p.stock_minimum||0;
        const alerte=stmin>0&&stock<=stmin;
        return`<tr class="clk" onclick="editProduct('${p.id}')">
          <td class="meta" style="font-family:monospace;font-size:11px">${esc(p.reference||p.ref||"—")}</td>
          <td><div class="nm">${esc(p.designation)}</div>${p.description?`<div class="meta">${esc(p.description.slice(0,50))}</div>`:""}</td>
          <td class="r tabnum">${fcfa(p.pu)}</td>
          <td class="r tabnum ${pa?"":" muted"}">${pa?fcfa(pa):"—"}</td>
          <td class="r">
            ${marge!==null?`<span class="pill ${marge>=30?"p-green":marge>=15?"p-amber":"p-red"}">${marge}%</span>`:"—"}</td>
          <td class="c">${tva}%</td>
          <td class="r tabnum">${fcfa(ttc)}</td>
          <td class="c ${alerte?"text-danger":""}"><strong>${stock}</strong></td>
          <td class="c muted">${stmin||"—"}</td>
          <td class="meta">${esc(fournisseurName(p.fournisseurId||p.fournisseur_id))}</td>
          <td class="r" onclick="event.stopPropagation()"><button class="btn btn-sm btn-ghost act-edit" onclick="editProduct('${p.id}')">Modifier</button></td>
        </tr>`;
      }).join("")}
      </tbody></table></div></div>`;
  }).join("");
  $("#view").innerHTML=html;
}

function editProduct(id){
  if(!guard("catalogue"))return;
  const p=id?DB.products.find(x=>x.id===id):{designation:"",reference:"",description:"",categorie:"",pu:0,prixAchat:0,tvaTaux:18,stockActuel:0,stockMinimum:0,unite:"unité",fournisseurId:""};
  const cats=["Impression","Grand format","Gadgets","Fournitures de bureau","Création","Bloc notes","Stylos","USB & Powerbanks","Sacs & Accessoires","Coffrets","Autre"];
  const foOpts=DB.fournisseurs.filter(f=>f.actif!==false).map(f=>`<option value="${f.id}" ${(p.fournisseurId||p.fournisseur_id)===f.id?"selected":""}>${esc(f.nom)}</option>`).join("");
  drawer(id?"Modifier le produit":"Nouveau produit","",
    `<form id="f-prod">
    <div class="row2">
      <div class="field"><label>Désignation *</label><input name="designation" value="${esc(p.designation)}" required></div>
      <div class="field"><label>Référence</label><input name="reference" value="${esc(p.reference||p.ref||"")}" style="font-family:monospace"></div>
    </div>
    <div class="field"><label>Description</label><textarea name="description" style="min-height:54px">${esc(p.description||"")}</textarea></div>
    <div class="row2">
      <div class="field"><label>Catégorie</label><select name="categorie">${cats.map(c=>`<option ${(p.categorie||"")==c?"selected":""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Unité</label><input name="unite" value="${esc(p.unite||"unité")}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Prix vente HT (F CFA)</label><input name="pu" type="number" value="${p.pu||0}" min="0" id="p-pu" oninput="calcMargePrev()"></div>
      <div class="field"><label>Prix d'achat HT (F CFA)</label><input name="prixAchat" type="number" value="${p.prixAchat||p.prix_achat||0}" min="0" id="p-pa" oninput="calcMargePrev()"></div>
    </div>
    <div class="row2">
      <div class="field"><label>TVA (%)</label><input name="tvaTaux" type="number" value="${p.tvaTaux||p.tva_taux||18}" min="0" max="100" id="p-tva" oninput="calcMargePrev()"></div>
      <div class="field" id="marge-prev" style="padding-top:22px;font-size:13px"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Stock actuel</label><input name="stockActuel" type="number" value="${p.stockActuel||p.stock_actuel||0}" min="0"></div>
      <div class="field"><label>Stock minimum (alerte)</label><input name="stockMinimum" type="number" value="${p.stockMinimum||p.stock_minimum||0}" min="0"></div>
    </div>
    <div class="field"><label>Fournisseur principal</label>
      <select name="fournisseurId"><option value="">— Aucun —</option>${foOpts}</select></div>
    </form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delProduct('${id}')`}:null,
     {label:id?"💾 Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveProduct('${id||""}')`}].filter(Boolean)
  );
  setTimeout(calcMargePrev,50);
}
function calcMargePrev(){
  const pu=+(document.getElementById("p-pu")||{}).value||0;
  const pa=+(document.getElementById("p-pa")||{}).value||0;
  const tva=+(document.getElementById("p-tva")||{}).value||18;
  const el=document.getElementById("marge-prev");if(!el)return;
  const ttc=Math.round(pu*(1+tva/100));
  const marge=pu&&pa?Math.round((pu-pa)/pu*100):null;
  el.innerHTML=`<div style="color:var(--txt-2);font-size:11px">Prix TTC</div>
    <div style="font-weight:700;font-size:15px">${fcfa(ttc)}</div>
    ${marge!==null?`<div class="pill ${marge>=30?"p-green":marge>=15?"p-amber":"p-red"}" style="margin-top:4px">Marge : ${marge}%</div>`:""}`;
}
function saveProduct(id){
  if(!guard("catalogue"))return;
  const f=document.getElementById("f-prod");const fd=new FormData(f);
  if(!fd.get("designation").trim()){toast("Désignation obligatoire");return}
  const data={designation:fd.get("designation"),reference:fd.get("reference"),description:fd.get("description"),categorie:fd.get("categorie"),pu:+fd.get("pu")||0,prixAchat:+fd.get("prixAchat")||0,tvaTaux:+fd.get("tvaTaux")||18,stockActuel:+fd.get("stockActuel")||0,stockMinimum:+fd.get("stockMinimum")||0,unite:fd.get("unite")||"unité",fournisseurId:fd.get("fournisseurId")||null};
  if(id){const x=DB.products.find(p=>p.id===id);Object.assign(x,data);sync("products",x);}
  else{const x={...data,id:uid(),createdAt:new Date().toISOString()};DB.products.push(x);sync("products",x);}
  closeOverlays();toast(id?"Produit mis à jour":"Produit ajouté");go(current);
}
function delProduct(id){if(!guard("catalogue"))return;confirmModal("Supprimer ce produit ?","",()=>{DB.products=DB.products.filter(x=>x.id!==id);syncDel("products",id);closeOverlays();toast("Produit supprimé");go("catalogue")})}

/* ============================================================
   COMPTABILITÉ V2 — Journal, TVA déclaration, P&L, Trésorerie
   ============================================================ */
function viewCompta(){
  if(!vis("compta"))return;
  window._comptaTab = window._comptaTab||"saisie";
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const y=new Date().getFullYear();
  let caHT=0,totalChg=0,tvaC=0,tvaD=0;
  DB.factures.forEach(f=>{if(new Date(f.date||0).getFullYear()===y){caHT+=f.montantHT||0;tvaC+=f.montantTVA||0;}});
  DB.depenses.forEach(d=>{if(new Date(d.date||0).getFullYear()===y){totalChg+=d.ht||0;tvaD+=d.tva||0;}});
  const resultat=caHT-totalChg;

  $("#pg-title").textContent="Comptabilité";
  $("#pg-sub").textContent="Exercice "+y+" — SYSCOHADA · Régime Réel Simplifié";
  $("#pg-actions").innerHTML=`
    <button class="btn" style="border-color:#1D6F42;color:#1D6F42" onclick="exportExcel('depenses')">📊 Excel</button>
    <button class="btn" onclick="openBalance()" style="border-color:var(--mag);color:var(--mag)">Balance</button>
    <button class="btn" onclick="openSaisieCompta()" style="border-color:var(--cyan);color:var(--cyan)">✏️ Écriture OD</button>
    ${wr("compta")?`<button class="btn btn-primary act-edit" onclick="editDepense()">+ Dépense</button>`:""}
  `;

  const tabs=[
    {k:"saisie",l:"📝 Journal de saisie"},
    {k:"grandlivre",l:"📒 Grand Livre"},
    {k:"plan",l:"📋 Plan comptable"},
    {k:"depenses",l:"💸 Dépenses"},
  ];

  $("#view").innerHTML=`
  <div class="grid kpis" style="margin-bottom:14px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">CA HT ${y}</div><div class="val tabnum">${fmt(caHT)}</div></div>
    <div class="card kpi c-rouge"><span class="tick"></span>
      <div class="lab">Charges HT</div><div class="val tabnum">${fmt(totalChg)}</div></div>
    <div class="card kpi ${resultat>=0?"c-noir":"c-rouge"}"><span class="tick"></span>
      <div class="lab">Résultat net</div>
      <div class="val tabnum" style="color:${resultat>=0?"var(--ok)":"var(--danger)"}">${fmt(resultat)}</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">TVA à reverser</div>
      <div class="val tabnum">${fmt(Math.max(0,tvaC-tvaD))}</div></div>
  </div>
  <div style="display:flex;gap:2px;border-bottom:2px solid var(--ligne);margin-bottom:0">
    ${tabs.map(t=>`<button onclick="switchComptaTab('${t.k}')" id="tab-${t.k}"
      style="padding:8px 18px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;font-weight:600;
      background:${window._comptaTab===t.k?"var(--carte)":"transparent"};
      color:${window._comptaTab===t.k?"var(--cyan)":"var(--txt-2)"};
      border-bottom:${window._comptaTab===t.k?"3px solid var(--cyan)":"3px solid transparent"};
      margin-bottom:-2px">${t.l}</button>`).join("")}
  </div>
  <div id="compta-tab-content" style="padding-top:14px"></div>`;
  renderComptaTab();
}

function switchComptaTab(tab){
  window._comptaTab=tab;
  document.querySelectorAll("[id^='tab-']").forEach(b=>{
    const k=b.id.replace("tab-","");
    const a=k===tab;
    b.style.background=a?"var(--carte)":"transparent";
    b.style.color=a?"var(--cyan)":"var(--txt-2)";
    b.style.borderBottom=a?"3px solid var(--cyan)":"3px solid transparent";
  });
  renderComptaTab();
}

function renderComptaTab(){
  const tab=window._comptaTab||"saisie";
  const el=document.getElementById("compta-tab-content"); if(!el)return;
  if(tab==="saisie")      renderJournalSaisie(el);
  else if(tab==="grandlivre") renderGrandLivre(el);
  else if(tab==="plan")   renderPlanComptable(el);
  else if(tab==="depenses") renderDepCompta(el);
}


function editDepense(id){
  if(!guard("compta"))return;
  const d=id?DB.depenses.find(x=>x.id===id):{date:todayISO(),libelle:"",numeroPiece:"",categorie:"",fournisseurId:"",modePaiement:"Virement",statutPaiement:"payé",echeance:"",ht:0,tva:0,ttc:0};
  const cats=["Achats matières","Charges fixes","Services externes","Frais de déplacement","Marketing","Maintenance","Loyer","Salaires","Impôts & taxes","Autre"];
  const modes=["Virement","Espèces","Chèque","Mobile Money","Carte bancaire"];
  const foOpts=DB.fournisseurs.filter(f=>f.actif!==false).map(f=>`<option value="${f.id}" ${(d.fournisseurId||d.fournisseur_id)===f.id?"selected":""}>${esc(f.nom)}</option>`).join("");
  drawer(id?"Modifier la dépense":"Nouvelle dépense","",
    `<form id="f-dep">
    <div class="row2">
      <div class="field"><label>Libellé *</label><input name="libelle" value="${esc(d.libelle)}" required></div>
      <div class="field"><label>N° Pièce / Facture fournisseur</label><input name="numeroPiece" value="${esc(d.numeroPiece||d.numero_piece||"")}" style="font-family:monospace"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Date</label><input name="date" type="date" value="${d.date||todayISO()}"></div>
      <div class="field"><label>Échéance</label><input name="echeance" type="date" value="${d.echeance||""}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Catégorie</label><select name="categorie">${cats.map(c=>`<option ${(d.categorie||"")==c?"selected":""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Fournisseur</label><select name="fournisseurId"><option value="">— Aucun —</option>${foOpts}</select></div>
    </div>
    <div class="row2">
      <div class="field"><label>Mode de paiement</label><select name="modePaiement">${modes.map(m=>`<option ${(d.modePaiement||d.mode_paiement||"Virement")===m?"selected":""}>${m}</option>`).join("")}</select></div>
      <div class="field"><label>Statut paiement</label><select name="statutPaiement">
        <option value="payé" ${(d.statutPaiement||d.statut_paiement||"payé")==="payé"?"selected":""}>Payé</option>
        <option value="en attente" ${(d.statutPaiement||d.statut_paiement)==="en attente"?"selected":""}>En attente</option>
      </select></div>
    </div>
    <div class="row3">
      <div class="field"><label>Montant HT (F)</label><input name="ht" type="number" value="${d.ht||0}" min="0" oninput="calcDep()"></div>
      <div class="field"><label>TVA (F)</label><input name="tva" type="number" value="${d.tva||0}" min="0" oninput="calcDep()"></div>
      <div class="field"><label>Total TTC (F)</label><input name="ttc" id="dep-ttc" type="number" value="${d.ttc||0}" min="0"></div>
    </div></form>`,
    [id?{label:"Supprimer",cls:"btn-danger",fn:`delDepense('${id}')`}:null,
     {label:id?"💾 Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveDepense('${id||""}')`}].filter(Boolean)
  );
}

/* ============================================================
   ENTREPÔT & STOCK — Mouvements, niveaux, alertes
   ============================================================ */
function viewEntrepot(){
  if(!vis("entrepot"))return;
  window._entrepotTab = window._entrepotTab||"stock";
  const dev = DB.settings.devise||"F CFA";
  const fmt = n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const prods = DB.products||[];
  const enAlerte   = prods.filter(p=>(p.stock_actuel||0)<=(p.stock_minimum||p.stock_min||0)&&(p.stock_minimum||p.stock_min||0)>0);
  const valeurStock = prods.reduce((s,p)=>s+(+p.stock_actuel||0)*(+p.prix_achat||+p.pu||0),0);
  const totalMvt    = (DB.stockMvt||[]).length;

  $("#pg-title").textContent = "Entrepôt & Stock";
  $("#pg-sub").textContent   = `${prods.length} produits · Valeur stock : ${fmt(valeurStock)}`;
  $("#pg-actions").innerHTML = wr("entrepot")?`
    ${wr("catalogue")?`<button class="btn" onclick="go('catalogue')">📦 Nouveau produit</button>`:""}
    <button class="btn" onclick="openInventaire()" style="border-color:var(--mag);color:var(--mag)">📋 Inventaire</button>
    <button class="btn btn-primary" onclick="openMvtStock()">➕ Mouvement de stock</button>`:"";

  const tabs=[
    {k:"stock",      l:"📦 Stock actuel"},
    {k:"mouvements", l:"🔄 Mouvements"},
    {k:"alertes",    l:`⚠️ Alertes${enAlerte.length?` <span style="background:var(--danger);color:#fff;border-radius:10px;padding:0 6px;font-size:10px">${enAlerte.length}</span>`:""}` },
    {k:"inventaire", l:"📋 Inventaire"},
  ];

  $("#view").innerHTML=`
  <!-- KPIs -->
  <div class="grid kpis" style="margin-bottom:14px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">Produits en stock</div>
      <div class="val">${prods.filter(p=>(p.stock_actuel||0)>0).length} / ${prods.length}</div></div>
    <div class="card kpi c-jaune"><span class="tick"></span>
      <div class="lab">Valeur totale</div>
      <div class="val tabnum" style="font-size:18px">${fmt(valeurStock)}</div></div>
    <div class="card kpi ${enAlerte.length?"c-rouge":"c-noir"}"><span class="tick"></span>
      <div class="lab">Alertes stock bas</div>
      <div class="val" style="color:${enAlerte.length?"var(--danger)":"inherit"}">${enAlerte.length}</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">Mouvements</div>
      <div class="val">${totalMvt}</div></div>
  </div>

  <!-- Onglets -->
  <div style="display:flex;gap:2px;border-bottom:2px solid var(--ligne);margin-bottom:0">
    ${tabs.map(t=>`<button onclick="switchEntrepotTab('${t.k}')" id="etab-${t.k}"
      style="padding:8px 16px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;font-weight:600;
      background:${window._entrepotTab===t.k?"var(--carte)":"transparent"};
      color:${window._entrepotTab===t.k?"var(--cyan)":"var(--txt-2)"};
      border-bottom:${window._entrepotTab===t.k?"3px solid var(--cyan)":"3px solid transparent"};
      margin-bottom:-2px">${t.l}</button>`).join("")}
  </div>
  <div id="entrepot-tab-content" style="padding-top:14px"></div>`;

  renderEntrepotTab();
}

function switchEntrepotTab(tab){
  window._entrepotTab=tab;
  document.querySelectorAll("[id^='etab-']").forEach(b=>{
    const k=b.id.replace("etab-",""), a=k===tab;
    b.style.background=a?"var(--carte)":"transparent";
    b.style.color=a?"var(--cyan)":"var(--txt-2)";
    b.style.borderBottom=a?"3px solid var(--cyan)":"3px solid transparent";
  });
  renderEntrepotTab();
}

function renderEntrepotTab(){
  const tab=window._entrepotTab||"stock";
  const el=document.getElementById("entrepot-tab-content"); if(!el)return;
  if(tab==="stock")      renderOngletStock(el);
  else if(tab==="mouvements") renderOngletMouvements(el);
  else if(tab==="alertes")    renderOngletAlertes(el);
  else if(tab==="inventaire") renderOngletInventaire(el);
}

function renderOngletStock(el){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const prods=DB.products||[];
  const cats=[...new Set(prods.map(p=>p.categorie).filter(Boolean))].sort();
  const cat=window._entropCat||"";
  const alerte=window._entropAlerte||"";

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Niveaux de stock</h3><div class="spacer"></div>
      <input id="srch-stock" placeholder="🔍 Rechercher..." oninput="renderStockList()" value="${window._entropSrch||""}"
        style="padding:7px 12px;border:1.5px solid var(--ligne);border-radius:8px;background:var(--carte);color:var(--txt-1);width:180px;font-size:12px">
      <select id="fil-stock-cat" onchange="window._entropCat=this.value;renderStockList()" style="width:150px">
        <option value="">Toutes catégories</option>
        ${cats.map(c=>`<option value="${c}" ${c===cat?"selected":""}>${c}</option>`).join("")}
      </select>
      <select id="fil-stock-alerte" onchange="window._entropAlerte=this.value;renderStockList()" style="width:140px">
        <option value="">Tous</option>
        <option value="alerte" ${alerte==="alerte"?"selected":""}>⚠️ Alertes</option>
        <option value="ok" ${alerte==="ok"?"selected":""}>✅ OK</option>
        <option value="vide" ${alerte==="vide"?"selected":""}>📭 Vide</option>
      </select>
    </div>
    <div id="stock-list"></div>
  </div>`;
  renderStockList();
}

function renderOngletMouvements(el){
  const type=window._entropType||"";
  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Historique des mouvements</h3><div class="spacer"></div>
      <select id="fil-mvt-type" onchange="window._entropType=this.value;renderMvtList()" style="width:160px">
        <option value="" ${!type?"selected":""}>Tous types</option>
        <option value="entree"  ${type==="entree"?"selected":""}>📥 Entrées</option>
        <option value="sortie"  ${type==="sortie"?"selected":""}>📤 Sorties</option>
        <option value="ajustement" ${type==="ajustement"?"selected":""}>⚙️ Ajustements</option>
        <option value="inventaire" ${type==="inventaire"?"selected":""}>📋 Inventaires</option>
      </select>
      ${wr("entrepot")?`<button class="btn btn-primary" onclick="openMvtStock()">+ Mouvement</button>`:""}
    </div>
    <div id="mvt-list"></div>
  </div>`;
  renderMvtList();
}

function renderOngletAlertes(el){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const prods=DB.products||[];
  const enAlerte=prods.filter(p=>(p.stock_actuel||0)<=(p.stock_minimum||p.stock_min||0)&&(p.stock_minimum||p.stock_min||0)>0);
  const vides=prods.filter(p=>(p.stock_actuel||0)===0&&(!p.stock_minimum&&!p.stock_min));

  el.innerHTML=`
  ${enAlerte.length===0&&vides.length===0?`
  <div class="card panel">
    <div style="padding:32px;text-align:center">
      <div style="font-size:40px;margin-bottom:8px">✅</div>
      <div style="font-size:15px;font-weight:700">Tous les stocks sont en ordre</div>
      <div class="meta">Aucun produit sous le seuil minimum</div>
    </div>
  </div>`:""}

  ${enAlerte.length?`
  <div class="card panel" style="border-left:3px solid var(--danger);margin-bottom:14px">
    <div class="panel-h">
      <h3 style="color:var(--danger)">⚠️ Produits sous le seuil minimum (${enAlerte.length})</h3>
    </div>
    <div style="overflow-x:auto"><table style="font-size:12px"><thead><tr>
      <th>Produit</th><th>Référence</th><th>Catégorie</th>
      <th class="r">Stock actuel</th><th class="r">Seuil min.</th><th class="r">Manque</th><th class="r">Valeur</th><th></th>
    </tr></thead><tbody>
    ${enAlerte.sort((a,b)=>(a.stock_actuel||0)-(b.stock_actuel||0)).map(p=>{
      const manque=(p.stock_minimum||p.stock_min||0)-(p.stock_actuel||0);
      const val=(p.stock_actuel||0)*(+p.prix_achat||+p.pu||0);
      return`<tr>
        <td><div class="nm">${esc(p.designation||p.nom||"")}</div></td>
        <td class="meta">${esc(p.reference||"—")}</td>
        <td><span class="pill p-grey" style="font-size:10px">${esc(p.categorie||"—")}</span></td>
        <td class="r tabnum" style="color:var(--danger);font-weight:700">${p.stock_actuel||0}</td>
        <td class="r tabnum">${p.stock_minimum||p.stock_min||0}</td>
        <td class="r tabnum" style="color:var(--warn);font-weight:600">${manque}</td>
        <td class="r tabnum meta">${val?fmt(val):"—"}</td>
        <td>${wr("entrepot")?`<button class="btn btn-sm btn-primary" onclick="openMvtStock('${p.id}')">Commander</button>`:""}
        </td>
      </tr>`;
    }).join("")}
    </tbody></table></div>
  </div>`:""}

  ${vides.length?`
  <div class="card panel" style="border-left:3px solid var(--txt-3)">
    <div class="panel-h"><h3 style="color:var(--txt-2)">📭 Produits à stock zéro (${vides.length})</h3></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:6px">
    ${vides.slice(0,20).map(p=>`
      <div style="padding:6px 12px;border-radius:6px;border:1px solid var(--ligne);font-size:11px">
        <div style="font-weight:600">${esc(p.designation||p.nom||"")}</div>
        <div class="meta">${esc(p.reference||p.categorie||"—")}</div>
      </div>`).join("")}
    </div>
  </div>`:""}`;
}

function renderOngletInventaire(el){
  const prods=DB.products||[];
  const lastInv=(DB.stockMvt||[]).filter(m=>m.type_mvt==="inventaire")
    .sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const lastDate=lastInv[0]?.date;

  el.innerHTML=`
  <div class="card panel" style="margin-bottom:14px">
    <div class="panel-h">
      <div>
        <h3>📋 Inventaire physique</h3>
        ${lastDate?`<div class="meta">Dernier inventaire : ${new Date(lastDate).toLocaleDateString("fr-FR")}</div>`:`<div class="meta">Aucun inventaire effectué</div>`}
      </div>
      <div class="spacer"></div>
      ${wr("entrepot")?`<button class="btn btn-primary" onclick="openInventaire()">Saisir un inventaire</button>`:""}
    </div>
    <p style="font-size:12px;color:var(--txt-2);margin-top:8px">
      L'inventaire physique permet de corriger les quantités réelles en stock en comparant ce que vous avez physiquement
      avec ce que le système affiche. Chaque correction génère un mouvement de type "Inventaire".
    </p>
  </div>

  <!-- Résumé des produits -->
  <div class="card panel">
    <div class="panel-h"><h3>État du stock par catégorie</h3></div>
    ${(()=>{
      const cats=[...new Set(prods.map(p=>p.categorie||"Sans catégorie"))].sort();
      return cats.map(cat=>{
        const items=prods.filter(p=>(p.categorie||"Sans catégorie")===cat);
        const totalQte=items.reduce((s,p)=>s+(+p.stock_actuel||0),0);
        const alertes=items.filter(p=>(p.stock_actuel||0)<=(p.stock_minimum||p.stock_min||0)&&(p.stock_minimum||p.stock_min||0)>0).length;
        return`<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--ligne)">
          <div style="min-width:160px;font-size:12px;font-weight:600">${esc(cat)}</div>
          <div style="flex:1;height:8px;background:var(--ligne);border-radius:4px;overflow:hidden">
            <div style="width:${Math.min(100,totalQte/10)}%;height:100%;background:var(--cyan);border-radius:4px"></div>
          </div>
          <div style="font-size:11px;color:var(--txt-2);min-width:80px;text-align:right">${items.length} produit(s)</div>
          <div style="font-size:11px;font-weight:700;min-width:60px;text-align:right">${totalQte} unités</div>
          ${alertes?`<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--danger)18;color:var(--danger);font-weight:700">⚠️ ${alertes}</span>`:`<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--ok)18;color:var(--ok)">✅</span>`}
        </div>`;
      }).join("");
    })()}
  </div>

  <!-- Derniers inventaires -->
  ${lastInv.length?`
  <div class="card panel" style="margin-top:14px">
    <div class="panel-h"><h3>Historique des inventaires</h3></div>
    <table style="font-size:12px"><thead><tr>
      <th>Date</th><th>Produit</th><th>Qté avant</th><th>Qté après</th><th>Écart</th><th>Note</th>
    </tr></thead><tbody>
    ${lastInv.slice(0,20).map(m=>`<tr>
      <td class="meta">${new Date(m.date||0).toLocaleDateString("fr-FR")}</td>
      <td><div class="nm">${esc(m.produit_nom||"—")}</div></td>
      <td class="r tabnum">${m.stock_avant??"-"}</td>
      <td class="r tabnum">${m.stock_apres??"-"}</td>
      <td class="r tabnum" style="color:${(m.stock_apres-m.stock_avant)>=0?"var(--ok)":"var(--danger)"};font-weight:700">
        ${(m.stock_apres-m.stock_avant)>=0?"+":""}${(m.stock_apres||0)-(m.stock_avant||0)}
      </td>
      <td class="meta">${esc(m.note||m.notes||"—")}</td>
    </tr>`).join("")}
    </tbody></table>
  </div>`:""}`;
}


function renderStockList(){
  const cat = document.getElementById("fil-stock-cat")?.value||window._entropCat||"";
  const alerte = document.getElementById("fil-stock-alerte")?.value||window._entropAlerte||"";
  const q = (document.getElementById("srch-stock")?.value||window._entropSrch||"").toLowerCase();
  if(document.getElementById("srch-stock")) window._entropSrch=document.getElementById("srch-stock").value;
  let rows = (DB.products||[]).filter(p=>
    (!cat||p.categorie===cat)&&
    (!q||(p.designation||p.nom||"").toLowerCase().includes(q)||(p.reference||"").toLowerCase().includes(q))&&
    (!alerte||(alerte==="alerte"?(p.stock_actuel||0)<=(p.stock_minimum||0)&&(p.stock_minimum||0)>0:
               (p.stock_actuel||0)>(p.stock_minimum||0)))
  ).sort((a,b)=>(a.designation||"").localeCompare(b.designation||""));
  const el=document.getElementById("stock-list"); if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty">Aucun produit</div>`;return;}
  el.innerHTML=`<table><thead><tr>
    <th>Réf</th><th>Désignation</th><th>Catégorie</th>
    <th class="r">Stock actuel</th><th class="r">Min</th><th class="r">P. Achat</th><th>État</th>
    ${wr("entrepot")?`<th></th>`:""}
  </tr></thead><tbody>
  ${rows.map(p=>{
    const enAl=(p.stock_actuel||0)<=(p.stock_minimum||0)&&(p.stock_minimum||0)>0;
    return`<tr>
      <td class="meta">${esc(p.reference||"—")}</td>
      <td><div class="nm">${esc(p.designation||"")}</div></td>
      <td class="meta">${esc(p.categorie||"—")}</td>
      <td class="r tabnum" style="font-weight:700;color:${enAl?"var(--danger)":"var(--ok)"}">${p.stock_actuel||0}</td>
      <td class="r tabnum meta">${p.stock_minimum||0}</td>
      <td class="r tabnum meta">${Math.round(p.prix_achat||0).toLocaleString("fr-FR")}</td>
      <td>${enAl?`<span class="pill p-red" style="font-size:10px">⚠️ Bas</span>`:`<span class="pill p-green" style="font-size:10px">✅ OK</span>`}</td>
      ${wr("entrepot")?`<td><button class="btn btn-sm btn-ghost" onclick="openMvtStock('${p.id}')">Mvt</button></td>`:""}
    </tr>`;
  }).join("")}
  </tbody></table>`;
}

function renderMvtList(){
  const type=document.getElementById("fil-mvt-type")?.value||"";
  const rows=(DB.stockMvt||[]).filter(m=>!type||m.type_mvt===type)
    .sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const mvtPill={entree:`<span class="pill p-green" style="font-size:10px">Entrée</span>`,
    sortie:`<span class="pill p-red" style="font-size:10px">Sortie</span>`,
    ajustement:`<span class="pill p-amber" style="font-size:10px">Ajustement</span>`,
    inventaire:`<span class="pill p-cyan" style="font-size:10px">Inventaire</span>`};
  const el=document.getElementById("mvt-list"); if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty">Aucun mouvement</div>`;return;}
  el.innerHTML=`<table><thead><tr>
    <th>Date</th><th>Produit</th><th>Type</th><th>Motif</th>
    <th class="r">Qté</th><th class="r">Avant</th><th class="r">Après</th>
    <th>Référence</th><th>Note</th>
  </tr></thead><tbody>
  ${rows.map(m=>`<tr>
    <td class="meta">${m.date?new Date(m.date).toLocaleDateString("fr-FR"):"—"}</td>
    <td><div class="nm">${esc(m.produit_nom||"—")}</div></td>
    <td>${mvtPill[m.type_mvt]||m.type_mvt}</td>
    <td class="meta">${esc(m.motif||"—")}</td>
    <td class="r tabnum" style="font-weight:700;color:${m.type_mvt==="entree"?"var(--ok)":"var(--danger)"}">
      ${m.type_mvt==="entree"?"+":"−"}${m.quantite}
    </td>
    <td class="r tabnum meta">${m.stock_avant||0}</td>
    <td class="r tabnum meta">${m.stock_apres||0}</td>
    <td class="meta">${esc(m.reference||"—")}</td>
    <td class="meta">${esc(m.note||"")}</td>
  </tr>`).join("")}
  </tbody></table>`;
}

function openMvtStock(prodId){
  if(!wr("entrepot"))return;
  const prodOpts=(DB.products||[]).map(p=>`<option value="${p.id}" ${prodId===p.id?"selected":""}>${esc(p.reference?"["+p.reference+"] ":"")}${esc(p.designation||"")}</option>`).join("");
  modal(`<h2>Nouveau mouvement de stock</h2>
  <div class="two">
    <div class="field"><label>Date *</label><input id="mvt-date" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Type *</label>
      <select id="mvt-type">
        <option value="entree">📥 Entrée de stock</option>
        <option value="sortie">📤 Sortie de stock</option>
        <option value="ajustement">⚙️ Ajustement</option>
        <option value="inventaire">📋 Inventaire</option>
      </select>
    </div>
  </div>
  <div class="field"><label>Produit *</label>
    <select id="mvt-prod" onchange="loadStockActuel()">
      <option value="">-- Sélectionner un produit --</option>${prodOpts}
    </select>
  </div>
  <div class="two">
    <div class="field"><label>Quantité *</label><input id="mvt-qte" type="number" min="0" step="1" value="1"></div>
    <div class="field"><label>Stock actuel</label><input id="mvt-stock-actuel" type="number" readonly style="background:var(--papier)" value="0"></div>
  </div>
  <div class="two">
    <div class="field"><label>Motif</label>
      <select id="mvt-motif">
        <option value="achat">Achat fournisseur</option>
        <option value="vente">Vente client</option>
        <option value="retour">Retour client</option>
        <option value="perte">Perte / Casse</option>
        <option value="transfert">Transfert</option>
        <option value="ajustement">Ajustement inventaire</option>
      </select>
    </div>
    <div class="field"><label>Référence (facture/cmd)</label><input id="mvt-ref" placeholder="FAC-2026-xxxx"></div>
  </div>
  <div class="field"><label>Emplacement</label><input id="mvt-empl" placeholder="ex : Rayon A3, Étagère 2"></div>
  <div class="field"><label>Note</label><textarea id="mvt-note" rows="2"></textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveMvtStock()">Enregistrer</button>
  </div>`);
  if(prodId) loadStockActuel();
}

function loadStockActuel(){
  const sel=document.getElementById("mvt-prod");
  const pid=sel?.value;
  const p=pid?(DB.products||[]).find(x=>x.id===pid):null;
  const el=document.getElementById("mvt-stock-actuel");
  if(el) el.value=p?p.stock_actuel||0:0;
}

async function saveMvtStock(){
  const gv=id=>document.getElementById(id)?.value?.trim()||"";
  const prodId=gv("mvt-prod");
  if(!prodId){toast("Sélectionnez un produit");return;}
  const prod=(DB.products||[]).find(p=>p.id===prodId);
  if(!prod){toast("Produit introuvable");return;}
  const qte=+document.getElementById("mvt-qte").value||0;
  if(!qte){toast("Quantité invalide");return;}
  const typeMvt=gv("mvt-type");
  const stockAvant=+prod.stock_actuel||0;
  const stockApres=typeMvt==="entree"?stockAvant+qte:
                   typeMvt==="sortie"?Math.max(0,stockAvant-qte):
                   typeMvt==="inventaire"?qte : stockAvant+(qte);
  const mvt={
    id:crypto.randomUUID(), date:gv("mvt-date"),
    produit_id:prodId, produit_nom:prod.designation||"",
    type_mvt:typeMvt, quantite:qte, stock_avant:stockAvant, stock_apres:stockApres,
    motif:gv("mvt-motif"), reference:gv("mvt-ref"),
    emplacement:gv("mvt-empl"), note:document.getElementById("mvt-note")?.value?.trim()||"",
  };
  const ok=await dbUpsert("crm_stock_mouvements",mvt);
  if(!ok)return;
  // MAJ stock produit
  const patchOk=await dbUpdate("products",prodId,{stock_actuel:stockApres});
  if(patchOk){
    const i=(DB.products||[]).findIndex(p=>p.id===prodId);
    if(i>=0) DB.products[i].stock_actuel=stockApres;
  }
  (DB.stockMvt=DB.stockMvt||[]).push(mvt);
  toast(`✅ ${typeMvt==="entree"?"Entrée":"Sortie"} enregistrée — Stock : ${stockApres}`);
  closeOverlays(); go("entrepot");
}

function openInventaire(){
  if(!wr("entrepot"))return;
  modal(`<h2>📋 Saisie d'inventaire</h2>
  <p style="font-size:12px;color:var(--txt-2);margin-bottom:12px">Corrigez les quantités réelles. Laissez vide pour ne pas modifier.</p>
  <div style="max-height:400px;overflow-y:auto">
  <table><thead><tr><th>Produit</th><th>Réf</th><th>Stock actuel</th><th>Qté réelle</th></tr></thead>
  <tbody id="inv-body"></tbody></table>
  </div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveInventaire()">Valider l'inventaire</button>
  </div>`);
  const tbody=document.getElementById("inv-body");
  if(tbody) tbody.innerHTML=(DB.products||[])
    .sort((a,b)=>(a.designation||"").localeCompare(b.designation||""))
    .map(p=>`<tr>
      <td style="font-size:12px">${esc(p.designation||"")}</td>
      <td class="meta">${esc(p.reference||"")}</td>
      <td class="r tabnum" style="font-size:12px">${p.stock_actuel||0}</td>
      <td><input data-id="${p.id}" data-old="${p.stock_actuel||0}" type="number" min="0" step="1"
           style="width:80px;padding:4px 8px;font-size:12px" placeholder="${p.stock_actuel||0}"></td>
    </tr>`).join("");
}

async function saveInventaire(){
  const inputs=document.querySelectorAll("#inv-body input[data-id]");
  let count=0;
  for(const inp of inputs){
    if(!inp.value.trim())continue;
    const newQte=+inp.value;
    const prodId=inp.dataset.id;
    const oldQte=+inp.dataset.old||0;
    if(newQte===oldQte)continue;
    await dbUpdate("products",prodId,{stock_actuel:newQte});
    const i=(DB.products||[]).findIndex(p=>p.id===prodId);
    if(i>=0) DB.products[i].stock_actuel=newQte;
    const mvt={id:crypto.randomUUID(),date:todayISO(),produit_id:prodId,
      produit_nom:DB.products[i]?.designation||"",type_mvt:"inventaire",
      quantite:Math.abs(newQte-oldQte),stock_avant:oldQte,stock_apres:newQte,
      motif:"inventaire",note:"Inventaire physique"};
    await dbUpsert("crm_stock_mouvements",mvt);
    (DB.stockMvt=DB.stockMvt||[]).push(mvt);
    count++;
  }
  toast(`✅ Inventaire : ${count} produit(s) mis à jour`);
  closeOverlays(); go("entrepot");
}

/* ============================================================
   CAISSES & TRÉSORERIE
   ============================================================ */
function viewCaisses(){
  if(!vis("caisses"))return;
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";

  const caisses=DB.caisses||[];
  const caisseMvt=DB.caisseMvt||[];

  // Calculer solde de chaque caisse
  const soldes={};
  caisses.forEach(c=>{soldes[c.id]=+c.solde_initial||0;});
  caisseMvt.forEach(m=>{
    if(soldes[m.caisse_id]!==undefined)
      soldes[m.caisse_id]+=(m.type_mvt==="entree"?+m.montant:-+m.montant);
  });
  const tresoTotale=Object.values(soldes).reduce((s,v)=>s+v,0);

  const typePill={especes:"💵",banque:"🏦",mobile_money:"📱",cheque:"📝"};
  const typeLabel={especes:"Espèces",banque:"Banque",mobile_money:"Mobile Money",cheque:"Chèque"};

  $("#pg-title").textContent="Caisses & Trésorerie";
  $("#pg-sub").textContent=`${caisses.length} compte(s) — Trésorerie totale : ${fmt(tresoTotale)}`;
  $("#pg-actions").innerHTML=`
    <button class="btn" onclick="exportCaisseExcel()" style="border-color:#1D6F42;color:#1D6F42">📊 Excel</button>
    ${wr("caisses")?`
    <button class="btn" onclick="openCaisse()">+ Nouvelle caisse</button>
    <button class="btn btn-primary" onclick="openMvtCaisse()">+ Mouvement</button>`:""}
  `;

  $("#view").innerHTML=`
  <!-- Cartes caisses -->
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:16px">
    ${caisses.map(c=>{
      const solde=soldes[c.id]||0;
      const mvts=caisseMvt.filter(m=>m.caisse_id===c.id);
      const dernierMvt=mvts.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0))[0];
      return`<div class="card" style="padding:18px;border-left:4px solid ${c.couleur||"var(--cyan)"};cursor:pointer" onclick="filtrerCaisse('${c.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--txt-2);text-transform:uppercase;letter-spacing:.06em">${typePill[c.type_caisse]||""} ${typeLabel[c.type_caisse]||""}</div>
            <div style="font-size:15px;font-weight:700;margin-top:2px">${esc(c.nom||"")}</div>
          </div>
          <span class="pill ${c.statut==="active"?"p-green":"p-grey"}" style="font-size:10px">
            <span class="dot"></span>${c.statut==="active"?"Active":"Fermée"}
          </span>
        </div>
        <div style="font-size:22px;font-weight:700;font-family:monospace;color:${solde<0?"var(--danger)":"var(--encre)"};margin-bottom:8px">
          ${fmt(solde)}
        </div>
        <div style="font-size:10.5px;color:var(--txt-3)">
          ${mvts.length} mouvement(s) · Dernier : ${dernierMvt?fmtD(dernierMvt.date):"—"}
        </div>
        ${wr("caisses")?`<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="event.stopPropagation();openMvtCaisse('','${c.id}','entree')">+ Entrée</button>
          <button class="btn btn-sm" onclick="event.stopPropagation();openMvtCaisse('','${c.id}','sortie')">− Sortie</button>
          <button class="btn btn-sm" style="margin-left:auto" title="Modifier la caisse" onclick="event.stopPropagation();openCaisse('${c.id}')">✏️</button>
        </div>`:""}
      </div>`;
    }).join("")}
  </div>

  <!-- Historique mouvements -->
  <div class="card panel">
    <div class="panel-h">
      <h3 id="hist-titre">📊 Tous les mouvements</h3><div class="spacer"></div>
      <select id="fil-caisse" onchange="renderCaisseMvt()" style="width:180px">
        <option value="">Toutes les caisses</option>
        ${caisses.map(c=>`<option value="${c.id}">${esc(c.nom||"")}</option>`).join("")}
      </select>
      <select id="fil-mvt-caisse" onchange="renderCaisseMvt()" style="width:140px">
        <option value="">Tous</option>
        <option value="entree">Entrées</option>
        <option value="sortie">Sorties</option>
      </select>
    </div>
    <div id="caisse-mvt-list"></div>
  </div>`;

  renderCaisseMvt();
}

function filtrerCaisse(id){
  const sel=document.getElementById("fil-caisse");
  if(sel){sel.value=id; renderCaisseMvt();}
  const titre=document.getElementById("hist-titre");
  const c=(DB.caisses||[]).find(x=>x.id===id);
  if(titre&&c) titre.textContent=`📊 Mouvements — ${c.nom}`;
  document.getElementById("caisse-mvt-list")?.scrollIntoView({behavior:"smooth"});
}

function renderCaisseMvt(){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const caisse=document.getElementById("fil-caisse")?.value||"";
  const type=document.getElementById("fil-mvt-caisse")?.value||"";
  const rows=(DB.caisseMvt||[])
    .filter(m=>(!caisse||m.caisse_id===caisse)&&(!type||m.type_mvt===type))
    .sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const el=document.getElementById("caisse-mvt-list"); if(!el)return;
  if(!rows.length){el.innerHTML=`<div class="empty">Aucun mouvement</div>`;return;}
  el.innerHTML=`<table><thead><tr>
    <th>Date</th><th>Caisse</th><th>Libellé</th><th>Catégorie</th>
    <th class="r">Montant</th><th class="r">Solde après</th><th>Référence</th>
    ${wr("caisses")?`<th></th>`:""}
  </tr></thead><tbody>
  ${rows.map(m=>{
    const c=(DB.caisses||[]).find(x=>x.id===m.caisse_id)||{};
    return`<tr>
      <td class="meta">${m.date?new Date(m.date).toLocaleDateString("fr-FR"):"—"}</td>
      <td style="font-size:12px">${esc(c.nom||"—")}</td>
      <td><div class="nm">${esc(m.libelle||"")}</div></td>
      <td class="meta">${esc(m.categorie||"—")}</td>
      <td class="r tabnum" style="font-weight:700;color:${m.type_mvt==="entree"?"var(--ok)":"var(--danger)"}">
        ${m.type_mvt==="entree"?"+":"−"}${fmt(m.montant)}
      </td>
      <td class="r tabnum meta">${fmt(m.solde_apres)}</td>
      <td class="meta">${esc(m.reference||"—")}</td>
      ${wr("caisses")?`<td><button class="btn btn-sm btn-ghost" onclick="delMvtCaisse('${m.id}','${m.caisse_id}',${m.type_mvt==="entree"?+m.montant:-+m.montant})">🗑</button></td>`:""}
    </tr>`;
  }).join("")}
  </tbody></table>`;
}

function openMvtCaisse(id, defaultCaisse, defaultType){
  if(!wr("caisses"))return;
  // Caisse par défaut : celle passée en param, sinon celle de l'utilisateur connecté
  const userCaisse = (DB.users||[]).find(u=>u.id===USER?.id)?.caisseId || 
                     (DB.users||[]).find(u=>u.id===USER?.id)?.caisse_id || defaultCaisse;
  const caisseOpts=(DB.caisses||[]).filter(c=>c.statut==="active")
    .map(c=>`<option value="${c.id}" ${(userCaisse||defaultCaisse)===c.id?"selected":""}>${esc(c.nom||"")}</option>`).join("");
  modal(`<h2>Nouveau mouvement</h2>
  <div class="two">
    <div class="field"><label>Date *</label><input id="cmvt-date" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Type *</label>
      <select id="cmvt-type">
        <option value="entree"  ${defaultType==="entree" ?"selected":""}>📥 Entrée (recette)</option>
        <option value="sortie"  ${defaultType==="sortie" ?"selected":""}>📤 Sortie (dépense)</option>
      </select>
    </div>
  </div>
  <div class="field"><label>Caisse *</label>
    <select id="cmvt-caisse"><option value="">-- Sélectionner --</option>${caisseOpts}</select>
  </div>
  <div class="field"><label>Libellé *</label><input id="cmvt-lib" placeholder="ex: Paiement facture FAC-2026-001"></div>
  <div class="two">
    <div class="field"><label>Montant *</label><input id="cmvt-mt" type="number" min="0" step="1" placeholder="0"></div>
    <div class="field"><label>Catégorie</label>
      <input id="cmvt-cat" list="cmvt-cat-list" placeholder="ex: Vente, Salaire, Loyer">
      <datalist id="cmvt-cat-list">
        <option>Vente client</option><option>Remboursement</option><option>Salaires</option>
        <option>Fournisseur</option><option>Loyer</option><option>Charges</option>
        <option>Impôts & taxes</option><option>Frais bancaires</option><option>Divers</option>
      </datalist>
    </div>
  </div>
  <div class="field"><label>Référence (facture / dépense)</label><input id="cmvt-ref" placeholder="FAC-2026-xxxx"></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveMvtCaisse()">Enregistrer</button>
  </div>`);
}

async function saveMvtCaisse(){
  const gv=id=>document.getElementById(id)?.value?.trim()||"";
  const caisseId=gv("cmvt-caisse");
  if(!caisseId){toast("Sélectionnez une caisse");return;}
  const montant=+document.getElementById("cmvt-mt").value||0;
  if(!montant){toast("Montant invalide");return;}
  const libelle=gv("cmvt-lib");
  if(!libelle){toast("Libellé requis");return;}
  const typeMvt=gv("cmvt-type");

  // Calculer solde actuel
  const c=(DB.caisses||[]).find(x=>x.id===caisseId);
  let solde=+c?.solde_initial||0;
  (DB.caisseMvt||[]).filter(m=>m.caisse_id===caisseId)
    .forEach(m=>{solde+=(m.type_mvt==="entree"?+m.montant:-+m.montant);});
  const soldeApres=typeMvt==="entree"?solde+montant:solde-montant;

  const mvt={
    id:crypto.randomUUID(),date:gv("cmvt-date"),caisse_id:caisseId,
    type_mvt:typeMvt,montant,libelle,categorie:gv("cmvt-cat"),
    reference:gv("cmvt-ref"),solde_avant:solde,solde_apres:soldeApres,
  };
  const ok=await dbUpsert("crm_caisse_mvt",mvt);
  if(!ok)return;
  (DB.caisseMvt=DB.caisseMvt||[]).push(mvt);
  toast(`✅ Mouvement enregistré — Solde : ${Math.round(soldeApres).toLocaleString("fr-FR")} ${DB.settings.devise||"F CFA"}`);
  // Préserver les filtres actifs avant rechargement
  const _fc=document.getElementById("fil-caisse")?.value||"";
  const _ft=document.getElementById("fil-mvt-caisse")?.value||"";
  closeOverlays(); go("caisses");
  setTimeout(()=>{
    const s1=document.getElementById("fil-caisse"); if(s1&&_fc)s1.value=_fc;
    const s2=document.getElementById("fil-mvt-caisse"); if(s2&&_ft)s2.value=_ft;
    if(_fc||_ft) renderCaisseMvt();
  },60);
}

async function delMvtCaisse(id, caisseId, impact){
  if(!confirm("Supprimer ce mouvement ?"))return;
  await dbDelete("crm_caisse_mvt",id);
  DB.caisseMvt=(DB.caisseMvt||[]).filter(x=>x.id!==id);
  toast("Mouvement supprimé");
  const _fc3=document.getElementById("fil-caisse")?.value||"";
  const _ft3=document.getElementById("fil-mvt-caisse")?.value||"";
  go("caisses");
  setTimeout(()=>{
    const s1=document.getElementById("fil-caisse"); if(s1&&_fc3)s1.value=_fc3;
    const s2=document.getElementById("fil-mvt-caisse"); if(s2&&_ft3)s2.value=_ft3;
    if(_fc3||_ft3) renderCaisseMvt();
  },60);
}

function openCaisse(id){
  if(!wr("caisses"))return;
  const c=id?(DB.caisses||[]).find(x=>x.id===id)||{}:{};
  modal(`<h2>${id?"Modifier":"Nouvelle"} caisse</h2>
  <div class="field"><label>Nom *</label><input id="cs-nom" value="${esc(c.nom||"")}"></div>
  <div class="two">
    <div class="field"><label>Type</label>
      <select id="cs-type">
        <option value="especes"     ${(c.type_caisse||"especes")==="especes"?"selected":""}>💵 Espèces</option>
        <option value="banque"      ${c.type_caisse==="banque"?"selected":""}>🏦 Banque</option>
        <option value="mobile_money"${c.type_caisse==="mobile_money"?"selected":""}>📱 Mobile Money</option>
        <option value="cheque"      ${c.type_caisse==="cheque"?"selected":""}>📝 Chèque</option>
      </select>
    </div>
    <div class="field"><label>Solde initial</label><input id="cs-solde" type="number" step="1" value="${c.solde_initial||0}"></div>
  </div>
  <div class="two">
    <div class="field"><label>Couleur</label><input id="cs-color" type="color" value="${c.couleur||"#00AEEF"}"></div>
    <div class="field"><label>Statut</label>
      <select id="cs-st">
        <option value="active" ${(c.statut||"active")==="active"?"selected":""}>Active</option>
        <option value="fermee" ${c.statut==="fermee"?"selected":""}>Fermée</option>
      </select>
    </div>
  </div>
  <div class="field"><label>Description</label><input id="cs-desc" value="${esc(c.description||"")}"></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveCaisse('${id||""}')">Enregistrer</button>
  </div>`);
}

async function saveCaisse(id){
  const gv=sid=>document.getElementById(sid)?.value?.trim()||"";
  const rec={nom:gv("cs-nom"),type_caisse:gv("cs-type"),
    solde_initial:+document.getElementById("cs-solde").value||0,
    couleur:gv("cs-color"),statut:gv("cs-st"),description:gv("cs-desc")};
  if(!rec.nom){toast("Nom requis");return;}
  const obj=id?{id,...rec}:{...rec,id:crypto.randomUUID()};
  const ok=await dbUpsert("crm_caisses",obj);
  if(!ok)return;
  if(id){const i=(DB.caisses||[]).findIndex(x=>x.id===id);if(i>=0)DB.caisses[i]=obj;}
  else{(DB.caisses=DB.caisses||[]).push(obj);}
  toast(id?"Caisse modifiée":"Caisse créée");
  const _fc4=document.getElementById("fil-caisse")?.value||"";
  const _ft4=document.getElementById("fil-mvt-caisse")?.value||"";
  closeOverlays(); go("caisses");
  setTimeout(()=>{
    const s1=document.getElementById("fil-caisse"); if(s1&&_fc4)s1.value=_fc4;
    const s2=document.getElementById("fil-mvt-caisse"); if(s2&&_ft4)s2.value=_ft4;
    if(_fc4||_ft4) renderCaisseMvt();
  },60);
}

/* ============================================================
   BALANCE COMPTABLE — SYSCOHADA simplifié
   Comptes de tiers, trésorerie, charges, produits, résultat
   ============================================================ */
function openBalance(){
  const y = new Date().getFullYear();
  modal(`<h2>📊 Balance comptable</h2>
  <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
    <div class="field" style="margin:0">
      <label style="font-size:11px">Période</label>
      <select id="bal-periode" onchange="renderBalance()">
        <option value="year">Exercice ${y}</option>
        <option value="q1">T1 — Jan/Mar ${y}</option>
        <option value="q2">T2 — Avr/Jun ${y}</option>
        <option value="q3">T3 — Jul/Sep ${y}</option>
        <option value="q4">T4 — Oct/Déc ${y}</option>
        <option value="custom">Période personnalisée</option>
      </select>
    </div>
    <div id="bal-custom" style="display:none;display:flex;gap:8px">
      <div class="field" style="margin:0"><label style="font-size:11px">Du</label><input id="bal-from" type="date" value="${y}-01-01" onchange="renderBalance()"></div>
      <div class="field" style="margin:0"><label style="font-size:11px">Au</label><input id="bal-to" type="date" value="${y}-12-31" onchange="renderBalance()"></div>
    </div>
    <button class="btn btn-sm" onclick="printBalance(4)">🖨️ 4 colonnes</button>
    <button class="btn btn-sm" onclick="printBalance(6)">🖨️ 6 colonnes</button>
    <button class="btn btn-sm" style="border-color:#1D6F42;color:#1D6F42" onclick="exportBalanceExcel()">📊 Excel</button>
  </div>
  <div id="bal-content" style="max-height:70vh;overflow-y:auto"></div>`,
  null, {wide:true});

  // Afficher/masquer champs custom
  document.getElementById("bal-periode")?.addEventListener("change", e=>{
    const div=document.getElementById("bal-custom");
    if(div) div.style.display=e.target.value==="custom"?"flex":"none";
  });
  renderBalance();
}

function getBalancePeriod(){
  const p=document.getElementById("bal-periode")?.value||"year";
  const y=new Date().getFullYear();
  if(p==="year")  return {from:new Date(y,0,1), to:new Date(y,11,31,23,59,59)};
  if(p==="q1")    return {from:new Date(y,0,1),  to:new Date(y,2,31,23,59,59)};
  if(p==="q2")    return {from:new Date(y,3,1),  to:new Date(y,5,30,23,59,59)};
  if(p==="q3")    return {from:new Date(y,6,1),  to:new Date(y,8,30,23,59,59)};
  if(p==="q4")    return {from:new Date(y,9,1),  to:new Date(y,11,31,23,59,59)};
  const from=new Date(document.getElementById("bal-from")?.value||`${y}-01-01`);
  const to  =new Date(document.getElementById("bal-to")?.value  ||`${y}-12-31`);
  to.setHours(23,59,59);
  return {from,to};
}

function buildBalanceData(from, to){
  const inPeriod = d => { const dt=new Date(d); return dt>=from && dt<=to; };
  const dev = DB.settings.devise||"F CFA";
  const tva = DB.settings.tva||18;

  // ── Classe 4 — Comptes de tiers ─────────────────────────────
  let clients_deb=0, clients_cred=0, fourn_deb=0, fourn_cred=0;
  let tva_coll=0, tva_ded=0;

  DB.factures.forEach(f=>{
    if(!inPeriod(f.date)) return;
    clients_deb += f.montantTTC||0;       // 41110000 débit (créance)
    tva_coll    += f.montantTVA||0;       // 44310000 crédit TVA collectée
  });
  (DB.factures||[]).forEach(f=>{
    (f.paiements||[]).forEach(p=>{
      if(inPeriod(p.date)) clients_cred += +p.montant||0; // 41110000 crédit (encaissement)
    });
  });

  DB.depenses.forEach(d=>{
    if(!inPeriod(d.date)) return;
    fourn_cred += d.ttc||0;               // 40110000 crédit (dette fournisseur)
    tva_ded    += d.tva||0;               // 44520000 débit TVA récupérable
  });
  // Paiements fournisseurs = dépenses déjà réglées
  DB.depenses.filter(d=>d.statut_paiement==="payee"&&inPeriod(d.date))
    .forEach(d=>{ fourn_deb += d.ttc||0; }); // 40110000 débit (paiement)

  // ── Classe 5 — Trésorerie ───────────────────────────────────
  const caissesByType={};
  (DB.caisses||[]).forEach(c=>{
    const mvts=(DB.caisseMvt||[]).filter(m=>m.caisse_id===c.id);
    let deb=0, cred=0;
    mvts.forEach(m=>{
      if(!inPeriod(m.date)) return;
      if(m.type_mvt==="entree") deb  += +m.montant||0;
      else                      cred += +m.montant||0;
    });
    caissesByType[c.id]={nom:c.nom,type:c.type_caisse,deb,cred,
      soldeInit:+c.solde_initial||0};
  });

  // ── Classe 6 — Charges (dépenses HT par catégorie) ──────────
  const chargesMap={};
  const catTo6={
    "Fournitures":"601","Sous-traitance":"604","Transport":"624",
    "Loyer":"622","Communication":"626","Frais bancaires":"627",
    "Équipement":"244","Salaires":"661","Taxes & impôts":"646",
    "Divers":"658"
  };
  DB.depenses.forEach(d=>{
    if(!inPeriod(d.date)) return;
    const compte = catTo6[d.categorie]||"658";
    const libelle = d.categorie||"Divers";
    if(!chargesMap[compte]) chargesMap[compte]={compte,libelle,deb:0,cred:0};
    chargesMap[compte].deb += d.ht||0;
  });

  // ── Classe 7 — Produits ──────────────────────────────────────
  let produits_cred=0;
  DB.factures.forEach(f=>{
    if(inPeriod(f.date)) produits_cred += f.montantHT||0;
  });

  // ── TVA nette ────────────────────────────────────────────────
  const tva_nette = tva_coll - tva_ded;

  return {clients_deb,clients_cred,fourn_deb,fourn_cred,
    tva_coll,tva_ded,tva_nette,
    caisses:Object.values(caissesByType),
    charges:Object.values(chargesMap).sort((a,b)=>a.compte.localeCompare(b.compte)),
    produits_cred,
    totalCharges:Object.values(chargesMap).reduce((s,c)=>s+c.deb,0),
  };
}

function renderBalance(){
  const {from,to} = getBalancePeriod();
  const dev = DB.settings.devise||"F CFA";
  const fmt = n => n?Math.round(n).toLocaleString("fr-FR").replace(/\u202f/g," "):"";
  const fmtD = dt => dt.toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"});
  const co = DB.settings.company||{};
  const el = document.getElementById("bal-content");
  if(!el) return;

  const {rows,sumBD,sumBC,sumGD,sumGC,totD,totC} = buildBalanceRowsSage(from,to);

  const td=(v,bold)=>`<td class="r tabnum" style="padding:5px 8px;font-size:11.5px;${bold?"font-weight:700":""}">${v?fmt(v):""}</td>`;

  const rowsHTML = rows.map(r=>{
    if(r.type==="subtotal"){
      return`<tr style="background:var(--papier);border-top:1px solid var(--ligne)">
        <td></td>
        <td style="padding:5px 8px;font-size:11.5px;font-weight:700">${esc(r.lib)}</td>
        ${td(r.md,1)}${td(r.mc,1)}${td(r.sd,1)}${td(r.sc,1)}
      </tr>`;
    }
    return`<tr>
      <td class="tabnum" style="font-size:10px;padding:5px 8px;color:var(--txt-2)">${r.compte}</td>
      <td style="font-size:11.5px;padding:5px 8px">${esc(r.lib)}</td>
      ${td(r.md)}${td(r.mc)}${td(r.sd)}${td(r.sc)}
    </tr>`;
  }).join("");

  el.innerHTML = `
  <div id="balance-print-area">
    <div style="margin-bottom:12px;padding:10px 14px;background:var(--papier);border-radius:6px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700;font-size:13px">${esc(co.name||"CREATIS STUDIO")}</div>
        <div style="font-size:11px;color:var(--txt-2)">Balance des comptes — Complète — Du ${fmtD(from)} au ${fmtD(to)}</div>
      </div>
      <div style="font-size:11px;color:var(--txt-2);text-align:right">
        Régime : ${esc(co.regime||"RSI")} — Compatible Sage 100 i7<br>
        CC ${esc(co.cc||"")} · RC ${esc(co.rc||"")}
      </div>
    </div>

    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;border:1px solid var(--ligne)">
      <thead>
        <tr>
          <th rowspan="2" style="padding:6px 8px;font-size:10.5px;text-align:left;width:90px;border-bottom:2px solid var(--encre);vertical-align:bottom">N° Compte</th>
          <th rowspan="2" style="padding:6px 8px;font-size:10.5px;text-align:left;border-bottom:2px solid var(--encre);vertical-align:bottom">Intitulé des comptes</th>
          <th colspan="2" style="padding:5px 8px;font-size:10.5px;text-align:center;border-bottom:1px solid var(--ligne)">Mouvements</th>
          <th colspan="2" style="padding:5px 8px;font-size:10.5px;text-align:center;border-bottom:1px solid var(--ligne)">Soldes</th>
        </tr>
        <tr>
          <th class="r" style="padding:4px 8px;font-size:10.5px;border-bottom:2px solid var(--encre)">Débit</th>
          <th class="r" style="padding:4px 8px;font-size:10.5px;border-bottom:2px solid var(--encre)">Crédit</th>
          <th class="r" style="padding:4px 8px;font-size:10.5px;border-bottom:2px solid var(--encre);color:var(--ok)">Débit</th>
          <th class="r" style="padding:4px 8px;font-size:10.5px;border-bottom:2px solid var(--encre);color:var(--danger)">Crédit</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHTML || `<tr><td colspan="6" style="padding:14px;text-align:center;color:var(--txt-3)">Aucune écriture sur cette période</td></tr>`}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--encre)">
          <td colspan="2" style="padding:6px 8px;font-size:11.5px;font-style:italic;color:var(--txt-2)">Totaux comptes de bilan</td>
          <td class="r tabnum" style="padding:6px 8px;font-size:11.5px">${fmt(sumBD)}</td>
          <td class="r tabnum" style="padding:6px 8px;font-size:11.5px">${fmt(sumBC)}</td>
          <td colspan="2"></td>
        </tr>
        <tr>
          <td colspan="2" style="padding:6px 8px;font-size:11.5px;font-style:italic;color:var(--txt-2)">Totaux comptes de gestion</td>
          <td class="r tabnum" style="padding:6px 8px;font-size:11.5px">${fmt(sumGD)}</td>
          <td class="r tabnum" style="padding:6px 8px;font-size:11.5px">${fmt(sumGC)}</td>
          <td colspan="2"></td>
        </tr>
        <tr style="background:var(--encre);color:#fff">
          <td colspan="2" style="padding:9px 8px;font-size:12px;font-weight:700">Totaux de la balance</td>
          <td class="r tabnum" style="padding:9px 8px;font-size:13px;font-weight:700;color:#FFC400">${fmt(totD)}</td>
          <td class="r tabnum" style="padding:9px 8px;font-size:13px;font-weight:700;color:#FFC400">${fmt(totC)}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
    </div>

    <div style="margin-top:10px;text-align:center;font-size:11px;font-weight:700;color:${totD===totC?"var(--ok)":"var(--danger)"}">
      ${totD===totC?"✓ Balance équilibrée — Débit = Crédit":"⚠ Écart : "+fmt(Math.abs(totD-totC))+" "+dev}
    </div>
  </div>`;
}


function buildBalanceRowsSage(from,to){
  // Sépare : ouverture (AN, antérieure à `from`) vs mouvements de la période
  const openMap={}, mvtMap={};
  const addTo=(map,num,lib,d,c)=>{
    if(!num)return;
    if(!map[num])map[num]={lib,d:0,c:0};
    map[num].d+=+d||0; map[num].c+=+c||0;
    if(lib && !map[num].lib) map[num].lib=lib;
  };

  // Écritures auto (factures + dépenses)
  buildEcritures().forEach(e=>{
    const d=new Date(e.date||0);
    if(d>=from && d<=to) addTo(mvtMap,e.compte,e.compteLib,e.debit,e.credit);
  });
  // Écritures journal (AN + OD manuelles)
  (DB.journal||[]).forEach(j=>{
    const d=new Date(j.date||0);
    const num=j.compte_num||j.compte||"";
    if(j.journal_code==="AN"){
      // Toujours traité comme solde d'ouverture, peu importe la date exacte
      addTo(openMap,num,j.compte_lib,j.debit,j.credit);
    } else if(d>=from && d<=to){
      addTo(mvtMap,num,j.compte_lib,j.debit,j.credit);
    }
  });

  // Libellés exacts du plan comptable (priorité)
  const allNums=new Set([...Object.keys(openMap),...Object.keys(mvtMap)]);
  const libOf=(num)=>{
    const p=(DB.planCompta||[]).find(x=>x.compte===num);
    if(p) return p.libelle;
    return (openMap[num]&&openMap[num].lib) || (mvtMap[num]&&mvtMap[num].lib) || "";
  };

  const comptes=[...allNums].sort((a,b)=>a.localeCompare(b));

  // Construction des lignes avec sous-totaux classe 6 (601/604/605→60, 61, 62, 63, 64, 66)
  const rows=[];
  const sub3={}, sub2={};
  let curP2=null, curP3=null;

  const acc=(map,p,key)=>{ map[p]=map[p]||{od:0,oc:0,md:0,mc:0}; };

  const flush3=(p3)=>{
    if(p3 && sub3[p3]) rows.push({type:"subtotal",compte:p3,lib:"TOTAL "+p3,...sub3[p3]});
  };
  const flush2=(p2)=>{
    if(p2 && sub2[p2]) rows.push({type:"subtotal",compte:p2,lib:"TOTAL "+p2,...sub2[p2]});
  };

  for(const num of comptes){
    const o=openMap[num]||{d:0,c:0}, m=mvtMap[num]||{d:0,c:0};
    if(!o.d&&!o.c&&!m.d&&!m.c) continue;
    const lib=libOf(num);
    const isCharge8 = num.length===8 && num[0]==="6";
    const line={type:"detail",compte:num,lib,od:o.d,oc:o.c,md:m.d,mc:m.c};

    if(isCharge8){
      const p2=num.slice(0,2), p3=num.slice(0,3);
      if(curP3 && curP3!==p3){ flush3(curP3); }
      if(curP2 && curP2!==p2){ flush2(curP2); }
      curP2=p2; curP3=p3;
      acc(sub3,0,p3); sub3[p3].od+=o.d;sub3[p3].oc+=o.c;sub3[p3].md+=m.d;sub3[p3].mc+=m.c;
      acc(sub2,0,p2); sub2[p2].od+=o.d;sub2[p2].oc+=o.c;sub2[p2].md+=m.d;sub2[p2].mc+=m.c;
      rows.push(line);
    } else {
      if(curP3){ flush3(curP3); curP3=null; }
      if(curP2){ flush2(curP2); curP2=null; }
      rows.push(line);
    }
  }
  if(curP3) flush3(curP3);
  if(curP2) flush2(curP2);

  // Soldes cumulés (ouverture + mouvements), nets en colonne D ou C unique
  rows.forEach(r=>{
    const d=(r.od||0)+(r.md||0), c=(r.oc||0)+(r.mc||0);
    if(d>=c){ r.sd=d-c; r.sc=0; } else { r.sd=0; r.sc=c-d; }
  });

  const detailRows=rows.filter(r=>r.type==="detail");
  const bilan=detailRows.filter(r=>r.compte[0]<"6");
  const gestion=detailRows.filter(r=>r.compte[0]>="6");
  const sumOf=(arr,k)=>arr.reduce((s,r)=>s+(r[k]||0),0);
  const sumBD=sumOf(bilan,"md"),   sumBC=sumOf(bilan,"mc");
  const sumGD=sumOf(gestion,"md"), sumGC=sumOf(gestion,"mc");
  const totD=sumBD+sumGD, totC=sumBC+sumGC;

  return {rows, sumBD,sumBC,sumGD,sumGC,totD,totC};
}

function printBalance(cols){
  cols = cols===6 ? 6 : 4;
  const {from,to}=getBalancePeriod();
  const co=DB.settings.company||{};
  const fmt=n=>n?Math.round(n).toLocaleString("fr-FR").replace(/\u202f/g," "):"";
  const fmtSage=dt=>{
    const j=String(dt.getDate()).padStart(2,"0"),m=String(dt.getMonth()+1).padStart(2,"0"),a=String(dt.getFullYear()).slice(-2);
    return `${j}/${m}/${a}`;
  };
  const now=new Date();
  const heureT=now.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const dateOuverture=new Date(from.getTime()-86400000); // veille du début de période (N-1)

  const {rows,sumBD,sumBC,sumGD,sumGC,totD,totC}=buildBalanceRowsSage(from,to);

  const td=(v,bold)=>`<td style="padding:3px 5px;text-align:right;font-family:'Courier New',monospace;font-size:9.5px;${bold?"font-weight:700":""}">${v?fmt(v):""}</td>`;

  const rowsHTML=rows.map((r)=>{
    if(r.type==="subtotal"){
      const cells = cols===6
        ? `<td></td>${td(r.od,1)}${td(r.oc,1)}${td(r.md,1)}${td(r.mc,1)}${td(r.sd,1)}${td(r.sc,1)}`
        : `<td></td>${td(r.md,1)}${td(r.mc,1)}${td(r.sd,1)}${td(r.sc,1)}`;
      return`<tr style="background:#EFEFEF;border-top:1px solid #999;border-bottom:1px solid #999">
        <td style="padding:3px 5px;font-size:9.5px"></td>
        <td style="padding:3px 5px;font-size:9.5px;font-weight:700">${esc(r.lib)}</td>
        ${cells}
      </tr>`;
    }
    const cells = cols===6
      ? `${td(r.od)}${td(r.oc)}${td(r.md)}${td(r.mc)}${td(r.sd)}${td(r.sc)}`
      : `${td(r.md)}${td(r.mc)}${td(r.sd)}${td(r.sc)}`;
    return`<tr style="border-bottom:1px solid #f2f2f2">
      <td style="padding:3px 5px;font-family:'Courier New',monospace;font-size:9px;color:#333">${r.compte}</td>
      <td style="padding:3px 5px;font-size:9.5px">${esc(r.lib)}</td>
      ${cells}
    </tr>`;
  }).join("");

  // En-têtes de colonnes selon le mode
  const groupHeader = cols===6
    ? `<tr>
        <td rowspan="2" style="width:64px;font-size:9px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:2px 5px;vertical-align:bottom">Numéro<br>de<br>compte</td>
        <td rowspan="2" style="font-size:9px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:2px 5px;vertical-align:bottom">Intitulé des comptes</td>
        <td colspan="2" style="text-align:center;font-size:8.5px;font-weight:700;border-bottom:1px solid #1A1A1C;padding:2px 5px">Mouvements au ${fmtSage(dateOuverture)}</td>
        <td colspan="2" style="text-align:center;font-size:8.5px;font-weight:700;border-bottom:1px solid #1A1A1C;padding:2px 5px">Mouvements</td>
        <td colspan="2" style="text-align:center;font-size:8.5px;font-weight:700;border-bottom:1px solid #1A1A1C;padding:2px 5px">Soldes cumulés</td>
      </tr>
      <tr>
        ${["Débit","Crédit","Débit","Crédit","Débit","Crédit"].map(l=>`<td style="width:80px;text-align:right;font-size:9px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:2px 5px">${l}</td>`).join("")}
      </tr>`
    : `<tr>
        <td rowspan="2" style="width:80px;font-size:9.5px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:3px 5px;vertical-align:bottom">Numéro<br>de compte</td>
        <td rowspan="2" style="font-size:9.5px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:3px 5px;vertical-align:bottom">Intitulé des comptes</td>
        <td colspan="2" style="text-align:center;font-size:9.5px;font-weight:700;border-bottom:1px solid #1A1A1C;padding:3px 5px">Mouvements</td>
        <td colspan="2" style="text-align:center;font-size:9.5px;font-weight:700;border-bottom:1px solid #1A1A1C;padding:3px 5px">Soldes</td>
      </tr>
      <tr>
        ${["Débit","Crédit","Débit","Crédit"].map(l=>`<td style="width:115px;text-align:right;font-size:9.5px;font-weight:700;border-bottom:1.5px solid #1A1A1C;padding:2px 5px">${l}</td>`).join("")}
      </tr>`;

  const colCount = cols===6 ? 8 : 6;
  const footerCells = (bd,bc)=> cols===6
    ? `<td colspan="2"></td>${td(0)}${td(0)}<td style="padding:4px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10px">${fmt(bd)}</td><td style="padding:4px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10px">${fmt(bc)}</td>`
    : `<td style="padding:4px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10px">${fmt(bd)}</td><td style="padding:4px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10px">${fmt(bc)}</td>`;

  const html=`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Balance des comptes (${cols} col.) — ${fmtSage(from)} au ${fmtSage(to)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,Helvetica,sans-serif;color:#1A1A1C;background:#e8e8e8;padding:10px}
.page{width:${cols===6?"1050px":"794px"};background:#fff;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.1)}
table{width:100%;border-collapse:collapse}
@media print{body{background:#fff;padding:0}.page{box-shadow:none;width:100%}.no-print{display:none}@page{margin:8mm 6mm;size:${cols===6?"A4 landscape":"A4"}}}
</style></head><body>
<div class="page">
  <div style="padding:14px 18px 10px">

    <!-- En-tête EXACT Sage 100 i7 -->
    <table style="margin-bottom:2px"><tr>
      <td style="width:30%;font-size:10px;font-weight:700;vertical-align:top">${esc(co.name||"CREATIS STUDIO")}</td>
      <td style="width:40%;text-align:center;font-size:13px;font-weight:700;vertical-align:top">Balance des comptes<br><span style="font-size:10px;font-weight:400">Complète</span></td>
      <td style="width:30%;text-align:right;font-size:10px;vertical-align:top">
        Période du <strong>${fmtSage(from)}</strong><br>au <strong>${fmtSage(to)}</strong>
      </td>
    </tr></table>
    <div style="text-align:center;font-size:9px;color:#555;margin-bottom:8px">Tenue de compte : FCFA</div>

    <table>
      <thead>${groupHeader}</thead>
      <tbody>${rowsHTML}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #1A1A1C">
          <td colspan="2" style="padding:4px 5px;font-size:10px;font-style:italic">Totaux comptes de bilan</td>
          ${footerCells(sumBD,sumBC)}
        </tr>
        <tr>
          <td colspan="2" style="padding:4px 5px;font-size:10px;font-style:italic">Totaux comptes de gestion</td>
          ${footerCells(sumGD,sumGC)}
        </tr>
        <tr style="border-top:1.5px solid #1A1A1C">
          <td colspan="2" style="padding:5px 5px;font-size:10.5px;font-weight:700">Totaux de la balance</td>
          ${cols===6?`<td colspan="2"></td><td colspan="2"></td>`:""}
          <td style="padding:5px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10.5px;font-weight:700">${fmt(totD)}</td>
          <td style="padding:5px 5px;text-align:right;font-family:'Courier New',monospace;font-size:10.5px;font-weight:700">${fmt(totC)}</td>
        </tr>
      </tfoot>
    </table>

    <div style="margin-top:8px;font-size:9px;color:${totD===totC?"#137f4f":"#E0444E"};font-weight:700;text-align:center">
      ${totD===totC?"✓ Balance équilibrée — Débit = Crédit":"⚠ Écart : "+fmt(Math.abs(totD-totC))+" F CFA"}
    </div>

    <div style="margin-top:12px;padding-top:6px;border-top:1px solid #ccc;font-size:8.5px;color:#777;text-align:center">
      Tenue de compte : FCFA &nbsp;·&nbsp; © Gescom-Creatis — compatible Sage 100 Comptabilité i7 8.50
      &nbsp;·&nbsp; Date de tirage ${fmtSage(now)} à ${heureT} &nbsp;·&nbsp; Page : 1
    </div>
  </div>
</div>
<div class="no-print" style="text-align:center;padding:14px;display:flex;justify-content:center;gap:10px">
  <button onclick="window.print()" style="padding:11px 28px;background:#1A1A1C;color:#fff;border:none;border-radius:30px;font-size:13px;font-weight:700;cursor:pointer">🖨️ Imprimer / PDF</button>
  <button onclick="window.close()" style="padding:11px 18px;background:#fff;color:#1A1A1C;border:1.5px solid #ddd;border-radius:30px;font-size:13px;cursor:pointer">✕ Fermer</button>
</div>
</body></html>`;
  const w=window.open("","_blank","width=1000,height=740");
  w.document.write(html);w.document.close();
}


function exportBalanceExcel(){
  const {from,to} = getBalancePeriod();
  const d = buildBalanceData(from,to);
  const dev = DB.settings.devise||"F CFA";
  const co = DB.settings.company||{};
  const fmt = n => Math.round(n||0);
  const fmtD = dt => dt.toLocaleDateString("fr-FR");

  if(typeof XLSX==="undefined"){toast("Chargez d'abord le module Excel");return;}
  const wb=XLSX.utils.book_new();
  const rows=[
    [`Balance comptable — ${co.name||"CREATIS STUDIO"}`,null,null,null,null,null],
    [`Du ${fmtD(from)} au ${fmtD(to)} · SYSCOHADA · ${co.regime||"RSI"}`,null,null,null,null,null],
    [],
    ["N° Compte","Intitulé","Débit","Crédit","Solde Débiteur","Solde Créditeur"],
    ["— CLASSE 4 — COMPTES DE TIERS",null,null,null,null,null],
    ["411","Clients — Créances",fmt(d.clients_deb),fmt(d.clients_cred),
      d.clients_deb>=d.clients_cred?fmt(d.clients_deb-d.clients_cred):0,
      d.clients_cred>d.clients_deb?fmt(d.clients_cred-d.clients_deb):0],
    ["401","Fournisseurs — Dettes",fmt(d.fourn_deb),fmt(d.fourn_cred),
      d.fourn_deb>=d.fourn_cred?fmt(d.fourn_deb-d.fourn_cred):0,
      d.fourn_cred>d.fourn_deb?fmt(d.fourn_cred-d.fourn_deb):0],
    ["44571","TVA collectée / déductible",fmt(d.tva_ded),fmt(d.tva_coll),
      d.tva_ded>=d.tva_coll?fmt(d.tva_ded-d.tva_coll):0,
      d.tva_coll>d.tva_ded?fmt(d.tva_coll-d.tva_ded):0],
    ["— CLASSE 5 — TRÉSORERIE",null,null,null,null,null],
    ...d.caisses.map(c=>[
      {"especes":"57100000","banque":"52100000","mobile_money":"52100000","cheque":"52100000"}[c.type]||"57100000",
      c.nom,fmt(c.soldeInit+c.deb),fmt(c.cred),
      c.soldeInit+c.deb>=c.cred?fmt(c.soldeInit+c.deb-c.cred):0,
      c.cred>c.soldeInit+c.deb?fmt(c.cred-c.soldeInit-c.deb):0]),
    ["— CLASSE 6 — CHARGES",null,null,null,null,null],
    ...d.charges.map(c=>[c.compte,c.libelle,fmt(c.deb),0,fmt(c.deb),0]),
    ["— CLASSE 7 — PRODUITS",null,null,null,null,null],
    ["70110000","VENTE DE MARCHANDISES",0,fmt(d.produits_cred),0,fmt(d.produits_cred)],
    ["— RÉSULTAT",null,null,null,null,null],
    [d.produits_cred-d.totalCharges>=0?"120":"129",
      d.produits_cred-d.totalCharges>=0?"Résultat bénéficiaire":"Résultat déficitaire",
      d.produits_cred-d.totalCharges<0?fmt(Math.abs(d.produits_cred-d.totalCharges)):0,
      d.produits_cred-d.totalCharges>=0?fmt(d.produits_cred-d.totalCharges):0,
      d.produits_cred-d.totalCharges<0?fmt(Math.abs(d.produits_cred-d.totalCharges)):0,
      d.produits_cred-d.totalCharges>=0?fmt(d.produits_cred-d.totalCharges):0],
    [],
    ["TOTAL GÉNÉRAL",null,null,null,null,null],
  ];
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"]=[{wch:12},{wch:40},{wch:18},{wch:18},{wch:18},{wch:18}];
  XLSX.utils.book_append_sheet(wb,ws,"⚖️ Balance");
  XLSX.writeFile(wb,`Balance_${co.name||"CRM"}_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast("✅ Balance exportée en Excel");
}

/* ============================================================
   FISCALITÉ — Actions : acomptes, impression, export
   ============================================================ */

// ── Modal enregistrement d'un acompte ───────────────────────────
function openAcompte(){
  if(!wr("fiscalite")){toast("Accès non autorisé");return;}
  const y = new Date().getFullYear();
  const co = DB.settings.company||{};
  const tva = DB.settings.tva||18;
  let caTTC=0, depHT=0;
  DB.factures.forEach(f=>{if(new Date(f.date||0).getFullYear()===y) caTTC+=f.montantTTC||0;});
  DB.depenses.forEach(d=>{if(new Date(d.date||0).getFullYear()===y) depHT+=d.ht||0;});
  const caHT = DB.factures.filter(f=>new Date(f.date||0).getFullYear()===y).reduce((s,f)=>s+(f.montantHT||0),0);
  const bic  = Math.max(0,(caHT-depHT)*0.25);
  const imf  = Math.max(400000, caTTC*0.02);
  const impot = Math.max(bic,imf);
  const acompte = Math.round(impot/3);
  const dev = DB.settings.devise||"F CFA";
  const fmt = n => Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;

  modal(`<h2>💳 Enregistrer un paiement d'acompte</h2>
  <div style="padding:10px 14px;background:var(--papier);border-radius:6px;font-size:12px;margin-bottom:14px">
    Impôt estimé <strong>${fmt(impot)}</strong> — Acompte (1/3) : <strong>${fmt(acompte)}</strong>
  </div>
  <div class="two">
    <div class="field"><label>Date de paiement *</label>
      <input id="ac-date" type="date" value="${todayISO()}">
    </div>
    <div class="field"><label>Fraction</label>
      <select id="ac-fraction">
        <option value="1">1ʳᵉ fraction (avant 20/04/${y})</option>
        <option value="2">2ᵉ fraction (avant 20/07/${y})</option>
        <option value="3">3ᵉ fraction (avant 20/09/${y})</option>
        <option value="solde">Solde annuel</option>
      </select>
    </div>
  </div>
  <div class="two">
    <div class="field"><label>Montant payé *</label>
      <input id="ac-montant" type="number" step="1" value="${acompte}">
    </div>
    <div class="field"><label>Mode de paiement</label>
      <select id="ac-mode">
        <option value="virement">Virement bancaire</option>
        <option value="cheque">Chèque</option>
        <option value="especes">Espèces</option>
      </select>
    </div>
  </div>
  <div class="field"><label>N° de quittance / référence</label>
    <input id="ac-ref" placeholder="ex : QUI-2026-0034">
  </div>
  <div class="field"><label>Note</label>
    <input id="ac-note" placeholder="ex : Centre II Plateaux 2">
  </div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveAcompte()">Enregistrer</button>
  </div>`);
}

async function saveAcompte(){
  const gv = id => document.getElementById(id)?.value?.trim()||"";
  const montant = +document.getElementById("ac-montant").value||0;
  if(!montant){toast("Montant requis");return;}
  // Sauvegarder comme dépense catégorie "Taxes & impôts"
  const dep = {
    id:          crypto.randomUUID(),
    date:        gv("ac-date"),
    libelle:     `Acompte BIC/IMF — ${gv("ac-fraction")}ᵉ fraction ${new Date().getFullYear()}`,
    categorie:   "Taxes & impôts",
    ht:          montant,
    tva:         0,
    ttc:         montant,
    fournisseur: "DGI — Centre des Impôts",
    numero_piece:gv("ac-ref"),
    mode_paiement: gv("ac-mode"),
    statut_paiement:"payee",
    note:        gv("ac-note"),
  };
  const ok = await dbUpsert("depenses", dep);
  if(!ok) return;
  (DB.depenses = DB.depenses||[]).push(dep);
  toast(`✅ Acompte de ${montant.toLocaleString("fr-FR")} ${DB.settings.devise||"F CFA"} enregistré`);
  closeOverlays();
  go("fiscalite");
}

// ── Impression fiche fiscale ─────────────────────────────────────
function printFiscalite(){
  const y   = new Date().getFullYear();
  const co  = DB.settings.company||{};
  const dev = DB.settings.devise||"F CFA";
  const fmt = n => Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;

  let caTTC=0, caHT=0, depHT=0, tvaCollectee=0;
  DB.factures.forEach(f=>{
    if(new Date(f.date||0).getFullYear()===y){
      caTTC+=f.montantTTC||0; caHT+=f.montantHT||0; tvaCollectee+=f.montantTVA||0;
    }
  });
  DB.depenses.forEach(d=>{if(new Date(d.date||0).getFullYear()===y) depHT+=d.ht||0;});
  const resultat = caHT-depHT;
  const bic      = Math.max(0,resultat*0.25);
  const imf      = Math.max(400000,caTTC*0.02);
  const impot    = Math.max(bic,imf);
  const acompte  = Math.round(impot/3);
  const droitCA  = caHT<=5e6?caHT*0.004:caHT<=2e7?20000+(caHT-5e6)*0.005:
                   caHT<=1e8?95000+(caHT-2e7)*0.006:caHT<=5e8?575000+(caHT-1e8)*0.007:
                   3375000+(caHT-5e8)*0.008;
  const patente  = Math.round(droitCA+18000);

  // Acomptes déjà payés (dépenses catégorie "Taxes & impôts" cette année)
  const acomptesPaids = DB.depenses.filter(d=>
    d.categorie==="Taxes & impôts" && new Date(d.date||0).getFullYear()===y);
  const totalPaid = acomptesPaids.reduce((s,d)=>s+(+d.ttc||0),0);
  const resteDu   = Math.max(0,impot-totalPaid);

  const html=`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Fiche fiscale ${y} — ${esc(co.name||"")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',Arial,sans-serif;color:#1A1A1C;background:#e8e8e8;padding:20px}
  .page{width:794px;background:#fff;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,.12)}
  @media print{body{background:#fff;padding:0}.page{box-shadow:none}.no-print{display:none}@page{margin:8mm;size:A4}}
  table{width:100%;border-collapse:collapse}
  td,th{padding:7px 12px;border-bottom:1px solid #eee;font-size:12px}
</style></head><body>
<div class="page">
  <div style="height:5px;display:flex">
    <div style="flex:1;background:#00AEEF"></div><div style="flex:1;background:#EC008C"></div>
    <div style="flex:1;background:#FFC400"></div><div style="flex:1;background:#1A1A1C"></div>
  </div>
  <div style="padding:24px 28px">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #1A1A1C">
      <div>
        <img src="data:image/png;base64,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" alt="Creatis Studio" style="height:48px;width:auto;object-fit:contain;display:block;margin-bottom:4px">
        <div style="font-size:10px;color:#8A8E97;letter-spacing:.18em;text-transform:uppercase">${esc(co.activite||"Creation · Impression · Fournitures · Gadgets")}</div>
        <div style="font-size:10px;color:#777;margin-top:6px">RC ${esc(co.rc||"")} · CC ${esc(co.cc||"")} · Centre : ${esc(co.centre||"")}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:22px;font-weight:800;color:#1A1A1C">FICHE FISCALE</div>
        <div style="font-size:13px;font-weight:700;color:#EC008C">Exercice ${y}</div>
        <div style="font-size:10px;color:#8A8E97;margin-top:4px">${esc(co.regime||"Réel Simplifié")} · Art. 34 & 90 CGI CI</div>
      </div>
    </div>

    <!-- Résultat comptable -->
    <h3 style="font-size:13px;font-weight:700;margin-bottom:10px;padding:6px 10px;background:#1A1A1C;color:#fff;border-radius:4px">1. Compte de résultat simplifié</h3>
    <table style="margin-bottom:20px">
      <tr><td>Chiffre d'affaires HT</td><td style="text-align:right;font-family:monospace;font-weight:600">${fmt(caHT)}</td></tr>
      <tr><td>Charges déductibles HT</td><td style="text-align:right;font-family:monospace;color:#922B21">− ${fmt(depHT)}</td></tr>
      <tr style="border-top:2px solid #1A1A1C">
        <td style="font-weight:700">Résultat fiscal</td>
        <td style="text-align:right;font-family:monospace;font-weight:700;color:${resultat>=0?"#137f4f":"#E0444E"}">${fmt(resultat)}</td>
      </tr>
    </table>

    <!-- BIC / IMF -->
    <h3 style="font-size:13px;font-weight:700;margin-bottom:10px;padding:6px 10px;background:#1A1A1C;color:#fff;border-radius:4px">2. Calcul BIC / IMF — Régime RSI</h3>
    <table style="margin-bottom:20px">
      <tr><td>BIC (25% du bénéfice)</td><td style="text-align:right;font-family:monospace">${fmt(bic)}</td>
          <td style="font-size:10px;color:#777">${bic>=imf?"← RETENU":""}</td></tr>
      <tr><td>IMF RSI (2% CA TTC, min 400 000 F)</td><td style="text-align:right;font-family:monospace">${fmt(imf)}</td>
          <td style="font-size:10px;color:#777">${imf>bic?"← RETENU":""}</td></tr>
      <tr style="border-top:2px solid #1A1A1C">
        <td style="font-weight:700">Impôt dû MAX(BIC, IMF)</td>
        <td style="text-align:right;font-family:monospace;font-weight:700;color:#EC008C">${fmt(impot)}</td>
        <td></td>
      </tr>
    </table>

    <!-- Acomptes -->
    <h3 style="font-size:13px;font-weight:700;margin-bottom:10px;padding:6px 10px;background:#1A1A1C;color:#fff;border-radius:4px">3. Acomptes provisionnels</h3>
    <table style="margin-bottom:20px">
      <tr style="background:#f5f5f5"><th style="text-align:left">Fraction</th><th style="text-align:center">Échéance</th><th style="text-align:right">Montant</th><th style="text-align:center">Statut</th></tr>
      ${[["1ʳᵉ fraction",`20/04/${y}`,acompte],["2ᵉ fraction",`20/07/${y}`,acompte],["3ᵉ fraction",`20/09/${y}`,acompte]].map(([l,d,m])=>`
      <tr><td>${l}</td><td style="text-align:center;font-family:monospace;font-size:11px">${d}</td>
          <td style="text-align:right;font-family:monospace;font-weight:600">${fmt(m)}</td>
          <td style="text-align:center"></td></tr>`).join("")}
      ${acomptesPaids.length?`
      <tr style="background:#EFF9F4;border-top:2px solid #137f4f">
        <td style="font-weight:700;color:#137f4f">Total payé</td><td></td>
        <td style="text-align:right;font-family:monospace;font-weight:700;color:#137f4f">${fmt(totalPaid)}</td>
        <td style="text-align:center;font-size:11px;color:#137f4f">✓ Enregistré</td>
      </tr>`:""}
      <tr style="background:${resteDu>0?"#FDE8E8":"#EFF9F4"};border-top:2px solid ${resteDu>0?"#E0444E":"#137f4f"}">
        <td style="font-weight:700;color:${resteDu>0?"#E0444E":"#137f4f"}">Reste à payer</td><td></td>
        <td style="text-align:right;font-family:monospace;font-weight:700;color:${resteDu>0?"#E0444E":"#137f4f"}">${fmt(resteDu)}</td>
        <td></td>
      </tr>
    </table>

    <!-- Patente + TVA -->
    <div style="display:flex;gap:14px;margin-bottom:20px">
      <div style="flex:1">
        <h3 style="font-size:13px;font-weight:700;margin-bottom:10px;padding:6px 10px;background:#1A1A1C;color:#fff;border-radius:4px">4. Patente (estimée)</h3>
        <table>
          <tr><td>Droit sur CA (barème)</td><td style="text-align:right;font-family:monospace">${fmt(droitCA)}</td></tr>
          <tr><td>Droit valeur locative</td><td style="text-align:right;font-family:monospace">${fmt(18000)}</td></tr>
          <tr style="border-top:2px solid #1A1A1C"><td style="font-weight:700">Patente estimée</td>
            <td style="text-align:right;font-family:monospace;font-weight:700;color:#FFC400">${fmt(patente)}</td></tr>
        </table>
        <div style="font-size:10px;color:#8A8E97;margin-top:6px">Échéance : 31/03/${y} · Art. 261 CGI</div>
      </div>
      <div style="flex:1">
        <h3 style="font-size:13px;font-weight:700;margin-bottom:10px;padding:6px 10px;background:#1A1A1C;color:#fff;border-radius:4px">5. TVA (18%)</h3>
        <table>
          <tr><td>TVA collectée</td><td style="text-align:right;font-family:monospace">${fmt(tvaCollectee)}</td></tr>
          <tr><td>TVA déductible</td><td style="text-align:right;font-family:monospace">${fmt(DB.depenses.filter(d=>new Date(d.date||0).getFullYear()===y).reduce((s,d)=>s+(+d.tva||0),0))}</td></tr>
          <tr style="border-top:2px solid #1A1A1C"><td style="font-weight:700">TVA nette à reverser</td>
            <td style="text-align:right;font-family:monospace;font-weight:700;color:#0a6fa0">${fmt(Math.max(0,tvaCollectee-DB.depenses.filter(d=>new Date(d.date||0).getFullYear()===y).reduce((s,d)=>s+(+d.tva||0),0)))}</td></tr>
        </table>
        <div style="font-size:10px;color:#8A8E97;margin-top:6px">Déclaration trimestrielle · Centre : ${esc(co.centre||"")}</div>
      </div>
    </div>

    <!-- Signature -->
    <div style="display:flex;justify-content:flex-end;margin-top:24px">
      <div style="text-align:center;width:220px;font-size:10px;color:#aaa">
        <div style="border-top:1px solid #ccc;margin-top:48px;padding-top:5px">Signature & Cachet</div>
        <div style="font-weight:600;color:#1A1A1C;margin-top:3px">${esc(co.name||"")}</div>
      </div>
    </div>
  </div>
  <div style="padding:10px 28px;border-top:1px solid #eee;font-size:8px;color:#aaa;text-align:center">
    Document généré le ${new Date().toLocaleDateString("fr-FR")} · Données estimatives — consulter un expert-comptable pour les déclarations officielles
  </div>
  <div style="height:4px;display:flex">
    <div style="flex:1;background:#00AEEF"></div><div style="flex:1;background:#EC008C"></div>
    <div style="flex:1;background:#FFC400"></div><div style="flex:1;background:#1A1A1C"></div>
  </div>
</div>
<div class="no-print" style="text-align:center;padding:20px;gap:10px;display:flex;justify-content:center">
  <button onclick="window.print()" style="padding:12px 32px;background:#1A1A1C;color:#fff;border:none;border-radius:30px;font-size:14px;font-weight:700;cursor:pointer">🖨️ Imprimer / PDF</button>
  <button onclick="window.close()" style="padding:12px 20px;background:#fff;color:#1A1A1C;border:1.5px solid #ddd;border-radius:30px;font-size:14px;cursor:pointer">✕ Fermer</button>
</div>
</body></html>`;
  const w=window.open("","_blank","width=900,height=740");
  w.document.write(html); w.document.close();
}

// ── Export Excel fiche fiscale ───────────────────────────────────
function exportFiscaliteExcel(){
  if(typeof XLSX==="undefined"){toast("Module Excel non chargé");return;}
  const y  = new Date().getFullYear();
  const co = DB.settings.company||{};
  const dev= DB.settings.devise||"F CFA";
  const fmt= n=>Math.round(n||0);

  let caTTC=0,caHT=0,depHT=0,tvaCollectee=0,tvaDed=0;
  DB.factures.forEach(f=>{if(new Date(f.date||0).getFullYear()===y){caTTC+=f.montantTTC||0;caHT+=f.montantHT||0;tvaCollectee+=f.montantTVA||0;}});
  DB.depenses.forEach(d=>{if(new Date(d.date||0).getFullYear()===y){depHT+=d.ht||0;tvaDed+=d.tva||0;}});
  const bic=Math.max(0,(caHT-depHT)*0.25);
  const imf=Math.max(400000,caTTC*0.02);
  const impot=Math.max(bic,imf);
  const acompte=Math.round(impot/3);

  const wb=XLSX.utils.book_new();
  const rows=[
    [`Fiche Fiscale — ${co.name||"CREATIS STUDIO"} — Exercice ${y}`,null,null],
    [`Régime : ${co.regime||"RSI"} · Centre : ${co.centre||""} · CC : ${co.cc||""}`],
    [],
    ["COMPTE DE RÉSULTAT",null,null],
    ["Chiffre d'affaires HT","",fmt(caHT)],
    ["Charges déductibles HT","",fmt(depHT)],
    ["Résultat fiscal","",fmt(caHT-depHT)],
    [],
    ["BIC / IMF",null,null],
    ["BIC (25% du bénéfice)","",fmt(bic)],
    ["IMF RSI (2% CA TTC, min 400 000 F)","",fmt(imf)],
    ["Impôt dû MAX(BIC, IMF)","",fmt(impot)],
    [],
    ["ACOMPTES PROVISIONNELS",null,null],
    ["1ʳᵉ fraction (avant 20/04)",`${acompte}`,fmt(acompte)],
    ["2ᵉ fraction (avant 20/07)",`${acompte}`,fmt(acompte)],
    ["3ᵉ fraction (avant 20/09)",`${acompte}`,fmt(acompte)],
    [],
    ["TVA",null,null],
    ["TVA collectée","",fmt(tvaCollectee)],
    ["TVA déductible","",fmt(tvaDed)],
    ["TVA nette à reverser","",fmt(Math.max(0,tvaCollectee-tvaDed))],
  ];
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"]=[{wch:40},{wch:20},{wch:20}];
  XLSX.utils.book_append_sheet(wb,ws,"Fiscalité");
  XLSX.writeFile(wb,`Fiscalite_${co.name||"CRM"}_${y}.xlsx`);
  toast("✅ Fiche fiscale exportée");
}

/* ============================================================
   SUIVI INFOGRAPHISTES
   Vue par designer : projets en cours, BAT, charge de travail
   ============================================================ */
function viewInfographistes(){
  if(!vis("infographistes"))return;
  const dev = DB.settings.devise||"F CFA";

  // Tous les utilisateurs avec au moins 1 commande assignée + les non assignées
  const assignees = DB.users.filter(u=>u.active!==false);
  const commandes = DB.commandes||[];

  // Commandes actives (pas livrées/facturées)
  const actives = commandes.filter(c=>c.statut!=="livré"&&c.statut!=="facturé");
  const nonAssignees = actives.filter(c=>!c.responsableId&&!c.responsable_id);

  const now = new Date();

  const batOrder = {non_demarre:0,en_cours:1,bat_envoye:2,en_revision:3,bat_approuve:4,en_impression:5};

  $("#pg-title").textContent = "Suivi infographistes";
  $("#pg-sub").textContent   = `${actives.length} projet(s) actif(s) · ${nonAssignees.length} non assigné(s)`;
  $("#pg-actions").innerHTML = `
    ${vis("production")?`<button class="btn" onclick="go('production')" style="border-color:var(--cyan);color:var(--cyan)">Atelier</button>`:""}
    <button class="btn btn-primary act-edit" onclick="editCmd()">+ Nouvelle commande</button>`;

  // KPIs globaux
  const enRetard = actives.filter(c=>c.deadline&&new Date(c.deadline)<now);
  const batEnvoye= actives.filter(c=>(c.statutBat||c.statut_bat)==="bat_envoye");
  const enRevision= actives.filter(c=>(c.statutBat||c.statut_bat)==="en_revision");

  $("#view").innerHTML = `
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">Projets actifs</div><div class="val">${actives.length}</div>
      <div class="delta">${assignees.length} infographiste(s)</div></div>
    <div class="card kpi ${nonAssignees.length?"c-jaune":"c-noir"}"><span class="tick"></span>
      <div class="lab">Non assignés</div>
      <div class="val" style="color:${nonAssignees.length?"var(--warn)":"inherit"}">${nonAssignees.length}</div>
      <div class="delta">Sans infographiste</div></div>
    <div class="card kpi ${enRetard.length?"c-rouge":"c-noir"}"><span class="tick"></span>
      <div class="lab">En retard</div>
      <div class="val" style="color:${enRetard.length?"var(--danger)":"inherit"}">${enRetard.length}</div>
      <div class="delta">Deadline dépassée</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">BAT en attente</div>
      <div class="val">${batEnvoye.length+enRevision.length}</div>
      <div class="delta">${batEnvoye.length} envoyé · ${enRevision.length} en révision</div></div>
  </div>

  <!-- Tableau par infographiste -->
  <div style="display:flex;flex-direction:column;gap:14px">

    ${assignees.map(u=>{
      const myCmds = actives.filter(c=>(c.responsableId||c.responsable_id)===u.id)
        .sort((a,b)=>{
          // Trier par : en retard d'abord, puis par statut BAT, puis deadline
          const la=a.deadline&&new Date(a.deadline)<now, lb=b.deadline&&new Date(b.deadline)<now;
          if(la&&!lb)return -1; if(!la&&lb)return 1;
          const ba=batOrder[a.statutBat||a.statut_bat||"non_demarre"]||0;
          const bb=batOrder[b.statutBat||b.statut_bat||"non_demarre"]||0;
          return bb-ba;
        });
      if(!myCmds.length) return "";
      const late = myCmds.filter(c=>c.deadline&&new Date(c.deadline)<now).length;
      const r = roleOf(u);
      return`<div class="card panel">
        <div class="panel-h">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--cyan)18;border:2px solid var(--cyan);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--cyan)">${esc((u.name||"?")[0].toUpperCase())}</div>
            <div>
              <div style="font-size:15px;font-weight:700">${esc(u.name||"")}</div>
              <div style="font-size:11px;color:var(--txt-2)">${esc(r?.name||"")} · ${myCmds.length} projet(s)${late?` · <span style="color:var(--danger);font-weight:600">${late} en retard</span>`:""}</div>
            </div>
          </div>
          <div class="spacer"></div>
          <div style="display:flex;gap:6px;align-items:center">
            ${["en_cours","bat_envoye","en_revision","bat_approuve"].map(st=>{
              const n=myCmds.filter(c=>(c.statutBat||c.statut_bat)===st).length;
              return n?batBadge(st).replace("</span>",` (${n})</span>`):"";
            }).join("")}
          </div>
        </div>
        <div style="overflow-x:auto">
        <table><thead><tr>
          <th>N°</th><th>Projet</th><th>Client</th>
          <th>Deadline</th><th>Statut BAT</th><th>Révisions</th><th>Format</th><th></th>
        </tr></thead><tbody>
        ${myCmds.map(c=>{
          const isLate=c.deadline&&new Date(c.deadline)<now;
          return`<tr ${isLate?"style=\"background:#FDE8E815\""  :""}>
            <td class="meta tabnum">${esc(c.numero||"")}</td>
            <td><div class="nm">${esc(c.titre||"")}</div>${c.brief?`<div class="meta" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.brief)}</div>`:""}</td>
            <td class="meta">${esc(clientName(c.clientId))}</td>
            <td class="meta" style="white-space:nowrap;color:${isLate?"var(--danger)":""};font-weight:${isLate?"700":"400"}">
              ${c.deadline?fdate(c.deadline):"—"}${isLate?` ⚠️`:""}
            </td>
            <td>${batBadge(c.statutBat||c.statut_bat||"non_demarre")}</td>
            <td class="meta" style="text-align:center">${c.nbRevisions||c.nb_revisions||0}</td>
            <td class="meta" style="font-size:11px">${esc(c.formatLivraison||c.format_livraison||"—")}</td>
            <td style="white-space:nowrap">
              ${wr("commandes")?`
              <button class="btn btn-sm btn-ghost" onclick="editCmd('${c.id}')" title="Modifier">✏️</button>
              <button class="btn btn-sm btn-ghost" onclick="changerBat('${c.id}')" title="Changer statut BAT">🔄</button>`:""}
            </td>
          </tr>`;
        }).join("")}
        </tbody></table>
        </div>
      </div>`;
    }).filter(Boolean).join("")}

    <!-- Projets non assignés -->
    ${nonAssignees.length?`
    <div class="card panel" style="border-left:3px solid var(--warn)">
      <div class="panel-h">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:20px">⚠️</span>
          <div>
            <div style="font-size:15px;font-weight:700">Projets non assignés</div>
            <div style="font-size:11px;color:var(--txt-2)">${nonAssignees.length} commande(s) sans infographiste</div>
          </div>
        </div>
        <div class="spacer"></div>
      </div>
      <table><thead><tr><th>N°</th><th>Projet</th><th>Client</th><th>Deadline</th><th>Statut</th><th></th></tr></thead><tbody>
      ${nonAssignees.map(c=>{
        const isLate=c.deadline&&new Date(c.deadline)<now;
        return`<tr>
          <td class="meta tabnum">${esc(c.numero||"")}</td>
          <td><div class="nm">${esc(c.titre||"")}</div></td>
          <td class="meta">${esc(clientName(c.clientId))}</td>
          <td class="meta" style="color:${isLate?"var(--danger)":""}">
            ${c.deadline?fdate(c.deadline):"—"}${isLate?" ⚠️":""}
          </td>
          <td>${pill(c.statut)}</td>
          <td>${wr("commandes")?`<button class="btn btn-sm" onclick="editCmd('${c.id}')">Assigner</button>`:""}</td>
        </tr>`;
      }).join("")}
      </tbody></table>
    </div>`:""}
  </div>`;
}

// Changer rapidement le statut BAT depuis le tableau infographistes
function changerBat(cmdId){
  if(!wr("commandes"))return;
  const c=DB.commandes.find(x=>x.id===cmdId); if(!c)return;
  const opts=[["non_demarre","⚪ Pas démarré"],["en_cours","🎨 En création"],
    ["bat_envoye","📤 BAT envoyé"],["en_revision","🔄 Révisions"],
    ["bat_approuve","✅ BAT approuvé"],["en_impression","🖨️ En impression"]];
  modal(`<h2>Changer le statut BAT</h2>
  <div style="font-size:13px;font-weight:600;margin-bottom:12px">${esc(c.titre||"")}</div>
  <div style="display:flex;flex-direction:column;gap:8px">
    ${opts.map(([v,l])=>`
    <button onclick="setBat('${cmdId}','${v}')" style="padding:10px 16px;border-radius:8px;border:2px solid ${(c.statutBat||c.statut_bat||"non_demarre")===v?"var(--cyan)":"var(--ligne)"};background:${(c.statutBat||c.statut_bat||"non_demarre")===v?"var(--cyan)18":"var(--carte)"};text-align:left;cursor:pointer;font-size:13px;font-weight:${(c.statutBat||c.statut_bat||"non_demarre")===v?"700":"400"}">
      ${l}
    </button>`).join("")}
  </div>
  <div class="modal-actions"><button class="btn" onclick="closeOverlays()">Annuler</button></div>`);
}

function setBat(cmdId, newStat){
  const c=DB.commandes.find(x=>x.id===cmdId); if(!c)return;
  c.statutBat=newStat; c.statut_bat=newStat;
  sync("commandes",c);
  toast(`✅ BAT mis à jour : ${BAT_LABELS[newStat]||newStat}`);
  closeOverlays();
  go("infographistes");
}

/* ============================================================
   COMPTABILITÉ — Onglets style Sage
   Journal de saisie · Grand Livre · Plan comptable · Dépenses
   ============================================================ */

// ── JOURNAL DE SAISIE (style Sage) ─────────────────────────────
function renderJournalSaisie(el){
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");
  const JOURNAUX={AN:"A-Nouveau",VE:"Ventes",AC:"Achats",BQ:"Banque",CA:"Caisse",OD:"Opér. div.",SA:"Salaires"};
  const JC={AN:"#2C3E50",VE:"var(--ok)",AC:"var(--mag)",BQ:"var(--cyan)",CA:"var(--jaune)",OD:"#7D3C98",SA:"#E67E22"};

  // Générer les écritures automatiques depuis factures + dépenses
  const ecritures = buildEcritures();

  const filterJnl = el.querySelector?.("select#fil-jnl")?.value||"";
  const filterPer = el.querySelector?.("select#fil-per")?.value||new Date().getFullYear().toString();

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Journal de saisie</h3><div class="spacer"></div>
      <select id="fil-jnl" onchange="renderComptaTab()" style="width:140px">
        <option value="">Tous les journaux</option>
        ${Object.entries(JOURNAUX).map(([k,v])=>`<option value="${k}">${k} — ${v}</option>`).join("")}
      </select>
      <select id="fil-per" onchange="renderComptaTab()" style="width:110px">
        ${[0,1,2,3,4,5,6,7,8,9,10,11].map(m=>{
          const d=new Date(new Date().getFullYear(),m,1);
          return`<option value="${new Date().getFullYear()}-${String(m+1).padStart(2,'0')}"
            ${m===new Date().getMonth()?"selected":""}>${d.toLocaleDateString("fr-FR",{month:"short",year:"2-digit"})}</option>`;
        }).join("")}
        <option value="${new Date().getFullYear()}">— Exercice ${new Date().getFullYear()} —</option>
      </select>
      ${wr("compta")?`<button class="btn btn-sm btn-primary" onclick="openSaisieCompta()">+ Écriture OD</button>`:""}
    </div>
    <div style="overflow-x:auto">
    <table style="font-size:12px">
      <thead><tr style="background:var(--encre);color:#fff">
        <th style="padding:7px 10px;white-space:nowrap">Date</th>
        <th style="padding:7px 10px">Jnl</th>
        <th style="padding:7px 10px">N° Pièce</th>
        <th style="padding:7px 10px">Compte</th>
        <th style="padding:7px 10px">Intitulé du compte</th>
        <th style="padding:7px 10px">Libellé</th>
        <th style="padding:7px 10px;text-align:right">Débit</th>
        <th style="padding:7px 10px;text-align:right">Crédit</th>
      </tr></thead>
      <tbody>
      ${ecritures.length===0?`<tr><td colspan="8" class="empty">Aucune écriture</td></tr>`:""}
      ${ecritures.map((e,i)=>`
        <tr style="background:${i%2===0?"#fff":"var(--papier)"}">
          <td style="padding:5px 10px;white-space:nowrap;color:var(--txt-2)">${fmtD(e.date)}</td>
          <td style="padding:5px 10px">
            <span style="padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${JC[e.journal]||"var(--txt-3)"}20;color:${JC[e.journal]||"var(--txt-2)"};border:1px solid ${JC[e.journal]||"var(--ligne)"}40">${e.journal}</span>
          </td>
          <td style="padding:5px 10px;font-family:monospace;font-size:11px;color:var(--txt-2)">${esc(e.piece||"—")}</td>
          <td style="padding:5px 10px;font-family:monospace;font-weight:600">${esc(e.compte||"")}</td>
          <td style="padding:5px 10px;color:var(--txt-2)">${esc(e.compteLib||"")}</td>
          <td style="padding:5px 10px">${esc(e.libelle||"")}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;color:${e.debit?"var(--ok)":"var(--txt-3)"};font-weight:${e.debit?"600":"400"}">${e.debit?fmt(e.debit):""}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;color:${e.credit?"var(--danger)":"var(--txt-3)"};font-weight:${e.credit?"600":"400"}">${e.credit?fmt(e.credit):""}</td>
        </tr>`).join("")}
      </tbody>
      ${ecritures.length?`
      <tfoot>
        <tr style="background:var(--encre);color:#fff;font-weight:700">
          <td colspan="6" style="padding:7px 10px">TOTAUX</td>
          <td style="padding:7px 10px;text-align:right;font-family:monospace;color:#FFC400">${fmt(ecritures.reduce((s,e)=>s+(+e.debit||0),0))}</td>
          <td style="padding:7px 10px;text-align:right;font-family:monospace;color:#FFC400">${fmt(ecritures.reduce((s,e)=>s+(+e.credit||0),0))}</td>
        </tr>
      </tfoot>`:""}
    </table>
    </div>
  </div>`;
}

// Construire les écritures comptables depuis factures + dépenses + journal_entries
function buildEcritures(){
  const ecr=[];
  const y=new Date().getFullYear();

  // Factures émises → Journal VE
  DB.factures.forEach(f=>{
    if(new Date(f.date||0).getFullYear()!==y)return;
    const num=f.numero||"";
    // Débit 41110000 Clients (TTC)
    ecr.push({date:f.date,journal:"VE",piece:num,compte:"41110000",compteLib:"CLIENTS",libelle:clientName(f.clientId),debit:f.montantTTC||0,credit:0});
    // Crédit 70110000 Ventes (HT)
    ecr.push({date:f.date,journal:"VE",piece:num,compte:"70110000",compteLib:"VENTE DE MARCHANDISES",libelle:clientName(f.clientId),debit:0,credit:f.montantHT||0});
    // Crédit 44310000 TVA facturée
    if(f.montantTVA) ecr.push({date:f.date,journal:"VE",piece:num,compte:"44310000",compteLib:"TVA FACTUREE SUR VENTE",libelle:"TVA "+f.numero,debit:0,credit:f.montantTVA||0});
    // Paiements reçus → Journal BQ
    (f.paiements||[]).forEach(p=>{
      ecr.push({date:p.date,journal:"BQ",piece:num,compte:"52100000",compteLib:"BANQUE (SGCI)",libelle:"Encaissement "+num,debit:+p.montant||0,credit:0});
      ecr.push({date:p.date,journal:"BQ",piece:num,compte:"41110000",compteLib:"CLIENTS",libelle:"Encaissement "+num,debit:0,credit:+p.montant||0});
    });
  });

  // Dépenses → Journal AC
  DB.depenses.forEach(d=>{
    if(new Date(d.date||0).getFullYear()!==y)return;
    const piece=d.numero_piece||"";
    // Débit 6xxxxxxx Charges (HT) — numéro Sage exact selon catégorie
    const {c6,l6}=catToCompte(d.categorie||"");
    ecr.push({date:d.date,journal:"AC",piece,compte:c6,compteLib:l6,libelle:esc(d.libelle||""),debit:d.ht||0,credit:0});
    // Débit 44520000 TVA récupérable sur achats
    if(d.tva) ecr.push({date:d.date,journal:"AC",piece,compte:"44520000",compteLib:"TVA RECUPERABLE SUR ACHATS",libelle:esc(d.libelle||""),debit:d.tva||0,credit:0});
    // Crédit 40110000 Fournisseurs (TTC)
    ecr.push({date:d.date,journal:"AC",piece,compte:"40110000",compteLib:"FOURNISSEURS",libelle:esc(d.libelle||""),debit:0,credit:d.ttc||0});
    // Si payée → apurement Fournisseurs
    if(d.statut_paiement==="payee"){
      ecr.push({date:d.date,journal:"BQ",piece,compte:"40110000",compteLib:"FOURNISSEURS",libelle:"Règlement "+esc(d.libelle||""),debit:d.ttc||0,credit:0});
      ecr.push({date:d.date,journal:"BQ",piece,compte:"52100000",compteLib:"BANQUE (SGCI)",libelle:"Règlement "+esc(d.libelle||""),debit:0,credit:d.ttc||0});
    }
  });

  // Écritures manuelles OD
  (DB.journal||[]).forEach(j=>{
    if(new Date(j.date||0).getFullYear()!==y)return;
    ecr.push({date:j.date,journal:j.journal_code||j.type||"OD",piece:j.numero_piece||j.reference||"",compte:j.compte_num||j.compte||"",compteLib:j.compte_lib||"",libelle:j.libelle||"",debit:j.debit||0,credit:j.credit||0});
  });

  return ecr.sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
}

function catToCompte(cat){
  // Numéros Sage 100 exacts utilisés par Creatis Studio
  const map={
    "Fournitures":    {c:"60580000",l:"ACHATS DE TRAVAUX, MATERIAUX ET EMBALLAGES"},
    "Sous-traitance": {c:"60580000",l:"ACHATS DE TRAVAUX, MATERIAUX ET EMBALLAGES"},
    "Transport":      {c:"61830000",l:"TRANSPORT ADMINISTRATIF"},
    "Loyer":          {c:"62220000",l:"LOCATION DE BATIMENT"},
    "Communication":  {c:"62880000",l:"AUTRES FRAIS DE TELECOMMUNICATION"},
    "Frais bancaires":{c:"63100000",l:"FRAIS BANCAIRES"},
    "Équipement":     {c:"60560000",l:"ACHAT DE PETITS MATERIELS ET OUTILLAGE"},
    "Salaires":       {c:"66110000",l:"APPOINTEMENTS, SALAIRES ET COMMISSIONS"},
    "Taxes & impôts": {c:"64180000",l:"AUTRES IMPOTS ET TAXES DIRECTS"},
    "Honoraires":     {c:"63240000",l:"HONORAIRES"},
    "Entretien":      {c:"62400000",l:"ENTRETIEN, REPARATION ET MAINTENANCE"},
    "Eau":            {c:"60510000",l:"FOURN. NON STOCK. — EAU"},
    "Électricité":    {c:"60520000",l:"FOURN. NON STOCK. — ELECTRICITE"},
    "Assurances":     {c:"62520000",l:"ASSURANCES MATERIELS DE TRANSPORT"},
    "Réceptions":     {c:"63830000",l:"RECEPTIONS"},
    "Missions":       {c:"63840000",l:"MISSION"},
    "Divers":         {c:"63280000",l:"DIVERS FRAIS"},
  };
  const r=map[cat]||{c:"63280000",l:"DIVERS FRAIS"};
  return {c6:r.c,l6:r.l};
}

// ── GRAND LIVRE (style Sage) ────────────────────────────────────
function renderGrandLivre(el){
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");
  const dev=DB.settings.devise||"F CFA";
  const y=new Date().getFullYear();

  const allEcr=buildEcritures();
  // Regrouper par compte
  const comptes={};
  allEcr.forEach(e=>{
    if(!comptes[e.compte]) comptes[e.compte]={lib:e.compteLib,ecr:[]};
    comptes[e.compte].ecr.push(e);
  });

  const comptesSorted=Object.entries(comptes).sort((a,b)=>a[0].localeCompare(b[0]));

  // Plan comptable pour filtrer
  const planOpts=(DB.planCompta||[]).filter(p=>p.type_compte==="detail")
    .sort((a,b)=>a.compte.localeCompare(b.compte))
    .map(p=>`<option value="${p.compte}">${p.compte} — ${p.libelle}</option>`).join("");

  const filtCompte=window._glCompte||"";

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Grand Livre</h3><div class="spacer"></div>
      <select id="fil-gl-compte" onchange="window._glCompte=this.value;renderComptaTab()" style="width:280px">
        <option value="">Tous les comptes</option>${planOpts}
      </select>
    </div>
    ${comptesSorted.filter(([num])=>!filtCompte||num===filtCompte).map(([num,data])=>{
      const totD=data.ecr.reduce((s,e)=>s+(+e.debit||0),0);
      const totC=data.ecr.reduce((s,e)=>s+(+e.credit||0),0);
      const solde=totD-totC;
      const plan=(DB.planCompta||[]).find(p=>p.compte===num);
      return`
      <div style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--encre);color:#fff;border-radius:6px 6px 0 0">
          <div style="font-family:monospace;font-size:13px;font-weight:700">${num} — ${data.lib||plan?.libelle||""}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.6)">${data.ecr.length} écriture(s)</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--papier)">
            <th style="padding:5px 10px;text-align:left">Date</th>
            <th style="padding:5px 10px;text-align:left">Jnl</th>
            <th style="padding:5px 10px;text-align:left">Libellé</th>
            <th style="padding:5px 10px;text-align:right">Débit</th>
            <th style="padding:5px 10px;text-align:right">Crédit</th>
            <th style="padding:5px 10px;text-align:right">Solde</th>
          </tr></thead>
          <tbody>
          ${(()=>{let sol=0;return data.ecr.map((e,i)=>{sol+=((+e.debit||0)-(+e.credit||0));return`
            <tr style="background:${i%2?"var(--papier)":"#fff"};border-bottom:1px solid var(--ligne)">
              <td style="padding:4px 10px;white-space:nowrap">${fmtD(e.date)}</td>
              <td style="padding:4px 10px;font-size:10px;font-weight:700;color:var(--cyan)">${e.journal}</td>
              <td style="padding:4px 10px">${esc(e.libelle||"")}</td>
              <td style="padding:4px 10px;text-align:right;font-family:monospace;color:var(--ok)">${e.debit?fmt(e.debit):""}</td>
              <td style="padding:4px 10px;text-align:right;font-family:monospace;color:var(--danger)">${e.credit?fmt(e.credit):""}</td>
              <td style="padding:4px 10px;text-align:right;font-family:monospace;font-weight:600;color:${sol>=0?"var(--ok)":"var(--danger)"}">${fmt(Math.abs(sol))} ${sol>=0?"D":"C"}</td>
            </tr>`;}).join("")})()}
          </tbody>
          <tfoot>
            <tr style="background:#1A1A1C;color:#fff;font-weight:700">
              <td colspan="3" style="padding:6px 10px">TOTAUX ${num}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#FFC400">${fmt(totD)}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;color:#FFC400">${fmt(totC)}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${solde>=0?"#9AEFC6":"#FFAAAA"}">${fmt(Math.abs(solde))} ${solde>=0?"D":"C"}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    }).join("")}
  </div>`;
}

// ── PLAN COMPTABLE ───────────────────────────────────────────────
function renderPlanComptable(el){
  const plan=(DB.planCompta||[]).sort((a,b)=>a.compte.localeCompare(b.compte));
  const classes=[...new Set(plan.map(p=>p.classe))].filter(Boolean).sort();
  const classeLabel={1:"Capitaux propres",2:"Actif immobilisé",3:"Stocks",4:"Comptes de tiers",5:"Trésorerie",6:"Charges",7:"Produits",8:"Résultats"};

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h"><h3>Plan comptable SYSCOHADA — Côte d'Ivoire</h3><div class="spacer"></div>
      <span class="meta">${plan.filter(p=>p.type_compte==="detail").length} comptes de détail</span>
      ${wr("compta")?`<button class="btn btn-sm" style="margin-left:12px" onclick="openCompte()">+ Compte</button>`:""}
    </div>
    ${classes.map(cls=>{
      const comptesCls=plan.filter(p=>p.classe===cls);
      return`
      <div style="margin-bottom:16px">
        <div style="padding:7px 12px;background:var(--encre);color:#fff;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:.04em">
          CLASSE ${cls} — ${classeLabel[cls]||""}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:2px">
          ${comptesCls.map((p,i)=>{
            const isClasse=p.type_compte==="classe";
            const isGroupe=p.type_compte==="groupe";
            if(isClasse)return"";
            return`<tr style="background:${isGroupe?"var(--papier)":"#fff"};border-bottom:1px solid var(--ligne)">
              <td style="padding:5px 10px 5px ${isGroupe?"10":"24"}px;font-family:monospace;font-weight:${isGroupe?"700":"400"};color:${isGroupe?"var(--encre)":"var(--txt-2)"}">${p.compte}</td>
              <td style="padding:5px 10px;font-weight:${isGroupe?"600":"400"};font-size:${isGroupe?"12":"11.5"}px">${esc(p.libelle||"")}</td>
              <td style="padding:5px 10px;text-align:center">
                <span style="padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;background:${p.sens==="debiteur"?"var(--ok)18":"var(--danger)18"};color:${p.sens==="debiteur"?"var(--ok)":"var(--danger)"}">${p.sens==="debiteur"?"D":"C"}</span>
              </td>
              ${wr("compta")?`<td style="padding:5px 8px;text-align:right"><button class="btn btn-sm" onclick="openCompte('${p.compte}')" style="padding:2px 7px;font-size:10px">✏️</button></td>`:"<td></td>"}
            </tr>`;
          }).join("")}
        </table>
      </div>`;
    }).join("")}
  </div>`;
}

// ── DÉPENSES (onglet dans Compta) ────────────────────────────────
function openCompte(compte){
  if(!wr("compta"))return;
  const p=compte?(DB.planCompta||[]).find(x=>x.compte===compte)||{}:{};
  const types=["detail","groupe","classe"].map(t=>`<option value="${t}" ${(p.type_compte||"detail")===t?"selected":""}>${t}</option>`).join("");
  const sens=["debiteur","crediteur"].map(s=>`<option value="${s}" ${(p.sens||"debiteur")===s?"selected":""}>${s}</option>`).join("");
  modal(`<h2>${compte?"Modifier":"Nouveau"} compte</h2>
  <div class="row2">
    <div class="field"><label>N° Compte *</label><input id="cpt-num" value="${esc(p.compte||"")}" placeholder="ex: 70110000" style="font-family:monospace"></div>
    <div class="field"><label>Classe</label><input id="cpt-cls" type="number" min="1" max="9" value="${p.classe||""}"></div>
  </div>
  <div class="field"><label>Libellé *</label><input id="cpt-lib" value="${esc(p.libelle||"")}"></div>
  <div class="row2">
    <div class="field"><label>Type</label><select id="cpt-type">${types}</select></div>
    <div class="field"><label>Sens</label><select id="cpt-sens">${sens}</select></div>
  </div>`,
  [{l:"Annuler",c:"closeModal()"},{l:compte?"Enregistrer":"Créer",c:`saveCompte(${compte?`'${compte}'`:null})`,p:true}]);
}
async function saveCompte(compte){
  const num=document.getElementById("cpt-num")?.value?.trim();
  const lib=document.getElementById("cpt-lib")?.value?.trim();
  if(!num||!lib){toast("Numéro et libellé requis");return;}
  const obj={compte:num,libelle:lib,classe:+document.getElementById("cpt-cls")?.value||null,
    type_compte:document.getElementById("cpt-type")?.value||"detail",
    sens:document.getElementById("cpt-sens")?.value||"debiteur",actif:true};
  const ok=await dbUpsert("crm_plan_comptable",obj);
  if(!ok)return;
  if(compte){const i=(DB.planCompta||[]).findIndex(x=>x.compte===compte);if(i>=0)DB.planCompta[i]=fromDb({...obj});}
  else DB.planCompta=(DB.planCompta||[]).concat(fromDb({...obj}));
  closeModal();
  renderComptaTab();
  toast(compte?"Compte modifié ✓":"Compte créé ✓");
}


function renderDepCompta(el){
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";
  const stPill={payee:`<span class="pill p-green" style="font-size:10px"><span class="dot"></span>Payée</span>`,impayee:`<span class="pill p-red" style="font-size:10px"><span class="dot"></span>Impayée</span>`,en_attente:`<span class="pill p-amber" style="font-size:10px"><span class="dot"></span>En attente</span>`};
  const rows=[...DB.depenses].sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const totHT=rows.reduce((s,d)=>s+(+d.ht||0),0);
  const totTTC=rows.reduce((s,d)=>s+(+d.ttc||0),0);
  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h"><h3>Toutes les dépenses</h3><div class="spacer"></div>
      <span style="font-size:12px;font-weight:700">Total HT : ${fmt(totHT)} · TTC : ${fmt(totTTC)}</span>
      ${wr("compta")?`<button class="btn btn-sm btn-primary" onclick="editDepense()">+ Dépense</button>`:""}
    </div>
    ${rows.length===0?`<div class="empty">Aucune dépense</div>`:`
    <div style="overflow-x:auto">
    <table style="font-size:12px"><thead><tr>
      <th>Date</th><th>N° Pièce</th><th>Libellé</th><th>Catégorie</th><th>Fournisseur</th>
      <th class="r">HT</th><th class="r">TVA</th><th class="r">TTC</th><th>Statut</th>
    </tr></thead><tbody>
    ${rows.map(d=>`<tr>
      <td class="meta">${fmtD(d.date)}</td>
      <td class="meta tabnum">${esc(d.numero_piece||"—")}</td>
      <td><div class="nm">${esc(d.libelle||"")}</div></td>
      <td class="meta">${esc(d.categorie||"—")}</td>
      <td class="meta">${esc(d.fournisseur||"—")}</td>
      <td class="r tabnum">${fmt(d.ht)}</td>
      <td class="r tabnum" style="color:var(--cyan)">${fmt(d.tva)}</td>
      <td class="r tabnum"><strong>${fmt(d.ttc)}</strong></td>
      <td>${stPill[d.statut_paiement]||`<span class="pill p-grey" style="font-size:10px">${esc(d.statut_paiement||"—")}</span>`}</td>
    </tr>`).join("")}
    </tbody></table></div>`}
  </div>`;
}

// ── SAISIE OD (écriture manuelle) ───────────────────────────────
function openSaisieCompta(){
  if(!wr("compta"))return;
  const planOpts=(DB.planCompta||[]).filter(p=>p.type_compte==="detail")
    .map(p=>`<option value="${p.compte}">${p.compte} — ${p.libelle}</option>`).join("");
  modal(`<h2>✏️ Saisie d'écriture comptable</h2>
  <div class="row2">
    <div class="field"><label>Date *</label><input id="od-date" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Journal</label>
      <select id="od-jnl">
        <option value="AN">AN — A-Nouveau (ouverture)</option>
        <option value="OD">OD — Opérations diverses</option>
        <option value="AC">AC — Achats</option>
        <option value="VE">VE — Ventes</option>
        <option value="BQ">BQ — Banque</option>
        <option value="CA">CA — Caisse</option>
        <option value="SA">SA — Salaires</option>
      </select>
    </div>
  </div>
  <div class="row2">
    <div class="field"><label>N° Pièce</label><input id="od-piece" placeholder="ex: OD-001"></div>
    <div class="field"><label>Libellé *</label><input id="od-lib" placeholder="ex: Régularisation TVA"></div>
  </div>
  <div style="border:1px solid var(--ligne);border-radius:6px;padding:12px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">Ligne débit</div>
    <div class="row2">
      <div class="field"><label>Compte débit</label>
        <input id="od-cptD" list="od-plan" placeholder="ex: 411">
        <datalist id="od-plan">${planOpts}</datalist>
      </div>
      <div class="field"><label>Montant débit</label><input id="od-deb" type="number" step="1" placeholder="0"></div>
    </div>
  </div>
  <div style="border:1px solid var(--ligne);border-radius:6px;padding:12px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">Ligne crédit</div>
    <div class="row2">
      <div class="field"><label>Compte crédit</label>
        <input id="od-cptC" list="od-plan2" placeholder="ex: 701">
        <datalist id="od-plan2">${planOpts}</datalist>
      </div>
      <div class="field"><label>Montant crédit</label><input id="od-cred" type="number" step="1" placeholder="0"></div>
    </div>
  </div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveEcritureOD()">Valider l'écriture</button>
  </div>`);
}

async function saveEcritureOD(){
  const gv=id=>document.getElementById(id)?.value?.trim()||"";
  const date=gv("od-date"); if(!date){toast("Date requise");return;}
  const libelle=gv("od-lib"); if(!libelle){toast("Libellé requis");return;}
  const deb=+document.getElementById("od-deb").value||0;
  const cred=+document.getElementById("od-cred").value||0;
  if(!deb&&!cred){toast("Montant requis");return;}

  const cptD=gv("od-cptD"), cptC=gv("od-cptC");
  const findLib=c=>(DB.planCompta||[]).find(p=>p.compte===c)?.libelle||"";
  const piece=gv("od-piece")||"OD-"+Date.now().toString().slice(-4);
  const jnl=gv("od-jnl")||"OD";

  const entries=[];
  if(deb&&cptD) entries.push({id:crypto.randomUUID(),date,journal_code:jnl,libelle,reference:libelle,numero_piece:piece,compte_num:cptD,compte_lib:findLib(cptD),debit:deb,credit:0,tva:0});
  if(cred&&cptC) entries.push({id:crypto.randomUUID(),date,journal_code:jnl,libelle,reference:libelle,numero_piece:piece,compte_num:cptC,compte_lib:findLib(cptC),debit:0,credit:cred,tva:0});

  for(const e of entries){
    await dbUpsert("journal_entries",e);
    (DB.journal=DB.journal||[]).push(e);
  }
  toast(`✅ Écriture ${jnl} enregistrée`);
  closeOverlays();
  // Rester sur l'onglet actif (Grand Livre, Journal, etc.)
  renderComptaTab();
}

/* ============================================================
   FIXES & AMÉLIORATIONS UX — Audit 30/06/2026
   ============================================================ */

// ── UX 3 : Catalogue — filtre par catégorie ──────────────────
// (patch viewCatalogue pour ajouter recherche live)
const _origViewCatalogue = viewCatalogue;

function dashAlerts(){
  const now = new Date();
  const alerts = [];
  // Factures en retard
  DB.factures.filter(f=>{
    const due = new Date(f.echeance||0);
    return f.statut!=="payée" && due < now && f.montantTTC > 0;
  }).forEach(f=>{
    const days = Math.floor((now-new Date(f.echeance))/86400000);
    alerts.push({type:"danger", msg:`Facture ${f.numero} — ${clientName(f.clientId)} en retard de ${days}j (${fcfa(f.montantTTC-factPaid(f))} restant)`});
  });
  // Commandes en retard
  DB.commandes.filter(c=>c.deadline&&new Date(c.deadline)<now&&c.statut!=="livré"&&c.statut!=="facturé")
    .forEach(c=>{
      alerts.push({type:"warn", msg:`Commande ${c.numero} — ${esc(c.titre)} deadline dépassée`});
    });
  // Stock faible
  (DB.products||[]).filter(p=>p.stock_actuel!==undefined&&p.stock_actuel<=p.stock_min).forEach(p=>{
    alerts.push({type:"warn", msg:`Stock faible : ${esc(p.nom)} (${p.stock_actuel} restant, seuil ${p.stock_min})`});
  });
  return alerts;
}

// Injecter les alertes dans le dashboard si la section existe
const _origViewDashboard = viewDashboard;

function renderClientList(){
  _origRenderClientList();
  // Ajouter le filtre type client si le select existe
  const filType = document.getElementById("fil-client-type");
  if(!filType) return;
  const q = (document.getElementById("srch-clients")?.value||"").toLowerCase();
  const t = filType.value;
  if(!q && !t) return;
  document.querySelectorAll("#client-list tbody tr, #view tbody tr").forEach(tr=>{
    const text = tr.textContent.toLowerCase();
    const typeCell = tr.dataset.type||"";
    const matchQ = !q || text.includes(q);
    const matchT = !t || typeCell === t;
    tr.style.display = (matchQ && matchT) ? "" : "none";
  });
}

/* ============================================================
   ATELIER & PRODUCTION — Module complet
   Suivi des commandes de la création à la livraison
   ============================================================ */

const PROD_ETAPES = [
  {k:"brief",         label:"Brief",        icon:"📋", color:"var(--txt-2)"},
  {k:"creation",      label:"Création",     icon:"🎨", color:"var(--mag)"},
  {k:"bat_envoye",    label:"BAT envoyé",   icon:"📤", color:"var(--jaune)"},
  {k:"revision",      label:"Révisions",    icon:"🔄", color:"#E67E22"},
  {k:"bat_approuve",  label:"BAT approuvé", icon:"✅", color:"var(--ok)"},
  {k:"impression",    label:"Impression",   icon:"🖨️", color:"var(--cyan)"},
  {k:"finition",      label:"Finition",     icon:"✂️", color:"#9B59B6"},
  {k:"livraison",     label:"Livraison",    icon:"🚚", color:"var(--ok)"},
];

const PROD_STATUTS = {
  en_attente: {label:"En attente", color:"var(--txt-3)", bg:"var(--ligne)"},
  en_cours:   {label:"En cours",   color:"var(--cyan)",  bg:"var(--cyan)18"},
  termine:    {label:"Terminé",    color:"var(--ok)",    bg:"var(--ok)18"},
  bloque:     {label:"Bloqué",     color:"var(--danger)",bg:"var(--danger)18"},
};

const PROD_ROLES = ["infographiste","imprimeur","finition","contrôleur","livreur","polyvalent"];

function prodEtapeLabel(k){ return PROD_ETAPES.find(e=>e.k===k)?.label||k; }
function prodEtapeIcon(k){  return PROD_ETAPES.find(e=>e.k===k)?.icon||"⚙️"; }
function prodEtapeColor(k){ return PROD_ETAPES.find(e=>e.k===k)?.color||"var(--txt-2)"; }
function prodStatutBadge(st){
  const s=PROD_STATUTS[st]||{label:st,color:"var(--txt-2)",bg:"var(--ligne)"};
  return`<span style="padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;color:${s.color};background:${s.bg}">${s.label}</span>`;
}

// ── viewProduction ── vue principale ────────────────────────────
function viewProduction(){
  if(!vis("production"))return;
  window._prodTab = window._prodTab||"kanban";
  window._prodFiltEtape = window._prodFiltEtape||"";
  window._prodFiltOp    = window._prodFiltOp||"";

  const now = new Date();
  const actives = (DB.commandes||[]).filter(c=>c.statut!=="livré"&&c.statut!=="facturé");
  const retard  = actives.filter(c=>c.deadline&&new Date(c.deadline)<now);
  const sansEtape = actives.filter(c=>!(DB.prodEtapes||[]).some(e=>e.commande_id===c.id));

  // Compter les étapes actives
  const etapesEnCours = (DB.prodEtapes||[]).filter(e=>e.statut==="en_cours").length;
  const etapesBloquees = (DB.prodEtapes||[]).filter(e=>e.statut==="bloque").length;

  $("#pg-title").textContent = "Atelier & Production";
  $("#pg-sub").textContent   = `${actives.length} commande(s) en cours · ${etapesEnCours} étape(s) active(s)`;
  $("#pg-actions").innerHTML = `
    ${wr("production")?`<button class="btn" onclick="initEtapesCommande()" style="border-color:var(--txt-2);color:var(--txt-2)">⚡ Init.</button>`:""}
    <button class="btn btn-primary" onclick="openNouvelleEtape()">➕ Nouvelle étape</button>
  `;

  const tabs=[
    {k:"kanban",label:"🏭 Kanban atelier"},
    {k:"operateurs",label:"👥 Par opérateur"},
    {k:"commandes",label:"📋 Par commande"},
    {k:"activite",label:"📰 Journal activité"},
  ];

  $("#view").innerHTML=`
  <!-- KPIs -->
  <div class="grid kpis" style="margin-bottom:14px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">En production</div>
      <div class="val">${actives.length}</div>
      <div class="delta">${etapesEnCours} étapes en cours</div></div>
    <div class="card kpi ${retard.length?"c-rouge":"c-noir"}"><span class="tick"></span>
      <div class="lab">En retard</div>
      <div class="val" style="color:${retard.length?"var(--danger)":"inherit"}">${retard.length}</div>
      <div class="delta">Deadline dépassée</div></div>
    <div class="card kpi ${etapesBloquees?"c-rouge":"c-noir"}"><span class="tick"></span>
      <div class="lab">Bloquées</div>
      <div class="val" style="color:${etapesBloquees?"var(--danger)":"inherit"}">${etapesBloquees}</div>
      <div class="delta">Nécessitent action</div></div>
    <div class="card kpi ${sansEtape.length?"c-jaune":"c-noir"}"><span class="tick"></span>
      <div class="lab">Sans étape</div>
      <div class="val" style="color:${sansEtape.length?"var(--warn)":"inherit"}">${sansEtape.length}</div>
      <div class="delta">À initialiser</div></div>
  </div>

  <!-- Onglets -->
  <div style="display:flex;gap:2px;border-bottom:2px solid var(--ligne);margin-bottom:0">
    ${tabs.map(t=>`<button onclick="switchProdTab('${t.k}')" id="ptab-${t.k}"
      style="padding:8px 16px;border:none;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;font-weight:600;
      background:${window._prodTab===t.k?"var(--carte)":"transparent"};
      color:${window._prodTab===t.k?"var(--cyan)":"var(--txt-2)"};
      border-bottom:${window._prodTab===t.k?"3px solid var(--cyan)":"3px solid transparent"};
      margin-bottom:-2px">${t.l}</button>`).join("")}
  </div>
  <div id="prod-tab-content" style="padding-top:14px"></div>`;

  renderProdTab();
}

function switchProdTab(tab){
  window._prodTab=tab;
  document.querySelectorAll("[id^='ptab-']").forEach(b=>{
    const k=b.id.replace("ptab-",""), a=k===tab;
    b.style.background=a?"var(--carte)":"transparent";
    b.style.color=a?"var(--cyan)":"var(--txt-2)";
    b.style.borderBottom=a?"3px solid var(--cyan)":"3px solid transparent";
  });
  renderProdTab();
}

function renderProdTab(){
  const el=document.getElementById("prod-tab-content"); if(!el)return;
  const t=window._prodTab||"kanban";
  if(t==="kanban")      renderProdKanban(el);
  else if(t==="operateurs") renderProdOperateurs(el);
  else if(t==="commandes")  renderProdCommandes(el);
  else if(t==="activite")   renderProdActivite(el);
}

// ── Onglet 1 : Kanban par étape ──────────────────────────────────
function renderProdKanban(el){
  const now = new Date();
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR");

  el.innerHTML=`
  <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:8px">
  ${PROD_ETAPES.map(et=>{
    const etapes = (DB.prodEtapes||[]).filter(e=>e.etape===et.k);
    const enCours = etapes.filter(e=>e.statut==="en_cours");
    const bloque  = etapes.filter(e=>e.statut==="bloque");
    const termine = etapes.filter(e=>e.statut==="termine");

    return`
    <div style="min-width:220px;max-width:240px;flex-shrink:0">
      <!-- En-tête colonne -->
      <div style="padding:8px 10px;border-radius:8px 8px 0 0;background:var(--papier);border:1px solid var(--ligne);border-bottom:2px solid ${et.color};margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:700;color:${et.color}">${et.icon} ${et.label}</span>
        <span style="font-size:10px;padding:2px 8px;background:${et.color}18;color:${et.color};border-radius:10px;font-weight:700">${etapes.length}</span>
      </div>
      <!-- Cartes -->
      <div style="display:flex;flex-direction:column;gap:6px;min-height:60px">
        ${etapes.length===0?`<div style="padding:12px;text-align:center;color:var(--txt-3);font-size:11px;border:1px dashed var(--ligne);border-radius:6px">Aucune</div>`:""}
        ${etapes.map(e=>{
          const cmd=(DB.commandes||[]).find(c=>c.id===e.commande_id)||{};
          const op=(DB.users||[]).find(u=>u.id===e.operateur_id);
          const isLate=e.date_fin_prev&&new Date(e.date_fin_prev)<now&&e.statut!=="termine";
          return`<div onclick="openProdEtape('${e.id}')" style="padding:10px 12px;background:var(--carte);border:1px solid var(--ligne);border-radius:8px;cursor:pointer;${isLate?"border-left:3px solid var(--danger)":""};${e.statut==="bloque"?"border-left:3px solid var(--danger)":""};${e.statut==="termine"?"opacity:.7":""}">
            <div style="font-size:11px;font-weight:700;color:var(--txt-1);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cmd.numero||"")} ${esc(cmd.titre||"")}</div>
            <div style="font-size:10px;color:var(--txt-2);margin-bottom:5px">${esc(clientName(cmd.clientId))}</div>
            ${op?`<div style="font-size:10px;color:var(--cyan);font-weight:600">👤 ${esc(op.name)}</div>`:""}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:5px">
              ${prodStatutBadge(e.statut)}
              ${isLate?`<span style="font-size:9px;color:var(--danger);font-weight:700">⚠️ Retard</span>`:""}
              ${e.date_fin_prev&&e.statut!=="termine"?`<span style="font-size:9px;color:var(--txt-2)">${new Date(e.date_fin_prev).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit"})}</span>`:""}
            </div>
          </div>`;
        }).join("")}
        ${wr("production")?`<button onclick="openNouvelleEtape('${et.k}')" style="padding:6px;border:1px dashed var(--ligne);border-radius:6px;background:transparent;cursor:pointer;font-size:11px;color:var(--txt-2);width:100%">+ Ajouter</button>`:""}
      </div>
    </div>`;
  }).join("")}
  </div>`;
}

// ── Onglet 2 : Par opérateur ─────────────────────────────────────
function renderProdOperateurs(el){
  const now=new Date();
  const operateurs = (DB.users||[]).filter(u=>u.active!==false);

  if(!operateurs.length){ el.innerHTML=`<div class="empty">Aucun utilisateur actif</div>`; return; }

  el.innerHTML=`<div style="display:flex;flex-direction:column;gap:14px">
  ${operateurs.map(u=>{
    const myEtapes=(DB.prodEtapes||[]).filter(e=>e.operateur_id===u.id&&e.statut!=="termine");
    if(!myEtapes.length)return "";
    const retard=myEtapes.filter(e=>e.date_fin_prev&&new Date(e.date_fin_prev)<now);
    return`<div class="card panel">
      <div class="panel-h">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--cyan)18;border:2px solid var(--cyan);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:var(--cyan)">${(u.name||"?")[0].toUpperCase()}</div>
        <div style="margin-left:10px">
          <div style="font-size:14px;font-weight:700">${esc(u.name)}</div>
          <div style="font-size:11px;color:var(--txt-2)">${myEtapes.length} tâche(s) actives${retard.length?` · <span style="color:var(--danger);font-weight:700">${retard.length} en retard</span>`:""}</div>
        </div>
        <div class="spacer"></div>
        ${["impression","creation","finition"].map(et=>{
          const n=myEtapes.filter(e=>e.etape===et).length;
          return n?`<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${prodEtapeColor(et)}18;color:${prodEtapeColor(et)};font-weight:600">${prodEtapeIcon(et)} ×${n}</span>`:"";
        }).join(" ")}
      </div>
      <table style="font-size:12px;margin-top:8px"><thead><tr>
        <th>Commande</th><th>Étape</th><th>Statut</th><th>Deadline</th><th></th>
      </tr></thead><tbody>
      ${myEtapes.sort((a,b)=>new Date(a.date_fin_prev||"9999")-new Date(b.date_fin_prev||"9999")).map(e=>{
        const cmd=(DB.commandes||[]).find(c=>c.id===e.commande_id)||{};
        const isLate=e.date_fin_prev&&new Date(e.date_fin_prev)<now&&e.statut!=="termine";
        return`<tr ${isLate?"style=\"background:var(--danger)0A\""  :""}>
          <td><div class="nm" style="font-size:12px">${esc(cmd.numero||"")} — ${esc(cmd.titre||"")}</div><div class="meta">${esc(clientName(cmd.clientId))}</div></td>
          <td>${prodEtapeIcon(e.etape)} ${esc(prodEtapeLabel(e.etape))}</td>
          <td>${prodStatutBadge(e.statut)}</td>
          <td style="color:${isLate?"var(--danger)":"inherit"};font-weight:${isLate?"700":"400"}">
            ${e.date_fin_prev?new Date(e.date_fin_prev).toLocaleDateString("fr-FR"):"—"}${isLate?" ⚠️":""}
          </td>
          <td>${wr("production")?`<button class="btn btn-sm btn-ghost" onclick="changerStatutEtape('${e.id}')">🔄</button>`:""}
          <button class="btn btn-sm btn-ghost" onclick="openProdEtape('${e.id}')">👁</button></td>
        </tr>`;
      }).join("")}
      </tbody></table>
    </div>`;
  }).filter(Boolean).join("")||`<div class="empty">Aucune étape assignée</div>`}
  </div>`;
}

// ── Onglet 3 : Par commande ──────────────────────────────────────
function renderProdCommandes(el){
  const now=new Date();
  const actives=(DB.commandes||[]).filter(c=>c.statut!=="livré"&&c.statut!=="facturé")
    .sort((a,b)=>new Date(a.deadline||"9999")-new Date(b.deadline||"9999"));

  if(!actives.length){el.innerHTML=`<div class="empty">Aucune commande en cours</div>`;return;}

  el.innerHTML=`<div style="display:flex;flex-direction:column;gap:12px">
  ${actives.map(cmd=>{
    const etapes=(DB.prodEtapes||[]).filter(e=>e.commande_id===cmd.id)
      .sort((a,b)=>PROD_ETAPES.findIndex(x=>x.k===a.etape)-PROD_ETAPES.findIndex(x=>x.k===b.etape));
    const etapesCurrent=etapes.filter(e=>e.statut==="en_cours");
    const isLate=cmd.deadline&&new Date(cmd.deadline)<now;
    const progress=etapes.length?Math.round(etapes.filter(e=>e.statut==="termine").length/PROD_ETAPES.length*100):0;

    return`<div class="card panel" style="${isLate?"border-left:3px solid var(--danger)":""}">
      <div class="panel-h">
        <div>
          <div style="font-size:13px;font-weight:700">${esc(cmd.numero)} — ${esc(cmd.titre)}</div>
          <div style="font-size:11px;color:var(--txt-2)">${esc(clientName(cmd.clientId))} · Deadline : <span style="color:${isLate?"var(--danger)":"inherit"};font-weight:${isLate?"700":"400"}">${cmd.deadline?new Date(cmd.deadline).toLocaleDateString("fr-FR"):"—"}</span>${isLate?" ⚠️":""}</div>
        </div>
        <div class="spacer"></div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--txt-2);margin-bottom:4px">Progression</div>
          <div style="width:120px;height:6px;background:var(--ligne);border-radius:3px;overflow:hidden">
            <div style="width:${progress}%;height:100%;background:${progress===100?"var(--ok)":"var(--cyan)"};border-radius:3px;transition:width .3s"></div>
          </div>
          <div style="font-size:10px;color:var(--txt-2);margin-top:2px">${etapes.filter(e=>e.statut==="termine").length}/${PROD_ETAPES.length} étapes</div>
        </div>
        ${wr("production")?`<button class="btn btn-sm" onclick="openNouvelleEtape('',{cmd:'${cmd.id}'})" style="margin-left:8px">+ Étape</button>`:""}
      </div>

      <!-- Timeline des étapes -->
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:10px">
        ${PROD_ETAPES.map(et=>{
          const e=etapes.find(x=>x.etape===et.k);
          const op=e?(DB.users||[]).find(u=>u.id===e.operateur_id):null;
          const bg=e?{en_attente:"var(--papier)",en_cours:et.color+"25",termine:"var(--ok)18",bloque:"var(--danger)18"}[e.statut]||"var(--papier)":"var(--papier)";
          const border=e?{en_attente:"var(--ligne)",en_cours:et.color,termine:"var(--ok)",bloque:"var(--danger)"}[e.statut]||"var(--ligne)":"var(--ligne)dashed";
          return`<div onclick="${e?`openProdEtape('${e.id}')`:`openNouvelleEtape('${et.k}',{cmd:'${cmd.id}'})`}" style="padding:5px 8px;border-radius:6px;border:1px solid ${border};background:${bg};cursor:pointer;min-width:80px;text-align:center" title="${et.label}${op?" — "+op.name:""}${e?" — "+prodStatutBadge(e.statut):""}">
            <div style="font-size:12px">${et.icon}</div>
            <div style="font-size:9px;color:${e?{en_attente:"var(--txt-3)",en_cours:et.color,termine:"var(--ok)",bloque:"var(--danger)"}[e.statut]:"var(--txt-3)"};">${et.label}</div>
            ${op?`<div style="font-size:8px;color:var(--cyan)">${(op.name||"").split(" ")[0]}</div>`:""}
          </div>`;
        }).join("")}
      </div>
      ${etapesCurrent.length?`<div style="margin-top:8px;padding:6px 10px;background:var(--cyan)10;border-radius:6px;font-size:11px;color:var(--cyan)">▶ En cours : ${etapesCurrent.map(e=>prodEtapeLabel(e.etape)).join(", ")}</div>`:""}
    </div>`;
  }).join("")}
  </div>`;
}

// ── Onglet 4 : Journal d'activité ───────────────────────────────
function renderProdActivite(el){
  const logs=[...(DB.prodActivite||[])].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,50);
  const typeIcon={avancement:"⏩",commentaire:"💬",alerte:"⚠️",validation:"✅",revision:"🔄",photo:"📷"};

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Journal d'activité</h3><div class="spacer"></div>
      ${wr("production")?`<button class="btn btn-sm btn-primary" onclick="openAjoutActivite()">+ Entrée</button>`:""}
    </div>
    ${logs.length===0?`<div class="empty">Aucune activité enregistrée</div>`:`
    <div style="display:flex;flex-direction:column;gap:8px">
    ${logs.map(log=>{
      const cmd=(DB.commandes||[]).find(c=>c.id===log.commande_id)||{};
      const auteur=(DB.users||[]).find(u=>u.id===log.auteur_id);
      const date=log.created_at?new Date(log.created_at):null;
      return`<div style="display:flex;gap:10px;padding:10px;border-radius:8px;background:var(--papier)">
        <div style="font-size:18px;flex-shrink:0">${typeIcon[log.type_action]||"📝"}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <div style="font-size:11px;font-weight:700">${esc(cmd.numero||"—")} — ${esc(cmd.titre||"")}</div>
            <div style="font-size:10px;color:var(--txt-2)">${date?date.toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"—"}</div>
          </div>
          <div style="font-size:12px;color:var(--txt-1)">${esc(log.message)}</div>
          <div style="font-size:10px;color:var(--txt-2);margin-top:3px">par ${auteur?esc(auteur.name):"Système"}</div>
        </div>
      </div>`;
    }).join("")}
    </div>`}
  </div>`;
}

// ── CRUD : ouvrir une étape ──────────────────────────────────────
function openProdEtape(id){
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  const cmd=(DB.commandes||[]).find(c=>c.id===e.commande_id)||{};
  const op=(DB.users||[]).find(u=>u.id===e.operateur_id);
  const logs=(DB.prodActivite||[]).filter(a=>a.etape_id===id)
    .sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));

  drawer(`${prodEtapeIcon(e.etape)} ${prodEtapeLabel(e.etape)}`,esc(cmd.numero||"")+" — "+esc(cmd.titre||""),`
  <div style="display:flex;flex-direction:column;gap:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${kv("Commande",esc(cmd.titre||""))}
      ${kv("Client",clientName(cmd.clientId))}
      ${kv("Opérateur",op?esc(op.name):"Non assigné")}
      ${kv("Statut",prodStatutBadge(e.statut))}
      ${kv("Début",e.date_debut?new Date(e.date_debut).toLocaleDateString("fr-FR"):"—")}
      ${kv("Deadline",e.date_fin_prev?new Date(e.date_fin_prev).toLocaleDateString("fr-FR"):"—")}
      ${kv("Terminé le",e.date_fin_reel?new Date(e.date_fin_reel).toLocaleDateString("fr-FR"):"—")}
      ${kv("Priorité",["","🔴 Urgente","🟡 Normale","🟢 Basse"][e.priorite||2])}
    </div>
    ${e.notes?`<div style="padding:8px 12px;background:var(--papier);border-radius:6px;font-size:12px">${esc(e.notes)}</div>`:""}
    ${logs.length?`<div><div style="font-size:11px;font-weight:700;margin-bottom:6px;color:var(--txt-2)">HISTORIQUE</div>
    ${logs.slice(0,5).map(l=>`<div style="padding:6px 0;border-bottom:1px solid var(--ligne);font-size:11px"><span style="color:var(--txt-2)">${new Date(l.created_at||0).toLocaleDateString("fr-FR")}</span> — ${esc(l.message)}</div>`).join("")}
    </div>`:""}
  </div>`,
  [
    wr("production")?{label:"Modifier",cls:"btn-primary",edit:1,fn:`editProdEtape('${id}')`}:null,
    wr("production")?{label:"🔄 Changer statut",cls:"btn",fn:`changerStatutEtape('${id}')`}:null,
    {label:"💬 Commenter",cls:"btn-ghost",fn:`ajouterCommentaire('${id}','${e.commande_id}')`},
  ].filter(Boolean));
}

// ── CRUD : créer / modifier une étape ───────────────────────────
function openNouvelleEtape(etapeDefaut, opts){
  if(!wr("production"))return;
  const cmdId=opts?.cmd||"";
  const cmdOpts=(DB.commandes||[]).filter(c=>c.statut!=="livré"&&c.statut!=="facturé")
    .map(c=>`<option value="${c.id}" ${c.id===cmdId?"selected":""}>${esc(c.numero)} — ${esc(c.titre)}</option>`).join("");
  const usrOpts=(DB.users||[]).filter(u=>u.active!==false)
    .map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("");
  const etapeOpts=PROD_ETAPES.map(e=>`<option value="${e.k}" ${e.k===etapeDefaut?"selected":""}>${e.icon} ${e.label}</option>`).join("");

  modal(`<h2>➕ Nouvelle étape de production</h2>
  <div class="row2">
    <div class="field"><label>Commande *</label><select id="pe-cmd"><option value="">— Choisir —</option>${cmdOpts}</select></div>
    <div class="field"><label>Étape *</label><select id="pe-etape">${etapeOpts}</select></div>
  </div>
  <div class="row2">
    <div class="field"><label>Opérateur assigné</label><select id="pe-op"><option value="">— Non assigné —</option>${usrOpts}</select></div>
    <div class="field"><label>Rôle opérateur</label><select id="pe-role">
      ${PROD_ROLES.map(r=>`<option>${r}</option>`).join("")}
    </select></div>
  </div>
  <div class="row2">
    <div class="field"><label>Début</label><input id="pe-deb" type="date" value="${todayISO()}"></div>
    <div class="field"><label>Deadline prévue</label><input id="pe-fin" type="date"></div>
  </div>
  <div class="row2">
    <div class="field"><label>Priorité</label><select id="pe-prio">
      <option value="1">🔴 Urgente</option>
      <option value="2" selected>🟡 Normale</option>
      <option value="3">🟢 Basse</option>
    </select></div>
    <div class="field"><label>Statut initial</label><select id="pe-statut">
      <option value="en_attente">En attente</option>
      <option value="en_cours">En cours</option>
    </select></div>
  </div>
  <div class="field"><label>Notes</label><textarea id="pe-notes" rows="2" placeholder="Instructions, fichiers attendus..."></textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveProdEtape()">Créer l'étape</button>
  </div>`);
}

async function saveProdEtape(){
  const gv=id=>document.getElementById(id)?.value?.trim()||"";
  const cmdId=gv("pe-cmd"); if(!cmdId){toast("Commande requise");return;}
  const etape=gv("pe-etape"); if(!etape){toast("Étape requise");return;}

  const e={
    id:crypto.randomUUID(),
    commande_id:cmdId, etape,
    statut:gv("pe-statut")||"en_attente",
    operateur_id:gv("pe-op")||null,
    role_operateur:gv("pe-role")||"",
    date_debut:gv("pe-deb")||null,
    date_fin_prev:gv("pe-fin")||null,
    priorite:+gv("pe-prio")||2,
    notes:gv("pe-notes")||"",
  };

  await dbUpsert("crm_prod_etapes", e);
  (DB.prodEtapes=DB.prodEtapes||[]).push(e);

  // Journal activité
  const log={id:crypto.randomUUID(),commande_id:cmdId,etape_id:e.id,auteur_id:USER?.id||null,type_action:"avancement",message:`Étape "${prodEtapeLabel(etape)}" créée — statut : ${PROD_STATUTS[e.statut]?.label||e.statut}`,created_at:new Date().toISOString()};
  await dbUpsert("crm_prod_activite",log);
  (DB.prodActivite=DB.prodActivite||[]).push(log);

  toast(`✅ Étape ${prodEtapeLabel(etape)} créée`);
  closeOverlays();
  go("production");
}

// ── Changer statut d'une étape rapidement ───────────────────────
function changerStatutEtape(id){
  if(!wr("production"))return;
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  modal(`<h2>🔄 Changer le statut</h2>
  <div style="font-size:13px;font-weight:600;margin-bottom:12px">${prodEtapeIcon(e.etape)} ${prodEtapeLabel(e.etape)}</div>
  <div style="display:flex;flex-direction:column;gap:8px">
  ${Object.entries(PROD_STATUTS).map(([k,v])=>`
  <button onclick="setStatutEtape('${id}','${k}')" style="padding:10px 16px;border-radius:8px;border:2px solid ${e.statut===k?"var(--cyan)":"var(--ligne)"};background:${e.statut===k?"var(--cyan)18":"var(--carte)"};text-align:left;cursor:pointer;font-size:13px;font-weight:${e.statut===k?"700":"400"}">
    ${v.label}
  </button>`).join("")}
  </div>
  <div class="modal-actions"><button class="btn" onclick="closeOverlays()">Annuler</button></div>`);
}

async function setStatutEtape(id,newStatut){
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  const old=e.statut;
  e.statut=newStatut;
  if(newStatut==="en_cours"&&!e.date_debut) e.date_debut=todayISO();
  if(newStatut==="termine"&&!e.date_fin_reel) e.date_fin_reel=todayISO();
  await dbUpsert("crm_prod_etapes",e);

  const log={id:crypto.randomUUID(),commande_id:e.commande_id,etape_id:e.id,auteur_id:USER?.id||null,type_action:"avancement",message:`${prodEtapeLabel(e.etape)} : ${PROD_STATUTS[old]?.label} → ${PROD_STATUTS[newStatut]?.label}`,created_at:new Date().toISOString()};
  await dbUpsert("crm_prod_activite",log);
  (DB.prodActivite=DB.prodActivite||[]).push(log);

  toast(`✅ Statut mis à jour : ${PROD_STATUTS[newStatut]?.label}`);
  closeOverlays();
  go("production");
}

// ── Commenter une étape ──────────────────────────────────────────
function ajouterCommentaire(etapeId,cmdId){
  modal(`<h2>💬 Ajouter un commentaire</h2>
  <div class="field"><label>Type</label><select id="ac-type">
    <option value="commentaire">💬 Commentaire</option>
    <option value="alerte">⚠️ Alerte</option>
    <option value="validation">✅ Validation</option>
    <option value="revision">🔄 Révision demandée</option>
  </select></div>
  <div class="field"><label>Message *</label><textarea id="ac-msg" rows="3" placeholder="Décrivez l'avancement, un problème..."></textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveCommentaire('${etapeId}','${cmdId}')">Enregistrer</button>
  </div>`);
}

async function saveCommentaire(etapeId,cmdId){
  const msg=document.getElementById("ac-msg")?.value?.trim();
  if(!msg){toast("Message requis");return;}
  const type=document.getElementById("ac-type")?.value||"commentaire";
  const log={id:crypto.randomUUID(),commande_id:cmdId,etape_id:etapeId,auteur_id:USER?.id||null,type_action:type,message:msg,created_at:new Date().toISOString()};
  await dbUpsert("crm_prod_activite",log);
  (DB.prodActivite=DB.prodActivite||[]).push(log);
  toast("✅ Commentaire enregistré");
  closeOverlays();
}

// ── openAjoutActivite (bouton journal) ──────────────────────────
function openAjoutActivite(){
  const cmdOpts=(DB.commandes||[]).filter(c=>c.statut!=="livré"&&c.statut!=="facturé")
    .map(c=>`<option value="${c.id}">${esc(c.numero)} — ${esc(c.titre)}</option>`).join("");
  modal(`<h2>📝 Nouvelle entrée journal</h2>
  <div class="field"><label>Commande</label><select id="aa-cmd"><option value="">— Générale —</option>${cmdOpts}</select></div>
  <div class="field"><label>Type</label><select id="aa-type">
    <option value="commentaire">💬 Commentaire</option>
    <option value="avancement">⏩ Avancement</option>
    <option value="alerte">⚠️ Alerte</option>
    <option value="validation">✅ Validation</option>
  </select></div>
  <div class="field"><label>Message *</label><textarea id="aa-msg" rows="3"></textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="saveActivite()">Enregistrer</button>
  </div>`);
}

async function saveActivite(){
  const msg=document.getElementById("aa-msg")?.value?.trim(); if(!msg){toast("Message requis");return;}
  const log={id:crypto.randomUUID(),commande_id:document.getElementById("aa-cmd")?.value||null,etape_id:null,auteur_id:USER?.id||null,type_action:document.getElementById("aa-type")?.value||"commentaire",message:msg,created_at:new Date().toISOString()};
  await dbUpsert("crm_prod_activite",log);
  (DB.prodActivite=DB.prodActivite||[]).push(log);
  toast("✅ Entrée enregistrée");
  closeOverlays();
  go("production");
}

// ── Initialiser les étapes de toutes les commandes actives ───────
function initEtapesCommande(){
  if(!wr("production"))return;
  const actives=(DB.commandes||[]).filter(c=>c.statut!=="livré"&&c.statut!=="facturé");
  const sansEtape=actives.filter(c=>!(DB.prodEtapes||[]).some(e=>e.commande_id===c.id));
  if(!sansEtape.length){toast("Toutes les commandes ont déjà des étapes ✅");return;}
  confirmModal(`Initialiser la production pour ${sansEtape.length} commande(s) ?`,
  `Créera l'étape "Brief" pour chaque commande sans étape de production.`,
  async()=>{
    for(const cmd of sansEtape){
      const e={id:crypto.randomUUID(),commande_id:cmd.id,etape:"brief",statut:"en_cours",operateur_id:cmd.responsableId||cmd.responsable_id||null,date_debut:todayISO(),priorite:2,notes:""};
      await dbUpsert("crm_prod_etapes",e);
      (DB.prodEtapes=DB.prodEtapes||[]).push(e);
    }
    toast(`✅ ${sansEtape.length} commande(s) initialisées`);
    go("production");
  });
}

// ── editProdEtape (modifier) ─────────────────────────────────────
function editProdEtape(id){
  if(!wr("production"))return;
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  const usrOpts=(DB.users||[]).filter(u=>u.active!==false)
    .map(u=>`<option value="${u.id}" ${e.operateur_id===u.id?"selected":""}>${esc(u.name)}</option>`).join("");
  modal(`<h2>✏️ Modifier l'étape</h2>
  <div class="row2">
    <div class="field"><label>Opérateur</label><select id="epe-op"><option value="">— Non assigné —</option>${usrOpts}</select></div>
    <div class="field"><label>Priorité</label><select id="epe-prio">
      <option value="1" ${e.priorite==1?"selected":""}>🔴 Urgente</option>
      <option value="2" ${e.priorite==2?"selected":""}>🟡 Normale</option>
      <option value="3" ${e.priorite==3?"selected":""}>🟢 Basse</option>
    </select></div>
  </div>
  <div class="row2">
    <div class="field"><label>Début</label><input id="epe-deb" type="date" value="${e.date_debut||""}"></div>
    <div class="field"><label>Deadline prévue</label><input id="epe-fin" type="date" value="${e.date_fin_prev||""}"></div>
  </div>
  <div class="field"><label>Notes</label><textarea id="epe-notes" rows="3">${esc(e.notes||"")}</textarea></div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-danger" onclick="delProdEtape('${id}')">Supprimer</button>
    <button class="btn btn-primary" onclick="updateProdEtape('${id}')">Enregistrer</button>
  </div>`);
}

async function updateProdEtape(id){
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  const gv=eid=>document.getElementById(eid)?.value?.trim()||"";
  Object.assign(e,{operateur_id:gv("epe-op")||null,priorite:+gv("epe-prio")||2,date_debut:gv("epe-deb")||null,date_fin_prev:gv("epe-fin")||null,notes:gv("epe-notes")||""});
  await dbUpsert("crm_prod_etapes",e);
  toast("✅ Étape mise à jour");
  closeOverlays();
  go("production");
}

async function delProdEtape(id){
  if(!wr("production"))return;
  const e=(DB.prodEtapes||[]).find(x=>x.id===id); if(!e)return;
  confirmModal("Supprimer cette étape ?","Cette action est irréversible.",async()=>{
    DB.prodEtapes=DB.prodEtapes.filter(x=>x.id!==id);
    await SB.from("crm_prod_etapes").delete().eq("id",id);
    toast("Étape supprimée");
    closeOverlays();
    go("production");
  });
}

/* ============================================================
   MODULE EMAIL — Envoi de devis/factures depuis le CRM
   From : Creatis Studio <infos@creatis-ci.com>
   Via  : Supabase Edge Function crm-send-email (Resend)
   ============================================================ */

const EMAIL_FN = `${typeof SUPABASE_URL!=="undefined"?SUPABASE_URL.replace("/rest/v1",""):""}/functions/v1/crm-send-email`.replace("https://","https://").replace("//functions","https://crlfkiniwalhzvpxrqav.supabase.co/functions");
// URL directe de la fonction
const CRM_EMAIL_URL = "https://kxnyinktawdblomkbukb.supabase.co/functions/v1/crm-send-email";

// ── Ouvrir modal envoi email ─────────────────────────────────────
function openEmailDoc(kind, id){
  if(!wr(kind))return;
  const doc = kind==="factures"
    ? (DB.factures||[]).find(x=>x.id===id)
    : (DB.devis||[]).find(x=>x.id===id);
  if(!doc){toast("Document introuvable");return;}

  const cli  = (DB.clients||[]).find(x=>x.id===doc.clientId)||{};
  const isF  = kind==="factures";
  const dev  = DB.settings.devise||"F CFA";
  const fmt  = n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");
  const co   = DB.settings.company||{};

  // Objet par défaut
  const defSubject = isF
    ? `Facture ${doc.numero} — ${co.name||"Creatis Studio"}`
    : `Devis ${doc.numero} — ${co.name||"Creatis Studio"}`;

  // Corps par défaut
  const defBody = isF
    ? `Bonjour ${esc(cli.contact||cli.nom||"")},\n\nVeuillez trouver ci-joint votre facture ${doc.numero} d'un montant de ${fmt(doc.montantTTC)} ${dev}.\n\nDate d'échéance : ${doc.echeance?new Date(doc.echeance).toLocaleDateString("fr-FR"):"—"}\n\nN'hésitez pas à nous contacter pour toute question.\n\nCordialement,\n${co.name||"Creatis Studio"}\n${co.tel||""} · ${co.email||"infos@creatis-ci.com"}`
    : `Bonjour ${esc(cli.contact||cli.nom||"")},\n\nVeuillez trouver ci-joint notre devis ${doc.numero} d'un montant de ${fmt(doc.montantTTC)} ${dev}.\n\nCe devis est valable jusqu'au : ${doc.validite?new Date(doc.validite).toLocaleDateString("fr-FR"):"—"}\n\nN'hésitez pas à nous contacter pour toute question.\n\nCordialement,\n${co.name||"Creatis Studio"}\n${co.tel||""} · ${co.email||"infos@creatis-ci.com"}`;

  // Historique des emails précédents pour ce doc
  const logs = (DB.emailLogs||[]).filter(l=>l.doc_id===id)
    .sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,3);

  modal(`<h2>📧 Envoyer ${isF?"la facture":"le devis"} par email</h2>
  <div style="padding:8px 12px;background:var(--papier);border-radius:6px;font-size:11px;margin-bottom:12px">
    De : <strong>infos@creatis-ci.com</strong> · via Resend
  </div>
  <div class="field"><label>Destinataire (email du client) *</label>
    <input id="em-to" type="email" value="${esc(cli.email||"")}" placeholder="client@example.com">
  </div>
  <div class="field"><label>Objet *</label>
    <input id="em-subject" value="${esc(defSubject)}">
  </div>
  <div class="field"><label>Message *</label>
    <textarea id="em-body" rows="8" style="font-size:12px;font-family:monospace">${esc(defBody)}</textarea>
  </div>
  ${logs.length?`<div style="margin-top:8px;padding:8px;background:var(--papier);border-radius:6px">
    <div style="font-size:10px;font-weight:700;color:var(--txt-2);margin-bottom:4px">ENVOIS PRÉCÉDENTS</div>
    ${logs.map(l=>`<div style="font-size:11px;display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--ligne)">
      <span>${esc(l.destinataire)}</span>
      <span style="color:${l.statut==="envoye"?"var(--ok)":"var(--danger)"}">${l.statut==="envoye"?"✅":"❌"} ${new Date(l.created_at||0).toLocaleDateString("fr-FR")}</span>
    </div>`).join("")}
  </div>`:""}
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="sendDocEmail('${kind}','${id}')">📤 Envoyer</button>
  </div>`);
}

// ── Construire HTML email brandé Creatis ─────────────────────────
function buildEmailHtml(kind, doc, bodyText){
  const co  = DB.settings.company||{};
  const dev = DB.settings.devise||"F CFA";
  const fmt = n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");
  const isF = kind==="factures";
  const cli = (DB.clients||[]).find(x=>x.id===doc.clientId)||{};

  const bodyHtml = esc(bodyText||"").replace(/\n/g,"<br>");

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#F1F2F4;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 8px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <!-- Bande CMJN -->
  <tr>
    <td width="150" style="background:#00AEEF;height:5px"></td>
    <td width="150" style="background:#EC008C;height:5px"></td>
    <td width="150" style="background:#FFC400;height:5px"></td>
    <td width="150" style="background:#1A1A1C;height:5px"></td>
  </tr>
  <!-- En-tête -->
  <tr><td colspan="4" style="padding:24px 32px 16px">
    <table width="100%"><tr>
      <td>
        <img src="https://gescom-creatis.vercel.app/logo.png" alt="Creatis Studio" style="height:52px;width:auto;object-fit:contain;display:block;margin-bottom:4px">
      </td>
      <td align="right">
        <div style="font-size:14px;font-weight:700;color:${isF?"#EC008C":"#00AEEF"}">${isF?"FACTURE":"DEVIS"}</div>
        <div style="font-size:16px;font-weight:800;color:#1A1A1C">${esc(doc.numero||"")}</div>
      </td>
    </tr></table>
  </td></tr>
  <!-- Corps -->
  <tr><td colspan="4" style="padding:0 32px 20px">
    <p style="font-size:14px;line-height:1.7;color:#1A1A1C">${bodyHtml}</p>
  </td></tr>
  <!-- Récap montants -->
  <tr><td colspan="4" style="padding:0 32px 24px">
    <table width="100%" style="background:#F7F7F8;border-radius:6px">
      <tr>
        <td style="padding:12px 16px;font-size:12px;color:#555">Montant HT</td>
        <td align="right" style="padding:12px 16px;font-size:12px;font-weight:600">${fmt(doc.montantHT||0)} ${dev}</td>
      </tr>
      <tr>
        <td style="padding:4px 16px;font-size:12px;color:#555">TVA ${doc.tva||18}%</td>
        <td align="right" style="padding:4px 16px;font-size:12px">${fmt(doc.montantTVA||0)} ${dev}</td>
      </tr>
      <tr style="border-top:2px solid #1A1A1C">
        <td style="padding:12px 16px;font-size:14px;font-weight:800;color:#1A1A1C">Total TTC</td>
        <td align="right" style="padding:12px 16px;font-size:16px;font-weight:800;color:#EC008C">${fmt(doc.montantTTC||0)} ${dev}</td>
      </tr>
    </table>
  </td></tr>
  <!-- Pied -->
  <tr style="background:#1A1A1C"><td colspan="4" style="padding:16px 32px">
    <div style="font-size:11px;color:rgba(255,255,255,.6);line-height:1.8">
      ${esc(co.name||"CREATIS STUDIO")} — RC ${esc(co.rc||"")} — CC ${esc(co.cc||"")}
      <br>${esc(co.siege||"")} — Tél : ${esc(co.tel||"")} — ${esc(co.email||"infos@creatis-ci.com")}
    </div>
  </td></tr>
  <!-- Bande bas -->
  <tr>
    <td width="150" style="background:#00AEEF;height:3px"></td>
    <td width="150" style="background:#EC008C;height:3px"></td>
    <td width="150" style="background:#FFC400;height:3px"></td>
    <td width="150" style="background:#1A1A1C;height:3px"></td>
  </tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Envoyer le doc ───────────────────────────────────────────────
async function sendDocEmail(kind, id){
  const to      = document.getElementById("em-to")?.value?.trim();
  const subject = document.getElementById("em-subject")?.value?.trim();
  const bodyTxt = document.getElementById("em-body")?.value?.trim();

  if(!to||!subject||!bodyTxt){toast("Tous les champs sont requis");return;}
  if(!to.includes("@")){toast("Adresse email invalide");return;}

  const doc = kind==="factures"
    ? (DB.factures||[]).find(x=>x.id===id)
    : (DB.devis||[]).find(x=>x.id===id);

  const btn=document.querySelector('.modal-b .btn-primary');
  if(btn){btn.textContent="⏳ Envoi…";btn.disabled=true;}

  try {
    const html = buildEmailHtml(kind, doc, bodyTxt);
    const resp = await fetch(CRM_EMAIL_URL, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        to, subject, html,
        type: kind==="factures"?"facture":"devis",
        docId: id,
        docNumero: doc?.numero||"",
        envoyePar: USER?.id||null,
      }),
    });
    const data = await resp.json();

    if(!resp.ok || data.error){
      toast("❌ Erreur envoi : "+(data.error||"Vérifiez la clé Resend"));
      if(btn){btn.textContent="📤 Envoyer";btn.disabled=false;}
      return;
    }

    // Mettre à jour le log local
    const log={id:crypto.randomUUID(),type:kind==="factures"?"facture":"devis",
      doc_id:id,doc_numero:doc?.numero||"",destinataire:to,sujet:subject,
      statut:"envoye",erreur:null,created_at:new Date().toISOString()};
    (DB.emailLogs=DB.emailLogs||[]).unshift(log);

    toast(`✅ Email envoyé à ${to}`);
    closeOverlays();

  } catch(err){
    toast("❌ Erreur réseau : "+String(err));
    if(btn){btn.textContent="📤 Envoyer";btn.disabled=false;}
  }
}

// ── Ouvrir modal relance paiement ────────────────────────────────
function openRelanceEmail(factureId){
  if(!wr("factures"))return;
  const f = (DB.factures||[]).find(x=>x.id===factureId);
  if(!f)return;
  const cli = (DB.clients||[]).find(x=>x.id===f.clientId)||{};
  const co  = DB.settings.company||{};
  const dev = DB.settings.devise||"F CFA";
  const fmt = n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ");
  const reste = (f.montantTTC||0) - (f.paiements||[]).reduce((s,p)=>s+(+p.montant||0),0);
  const defBody = `Bonjour ${esc(cli.contact||cli.nom||"")},\n\nNous nous permettons de vous relancer concernant la facture ${f.numero} d'un montant de ${fmt(f.montantTTC)} ${dev}, dont le solde restant est de ${fmt(reste)} ${dev}.\n\nDate d'échéance : ${f.echeance?new Date(f.echeance).toLocaleDateString("fr-FR"):"—"}\n\nNous vous serions reconnaissants de bien vouloir procéder au règlement dans les meilleurs délais.\n\nPour tout renseignement, n'hésitez pas à nous contacter.\n\nCordialement,\n${co.name||"Creatis Studio"}\n${co.tel||""} · ${co.email||"infos@creatis-ci.com"}`;

  modal(`<h2>🔔 Relance paiement — ${f.numero}</h2>
  <div style="padding:8px 12px;background:var(--danger)10;border-radius:6px;font-size:12px;margin-bottom:12px;color:var(--danger)">
    Reste à encaisser : <strong>${fmt(reste)} ${dev}</strong>
  </div>
  <div class="field"><label>Email client *</label>
    <input id="em-to" type="email" value="${esc(cli.email||"")}" placeholder="client@example.com">
  </div>
  <div class="field"><label>Objet</label>
    <input id="em-subject" value="Relance facture ${f.numero} — ${co.name||"Creatis Studio"}">
  </div>
  <div class="field"><label>Message *</label>
    <textarea id="em-body" rows="8" style="font-size:12px;font-family:monospace">${esc(defBody)}</textarea>
  </div>
  <div class="modal-actions">
    <button class="btn" onclick="closeOverlays()">Annuler</button>
    <button class="btn btn-primary" onclick="sendDocEmail('factures','${factureId}')">📤 Envoyer la relance</button>
  </div>`);
}

// ── Helper : mini-historique emails pour un document ────────────
function emailHistoryHtml(docId){
  const logs=(DB.emailLogs||[]).filter(l=>l.doc_id===docId)
    .sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,3);
  if(!logs.length)return "";
  return`<div style="margin-top:14px;padding:10px 12px;background:var(--papier);border-radius:6px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt-2);margin-bottom:6px">Emails envoyés</div>
    ${logs.map(l=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--ligne);font-size:11px">
      <div>
        <span style="color:${l.statut==="envoye"?"var(--ok)":"var(--danger)"}">${l.statut==="envoye"?"✅":"❌"}</span>
        ${esc(l.destinataire)}
      </div>
      <div style="color:var(--txt-2)">${new Date(l.created_at||0).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
    </div>`).join("")}
  </div>`;
}
