// api/apify-webhook.js — Vercel Serverless Function
// ════════════════════════════════════════════════════════════════════════════
// Recebe o callback do Apify, analisa cada lead com Gemini (síncrono, inline)
// e salva o lead JÁ ANALISADO na Pré-Lista.
//
// Limite de segurança: processa até MAX_INLINE leads com Gemini dentro do
// maxDuration de 60s. Leads excedentes entram com flag "pendente_analise"
// e o CRM os analisa ao sincronizar via /api/agent1-analyze.
//
// Variáveis de ambiente necessárias:
//   DATABASE_URL_EXTERNAL  — PostgreSQL externo (Render)
//   APIFY_TOKEN            — token da conta Apify
//   GOOGLE_API_KEY         — chave Google AI Studio (gratuita)
//   HUNTER_SECRET          — autenticação
// ════════════════════════════════════════════════════════════════════════════

import { Client } from 'pg';
import { insertLead, esc, escArr, escJ } from './_lib.js';

export const config = { maxDuration: 60 };

// Máximo de leads analisados inline nesta chamada (cada Gemini leva ~4s)
const MAX_INLINE = 8;

// ── IDs dos Atores Apify ─────────────────────────────────────────────────────
const ACTOR_NORMALIZERS = {
  'dSCLg0C3YEZ83HzYX': normalizeInstagram,
  '3fgjV51WijDcQxpIK': normalizeInstagramEmailScraper,
  'nwua9Gu5YrADL7ZDj': normalizeGoogleMaps,
  'WnMxbsRLNbPeYL6ge': normalizeGoogleMaps,
  'UwSdACBp7ymaGUJjS': normalizeLinkedIn,
};

const SOURCE_LABELS = {
  'dSCLg0C3YEZ83HzYX': 'instagram',
  '3fgjV51WijDcQxpIK': 'instagram',
  'reGe1ST3OBgYZSsZJ': 'instagram_hashtag',
  'nwua9Gu5YrADL7ZDj': 'google_maps',
  'WnMxbsRLNbPeYL6ge': 'google_maps',
  'UwSdACBp7ymaGUJjS': 'linkedin',
};

// ── Normalizadores por Ator ──────────────────────────────────────────────────

function normalizeInstagram(item) {
  if (!item.username && !item.fullName) return null;
  const nome      = item.fullName || item.username;
  const insta     = item.username ? `@${item.username}` : null;
  const seg       = item.businessCategoryName || 'Instagram';
  const followers = item.followersCount || 0;
  const pot       = followers >= 100000 ? 'alto' : 'medio';
  const seguidores = followers ? (followers >= 1000 ? `${Math.round(followers/1000)}k` : String(followers)) : null;
  let engajamento = null;
  if (item.latestPosts?.length && followers > 0) {
    const totalEng = item.latestPosts.slice(0,6).reduce((s,p)=>s+(p.likesCount||0)+(p.commentsCount||0),0);
    const rate = (totalEng / item.latestPosts.slice(0,6).length / followers) * 100;
    engajamento = `${rate.toFixed(1)}%`;
  }
  return {
    nome, insta, site: item.externalUrl||null, seg, pot, seguidores, engajamento,
    just: item.biography ? `Bio: ${item.biography.slice(0,200)}` : null,
    tags: ['instagram', ...(item.isVerified ? ['verificado'] : [])],
    rawData: { instagramUrl:item.url, isBusinessAccount:item.isBusinessAccount, isVerified:item.isVerified, postsCount:item.postsCount, followingCount:item.followingCount },
  };
}

function normalizeInstagramEmailScraper(item) {
  if (!item.username && !item.fullName) return null;
  const nome      = item.fullName || item.username;
  const insta     = item.username ? `@${item.username}` : null;
  const seg       = item.accountCategory || item.businessCategoryName || 'Instagram';
  const followers = item.followersCount || 0;
  const pot       = followers >= 50000 ? 'alto' : followers >= 5000 ? 'medio' : 'baixo';
  const seguidores = followers ? (followers >= 1000 ? `${Math.round(followers/1000)}k` : String(followers)) : null;
  const email     = item.email || item.emails?.[0] || null;
  const linkedin  = item.socials?.linkedin || null;
  const tags      = ['instagram', ...(item.isVerified?['verificado']:[]), ...(item.isBusinessAccount?['conta comercial']:[])];
  return {
    nome, insta, site: item.website||null, seg, email, telefone: item.phone||null, linkedin, pot, seguidores,
    just: item.bio ? `Bio: ${item.bio.slice(0,200)}` : `Perfil encontrado via busca por nicho`,
    tags,
    rawData: {
      instagramUrl: `https://instagram.com/${item.username}`,
      isBusinessAccount: item.isBusinessAccount, isVerified: item.isVerified,
      postsCount: item.postsCount, followersCount: followers, socials: item.socials,
    },
  };
}

function normalizeGoogleMaps(item) {
  if (!item.title || item.permanentlyClosed) return null;
  const insta = item.socialMedia?.instagram
    ? '@' + item.socialMedia.instagram.replace(/.*instagram\.com\/([^/?#]+).*/i, '$1') : null;
  const pot = (item.totalScore||0) >= 4 && (item.reviewsCount||0) >= 50 ? 'alto' : 'medio';
  const endereco = [item.city, item.state, item.countryCode].filter(Boolean).join(', ') || item.address || null;
  return {
    nome: item.title, insta, site: item.website||null, seg: item.categoryName||'Negócio Local',
    email: item.email||item.emails?.[0]||null, telefone: item.phone||null,
    linkedin: item.socialMedia?.linkedin||null, pot,
    just: `Google Maps · ${item.categoryName||'—'} · ⭐ ${item.totalScore||'—'} (${item.reviewsCount||0} avaliações)${endereco?' · '+endereco:''}`,
    tags: ['google maps', item.categoryName].filter(Boolean),
    rawData: { googleMapsUrl:item.url, rating:item.totalScore, reviewsCount:item.reviewsCount, address:item.address, location:item.location, socialMedia:item.socialMedia },
  };
}

function normalizeLinkedIn(item) {
  if (!item.name) return null;
  const hq = item.headquarters ? [item.headquarters.city, item.headquarters.state, item.headquarters.country].filter(Boolean).join(', ') : null;
  const employees = item.employeeCount || 0;
  return {
    nome: item.name, site: item.website||null, seg: item.industry||'LinkedIn',
    telefone: item.phone||null, linkedin: item.linkedinUrl||null, pot: employees >= 50 ? 'alto' : 'medio',
    capital: employees ? `${employees} funcionários` : null,
    just: item.description ? item.description.slice(0,300) : null,
    tags: ['linkedin', item.industry].filter(Boolean),
    rawData: { linkedinUrl:item.linkedinUrl, employeeCount:item.employeeCount, followerCount:item.followerCount, foundedYear:item.foundedYear, headquarters:hq, specialties:item.specialties },
  };
}

function normalizeGeneric(item) {
  const nome = item.name||item.title||item.fullName||item.companyName||null;
  if (!nome) return null;
  return {
    nome, insta: item.instagram||item.instagramUrl||null, site: item.website||item.url||null,
    seg: item.category||item.industry||item.seg||'Sem segmento',
    email: item.email||null, telefone: item.phone||item.telefone||null,
    linkedin: item.linkedin||item.linkedinUrl||null, pot: item.pot||'medio',
    just: item.description||item.biography||item.just||null, tags: [], rawData: item,
  };
}

// ── Fetch dataset do Apify ────────────────────────────────────────────────────
async function fetchDataset(datasetId, token) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items`
    + `?token=${encodeURIComponent(token)}&format=json&limit=500&clean=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Apify dataset fetch falhou: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── Análise Gemini — protocolo de 5 eixos ────────────────────────────────────
const ANALYSIS_PROMPT = `Você é o Analista UGC do CRM da Ísis Rebua. Analise este lead com o protocolo de 5 eixos:

1. Instagram — perfil ativo, seguidores, engajamento, tipo de conteúdo
2. Meta Ads — deduza pela presença digital: site + loja + nicho = investe em tráfego pago?
3. Site — e-commerce estabelecido ou microempreendedor? Marketplace?
4. Gargalo — dor principal que UGC resolve para essa marca especificamente
5. Critério Ouro — vale prospectar? Qual pitch? Qual tipo de UGC? (review, unboxing, dia-a-dia, antes/depois)

Retorne APENAS um array JSON com 1 objeto. Todos os valores string em uma única linha, sem quebras de linha:
[{"pot":"alto"|"medio"|"baixo","just":"resumo 1-2 frases","garg":"gargalo principal","insight":"diagnóstico 5 eixos máx 400 chars","tags":["tag1"],"metaAds":true|false}]`;

async function analyzeWithGemini(lead) {
  const raw = lead.rawData || {};
  const ctx = [
    `Nome: ${lead.nome}`,
    `Segmento: ${lead.seg || 'Não informado'}`,
    lead.insta       ? `Instagram: ${lead.insta}` : null,
    lead.site        ? `Site: ${lead.site}` : null,
    lead.seguidores  ? `Seguidores: ${lead.seguidores}` : null,
    lead.engajamento ? `Engajamento: ${lead.engajamento}` : null,
    lead.just        ? `Bio: ${lead.just.slice(0,300)}` : null,
    raw.isBusinessAccount !== undefined ? `Conta Comercial: ${raw.isBusinessAccount ? 'Sim' : 'Não'}` : null,
    raw.isVerified   ? `Verificado: Sim` : null,
    raw.postsCount   ? `Posts: ${raw.postsCount}` : null,
    raw.followersCount ? `Seguidores (raw): ${raw.followersCount}` : null,
    lead.email       ? `Email encontrado: Sim` : null,
    (lead.tags||[]).length ? `Tags: ${lead.tags.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${ANALYSIS_PROMPT}\n\n---\n${ctx}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800, responseMimeType: 'application/json' },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${txt.slice(0,200)}`);
  }

  const data = await resp.json();
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

  // Limpa markdown e extrai array
  text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s !== -1 && e !== -1) text = text.slice(s, e + 1);

  // Sanitiza newlines dentro de strings
  text = text.replace(/("(?:[^"\\]|\\.)*")/g, m =>
    m.replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ')
  );

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

// ── Mescla análise do Gemini no lead normalizado ─────────────────────────────
function mergeAnalysis(normalized, ai) {
  if (!ai) return { ...normalized, status_flags: ['pendente_analise'] };

  const extraTags = ai.metaAds ? ['meta ads'] : [];
  const allTags   = [...new Set([...(normalized.tags||[]), ...(ai.tags||[]), ...extraTags])];

  return {
    ...normalized,
    pot:     ai.pot     || normalized.pot,
    just:    ai.just    || normalized.just,
    garg:    ai.garg    || null,
    insight: ai.insight || null,
    tags:    allTags,
    status_flags:  ai.metaAds ? ['meta_ads'] : [],
    ag2_reasoning: { analisadoEm: new Date().toISOString(), protocolo: '5-eixos', metaAds: !!ai.metaAds },
  };
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação via query string (webhook do Apify) ou header (testes)
  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.query?.secret || req.headers['x-hunter-secret'] || '';
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const body      = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const datasetId = body.resource?.defaultDatasetId || body.datasetId || null;
  const actId     = body.resource?.actId            || body.actorId   || null;

  if (!datasetId) {
    return res.status(400).json({ error: 'defaultDatasetId ausente no payload do Apify' });
  }

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) return res.status(500).json({ error: 'APIFY_TOKEN não configurado' });

  if (!process.env.GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY não configurada' });

  // Busca itens do dataset
  let items;
  try {
    items = await fetchDataset(datasetId, apifyToken);
  } catch (err) {
    return res.status(502).json({ error: `Erro ao buscar dataset Apify: ${err.message}` });
  }

  if (!Array.isArray(items) || !items.length) {
    return res.status(200).json({ ok: true, message: 'Dataset vazio', inserted: 0, skipped: 0 });
  }

  const normalize = (actId && ACTOR_NORMALIZERS[actId]) || normalizeGeneric;
  const source    = (actId && SOURCE_LABELS[actId]) || 'apify';

  // Normaliza todos os itens primeiro
  const normalized = items.map(item => normalize(item)).filter(Boolean);

  // Divide: primeiros MAX_INLINE analisados agora, restantes como pendentes
  const toAnalyze = normalized.slice(0, MAX_INLINE);
  const toDefer   = normalized.slice(MAX_INLINE);

  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const details   = [];
    let inserted    = 0;
    let skipped     = 0;
    let analyzed    = 0;
    let deferred    = 0;

    // ── Lote inline: normaliza + Gemini + salva (até MAX_INLINE leads) ─────────
    for (const lead of toAnalyze) {
      let enriched;
      try {
        const ai = await analyzeWithGemini(lead);
        enriched  = mergeAnalysis(lead, ai);
        analyzed++;
      } catch (err) {
        console.error(`[apify-webhook] Gemini falhou para "${lead.nome}":`, err.message);
        enriched = { ...lead, status_flags: ['pendente_analise'] };
      }

      const result = await insertLead(client, { ...enriched, source });
      if (result.inserted) {
        details.push({ nome: result.nome, id: result.id, status: 'inserted', analyzed: !enriched.status_flags?.includes('pendente_analise') });
        inserted++;
      } else {
        details.push({ nome: lead.nome, status: 'duplicate', reason: result.reason });
        skipped++;
      }
    }

    // ── Lote diferido: salva como pendente_analise para o CRM processar ────────
    for (const lead of toDefer) {
      const result = await insertLead(client, { ...lead, source, status_flags: ['pendente_analise'] });
      if (result.inserted) {
        details.push({ nome: result.nome, id: result.id, status: 'inserted', analyzed: false, deferred: true });
        inserted++;
        deferred++;
      } else {
        details.push({ nome: lead.nome, status: 'duplicate', reason: result.reason });
        skipped++;
      }
    }

    return res.status(200).json({
      ok: true, source, actorId: actId, datasetId,
      total: items.length, inserted, skipped, analyzed, deferred,
      message: deferred > 0
        ? `${analyzed} lead(s) analisados inline. ${deferred} pendentes — serão analisados ao sincronizar o CRM.`
        : `${analyzed} lead(s) inseridos e analisados com sucesso.`,
      details,
      ts: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[apify-webhook]', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  } finally {
    await client.end().catch(() => {});
  }
}
