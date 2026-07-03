// api/apify-webhook.js — Vercel Serverless Function
// Recebe o webhook do Apify quando um Ator termina com sucesso,
// busca os itens do dataset, normaliza por tipo de Ator e insere
// os leads novos na Pré-Lista (dedup via PostgreSQL).
//
// Variáveis de ambiente necessárias no painel Vercel:
//   DATABASE_URL   — já configurada
//   APIFY_TOKEN    — token da sua conta Apify (Settings → Integrations → API tokens)
//   HUNTER_SECRET  — mesmo segredo usado em /api/hunter (opcional mas recomendado)
//
// Como configurar o webhook no Apify:
//   Apify Console → Actor → Settings → Webhooks → Add webhook
//   URL:    https://<seu-projeto>.vercel.app/api/apify-webhook?secret=<HUNTER_SECRET>
//   Events: ACTOR.RUN.SUCCEEDED
//
// Payload recebido do Apify (automático):
// {
//   "eventType": "ACTOR.RUN.SUCCEEDED",
//   "eventData": { "actorId": "...", "actorRunId": "..." },
//   "resource": {
//     "id": "<runId>",
//     "actId": "<actorId>",
//     "status": "SUCCEEDED",
//     "defaultDatasetId": "<datasetId>"
//   }
// }

import { Client } from 'pg';
import { insertLead } from './_lib.js';

export const config = { maxDuration: 60 };

// ── IDs dos Atores Apify que usamos ─────────────────────────────────────────
// Mapeamos o actId para o normalizador correto.
// Se você usar outro ator, adicione o ID aqui e crie o normalizador abaixo.
const ACTOR_NORMALIZERS = {
  // apify/instagram-profile-scraper
  'dSCLg0C3YEZ83HzYX': normalizeInstagram,
  // compass/crawler-google-places (Google Maps Scraper)
  'nwua9Gu5YrADL7ZDj': normalizeGoogleMaps,
  // lukaskrivka/google-maps-with-contact-details (Maps + Email)
  'WnMxbsRLNbPeYL6ge': normalizeGoogleMaps,
  // harvestapi/linkedin-company
  'UwSdACBp7ymaGUJjS': normalizeLinkedIn,
};

// ── Normalizadores por Ator ──────────────────────────────────────────────────

// apify/instagram-profile-scraper
// Campos: username, fullName, biography, followersCount, externalUrl,
//         businessCategoryName, isBusinessAccount, isVerified, url
function normalizeInstagram(item) {
  if (!item.username && !item.fullName) return null;

  const nome  = item.fullName || item.username;
  const insta = item.username ? `@${item.username}` : null;
  const seg   = item.businessCategoryName || 'Instagram';

  // Estima potencial pela contagem de seguidores
  const followers = item.followersCount || 0;
  const pot = followers >= 100000 ? 'alto' : 'medio';

  const seguidores = followers
    ? followers >= 1000 ? `${Math.round(followers / 1000)}k` : String(followers)
    : null;

  // Taxa de engajamento estimada (likes+comentários / seguidores)
  let engajamento = null;
  if (item.latestPosts?.length && followers > 0) {
    const totalEng = item.latestPosts.slice(0, 6).reduce(
      (s, p) => s + (p.likesCount || 0) + (p.commentsCount || 0), 0
    );
    const rate = (totalEng / item.latestPosts.slice(0, 6).length / followers) * 100;
    engajamento = `${rate.toFixed(1)}%`;
  }

  return {
    nome,
    insta,
    site:  item.externalUrl || null,
    seg,
    pot,
    seguidores,
    engajamento,
    just:  item.biography ? `Bio: ${item.biography.slice(0, 200)}` : null,
    tags:  ['instagram', ...(item.isVerified ? ['verificado'] : [])],
    rawData: {
      instagramUrl:    item.url,
      isBusinessAccount: item.isBusinessAccount,
      isVerified:      item.isVerified,
      postsCount:      item.postsCount,
      followingCount:  item.followingCount,
    },
  };
}

// compass/crawler-google-places + lukaskrivka/google-maps-with-contact-details
// Campos: title, website, phone, address, categoryName, totalScore,
//         reviewsCount, socialMedia { instagram, facebook, linkedin }
//         email (do enrichment), permanentlyClosed
function normalizeGoogleMaps(item) {
  if (!item.title) return null;
  if (item.permanentlyClosed) return null;

  const insta = item.socialMedia?.instagram
    ? '@' + item.socialMedia.instagram.replace(/.*instagram\.com\/([^/?#]+).*/i, '$1')
    : null;

  const pot = (item.totalScore || 0) >= 4 && (item.reviewsCount || 0) >= 50
    ? 'alto' : 'medio';

  const endereco = [item.city, item.state, item.countryCode]
    .filter(Boolean).join(', ') || item.address || null;

  return {
    nome:      item.title,
    insta,
    site:      item.website || null,
    seg:       item.categoryName || 'Negócio Local',
    email:     item.email || item.emails?.[0] || null,
    telefone:  item.phone || null,
    linkedin:  item.socialMedia?.linkedin || null,
    pot,
    just:      `Google Maps · ${item.categoryName || '—'} · ⭐ ${item.totalScore || '—'} (${item.reviewsCount || 0} avaliações)${endereco ? ' · ' + endereco : ''}`,
    tags:      ['google maps', item.categoryName].filter(Boolean),
    rawData: {
      googleMapsUrl:  item.url,
      rating:         item.totalScore,
      reviewsCount:   item.reviewsCount,
      address:        item.address,
      location:       item.location,
      socialMedia:    item.socialMedia,
    },
  };
}

// harvestapi/linkedin-company
// Campos: name, website, description, employeeCount, followerCount,
//         industry, headquarters { city, state, country }, phone, linkedinUrl
function normalizeLinkedIn(item) {
  if (!item.name) return null;

  const hq = item.headquarters
    ? [item.headquarters.city, item.headquarters.state, item.headquarters.country]
        .filter(Boolean).join(', ')
    : null;

  const employees = item.employeeCount || 0;
  const pot = employees >= 50 ? 'alto' : 'medio';

  return {
    nome:     item.name,
    site:     item.website || null,
    seg:      item.industry || 'LinkedIn',
    telefone: item.phone || null,
    linkedin: item.linkedinUrl || null,
    pot,
    capital:  employees ? `${employees} funcionários` : null,
    just:     item.description ? item.description.slice(0, 300) : null,
    tags:     ['linkedin', item.industry].filter(Boolean),
    rawData: {
      linkedinUrl:   item.linkedinUrl,
      employeeCount: item.employeeCount,
      followerCount: item.followerCount,
      foundedYear:   item.foundedYear,
      headquarters:  hq,
      specialties:   item.specialties,
    },
  };
}

// Fallback: tenta mapear campos genéricos de qualquer ator desconhecido
function normalizeGeneric(item) {
  const nome = item.name || item.title || item.fullName || item.companyName || null;
  if (!nome) return null;

  return {
    nome,
    insta:    item.instagram || item.instagramUrl || null,
    site:     item.website || item.url || null,
    seg:      item.category || item.industry || item.seg || 'Sem segmento',
    email:    item.email || null,
    telefone: item.phone || item.telefone || null,
    linkedin: item.linkedin || item.linkedinUrl || null,
    pot:      item.pot || 'medio',
    just:     item.description || item.biography || item.just || null,
    tags:     [],
    rawData:  item,
  };
}

// ── Fetch dataset do Apify ────────────────────────────────────────────────────

async function fetchDataset(datasetId, token) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items`
    + `?token=${encodeURIComponent(token)}&format=json&limit=500&clean=true`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Apify dataset fetch falhou: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Verificação de segredo ────────────────────────────────────────────────
  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.query?.secret || req.headers['x-hunter-secret'] || '';
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // Aceita tanto o payload completo do Apify quanto um payload simplificado
  // { datasetId, actorId } para testes manuais
  const datasetId = body.resource?.defaultDatasetId || body.datasetId || null;
  const actId     = body.resource?.actId            || body.actorId   || null;

  if (!datasetId) {
    return res.status(400).json({ error: 'defaultDatasetId ausente no payload do Apify' });
  }

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    return res.status(500).json({ error: 'APIFY_TOKEN não configurado nas env vars da Vercel' });
  }

  // ── Buscar itens do dataset ───────────────────────────────────────────────
  let items;
  try {
    items = await fetchDataset(datasetId, apifyToken);
  } catch (err) {
    return res.status(502).json({ error: `Erro ao buscar dataset Apify: ${err.message}` });
  }

  if (!Array.isArray(items) || !items.length) {
    return res.status(200).json({ ok: true, message: 'Dataset vazio — nenhum lead para processar', inserted: 0, skipped: 0 });
  }

  // ── Escolher normalizador ─────────────────────────────────────────────────
  const normalize = (actId && ACTOR_NORMALIZERS[actId]) || normalizeGeneric;
  const source    = actId
    ? Object.keys(ACTOR_NORMALIZERS).includes(actId)
      ? actId === 'dSCLg0C3YEZ83HzYX' ? 'instagram'
        : actId === 'nwua9Gu5YrADL7ZDj' || actId === 'WnMxbsRLNbPeYL6ge' ? 'google_maps'
        : actId === 'UwSdACBp7ymaGUJjS' ? 'linkedin'
        : 'apify'
      : 'apify'
    : 'apify';

  // ── Conectar ao banco e inserir ───────────────────────────────────────────
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const details  = [];
    let inserted   = 0;
    let skipped    = 0;

    for (const item of items) {
      const normalized = normalize(item);

      if (!normalized) {
        details.push({ status: 'skipped', reason: 'item sem campos mínimos ou negócio fechado' });
        skipped++;
        continue;
      }

      const result = await insertLead(client, { ...normalized, source });

      if (result.inserted) {
        details.push({ nome: result.nome, status: 'inserted', id: result.id });
        inserted++;
      } else {
        details.push({ nome: normalized.nome, status: 'duplicate', reason: result.reason });
        skipped++;
      }
    }

    return res.status(200).json({
      ok:       true,
      source,
      actorId:  actId,
      datasetId,
      total:    items.length,
      inserted,
      skipped,
      details,
      ts:       new Date().toISOString(),
    });

  } catch (err) {
    console.error('[apify-webhook]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
