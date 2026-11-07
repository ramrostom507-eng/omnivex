
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ error: "مفتاح الذكاء الاصطناعي غير مضبوط في إعدادات الخادم." }, 500);
    }

    const body = await req.json();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const mode = typeof body.mode === "string" ? body.mode : "general";

    if (!prompt) {
      return json({ error: "اكتب سؤالك أولاً." }, 400);
    }

    if (prompt.length > 12000) {
      return json({ error: "السؤال طويل جداً. اختصره قليلاً." }, 400);
    }

    const systemPrompt = `
You are OMNIVEX AI, a professional global business intelligence,
market research and growth strategy assistant.
Respond in clear Arabic unless the user requests another language.
Be practical, structured, accurate, and transparent.
Never invent companies, contacts, prices, statistics, or sources.
Clearly distinguish verified facts, estimates, and recommendations.
If current live data is unavailable, say so.
Mode: ${mode}
`;

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: systemPrompt,
        input: prompt,
        max_output_tokens: 1400,
      }),
    });

    const result = await aiResponse.json();

    if (!aiResponse.ok) {
      return json({
        error: result.error?.message || "تعذر الاتصال بخدمة الذكاء الاصطناعي.",
      }, aiResponse.status);
    }

    const answer =
      result.output
        ?.flatMap((item: any) => item.content || [])
        ?.filter((item: any) => item.type === "output_text")
        ?.map((item: any) => item.text)
        ?.join("\n") || "لم يصل رد واضح من المساعد.";

    return json({ answer });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "حدث خطأ غير متوقع.",
    }, 500);
  }
});
      
