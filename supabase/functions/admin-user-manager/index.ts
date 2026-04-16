import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Payload = {
  action?: "create_user" | "set_admin_status";
  email?: string;
  password?: string;
  nome?: string;
  isAdmin?: boolean;
  active?: boolean;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
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

async function getRequester(authHeader: string | null) {
  const token = authHeader?.replace("Bearer ", "").trim();
  if (!token) {
    return { error: json({ error: "Token ausente." }, 401) };
  }

  const { data: userData, error: userError } = await adminClient.auth.getUser(token);
  if (userError || !userData.user) {
    return { error: json({ error: "Sessão inválida." }, 401) };
  }

  const requesterEmail = userData.user.email?.toLowerCase() ?? "";
  if (!requesterEmail) {
    return { error: json({ error: "E-mail do solicitante não encontrado." }, 403) };
  }

  const { data: adminRow, error: adminError } = await adminClient
    .from("admin_users")
    .select("email, active")
    .eq("email", requesterEmail)
    .maybeSingle();

  if (adminError || !adminRow || !adminRow.active) {
    return { error: json({ error: "Acesso negado." }, 403) };
  }

  return {
    requester: {
      email: requesterEmail,
      user: userData.user,
    },
  };
}

async function createUser(payload: Payload, requesterEmail: string) {
  const email = (payload.email ?? "").trim().toLowerCase();
  const password = payload.password ?? "";
  const nome = (payload.nome ?? "").trim();
  const isAdmin = Boolean(payload.isAdmin);

  if (!email || !password) {
    return json({ error: "E-mail e senha são obrigatórios." }, 400);
  }

  if (password.length < 6) {
    return json({ error: "A senha precisa ter pelo menos 6 caracteres." }, 400);
  }

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: nome ? { name: nome } : undefined,
  });

  if (error) {
    return json({ error: error.message }, 400);
  }

  if (isAdmin) {
    const { error: adminInsertError } = await adminClient.from("admin_users").upsert({
      email,
      nome: nome || null,
      active: true,
      created_by: requesterEmail,
    });

    if (adminInsertError) {
      return json({ error: adminInsertError.message }, 400);
    }
  }

  return json({
    ok: true,
    user: {
      id: data.user?.id,
      email: data.user?.email,
      isAdmin,
    },
  });
}

async function setAdminStatus(payload: Payload, requesterEmail: string) {
  const email = (payload.email ?? "").trim().toLowerCase();
  const nome = (payload.nome ?? "").trim();
  const active = Boolean(payload.active);

  if (!email) {
    return json({ error: "E-mail é obrigatório." }, 400);
  }

  const { error } = await adminClient.from("admin_users").upsert({
    email,
    nome: nome || null,
    active,
    created_by: requesterEmail,
  });

  if (error) {
    return json({ error: error.message }, 400);
  }

  return json({ ok: true });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  const authHeader = request.headers.get("Authorization");
  const requesterResult = await getRequester(authHeader);
  if ("error" in requesterResult) return requesterResult.error;

  const payload = (await request.json()) as Payload;

  switch (payload.action) {
    case "create_user":
      return createUser(payload, requesterResult.requester.email);
    case "set_admin_status":
      return setAdminStatus(payload, requesterResult.requester.email);
    default:
      return json({ error: "Ação inválida." }, 400);
  }
});

