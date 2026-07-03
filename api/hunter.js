// api/hunter.js — Vercel Serverless Function
// Webhook do Agente 1 (Caçador): recebe leads brutos minerados de qualquer fonte
// (Google Maps, scraper de sites, LinkedIn, Meta Ads, planilhas, etc.)
// e os insere na tabela `leads` com stage='prelista', verificando duplicatas.
//
// Variável de ambiente necessária: DATABASE_URL (já configurada no projeto Vercel)
// Variável de ambiente opcional:   HUNTER_SECRET (token de autorização)
//
// Contrato de entrada (POST /api/hunter):
// {
//   "source": "google_maps" | "site_scraper" | "linkedin" | "meta_ads" | "manual",
//   "leads": [
//     {
//       "nome":        "Glow Beauty",          // obrigatório
//       "insta":       "@glowbeauty",          // opcional mas recomendado para dedup
//       "site":        "www.glowbeauty.com",   // opcional
//       "seg":         "Cosméticos Naturais",  // segmento/nicho
//       "email":       "contato@marca.com",    // opcional
//       "whatsapp":    "(11) 99999-9999",       // opcional
//       "telefone":    "(11) 3333-3333",        // opcional
//       "endereco":    "São Paulo, SP",         // opcional (vindo do Google Maps)
//       "seguidores":  "45k",                  // opcional
//       "engajamento": "3.2%",                 // opcional
//       "pot":         "alto" | "medio",       // potencial estimado (default: medio)
//       "capital":     "R$ 500k–2M/ano",       // faturamento estimado
//       "just":        "Justificativa...",     // análise do agente
//       "garg":        "Gargalo...",           // gargalo identificado
//       "insight":     "Insight UGC...",       // oportunidade de conexão
//       "tags":        ["pet", "premium"],     // tags livres
//       "metaAds":     true | false,           // tem anúncios na Meta?
//       "linkedin":    "linkedin.com/in/...",  // perfil LinkedIn
//       "rawData":     {}                      // qualquer dado extra do scraper
//     }
//   ]
// }
//
// Resposta:
// {
//   "ok": true,
//   "inserted": 3,   // leads novos inseridos
//   "skipped": 1,    // duplicatas bloqueadas
//   "details": [{ "nome": "...", "status": "inserted" | "duplicate", "reason": "..." }]
// }

import { Client } from 'pg';

export const config = { maxDuration: 30 };

// ── Helpers SQL ──────────────────────────────────────────────────────────────

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function escJ(v) {
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
}
function escArr(arr) {
  if (!arr || !arr.length) return "ARRAY[]::text[]";
  const inner = arr.map(s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
  return "'" + '{' + inner + "}'" + "::text[]";
}

// ── Normalização ─────────────────────────────────────────────────────────────

function normInsta(v) {
  return (v || '').toLowerCase().replace(/^@/, '').replace(/\s/g, '').trim();
}
function normNome(v) {
  return (v || '').toLowerCase().trim();
}

// Monta o objeto de contatos a partir dos campos brutos do lead minerado
function buildContatos(raw) {
  const contatos = [];
  if (raw.email)     contatos.push({ tipo: 'email',     tag: 'E-mail',    val: raw.email });
  if (raw.whatsapp)  contatos.push({ tipo: 'wpp',       tag: 'WhatsApp',  val: raw.whatsapp });
  if (raw.telefone)  contatos.push({ tipo: 'telefone',  tag: 'Telefone',  val: raw.telefone });
  if (raw.linkedin)  contatos.push({ tipo: 'linkedin',  tag: 'LinkedIn',  val: raw.linkedin });
  contatos.push({ tipo: 'agent', tag: 'Agente 1', val: raw.email || 'Pendente' });
  return contatos;
}

// Monta as tags automáticas com base nos dados minerados
function buildTags(raw, source) {
  const tags = [...(raw.tags || [])];
  if (raw.seg)       tags.push(raw.seg);
  if (source)        tags.push(source.replace(/_/g, ' '));
  if (raw.metaAds)   tags.push('meta ads');
  if (raw.pot === 'alto') tags.push('alto potencial');
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))];
}

// ── Verificação de duplicata via DB ─────────────────────────────────────────
// Mais confiável que checar só no localStorage do browser

async function findDuplicateInDB(client, nome, insta) {
  const nomeN  = normNome(nome);
  const instaN = normInsta(insta);

  // Busca por nome exato (case-insensitive) ou Instagram normalizado
  const params = [];
  const conditions = [];

  if (nomeN) {
    params.push(nomeN);
    conditions.push(`LOWER(TRIM(nome)) = $${params.length}`);
  }
  if (instaN) {
    params.push(instaN);
    // Remove @ do valor armazenado antes de comparar
    conditions.push(`LOWER(TRIM(REPLACE(insta, '@', ''))) = $${params.length}`);
  }

  if (!conditions.length) return null;

  const sql = `SELECT id, nome, insta, stage FROM leads WHERE ${conditions.join(' OR ')} LIMIT 1`;
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}

// ── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hunter-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Verificação de token (opcional mas recomendada)
  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.headers['x-hunter-secret'] || '';
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized — token inválido' });
    }
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const rawLeads = Array.isArray(body?.leads) ? body.leads : [];
  const source   = String(body?.source || 'manual').slice(0, 64);

  if (!rawLeads.length) {
    return res.status(400).json({ error: 'Nenhum lead enviado. Use { "leads": [...] }' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const details = [];
    let inserted = 0;
    let skipped  = 0;

    for (const raw of rawLeads) {
      // Validação mínima
      if (!raw.nome || !String(raw.nome).trim()) {
        details.push({ nome: '(sem nome)', status: 'skipped', reason: 'campo nome obrigatório ausente' });
        skipped++;
        continue;
      }

      const nome  = String(raw.nome).trim();
      const insta = raw.insta ? String(raw.insta).trim() : null;

      // Verificar duplicata no banco
      const dup = await findDuplicateInDB(client, nome, insta);
      if (dup) {
        details.push({
          nome,
          status: 'duplicate',
          reason: `já existe (id=${dup.id}, stage=${dup.stage})`,
          existingId: dup.id,
        });
        skipped++;
        continue;
      }

      // Gerar ID sequencial (máximo atual + 1)
      const { rows: idRows } = await client.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM leads');
      const newId = idRows[0].next_id;

      const contatos = buildContatos(raw);
      const tags     = buildTags(raw, source);

      // Inserir o lead na Pré-Lista
      await client.query(`
        INSERT INTO leads (
          id, nome, seg, insta, site, canal, pot, capital, valor, agent,
          tags, seguidores, engajamento, just, garg, insight, contatos,
          stage, tabs, escopo, status_flags, data_captacao, proxima_acao,
          retomar_contato, cadencia_pausada, agent_note, sazonal_note,
          inicio_cadencia, ag2_status, ag2_reasoning, order_history
        ) VALUES (
          ${esc(newId)}, ${esc(nome)}, ${esc(raw.seg || 'Sem segmento')},
          ${esc(insta)}, ${esc(raw.site || null)},
          ${esc(raw.canal || 'instagram')},
          ${esc(raw.pot || 'medio')},
          ${esc(raw.capital || null)},
          ${esc(raw.valor || null)},
          'a1',
          ${escArr(tags)},
          ${esc(raw.seguidores || null)},
          ${esc(raw.engajamento || null)},
          ${esc(raw.just || `Lead minerado via ${source}`)},
          ${esc(raw.garg || null)},
          ${esc(raw.insight || null)},
          ${escJ(contatos)},
          'prelista',
          ${escArr(['prelista'])},
          ${escArr(['ugc'])},
          ${escArr(raw.metaAds ? ['meta_ads'] : [])},
          ${esc(new Date().toISOString().slice(0, 10))},
          NULL, NULL, FALSE,
          ${esc(`Minerado pelo Agente 1 via ${source}${raw.endereco ? ' · ' + raw.endereco : ''}`)},
          NULL, NULL, 'pendente',
          ${escJ({ source, rawData: raw.rawData || {}, metaAds: !!raw.metaAds, linkedin: raw.linkedin || null })},
          ${escJ([])}
        )
        ON CONFLICT (id) DO NOTHING
      `);

      details.push({ nome, status: 'inserted', id: newId });
      inserted++;
    }

    return res.status(200).json({
      ok: true,
      source,
      inserted,
      skipped,
      total: rawLeads.length,
      details,
      ts: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[hunter]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
