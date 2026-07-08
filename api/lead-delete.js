// api/lead-delete.js — Vercel Serverless Function
// DELETE /api/lead-delete
// Body: { "leadId": 42 }
// Header: X-Hunter-Secret: <HUNTER_SECRET>
// Remove o lead do PostgreSQL permanentemente.

import { Client } from 'pg';

export const config = { maxDuration: 15 };

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

  const body   = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const leadId = parseInt(body.leadId);
  if (!leadId) return res.status(400).json({ error: 'leadId obrigatório' });

  const client = new Client({
    connectionString: process.env.DATABASE_URL_EXTERNAL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const r = await client.query('DELETE FROM leads WHERE id = $1 RETURNING id, nome', [leadId]);
    if (!r.rowCount) return res.status(404).json({ error: `Lead ${leadId} não encontrado` });
    return res.status(200).json({ ok: true, deleted: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    await client.end().catch(() => {});
  }
}
