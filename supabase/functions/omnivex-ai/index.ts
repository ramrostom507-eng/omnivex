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
const SEARCH_MODEL_DEFAULT = "gemini-3.8-flash";
const STANDARD_MODEL_DEFAULT = "gemini-3.8-flash";
const GEMINI_FALLBACK_MODEL_DEFAULT = "gemini-3.5-flash-lite";
const MAX_PROMPT_LENGTH = 12000;

function needsLiveSearch(prompt: string, mode: string): boolean {
  const p = (prompt + " " + mode).toLowerCase();
  return /بحث|ابحث|مصادر|مراجع|آخر|أحدث|حديث|حالي|اليوم|هذا الأسبوع|هذا الشهر|سعر اليوم|أسعار|السوق الآن|بيانات التجارة|إحصائيات|استيراد|تصدير|موردين|موردون|مستوردين|منافسين|شركات في|فرص السوق|تحليل السوق|دراسة سوق|حجم السوق|market\s*research|competitor\s*analysis|opportunity\s*scan|latest|current|today|this week|this month|recent|live|sources|citations|trade data|market size|competitor|competitors|import|export|hs code/.test(p);
}

function collectInteraction(interaction: any) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  const textParts: string[] = [];
  const citations: Array<{ title: string; url: string }> = [];
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      textParts.push(block.text);
      for (const annotation of Array.isArray(block.annotations) ? block.annotations : []) {
        if (annotation?.type !== "url_citation") continue;
        const url = typeof annotation.url === "string" ? annotation.url : "";
        if (!/^https?:\/\//i.test(url)) continue;
        citations.push({ title: String(annotation.title || url).slice(0, 180), url });
      }
    }
  }
  const answer = (typeof interaction?.output_text === "string" && interaction.output_text.trim())
    ? interaction.output_text.trim()
    : textParts.join("\n").trim();
  const unique = citations.filter((item, index, all) => all.findIndex((x) => x.url === item.url) === index);
  const searchExecuted = steps.some((step) => step?.type === "google_search_call");
  return { answer, citations: unique, searchExecuted };
}

async function callGeminiSearch(apiKey: string, model: string, system: string, prompt: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50000);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        system_instruction: system,
        input: prompt,
        tools: [{ type: "google_search" }],
      }),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* provider returned non-JSON */ }
    if (!response.ok) {
      const message = String(data?.error?.message || ("HTTP " + response.status)).slice(0, 400);
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const interaction = data?.interaction ?? data;
    const result = collectInteraction(interaction);
    if (!result.answer) throw new Error("لم يرجع بحث Google إجابة نصية قابلة للعرض.");
    return { ...result, model: interaction?.model || model };
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiStandard(apiKey: string, model: string, system: string, prompt: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50000);
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1800, temperature: 0.35 },
        }),
      },
    );
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { /* provider returned non-JSON */ }
    if (!response.ok) {
      const message = String(data?.error?.message || ("HTTP " + response.status)).slice(0, 400);
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const candidate = data?.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
      .filter((part: any) => typeof part?.text === "string")
      .map((part: any) => part.text).join("\n").trim();
    if (!answer) throw new Error("لم يُرجع Gemini إجابة نصية.");
    return { answer, model: data?.modelVersion || model };
  } finally {
    clearTimeout(timer);
  }
}

function isTemporaryProviderError(error: unknown): boolean {
  const status = (error as any)?.status;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return [429, 500, 502, 503, 504].includes(status) ||
    message.includes("high demand") || message.includes("overloaded") ||
    message.includes("temporarily unavailable") || message.includes("try again later");
}

async function callGeminiStandardWithFallback(
  apiKey: string, primaryModel: string, fallbackModel: string, system: string, prompt: string,
) {
  try {
    return await callGeminiStandard(apiKey, primaryModel, system, prompt);
  } catch (primaryError) {
    if (!isTemporaryProviderError(primaryError) || fallbackModel === primaryModel) throw primaryError;
    console.warn("Gemini primary model temporarily unavailable; trying fallback model", {
      primaryModel, fallbackModel, status: (primaryError as any)?.status,
    });
    return await callGeminiStandard(apiKey, fallbackModel, system, prompt);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
  const groqKey = Deno.env.get("GROQ_API_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Authentication required" });
  if (!supabaseUrl || !anonKey) return json(500, { error: "Supabase environment is not configured" });

  try {
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser();
    const user = authData?.user;
    if (authError || !user) return json(401, { error: "انتهت جلسة الدخول. سجّل الدخول مجدداً." });

    const payload = await req.json();
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    const mode = typeof payload?.mode === "string" ? payload.mode.slice(0, 80) : "business_analysis";
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      return json(400, { error: "اكتب طلباً بين حرف واحد و12000 حرف." });
    }
    if (!geminiKey && !groqKey) {
      return json(503, { error: "لا يوجد مفتاح مزود ذكاء اصطناعي مضبوط. أضف GEMINI_API_KEY أو GROQ_API_KEY إلى أسرار Supabase." });
    }

    const today = new Date().toISOString().slice(0, 10);
    const system = "أنت OMNIVEX AI، مساعد ذكاء أعمال عالمي متخصص في أبحاث الأسواق والتجارة والاستراتيجية والنمو.\n" +
      "أجب بالعربية الواضحة ما لم يطلب المستخدم لغة أخرى. التاريخ الحالي: " + today + ". نوع المهمة: " + mode + ".\n" +
      "ميّز بين الحقائق المنشورة والتقديرات والتحليل والافتراضات والمعلومات غير المتاحة. لا تختلق شركات أو جهات اتصال أو أسعاراً أو أرقاماً أو مصادر أو تواريخ.\n" +
      "إذا لم تُجرَ عملية بحث ويب فعلية فلا تدّعِ أنك بحثت على الإنترنت أو أن المعلومات آنية. لا تضع روابط أو مراجع غير متحقق منها.\n" +
      "عند تقدير سوق أو إيراد أو تكلفة، اذكر المعادلة والافتراضات. لا تدّعِ أنك تواصلت مع شركة أو أرسلت رسالة أو أجريت معاملة.\n" +
      "في بيانات التجارة حدّد المنتج بدقة، واذكر رمز HS والفترة والوحدة والعملة عند توفرها. فضّل المصادر الأولية كالجمارك والوزارات والجهات الإحصائية والمنظمات الدولية. عند غياب البيانات اكتب «غير متاح أو لم أتمكن من التحقق» بدلاً من التخمين.\n" +
      "قدّم التقرير بعناوين واضحة بهذا الترتيب عند ملاءمته: الملخص التنفيذي؛ حقائق مثبتة مع مصدر لكل رقم؛ تقديرات وافتراضات مع معادلاتها؛ تحليل واستنتاجات؛ معلومات لم يتم التحقق منها؛ الفرص والمخاطر؛ الخطوات التالية. " +
      "ضع بجانب كل ادعاء أحد التصنيفات: [حقيقة موثقة] أو [تقدير] أو [تحليل] أو [غير متحقق]. لا تضع اسم شركة أو هاتفاً أو بريداً أو سعراً أو حصة سوقية ضمن الحقائق الموثقة دون مصدر مباشر قابل للفتح. " +
      "إذا تعذر الوصول إلى مصدر أولي، صرّح بذلك ولا تحول قوائم الدليل التجاري أو صفحات التواصل إلى إثبات لوجود مستورد فعلي أو نشاط استيراد.\\n" +
      "عند تحليل الشركات، صنّف كل كيان بوضوح ضمن فئة واحدة: مصنع/منتج، مستورد مثبت، موزع مثبت، تاجر جملة، تاجر تجزئة، وسيط، أو مرشح محتمل غير متحقق منه. لا تصف الشركة بأنها مستورد أو موزع مثبت إلا بوجود دليل مباشر على هذا الدور.\\n" +
      "لكل شركة اعرض الاسم القانوني أو التجاري، الدور المثبت، المنتج/القطاع، البلد، دليل الدور، رابط المصدر، تاريخ النشر أو التحقق، وبيانات الاتصال فقط إذا كانت منشورة مباشرة في مصدر موثوق. إذا لم يوجد دليل كافٍ فاكتب: مرشح محتمل — غير مثبت.\\n" +
      "اكشف التكرار قبل عرض النتائج: قارن الاسم القانوني والاسم التجاري والنطاق الإلكتروني والهاتف والعنوان. أشر إلى السجلات المتشابهة وسبب الاشتباه، ولا تدمج كيانين لمجرد تشابه الاسم دون دليل يثبت أنهما الشركة نفسها.\\n" +
      "امنح كل شركة أو فرصة درجة موثوقية من 0 إلى 100 مع شرح الحساب: قوة الدليل 0–40، جودة المصدر 0–25، حداثة المصدر 0–15، تطابق هوية الكيان 0–10، والتأييد المستقل من مصدر ثانٍ 0–10. لا تمنح نقاطاً بلا دليل. التصنيف: 80–100 مرتفعة، 60–79 متوسطة، 40–59 منخفضة، 0–39 ضعيفة؛ وإذا لم تتوفر أدلة كافية فاكتب غير قابل للتقييم.\\n" +
      "لا تعتبر صفحة متجر أو فيسبوك أو دليل تجاري أو معرض أو صفحة تعريف عامة دليلاً على الاستيراد. إثبات الاستيراد يحتاج سجلاً جمركياً أو بيانات تجارة رسمية أو إفصاحاً موثقاً من الشركة أو وثيقة شحن/مناقصة موثوقة. الدليل غير المباشر يعني مرشحاً محتملاً لا مستورداً مثبتاً.";

    const searchRequested = needsLiveSearch(prompt, mode);
    const searchEnabled = Deno.env.get("OMNIVEX_GOOGLE_SEARCH_ENABLED") === "true";
    const searchModel = Deno.env.get("GEMINI_SEARCH_MODEL") || SEARCH_MODEL_DEFAULT;
    const standardModel = Deno.env.get("GEMINI_MODEL") || STANDARD_MODEL_DEFAULT;

    // Search grounding is deliberately OFF unless an administrator explicitly enables it.
    // This prevents unexpected Google Search usage or charges during setup.
    if (searchRequested && searchEnabled && geminiKey) {
      try {
        const result = await callGeminiSearch(geminiKey, searchModel, system, prompt);
        const citations = result.citations;
        return json(200, {
          answer: result.answer, model: result.model, provider: "Gemini",
          web_search_used: result.searchExecuted,
          citations,
          notice: citations.length
            ? "تم استخدام بحث Google وإرفاق المراجع التي أعادتها الخدمة."
            : "تم إرسال الطلب إلى أداة البحث، لكن لم تُرجع الخدمة مراجع قابلة للعرض.",
        });
      } catch (searchError) {
        // A Search API/model/configuration error must not prevent trying the
        // configured Groq provider or the non-search Gemini fallback.
        console.warn("Gemini Search failed; trying the next configured provider", {
          status: (searchError as any)?.status,
          message: searchError instanceof Error ? searchError.message.slice(0, 180) : "Unknown error",
        });
      }
    }

    if (groqKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50000);
      try {
        // GPT-OSS on Groq supports the built-in browser_search tool. This lets
        // OMNIVEX perform live research with the existing GROQ_API_KEY; no
        // separate Gemini key is required.
        // Keep the administrator's master switch authoritative for BOTH providers.
        const useGroqSearch = searchRequested && searchEnabled;
        const groqBody: Record<string, unknown> = {
          model: "openai/gpt-oss-120b",
          messages: [
            { role: "system", content: system + (useGroqSearch
              ? "\\nأجرِ بحث ويب فعلياً باستخدام أداة browser_search قبل الإجابة. استشهد بالمصادر وروابطها داخل الإجابة، واذكر تاريخ النشر أو الوصول عندما يظهر. لا تعتبر مقتطف البحث دليلاً كافياً إذا تعارض مع مصدر أولي."
              : "") },
            { role: "user", content: prompt },
          ],
          max_completion_tokens: 2400,
          reasoning_effort: "low",
        };
        if (useGroqSearch) {
          groqBody.tools = [{ type: "browser_search" }];
          groqBody.tool_choice = "required";
        }
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + groqKey, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(groqBody),
        });
        const raw = await response.text();
        let result: any = {};
        try { result = JSON.parse(raw); } catch { /* provider returned non-JSON */ }
        if (response.ok) {
          const message = result?.choices?.[0]?.message;
          const answer = message?.content;
          // Preserve provider-supplied URL annotations when available.
          const citations: Array<{title:string;url:string}> = [];
          const addCitation = (title: unknown, url: unknown) => {
            if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
            const clean = url.replace(/[),.;]+$/, "");
            if (!citations.some((item) => item.url === clean)) {
              citations.push({ title: String(title || clean).slice(0, 180), url: clean });
            }
          };
          const annotationLists = [
            message?.annotations, message?.citations, result?.citations,
            message?.sources, result?.sources,
          ];
          for (const list of annotationLists) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              addCitation(item?.title || item?.name, item?.url || item?.uri || item?.source_url);
            }
          }
          if (typeof answer === "string" && answer.trim()) {
            const urls = answer.match(/https?:\/\/[^\s)]+/g) || [];
            for (const url of urls) addCitation(url, url);
            // tool_choice="required" forces the built-in browser_search path.
            const searched = useGroqSearch;
            return json(200, {
              answer: answer.trim(), model: result?.model || "openai/gpt-oss-120b",
              provider: "Groq", web_search_used: searched, citations,
              notice: searched
                ? (citations.length
                  ? "تم تنفيذ البحث الحي عبر Groq Browser Search، وأُرفقت الروابط التي أعادها المزود."
                  : "تم تنفيذ البحث الحي عبر Groq Browser Search. أظهر المزود إشارات المراجع داخل الإجابة لكنه لم يُرجع روابط منفصلة قابلة للاستخراج؛ لا تعتبر أي جهة اتصال أو رقم غير موثق.")
                : "هذه إجابة ذكاء اصطناعي دون بحث ويب حي.",
            });
          }
        }
        console.error("Groq request failed", { status: response.status, message: String(result?.error?.message || "").slice(0, 300) });
        if (useGroqSearch) {
          return json(502, { error: "تعذّر تنفيذ البحث الحي عبر Groq: " + String(result?.error?.message || ("HTTP " + response.status)).slice(0, 240) + ". لم نعرض إجابة على أنها بحث موثق." });
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (!geminiKey) return json(502, { error: "تعذّر الوصول إلى مزود الذكاء الاصطناعي." });
    const fallbackModel = Deno.env.get("GEMINI_FALLBACK_MODEL") || GEMINI_FALLBACK_MODEL_DEFAULT;
    const result = await callGeminiStandardWithFallback(
      geminiKey, standardModel, fallbackModel, system, prompt,
    );
    return json(200, {
      answer: result.answer, model: result.model, provider: "Gemini",
      web_search_used: false, citations: [],
      notice: searchRequested
        ? (searchEnabled
          ? "تعذّر البحث الحي عبر المزودات المتاحة؛ أُنجز التحليل دون مراجع ويب مباشرة."
          : "البحث الحي غير مفعّل حالياً؛ هذه إجابة دون تحقق ويب آني.")
        : "لم يُستخدم البحث الحي في هذا الطلب.",
    });
  } catch (error) {
    const status = (error as any)?.status;
    if (status === 429) return json(429, {
      error: "بلغ مزود الذكاء الاصطناعي حد الطلبات المتاح حالياً. انتظر دقيقة ثم أعد المحاولة.",
      code: "PROVIDER_RATE_LIMIT",
    });
    if ([500, 502, 503, 504].includes(status)) return json(503, {
      error: "مزود الذكاء الاصطناعي مشغول مؤقتاً ولم ينجح النموذج الاحتياطي. أعد المحاولة بعد قليل.",
      code: "PROVIDER_TEMPORARILY_UNAVAILABLE",
    });
    console.error("OMNIVEX AI request error", error instanceof Error ? error.message : "Unknown error");
    return json(error instanceof Error && error.name === "AbortError" ? 504 : 502, {
      error: error instanceof Error && error.name === "AbortError"
        ? "انتهت مهلة الاتصال بمزود الذكاء الاصطناعي. حاول مجدداً."
        : "تعذّر تنفيذ التحليل عبر مزود الذكاء الاصطناعي. تحقق من إعدادات المزود ثم أعد المحاولة.",
    });
  }
});
