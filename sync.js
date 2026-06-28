/* ══════════════════════════════════════════════════════════════════════════════
   UGC Mestre CRM — Módulo de Sincronização Cloud (sync.js)
   Estratégia: localStorage como fonte primária (offline-first).
               Cloud (Supabase REST API) como backup persistente e multi-device.
   Injeção: <script src="sync.js"></script> antes do </body> no index.html.
══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Chave de configuração no localStorage ── */
  const CONFIG_KEY  = 'crm_cloud_config';
  const SYNC_LOG    = 'crm_sync_log';
  const DEBOUNCE_MS = 2000;   /* 2 s após o último _scheduleSave */

  /* ── Estado interno ── */
  let _syncTimer   = null;
  let _isSyncing   = false;
  let _pendingSync = false;

  /* ══════════════════════════════════════════════
     1. CONFIGURAÇÃO
  ══════════════════════════════════════════════ */

  /**
   * Retorna a config de cloud salva no localStorage.
   * Formato: { supabaseUrl, apiKey, enabled }
   */
  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    } catch { return {}; }
  }

  /** Salva a configuração de conexão cloud. */
  function setConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    _log('⚙️ Config atualizada.', cfg.supabaseUrl ? 'conectado' : 'desconectado');
  }

  /** Retorna true se a sync está habilitada e configurada. */
  function isCloudReady() {
    const cfg = getConfig();
    return !!(cfg.enabled && cfg.supabaseUrl && cfg.apiKey && navigator.onLine);
  }

  /* ══════════════════════════════════════════════
     2. LOG
  ══════════════════════════════════════════════ */

  function _log(msg, status) {
    const entry = { ts: new Date().toISOString(), msg, status: status || 'info' };
    try {
      const log = JSON.parse(localStorage.getItem(SYNC_LOG) || '[]');
      log.unshift(entry);
      if (log.length > 50) log.length = 50;   /* mantém últimas 50 entradas */
      localStorage.setItem(SYNC_LOG, JSON.stringify(log));
    } catch {}
    console.log(`[CRM Sync] ${msg}`);
    _updateSyncBadge(status);
  }

  function _updateSyncBadge(status) {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;
    const states = {
      ok:          { txt: '☁️ Salvo na nuvem', cls: 'sync-ok'    },
      syncing:     { txt: '🔄 Sincronizando…', cls: 'sync-ing'   },
      offline:     { txt: '📴 Offline — local', cls: 'sync-off'  },
      error:       { txt: '⚠️ Erro de sync',   cls: 'sync-err'   },
      disabled:    { txt: '💾 Apenas local',    cls: 'sync-dis'   },
      info:        { txt: '',                   cls: ''            },
    };
    const s = states[status] || states.info;
    badge.textContent = s.txt;
    badge.className   = `sync-badge ${s.cls}`;
    badge.style.display = s.txt ? '' : 'none';
  }

  /* ══════════════════════════════════════════════
     3. HTTP — SUPABASE REST API
  ══════════════════════════════════════════════ */

  function _headers() {
    const { apiKey } = getConfig();
    return {
      'Content-Type':  'application/json',
      'apikey':        apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    };
  }

  /** UPSERT em lote numa tabela Supabase via REST */
  async function _upsert(table, rows) {
    const { supabaseUrl } = getConfig();
    if (!rows || !rows.length) return;
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify(rows),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`[${table}] ${res.status}: ${err.substring(0, 200)}`);
    }
  }

  /** SELECT * de uma tabela */
  async function _select(table, params) {
    const { supabaseUrl } = getConfig();
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}${qs}`, {
      headers: { ..._headers(), 'Prefer': '' },
    });
    if (!res.ok) throw new Error(`[${table}] ${res.status}`);
    return res.json();
  }

  /* ══════════════════════════════════════════════
     4. ADAPTADORES DE FORMATO
     (CRM interno → linhas SQL e vice-versa)
  ══════════════════════════════════════════════ */

  function _leadToRow(l) {
    return {
      id:               l.id,
      nome:             l.nome,
      seg:              l.seg            || null,
      insta:            l.insta          || null,
      site:             l.site           || null,
      canal:            l.canal          || null,
      pot:              l.pot            || null,
      capital:          l.capital        || null,
      valor:            l.valor          || null,
      agent:            l.agent          || null,
      tags:             l.tags           || [],
      seguidores:       l.seguidores     || null,
      engajamento:      l.engajamento    || null,
      just:             l.just           || null,
      garg:             l.garg           || null,
      insight:          l.insight        || null,
      contatos:         JSON.stringify(l.contatos        || []),
      stage:            l.stage          || 'prelista',
      tabs:             l.tabs           || [l.stage],
      escopo:           l.escopo         || ['ugc'],
      status_flags:     l.statusFlags    || [],
      data_captacao:    l.dataCaptacao   || null,
      proxima_acao:     l.proximaAcao    || null,
      retomar_contato:  l.retomarContato || null,
      cadencia_pausada: l.cadenciaPausada || false,
      agent_note:       l.agentNote      || null,
      sazonal_note:     l.sazonalNote    || null,
      inicio_cadencia:  l.inicioCadencia || null,
      ag2_status:       l.ag2Status      || null,
      ag2_reasoning:    JSON.stringify(l.ag2Reasoning    || {}),
      order_history:    JSON.stringify(l.orderHistory    || []),
    };
  }

  function _rowToLead(row) {
    return {
      id:               row.id,
      nome:             row.nome,
      seg:              row.seg,
      insta:            row.insta,
      site:             row.site,
      canal:            row.canal,
      pot:              row.pot,
      capital:          row.capital,
      valor:            row.valor,
      agent:            row.agent,
      tags:             row.tags           || [],
      seguidores:       row.seguidores,
      engajamento:      row.engajamento,
      just:             row.just,
      garg:             row.garg,
      insight:          row.insight,
      contatos:         _parseJ(row.contatos, []),
      stage:            row.stage,
      tabs:             row.tabs           || [row.stage],
      escopo:           row.escopo         || ['ugc'],
      statusFlags:      row.status_flags   || [],
      dataCaptacao:     row.data_captacao,
      proximaAcao:      row.proxima_acao,
      retomarContato:   row.retomar_contato,
      cadenciaPausada:  row.cadencia_pausada || false,
      agentNote:        row.agent_note,
      sazonalNote:      row.sazonal_note,
      inicioCadencia:   row.inicio_cadencia,
      ag2Status:        row.ag2_status,
      ag2Reasoning:     _parseJ(row.ag2_reasoning, {}),
      orderHistory:     _parseJ(row.order_history, []),
    };
  }

  function _etapaToRow(leadId, e) {
    return {
      id:        e.id,
      lead_id:   leadId,
      et:        e.et,
      titulo:    e.titulo    || '',
      canal:     e.canal     || 'instagram',
      data:      e.data      || null,
      status:    e.status    || 'pendente',
      roteiro:   e.roteiro   || null,
      motivo:    e.motivo    || null,
      occ:       e.occ       || null,
      locked:    e.locked    || false,
    };
  }

  function _rowToEtapa(row) {
    return {
      id:      row.id,
      et:      row.et,
      titulo:  row.titulo,
      canal:   row.canal,
      data:    row.data,
      status:  row.status,
      roteiro: row.roteiro,
      motivo:  row.motivo,
      occ:     row.occ,
      locked:  row.locked,
    };
  }

  function _parseJ(val, fallback) {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return fallback; }
  }

  /* ══════════════════════════════════════════════
     5. PUSH — localStorage → Supabase
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
      /* Acessa as variáveis globais do CRM */
      const leads    = window.Leads_Geral    || [];
      const cadencia = window.Cadencia       || {};
      const intera   = window.Interacoes     || {};
      const clientes = window.Clientes_Ativos || [];
      const calls    = window.CallsAgendadas  || [];

      /* 5a. Leads */
      if (leads.length) {
        await _upsert('leads', leads.map(_leadToRow));
      }

      /* 5b. Etapas de cadência (todas as etapas de todos os leads) */
      const etapasRows = [];
      Object.entries(cadencia).forEach(([leadId, etapas]) => {
        (etapas || []).forEach(e => etapasRows.push(_etapaToRow(Number(leadId), e)));
      });
      if (etapasRows.length) await _upsert('cadencia_etapas', etapasRows);

      /* 5c. Interações */
      const interRows = [];
      Object.entries(intera).forEach(([leadId, lista]) => {
        (lista || []).forEach(i => interRows.push({
          id:       i.id,
          lead_id:  Number(leadId),
          tipo:     i.tipo,
          canal:    i.canal || null,
          data:     i.data  || null,
          texto:    i.texto || '',
          aprovado: i.aprovado || false,
        }));
      });
      if (interRows.length) await _upsert('interacoes', interRows);

      /* 5d. Clientes ativos */
      if (clientes.length) {
        const rows = clientes.map(c => ({
          id:            c.id,
          nome:          c.nome,
          seg:           c.seg            || null,
          escopo:        c.escopo         || ['ugc'],
          status:        c.status         || 'ativo',
          inicio:        c.inicio         || null,
          pacote:        c.pacote         || null,
          valor_pacote:  c.valorPacote    || null,
          link_contrato: c.linkContrato   || null,
          entregaveis:   c.entregaveis    || null,
          contatos:      JSON.stringify(c.contatos  || []),
          historico:     JSON.stringify(c.historico || []),
        }));
        await _upsert('clientes_ativos', rows);
      }

      /* 5e. Calls agendadas */
      if (calls.length) {
        const rows = calls.map(c => ({
          id:       c.id,
          lead_id:  c.leadId || null,
          nome:     c.nome,
          data:     c.data,
          hora:     c.hora    || null,
          canal:    c.canal   || null,
          intuito:  c.intuito || null,
          status:   c.status  || 'agendado',
        }));
        await _upsert('calls_agendadas', rows);
      }

      /* 5f. Estado global */
      await _upsert('crm_global_state', [{
        id:                 1,
        nicho_custom:       JSON.stringify(window._nichoCustom      || {}),
        pl_checked:         JSON.stringify(window.plChecked          || {}),
        pl_lead_comments:   JSON.stringify(window.plLeadComments     || {}),
        pl_global_cmd_text: window.plGlobalCmdText  || '',
        aprov_master_text:  window.aprovMasterText  || '',
        aprov_etapa_cmd:    JSON.stringify(window.aprovEtapaCmd      || {}),
        aprov_reprocess:    JSON.stringify(window.aprovReprocess     || {}),
      }]);

      _log('✅ Sincronização completa com a nuvem.', 'ok');

    } catch (err) {
      _log(`❌ Erro ao sincronizar: ${err.message}`, 'error');
    } finally {
      _isSyncing = false;
      if (_pendingSync) { _pendingSync = false; scheduleSync(); }
    }
  }

  /* ══════════════════════════════════════════════
     6. PULL — Supabase → localStorage (na inicialização)
  ══════════════════════════════════════════════ */

  async function pullFromCloud() {
    if (!isCloudReady()) return false;

    _updateSyncBadge('syncing');
    try {
      /* Verifica se a nuvem tem dados mais recentes que o localStorage */
      const [cloudLeads, cloudEtapas, cloudIntera, cloudClientes, cloudCalls, cloudState] =
        await Promise.all([
          _select('leads',           { select: '*', order: 'id.asc' }),
          _select('cadencia_etapas', { select: '*', order: 'lead_id.asc,et.asc' }),
          _select('interacoes',      { select: '*' }),
          _select('clientes_ativos', { select: '*' }),
          _select('calls_agendadas', { select: '*' }),
          _select('crm_global_state',{ select: '*' }),
        ]);

      if (!cloudLeads.length) {
        _log('Nuvem vazia — mantendo dados locais.', 'ok');
        return false;
      }

      /* Reconstrução: transforma linhas DB → objetos internos do CRM */
      window.Leads_Geral     = cloudLeads.map(_rowToLead);
      window.Clientes_Ativos = cloudClientes;
      window.CallsAgendadas  = cloudCalls.map(c => ({
        id: c.id, leadId: c.lead_id, nome: c.nome, data: c.data,
        hora: c.hora, canal: c.canal, intuito: c.intuito, status: c.status,
      }));

      /* Cadência: reagrupa por lead_id */
      window.Cadencia = {};
      cloudEtapas.forEach(row => {
        const lid = row.lead_id;
        if (!window.Cadencia[lid]) window.Cadencia[lid] = [];
        window.Cadencia[lid].push(_rowToEtapa(row));
      });

      /* Interações: reagrupa por lead_id */
      window.Interacoes = {};
      cloudIntera.forEach(row => {
        const lid = row.lead_id;
        if (!window.Interacoes[lid]) window.Interacoes[lid] = [];
        window.Interacoes[lid].push({
          id: row.id, tipo: row.tipo, canal: row.canal,
          data: row.data, texto: row.texto, aprovado: row.aprovado,
        });
      });

      /* Estado global */
      if (cloudState && cloudState[0]) {
        const s = cloudState[0];
        if (s.nicho_custom)      Object.assign(window._nichoCustom    || {}, _parseJ(s.nicho_custom, {}));
        if (s.pl_checked)        window.plChecked         = _parseJ(s.pl_checked, {});
        if (s.pl_lead_comments)  window.plLeadComments    = _parseJ(s.pl_lead_comments, {});
        if (s.pl_global_cmd_text !== undefined) window.plGlobalCmdText = s.pl_global_cmd_text;
        if (s.aprov_master_text  !== undefined) window.aprovMasterText  = s.aprov_master_text;
        if (s.aprov_etapa_cmd)   window.aprovEtapaCmd     = _parseJ(s.aprov_etapa_cmd, {});
        if (s.aprov_reprocess)   window.aprovReprocess    = _parseJ(s.aprov_reprocess, {});
      }

      /* Persiste no localStorage para funcionar offline */
      if (typeof window._saveAll === 'function') window._saveAll();

      _log(`☁️ Dados carregados da nuvem (${cloudLeads.length} leads).`, 'ok');
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

  /**
   * Intercepta o _saveAll original do CRM para disparar a sync cloud
   * depois de cada salvamento no localStorage.
   */
  function _hookSaveAll() {
    const originalSave = window._saveAll;
    if (typeof originalSave !== 'function') return;

    window._saveAll = function () {
      originalSave();          /* salva no localStorage normalmente */
      scheduleSync();          /* agenda push para a nuvem */
    };
  }

  /* ══════════════════════════════════════════════
     8. UI — Modal de Configuração Cloud
  ══════════════════════════════════════════════ */

  function _injectSyncUI() {
    /* Badge de status no header */
    const header = document.querySelector('.header') || document.body;
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
    const headerRight = document.querySelector('.header-right') || header;
    headerRight.appendChild(badge);

    /* Modal */
    const modal = document.createElement('div');
    modal.id = 'sync-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;background:rgba(40,32,20,.4);z-index:9999',
      'display:none;align-items:center;justify-content:center',
    ].join(';');
    modal.innerHTML = `
      <div style="background:var(--cream,#F5F0E8);border-radius:20px;padding:28px 28px 24px;width:min(420px,94vw);box-shadow:0 12px 48px rgba(0,0,0,.18);font-family:inherit">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <div style="font-size:15px;font-weight:800;color:var(--txt,#2D2416)">☁️ Sincronização Cloud</div>
          <button onclick="document.getElementById('sync-modal').style.display='none'"
            style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--txt-s,#888)">✕</button>
        </div>
        <p style="font-size:11px;color:var(--txt-s,#888);margin:0 0 16px;line-height:1.6">
          Cole as credenciais do seu projeto <strong>Supabase</strong>.
          Os dados ficam criptografados e só você tem acesso.
        </p>
        <label style="font-size:10px;font-weight:700;color:var(--txt-s,#888);text-transform:uppercase;letter-spacing:.06em">URL do Projeto (Project URL)</label>
        <input id="sync-url-inp" placeholder="https://xxxxxxxxxxxx.supabase.co"
          style="width:100%;box-sizing:border-box;margin:4px 0 12px;padding:9px 12px;border:none;border-radius:10px;background:var(--cream-d,#EBE5D8);font-size:12px;font-family:inherit;outline:none;box-shadow:inset 0 2px 6px rgba(0,0,0,.08)"/>
        <label style="font-size:10px;font-weight:700;color:var(--txt-s,#888);text-transform:uppercase;letter-spacing:.06em">Anon Key (chave pública)</label>
        <input id="sync-key-inp" placeholder="eyJhbGciOiJ..." type="password"
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

    /* Preenche inputs com config existente */
    const cfg = getConfig();
    if (cfg.supabaseUrl) document.getElementById('sync-url-inp').value = cfg.supabaseUrl;
    if (cfg.apiKey)      document.getElementById('sync-key-inp').value = cfg.apiKey;
  }

  function openSyncModal() {
    const m = document.getElementById('sync-modal');
    if (!m) return;
    /* Atualiza log no modal */
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
    /** Salva a config e testa a conexão */
    saveConfig() {
      const url = (document.getElementById('sync-url-inp')?.value || '').trim().replace(/\/$/, '');
      const key = (document.getElementById('sync-key-inp')?.value || '').trim();
      if (!url || !key) { alert('Preencha a URL e a Anon Key do Supabase.'); return; }
      setConfig({ supabaseUrl: url, apiKey: key, enabled: true });
      this.testConnection();
    },

    async testConnection() {
      const log = document.getElementById('sync-modal-log');
      if (log) log.textContent = 'Testando conexão…';
      try {
        const rows = await _select('crm_global_state', { select: 'id', limit: 1 });
        const msg = rows !== undefined ? '✅ Conexão OK! Banco acessível.' : '⚠️ Tabelas não encontradas — rode o init_db.sql.';
        if (log) log.textContent = msg;
        _log(msg, 'ok');
      } catch (e) {
        const msg = `❌ Falha: ${e.message}`;
        if (log) log.textContent = msg;
        _log(msg, 'error');
      }
    },

    /** Dispara push manual imediato */
    async pushNow() {
      document.getElementById('sync-push-btn').textContent = '⏳ Enviando…';
      await pushToCloud();
      document.getElementById('sync-push-btn').textContent = '📤 Enviar Dados Locais para Nuvem Agora';
    },

    /** Dispara pull manual e recarrega o CRM */
    async pullNow() {
      if (!confirm('Isso vai SUBSTITUIR os dados locais pelos dados da nuvem. Continuar?')) return;
      document.getElementById('sync-pull-btn').textContent = '⏳ Carregando…';
      const ok = await pullFromCloud();
      document.getElementById('sync-pull-btn').textContent = '📥 Carregar Dados da Nuvem (substitui local)';
      if (ok) {
        alert('✅ Dados carregados da nuvem. A página será recarregada.');
        window.location.reload();
      }
    },

    /** Retorna o log de sincronização */
    getLog() {
      return JSON.parse(localStorage.getItem(SYNC_LOG) || '[]');
    },

    /** Desativa a sincronização cloud */
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

  function init() {
    _injectSyncUI();
    _hookSaveAll();

    /* Monitoramento de conectividade */
    window.addEventListener('online',  () => { _log('🌐 Conexão restaurada.', 'ok');      scheduleSync(); });
    window.addEventListener('offline', () => { _log('📴 Sem conexão.',        'offline'); });

    if (!isCloudReady()) {
      _updateSyncBadge('disabled');
      return;
    }

    /* Pull na inicialização se a nuvem estiver configurada */
    pullFromCloud().then(pulled => {
      if (pulled && typeof window.renderVisaoGeral === 'function') {
        window.renderVisaoGeral();
        if (typeof window.updateBadges === 'function') window.updateBadges();
      }
    });
  }

  /* Aguarda o DOM + scripts do CRM estarem prontos */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 200));
  } else {
    setTimeout(init, 200);
  }

})();
