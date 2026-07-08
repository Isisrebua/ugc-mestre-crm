// api/agent1-hunt.js — Vercel Serverless Function
// ════════════════════════════════════════════════════════════════
// AGENTE 1 · CÉREBRO DE CAÇA
// O Agente 1 chama este endpoint para disparar uma mineração
// no Apify passando nicho, hashtag e limite. O Apify executa o
// Ator e, ao terminar, chama /api/apify-webhook automaticamente
// com os resultados, que entram direto na Pré-Lista.
//
// Fluxo:
//   Agente 1 → POST /api/agent1-hunt
//     → Dispara Ator no Apify (com webhook de retorno)
//     → Apify roda e termina
//     → Apify chama POST /api/apify-webhook
//     → Leads entram na Pré-Lista
//
// Variáveis de ambiente necessárias (Vercel):
//   APIFY_TOKEN    — token da conta Apify
//   HUNTER_SECRET  — protege este endpoint e o webhook de retorno
//   VERCEL_URL     — base URL desta função (ex: ugc-mestre-crm.vercel.app)
//
// Contrato de entrada:
// POST /api/agent1-hunt
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Body:
// {
//   "source":      "instagram" | "google_maps" | "linkedin",
//   "nicho":       "Cosméticos Naturais",
//   "hashtag":     "cosmeticosbrasileiros",   // para Instagram
//   "localizacao": "São Paulo, Brasil",        // para Google Maps
//   "limite":      50,                         // máx de resultados
//   "memoria":     512                         // MB (padrão: 512)
// }
//
// Resposta:
// {
//   "ok": true,
//   "runId": "abc123",
//   "actorId": "...",
//   "actorName": "apify/instagram-hashtag-scraper",
//   "source": "instagram",
//   "message": "Ator disparado. Leads chegarão em /api/apify-webhook ao terminar."
// }
// ════════════════════════════════════════════════════════════════

export const config = { maxDuration: 30 };

// ── Mapeamento: source → Ator Apify ─────────────────────────────────────────
const ACTORS = {
  instagram: {
    id:   '3fgjV51WijDcQxpIK',          // jurassic_jove/instagram-email-scraper
    name: 'jurassic_jove/instagram-email-scraper',
    buildInput: ({ nicho, hashtag, limite }) => ({
      searchTerms:      [nicho || hashtag],
      searchType:       'user',           // busca perfis, não hashtags nem posts
      resultsPerSearch: Math.min(limite || 30, 50),
      maxResults:       limite || 30,
      scrapeEmails:     true,
      scrapeSocials:    true,
      maxConcurrency:   3,
    }),
  },
  google_maps: {
    id:   'nwua9Gu5YrADL7ZDj',           // compass/crawler-google-places
    name: 'compass/crawler-google-places',
    buildInput: ({ nicho, localizacao, limite }) => ({
      searchStringsArray:        [nicho],
      locationQuery:             localizacao || 'Brasil',
      maxCrawledPlacesPerSearch: limite || 30,
      language:                  'pt',
      scrapePlaceDetailPage:     true,
    }),
  },
  linkedin: {
    id:   'UwSdACBp7ymaGUJjS',           // harvestapi/linkedin-company
    name: 'harvestapi/linkedin-company',
    buildInput: ({ nicho, limite }) => ({
      searches: [nicho],
      maxItems: limite || 20,
    }),
  },
};

// ── Disparo via Apify REST API ────────────────────────────────────────────────
async function triggerApifyRun({ actorId, input, webhookUrl, memory, timeout }) {
  // Codifica webhook em base64 para passar na query string
  // Sem payloadTemplate — usa o payload padrão do Apify, que já inclui
  // resource.actId, resource.defaultDatasetId e todos os campos necessários.
  // Um payloadTemplate customizado com {{resource.id}} sem aspas geraria
  // JSON inválido (valores string sem quotes), fazendo o Apify descartar silenciosamente.
  const webhookPayload = JSON.stringify([{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
    requestUrl: webhookUrl,
  }]);

  const webhooksB64 = Buffer.from(webhookPayload).toString('base64');

  const url = `https://api.apify.com/v2/acts/${actorId}/runs`
    + `?token=${encodeURIComponent(process.env.APIFY_TOKEN)}`
    + `&webhooks=${encodeURIComponent(webhooksB64)}`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      memory:  memory  || 512,
      timeout: timeout || 300,
      ...input,        // input da corrida vai junto no body
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Apify retornou ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.data;  // { id, actId, status, ... }
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hunter-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Autenticação ────────────────────────────────────────────────────────────
  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.headers['x-hunter-secret'] || '';
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized — token inválido' });
    }
  }

  if (!process.env.APIFY_TOKEN) {
    return res.status(500).json({ error: 'APIFY_TOKEN não configurado no painel Vercel' });
  }

  // ── Parâmetros da ordem do Agente 1 ────────────────────────────────────────
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  const source     = String(body.source || 'instagram').toLowerCase();
  const nicho      = String(body.nicho      || '').trim();
  const hashtag    = String(body.hashtag    || nicho).trim().replace(/^#/, '');
  const localizacao= String(body.localizacao|| 'Brasil').trim();
  const limite     = Math.min(parseInt(body.limite) || 30, 200);  // máx 200
  const memoria    = parseInt(body.memoria) || 512;

  if (!nicho && !hashtag) {
    return res.status(400).json({ error: 'Informe ao menos "nicho" ou "hashtag"' });
  }

  const actor = ACTORS[source];
  if (!actor) {
    return res.status(400).json({
      error: `source "${source}" inválido. Use: ${Object.keys(ACTORS).join(', ')}`,
    });
  }

  // ── URL do webhook de retorno ───────────────────────────────────────────────
  // IMPORTANTE: VERCEL_URL aponta para o deploy atual (preview), não para o
  // domínio de produção. O webhook do Apify DEVE apontar para o domínio fixo
  // de produção para garantir que o callback sempre chegue ao lugar certo.
  const baseUrl = process.env.PRODUCTION_URL || 'https://ugc-mestre-crm.vercel.app';

  const webhookUrl = `${baseUrl}/api/apify-webhook`
    + (secret ? `?secret=${encodeURIComponent(secret)}` : '');

  // ── Input do Ator ───────────────────────────────────────────────────────────
  const actorInput = actor.buildInput({ nicho, hashtag, localizacao, limite });

  // ── Disparo ─────────────────────────────────────────────────────────────────
  try {
    const run = await triggerApifyRun({
      actorId:    actor.id,
      input:      actorInput,
      webhookUrl,
      memory:     memoria,
      timeout:    600,
    });

    return res.status(200).json({
      ok:        true,
      runId:     run.id,
      actorId:   run.actId,
      actorName: actor.name,
      source,
      status:    run.status,
      input:     actorInput,
      webhookUrl,
      message:   `Ator disparado com sucesso. Os leads chegarão automaticamente em /api/apify-webhook assim que a mineração terminar.`,
      apifyRunUrl: `https://console.apify.com/actors/${actor.id}/runs/${run.id}`,
    });

  } catch (err) {
    console.error('[agent1-hunt]', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
}
