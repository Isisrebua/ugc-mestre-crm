/* ══════════════════════════════════════════════════════════════════════════════
   UGC Mestre CRM — Módulo de Sincronização Cloud (sync.js) — Rota B
   Estratégia: localStorage como fonte primária (offline-first).
               n8n webhook como gateway para PostgreSQL (Rota B definitiva).
   Webhooks:
     POST  {n8nUrl}/webhook/crm-push  →  envia tudo para o banco
     GET   {n8nUrl}/webhook/crm-pull  →  lê tudo do banco
   Injeção: <script src="sync.js"></script> antes do </body> no index.html.
══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const CONFIG_KEY  = 'crm_cloud_config';
  const SYNC_LOG    = 'crm_sync_log';
  const DEBOUNCE_MS = 2000;

  let _syncTimer   = null;
  let _isSyncing   = false;
  let _pendingSync = false;

  /* ══════════════════════════════════════════════
     1. CONFIGURAÇÃO
     Formato: { n8nUrl, enabled }
     Ex: { n8nUrl: "https://n8n-ugc-mestre.onrender.com", enabled: true }
  ══════════════════════════════════════════════ */

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
    catch { return {}; }
  }

  function setConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    _log('⚙️ Config atualizada.', cfg.n8nUrl ? 'ok' : 'disabled');
  }

  function isCloudReady() {
    const cfg = getConfig();
    return !!(cfg.enabled && cfg.n8nUrl && navigator.onLine);
  }

  /* ══════════════════════════════════════════════
     2. LOG
  ══════════════════════════════════════════════ */

  function _log(msg, status) {
    const entry = { ts: new Date().toISOString(), msg, status: status || 'info' };
    try {
      const log = JSON.parse(localStorage.getItem(SYNC_LOG) || '[]');
      log.unshift(entry);
      if (log.length > 50) log.length = 50;
      localStorage.setItem(SYNC_LOG, JSON.stringify(log));
    } catch {}
    console.log(`[CRM Sync] ${msg}`);
    _updateSyncBadge(status);
  }

  function _updateSyncBadge(status) {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;
    const states = {
      ok:       { txt: '☁️ Salvo na nuvem', cls: 'sync-ok'  },
      syncing:  { txt: '🔄 Sincronizando…', cls: 'sync-ing' },
      offline:  { txt: '📴 Offline — local', cls: 'sync-off' },
      error:    { txt: '⚠️ Erro de sync',   cls: 'sync-err' },
      disabled: { txt: '💾 Apenas local',   cls: 'sync-dis' },
      info:     { txt: '',                  cls: ''          },
    };
    const s = states[status] || states.info;
    badge.textContent = s.txt;
    badge.className   = `sync-badge ${s.cls}`;
    badge.style.display = s.txt ? '' : 'none';
  }

  /* ══════════════════════════════════════════════
     3. HTTP — VERCEL API
  ══════════════════════════════════════════════ */

  function _apiUrl(path) {
    const { n8nUrl } = getConfig();
    return `${n8nUrl.replace(/\/$/, '')}/api/${path}`;
  }

  async function _n8nPost(path, body) {
    const res = await fetch(_apiUrl(path), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function _n8nGet(path) {
    const res = await fetch(_apiUrl(path));
    if (!res.ok) throw new Error(`API ${path}: HTTP ${res.status}`);
    return res.json();
  }

  /* ══════════════════════════════════════════════
     4. ADAPTADORES (CRM interno → payload n8n e vice-versa)
  ══════════════════════════════════════════════ */

  function _buildPushPayload() {
    return {
      leads:       window.Leads_Geral      || [],
      cadencia:    window.Cadencia         || {},
      interacoes:  window.Interacoes       || {},
      clientes:    window.Clientes_Ativos  || [],
      calls:       window.CallsAgendadas   || [],
      globalState: {
        nichoCustom:    window._nichoCustom     || {},
        plChecked:      window.plChecked        || {},
        plLeadComments: window.plLeadComments   || {},
        plGlobalCmdText:window.plGlobalCmdText  || '',
        aprovMasterText:window.aprovMasterText  || '',
        aprovEtapaCmd:  window.aprovEtapaCmd    || {},
        aprovReprocess: window.aprovReprocess   || {},
      },
    };
  }

  function _parseJ(val, fallback) {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return fallback; }
  }

  function _applyPullResponse(data) {
    /* leads */
    window.Leads_Geral = (data.leads || []).map(row => ({
      id:              row.id,
      nome:            row.nome,
      seg:             row.seg,
      insta:           row.insta,
      site:            row.site,
      canal:           row.canal,
      pot:             row.pot,
      capital:         row.capital,
      valor:           row.valor,
      agent:           row.agent,
      tags:            row.tags           || [],
      seguidores:      row.seguidores,
      engajamento:     row.engajamento,
      just:            row.just,
      garg:            row.garg,
      insight:         row.insight,
      contatos:        _parseJ(row.contatos, []),
      stage:           row.stage,
      tabs:            row.tabs           || [row.stage],
      escopo:          row.escopo         || ['ugc'],
      statusFlags:     row.status_flags   || [],
      dataCaptacao:    row.data_captacao,
      proximaAcao:     row.proxima_acao,
      retomarContato:  row.retomar_contato,
      cadenciaPausada: row.cadencia_pausada || false,
      agentNote:       row.agent_note,
      sazonalNote:     row.sazonal_note,
      inicioCadencia:  row.inicio_cadencia,
      ag2Status:       row.ag2_status,
      ag2Reasoning:    _parseJ(row.ag2_reasoning, {}),
      orderHistory:    _parseJ(row.order_history, []),
    }));

    /* cadência — agrupa por lead_id */
    window.Cadencia = {};
    (data.cadencia_etapas || []).forEach(row => {
      const lid = row.lead_id;
      if (!window.Cadencia[lid]) window.Cadencia[lid] = [];
      window.Cadencia[lid].push({
        id: row.id, et: row.et, titulo: row.titulo, canal: row.canal,
        data: row.data, status: row.status, roteiro: row.roteiro,
        motivo: row.motivo, occ: row.occ, locked: row.locked,
      });
    });

    /* interações — agrupa por lead_id */
    window.Interacoes = {};
    (data.interacoes || []).forEach(row => {
      const lid = row.lead_id;
      if (!window.Interacoes[lid]) window.Interacoes[lid] = [];
      window.Interacoes[lid].push({
        id: row.id, tipo: row.tipo, canal: row.canal,
        data: row.data, texto: row.texto, aprovado: row.aprovado,
      });
    });

    /* clientes e calls — direto */
    window.Clientes_Ativos = data.clientes_ativos || [];
    window.CallsAgendadas  = (data.calls_agendadas || []).map(c => ({
      id: c.id, leadId: c.lead_id, nome: c.nome, data: c.data,
      hora: c.hora, canal: c.canal, intuito: c.intuito, status: c.status,
    }));

    /* estado global */
    const gs = data.crm_global_state;
    if (gs) {
      if (gs.nicho_custom)       Object.assign(window._nichoCustom || {}, _parseJ(gs.nicho_custom, {}));
      if (gs.pl_checked)         window.plChecked        = _parseJ(gs.pl_checked, {});
      if (gs.pl_lead_comments)   window.plLeadComments   = _parseJ(gs.pl_lead_comments, {});
      if (gs.pl_global_cmd_text !== undefined) window.plGlobalCmdText  = gs.pl_global_cmd_text;
      if (gs.aprov_master_text  !== undefined) window.aprovMasterText  = gs.aprov_master_text;
      if (gs.aprov_etapa_cmd)    window.aprovEtapaCmd    = _parseJ(gs.aprov_etapa_cmd, {});
      if (gs.aprov_reprocess)    window.aprovReprocess   = _parseJ(gs.aprov_reprocess, {});
    }
  }

  /* ══════════════════════════════════════════════
     5. PUSH — localStorage → n8n → PostgreSQL
  ══════════════════════════════════════════════ */

  async function pushToCloud() {
    if (_isSyncing) { _pendingSync = true; return; }
    if (!isCloudReady()) {
      _log('Push ignorado — offline ou não configurado.', 'offline');
      return;
    }

    _isSyncing = true;
    _updateSyncBadge('syncing');

    try {
      const payload = _buildPushPayload();
      await _n8nPost('crm-push', payload);  // → /api/crm-push
      _log('✅ Sincronização completa com a nuvem.', 'ok');
    } catch (err) {
      _log(`❌ Erro ao sincronizar: ${err.message}`, 'error');
    } finally {
      _isSyncing = false;
      if (_pendingSync) { _pendingSync = false; scheduleSync(); }
    }
  }

  /* ══════════════════════════════════════════════
     6. PULL — n8n → localStorage
  ══════════════════════════════════════════════ */

  async function pullFromCloud() {
    if (!isCloudReady()) return false;

    _updateSyncBadge('syncing');
    try {
      const data = await _n8nGet('crm-pull');  // → /api/crm-pull

      if (!data || !(data.leads || []).length) {
        _log('Nuvem vazia — mantendo dados locais.', 'ok');
        return false;
      }

      _applyPullResponse(data);
      if (typeof window._saveAll === 'function') window._saveAll();

      _log(`☁️ Dados carregados da nuvem (${data.leads.length} leads).`, 'ok');
      return true;
    } catch (err) {
      _log(`❌ Pull falhou: ${err.message} — usando dados locais.`, 'error');
      return false;
    }
  }

  /* ══════════════════════════════════════════════
     7. DEBOUNCE + HOOK NO _saveAll
  ══════════════════════════════════════════════ */

  function scheduleSync() {
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(pushToCloud, DEBOUNCE_MS);
  }

  function _hookSaveAll() {
    const originalSave = window._saveAll;
    if (typeof originalSave !== 'function') return;
    window._saveAll = function () {
      originalSave();
      scheduleSync();
    };
  }

  /* ══════════════════════════════════════════════
     8. UI — Modal de Configuração
  ══════════════════════════════════════════════ */

  function _injectSyncUI() {
    const headerRight = document.querySelector('.header-right') || document.body;
    const badge = document.createElement('span');
    badge.id        = 'sync-status-badge';
    badge.className = 'sync-badge sync-dis';
    badge.textContent = '💾 Apenas local';
    badge.title     = 'Clique para configurar sincronização cloud';
    badge.style.cssText = [
      'display:inline-flex;align-items:center;gap:4px',
      'padding:3px 10px;border-radius:50px',
      'font-size:10px;font-weight:700;cursor:pointer',
      'background:var(--cream-d,#EBE5D8);color:var(--txt-s,#888)',
      'transition:all .2s;flex-shrink:0',
    ].join(';');
    badge.onclick = openSyncModal;
    headerRight.appendChild(badge);

    const modal = document.createElement('div');
    modal.id = 'sync-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;background:rgba(40,32,20,.4);z-index:9999',
      'display:none;align-items:center;justify-content:center',
    ].join(';');
    modal.innerHTML = `
      <div style="background:var(--cream,#F5F0E8);border-radius:20px;padding:28px 28px 24px;width:min(440px,94vw);box-shadow:0 12px 48px rgba(0,0,0,.18);font-family:inherit">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <div style="font-size:15px;font-weight:800;color:var(--txt,#2D2416)">☁️ Sincronização Cloud (n8n)</div>
          <button onclick="document.getElementById('sync-modal').style.display='none'"
            style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--txt-s,#888)">✕</button>
        </div>
        <p style="font-size:11px;color:var(--txt-s,#888);margin:0 0 16px;line-height:1.6">
          Cole a URL do seu projeto na <strong>Vercel</strong>.<br>
          Ex: <code>https://ugc-mestre-crm.vercel.app</code>
        </p>
        <label style="font-size:10px;font-weight:700;color:var(--txt-s,#888);text-transform:uppercase;letter-spacing:.06em">URL da Vercel</label>
        <input id="sync-url-inp" placeholder="https://ugc-mestre-crm.vercel.app"
          style="width:100%;box-sizing:border-box;margin:4px 0 18px;padding:9px 12px;border:none;border-radius:10px;background:var(--cream-d,#EBE5D8);font-size:12px;font-family:inherit;outline:none;box-shadow:inset 0 2px 6px rgba(0,0,0,.08)"/>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button onclick="CRMSync.saveConfig()"
            style="flex:1;padding:10px;border:none;border-radius:12px;background:var(--blue-d,#3A6BC4);color:#fff;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">
            💾 Salvar e Conectar
          </button>
          <button onclick="CRMSync.testConnection()"
            style="flex:1;padding:10px;border:none;border-radius:12px;background:var(--cream-dd,#D8CEBC);color:var(--txt,#2D2416);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">
            🔌 Testar Conexão
          </button>
        </div>
        <button onclick="CRMSync.pushNow()" id="sync-push-btn"
          style="width:100%;margin-top:8px;padding:10px;border:none;border-radius:12px;background:var(--mint-d,#2EA87A);color:#fff;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">
          📤 Enviar Dados Locais para Nuvem Agora
        </button>
        <button onclick="CRMSync.pullNow()" id="sync-pull-btn"
          style="width:100%;margin-top:8px;padding:10px;border:none;border-radius:12px;background:var(--cream-dd,#D8CEBC);color:var(--txt,#2D2416);font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">
          📥 Carregar Dados da Nuvem (substitui local)
        </button>
        <div id="sync-modal-log" style="margin-top:14px;font-size:10px;color:var(--txt-s,#888);max-height:80px;overflow-y:auto;background:var(--cream-d,#EBE5D8);border-radius:8px;padding:8px 10px;line-height:1.6"></div>
      </div>`;
    document.body.appendChild(modal);

    const cfg = getConfig();
    if (cfg.n8nUrl) document.getElementById('sync-url-inp').value = cfg.n8nUrl;
  }

  function openSyncModal() {
    const m = document.getElementById('sync-modal');
    if (!m) return;
    try {
      const log = JSON.parse(localStorage.getItem(SYNC_LOG) || '[]');
      document.getElementById('sync-modal-log').innerHTML =
        log.slice(0, 8).map(e => `<div>${e.ts.substring(11,19)} — ${e.msg}</div>`).join('');
    } catch {}
    m.style.display = 'flex';
  }

  /* ══════════════════════════════════════════════
     9. API PÚBLICA (window.CRMSync)
  ══════════════════════════════════════════════ */

  window.CRMSync = {
    saveConfig() {
      const url = (document.getElementById('sync-url-inp')?.value || '').trim().replace(/\/$/, '');
      if (!url) { alert('Cole a URL do n8n.'); return; }
      setConfig({ n8nUrl: url, enabled: true });
      this.testConnection();
    },

    async testConnection() {
      const log = document.getElementById('sync-modal-log');
      if (log) log.textContent = 'Testando conexão com n8n…';
      try {
        const res = await fetch(`${getConfig().n8nUrl.replace(/\/$/, '')}/api/crm-pull`);
        if (res.ok) {
          const msg = '✅ Vercel API respondeu! Conexão OK.';
          if (log) log.textContent = msg;
          _log(msg, 'ok');
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (e) {
        const msg = `❌ Falha: ${e.message}`;
        if (log) log.textContent = msg;
        _log(msg, 'error');
      }
    },

    async pushNow() {
      const btn = document.getElementById('sync-push-btn');
      btn.textContent = '⏳ Enviando…';
      await pushToCloud();
      btn.textContent = '📤 Enviar Dados Locais para Nuvem Agora';
    },

    async pullNow() {
      if (!confirm('Isso vai SUBSTITUIR os dados locais pelos dados da nuvem. Continuar?')) return;
      const btn = document.getElementById('sync-pull-btn');
      btn.textContent = '⏳ Carregando…';
      const ok = await pullFromCloud();
      btn.textContent = '📥 Carregar Dados da Nuvem (substitui local)';
      if (ok) {
        alert('✅ Dados carregados da nuvem. A página será recarregada.');
        window.location.reload();
      }
    },

    getLog() { return JSON.parse(localStorage.getItem(SYNC_LOG) || '[]'); },

    disable() {
      const cfg = getConfig();
      cfg.enabled = false;
      setConfig(cfg);
      _updateSyncBadge('disabled');
    },
  };

  /* ══════════════════════════════════════════════
     10. INICIALIZAÇÃO
  ══════════════════════════════════════════════ */

  const DEFAULT_VERCEL_URL = 'https://ugc-mestre-crm.vercel.app';

  function _ensureDefaultConfig() {
    const cfg = getConfig();
    if (!cfg.n8nUrl) {
      // Primeira vez: configura URL padrão com sync ativo
      setConfig({ n8nUrl: DEFAULT_VERCEL_URL, enabled: true });
    } else if (cfg.n8nUrl === DEFAULT_VERCEL_URL && !cfg.enabled) {
      // URL é a Vercel de produção mas sync estava desligado: reativa
      setConfig({ n8nUrl: DEFAULT_VERCEL_URL, enabled: true });
    }
  }

  function init() {
    _ensureDefaultConfig();
    _injectSyncUI();
    _hookSaveAll();

    window.addEventListener('online',  () => { _log('🌐 Conexão restaurada.', 'ok');      scheduleSync(); });
    window.addEventListener('offline', () => { _log('📴 Sem conexão.',        'offline'); });

    if (!isCloudReady()) { _updateSyncBadge('disabled'); return; }

    pullFromCloud().then(pulled => {
      if (pulled && typeof window.renderVisaoGeral === 'function') {
        window.renderVisaoGeral();
        if (typeof window.updateBadges === 'function') window.updateBadges();
        if (typeof window.renderPage    === 'function') window.renderPage(window.currentPage);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 200));
  } else {
    setTimeout(init, 200);
  }

})();
