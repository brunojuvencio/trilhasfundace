import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AttributionPayload = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  fbclid?: string;
  fbp?: string;
  fbc?: string;
  page_url?: string;
  landing_page_url?: string;
  referrer_url?: string;
  ga_client_id?: string;
  ga_session_id?: string;
  captured_at?: string;
};

type Payload = {
  email?: string;
  attribution?: AttributionPayload;
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
  consultor_contact_opt_in: boolean | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const metaPixelId = (Deno.env.get("META_PIXEL_ID") ?? "").trim();
const metaAccessToken = (Deno.env.get("META_ACCESS_TOKEN") ?? "").trim();
const metaGraphApiVersion = (Deno.env.get("META_GRAPH_API_VERSION") ?? "v23.0").trim();
const metaTestEventCode = (Deno.env.get("META_TEST_EVENT_CODE") ?? "").trim();
const ga4MeasurementId = (Deno.env.get("GA4_MEASUREMENT_ID") ?? "").trim();
const ga4ApiSecret = (Deno.env.get("GA4_API_SECRET") ?? "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
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

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function extractErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object") {
    const nestedRecord = nestedError as Record<string, unknown>;
    const nestedMessage = cleanString(nestedRecord.message);
    if (nestedMessage) return nestedMessage;
  }

  return cleanString(record.message);
}

function pickClientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    ""
  ).trim();
}

async function sha256Hex(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer)).map(item => item.toString(16).padStart(2, "0")).join("");
}

function buildFbc(fbclid: string) {
  if (!fbclid) return "";
  return `fb.1.${Date.now()}.${fbclid}`;
}

function buildEventId(leadId: number) {
  return `trilha_contifrs_qualified_${leadId}_${Date.now()}`;
}

async function getLeadByEmail(email: string) {
  const { data, error } = await adminClient
    .from("leads")
    .select("id,nome,email,cidade,telefone,possui_formacao_superior,area_formacao,empresa,cargo,pretende_pos,consultor_contact_opt_in")
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

async function postMetaLead(
  lead: LeadRow,
  request: Request,
  attribution: AttributionPayload,
  eventId: string,
) {
  if (!metaPixelId || !metaAccessToken) {
    return { skipped: true, reason: "missing_config" };
  }

  const emailHash = await sha256Hex(lead.email);
  const phoneDigits = normalizePhone(lead.telefone);
  const phoneHash = phoneDigits ? await sha256Hex(phoneDigits) : "";
  const fbclid = cleanString(attribution.fbclid);
  const fbp = cleanString(attribution.fbp);
  const fbc = cleanString(attribution.fbc) || buildFbc(fbclid);
  const clientIp = pickClientIp(request);
  const clientUserAgent = request.headers.get("user-agent") ?? "";

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: cleanString(attribution.page_url) || cleanString(attribution.landing_page_url) || "",
        user_data: {
          em: [emailHash],
          ...(phoneHash ? { ph: [phoneHash] } : {}),
          ...(fbp ? { fbp } : {}),
          ...(fbc ? { fbc } : {}),
          ...(clientIp ? { client_ip_address: clientIp } : {}),
          ...(clientUserAgent ? { client_user_agent: clientUserAgent } : {}),
        },
        custom_data: {
          content_name: "Trilha CONTIFRS",
          content_category: "lead_qualificado",
          lead_origin: "popup_mais_informacoes",
        },
      },
    ],
  };

  if (metaTestEventCode) {
    body.test_event_code = metaTestEventCode;
  }

  const response = await fetch(
    `https://graph.facebook.com/${metaGraphApiVersion}/${metaPixelId}/events?access_token=${encodeURIComponent(metaAccessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = extractErrorMessage(result) || `Meta respondeu ${response.status}.`;
    throw new Error(message);
  }

  return {
    skipped: false,
    eventName: "Lead",
    eventId,
    response: result,
  };
}

async function postGa4QualifiedLead(
  lead: LeadRow,
  attribution: AttributionPayload,
) {
  if (!ga4MeasurementId || !ga4ApiSecret) {
    return { skipped: true, reason: "missing_config" };
  }

  const clientId = cleanString(attribution.ga_client_id) || `${Date.now()}.${lead.id}`;
  const sessionId = Number(cleanString(attribution.ga_session_id) || Math.floor(Date.now() / 1000));
  const payload = {
    client_id: clientId,
    user_id: `lead_${lead.id}`,
    timestamp_micros: Date.now() * 1000,
    events: [
      {
        name: "qualify_lead",
        params: {
          session_id: sessionId,
          engagement_time_msec: 1,
          lead_source: "popup_preco_trilha_contifrs",
          form_name: "popup_comercial_trilha_contifrs",
          course_name: "Trilha CONTIFRS",
          company_name: cleanString(lead.empresa),
          job_title: cleanString(lead.cargo),
          education_area: cleanString(lead.area_formacao),
          intends_postgraduate: cleanString(lead.pretende_pos),
          has_degree: lead.possui_formacao_superior ? "true" : "false",
          city_name: cleanString(lead.cidade),
          page_location: cleanString(attribution.page_url),
          page_referrer: cleanString(attribution.referrer_url),
          landing_page_url: cleanString(attribution.landing_page_url),
          utm_source: cleanString(attribution.utm_source),
          utm_medium: cleanString(attribution.utm_medium),
          utm_campaign: cleanString(attribution.utm_campaign),
          utm_term: cleanString(attribution.utm_term),
          utm_content: cleanString(attribution.utm_content),
          gclid: cleanString(attribution.gclid),
          fbclid: cleanString(attribution.fbclid),
        },
      },
    ],
  };

  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(ga4MeasurementId)}&api_secret=${encodeURIComponent(ga4ApiSecret)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `GA4 respondeu ${response.status}.`);
  }

  return {
    skipped: false,
    eventName: "qualify_lead",
    clientId,
    sessionId,
  };
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Metodo nao permitido." }, 405);
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return json({ error: "Body invalido." }, 400);
  }

  const email = normalizeEmail(payload.email ?? "");
  if (!email) {
    return json({ error: "E-mail e obrigatorio." }, 400);
  }

  try {
    const lead = await getLeadByEmail(email);
    if (!lead.consultor_contact_opt_in) {
      return json({ error: "Lead nao autorizou mais informacoes no popup." }, 400);
    }

    const attribution = payload.attribution ?? {};
    const eventId = buildEventId(lead.id);

    const [metaResult, ga4Result] = await Promise.allSettled([
      postMetaLead(lead, request, attribution, eventId),
      postGa4QualifiedLead(lead, attribution),
    ]);

    const meta =
      metaResult.status === "fulfilled"
        ? metaResult.value
        : { skipped: false, error: metaResult.reason instanceof Error ? metaResult.reason.message : "Falha no Meta." };
    const ga4 =
      ga4Result.status === "fulfilled"
        ? ga4Result.value
        : { skipped: false, error: ga4Result.reason instanceof Error ? ga4Result.reason.message : "Falha no GA4." };

    if ("error" in meta && "error" in ga4) {
      throw new Error(`Meta: ${meta.error} | GA4: ${ga4.error}`);
    }

    return json({
      ok: true,
      leadId: lead.id,
      email,
      meta,
      ga4,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao enviar tracking do lead qualificado.";
    console.error(`[qualified-lead-tracking] ${message}`);
    return json({ error: message }, 400);
  }
});
