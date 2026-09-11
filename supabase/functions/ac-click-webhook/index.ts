import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Recebe o evento de clique de link do ActiveCampaign (webhook de conta,
// evento "click", form-urlencoded). Registra o clique pra pontuação de
// prioridade de abordagem quando o link clicado for de um dos 5 e-mails da
// automação "TRILHA MKT" — outras campanhas são ignoradas silenciosamente.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const rawText = await request.text();
    let fields: Record<string, string> = {};

    if (contentType.includes("application/x-www-form-urlencoded")) {
      fields = Object.fromEntries(new URLSearchParams(rawText).entries());
    } else if (contentType.includes("application/json")) {
      const body = JSON.parse(rawText || "{}");
      fields = body as Record<string, string>;
    }

    const type = fields["type"];
    const email = (fields["contact[email]"] ?? "").trim().toLowerCase();
    const campaignId = Number(fields["campaign[id]"]);

    if (type !== "click" || !email || !Number.isFinite(campaignId)) {
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error } = await adminClient.rpc("record_sdr_email_link_click", {
      p_lead_email: email,
      p_campaign_id: campaignId,
    });

    if (error) {
      console.error(`[ac-click-webhook] Erro ao registrar clique de ${email}:`, error.message);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[ac-click-webhook] Erro inesperado:", error);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
