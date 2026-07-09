// api/agent-status.js — Vercel Serverless Function
// GET  /api/agent-status                        → retorna status e tasks de todos os agentes
// POST /api/agent-status { agent, status, ... } → atualiza status de um agente
// POST /api/agent-status { action:'add_task', agent, task }    → adiciona tarefa agendada
// POST /api/agent-status { action:'remove_task', agent, taskId } → remove tarefa agendada

import { Client } from 'pg';

export const config = { maxDuration: 15 };

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_ops (
    agent       TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'inativo',
    detail      TEXT,
    run_id      TEXT,
    apify_url   TEXT,
    tasks       JSONB DEFAULT '[]',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )`;

// Garante coluna tasks em instâncias antigas da tabela
const ADD_COL = `ALTER TABLE agent_ops ADD COLUMN IF NOT EXISTS tasks JSONB DEFAULT '[]'`;

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
  await client.query(ADD_COL);
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
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { action, agent } = body;

      if (!agent) return res.status(400).json({ error: 'agent obrigatório' });

      // ── Adiciona tarefa agendada ──────────────────────────────────
      if (action === 'add_task') {
        const task = body.task;
        if (!task) return res.status(400).json({ error: 'task obrigatória' });
        task.id = task.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        task.criadoEm = new Date().toISOString();
        await client.query(`
          UPDATE agent_ops
          SET tasks = COALESCE(tasks,'[]'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE agent = $2
        `, [JSON.stringify([task]), agent]);
        return res.status(200).json({ ok: true, taskId: task.id });
      }

      // ── Remove tarefa agendada ────────────────────────────────────
      if (action === 'remove_task') {
        const { taskId } = body;
        if (!taskId) return res.status(400).json({ error: 'taskId obrigatório' });
        await client.query(`
          UPDATE agent_ops
          SET tasks = (
            SELECT COALESCE(jsonb_agg(t),'[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(tasks,'[]'::jsonb)) t
            WHERE t->>'id' <> $1
          ), updated_at = NOW()
          WHERE agent = $2
        `, [taskId, agent]);
        return res.status(200).json({ ok: true });
      }

      // ── Atualiza status do agente (comportamento original) ────────
      const { status, detail, runId, apifyUrl } = body;
      if (!status) return res.status(400).json({ error: 'status obrigatório' });

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
