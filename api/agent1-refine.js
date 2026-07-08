// api/agent1-refine.js — Vercel Serverless Function
// ════════════════════════════════════════════════════════════════
// AGENTE 1 · AJUSTE FINO (IDA E VOLTA)
//
// A Ísis digita uma instrução de melhoria para um lead específico
// no CRM. O CRM envia { leadId, instrucao }. Este endpoint:
//   1. Busca o lead atual no PostgreSQL pelo ID
//   2. Envia lead + instrução para o Gemini
//   3. Gemini retorna os campos atualizados
//   4. Atualiza o lead no banco
//   5. Retorna os campos novos para o CRM atualizar a UI
//
// Variáveis de ambiente necessárias (Vercel):
//   GOOGLE_API_KEY         — chave do Google AI Studio (gratuita)
//   DATABASE_URL_EXTERNAL  — PostgreSQL externo (Render)
//   HUNTER_SECRET          — protege este endpoint
//
// Contrato de entrada:
// POST /api/agent1-refine
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Body: { "leadId": 3, "instrucao": "Foca no pitch de reels curtos" }
//
// Resposta:
// {
//   "ok": true,
//   "leadId": 3,
//   "campos": { "just", "garg", "insight", "pot", "tags" }
// }
// ════════════════════════════════════════════════════════════════

import { Client } from 'pg';
import { esc, escArr } from './_lib.js';

export const config = { maxDuration: 30 };

const REFINE_SYSTEM = `Você é o Analista de Ajuste Fino UGC do CRM da Ísis Rebua.

A Ísis já qualificou este lead e agora quer refinar o diagnóstico com uma instrução específica.

Seu trabalho: ler os dados atuais do lead + a instrução da Ísis, e retornar APENAS os campos que devem ser atualizados, com o refinamento aplicado.

## Campos que você pode atualizar

- **just** — resumo executivo (1-2 frases diretas para decisão rápida)
- **garg** — gargalo principal que UGC resolve para essa marca
- **insight** — diagnóstico completo refinado (máx 400 chars, sem quebra de linha)
- **pot** — potencial: "alto", "medio" ou "baixo"
- **tags** — array de tags relevantes (strings curtas, sem acentos)

## Regras

1. Aplique a instrução da Ísis com precisão — ela conhece o negócio
2. Mantenha o que já estava bom; só ajuste o que a instrução pede
3. Seja direto e acionável — sem floreios
4. Todos os valores string: UMA linha, sem quebras de linha internas

## Formato de resposta (JSON puro, sem markdown, sem texto extra)

{
  "just": "string",
  "garg": "string",
  "insight": "string",
  "pot": "alto" | "medio" | "baixo",
  "tags": ["tag1", "tag2"]
}`;

// ── Busca o lead no banco ─────────────────────────────────────────────────────
async function fetchLead(client, leadId) {
  const { rows } = await client.query(
    `SELECT id, nome, seg, insta, site, pot, just, garg, insight, tags,
            seguidores, engajamento, ag2_reasoning
     FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

// ── Chama Gemini para o ajuste fino ──────────────────────────────────────────
async function callGemini(lead, instrucao) {
  const leadCtx = [
    `ID: ${lead.id}`,
    `Nome: ${lead.nome}`,
    `Segmento: ${lead.seg || '—'}`,
    lead.insta       ? `Instagram: ${lead.insta}` : null,
    lead.site        ? `Site: ${lead.site}` : null,
    lead.seguidores  ? `Seguidores: ${lead.seguidores}` : null,
    lead.engajamento ? `Engajamento: ${lead.engajamento}` : null,
    lead.pot         ? `Potencial atual: ${lead.pot}` : null,
    lead.just        ? `Resumo atual: ${lead.just}` : null,
    lead.garg        ? `Gargalo atual: ${lead.garg}` : null,
    lead.insight     ? `Diagnóstico atual: ${lead.insight}` : null,
    (lead.tags || []).length ? `Tags atuais: ${lead.tags.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `${REFINE_SYSTEM}

## Dados atuais do lead

${leadCtx}

## Instrução da Ísis

${instrucao}

Retorne o JSON com os campos atualizados:`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:      0.3,
        maxOutputTokens:  512,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${txt}`);
  }

  const data  = await resp.json();
  let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  // Limpa markdown e sanitiza newlines dentro de strings
  raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  raw = raw.replace(/("(?:[^"\\]|\\.)*")/g, m =>
    m.replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ')
  );

  return JSON.parse(raw);
}

// ── Salva os campos refinados no banco ───────────────────────────────────────
async function saveCampos(client, leadId, campos) {
  const sets = [];

  if (campos.pot)     sets.push(`pot     = ${esc(campos.pot)}`);
  if (campos.just)    sets.push(`just    = ${esc(campos.just)}`);
  if (campos.garg)    sets.push(`garg    = ${esc(campos.garg)}`);
  if (campos.insight) sets.push(`insight = ${esc(campos.insight)}`);
  if (Array.isArray(campos.tags) && campos.tags.length) {
    sets.push(`tags = ${escArr(campos.tags)}`);
  }

  if (!sets.length) return;

  await client.query(
    `UPDATE leads SET ${sets.join(', ')} WHERE id = ${esc(leadId)}`
  );
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
    return res.status(500).json({ error: 'GOOGLE_API_KEY não configurada' });
  }

  const body      = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const leadId    = parseInt(body.leadId);
  const instrucao = String(body.instrucao || '').trim();

  if (!leadId || !instrucao) {
    return res.status(400).json({ error: 'Campos obrigatórios: leadId (número) e instrucao (string)' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // 1. Busca lead atual
    const lead = await fetchLead(client, leadId);
    if (!lead) {
      return res.status(404).json({ error: `Lead ${leadId} não encontrado no banco` });
    }

    // 2. Gemini processa
    let campos;
    try {
      campos = await callGemini(lead, instrucao);
    } catch (err) {
      return res.status(502).json({ ok: false, error: `Gemini: ${err.message}` });
    }

    // 3. Salva no banco
    await saveCampos(client, leadId, campos);

    // 4. Retorna campos atualizados para o CRM atualizar a UI
    return res.status(200).json({
      ok:      true,
      leadId,
      nome:    lead.nome,
      campos,
      ts:      new Date().toISOString(),
    });

  } catch (err) {
    console.error('[agent1-refine]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
