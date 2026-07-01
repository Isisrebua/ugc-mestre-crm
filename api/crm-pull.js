// api/crm-pull.js — Vercel Serverless Function
// Lê todas as tabelas do PostgreSQL e retorna o estado completo do CRM.
// Variável de ambiente necessária no painel Vercel: DATABASE_URL

import { Client } from 'pg';

export const config = { maxDuration: 30 };

const PULL_SQL = `
  SELECT 'leads'            AS _t, row_to_json(r) AS d FROM leads            r UNION ALL
  SELECT 'cadencia_etapas'  AS _t, row_to_json(r) AS d FROM cadencia_etapas  r UNION ALL
  SELECT 'interacoes'       AS _t, row_to_json(r) AS d FROM interacoes        r UNION ALL
  SELECT 'clientes_ativos'  AS _t, row_to_json(r) AS d FROM clientes_ativos   r UNION ALL
  SELECT 'calls_agendadas'  AS _t, row_to_json(r) AS d FROM calls_agendadas   r UNION ALL
  SELECT 'crm_global_state' AS _t, row_to_json(r) AS d FROM crm_global_state  r;
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const { rows } = await client.query(PULL_SQL);

    const result = {
      leads: [],
      cadencia_etapas: [],
      interacoes: [],
      clientes_ativos: [],
      calls_agendadas: [],
      crm_global_state: null,
    };

    for (const row of rows) {
      const d = typeof row.d === 'string' ? JSON.parse(row.d) : row.d;
      if (!d) continue;
      if (row._t === 'crm_global_state') {
        result.crm_global_state = d;
      } else if (Array.isArray(result[row._t])) {
        result[row._t].push(d);
      }
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('[crm-pull]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
