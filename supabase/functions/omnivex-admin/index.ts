import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!url || !anon || !service) return json(503, { error: "Admin function configuration incomplete" });
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Authentication required" });

  try {
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    const user = authData?.user;
    if (authError || !user) return json(401, { error: "Invalid or expired session" });

    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    const adminClient = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === "track") {
      const allowed = ["session_start", "page_view", "heartbeat", "session_end"];
      if (!allowed.includes(body?.event_type)) return json(400, { error: "Invalid activity event" });
      const sessionId = typeof body?.session_id === "string" ? body.session_id.slice(0, 80) : "";
      if (!sessionId) return json(400, { error: "Missing session id" });
      const page = typeof body?.page === "string" ? body.page.slice(0, 100) : null;
      const { error } = await adminClient.from("omnivex_activity").insert({
        user_id: user.id,
        user_email: user.email ?? null,
        session_id: sessionId,
        event_type: body.event_type,
        page,
      });
      if (error) {
        console.error("Activity insert failed", error.message);
        return json(500, { error: "تعذّر حفظ سجل النشاط" });
      }
      return json(200, { ok: true });
    }

    if (action !== "dashboard") return json(400, { error: "Unknown action" });
    if (user.app_metadata?.role !== "admin") {
      return json(403, { error: "غير مصرح لك بدخول لوحة الإدارة" });
    }

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const activeSince = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

    const [allCount, todayCount, pageCount, todayVisitorsResult, recentResult, activeResult] = await Promise.all([
      adminClient.from("omnivex_activity").select("id", { count: "exact", head: true }),
      adminClient.from("omnivex_activity").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
      adminClient.from("omnivex_activity").select("id", { count: "exact", head: true }).eq("event_type", "page_view").gte("created_at", dayAgo),
      adminClient.from("omnivex_activity").select("user_id").gte("created_at", dayAgo).limit(10000),
      adminClient.from("omnivex_activity").select("user_email,session_id,event_type,page,created_at").order("created_at", { ascending: false }).limit(100),
      adminClient.from("omnivex_activity").select("user_id,user_email,session_id,event_type,page,created_at").gte("created_at", activeSince).order("created_at", { ascending: false }).limit(1000),
    ]);
    for (const item of [allCount, todayCount, pageCount, todayVisitorsResult, recentResult, activeResult]) {
      if (item.error) throw item.error;
    }

    const visitorsToday = new Set((todayVisitorsResult.data ?? []).map((x: any) => x.user_id)).size;

    const activeSessions = new Map<string, any>();
    for (const event of activeResult.data ?? []) {
      if (!activeSessions.has(event.session_id)) activeSessions.set(event.session_id, event);
    }
    const online = [...activeSessions.values()].filter((x: any) => x.event_type !== "session_end");

    let registeredUsers = 0;
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const users = data?.users ?? [];
      registeredUsers += users.length;
      if (users.length < 1000) break;
    }

    return json(200, {
      stats: {
        registered_users: registeredUsers,
        visitors_today: visitorsToday,
        page_views_today: pageCount.count ?? 0,
        events_today: todayCount.count ?? 0,
        total_events: allCount.count ?? 0,
        currently_active_sessions: online.length,
      },
      online: online.slice(0, 50),
      recent: (recentResult.data ?? []).slice(0, 100),
      generated_at: now.toISOString(),
      note: "عدد الموجودين حالياً تقديري من آخر نبضة خلال 5 دقائق؛ قد يتأخر تسجيل الخروج عند إغلاق المتصفح فجأة.",
    });
  } catch (error) {
    console.error("OMNIVEX admin error", error instanceof Error ? error.message : String(error));
    return json(500, { error: "حدث خطأ أثناء تحميل لوحة الإدارة" });
  }
});