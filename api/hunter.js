// api/hunter.js — Vercel Serverless Function
// Webhook manual do Agente 1: recebe leads brutos de qualquer fonte
// (planilha, script Python, Make.com, Zapier, etc.) e os insere
// na Pré-Lista com dedup via PostgreSQL.
//
// Variáveis de ambiente: DATABASE_URL, HUNTER_SECRET (opcional)
//
// POST /api/hunter
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Body:
// {
//   "source": "google_maps" | "instagram" | "linkedin" | "manual" | ...,
//   "leads": [
//     {
//       "nome":        "Glow Beauty",        // obrigatório
//       "insta":       "@glowbeauty",
//       "site":        "www.glowbeauty.com",
//       "seg":         "Cosméticos Naturais",
//       "email":       "contato@marca.com",
//       "whatsapp":    "(11) 99999-9999",
//       "telefone":    "(11) 3333-3333",
//       "linkedin":    "linkedin.com/company/...",
//       "pot":         "alto" | "medio",
//       "capital":     "R$ 500k–2M/ano",
//       "just":        "Justificativa do agente...",
//       "garg":        "Gargalo identificado...",
//       "insight":     "Oportunidade UGC...",
//       "seguidores":  "45k",
//       "engajamento": "3.2%",
//       "metaAds":     true,
//       "tags":        ["pet", "premium"],
//       "rawData":     {}
//     }
//   ]
// }

import { Client } from 'pg';
import { insertLead } from './_lib.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hunter-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.HUNTER_SECRET;
  if (secret) {
    const provided = req.headers['x-hunter-secret'] || '';
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized — token inválido' });
    }
  }

  const body     = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const rawLeads = Array.isArray(body?.leads) ? body.leads : [];
  const source   = String(body?.source || 'manual').slice(0, 64);

  if (!rawLeads.length) {
    return res.status(400).json({ error: 'Nenhum lead enviado. Use { "leads": [...] }' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const details = [];
    let inserted  = 0;
    let skipped   = 0;

    for (const raw of rawLeads) {
      const result = await insertLead(client, { ...raw, source });

      if (result.inserted) {
        details.push({ nome: result.nome, status: 'inserted', id: result.id });
        inserted++;
      } else {
        details.push({ nome: raw.nome || '(sem nome)', status: result.reason?.startsWith('duplicata') ? 'duplicate' : 'skipped', reason: result.reason });
        skipped++;
      }
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
