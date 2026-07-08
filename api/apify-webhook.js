// api/apify-webhook.js — Vercel Serverless Function
// Recebe o webhook do Apify, insere leads IMEDIATAMENTE com flag
// "pendente_analise" e responde 200 OK em < 1s para evitar timeout.
// O Gemini analisa os leads separadamente via /api/agent1-analyze.
//
// Variáveis de ambiente necessárias no painel Vercel:
//   DATABASE_URL_EXTERNAL  — PostgreSQL externo (Render)
//   APIFY_TOKEN            — token da conta Apify
//   HUNTER_SECRET          — autenticação do webhook

import { Client } from 'pg';
import { insertLead } from './_lib.js';

export const config = { maxDuration: 30 };

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

// ── Normalizadores ────────────────────────────────────────────────────────────

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
    const rate = (totalEng/item.latestPosts.slice(0,6).length/followers)*100;
    engajamento = `${rate.toFixed(1)}%`;
  }
  return {
    nome, insta, site: item.externalUrl||null, seg, pot, seguidores, engajamento,
    just: item.biography ? `Bio: ${item.biography.slice(0,200)}` : null,
    tags: ['instagram',...(item.isVerified?['verificado']:[])],
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
  const tags      = ['instagram',...(item.isVerified?['verificado']:[]),...(item.isBusinessAccount?['conta comercial']:[])];
  return {
    nome, insta, site: item.website||null, seg, email, telefone: item.phone||null, linkedin, pot, seguidores,
    just: item.bio ? `Bio: ${item.bio.slice(0,200)}` : `Perfil encontrado via busca por nicho`,
    tags,
    rawData: { instagramUrl:`https://instagram.com/${item.username}`, isBusinessAccount:item.isBusinessAccount, isVerified:item.isVerified, postsCount:item.postsCount, followersCount:followers, socials:item.socials },
  };
}

function normalizeGoogleMaps(item) {
  if (!item.title || item.permanentlyClosed) return null;
  const insta = item.socialMedia?.instagram ? '@'+item.socialMedia.instagram.replace(/.*instagram\.com\/([^/?#]+).*/i,'$1') : null;
  const pot = (item.totalScore||0)>=4 && (item.reviewsCount||0)>=50 ? 'alto' : 'medio';
  const endereco = [item.city,item.state,item.countryCode].filter(Boolean).join(', ')||item.address||null;
  return {
    nome: item.title, insta, site: item.website||null, seg: item.categoryName||'Negócio Local',
    email: item.email||item.emails?.[0]||null, telefone: item.phone||null, linkedin: item.socialMedia?.linkedin||null, pot,
    just: `Google Maps · ${item.categoryName||'—'} · ⭐ ${item.totalScore||'—'} (${item.reviewsCount||0} avaliações)${endereco?' · '+endereco:''}`,
    tags: ['google maps',item.categoryName].filter(Boolean),
    rawData: { googleMapsUrl:item.url, rating:item.totalScore, reviewsCount:item.reviewsCount, address:item.address, location:item.location, socialMedia:item.socialMedia },
  };
}

function normalizeLinkedIn(item) {
  if (!item.name) return null;
  const hq = item.headquarters ? [item.headquarters.city,item.headquarters.state,item.headquarters.country].filter(Boolean).join(', ') : null;
  const employees = item.employeeCount || 0;
  return {
    nome: item.name, site: item.website||null, seg: item.industry||'LinkedIn',
    telefone: item.phone||null, linkedin: item.linkedinUrl||null, pot: employees>=50?'alto':'medio',
    capital: employees?`${employees} funcionários`:null,
    just: item.description?item.description.slice(0,300):null,
    tags: ['linkedin',item.industry].filter(Boolean),
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
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json&limit=500&clean=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Apify dataset fetch falhou: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação
  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.query?.secret || req.headers['x-hunter-secret'] || '';
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const body      = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const datasetId = body.resource?.defaultDatasetId || body.datasetId || null;
  const actId     = body.resource?.actId            || body.actorId   || null;

  if (!datasetId) return res.status(400).json({ error: 'defaultDatasetId ausente no payload do Apify' });

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) return res.status(500).json({ error: 'APIFY_TOKEN não configurado' });

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

  const client = new Client({ connectionString: process.env.DATABASE_URL_EXTERNAL, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();

    const details      = [];
    const insertedIds  = [];
    let inserted       = 0;
    let skipped        = 0;

    for (const item of items) {
      const normalized = normalize(item);
      if (!normalized) { skipped++; details.push({ status:'skipped', reason:'sem campos mínimos' }); continue; }

      // Insere imediatamente com flag pendente_analise — sem chamar Gemini aqui
      const leadData = {
        ...normalized,
        source,
        status_flags: ['pendente_analise'],
      };

      const result = await insertLead(client, leadData);
      if (result.inserted) {
        insertedIds.push(result.id);
        details.push({ nome: result.nome, status: 'inserted', id: result.id });
        inserted++;
      } else {
        details.push({ nome: normalized.nome, status: 'duplicate', reason: result.reason });
        skipped++;
      }
    }

    // Responde 200 IMEDIATAMENTE — Apify recebe o OK antes de qualquer análise
    res.status(200).json({
      ok: true, source, actorId: actId, datasetId,
      total: items.length, inserted, skipped,
      pendentes: insertedIds.length,
      message: `${inserted} lead(s) salvos. Análise Gemini será disparada pelo CRM ao sincronizar.`,
      details, ts: new Date().toISOString(),
    });

    // Nada mais aqui — análise é responsabilidade do agent1-analyze (chamado pelo CRM)

  } catch (err) {
    console.error('[apify-webhook]', err.message);
    // Se ainda não respondemos, retorna erro
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  } finally {
    await client.end().catch(() => {});
  }
}
