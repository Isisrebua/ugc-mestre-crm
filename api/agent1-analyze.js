// api/agent1-analyze.js — Vercel Serverless Function
// ════════════════════════════════════════════════════════════════
// AGENTE 1 · PROTOCOLO DE ANÁLISE MINUCIOSA
//
// Chamado automaticamente pelo /api/apify-webhook após a inserção
// em lote. Recebe os leads brutos, roda o diagnóstico completo via
// Anthropic API e atualiza cada registro no PostgreSQL com os campos:
//   just, garg, insight, pot, tags
//
// Protocolo de análise (5 eixos):
//   1. Instagram   — seguidores, engajamento, qualidade do perfil
//   2. Meta Ads    — se a marca investe em tráfego pago
//   3. Site        — presença digital e profissionalismo
//   4. Gargalo     — principal dor/oportunidade de UGC
//   5. Critério Ouro — veredicto final: vale prospectar?
//
// Variáveis de ambiente necessárias (Vercel):
//   ANTHROPIC_API_KEY      — chave da API da Anthropic
//   DATABASE_URL_EXTERNAL  — PostgreSQL externo (Render)
//   HUNTER_SECRET          — protege este endpoint
//
// Contrato de entrada:
// POST /api/agent1-analyze
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Body:
// {
//   "leads": [{ id, nome, insta, seg, seguidores, engajamento, just, tags, rawData }]
// }
// ════════════════════════════════════════════════════════════════

import { Client } from 'pg';
import { esc, escArr, escJ } from './_lib.js';

export const config = { maxDuration: 60 };

// ── System prompt do protocolo de análise ────────────────────────────────────
const ANALYSIS_SYSTEM = `Você é o Analista de Qualificação UGC do CRM UGC Mestre da Ísis Rebua.

Seu trabalho: analisar leads de marcas brasileiras e diagnosticar o potencial UGC de cada uma com precisão cirúrgica.

## Protocolo de Análise Minuciosa (5 eixos)

**1. Instagram** — avalie pela bio, seguidores, engajamento e tipo de conteúdo:
- Perfil ativo com posts regulares? Marca real ou pessoal?
- Engajamento saudável (>1% = bom, >3% = ótimo)?
- Estética visual compatível com UGC profissional?

**2. Biblioteca de Anúncios (Meta Ads)** — deduza pela presença digital:
- Marcas com site profissional + loja online geralmente investem em tráfego pago
- Bio com link para loja/produto = maior probabilidade de rodar anúncios
- E-commerce nicho de beleza/moda/saúde = 80%+ investe em Meta Ads

**3. Site** — avalie o profissionalismo da marca:
- Tem site próprio (não só Instagram)?
- Aparenta ser e-commerce estabelecido ou microempreendedor iniciante?
- Presença em marketplaces (Shopee, Mercado Livre) = marca escalando

**4. Gargalo** — identifique a dor principal que UGC resolve:
- Baixo engajamento mas produto bom = precisa de conteúdo autêntico
- Alta venda mas conteúdo fraco = oportunidade imediata
- Marca nova sem provas sociais = UGC é o próximo passo natural

**5. Critério Ouro** — veredicto final (seja direto):
- Vale prospectar? Por quê?
- Qual pitch de abordagem funcionaria para essa marca?
- Qual tipo de UGC ela mais precisa? (review, unboxing, dia-a-dia, antes/depois...)

## Formato de resposta (JSON puro, sem markdown)

Para cada lead analisado:
{
  "id": <número do lead>,
  "pot": "alto" | "medio" | "baixo",
  "just": "Resumo executivo em 1-2 frases para a Ísis decidir rapidamente",
  "garg": "Gargalo principal identificado — a dor que UGC resolve",
  "insight": "Diagnóstico completo dos 5 eixos. Máx 400 chars.",
  "tags": ["tag1", "tag2"],
  "metaAds": true | false
}

Responda APENAS com um array JSON com todos os leads analisados. Sem texto antes ou depois.`;

// ── Chama Anthropic para analisar um lote ────────────────────────────────────
async function analyzeBatch(leads) {
  const userMsg = leads.map(l => {
    const raw = l.rawData || {};
    const lines = [
      `ID: ${l.id}`,
      `Nome: ${l.nome}`,
      `Segmento: ${l.seg || 'Não informado'}`,
      l.insta       ? `Instagram: ${l.insta}` : null,
      l.site        ? `Site: ${l.site}` : null,
      l.seguidores  ? `Seguidores: ${l.seguidores}` : null,
      l.engajamento ? `Engajamento: ${l.engajamento}` : null,
      l.just        ? `Bio/Descrição coletada: ${l.just.slice(0, 300)}` : null,
      raw.isBusinessAccount !== undefined ? `Conta Comercial: ${raw.isBusinessAccount ? 'Sim' : 'Não'}` : null,
      raw.isVerified        ? `Verificado: Sim` : null,
      raw.postsCount        ? `Posts publicados: ${raw.postsCount}` : null,
      raw.rating            ? `Nota Google: ${raw.rating} (${raw.reviewsCount || 0} avaliações)` : null,
      l.linkedin    ? `LinkedIn: ${l.linkedin}` : null,
      l.email       ? `E-mail encontrado: Sim` : null,
      (l.tags || []).length ? `Tags coletadas: ${l.tags.join(', ')}` : null,
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',  // Haiku: mais rápido e barato para análise em lote
      max_tokens: 2048,
      system:     ANALYSIS_SYSTEM,
      messages:   [{
        role:    'user',
        content: `Analise os seguintes ${leads.length} lead(s) e retorne o array JSON:\n\n${userMsg}`,
      }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const raw  = data.content?.[0]?.text || '[]';
  const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

// ── Atualiza lead no PostgreSQL ───────────────────────────────────────────────
async function updateLead(client, analysis) {
  const { id, pot, just, garg, insight, tags, metaAds } = analysis;

  const extraTag = metaAds ? ['meta ads'] : [];
  const allTags  = [...new Set([...(tags || []), ...extraTag])];

  const statusFlags = metaAds ? escArr(['meta_ads']) : `(SELECT status_flags FROM leads WHERE id = ${esc(id)})`;

  await client.query(`
    UPDATE leads SET
      pot          = ${esc(pot || 'medio')},
      just         = ${esc(just || null)},
      garg         = ${esc(garg || null)},
      insight      = ${esc(insight || null)},
      tags         = ${escArr(allTags)},
      status_flags = ${statusFlags},
      ag2_reasoning = ${escJ({ analisadoEm: new Date().toISOString(), protocolo: '5-eixos', metaAds: !!metaAds })}
    WHERE id = ${esc(id)}
  `);
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hunter-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.headers['x-hunter-secret'] || '';
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
  }

  const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const leads = Array.isArray(body.leads) ? body.leads : [];

  if (!leads.length) {
    return res.status(400).json({ error: 'Campo "leads" obrigatório e não pode ser vazio' });
  }

  // Analisa em lotes de 5 para não exceder o contexto do Haiku
  const BATCH = 5;
  const allAnalyses = [];
  const batchErrors = [];
  for (let i = 0; i < leads.length; i += BATCH) {
    const slice = leads.slice(i, i + BATCH);
    try {
      const analyses = await analyzeBatch(slice);
      allAnalyses.push(...analyses);
    } catch (err) {
      console.error(`[agent1-analyze] Erro no lote ${i}–${i + BATCH}:`, err.message);
      batchErrors.push(err.message);
    }
  }

  if (!allAnalyses.length) {
    return res.status(502).json({
      ok: false,
      error: 'Anthropic não retornou análises válidas',
      details: batchErrors,
    });
  }

  // Salva no banco
  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  let updated = 0;
  const errors = [];

  try {
    await client.connect();
    for (const analysis of allAnalyses) {
      try {
        await updateLead(client, analysis);
        updated++;
      } catch (err) {
        errors.push({ id: analysis.id, error: err.message });
      }
    }
  } finally {
    await client.end().catch(() => {});
  }

  return res.status(200).json({
    ok:        true,
    analyzed:  allAnalyses.length,
    updated,
    errors:    errors.length ? errors : undefined,
    ts:        new Date().toISOString(),
  });
}
