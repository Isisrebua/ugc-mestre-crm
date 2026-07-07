# Configurar o Agente 1 no claude.ai — Passo a Passo

## Passo 1 — Criar o Project

1. Acesse **claude.ai**
2. No menu lateral esquerdo, clique em **"Projects"**
3. Clique em **"+ New project"**
4. Nome sugerido: `🤖 Agente 1 — Caçador UGC Mestre`

---

## Passo 2 — Colar o System Prompt

1. Dentro do Project, clique em **"Edit project"** (ícone de lápis ou engrenagem)
2. No campo **"Project instructions"**, cole o conteúdo do arquivo `agent1-system-prompt.md`
3. Salve

---

## Passo 3 — Adicionar a integração (ferramenta)

1. Ainda em "Edit project", clique na aba **"Integrations"** (ou "Tools" / "Custom integrations")
2. Clique em **"Add integration"** ou **"Connect API"**
3. Selecione **"Custom OpenAPI"** ou **"Add tool from schema"**
4. Cole o conteúdo do arquivo `agent1-openapi.json`
5. No campo de autenticação, informe:
   - **Header name:** `X-Hunter-Secret`
   - **Value:** `Lucyrebua2@`
6. Confirme e salve

---

## Passo 4 — Testar

Na conversa do Project, escreva:
```
Busca 10 contas de skincare natural no Instagram para teste
```

O Agente deve disparar automaticamente e responder com o runId e o link do Apify.

---

## Fluxo completo após configuração

```
Ísis digita no claude.ai Project
        ↓
Agente 1 chama dispararMineracaoLeads
        ↓ (POST /api/agent1-hunt · Vercel)
Apify minera (Instagram / Google Maps / LinkedIn)
        ↓ (webhook automático ao terminar)
POST /api/apify-webhook · dedup no PostgreSQL
        ↓
Leads entram na Pré-Lista do CRM ✅
        ↓
Ísis faz gestão em lote no CRM
  → Aprova → vai para Qualificados
  → Escreve instrução → /api/agent1-think → nova mineração
```

---

## Resolução de problemas

| Erro | Causa | Solução |
|------|-------|---------|
| 401 Unauthorized | Header X-Hunter-Secret errado | Confirme o valor `Lucyrebua2@` nas configurações da ferramenta |
| 500 APIFY_TOKEN não configurado | Variável não está na Vercel | Adicione APIFY_TOKEN no painel da Vercel |
| Ferramenta não aparece | claude.ai ainda não liberou integrations para o plano | Use o System Prompt com instruções de curl como fallback |
| Leads não aparecem no CRM | PWA com cache antigo | Clique "🔄 Sincronizar" no CRM |
