import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// "Funil Comercial" no Ploomes (confirmado via /DealsPipelines em 2026-09-01) —
// funil do time de vendas, diferente do "Trilhas - COMUNICAÇÃO" usado pelo SDR.
const COMMERCIAL_PIPELINE_ID = Number(Deno.env.get("PLOOMES_COMMERCIAL_PIPELINE_ID") ?? "10002245");

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ploomesUserKey = Deno.env.get("PLOOMES_API_KEY") ?? "";
const ploomesBaseUrl = (Deno.env.get("PLOOMES_BASE_URL") ?? "https://public-api2.ploomes.com").replace(/\/+$/, "");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Payload = {
  trailSlug?: string;
  triggerType?: string;
  email?: string;
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  return (value ?? "").replace(/\D/g, "");
}

async function isAdmin(authHeader: string | null) {
  const token = authHeader?.replace("Bearer ", "").trim();
  if (!token) return false;

  const { data: userData, error } = await adminClient.auth.getUser(token);
  if (error || !userData.user?.email) return false;

  const { data: adminRow } = await adminClient
    .from("admin_users")
    .select("active")
    .eq("email", userData.user.email.toLowerCase())
    .maybeSingle();

  return Boolean(adminRow?.active);
}

async function ploomesFetch(path: string) {
  const response = await fetch(`${ploomesBaseUrl}${path}`, {
    headers: { "User-Key": ploomesUserKey, "Content-Type": "application/json" },
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

async function findContactByEmail(email: string) {
  const filter = encodeURIComponent(`Email eq '${email.replace(/'/g, "''")}'`);
  const res = await ploomesFetch(`/Contacts?$top=1&$select=${encodeURIComponent("Id,Name,Email")}&$filter=${filter}`);
  const list = Array.isArray((res.data as Record<string, unknown>).value)
    ? (res.data as Record<string, unknown>).value as Array<Record<string, unknown>>
    : [];
  return list[0] ?? null;
}

async function findContactByPhone(phone: string) {
  const digits = normalizePhone(phone);
  if (!digits) return null;

  const candidates = new Set<string>([digits]);
  if (digits.startsWith("55") && digits.length > 11) candidates.add(digits.slice(2));
  else if (!digits.startsWith("55") && digits.length <= 11) candidates.add(`55${digits}`);

  for (const num of candidates) {
    const filter = encodeURIComponent(`Phones/any(p: p/PhoneNumber eq '${num}')`);
    const res = await ploomesFetch(`/Contacts?$top=1&$select=${encodeURIComponent("Id,Name,Email")}&$filter=${filter}`);
    const list = Array.isArray((res.data as Record<string, unknown>).value)
      ? (res.data as Record<string, unknown>).value as Array<Record<string, unknown>>
      : [];
    if (list[0]) return list[0];
  }
  return null;
}

async function findCommercialDeals(contactId: number) {
  const filter = encodeURIComponent(`ContactId eq ${contactId} and PipelineId eq ${COMMERCIAL_PIPELINE_ID}`);
  const res = await ploomesFetch(
    `/Deals?$top=5&$select=${encodeURIComponent("Id,Title,StageId,StatusId")}&$expand=${encodeURIComponent("Stage")}&$filter=${filter}&$orderby=${encodeURIComponent("LastUpdateDate desc")}`
  );
  return Array.isArray((res.data as Record<string, unknown>).value)
    ? (res.data as Record<string, unknown>).value as Array<Record<string, unknown>>
    : [];
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  if (!(await isAdmin(request.headers.get("Authorization")))) {
    return json({ error: "Acesso negado." }, 403);
  }

  if (!ploomesUserKey) {
    return json({ error: "Ploomes não configurado." }, 500);
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return json({ error: "Body inválido." }, 400);
  }

  const email = normalizeEmail(payload.email ?? "");
  if (!email) {
    return json({ error: "E-mail é obrigatório." }, 400);
  }

  try {
    const { data: lead } = await adminClient
      .from("leads")
      .select("telefone")
      .eq("email", email)
      .maybeSingle();

    let contact = await findContactByEmail(email);
    let foundBy = contact ? "email" : null;

    if (!contact && lead?.telefone) {
      contact = await findContactByPhone(lead.telefone);
      if (contact) foundBy = "phone";
    }

    if (!contact) {
      return json({ existsInCommercial: false, contactFound: false, deals: [] });
    }

    const contactId = Number((contact as Record<string, unknown>).Id ?? 0);
    const deals = await findCommercialDeals(contactId);

    const status: "sim" | "nao" = deals.length > 0 ? "sim" : "nao";

    // Persiste o resultado, se veio o contexto do gatilho (trail/trigger/email).
    if (payload.trailSlug && payload.triggerType) {
      await adminClient.rpc("set_sdr_lead_ploomes_status", {
        p_trail_slug: payload.trailSlug,
        p_trigger_type: payload.triggerType,
        p_lead_email: email,
        p_status: status,
      });
    }

    return json({
      existsInCommercial: deals.length > 0,
      contactFound: true,
      foundBy,
      contactId,
      deals: deals.map(d => ({
        id: d.Id,
        titulo: d.Title,
        etapa: (d.Stage as Record<string, unknown> | undefined)?.Name ?? null,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao consultar o Ploomes.";
    console.error(`[ploomes-check-commercial] Erro: ${message}`);
    return json({ error: message }, 400);
  }
});
