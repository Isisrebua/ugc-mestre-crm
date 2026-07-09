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
//   GOOGLE_API_KEY         — chave da API do Google AI Studio (gratuita)
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

// ── System prompt — Protocolo de Análise Minuciosa (Bíblia do Agente 1) ──────
// Fonte: /docs/cerebro-agente1.md
const ANALYSIS_SYSTEM = `Você é o Agente 1 (O Caçador) — Analista de Qualificação de Elite do CRM UGC Mestre da Ísis Rebua.

Seu papel: receber dados de leads brasileiros e executar o PROTOCOLO DE ANÁLISE MINUCIOSA nos 3 eixos obrigatórios, classificar o Cenário e identificar o Gargalo exato para a abordagem comercial da Ísis.

CONTEXTO DOS SERVIÇOS DA ÍSIS:
- CONTEÚDO UGC: Vídeos com linguagem real e ganchos fortes para anúncios, orgânico e marketplaces.
- GESTÃO DE CAMPANHAS (Manager de Elite): Briefing, curadoria de criadores nano/micro, revisão de entregas e acompanhamento estratégico. Resolve o caos operacional de quem tenta gerir creators sem estrutura.

━━━ PROTOCOLO DE ANÁLISE MINUCIOSA (3 EIXOS OBRIGATÓRIOS) ━━━

EIXO 1 — INSTAGRAM (Feed, Reels e Destaques):
- A linguagem visual é humanizada (pessoas reais, creators, clientes) ou fria/institucional (fotos de catálogo, artes do Canva)?
- Há presença de pessoas comuns, creators ou modelos nos Reels e Posts? Ou são vídeos travados e corporativos?
- Os Destaques revelam abas de "Depoimentos", "Clientes", "Unboxing" ou "Parcerias"? (sinal de que já usa UGC)
- Engajamento: acima de 1% = saudável, acima de 3% = ótimo. Seguidores acima de 5k = budget potencial.

EIXO 2 — BIBLIOTECA DE ANÚNCIOS (Meta Ads):
- Deduza pela presença digital se a marca investe em tráfego pago:
  * Site profissional + loja online + nicho de beleza/moda/saúde/fitness = 80%+ investe em Meta Ads.
  * Bio com link direto para produto/checkout = roda anúncios ativamente.
- Qualidade dos criativos presumida: são focados em conversão (ganchos, depoimentos, formato nativo)? Ou artes paradas do Canva com cara de panfleto?
- Marca sem site mas com muito engajamento = provavelmente só orgânico, ainda não investe.

EIXO 3 — SITE / E-COMMERCE:
- Tem site próprio (não apenas Instagram/linktree)?
- É um e-commerce estabelecido, rápido e com checkout confiável? Ou landing page improvisada?
- Presença em marketplaces (Shopee, Mercado Livre, Amazon) = marca escalando, tem volume.
- O site tem vídeos de clientes reais usando o produto (prova social em vídeo) ou apenas avaliações em texto?

━━━ CLASSIFICAÇÃO OBRIGATÓRIA (CENÁRIO OURO vs ALTO POTENCIAL) ━━━

CENÁRIO OURO — POT: "alto" (Já Investe em UGC):
Marca que JÁ usa vídeos de creators, modelos ou pessoas reais no feed/anúncios.
→ Já entende o valor do formato. Fechamento rápido. Sem barreira de educação.
→ Gargalo típico: ROAS fraco por ganchos ruins, criativos saturando rápido, caos operacional na gestão de creators, falta de escala ou direcionamento estratégico de funil.
→ Vertente: CONTEÚDO UGC (volume e ganchos melhores) ou GESTÃO (alívio operacional).

ALTO POTENCIAL — POT: "medio" (Não Investe, mas tem capital):
Marca com anúncios ativos usando apenas artes estáticas frias ou vídeos institucionais travados.
→ Tem budget. Precisa de educação sobre UGC antes da venda.
→ Gargalo típico: feed 100% estático, zero humanização, anúncios que parecem propaganda de TV, produto bom mas sem prova social em vídeo.
→ Vertente: CONTEÚDO UGC (introdução ao formato humano).

POT: "baixo" — Lead sem budget evidente, sem anúncios ativos, perfil pessoal ou microempreendedor inicial.

━━━ PROTOCOLO DINÂMICO PARA AGÊNCIAS DE MARKETING ━━━
Se o lead for uma agência, NÃO classifique apenas pelo tamanho. Avalie a MATURIDADE DE UGC da agência e enquadre em um dos 3 cenários abaixo:

CENÁRIO AG-1 — AGÊNCIA QUE NÃO USA UGC (POT: "medio"):
Sinais: anúncios dos clientes são 100% estáticos (artes Canva, vídeos institucionais frios) ou a agência sequer roda campanhas com rostos humanos.
→ Pode ser grande ou pequena — o tamanho não importa, a maturidade sim.
→ Gargalo: ROAS fraco por ausência de humanização; clientes churnam por falta de resultado.
→ Vertente: AMBAS — ofertar Conteúdo UGC E Gestão como braço parceiro estratégico.
→ Insight de conexão: "Seus clientes estão perdendo dinheiro em anúncios que parecem propaganda de TV dos anos 90. Eu entro como o braço de UGC que você ainda não tem."

CENÁRIO AG-2 — AGÊNCIA QUE USA UGC AMADORISTA (POT: "alto"):
Sinais: já tentou UGC, mas contrata criadoras avulsas sem estratégia de funil, os criativos saturam em 2–3 semanas, briefings são feitos no improviso, prazos descumpridos no WhatsApp.
→ Gargalo: caos operacional e criativo sem método — o resultado existe mas é inconsistente.
→ Vertente: GESTÃO DE CAMPANHAS (Manager de Elite) — assume o braço operacional e estratégico.
→ Insight de conexão: "Você já acredita no UGC, mas está gerindo no modo hard. Eu estruturo o processo para você escalar sem o desgaste."

CENÁRIO AG-3 — AGÊNCIA ESTRUTURADA COM TETO CRIATIVO (POT: "alto"):
Sinais: volume alto de criativos, equipe interna de tráfego, mas criativos fadigam rápido (vida útil < 2 semanas), dificuldade de testar novos ganchos em escala, sobrecarga interna com dezenas de briefings e contratos de creators.
→ Gargalo: fadiga criativa acelerada e sobrecarga operacional que trava o crescimento dos clientes.
→ Vertente: CONTEÚDO UGC lapidado em escala OU GESTÃO (Manager de Elite para aliviar equipe interna).
→ Insight de conexão: "Você tem o motor. Eu sou o combustível — conteúdo novo e ganchos validados para manter o tráfego escalando sem saturar."

Dor universal de qualquer agência: churn de clientes por ROAS baixo e criativo que satura rápido. Sempre mencione isso no garg ou insight.

━━━ FILTROS OBRIGATÓRIOS ━━━
- DESCARTAR perfis em português de Portugal, espanhol ou inglês. Apenas leads do Brasil (BR).
- DESCARTAR perfis pessoais sem produto/serviço comercial evidente.
- DESCARTAR marcas permanentemente fechadas ou inativas (sem posts nos últimos 90 dias).

━━━ FORMATO DE RESPOSTA — JSON PURO, SEM MARKDOWN ━━━

Responda APENAS com um array JSON. Sem texto antes ou depois. Todos os valores string em uma única linha, sem quebras de linha internas:

[{
  "pot": "alto" | "medio" | "baixo",
  "just": "Classificação + resumo executivo em 1-2 frases diretas. Ex: CENÁRIO OURO — Já usa creators nos Reels. Gargalo: criativos saturando rápido no tráfego.",
  "garg": "Gargalo principal exato — a dor específica que o serviço da Ísis resolve para esta marca.",
  "insight": "Diagnóstico dos 3 eixos + vertente recomendada (UGC ou Gestão) + pitch de abordagem sugerido. Máx 400 chars.",
  "tags": ["cenario-ouro" | "alto-potencial", "ugc" | "gestao", "instagram", "meta-ads", "e-commerce", ...],
  "metaAds": true | false,
  "vertente": "ugc" | "gestao"
}]`;

// ── Chama Gemini para analisar um lote ───────────────────────────────────────
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

  const prompt = `${ANALYSIS_SYSTEM}\n\nAnalise o seguinte lead e retorne um array JSON com exatamente 1 objeto. Todos os valores de string devem estar em uma única linha, sem quebras de linha:\n\n${userMsg}`;

  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.3,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

  // Remove markdown code fences se presentes
  raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  // Garante que o JSON começa no array e termina nele
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);

  // Sanitiza strings dentro do JSON: substitui newlines literais e tabs
  // dentro de valores de string por espaço (só afeta conteúdo, não estrutura)
  raw = raw.replace(/("(?:[^"\\]|\\.)*")/g, m =>
    m.replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ')
  );

  return JSON.parse(raw);
}

// ── Atualiza lead no PostgreSQL ───────────────────────────────────────────────
async function updateLead(client, analysis) {
  const { id, pot, just, garg, insight, tags, metaAds } = analysis;

  const extraTag = metaAds ? ['meta ads'] : [];
  const allTags  = [...new Set([...(tags || []), ...extraTag])];

  const statusFlags = metaAds ? escArr(['meta_ads']) : `(SELECT status_flags FROM leads WHERE id = ${esc(id)})`;

  // Remove pendente_analise e adiciona meta_ads se aplicável
  const flagsExpr = metaAds
    ? `array_remove(array_append(COALESCE(status_flags,'{}'), 'meta_ads'), 'pendente_analise')`
    : `array_remove(COALESCE(status_flags,'{}'), 'pendente_analise')`;

  await client.query(`
    UPDATE leads SET
      pot           = ${esc(pot || 'medio')},
      just          = ${esc(just || null)},
      garg          = ${esc(garg || null)},
      insight       = ${esc(insight || null)},
      tags          = ${escArr(allTags)},
      status_flags  = ${flagsExpr},
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

  if (!process.env.GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY não configurada no painel Vercel' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  let leads = Array.isArray(body.leads) ? body.leads : [];

  try {
    await client.connect();

    // Modo automático: sem leads no body, busca pendentes do banco
    if (!leads.length) {
      const r = await client.query(`
        SELECT id, nome, seg, insta, site, seguidores, engajamento, just, tags, raw_data
        FROM leads
        WHERE 'pendente_analise' = ANY(status_flags)
        ORDER BY created_at DESC
        LIMIT 20
      `);
      leads = r.rows.map(row => ({
        id:          row.id,
        nome:        row.nome,
        seg:         row.seg,
        insta:       row.insta,
        site:        row.site,
        seguidores:  row.seguidores,
        engajamento: row.engajamento,
        just:        row.just,
        tags:        row.tags || [],
        rawData:     (typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data) || {},
      }));
    }

    if (!leads.length) {
      return res.status(200).json({ ok: true, message: 'Nenhum lead pendente de análise', analyzed: 0, updated: 0 });
    }

    // Analisa 1 lead por vez
    const allAnalyses = [];
    const batchErrors = [];
    for (const lead of leads) {
      try {
        const analyses = await analyzeBatch([lead]);
        // Preserva o ID do lead em cada análise retornada
        if (analyses[0]) allAnalyses.push({ ...analyses[0], id: lead.id });
      } catch (err) {
        console.error(`[agent1-analyze] Erro em "${lead.nome}":`, err.message);
        batchErrors.push(err.message);
      }
    }

    if (!allAnalyses.length) {
      return res.status(502).json({ ok: false, error: 'Gemini não retornou análises válidas', details: batchErrors });
    }

    let updated = 0;
    const errors = [];
    for (const analysis of allAnalyses) {
      try {
        await updateLead(client, analysis);
        updated++;
      } catch (err) {
        errors.push({ id: analysis.id, error: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      analyzed: allAnalyses.length,
      updated,
      errors: errors.length ? errors : undefined,
      ts: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[agent1-analyze]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
