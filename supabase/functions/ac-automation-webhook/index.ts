import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Recebe o webhook disparado pela automação "TRILHA MKT" do ActiveCampaign
// logo depois de CADA e-mail ser enviado, move o lead pra etapa "Em
// automação de e-mail" no painel SDR (se ainda não estiver lá) e marca a
// nutrição correspondente (via "step") como concluída.
//
// Configuração no ActiveCampaign: um bloco de automação "Webhook" logo após
// CADA bloco de envio de e-mail, um "step" por e-mail (1 a 5, na ordem):
//   1 = TRILHA MKT 0, 2 = TRILHA MKT 1, 3 = QUIZ MKTEST TRILHA,
//   4 = TRILHA MKT 3, 5 = MKTEST TRILHA 4
//   URL: https://<project>.supabase.co/functions/v1/ac-automation-webhook?secret=<AC_WEBHOOK_SECRET>&email=%EMAIL%&step=<N>
//   Método: GET ou POST (aceita os dois)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const webhookSecret = Deno.env.get("AC_WEBHOOK_SECRET") ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

if (!webhookSecret) {
  throw new Error("AC_WEBHOOK_SECRET é obrigatório.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function extractEmail(request: Request, url: URL): Promise<string> {
  const fromQuery = url.searchParams.get("email");
  if (fromQuery) return fromQuery;

  // Fallback: caso o AC mande o e-mail no corpo (form-encoded ou JSON) em
  // vez de na URL.
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      return String(body?.email ?? body?.contact?.email ?? "");
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      return params.get("email") ?? params.get("contact[email]") ?? "";
    }
  } catch {
    // corpo vazio ou ilegível — segue sem e-mail, tratado abaixo
  }
  return "";
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(request.url);

  if (url.searchParams.get("secret") !== webhookSecret) {
    return json({ error: "Acesso negado." }, 403);
  }

  const email = (await extractEmail(request, url)).trim().toLowerCase();
  if (!email) {
    return json({ error: "E-mail não informado." }, 400);
  }

  const stepParam = url.searchParams.get("step");
  const step = stepParam ? Number(stepParam) : null;

  const { error } = await adminClient.rpc("mark_sdr_lead_entered_email_automation", {
    p_lead_email: email,
    p_step: Number.isFinite(step) ? step : null,
  });

  if (error) {
    console.error(`[ac-automation-webhook] Erro ao mover ${email} pra automação:`, error.message);
    return json({ error: error.message }, 400);
  }

  console.info(`[ac-automation-webhook] Lead ${email} movido pra "Em automação de e-mail".`);
  return json({ ok: true });
});
