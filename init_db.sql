-- ══════════════════════════════════════════════════════════════════════════════
--  UGC Mestre CRM — Estrutura do Banco de Dados PostgreSQL
--  Compatível com: Render PostgreSQL (gratuito) · Supabase · NocoDB
--  Execute este script UMA VEZ no banco recém-criado para inicializar.
-- ══════════════════════════════════════════════════════════════════════════════

-- Habilita extensão para timestamps com timezone (boa prática)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. LEADS ──────────────────────────────────────────────────────────────────
--  Tabela principal. Um registro por lead, com campos escalares indexáveis
--  e colunas JSONB para estruturas complexas (contatos, reasoning, histórico).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  -- Identificação
  id               INTEGER       PRIMARY KEY,
  nome             TEXT          NOT NULL,
  seg              TEXT,
  insta            TEXT,
  site             TEXT,
  canal            TEXT,
  pot              TEXT          CHECK (pot IN ('alto','medio','baixo')),
  capital          TEXT,
  valor            TEXT,
  agent            TEXT,
  tags             TEXT[]        DEFAULT '{}',
  seguidores       TEXT,
  engajamento      TEXT,

  -- Raio-X da Marca (campos editáveis — bloco Análise)
  just             TEXT,
  garg             TEXT,
  insight          TEXT,
  contatos         JSONB         DEFAULT '[]',       -- [{tipo, tag, val}]

  -- Operação / Pipeline
  stage            TEXT          NOT NULL DEFAULT 'prelista',
  tabs             TEXT[]        DEFAULT '{}',        -- estágios simultâneos
  escopo           TEXT[]        DEFAULT '{"ugc"}',   -- 'ugc' | 'gestao'
  status_flags     TEXT[]        DEFAULT '{}',        -- 'sazonal'|'interessada'|etc.
  data_captacao    DATE,
  proxima_acao     DATE,
  retomar_contato  DATE,
  cadencia_pausada BOOLEAN       DEFAULT FALSE,
  agent_note       TEXT,
  sazonal_note     TEXT,

  -- Agente 2
  inicio_cadencia  TIMESTAMPTZ,
  ag2_status       TEXT          CHECK (ag2_status IN ('aguardando','trabalhando','concluido') OR ag2_status IS NULL),
  ag2_reasoning    JSONB         DEFAULT '{}',        -- {overview, steps:{[stepId]:{canal,gancho}}}

  -- Histórico de ordens da Isis
  order_history    JSONB         DEFAULT '[]',        -- [{ts, cmd, resultado}]

  -- Controle
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- Índices para filtros mais usados no CRM
CREATE INDEX IF NOT EXISTS idx_leads_stage        ON leads (stage);
CREATE INDEX IF NOT EXISTS idx_leads_escopo       ON leads USING GIN (escopo);
CREATE INDEX IF NOT EXISTS idx_leads_status_flags ON leads USING GIN (status_flags);
CREATE INDEX IF NOT EXISTS idx_leads_proxima_acao ON leads (proxima_acao);


-- ── 2. CADÊNCIA ────────────────────────────────────────────────────────────────
--  Uma linha por etapa de cadência. Cada etapa pertence a um lead.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cadencia_etapas (
  id         TEXT          PRIMARY KEY,               -- ex: 's1719000000000'
  lead_id    INTEGER       NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  et         SMALLINT      NOT NULL,                  -- número da etapa (1, 2, 3…)
  titulo     TEXT          NOT NULL,
  canal      TEXT          NOT NULL,
  data       DATE,
  status     TEXT          DEFAULT 'pendente'
                           CHECK (status IN ('pendente','agendado','enviado','teve-resposta','ia-resposta','alterado','isis','automatizado')),
  roteiro    TEXT,                                    -- copy da mensagem
  motivo     TEXT,                                    -- justificativa de transição
  occ        TEXT,                                    -- o que aconteceu (ocorrência)
  locked     BOOLEAN       DEFAULT FALSE,
  created_at TIMESTAMPTZ   DEFAULT NOW(),
  updated_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cadencia_lead_id ON cadencia_etapas (lead_id);
CREATE INDEX IF NOT EXISTS idx_cadencia_status  ON cadencia_etapas (status);
CREATE INDEX IF NOT EXISTS idx_cadencia_data    ON cadencia_etapas (data);


-- ── 3. INTERAÇÕES ─────────────────────────────────────────────────────────────
--  Mensagens captadas e respostas da IA Atendente por lead.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interacoes (
  id         TEXT          PRIMARY KEY,               -- ex: 'im1719000000000'
  lead_id    INTEGER       NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  tipo       TEXT          NOT NULL CHECK (tipo IN ('ia','captada')),
  canal      TEXT,
  data       TEXT,                                   -- mantido como TEXT para compatibilidade com o CRM
  texto      TEXT,
  aprovado   BOOLEAN       DEFAULT FALSE,
  created_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interacoes_lead_id  ON interacoes (lead_id);
CREATE INDEX IF NOT EXISTS idx_interacoes_aprovado ON interacoes (aprovado) WHERE NOT aprovado;


-- ── 4. CLIENTES ATIVOS ─────────────────────────────────────────────────────────
--  Leads convertidos em clientes com contrato e pacote ativo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes_ativos (
  id             INTEGER       PRIMARY KEY,
  nome           TEXT          NOT NULL,
  seg            TEXT,
  escopo         TEXT[]        DEFAULT '{"ugc"}',
  status         TEXT          DEFAULT 'ativo',
  inicio         DATE,
  pacote         TEXT,
  valor_pacote   NUMERIC(12,2),
  link_contrato  TEXT,
  entregaveis    TEXT,
  contatos       JSONB         DEFAULT '[]',
  historico      JSONB         DEFAULT '[]',          -- log de renovações/notas
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   DEFAULT NOW()
);


-- ── 5. CALLS AGENDADAS ─────────────────────────────────────────────────────────
--  Agenda de ligações / reuniões da Isis.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls_agendadas (
  id         TEXT          PRIMARY KEY,
  lead_id    INTEGER       REFERENCES leads (id) ON DELETE SET NULL,
  nome       TEXT          NOT NULL,
  data       DATE          NOT NULL,
  hora       TEXT,
  canal      TEXT,
  intuito    TEXT,
  status     TEXT          DEFAULT 'agendado'
                           CHECK (status IN ('agendado','realizado','cancelado')),
  created_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_data ON calls_agendadas (data);


-- ── 6. ESTADO GLOBAL DO CRM ────────────────────────────────────────────────────
--  Tabela de linha única para o estado compartilhado (Pré-Lista, filtros, etc.)
--  A CONSTRAINT garante que sempre haverá exatamente UM registro (id = 1).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_global_state (
  id                  INTEGER     PRIMARY KEY DEFAULT 1,
  nicho_custom        JSONB       DEFAULT '{"ugc":[],"gestao":[]}',
  pl_checked          JSONB       DEFAULT '{}',   -- {leadId: 'aprovado'|'melhoria'}
  pl_lead_comments    JSONB       DEFAULT '{}',   -- {leadId: 'texto'}
  pl_global_cmd_text  TEXT        DEFAULT '',
  aprov_master_text   TEXT        DEFAULT '',
  aprov_etapa_cmd     JSONB       DEFAULT '{}',   -- {leadId: {stepId: 'instrução'}}
  aprov_reprocess     JSONB       DEFAULT '{}',
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Garante que o registro único existe
INSERT INTO crm_global_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ── TRIGGER: updated_at automático ────────────────────────────────────────────
--  Atualiza o campo updated_at sempre que uma linha for modificada.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','cadencia_etapas','clientes_ativos','crm_global_state']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_updated_at ON %I;
       CREATE TRIGGER trg_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t
    );
  END LOOP;
END;
$$;


-- ── ROW LEVEL SECURITY (opcional para Supabase) ───────────────────────────────
--  Descomente e adapte se for usar Supabase com auth de usuário.
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE leads            ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE cadencia_etapas  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE interacoes       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE clientes_ativos  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE calls_agendadas  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE crm_global_state ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "acesso_total" ON leads            FOR ALL USING (true);
-- CREATE POLICY "acesso_total" ON cadencia_etapas  FOR ALL USING (true);
-- CREATE POLICY "acesso_total" ON interacoes       FOR ALL USING (true);
-- CREATE POLICY "acesso_total" ON clientes_ativos  USING (true);
-- CREATE POLICY "acesso_total" ON calls_agendadas  USING (true);
-- CREATE POLICY "acesso_total" ON crm_global_state USING (true);
