import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const groqKey = Deno.env.get("GROQ_API_KEY") ?? "";
  const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Authentication required" });
  if (!supabaseUrl || !anonKey) return json(500, { error: "Supabase environment is not configured" });
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json(401, { error: "Invalid or expired session" });
  try {
    const payload = await req.json();
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    const mode = typeof payload?.mode === "string" ? payload.mode : "business_analysis";
    if (!prompt || prompt.length > 12000) return json(400, { error: "اكتب طلباً بين حرف واحد و12000 حرف." });
    const today = new Date().toISOString().slice(0, 10);
    const system = `أنت OMNIVEX AI، مساعد ذكاء أعمال عالمي متخصص في أبحاث الأسواق والتجارة والاستراتيجية والنمو.
أجب بالعربية الواضحة ما لم يطلب المستخدم لغة أخرى. التاريخ الحالي: ${today}. نوع المهمة: ${mode}.
ميّز بين الحقائق المنشورة والتقديرات والتحليل والافتراضات والمعلومات غير المتاحة. لا تختلق شركات أو جهات اتصال أو أسعاراً أو أرقاماً أو مصادر أو تواريخ.
إذا لم تكن أداة البحث الحي متاحة في هذه الإجابة، صرّح بذلك بوضوح ولا تدّعِ أنك بحثت على الإنترنت أو أن المعلومات آنية. لا تضع روابط أو مراجع غير متحقق منها.
عند تقدير سوق أو إيراد أو تكلفة، اذكر المعادلة والافتراضات. لا تدّعِ أنك تواصلت مع شركة أو أرسلت رسالة أو أجريت معاملة.
في بيانات التجارة: حدّد المنتج بدقة ولا تخلط زيت الزيتون بزيت تفل الزيتون أو زيتون المائدة. اذكر رمز HS ووصف المنتج والفترة والوحدة والعملة وحالة البيانات عند توفرها. ميّز السنة التقويمية عن التسويقية. فضّل المصادر الأولية كالجمارك والوزارات والجهات الإحصائية والمنظمات الدولية. عند غياب البيانات اكتب «غير متاح أو لم أتمكن من التحقق» بدلاً من التخمين. قدّم خلاصة منظمة تتضمن الأدلة والمصادر والتحليل والفرص والمخاطر والخطوات التالية عند ملاءمتها.`;
    if (groqKey) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 55000);
      let response: Response;
      try {
        response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
          signal: ctl.signal,
          body: JSON.stringify({
            model: "openai/gpt-oss-120b",
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
            max_completion_tokens: 1800,
            reasoning_effort: "medium",
          }),
        });
      } finally { clearTimeout(timer); }
      const raw = await response.text();
      let result: any;
      try { result = JSON.parse(raw); } catch { result = {}; }
      if (response.ok) {
        const answer = result?.choices?.[0]?.message?.content;
        if (typeof answer === "string" && answer.trim()) {
          return json(200, {
            answer: answer.trim(), model: result?.model ?? "openai/gpt-oss-120b",
            provider: "Groq", web_search_used: false, citations: [],
          });
        }
        console.error("Groq returned no text");
      } else {
        console.error("Groq request failed", { status: response.status, message: String(result?.error?.message ?? "").slice(0, 400) });
        if (!geminiKey || (response.status !== 429 && response.status < 500)) {
          return json(502, {
            error: "تعذّر إكمال التحليل عبر Groq.", provider: "Groq",
            provider_status: response.status,
            provider_message: String(result?.error?.message ?? "Groq provider request failed").slice(0, 500),
          });
        }
      }
    }
    if (!geminiKey) return json(503, { error: "أضف سر GROQ_API_KEY في Supabase لتشغيل المساعد. لا ترسل المفتاح داخل المحادثة." });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 55000);
    let response: Response;
    try {
      response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 1800 },
        }),
      });
    } finally { clearTimeout(timer); }
    const raw = await response.text();
    let result: any;
    try { result = JSON.parse(raw); } catch { result = {}; }
    if (!response.ok) {
      const msg = result?.error?.message ?? "Gemini provider request failed";
      console.error("Gemini request failed", { status: response.status, message: String(msg).slice(0, 400) });
      return json(502, { error: "تعذّر إكمال التحليل عبر Google Gemini.", provider: "Gemini", provider_status: response.status, provider_message: String(msg).slice(0, 600) });
    }
    const candidate = result?.candidates?.[0];
    const answer = (candidate?.content?.parts ?? []).filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("\n").trim();
    if (!answer) return json(502, { error: "لم يُرجع Gemini إجابة نصية." });
    const citations = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c: any) => c?.web).filter((w: any) => typeof w?.uri === "string")
      .map((w: any) => ({ title: w.title || w.uri, url: w.uri }))
      .filter((v: any, i: number, a: any[]) => a.findIndex((x: any) => x.url === v.url) === i);
    let output = answer;
    const missing = citations.filter((v: any) => !output.includes(v.url));
    if (missing.length) output += "\n\n### مصادر بحث Google\n" + missing.map((v: any) => `- [${String(v.title).replace(/[\[\]]/g, "")}](${v.url})`).join("\n");
    return json(200, { answer: output, model: result?.modelVersion ?? "gemini-3.8-flash", provider: "Gemini", web_search_used: citations.length > 0, citations });
  } catch (error) {
    console.error("OMNIVEX AI request error", error instanceof Error ? error.message : "Unknown error");
    return json(500, { error: error instanceof Error && error.name === "AbortError" ? "انتهت مهلة الاتصال بمزود الذكاء الاصطناعي. حاول مجدداً." : "حدث خطأ داخلي أثناء تنفيذ التحليل. يرجى المحاولة مرة أخرى." });
  }
});