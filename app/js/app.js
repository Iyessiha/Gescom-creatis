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
         stockMvtRows, caissesRows, caisseMvtRows] = await Promise.all([
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
  const full={};["dashboard","clients","devis","factures","commandes","compta","catalogue","users","fournisseurs","fiscalite","depenses","crh","entrepot","caisses","parametres"].forEach(m=>full[m]="edit");
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

const LOGO_SVG=`<svg width="34" height="34" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="17" stroke="#FFC400" stroke-width="3.4" stroke-dasharray="58 90" transform="rotate(-30 20 20)"/><circle cx="20" cy="20" r="13.5" stroke="#EC008C" stroke-width="3.4" stroke-dasharray="44 90" transform="rotate(110 20 20)"/><circle cx="20" cy="20" r="13.5" stroke="#00AEEF" stroke-width="3.4" stroke-dasharray="40 120" transform="rotate(-110 20 20)"/><text x="20" y="26" font-family="Space Grotesk,sans-serif" font-size="20" font-weight="700" fill="#1A1A1C" text-anchor="middle">C</text></svg>`;

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
  {k:"caisses",label:"Caisses"}
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

// Section FNE dans viewParametres
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
    <button class="btn btn-primary" onclick="printFiscalite()">
      🖨️ Imprimer la fiche
    </button>
    <button class="btn" style="border-color:#1D6F42;color:#1D6F42" onclick="exportFiscaliteExcel()">
      📊 Excel
    </button>
    <button class="btn" onclick="openAcompte()">
      💳 Enregistrer un acompte
    </button>`;

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
  $("#pg-actions").innerHTML=wr("depenses")?`<button class="btn btn-primary" onclick="openDepense()">+ Nouvelle dépense</button>`:"";

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
  closeOverlays(); go("depenses");
}
async function delDepense(id){
  if(!confirm("Supprimer cette dépense ?"))return;
  await dbDelete("depenses",id);
  DB.depenses = DB.depenses.filter(x=>x.id!==id);
  toast("Dépense supprimée"); go("depenses");
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
  $("#pg-actions").innerHTML=wr("crh")?`<button class="btn btn-primary" onclick="openEmploye()">+ Ajouter employé</button>`:"";

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
  parametres:{t:"Paramètres",render:viewParametres},
  fournisseurs:{t:"Fournisseurs",render:viewFournisseurs},
  fiscalite:{t:"Fiscalité & Obligations",render:viewFiscalite},
  depenses:{t:"Dépenses",render:viewDepenses},
  crh:{t:"Ressources Humaines",render:viewCrh},
  entrepot:{t:"Entrepôt & Stock",render:viewEntrepot},
  caisses:{t:"Caisses & Trésorerie",render:viewCaisses},
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
  $("#pg-actions").innerHTML=`<button class="btn" onclick="exportExcel('clients')" style="border-color:#1D6F42;color:#1D6F42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>Excel</button><button class="btn btn-primary act-edit" onclick="editClient()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau contact</button>`;
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
  $("#pg-actions").innerHTML=`<button class="btn" onclick="exportExcel('${kind}')" style="border-color:#1D6F42;color:#1D6F42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>Excel</button><button class="btn btn-primary act-edit" onclick="editDoc('${kind}')"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>${isF?"Nouvelle facture":"Nouveau devis"}</button>`;
  if(!list.length){$("#view").innerHTML=emptyState(isF?"Aucune facture":"Aucun devis","",isF?"Nouvelle facture":"Nouveau devis",`editDoc('${kind}')`);return}
  $("#view").innerHTML=`<div style="overflow-x:auto"><table><thead><tr><th>Numéro</th><th>Client</th><th>Date</th><th>${isF?"Échéance":"Validité"}</th><th class="r">Total TTC</th><th>Statut</th><th>FNE</th><th></th></tr></thead><tbody>
    ${list.map(d=>`<tr class="clk" onclick="${isF?`openFacture`:`openDevis`}('${d.id}')">
      <td><div class="nm tabnum">${esc(d.numero)}</div></td>
      <td class="meta">${esc(clientName(d.clientId))}</td>
      <td class="meta">${fdate(d.date)}</td>
      <td class="meta">${isF?fdate(d.echeance):fdate(d.validite)}</td>
      <td class="r tabnum">${fcfa(d.montantTTC)}</td>
      <td>${pill(isF?factStatut(d):d.statut)}</td>
      <td style="font-size:10px">${isF?fneBadge(d):""}</td>
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
     (f.fneStatus!=="certifiee")?{label:"🔒 Certifier FNE",cls:"btn",edit:1,fn:`certifierFNE('${id}')`}:null,
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
          <svg width="30" height="30" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="16" stroke="#FFC400" stroke-width="3.4" stroke-dasharray="58 90" transform="rotate(-30 20 20)"/>
            <circle cx="20" cy="20" r="12.5" stroke="#EC008C" stroke-width="3.4" stroke-dasharray="44 90" transform="rotate(110 20 20)"/>
            <circle cx="20" cy="20" r="12.5" stroke="#00AEEF" stroke-width="3.4" stroke-dasharray="40 120" transform="rotate(-110 20 20)"/>
            <text x="20" y="26" font-family="Arial" font-size="15" font-weight="700" fill="#1A1A1C" text-anchor="middle">C</text>
          </svg>
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
  $("#pg-actions").innerHTML=`<button class="btn" onclick="exportExcel('commandes')" style="border-color:#1D6F42;color:#1D6F42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>Excel</button><button class="btn btn-primary act-edit" onclick="editCmd()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouvelle commande</button>`;
  if(!DB.commandes.length){$("#view").innerHTML=emptyState("Aucune commande","Créez votre première commande.","Nouvelle commande","editCmd()");return}
  const cols=CMD_FLOW.map(([k,l])=>({k,l,items:DB.commandes.filter(c=>c.statut===k)}));
  $("#view").innerHTML=`<div class="kanban">${cols.map(col=>`
    <div class="kol"><div class="kol-h">${col.l} <span class="badge" style="background:rgba(255,255,255,.15)">${col.items.length}</span></div>
    ${col.items.map(c=>{const late=c.deadline&&new Date(c.deadline)<new Date()&&c.statut!=="livré"&&c.statut!=="facturé";return`<div class="kard ${late?"late":""}" onclick="openCmd('${c.id}')">
      <div class="kard-t">${esc(c.titre)}</div>
      <div class="kard-m"><span>${esc(clientName(c.clientId))}</span>${c.deadline?`<span class="${late?"text-danger":""}">${fdate(c.deadline)}</span>`:""}</div>
      ${(()=>{const u=DB.users.find(x=>x.id===(c.responsableId||c.responsable_id));return u?`<div style="font-size:10px;color:var(--cyan);margin-top:3px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">👤 ${esc(u.name)}</div>`:""})()}
      ${(c.statutBat||c.statut_bat)&&(c.statutBat||c.statut_bat)!=="non_demarre"?`<div style="margin-top:4px">${batBadge(c.statutBat||c.statut_bat)}</div>`:""}
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
   BOOT ASYNC
   ============================================================ */
(async function boot(){
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
})();
/* ============================================================
   FOURNISSEURS
   ============================================================ */
function fournisseurName(id){ const f=DB.fournisseurs.find(x=>x.id===id); return f?f.nom:"—"; }

function viewFournisseurs(){
  if(!vis("fournisseurs"))return;
  $("#pg-actions").innerHTML=`
    <button class="btn" onclick="exportExcel('fournisseurs')" style="border-color:#1D6F42;color:#1D6F42"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l4 4-4 4M12 16h4"/></svg>Excel</button>
    <button class="btn btn-primary act-edit" onclick="editFournisseur()"><svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Nouveau fournisseur</button>`;

  if(!DB.fournisseurs.length){
    $("#view").innerHTML=emptyState("Aucun fournisseur","Ajoutez vos fournisseurs habituels.","Nouveau fournisseur","editFournisseur()");return;
  }
  const actifs=DB.fournisseurs.filter(f=>f.actif!==false);
  const inactifs=DB.fournisseurs.filter(f=>f.actif===false);
  $("#view").innerHTML=`
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span><div class="lab">Fournisseurs actifs</div><div class="val tabnum">${actifs.length}</div></div>
    <div class="card kpi c-mag"><span class="tick"></span><div class="lab">Dépenses liées</div><div class="val tabnum">${fcfa(DB.depenses.filter(d=>d.fournisseurId).reduce((s,d)=>s+(+d.ttc||0),0))}</div></div>
    <div class="card kpi c-jaune"><span class="tick"></span><div class="lab">Secteurs</div><div class="val tabnum">${new Set(DB.fournisseurs.map(f=>f.secteur||"Autre")).size}</div></div>
    <div class="card kpi c-noir"><span class="tick"></span><div class="lab">Fournisseurs inactifs</div><div class="val tabnum">${inactifs.length}</div></div>
  </div>
  <div class="card" style="overflow-x:auto"><table><thead><tr>
    <th>Nom</th><th>Contact</th><th>Secteur</th><th>Téléphone</th><th>Email</th>
    <th>Conditions</th><th>Dépenses</th><th>Statut</th><th></th>
  </tr></thead><tbody>
  ${DB.fournisseurs.map(f=>{
    const depF=DB.depenses.filter(d=>(d.fournisseurId||d.fournisseur_id)===f.id).reduce((s,d)=>s+(+d.ttc||0),0);
    return`<tr class="clk" onclick="openFournisseur('${f.id}')">
      <td><div class="nm">${esc(f.nom)}</div><div class="meta">${esc(f.numeroContribuable||f.numero_contribuable||"")}</div></td>
      <td class="meta">${esc(f.contact||"—")}</td>
      <td><span class="seg">${esc(f.secteur||"—")}</span></td>
      <td class="meta">${esc(f.tel||"—")}</td>
      <td class="meta">${esc(f.email||"—")}</td>
      <td class="meta">${esc(f.conditionsPaiement||f.conditions_paiement||"—")}</td>
      <td class="r tabnum">${depF?fcfa(depF):"—"}</td>
      <td>${f.actif!==false?'<span class="pill p-green"><span class="dot"></span>Actif</span>':'<span class="pill p-grey"><span class="dot"></span>Inactif</span>'}</td>
      <td class="r" onclick="event.stopPropagation()"><button class="btn btn-sm btn-ghost act-edit" onclick="editFournisseur('${f.id}')">Modifier</button></td>
    </tr>`;
  }).join("")}
  </tbody></table></div>`;
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
     {label:id?"Enregistrer":"Créer",cls:"btn-primary",fn:`saveFournisseur('${id||""}')`}].filter(Boolean)
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
     {label:id?"Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveProduct('${id||""}')`}].filter(Boolean)
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
    <button class="btn btn-primary act-edit" onclick="editDepense()">+ Dépense</button>
    <button class="btn" onclick="openSaisieCompta()" style="border-color:var(--cyan);color:var(--cyan)">✏️ Écriture</button>
    <button class="btn" onclick="openBalance()" style="border-color:var(--mag);color:var(--mag)">⚖️ Balance</button>
    <button class="btn" style="border-color:#1D6F42;color:#1D6F42" onclick="exportExcel('depenses')">📊 Excel</button>`;

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
     {label:id?"Enregistrer":"Ajouter",cls:"btn-primary",fn:`saveDepense('${id||""}')`}].filter(Boolean)
  );
}

/* ============================================================
   ENTREPÔT & STOCK — Mouvements, niveaux, alertes
   ============================================================ */
function viewEntrepot(){
  if(!vis("entrepot"))return;
  const dev=DB.settings.devise||"F CFA";
  const fmt=n=>Math.round(n||0).toLocaleString("fr-FR").replace(/\u202f/g," ")+" "+dev;
  const fmtD=s=>s?new Date(s).toLocaleDateString("fr-FR"):"—";

  // KPIs stock
  const prods = DB.products||[];
  const enAlerte   = prods.filter(p=>(p.stock_actuel||0)<=(p.stock_minimum||0)&&(p.stock_minimum||0)>0);
  const valeurStock = prods.reduce((s,p)=>s+(+p.stock_actuel||0)*(+p.prix_achat||+p.pu||0),0);
  const totalMvt    = (DB.stockMvt||[]).length;

  const mvtPill={
    entree: `<span class="pill p-green"  style="font-size:10px"><span class="dot"></span>Entrée</span>`,
    sortie: `<span class="pill p-red"    style="font-size:10px"><span class="dot"></span>Sortie</span>`,
    ajustement:`<span class="pill p-amber" style="font-size:10px"><span class="dot"></span>Ajustement</span>`,
    inventaire:`<span class="pill p-cyan"  style="font-size:10px"><span class="dot"></span>Inventaire</span>`,
  };
  const motifLabel={achat:"🛒 Achat",vente:"🧾 Vente",perte:"❌ Perte",
    retour:"↩️ Retour",transfert:"🔄 Transfert",inventaire:"📋 Inventaire",ajustement:"⚙️ Ajustement"};

  $("#pg-title").textContent="Entrepôt & Stock";
  $("#pg-sub").textContent=`${prods.length} produits — Valeur stock : ${fmt(valeurStock)}`;
  $("#pg-actions").innerHTML=wr("entrepot")?`
    <button class="btn btn-primary" onclick="openMvtStock()">+ Mouvement de stock</button>
    <button class="btn" onclick="openInventaire()">📋 Inventaire</button>`:""

  $("#view").innerHTML=`
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi c-cyan"><span class="tick"></span>
      <div class="lab">Produits en catalogue</div>
      <div class="val">${prods.length}</div>
      <div class="delta">${prods.filter(p=>(p.stock_actuel||0)>0).length} en stock</div></div>
    <div class="card kpi c-jaune"><span class="tick"></span>
      <div class="lab">Valeur du stock</div>
      <div class="val tabnum">${fmt(valeurStock)}</div>
      <div class="delta">Prix d'achat × quantités</div></div>
    <div class="card kpi ${enAlerte.length?"c-rouge":"c-noir"}"><span class="tick"></span>
      <div class="lab">Alertes stock bas</div>
      <div class="val" style="color:${enAlerte.length?"var(--danger)":"inherit"}">${enAlerte.length}</div>
      <div class="delta">${enAlerte.length?"Produits sous le minimum":""}</div></div>
    <div class="card kpi c-mag"><span class="tick"></span>
      <div class="lab">Mouvements enregistrés</div>
      <div class="val">${totalMvt}</div>
      <div class="delta">Entrées, sorties, ajustements</div></div>
  </div>

  <div class="two-13" style="margin-bottom:14px">

    <!-- Niveaux de stock -->
    <div class="card panel">
      <div class="panel-h">
        <h3>📦 Niveaux de stock</h3><div class="spacer"></div>
        <select id="fil-stock-cat" onchange="renderStockList()" style="width:160px">
          <option value="">Toutes catégories</option>
          ${[...new Set(prods.map(p=>p.categorie).filter(Boolean))].map(c=>`<option>${c}</option>`).join("")}
        </select>
        <select id="fil-stock-alerte" onchange="renderStockList()" style="width:140px">
          <option value="">Tous</option>
          <option value="alerte">⚠️ Alerte uniquement</option>
          <option value="ok">✅ OK uniquement</option>
        </select>
      </div>
      <div id="stock-list"></div>
    </div>

    <!-- Colonne droite -->
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- Alertes -->
      ${enAlerte.length?`
      <div class="card panel" style="border-left:3px solid var(--danger)">
        <div class="panel-h"><h3>⚠️ Alertes stock</h3></div>
        ${enAlerte.slice(0,8).map(p=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--ligne);font-size:12px">
            <div>
              <div style="font-weight:600">${esc(p.designation||"")}</div>
              <div class="meta">${esc(p.reference||p.categorie||"")}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:700;color:var(--danger)">${p.stock_actuel||0} / min ${p.stock_minimum||0}</div>
            </div>
          </div>`).join("")}
      </div>`:`
      <div class="card panel">
        <div class="panel-h"><h3>✅ Stock en ordre</h3></div>
        <div class="meta" style="padding:8px 0">Aucun produit sous le seuil minimum</div>
      </div>`}

      <!-- Derniers mouvements -->
      <div class="card panel">
        <div class="panel-h"><h3>🔄 Derniers mouvements</h3><div class="spacer"></div>
          ${wr("entrepot")?`<button class="btn btn-sm" onclick="openMvtStock()">+</button>`:""}
        </div>
        ${(DB.stockMvt||[]).length===0?`<div class="empty">Aucun mouvement enregistré</div>`:""}
        ${(DB.stockMvt||[]).slice().sort((a,b)=>new Date(b.date||0)-new Date(a.date||0))
          .slice(0,8).map(m=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--ligne)">
            <div style="display:flex;align-items:center;gap:8px">
              ${mvtPill[m.type_mvt]||""}
              <div>
                <div style="font-size:12px;font-weight:600">${esc(m.produit_nom||"—")}</div>
                <div class="meta">${fmtD(m.date)} — ${esc(motifLabel[m.motif]||m.motif||"")}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;font-weight:700;color:${m.type_mvt==="entree"?"var(--ok)":"var(--danger)"}">
                ${m.type_mvt==="entree"?"+":"−"}${m.quantite}
              </div>
              <div class="meta">→ ${m.stock_apres}</div>
            </div>
          </div>`).join("")}
      </div>
    </div>
  </div>

  <!-- Historique complet -->
  <div class="card panel">
    <div class="panel-h"><h3>📋 Historique des mouvements</h3><div class="spacer"></div>
      <select id="fil-mvt-type" onchange="renderMvtList()" style="width:150px">
        <option value="">Tous types</option>
        <option value="entree">Entrées</option>
        <option value="sortie">Sorties</option>
        <option value="ajustement">Ajustements</option>
        <option value="inventaire">Inventaires</option>
      </select>
    </div>
    <div id="mvt-list"></div>
  </div>`;

  renderStockList();
  renderMvtList();
}

function renderStockList(){
  const cat = document.getElementById("fil-stock-cat")?.value||"";
  const alerte = document.getElementById("fil-stock-alerte")?.value||"";
  let rows = (DB.products||[]).filter(p=>
    (!cat||p.categorie===cat)&&
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
  $("#pg-actions").innerHTML=wr("caisses")?`
    <button class="btn btn-primary" onclick="openMvtCaisse()">+ Mouvement</button>
    <button class="btn" onclick="openCaisse()">+ Nouvelle caisse</button>`:"";

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
        ${wr("caisses")?`<div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn btn-sm" onclick="event.stopPropagation();openMvtCaisse('','${c.id}','entree')">+ Entrée</button>
          <button class="btn btn-sm" onclick="event.stopPropagation();openMvtCaisse('','${c.id}','sortie')">− Sortie</button>
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
  closeOverlays(); go("caisses");
}

async function delMvtCaisse(id, caisseId, impact){
  if(!confirm("Supprimer ce mouvement ?"))return;
  await dbDelete("crm_caisse_mvt",id);
  DB.caisseMvt=(DB.caisseMvt||[]).filter(x=>x.id!==id);
  toast("Mouvement supprimé");
  go("caisses");
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
  closeOverlays(); go("caisses");
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
  XLSX.utils.book_append_sheet(wb,ws,"Balance");
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
        <div style="font-size:20px;font-weight:800">${esc(co.name||"CREATIS STUDIO")}</div>
        <div style="font-size:10px;color:#8A8E97;letter-spacing:.18em;text-transform:uppercase;margin-top:2px">${esc(co.activite||"")}</div>
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
    <button class="btn" onclick="go('commandes')">📋 Voir le Kanban</button>
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

  const filtCompte=el.querySelector?.("select#fil-gl-compte")?.value||"";

  el.innerHTML=`
  <div class="card panel">
    <div class="panel-h">
      <h3>Grand Livre</h3><div class="spacer"></div>
      <select id="fil-gl-compte" onchange="renderComptaTab()" style="width:280px">
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
            </tr>`;
          }).join("")}
        </table>
      </div>`;
    }).join("")}
  </div>`;
}

// ── DÉPENSES (onglet dans Compta) ────────────────────────────────
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
  go("compta");
}
