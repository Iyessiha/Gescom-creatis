-- ============================================================
-- CREATIS STUDIO — CRM  ·  Schema Supabase
-- ============================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- PARAMÈTRES SOCIÉTÉ (ligne unique)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company     jsonb NOT NULL DEFAULT '{}'::jsonb,
  tva         numeric NOT NULL DEFAULT 18,
  devise      text NOT NULL DEFAULT 'F CFA',
  year        integer NOT NULL DEFAULT EXTRACT(year FROM NOW()),
  seq_devis   integer NOT NULL DEFAULT 1,
  seq_facture integer NOT NULL DEFAULT 1,
  seq_commande integer NOT NULL DEFAULT 1,
  updated_at  timestamptz DEFAULT now()
);

-- ============================================================
-- RÔLES ET DROITS
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT 'noir',
  system_role boolean NOT NULL DEFAULT false,
  perms      jsonb NOT NULL DEFAULT '{}'::jsonb,
  widgets    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- UTILISATEURS (auth personnalisée, SHA-256)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  login      text NOT NULL UNIQUE,
  role_id    text NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active     boolean NOT NULL DEFAULT true,
  pass       text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- CLIENTS & PROSPECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL DEFAULT 'prospect' CHECK (type IN ('client','prospect')),
  nom        text NOT NULL,
  contact    text,
  segment    text,
  tel        text,
  email      text,
  adresse    text,
  source     text,
  notes      text,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- CATALOGUE PRODUITS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  designation text NOT NULL,
  categorie   text,
  pu          numeric NOT NULL DEFAULT 0,
  unite       text NOT NULL DEFAULT 'unité',
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- DEVIS
-- ============================================================
CREATE TABLE IF NOT EXISTS devis (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero      text UNIQUE,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  date        date,
  validite    date,
  statut      text NOT NULL DEFAULT 'brouillon',
  lignes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  tva         numeric NOT NULL DEFAULT 18,
  montant_ht  numeric NOT NULL DEFAULT 0,
  montant_tva numeric NOT NULL DEFAULT 0,
  montant_ttc numeric NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- FACTURES
-- ============================================================
CREATE TABLE IF NOT EXISTS factures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero      text UNIQUE,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  devis_id    uuid REFERENCES devis(id) ON DELETE SET NULL,
  date        date,
  echeance    date,
  lignes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  tva         numeric NOT NULL DEFAULT 18,
  statut      text NOT NULL DEFAULT 'brouillon',
  paiements   jsonb NOT NULL DEFAULT '[]'::jsonb,
  montant_ht  numeric NOT NULL DEFAULT 0,
  montant_tva numeric NOT NULL DEFAULT 0,
  montant_ttc numeric NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- COMMANDES & PROJETS
-- ============================================================
CREATE TABLE IF NOT EXISTS commandes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero      text UNIQUE,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  titre       text NOT NULL,
  devis_id    uuid REFERENCES devis(id) ON DELETE SET NULL,
  facture_id  uuid REFERENCES factures(id) ON DELETE SET NULL,
  statut      text NOT NULL DEFAULT 'devis',
  deadline    date,
  notes       text,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- DÉPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS depenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date,
  libelle     text NOT NULL,
  categorie   text,
  fournisseur text,
  ht          numeric NOT NULL DEFAULT 0,
  tva         numeric NOT NULL DEFAULT 0,
  ttc         numeric NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Chaque table est protégée : seules les requêtes avec la
-- clé anon (SUPABASE_ANON_KEY) depuis l'app peuvent accéder.
-- Aucune donnée n'est accessible sans la clé.
-- ============================================================
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE devis         ENABLE ROW LEVEL SECURITY;
ALTER TABLE factures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE commandes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE depenses      ENABLE ROW LEVEL SECURITY;

-- Politique : accès total pour le rôle anon (protégé par la clé API)
-- Pour renforcer la sécurité plus tard : restreindre à authenticated
-- et utiliser Supabase Auth à la place de l'auth custom.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_settings','roles','profiles','clients','products','devis','factures','commandes','depenses']
  LOOP
    EXECUTE format('CREATE POLICY "anon_all_%s" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;

-- ============================================================
-- DONNÉES PAR DÉFAUT : rôles & paramètres société
-- ============================================================
INSERT INTO app_settings (company, tva, devise, year, seq_devis, seq_facture, seq_commande)
VALUES (
  '{"name":"Creatis Studio","activite":"Création · Impression · Fournitures de bureau · Gadgets","forme":"SARL","capital":"1 000 000 F CFA","siege":"Cocody Val Doyen 4 — Duplex Appartement 135","tel":"27 22 44 23 06","cel":"07 07 96 40 01","email":"infos@creatis-ci.com","site":"www.creatis-ci.com","rc":"CI-ABJ-2007-B-3172","cc":"0811105V","banque":"SGCI N° CI008 01111 011151700304 93","regime":"Réel Simplifié","centre":"II Plateaux 2","mentions":"SARL au capital de 1 000 000 F CFA"}'::jsonb,
  18, 'F CFA', EXTRACT(year FROM NOW()), 1, 1, 1
) ON CONFLICT DO NOTHING;

INSERT INTO roles (id, name, color, system_role, perms, widgets) VALUES
('administrateur', 'Administrateur', 'noir', true,
  '{"dashboard":"edit","clients":"edit","devis":"edit","factures":"edit","commandes":"edit","compta":"edit","catalogue":"edit","users":"edit","parametres":"edit"}'::jsonb,
  ARRAY['kpi_encaisse','kpi_reste','kpi_devis','kpi_leads','chart_ca','pipe_devis','list_relance','list_echeances']),
('commercial', 'Commercial', 'cyan', false,
  '{"dashboard":"view","clients":"edit","devis":"edit","factures":"edit","commandes":"edit","compta":"none","catalogue":"edit","users":"none","parametres":"none"}'::jsonb,
  ARRAY['kpi_devis','kpi_leads','kpi_encaisse','kpi_prod','pipe_devis','list_relance']),
('comptable', 'Comptable', 'mag', false,
  '{"dashboard":"view","clients":"view","devis":"view","factures":"edit","commandes":"view","compta":"edit","catalogue":"view","users":"none","parametres":"none"}'::jsonb,
  ARRAY['kpi_encaisse','kpi_reste','kpi_tva','kpi_depenses','chart_ca','list_echeances']),
('production', 'Production', 'jaune', false,
  '{"dashboard":"view","clients":"view","devis":"view","factures":"none","commandes":"edit","compta":"none","catalogue":"view","users":"none","parametres":"none"}'::jsonb,
  ARRAY['kpi_prod','kpi_devis','list_prod']),
('accueil', 'Accueil / Information', 'cyan', false,
  '{"dashboard":"view","clients":"edit","devis":"view","factures":"none","commandes":"view","compta":"none","catalogue":"view","users":"none","parametres":"none"}'::jsonb,
  ARRAY['kpi_leads','kpi_devis','list_relance'])
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- COMPTE ADMIN PAR DÉFAUT
-- Login : admin  |  Mot de passe : Admin2025!
-- À changer après le premier accès via Utilisateurs & rôles
-- ============================================================
INSERT INTO profiles (id, name, login, role_id, active, pass)
VALUES (
  gen_random_uuid(),
  'Administrateur',
  'admin',
  'administrateur',
  true,
  '49930b8655862f6db7db2c82a544a2256a850f7e9dc46d34f7fa5c805045c217'
) ON CONFLICT (login) DO NOTHING;
