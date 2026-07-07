// api/agent1-think.js — Vercel Serverless Function
// ════════════════════════════════════════════════════════════════
// AGENTE 1 · CÉREBRO AUTÔNOMO
// Recebe a instrução da Ísis em linguagem natural + contexto do CRM,
// chama a Anthropic Messages API, interpreta a decisão e dispara
// automaticamente o /api/agent1-hunt com os parâmetros corretos.
//
// Fluxo completo:
//   Ísis clica "Enviar ao Agente" no CRM
//     → POST /api/agent1-think { instrucao, contexto }
//       → Anthropic Messages API (claude-sonnet-4-5)
//         → Claude decide: source, nicho, hashtag, limite...
//           → POST /api/agent1-hunt (interno)
//             → Apify minera
//               → Leads chegam na Pré-Lista ✅
//
// Variáveis de ambiente necessárias (Vercel):
//   ANTHROPIC_API_KEY  — chave da API da Anthropic
//   HUNTER_SECRET      — protege este endpoint
//   VERCEL_URL         — base URL (ex: ugc-mestre-crm.vercel.app)
//
// Contrato de entrada:
// POST /api/agent1-think
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Body:
// {
//   "instrucao": "Busca 50 contas de skincare natural no Instagram",
//   "contexto": {                      // opcional — dados atuais do CRM
//     "totalLeads": 142,
//     "ultimaBusca": "cosmeticos",
//     "nichosFoco": ["skincare", "moda sustentável"]
//   }
// }
// ════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `Você é o Agente 1 (O Caçador) do CRM UGC Mestre da Ísis Rebua.

Sua missão: transformar instruções em linguagem natural em comandos estruturados de mineração de leads para criadores de conteúdo UGC (User Generated Content) brasileiros.

## Seu papel
- Recebe ordens da Ísis via chat do CRM
- Analisa o contexto atual da base de leads
- Decide qual canal, nicho, hashtag e volume usar
- Retorna APENAS um JSON de decisão (sem explicações extras)

## Canais disponíveis
- **instagram**: Busca por hashtag. Ideal para criadores de conteúdo, influenciadores, marcas com presença visual forte.
- **google_maps**: Busca negócios locais. Ideal para empresas físicas (lojas, restaurantes, academias) que precisam de UGC local.
- **linkedin**: Busca empresas B2B. Ideal para marcas que vendem para outras empresas e precisam de conteúdo institucional.

## Regras de decisão
1. Se a instrução mencionar hashtag, criador, influenciador, Instagram → source: "instagram"
2. Se mencionar negócio local, cidade, loja física, restaurante, academia → source: "google_maps"
3. Se mencionar empresa, B2B, corporativo, LinkedIn → source: "linkedin"
4. Limite padrão: 30. Se Ísis pedir "bastante" ou "muitos" → 100. Se pedir "teste" ou "poucos" → 10.
5. Hashtags: remova o # e use letras minúsculas sem acentos. Ex: "skincare natural" → "skincarenatural".
6. Nichos compostos: use a versão mais específica. "moda sustentável feminina" é melhor que "moda".

## Formato de resposta (OBRIGATÓRIO — apenas JSON puro, sem markdown)
{
  "decisao": {
    "source": "instagram" | "google_maps" | "linkedin",
    "nicho": "string",
    "hashtag": "string (só para instagram, sem #)",
    "localizacao": "string (só para google_maps)",
    "limite": number,
    "justificativa": "string curta explicando a escolha"
  }
}

Se a instrução for ambígua ou pedir algo impossível, retorne:
{
  "erro": "string explicando o que faltou na instrução"
}`;

// ── Chama Anthropic Messages API ──────────────────────────────────────────────
async function askClaude(instrucao, contexto) {
  const userMessage = contexto
    ? `Instrução da Ísis: ${instrucao}\n\nContexto atual do CRM:\n${JSON.stringify(contexto, null, 2)}`
    : `Instrução da Ísis: ${instrucao}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 512,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic API retornou ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const raw  = data.content?.[0]?.text || '';

  // Remove possível markdown ```json ... ``` antes de parsear
  const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

// ── Dispara agent1-hunt internamente ─────────────────────────────────────────
async function dispararHunt(decisao, baseUrl, secret) {
  const url = `${baseUrl}/api/agent1-hunt`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Hunter-Secret': secret || '',
    },
    body: JSON.stringify({
      source:      decisao.source,
      nicho:       decisao.nicho,
      hashtag:     decisao.hashtag,
      localizacao: decisao.localizacao,
      limite:      decisao.limite || 30,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`agent1-hunt retornou ${resp.status}: ${txt}`);
  }

  return resp.json();
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
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no painel Vercel' });
  }

  const body       = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const instrucao  = String(body.instrucao || '').trim();
  const contexto   = body.contexto || null;

  if (!instrucao) {
    return res.status(400).json({ error: 'Campo "instrucao" obrigatório' });
  }

  // ── Passo 1: Claude decide ──────────────────────────────────────────────────
  let resultado;
  try {
    resultado = await askClaude(instrucao, contexto);
  } catch (err) {
    return res.status(502).json({ ok: false, etapa: 'anthropic', error: err.message });
  }

  // Se Claude devolveu um erro de instrução ambígua
  if (resultado.erro) {
    return res.status(200).json({
      ok:    false,
      agente: 'aguardando_instrucao',
      mensagem: resultado.erro,
    });
  }

  const decisao = resultado.decisao;
  if (!decisao?.source || !decisao?.nicho) {
    return res.status(502).json({
      ok:    false,
      error: 'Resposta do Agente incompleta — faltou source ou nicho',
      raw:   resultado,
    });
  }

  // ── Passo 2: Dispara o hunt ─────────────────────────────────────────────────
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://ugc-mestre-crm.vercel.app';

  let hunt;
  try {
    hunt = await dispararHunt(decisao, baseUrl, secret);
  } catch (err) {
    return res.status(502).json({ ok: false, etapa: 'agent1-hunt', error: err.message, decisao });
  }

  // ── Resposta final ──────────────────────────────────────────────────────────
  return res.status(200).json({
    ok:           true,
    instrucao,
    decisao,
    hunt: {
      runId:       hunt.runId,
      actorName:   hunt.actorName,
      status:      hunt.status,
      apifyRunUrl: hunt.apifyRunUrl,
    },
    mensagem: `✅ Agente 1 em ação! Minerando "${decisao.nicho}" via ${decisao.source}. Os leads chegarão na Pré-Lista automaticamente.`,
    ts: new Date().toISOString(),
  });
}
