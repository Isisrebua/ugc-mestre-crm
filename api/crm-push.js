// api/crm-push.js — Vercel Serverless Function
// Recebe o estado completo do CRM e faz upsert no PostgreSQL.
// Variável de ambiente necessária no painel Vercel: DATABASE_URL

import { Client } from 'pg';

export const config = { maxDuration: 30 };

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function escJ(v) {
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
}
function escArr(arr) {
  if (!arr || !arr.length) return "ARRAY[]::text[]";
  const inner = arr.map(s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
  return "'" + '{' + inner + "}'" + "::text[]";
}

function buildSQL(body) {
  const parts = [];

  // ── leads ──────────────────────────────────────────────────
  const leads = body.leads || [];
  if (leads.length) {
    const vals = leads.map(l => `(
      ${esc(l.id)},${esc(l.nome)},${esc(l.seg)},${esc(l.insta)},${esc(l.site)},
      ${esc(l.canal)},${esc(l.pot)},${esc(l.capital)},${esc(l.valor)},${esc(l.agent)},
      ${escArr(l.tags)},${esc(l.seguidores)},${esc(l.engajamento)},
      ${esc(l.just)},${esc(l.garg)},${esc(l.insight)},${escJ(l.contatos||[])},
      ${esc(l.stage||'prelista')},${escArr(l.tabs||[l.stage])},${escArr(l.escopo||['ugc'])},
      ${escArr(l.statusFlags||[])},${esc(l.dataCaptacao)},${esc(l.proximaAcao)},
      ${esc(l.retomarContato)},${l.cadenciaPausada?'TRUE':'FALSE'},
      ${esc(l.agentNote)},${esc(l.sazonalNote)},${esc(l.inicioCadencia)},
      ${esc(l.ag2Status)},${escJ(l.ag2Reasoning||{})},${escJ(l.orderHistory||[])}
    )`).join(',\n');
    parts.push(`INSERT INTO leads (
      id,nome,seg,insta,site,canal,pot,capital,valor,agent,
      tags,seguidores,engajamento,just,garg,insight,contatos,
      stage,tabs,escopo,status_flags,data_captacao,proxima_acao,
      retomar_contato,cadencia_pausada,agent_note,sazonal_note,
      inicio_cadencia,ag2_status,ag2_reasoning,order_history
    ) VALUES ${vals}
    ON CONFLICT (id) DO UPDATE SET
      nome=EXCLUDED.nome,seg=EXCLUDED.seg,insta=EXCLUDED.insta,site=EXCLUDED.site,
      canal=EXCLUDED.canal,pot=EXCLUDED.pot,capital=EXCLUDED.capital,valor=EXCLUDED.valor,
      agent=EXCLUDED.agent,tags=EXCLUDED.tags,seguidores=EXCLUDED.seguidores,
      engajamento=EXCLUDED.engajamento,just=EXCLUDED.just,garg=EXCLUDED.garg,
      insight=EXCLUDED.insight,contatos=EXCLUDED.contatos,stage=EXCLUDED.stage,
      tabs=EXCLUDED.tabs,escopo=EXCLUDED.escopo,status_flags=EXCLUDED.status_flags,
      data_captacao=EXCLUDED.data_captacao,proxima_acao=EXCLUDED.proxima_acao,
      retomar_contato=EXCLUDED.retomar_contato,cadencia_pausada=EXCLUDED.cadencia_pausada,
      agent_note=EXCLUDED.agent_note,sazonal_note=EXCLUDED.sazonal_note,
      inicio_cadencia=EXCLUDED.inicio_cadencia,ag2_status=EXCLUDED.ag2_status,
      ag2_reasoning=EXCLUDED.ag2_reasoning,order_history=EXCLUDED.order_history,
      updated_at=NOW();`);
  }

  // ── cadencia_etapas ────────────────────────────────────────
  const etapas = [];
  Object.entries(body.cadencia || {}).forEach(([lid, list]) => {
    (list || []).forEach(e => etapas.push({ ...e, lead_id: Number(lid) }));
  });
  if (etapas.length) {
    const vals = etapas.map(e => `(
      ${esc(e.id)},${esc(e.lead_id)},${esc(e.et)},
      ${esc(e.titulo||'')},${esc(e.canal||'instagram')},
      ${esc(e.data)},${esc(e.status||'pendente')},
      ${esc(e.roteiro)},${esc(e.motivo)},${esc(e.occ)},${e.locked?'TRUE':'FALSE'}
    )`).join(',\n');
    parts.push(`INSERT INTO cadencia_etapas (id,lead_id,et,titulo,canal,data,status,roteiro,motivo,occ,locked)
    VALUES ${vals}
    ON CONFLICT (id) DO UPDATE SET
      lead_id=EXCLUDED.lead_id,et=EXCLUDED.et,titulo=EXCLUDED.titulo,
      canal=EXCLUDED.canal,data=EXCLUDED.data,status=EXCLUDED.status,
      roteiro=EXCLUDED.roteiro,motivo=EXCLUDED.motivo,occ=EXCLUDED.occ,
      locked=EXCLUDED.locked,updated_at=NOW();`);
  }

  // ── interacoes ─────────────────────────────────────────────
  const intera = [];
  Object.entries(body.interacoes || {}).forEach(([lid, list]) => {
    (list || []).forEach(i => intera.push({ ...i, lead_id: Number(lid) }));
  });
  if (intera.length) {
    const vals = intera.map(i => `(
      ${esc(i.id)},${esc(i.lead_id)},${esc(i.tipo)},
      ${esc(i.canal)},${esc(i.data)},${esc(i.texto||'')},${i.aprovado?'TRUE':'FALSE'}
    )`).join(',\n');
    parts.push(`INSERT INTO interacoes (id,lead_id,tipo,canal,data,texto,aprovado)
    VALUES ${vals}
    ON CONFLICT (id) DO UPDATE SET
      lead_id=EXCLUDED.lead_id,tipo=EXCLUDED.tipo,canal=EXCLUDED.canal,
      data=EXCLUDED.data,texto=EXCLUDED.texto,aprovado=EXCLUDED.aprovado;`);
  }

  // ── clientes_ativos ────────────────────────────────────────
  const clientes = body.clientes || [];
  if (clientes.length) {
    const vals = clientes.map(c => `(
      ${esc(c.id)},${esc(c.nome)},${esc(c.seg)},${escArr(c.escopo||['ugc'])},
      ${esc(c.status||'ativo')},${esc(c.inicio)},${esc(c.pacote)},
      ${esc(c.valorPacote)},${esc(c.linkContrato)},${esc(c.entregaveis)},
      ${escJ(c.contatos||[])},${escJ(c.historico||[])}
    )`).join(',\n');
    parts.push(`INSERT INTO clientes_ativos (id,nome,seg,escopo,status,inicio,pacote,valor_pacote,link_contrato,entregaveis,contatos,historico)
    VALUES ${vals}
    ON CONFLICT (id) DO UPDATE SET
      nome=EXCLUDED.nome,seg=EXCLUDED.seg,escopo=EXCLUDED.escopo,status=EXCLUDED.status,
      inicio=EXCLUDED.inicio,pacote=EXCLUDED.pacote,valor_pacote=EXCLUDED.valor_pacote,
      link_contrato=EXCLUDED.link_contrato,entregaveis=EXCLUDED.entregaveis,
      contatos=EXCLUDED.contatos,historico=EXCLUDED.historico,updated_at=NOW();`);
  }

  // ── calls_agendadas ────────────────────────────────────────
  const calls = body.calls || [];
  if (calls.length) {
    const vals = calls.map(c => `(
      ${esc(c.id)},${esc(c.leadId)},${esc(c.nome)},${esc(c.data)},
      ${esc(c.hora)},${esc(c.canal)},${esc(c.intuito)},${esc(c.status||'agendado')}
    )`).join(',\n');
    parts.push(`INSERT INTO calls_agendadas (id,lead_id,nome,data,hora,canal,intuito,status)
    VALUES ${vals}
    ON CONFLICT (id) DO UPDATE SET
      lead_id=EXCLUDED.lead_id,nome=EXCLUDED.nome,data=EXCLUDED.data,
      hora=EXCLUDED.hora,canal=EXCLUDED.canal,intuito=EXCLUDED.intuito,status=EXCLUDED.status;`);
  }

  // ── crm_global_state ───────────────────────────────────────
  const gs = body.globalState || {};
  parts.push(`INSERT INTO crm_global_state (
    id,nicho_custom,pl_checked,pl_lead_comments,
    pl_global_cmd_text,aprov_master_text,aprov_etapa_cmd,aprov_reprocess
  ) VALUES (
    1,
    ${escJ(gs.nichoCustom||{})},
    ${escJ(gs.plChecked||{})},
    ${escJ(gs.plLeadComments||{})},
    ${esc(gs.plGlobalCmdText||'')},
    ${esc(gs.aprovMasterText||'')},
    ${escJ(gs.aprovEtapaCmd||{})},
    ${escJ(gs.aprovReprocess||{})}
  )
  ON CONFLICT (id) DO UPDATE SET
    nicho_custom=EXCLUDED.nicho_custom,pl_checked=EXCLUDED.pl_checked,
    pl_lead_comments=EXCLUDED.pl_lead_comments,pl_global_cmd_text=EXCLUDED.pl_global_cmd_text,
    aprov_master_text=EXCLUDED.aprov_master_text,aprov_etapa_cmd=EXCLUDED.aprov_etapa_cmd,
    aprov_reprocess=EXCLUDED.aprov_reprocess,updated_at=NOW();`);

  return parts.join('\n\n');
}

export default async function handler(req, res) {
  // CORS — permite chamadas do CRM em qualquer domínio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const sql = buildSQL(body);

    await client.connect();
    await client.query(sql);

    res.status(200).json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    console.error('[crm-push]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
