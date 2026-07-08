// api/agent-status.js — Vercel Serverless Function
// GET  /api/agent-status        → retorna status atual de todos os agentes
// POST /api/agent-status        → atualiza status de um agente
// Body POST: { agent, status, detail, runId, apifyUrl }
//
// Cria a tabela agent_ops automaticamente se não existir.

import { Client } from 'pg';

export const config = { maxDuration: 15 };

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_ops (
    agent       TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'inativo',
    detail      TEXT,
    run_id      TEXT,
    apify_url   TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )`;

// Seed com os 6 agentes se a tabela estiver vazia
const SEED = `
  INSERT INTO agent_ops (agent, status, detail) VALUES
    ('ag1','inativo','Aguardando ativação'),
    ('ag2','inativo','Aguardando ativação'),
    ('ag3','inativo','Aguardando ativação'),
    ('ag4','inativo','Aguardando ativação'),
    ('ag5','inativo','Aguardando ativação'),
    ('ag_atend','inativo','Aguardando ativação')
  ON CONFLICT (agent) DO NOTHING`;

async function getClient() {
  const client = new Client({ connectionString: process.env.DATABASE_URL_EXTERNAL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(CREATE_TABLE);
  await client.query(SEED);
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hunter-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const secret = process.env.HUNTER_SECRET;
  if (secret && req.method === 'POST') {
    const provided = req.headers['x-hunter-secret'] || '';
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const client = await getClient().catch(err => { res.status(500).json({ error: err.message }); return null; });
  if (!client) return;

  try {
    if (req.method === 'GET') {
      const { rows } = await client.query('SELECT * FROM agent_ops ORDER BY agent');
      return res.status(200).json({ ok: true, agents: rows });
    }

    if (req.method === 'POST') {
      const body   = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { agent, status, detail, runId, apifyUrl } = body;
      if (!agent || !status) return res.status(400).json({ error: 'agent e status obrigatórios' });

      await client.query(`
        INSERT INTO agent_ops (agent, status, detail, run_id, apify_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (agent) DO UPDATE SET
          status=$2, detail=$3, run_id=$4, apify_url=$5, updated_at=NOW()
      `, [agent, status, detail||null, runId||null, apifyUrl||null]);

      return res.status(200).json({ ok: true, agent, status });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } finally {
    await client.end().catch(() => {});
  }
}
