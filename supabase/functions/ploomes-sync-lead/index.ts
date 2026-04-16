import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Payload = {
  email?: string;
};

type LeadRow = {
  id: number;
  nome: string;
  email: string;
  cidade: string | null;
  telefone: string;
  possui_formacao_superior: boolean;
  area_formacao: string;
  empresa: string;
  cargo: string;
  pretende_pos: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  gclid: string | null;
  fbclid: string | null;
  landing_page_url: string | null;
  referrer_url: string | null;
  consultor_contact_opt_in: boolean | null;
};

type PloomesContact = {
  Id: number;
  Name: string | null;
  Email: string | null;
};

type PloomesDeal = {
  Id: number;
  Title: string | null;
  LastUpdateDate?: string | null;
  Pipeline?: { Id: number; Name: string | null } | null;
  Stage?: { Id: number; Name: string | null } | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ploomesUserKey = Deno.env.get("PLOOMES_API_KEY") ?? "";
const ploomesBaseUrl = (Deno.env.get("PLOOMES_BASE_URL") ?? "https://public-api2.ploomes.com").replace(/\/+$/, "");
const ploomesPipelineId = Number(Deno.env.get("PLOOMES_PIPELINE_ID") ?? "50001415");
const ploomesStageId = Number(Deno.env.get("PLOOMES_STAGE_ID") ?? "50008137");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

if (!ploomesUserKey) {
  throw new Error("PLOOMES_API_KEY é obrigatório.");
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

async function ploomesFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${ploomesBaseUrl}${path}`, {
    ...init,
    headers: {
      "User-Key": ploomesUserKey,
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
          : `Ploomes respondeu ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

function getPloomesEntity<T extends Record<string, unknown>>(data: Record<string, unknown>) {
  if (Array.isArray(data.value) && data.value.length) {
    return data.value[0] as T;
  }

  return data as T;
}

async function getLeadByEmail(email: string) {
  const { data, error } = await adminClient
    .from("leads")
    .select("id,nome,email,cidade,telefone,possui_formacao_superior,area_formacao,empresa,cargo,pretende_pos,utm_source,utm_medium,utm_campaign,utm_term,utm_content,gclid,fbclid,landing_page_url,referrer_url,consultor_contact_opt_in")
    .eq("email", email)
    .maybeSingle<LeadRow>();

  if (error) {
    throw new Error(`Falha ao carregar lead no Supabase: ${error.message}`);
  }

  if (!data) {
    throw new Error("Lead não encontrado.");
  }

  return data;
}

async function markLead(email: string, status: "pending" | "synced" | "error", contactId?: string, dealId?: string, error?: string) {
  const { error: rpcError } = await adminClient.rpc("update_lead_ploomes_sync", {
    p_email: email,
    p_contact_id: contactId ?? null,
    p_deal_id: dealId ?? null,
    p_pipeline_id: String(ploomesPipelineId),
    p_stage_id: String(ploomesStageId),
    p_status: status,
    p_error: error ?? null,
  });

  if (rpcError) {
    throw new Error(`Falha ao atualizar lead no Supabase: ${rpcError.message}`);
  }
}

async function findContactByEmail(email: string) {
  const uri = `/Contacts?$top=1&$select=Id,Name,Email&$filter=${encodeURIComponent(`Email eq '${email.replace(/'/g, "''")}'`)}`;
  const response = await ploomesFetch(uri);
  const list = Array.isArray(response.value) ? response.value as PloomesContact[] : [];
  return list[0] ?? null;
}

function buildAttributionSummary(lead: LeadRow) {
  const lines = [
    ["utm_source", lead.utm_source],
    ["utm_medium", lead.utm_medium],
    ["utm_campaign", lead.utm_campaign],
    ["utm_term", lead.utm_term],
    ["utm_content", lead.utm_content],
    ["gclid", lead.gclid],
    ["fbclid", lead.fbclid],
    ["landing_page_url", lead.landing_page_url],
    ["referrer_url", lead.referrer_url],
  ]
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([label, value]) => `${label}: ${String(value).trim()}`);

  return lines.join("\n");
}

async function createContact(lead: LeadRow) {
  const attributionSummary = buildAttributionSummary(lead);
  const response = await ploomesFetch("/Contacts", {
    method: "POST",
    body: JSON.stringify({
      Name: lead.nome,
      Email: lead.email,
      TypeId: 2,
      OtherProperties: attributionSummary
        ? [
            {
              FieldKey: "contact_920612B2-544B-4A63-8441-0C76BDB46CEF",
              StringValue: attributionSummary,
            },
          ]
        : [],
    }),
  });

  const contact = getPloomesEntity<PloomesContact & Record<string, unknown>>(response);
  const contactId = Number(contact.Id ?? 0);
  if (!contactId) {
    throw new Error("Não foi possível criar o contato no Ploomes.");
  }

  return {
    Id: contactId,
    Name: String(contact.Name ?? lead.nome),
    Email: String(contact.Email ?? lead.email),
  } as PloomesContact;
}

async function getExistingDeals(contactId: number) {
  const filter = encodeURIComponent(`ContactId eq ${contactId}`);
  const uri = `/Deals?$top=5&$select=Id,Title,LastUpdateDate,ContactId&$expand=Pipeline($select=Id,Name),Stage($select=Id,Name)&$orderby=LastUpdateDate desc&$filter=${filter}`;
  const response = await ploomesFetch(uri);
  return Array.isArray(response.value) ? response.value as PloomesDeal[] : [];
}

async function findLatestDealForContact(contactId: number, title: string) {
  const filter = encodeURIComponent(`ContactId eq ${contactId} and Title eq '${title.replace(/'/g, "''")}'`);
  const uri = `/Deals?$top=1&$select=Id,Title,LastUpdateDate,ContactId&$expand=Pipeline($select=Id,Name),Stage($select=Id,Name)&$orderby=LastUpdateDate desc&$filter=${filter}`;
  const response = await ploomesFetch(uri);
  const deals = Array.isArray(response.value) ? response.value as PloomesDeal[] : [];
  return deals[0] ?? null;
}

function buildOtherProperties(lead: LeadRow) {
  return [
    {
      FieldKey: "deal_AA4A6114-F802-479C-B051-0D725AF2EDFE",
      BoolValue: true,
    },
    {
      FieldKey: "deal_BB695453-1351-4744-99EA-8467876C28AC",
      StringValue: "Solicitou mais informações após visualizar o valor médio de R$ 500/mês.",
    },
    {
      FieldKey: "deal_50A4D1E5-2D70-4C33-9723-CEA009E25F26",
      StringValue: lead.possui_formacao_superior ? "Sim" : "Não",
    },
    {
      FieldKey: "deal_8F7621D9-E74F-4402-BB88-D62EF9393394",
      StringValue: lead.empresa || "",
    },
    {
      FieldKey: "deal_DAF0E02D-E986-43E3-A98E-2BC89614BB43",
      StringValue: lead.cargo || "",
    },
    {
      FieldKey: "deal_00112DC8-62A1-4305-A853-9DD19DF6FDCC",
      StringValue: String(lead.id),
    },
    {
      FieldKey: "deal_C4A0DCDB-A9E7-4CD3-A52A-4BF2D093072A",
      StringValue: lead.area_formacao || "",
    },
    {
      FieldKey: "deal_C47CFF53-2019-4960-AA8C-C2E1BFA936A7",
      StringValue: "Trilha CONTIFRS",
    },
    {
      FieldKey: "deal_74219D35-6B80-48C4-BC22-29DD64B3EAE5",
      StringValue: lead.pretende_pos === "sim_agora" ? "Imediato" : lead.pretende_pos,
    },
  ].filter(item => typeof item.StringValue !== "string" || item.StringValue !== "");
}

async function createDeal(contactId: number, lead: LeadRow) {
  const title = "Trilha CONTIFRS";
  const response = await ploomesFetch("/Deals", {
    method: "POST",
    body: JSON.stringify({
      Title: title,
      ContactId: contactId,
      PipelineId: ploomesPipelineId,
      StageId: ploomesStageId,
      OtherProperties: buildOtherProperties(lead),
    }),
  });

  const deal = getPloomesEntity<Record<string, unknown>>(response);
  let dealId = Number(deal.Id ?? 0);

  if (!dealId) {
    const latestDeal = await findLatestDealForContact(contactId, title);
    dealId = Number(latestDeal?.Id ?? 0);
  }

  if (!dealId) {
    throw new Error("Não foi possível identificar o negócio criado no Ploomes.");
  }

  return dealId;
}

function buildHistoryMessage(existingDeals: PloomesDeal[]) {
  if (!existingDeals.length) return "";

  const lines = existingDeals.slice(0, 5).map((deal, index) => {
    const title = deal.Title?.trim() || `Negócio ${deal.Id}`;
    const stage = deal.Stage?.Name?.trim() || "Sem estágio";
    const pipeline = deal.Pipeline?.Name?.trim() || "Sem funil";
    return `${index + 1}. ${title} | Funil: ${pipeline} | Etapa: ${stage}`;
  });

  return [
    "Este contato já possui histórico no CRM.",
    "Antes de iniciar uma nova abordagem, vale revisar o contexto mais recente:",
    ...lines,
  ].join("\n");
}

async function createInteractionRecord(contactId: number, content: string, dealId?: number) {
  if (!content.trim()) return;

  await ploomesFetch("/InteractionRecords", {
    method: "POST",
    body: JSON.stringify({
      ContactId: contactId,
      ...(dealId ? { DealId: dealId } : {}),
      Content: content,
    }),
  });
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

  const email = normalizeEmail(payload.email ?? "");
  if (!email) {
    return json({ error: "E-mail é obrigatório." }, 400);
  }

  try {
    const lead = await getLeadByEmail(email);
    if (!lead.consultor_contact_opt_in) {
      return json({ error: "Lead não autorizou contato do consultor." }, 400);
    }

    console.info(`[ploomes-sync-lead] Iniciando sincronização do lead ${email}.`);
    await markLead(email, "pending");

    let contact = await findContactByEmail(email);
    const contactAlreadyExisted = Boolean(contact);

    if (!contact) {
      contact = await createContact(lead);
    }

    const attributionSummary = buildAttributionSummary(lead);
    const existingDeals = contactAlreadyExisted ? await getExistingDeals(contact.Id) : [];
    const dealId = await createDeal(contact.Id, lead);

    if (attributionSummary) {
      await createInteractionRecord(contact.Id, `Atribuicao capturada na inscricao:\n${attributionSummary}`);
    }

    if (contactAlreadyExisted && existingDeals.length) {
      const content = buildHistoryMessage(existingDeals);
      await createInteractionRecord(contact.Id, content, dealId);
    }

    await markLead(email, "synced", String(contact.Id), String(dealId));
    console.info(`[ploomes-sync-lead] Lead ${email} sincronizado com sucesso. contactId=${contact.Id}, dealId=${dealId}`);

    return json({
      ok: true,
      contactId: contact.Id,
      dealId,
      contactAlreadyExisted,
      historyDealsCount: existingDeals.length,
      pipelineId: ploomesPipelineId,
      stageId: ploomesStageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao sincronizar lead com o Ploomes.";
    console.error(`[ploomes-sync-lead] Erro ao sincronizar ${email}: ${message}`);

    try {
      await markLead(email, "error", undefined, undefined, message);
    } catch (markError) {
      const markMessage = markError instanceof Error ? markError.message : "Falha ao salvar erro no Supabase.";
      console.error(`[ploomes-sync-lead] ${markMessage}`);
    }

    return json({ error: message }, 400);
  }
});
