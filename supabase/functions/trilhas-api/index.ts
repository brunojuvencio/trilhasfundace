import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

type TrilhaStatus = "rascunho" | "publicada";

type TrilhaPayload = {
  nome?: string;
  slug?: string;
  descricao?: string;
  cursoId?: string;
  status?: TrilhaStatus;
};

type CursoPayload = {
  nome?: string;
  descricao?: string;
};

type VideoProvider = "vimeo" | "youtube";

type AulaPayload = {
  titulo?: string;
  vimeoUrl?: string;
  vimeoId?: string;
  videoProvider?: string;
  duracao?: string;
  ordem?: number;
};

type ReorderPayload = Array<{ id?: string; ordem?: number }> | {
  aulas?: Array<{ id?: string; ordem?: number }>;
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

function slugify(text: unknown) {
  return String(text ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanText(value: unknown, maxLength?: number) {
  const text = String(value ?? "").trim();
  return typeof maxLength === "number" ? text.slice(0, maxLength) : text;
}

function extractVimeoId(value: unknown) {
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw)) return raw;

  const patterns = [
    /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:[/?#].*)?$/i,
    /^https?:\/\/player\.vimeo\.com\/video\/(\d+)(?:[/?#].*)?$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }

  return "";
}

function extractYoutubeId(value: unknown) {
  const raw = String(value ?? "").trim();

  const patterns = [
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})(?:[&#].*)?$/i,
    /^https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:[/?#].*)?$/i,
    /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[/?#].*)?$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }

  return "";
}

function extractVideoRef(value: unknown): { provider: VideoProvider; id: string } | null {
  const vimeoId = extractVimeoId(value);
  if (vimeoId) return { provider: "vimeo", id: vimeoId };

  const youtubeId = extractYoutubeId(value);
  if (youtubeId) return { provider: "youtube", id: youtubeId };

  return null;
}

function mapCurso(row: Record<string, unknown>) {
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao ?? "",
  };
}

function mapAula(row: Record<string, unknown>) {
  const vimeoId = String(row.vimeo_id ?? "");
  const provider = (row.video_provider as VideoProvider) ?? "vimeo";
  const vimeoUrl = !vimeoId
    ? ""
    : provider === "youtube"
      ? `https://www.youtube.com/embed/${vimeoId}`
      : `https://player.vimeo.com/video/${vimeoId}`;

  return {
    id: row.id,
    trilhaId: row.trilha_id,
    titulo: row.titulo,
    vimeoId,
    videoProvider: provider,
    vimeoUrl,
    duracao: row.duracao ?? "",
    ordem: row.ordem,
    criadaEm: row.criada_em,
  };
}

function mapTrilha(row: Record<string, unknown>, numeroAulas = 0, aulas: unknown[] = []) {
  const rawCurso = Array.isArray(row.cursos) ? row.cursos[0] : row.cursos;
  const curso = rawCurso && typeof rawCurso === "object"
    ? mapCurso(rawCurso as Record<string, unknown>)
    : null;

  return {
    id: row.id,
    nome: row.nome,
    slug: row.slug ?? "",
    descricao: row.descricao ?? "",
    cursoId: row.curso_id,
    curso,
    status: row.status,
    numeroAulas,
    aulas,
    criadaEm: row.criada_em,
    atualizadaEm: row.atualizada_em,
  };
}

function pathSegments(request: Request) {
  const pathname = new URL(request.url).pathname;
  let segments = pathname.split("/").filter(Boolean);
  const functionIndex = segments.findIndex(segment => segment === "trilhas-api");
  if (functionIndex >= 0) segments = segments.slice(functionIndex + 1);
  if (segments[0] === "api") segments = segments.slice(1);
  return segments;
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

async function readPayload<T>(request: Request): Promise<T> {
  return await request.json().catch(() => ({})) as T;
}

function validateStatus(status: unknown): TrilhaStatus {
  if (status === undefined || status === null || status === "") return "rascunho";
  const normalized = String(status).trim().toLowerCase();
  if (normalized === "publicada") return "publicada";
  if (normalized === "rascunho") return "rascunho";
  throw new Error("Status inválido.");
}

function validateTrilhaPayload(payload: TrilhaPayload, allowPartial = false) {
  const values: Record<string, unknown> = {};

  if (!allowPartial || "nome" in payload) {
    const nome = cleanText(payload.nome);
    if (!nome) throw new Error("Nome da trilha é obrigatório.");
    values.nome = nome;
    if (!("slug" in payload)) {
      values.slug = slugify(nome);
    }
  }

  if (!allowPartial || "slug" in payload) {
    const slug = slugify(payload.slug || (values.nome as string));
    if (!slug) throw new Error("Slug da trilha é obrigatório.");
    values.slug = slug;
  }

  if (!allowPartial || "descricao" in payload) {
    const descricao = cleanText(payload.descricao, 200);
    values.descricao = descricao;
  }

  if (!allowPartial || "cursoId" in payload) {
    const cursoId = cleanText(payload.cursoId);
    if (!cursoId) throw new Error("Curso associado é obrigatório.");
    values.curso_id = cursoId;
  }

  if (!allowPartial || "status" in payload) {
    values.status = validateStatus(payload.status);
  }

  return values;
}

function validateAulaPayload(payload: AulaPayload, allowPartial = false) {
  const values: Record<string, unknown> = {};

  if (!allowPartial || "titulo" in payload) {
    const titulo = cleanText(payload.titulo);
    if (!titulo) throw new Error("Título da aula é obrigatório.");
    values.titulo = titulo;
  }

  if (!allowPartial || "vimeoUrl" in payload || "vimeoId" in payload || "videoProvider" in payload) {
    const rawValue = payload.vimeoId || payload.vimeoUrl;
    let videoRef = extractVideoRef(rawValue);

    if (!videoRef && (payload.videoProvider === "vimeo" || payload.videoProvider === "youtube")) {
      const bareId = cleanText(rawValue);
      const isValid = payload.videoProvider === "vimeo"
        ? /^\d+$/.test(bareId)
        : /^[A-Za-z0-9_-]{11}$/.test(bareId);
      if (isValid) videoRef = { provider: payload.videoProvider, id: bareId };
    }

    if (!videoRef) throw new Error("Link ou ID do Vimeo/YouTube inválido.");
    values.vimeo_id = videoRef.id;
    values.video_provider = videoRef.provider;
  }

  if (!allowPartial || "duracao" in payload) {
    const duracao = cleanText(payload.duracao);
    values.duracao = duracao || null;
  }

  if (!allowPartial || "ordem" in payload) {
    const ordem = Number(payload.ordem || 1);
    values.ordem = Number.isFinite(ordem) && ordem > 0 ? Math.round(ordem) : 1;
  }

  return values;
}

async function listCursos() {
  const { data, error } = await adminClient
    .from("cursos")
    .select("id, nome, descricao")
    .order("nome", { ascending: true });

  if (error) return json({ error: error.message }, 400);
  return json({ cursos: (data || []).map(mapCurso) });
}

async function createCurso(request: Request) {
  try {
    const payload = await readPayload<CursoPayload>(request);
    const nome = cleanText(payload.nome);
    if (!nome) throw new Error("Nome do curso é obrigatório.");
    const descricao = cleanText(payload.descricao, 300);

    const { data, error } = await adminClient
      .from("cursos")
      .insert({ nome, descricao: descricao || null })
      .select("id, nome, descricao")
      .single();

    if (error) return json({ error: error.message }, 400);
    return json({ curso: mapCurso(data) }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function updateCurso(request: Request, cursoId: string) {
  try {
    const payload = await readPayload<CursoPayload>(request);
    const values: Record<string, unknown> = {};
    if ("nome" in payload) {
      const nome = cleanText(payload.nome);
      if (!nome) throw new Error("Nome do curso é obrigatório.");
      values.nome = nome;
    }
    if ("descricao" in payload) values.descricao = cleanText(payload.descricao, 300) || null;

    if (!Object.keys(values).length) return json({ error: "Nenhum campo para atualizar." }, 400);

    const { data, error } = await adminClient
      .from("cursos")
      .update(values)
      .eq("id", cursoId)
      .select("id, nome, descricao")
      .maybeSingle();

    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: "Curso não encontrado." }, 404);
    return json({ curso: mapCurso(data) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function deleteCurso(cursoId: string) {
  const { error } = await adminClient
    .from("cursos")
    .delete()
    .eq("id", cursoId);

  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

async function listTrilhas() {
  const { data: trilhas, error } = await adminClient
    .from("trilhas")
    .select("id, nome, descricao, curso_id, status, criada_em, atualizada_em, cursos(id, nome, descricao)")
    .order("criada_em", { ascending: false });

  if (error) return json({ error: error.message }, 400);

  const ids = (trilhas || []).map(item => item.id);
  const counts = new Map<string, number>();

  if (ids.length) {
    const { data: aulas, error: aulasError } = await adminClient
      .from("aulas")
      .select("trilha_id")
      .in("trilha_id", ids);

    if (aulasError) return json({ error: aulasError.message }, 400);
    for (const aula of aulas || []) {
      const trilhaId = String(aula.trilha_id);
      counts.set(trilhaId, (counts.get(trilhaId) || 0) + 1);
    }
  }

  return json({
    trilhas: (trilhas || []).map(item => mapTrilha(item, counts.get(String(item.id)) || 0)),
  });
}

async function createTrilha(request: Request) {
  try {
    const payload = await readPayload<TrilhaPayload>(request);
    const values = validateTrilhaPayload(payload);

    const { data, error } = await adminClient
      .from("trilhas")
      .insert(values)
      .select("id, nome, descricao, curso_id, status, criada_em, atualizada_em, cursos(id, nome, descricao)")
      .single();

    if (error) return json({ error: error.message }, 400);
    return json({ trilha: mapTrilha(data) }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function getTrilha(trilhaId: string) {
  const { data: trilha, error } = await adminClient
    .from("trilhas")
    .select("id, nome, descricao, curso_id, status, criada_em, atualizada_em, cursos(id, nome, descricao)")
    .eq("id", trilhaId)
    .maybeSingle();

  if (error) return json({ error: error.message }, 400);
  if (!trilha) return json({ error: "Trilha não encontrada." }, 404);

  const { data: aulas, error: aulasError } = await adminClient
    .from("aulas")
    .select("id, trilha_id, titulo, vimeo_id, video_provider, duracao, ordem, criada_em")
    .eq("trilha_id", trilhaId)
    .order("ordem", { ascending: true })
    .order("criada_em", { ascending: true });

  if (aulasError) return json({ error: aulasError.message }, 400);

  const mappedAulas = (aulas || []).map(mapAula);
  return json({
    trilha: mapTrilha(trilha, mappedAulas.length, mappedAulas),
  });
}

async function updateTrilha(request: Request, trilhaId: string) {
  try {
    const payload = await readPayload<TrilhaPayload>(request);
    const values = validateTrilhaPayload(payload, true);

    if (!Object.keys(values).length) {
      return json({ error: "Nenhum campo para atualizar." }, 400);
    }

    const { data, error } = await adminClient
      .from("trilhas")
      .update(values)
      .eq("id", trilhaId)
      .select("id, nome, descricao, curso_id, status, criada_em, atualizada_em, cursos(id, nome, descricao)")
      .maybeSingle();

    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: "Trilha não encontrada." }, 404);
    return json({ trilha: mapTrilha(data) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function deleteTrilha(trilhaId: string) {
  const { error } = await adminClient
    .from("trilhas")
    .delete()
    .eq("id", trilhaId);

  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

async function listAulas(trilhaId: string) {
  const { data, error } = await adminClient
    .from("aulas")
    .select("id, trilha_id, titulo, vimeo_id, video_provider, duracao, ordem, criada_em")
    .eq("trilha_id", trilhaId)
    .order("ordem", { ascending: true })
    .order("criada_em", { ascending: true });

  if (error) return json({ error: error.message }, 400);
  return json({ aulas: (data || []).map(mapAula) });
}

async function createAula(request: Request, trilhaId: string) {
  try {
    const payload = await readPayload<AulaPayload>(request);
    const values = {
      ...validateAulaPayload(payload),
      trilha_id: trilhaId,
    };

    const { data, error } = await adminClient
      .from("aulas")
      .insert(values)
      .select("id, trilha_id, titulo, vimeo_id, video_provider, duracao, ordem, criada_em")
      .single();

    if (error) return json({ error: error.message }, 400);
    return json({ aula: mapAula(data) }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function updateAula(request: Request, aulaId: string) {
  try {
    const payload = await readPayload<AulaPayload>(request);
    const values = validateAulaPayload(payload, true);

    if (!Object.keys(values).length) {
      return json({ error: "Nenhum campo para atualizar." }, 400);
    }

    const { data, error } = await adminClient
      .from("aulas")
      .update(values)
      .eq("id", aulaId)
      .select("id, trilha_id, titulo, vimeo_id, video_provider, duracao, ordem, criada_em")
      .maybeSingle();

    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: "Aula não encontrada." }, 404);
    return json({ aula: mapAula(data) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Payload inválido." }, 400);
  }
}

async function deleteAula(aulaId: string) {
  const { error } = await adminClient
    .from("aulas")
    .delete()
    .eq("id", aulaId);

  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

async function reorderAulas(request: Request, trilhaId: string) {
  const payload = await readPayload<ReorderPayload>(request);
  const aulas = Array.isArray(payload) ? payload : payload.aulas || [];

  if (!aulas.length) {
    return json({ error: "Informe a nova ordem das aulas." }, 400);
  }

  for (const aula of aulas) {
    const id = cleanText(aula.id);
    const ordem = Number(aula.ordem);
    if (!id || !Number.isFinite(ordem) || ordem <= 0) {
      return json({ error: "Payload de ordenação inválido." }, 400);
    }
  }

  for (const aula of aulas) {
    const { error } = await adminClient
      .from("aulas")
      .update({ ordem: Math.round(Number(aula.ordem)) })
      .eq("id", aula.id)
      .eq("trilha_id", trilhaId);

    if (error) return json({ error: error.message }, 400);
  }

  return listAulas(trilhaId);
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requesterResult = await getRequester(request.headers.get("Authorization"));
  if ("error" in requesterResult) return requesterResult.error;

  const segments = pathSegments(request);
  const [resource, id, child] = segments;

  if (resource === "cursos") {
    if (request.method === "GET" && !id) return listCursos();
    if (request.method === "POST" && !id) return createCurso(request);
    if (request.method === "PUT" && id) return updateCurso(request, id);
    if (request.method === "DELETE" && id) return deleteCurso(id);
  }

  if (resource === "trilhas") {
    if (request.method === "GET" && !id) return listTrilhas();
    if (request.method === "POST" && !id) return createTrilha(request);
    if (request.method === "GET" && id && !child) return getTrilha(id);
    if (request.method === "PUT" && id && !child) return updateTrilha(request, id);
    if (request.method === "DELETE" && id && !child) return deleteTrilha(id);
    if (request.method === "GET" && id && child === "aulas") return listAulas(id);
    if (request.method === "POST" && id && child === "aulas") return createAula(request, id);
    if (request.method === "PATCH" && id && child === "reordenar") return reorderAulas(request, id);
  }

  if (resource === "aulas" && id) {
    if (request.method === "PATCH" && !child) return updateAula(request, id);
    if (request.method === "DELETE" && !child) return deleteAula(id);
  }

  return json({ error: "Rota não encontrada." }, 404);
});
