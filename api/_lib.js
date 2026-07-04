// api/_lib.js — Módulo compartilhado (não exposto como endpoint pelo Vercel)
// Contém: helpers SQL, normalização, dedup e insert no PostgreSQL.

// ── Helpers SQL ──────────────────────────────────────────────────────────────

export function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function escJ(v) {
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
}

export function escArr(arr) {
  if (!arr || !arr.length) return "ARRAY[]::text[]";
  const inner = arr.map(s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
  return "'" + '{' + inner + "}'" + "::text[]";
}

// ── Normalização ─────────────────────────────────────────────────────────────

export function normInsta(v) {
  return (v || '').toLowerCase().replace(/^@/, '').replace(/\s/g, '').trim();
}

export function normNome(v) {
  return (v || '').toLowerCase().trim();
}

// ── Builders ─────────────────────────────────────────────────────────────────

export function buildContatos({ email, whatsapp, telefone, linkedin } = {}) {
  const c = [];
  if (email)     c.push({ tipo: 'email',    tag: 'E-mail',   val: email });
  if (whatsapp)  c.push({ tipo: 'wpp',      tag: 'WhatsApp', val: whatsapp });
  if (telefone)  c.push({ tipo: 'telefone', tag: 'Telefone', val: telefone });
  if (linkedin)  c.push({ tipo: 'linkedin', tag: 'LinkedIn', val: linkedin });
  c.push({ tipo: 'agent', tag: 'Agente 1', val: email || 'Pendente' });
  return c;
}

export function buildTags({ seg, source, metaAds, tags } = {}) {
  const t = [...(Array.isArray(tags) ? tags : [])];
  if (seg)      t.push(seg);
  if (source)   t.push(source.replace(/_/g, ' '));
  if (metaAds)  t.push('meta ads');
  return [...new Set(t.map(x => String(x).trim()).filter(Boolean))];
}

// ── Dedup via DB ─────────────────────────────────────────────────────────────

export async function findDuplicateInDB(client, nome, insta) {
  const nomeN  = normNome(nome);
  const instaN = normInsta(insta);

  const conditions = [];
  const params = [];

  if (nomeN) {
    params.push(nomeN);
    conditions.push(`LOWER(TRIM(nome)) = $${params.length}`);
  }
  if (instaN) {
    params.push(instaN);
    conditions.push(`LOWER(TRIM(REPLACE(insta, '@', ''))) = $${params.length}`);
  }

  if (!conditions.length) return null;

  const { rows } = await client.query(
    `SELECT id, nome, insta, stage FROM leads WHERE ${conditions.join(' OR ')} LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// ── Insert único ─────────────────────────────────────────────────────────────
// Retorna { inserted: true, id } ou { inserted: false, reason, existing }

export async function insertLead(client, lead) {
  const {
    nome, insta, seg, site, email, whatsapp, telefone, linkedin,
    pot, capital, valor, just, garg, insight,
    tags, seguidores, engajamento, metaAds, rawData, source,
    canal = 'instagram',
  } = lead;

  if (!nome || !String(nome).trim()) {
    return { inserted: false, reason: 'nome ausente' };
  }

  const dup = await findDuplicateInDB(client, nome, insta);
  if (dup) {
    return { inserted: false, reason: `duplicata (id=${dup.id}, stage=${dup.stage})`, existing: dup };
  }

  const { rows: idRows } = await client.query(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM leads'
  );
  const newId = idRows[0].next_id;

  const contatos  = buildContatos({ email, whatsapp, telefone, linkedin });
  const tagsBuilt = buildTags({ seg, source, metaAds, tags });
  const today     = new Date().toISOString().slice(0, 10);

  await client.query(`
    INSERT INTO leads (
      id, nome, seg, insta, site, canal, pot, capital, valor, agent,
      tags, seguidores, engajamento, just, garg, insight, contatos,
      stage, tabs, escopo, status_flags, data_captacao, proxima_acao,
      retomar_contato, cadencia_pausada, agent_note, sazonal_note,
      inicio_cadencia, ag2_status, ag2_reasoning, order_history
    ) VALUES (
      ${esc(newId)}, ${esc(String(nome).trim())}, ${esc(seg || 'Sem segmento')},
      ${esc(insta || null)}, ${esc(site || null)},
      ${esc(canal)}, ${esc(pot || 'medio')},
      ${esc(capital || null)}, ${esc(valor || null)},
      'a1',
      ${escArr(tagsBuilt)},
      ${esc(seguidores || null)}, ${esc(engajamento || null)},
      ${esc(just || `Lead minerado via ${source || 'agente'}`)},
      ${esc(garg || null)}, ${esc(insight || null)},
      ${escJ(contatos)},
      'prelista',
      ${escArr(['prelista'])},
      ${escArr(['ugc'])},
      ${escArr(metaAds ? ['meta_ads'] : [])},
      ${esc(today)},
      NULL, NULL, FALSE,
      ${esc(`Minerado pelo Agente 1 via ${source || 'agente'}`)},
      NULL, NULL, NULL,
      ${escJ({ source: source || null, metaAds: !!metaAds, linkedin: linkedin || null, rawData: rawData || {} })},
      ${escJ([])}
    )
    ON CONFLICT (id) DO NOTHING
  `);

  return { inserted: true, id: newId, nome: String(nome).trim() };
}
