const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Payload = {
  trilhaSlug?: string;
};

type TrilhaConfig = {
  nome: string;
  acListId: string;
  acListName: string;
};

type SupabaseUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const activeCampaignBaseUrl = (Deno.env.get("ACTIVECAMPAIGN_BASE_URL") ?? "").replace(/\/+$/, "");
const activeCampaignApiToken = Deno.env.get("ACTIVECAMPAIGN_API_TOKEN") ?? "";

const ploomesUserKey = Deno.env.get("PLOOMES_API_KEY") ?? "";
const ploomesBaseUrl = (Deno.env.get("PLOOMES_BASE_URL") ?? "https://public-api2.ploomes.com").replace(/\/+$/, "");
const ploomesPipelineId = Number(Deno.env.get("PLOOMES_PIPELINE_ID") ?? "50001415");
const ploomesStageId = Number(Deno.env.get("PLOOMES_STAGE_ID") ?? "50008137");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

const TRILHAS: Record<string, TrilhaConfig> = {
  "ifrs": {
    nome: "Trilha CONTIFRS",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_LIST_ID") ?? "").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_LIST_NAME") ?? "Trilhaifrs").trim(),
  },
  "gestao": {
    nome: "Trilha de Gestão de Produção com IA",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_GESTAO_LIST_ID") ?? "").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_GESTAO_LIST_NAME") ?? "TrilhaGestaoProducaoIA").trim(),
  },
  "gestao-projetos": {
    nome: "Trilha de Gestão de Projetos",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_GESTAOPROJETOS_LIST_ID") ?? "").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_GESTAOPROJETOS_LIST_NAME") ?? "TrilhaGestaoProjetos").trim(),
  },
  "financas": {
    nome: "Trilha de Finanças",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_FINANCAS_LIST_ID") ?? "50").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_FINANCAS_LIST_NAME") ?? "TrilhaFinancas").trim(),
  },
  "marketing": {
    nome: "Trilha de Marketing Estratégico",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_MARKETING_LIST_ID") ?? "35").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_MARKETING_LIST_NAME") ?? "TrilhaMarketing").trim(),
  },
  "semana-ia-no-direito": {
    nome: "Semana IA no Direito",
    acListId: (Deno.env.get("ACTIVECAMPAIGN_GDE_LIST_ID") ?? "66").trim(),
    acListName: (Deno.env.get("ACTIVECAMPAIGN_GDE_LIST_NAME") ?? "TrilhaGDE").trim(),
  },
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function splitName(nome: string) {
  const parts = nome.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

async function getRequester(authHeader: string | null) {
  const token = authHeader?.replace("Bearer ", "").trim();
  if (!token) {
    return { error: json({ error: "Token ausente." }, 401) };
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { error: json({ error: "Sessão inválida." }, 401) };
  }

  const user = await response.json() as SupabaseUser;
  if (!user?.id) {
    return { error: json({ error: "Sessão inválida." }, 401) };
  }

  return { user };
}

async function updateUserMetadata(userId: string, metadata: Record<string, unknown>) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_metadata: metadata }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Falha ao atualizar usuário: ${response.status} ${text}`);
  }

  return await response.json();
}

async function getLeadByEmail(email: string) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/leads?email=eq.${encodeURIComponent(email)}&select=nome,telefone&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!response.ok) return null;
  const rows = await response.json().catch(() => []) as Array<{ nome?: string; telefone?: string }>;
  return rows[0] ?? null;
}

function normalizeTrilhaSlug(raw: string) {
  const slug = raw.trim().toLowerCase();
  if (TRILHAS[slug]) return slug;

  const normalized = slug.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (normalized.includes("projetos")) return "gestao-projetos";
  if (normalized.includes("gestao")) return "gestao";
  if (normalized.includes("contifrs") || normalized.includes("ifrs") || normalized.includes("contabilidade")) return "ifrs";
  if (normalized.includes("financas")) return "financas";
  if (normalized.includes("marketing")) return "marketing";
  if (normalized.includes("direito") || normalized.includes("gde")) return "semana-ia-no-direito";
  return "";
}

function currentTrilhas(userMetadata: Record<string, unknown> | null | undefined) {
  const metadata = userMetadata ?? {};
  if (Array.isArray(metadata.trilhas)) {
    return metadata.trilhas.map(value => String(value)).filter(Boolean);
  }
  if (typeof metadata.trilha === "string" && metadata.trilha.trim()) {
    return [metadata.trilha.trim()];
  }
  return [];
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
    const message = typeof data.message === "string"
      ? data.message
      : typeof data.error === "string"
        ? data.error
        : `ActiveCampaign respondeu ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

async function syncActiveCampaign(nome: string, email: string, telefone: string, trilha: TrilhaConfig) {
  if (!activeCampaignBaseUrl || !activeCampaignApiToken) {
    throw new Error("ActiveCampaign não configurado.");
  }

  const { firstName, lastName } = splitName(nome);
  const contactData = await activeCampaignFetch("/api/3/contact/sync", {
    method: "POST",
    body: JSON.stringify({
      contact: {
        email,
        firstName: firstName || nome,
        lastName,
        phone: normalizePhone(telefone) || undefined,
      },
    }),
  });

  const contactId = String((contactData.contact as Record<string, unknown> | undefined)?.id ?? "").trim();
  if (!contactId) {
    throw new Error("ActiveCampaign não retornou id de contato.");
  }

  let listId = trilha.acListId;
  if (!listId) {
    const listsData = await activeCampaignFetch("/api/3/lists?limit=100");
    const lists = Array.isArray(listsData.lists) ? listsData.lists as Array<Record<string, unknown>> : [];
    const match = lists.find(item => String(item.name ?? "").trim().toLowerCase() === trilha.acListName.toLowerCase());
    listId = String(match?.id ?? "").trim();
  }

  if (!listId) {
    throw new Error(`Lista "${trilha.acListName}" não encontrada no ActiveCampaign.`);
  }

  const membershipData = await activeCampaignFetch(`/api/3/contacts/${contactId}/contactLists`);
  const memberships = Array.isArray(membershipData.contactLists)
    ? membershipData.contactLists as Array<Record<string, unknown>>
    : [];
  const alreadySubscribed = memberships.some(
    item => String(item.list ?? "") === listId && String(item.status ?? "") === "1",
  );

  if (!alreadySubscribed) {
    await activeCampaignFetch("/api/3/contactLists", {
      method: "POST",
      body: JSON.stringify({
        contactList: { list: listId, contact: contactId, status: 1 },
      }),
    });
  }

  return { contactId, listId };
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
    const message = typeof data.message === "string"
      ? data.message
      : typeof data.error === "string"
        ? data.error
        : `Ploomes respondeu ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

function getPloomesEntity(data: Record<string, unknown>) {
  if (Array.isArray(data.value) && data.value.length) {
    return data.value[0] as Record<string, unknown>;
  }
  return data;
}

async function findPloomesContactByEmail(email: string) {
  const uri = `/Contacts?$top=1&$select=Id,Name,Email&$filter=${encodeURIComponent(`Email eq '${email.replace(/'/g, "''")}'`)}`;
  const response = await ploomesFetch(uri);
  const list = Array.isArray(response.value) ? response.value as Array<Record<string, unknown>> : [];
  return list[0] ?? null;
}

async function syncPloomes(nome: string, email: string, telefone: string, trilha: TrilhaConfig) {
  if (!ploomesUserKey) {
    throw new Error("Ploomes não configurado.");
  }

  let contact = await findPloomesContactByEmail(email);
  if (!contact) {
    const response = await ploomesFetch("/Contacts", {
      method: "POST",
      body: JSON.stringify({ Name: nome, Email: email, TypeId: 2 }),
    });
    contact = getPloomesEntity(response);
  }

  const contactId = Number(contact.Id ?? 0);
  if (!contactId) {
    throw new Error("Não foi possível identificar o contato no Ploomes.");
  }

  const dealResponse = await ploomesFetch("/Deals", {
    method: "POST",
    body: JSON.stringify({
      Title: trilha.nome,
      ContactId: contactId,
      PipelineId: ploomesPipelineId,
      StageId: ploomesStageId,
    }),
  });

  const deal = getPloomesEntity(dealResponse);
  const dealId = Number(deal.Id ?? 0);

  await ploomesFetch("/InteractionRecords", {
    method: "POST",
    body: JSON.stringify({
      ContactId: contactId,
      ...(dealId ? { DealId: dealId } : {}),
      Content: `Aluno liberou acesso adicional à "${trilha.nome}" pelo próprio portal (auto-inscrição), sem preencher o formulário novamente.`,
    }),
  });

  return { contactId, dealId };
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  const requesterResult = await getRequester(request.headers.get("Authorization"));
  if ("error" in requesterResult) return requesterResult.error;
  const { user } = requesterResult;

  const email = user.email?.toLowerCase() ?? "";
  if (!email) {
    return json({ error: "E-mail do usuário não encontrado." }, 400);
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return json({ error: "Body inválido." }, 400);
  }

  const rawSlug = String(payload.trilhaSlug ?? "").trim().toLowerCase();
  const configKey = normalizeTrilhaSlug(rawSlug);
  const trilha = TRILHAS[configKey];
  if (!rawSlug || !trilha) {
    return json({ error: "Trilha inválida." }, 400);
  }

  const existingTrilhas = currentTrilhas(user.user_metadata);
  if (existingTrilhas.includes(rawSlug)) {
    return json({ ok: true, alreadyEnrolled: true, trilhas: existingTrilhas });
  }

  const nextTrilhas = [...existingTrilhas, rawSlug];

  try {
    await updateUserMetadata(user.id, {
      ...(user.user_metadata ?? {}),
      trilhas: nextTrilhas,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido.";
    return json({ error: `Falha ao liberar acesso: ${message}` }, 400);
  }

  const lead = await getLeadByEmail(email);
  const nome = String(lead?.nome ?? user.user_metadata?.name ?? email);
  const telefone = String(lead?.telefone ?? "");

  let acSynced = false;
  let ploomesSynced = false;
  const warnings: string[] = [];

  try {
    await syncActiveCampaign(nome, email, telefone, trilha);
    acSynced = true;
  } catch (error) {
    warnings.push(`ActiveCampaign: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  }

  try {
    await syncPloomes(nome, email, telefone, trilha);
    ploomesSynced = true;
  } catch (error) {
    warnings.push(`Ploomes: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  }

  return json({
    ok: true,
    trilhas: nextTrilhas,
    acSynced,
    ploomesSynced,
    warnings,
  });
});
