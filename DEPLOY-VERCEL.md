# Deploy na Vercel

## O que já está pronto

- `vercel.json` com:
  - `/` abrindo `captacao.html`
  - rotas amigáveis para login, trilha e admin
  - cache longo para assets
  - HTML com revalidação

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
