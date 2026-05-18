# Deploy na Vercel

## O que já está pronto

- `vercel.json` com:
  - `/` abrindo `captacao.html`
  - `/gestao` abrindo `captacao-gestao.html`
  - rotas amigáveis para login, trilha e admin
  - cache longo para assets
  - HTML com revalidação

## Ordem segura para publicar a trilha de Gestão

1. Rode `supabase/capture_lead.sql` no Supabase de produção.
   - Esse script adiciona `nome_trilha` e atualiza a função `capture_lead`.
   - O frontend novo já envia `p_nome_trilha`; se publicar o frontend antes do SQL, o cadastro pode falhar.
2. Faça deploy das Edge Functions alteradas:
   - `activecampaign-sync-lead`
   - `ploomes-sync-lead`
   - `qualified-lead-tracking`
3. Configure os secrets novos da Edge Function de ActiveCampaign:
   - `ACTIVECAMPAIGN_GESTAO_LIST_ID` ou uma lista com o nome de `ACTIVECAMPAIGN_GESTAO_LIST_NAME`
   - `ACTIVECAMPAIGN_TRAIL_FIELD_ID`, se quiser gravar a trilha em um campo customizado do contato
4. Depois disso, publique o frontend na Vercel.

## Como subir

1. Entre na conta correta da Vercel:

```bash
vercel logout
vercel login
```

2. Importe o repositório `brunojuvencio/trilhasfundace` na Vercel.

3. Na importação:
  - Framework Preset: `Other`
  - Root Directory: `.`
  - Build Command: deixe vazio
  - Output Directory: deixe vazio

## Rotas esperadas

- `/` -> landing de captação
- `/captacao`
- `/gestao`
- `/login`
- `/cadastrar-senha`
- `/esqueci-senha`
- `/redefinir-senha`
- `/trilha`
- `/admin`
- `/painel-admin`

## Supabase Auth

Depois do primeiro deploy, copie a URL da Vercel e cadastre no Supabase:

1. `Authentication -> URL Configuration`
2. Adicione a URL do site em `Site URL`
3. Adicione também em `Redirect URLs`:

```text
https://SEU-DOMINIO.vercel.app/redefinir-senha.html
https://SEU-DOMINIO.vercel.app/redefinir-senha
```

Se usar domínio próprio, repita com o domínio final.

## Variáveis de ambiente

No modelo atual, o frontend usa `supabase/config.js`, então:

- `SUPABASE_URL` e `SUPABASE_ANON_KEY` já estão no código do cliente
- `SUPABASE_SERVICE_ROLE_KEY` não deve ir para a Vercel para esse site estático

Essa chave continua sendo usada no Supabase Edge Function `admin-user-manager`, não no frontend hospedado na Vercel.

## Importante

- Sempre que mudar `supabase/config.js`, faça novo commit e novo deploy
- Sempre que mudar SQL no Supabase, rode a migration no painel antes de testar a interface
- A edge function de admin continua sendo deployada pelo Supabase, não pela Vercel
