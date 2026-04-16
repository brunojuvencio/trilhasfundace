import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Payload = {
  nome?: string;
  email?: string;
  telefone?: string;
};

type LeadRow = {
  id: number;
  nome: string;
  email: string;
  telefone: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  gclid: string | null;
  fbclid: string | null;
  landing_page_url: string | null;
  referrer_url: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const activeCampaignBaseUrl = (Deno.env.get("ACTIVECAMPAIGN_BASE_URL") ?? "").replace(/\/+$/, "");
const activeCampaignApiToken = Deno.env.get("ACTIVECAMPAIGN_API_TOKEN") ?? "";
const activeCampaignListId = (Deno.env.get("ACTIVECAMPAIGN_LIST_ID") ?? "").trim();
const activeCampaignListName = (Deno.env.get("ACTIVECAMPAIGN_LIST_NAME") ?? "Trilhaifrs").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

if (!activeCampaignBaseUrl || !activeCampaignApiToken) {
  throw new Error("ACTIVECAMPAIGN_BASE_URL e ACTIVECAMPAIGN_API_TOKEN são obrigatórios.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function splitName(nome: string) {
  const parts = nome.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

async function activeCampaignFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${activeCampaignBaseUrl}${path}`, {
    ...init,
    headers: {
      "Api-Token": activeCampaignApiToken,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let data: Record<string, unknown> = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text ? { raw: text } : {};
  }

  if (!response.ok) {
    const message =
      typeof data.message === "string"
        ? data.message
        : typeof data.error === "string"
          ? data.error
          : `ActiveCampaign respondeu ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

async function resolveListId() {
  if (activeCampaignListId) return activeCampaignListId;

  const data = await activeCampaignFetch("/api/3/lists");
  const lists = Array.isArray(data.lists) ? data.lists as Array<Record<string, unknown>> : [];
  const match = lists.find(item => {
    const name = String(item.name ?? "").trim().toLowerCase();
    return name === activeCampaignListName.toLowerCase();
  });

  const listId = String(match?.id ?? "").trim();
  if (!listId) {
    throw new Error(`Lista "${activeCampaignListName}" não encontrada no ActiveCampaign.`);
  }

  return listId;
}

async function getLeadByEmail(email: string) {
  const { data, error } = await adminClient
    .from("leads")
    .select("id,nome,email,telefone,utm_source,utm_medium,utm_campaign,utm_term,utm_content,gclid,fbclid,landing_page_url,referrer_url")
    .eq("email", email)
    .maybeSingle<LeadRow>();

  if (error) {
    throw new Error(`Falha ao carregar lead no Supabase: ${error.message}`);
  }

  if (!data) {
    throw new Error("Lead nao encontrado.");
  }

  return data;
}

async function syncContact(payload: Required<Payload>) {
  const { firstName, lastName } = splitName(payload.nome);
  const phone = normalizePhone(payload.telefone);

  const data = await activeCampaignFetch("/api/3/contact/sync", {
    method: "POST",
    body: JSON.stringify({
      contact: {
        email: payload.email,
        firstName: firstName || payload.nome,
        lastName: lastName || "",
        phone: phone || undefined,
      },
    }),
  });

  const contact = (data.contact ?? {}) as Record<string, unknown>;
  const contactId = String(contact.id ?? "").trim();
  if (!contactId) {
    throw new Error("Não foi possível identificar o contato sincronizado no ActiveCampaign.");
  }

  return contactId;
}

async function ensureListSubscription(contactId: string, listId: string) {
  const membershipData = await activeCampaignFetch(`/api/3/contacts/${contactId}/contactLists`);
  const memberships = Array.isArray(membershipData.contactLists)
    ? membershipData.contactLists as Array<Record<string, unknown>>
    : [];

  const existing = memberships.find(item => String(item.list ?? "") === listId);
  if (existing && String(existing.status ?? "") === "1") {
    return;
  }

  await activeCampaignFetch("/api/3/contactLists", {
    method: "POST",
    body: JSON.stringify({
      contactList: {
        list: listId,
        contact: contactId,
        status: 1,
      },
    }),
  });
}

async function upsertFieldValue(contactId: string, fieldId: string, value: string) {
  const normalizedValue = value.trim();
  if (!normalizedValue) return;

  const existingData = await activeCampaignFetch(`/api/3/contacts/${contactId}/fieldValues`);
  const existingValues = Array.isArray(existingData.fieldValues)
    ? existingData.fieldValues as Array<Record<string, unknown>>
    : [];

  const existing = existingValues.find(item => String(item.field ?? "") === fieldId);

  if (existing) {
    await activeCampaignFetch(`/api/3/fieldValues/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({
        fieldValue: {
          contact: contactId,
          field: fieldId,
          value: normalizedValue,
        },
      }),
    });
    return;
  }

  await activeCampaignFetch("/api/3/fieldValues", {
    method: "POST",
    body: JSON.stringify({
      fieldValue: {
        contact: contactId,
        field: fieldId,
        value: normalizedValue,
      },
    }),
  });
}

async function markLead(email: string, status: "synced" | "error", contactId?: string, listId?: string, error?: string) {
  const { error: rpcError } = await adminClient.rpc("update_lead_activecampaign_sync", {
    p_email: email,
    p_contact_id: contactId ?? null,
    p_list_id: listId ?? null,
    p_status: status,
    p_error: error ?? null,
  });

  if (rpcError) {
    throw new Error(`Falha ao atualizar lead no Supabase: ${rpcError.message}`);
  }
}

async function markLeadPending(email: string) {
  const { error: rpcError } = await adminClient.rpc("update_lead_activecampaign_sync", {
    p_email: email,
    p_contact_id: null,
    p_list_id: null,
    p_status: "pending",
    p_error: null,
  });

  if (rpcError) {
    throw new Error(`Falha ao marcar lead como pending no Supabase: ${rpcError.message}`);
  }
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return json({ error: "Body inválido." }, 400);
  }

  const nome = (payload.nome ?? "").trim();
  const email = normalizeEmail(payload.email ?? "");
  const telefone = (payload.telefone ?? "").trim();

  if (!nome || !email) {
    return json({ error: "Nome e e-mail são obrigatórios." }, 400);
  }

  try {
    console.info(`[activecampaign-sync-lead] Iniciando sincronização do lead ${email}.`);
    await markLeadPending(email);

    const lead = await getLeadByEmail(email);
    const listId = await resolveListId();
    const contactId = await syncContact({ nome, email, telefone });
    await upsertFieldValue(contactId, "22", lead.utm_source ?? "");
    await ensureListSubscription(contactId, listId);
    await markLead(email, "synced", contactId, listId);
    console.info(`[activecampaign-sync-lead] Lead ${email} sincronizado com sucesso. contactId=${contactId}, listId=${listId}`);

    return json({
      ok: true,
      contactId,
      listId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao sincronizar lead com o ActiveCampaign.";
    console.error(`[activecampaign-sync-lead] Erro ao sincronizar ${email}: ${message}`);
    try {
      await markLead(email, "error", undefined, undefined, message);
    } catch (markError) {
      const markMessage = markError instanceof Error ? markError.message : "Falha ao salvar erro no Supabase.";
      console.error(`[activecampaign-sync-lead] ${markMessage}`);
    }
    return json({ error: message }, 400);
  }
});
