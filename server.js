// server.js  — VIN Agent Service (Express on Render)
// ESM module (be sure package.json has: { "type": "module" })

import express from "express";
import helmet from "helmet";
import cors from "cors";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- tiny helpers ------------------------------------------------------------
const isNonEmptyString = (s) => typeof s === "string" && s.trim().length > 0;

function normalizeMessages(msgs = []) {
  return (Array.isArray(msgs) ? msgs : [])
    .map(m => ({
      sender: m?.sender || "rep",
      text: (m?.text || "").toString().trim(),
      time: m?.time || ""
    }))
    .filter(m => isNonEmptyString(m.text))
    .slice(-60); // last 60 for context max
}

function buildPrompt(messages = [], lead = {}, page = {}) {
  const convo = messages.map(m => `[${m.sender}] ${m.text}`).join("\n");

  const leadBits = [
    lead?.name && `name: ${lead.name}`,
    [lead?.vehicleYear, lead?.vehicleMake, lead?.vehicleModel].filter(Boolean).length
      ? `vehicle: ${[lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(" ")}`
      : null,
    lead?.status && `status: ${lead.status}`,
    lead?.source && `source: ${lead.source}`
  ].filter(Boolean).join("; ");

  const pageBits = [
    page?.url && `url: ${page.url}`,
    page?.title && `title: ${page.title}`
  ].filter(Boolean).join("; ");

  return {
    system: [
      "You are an expert BDC/sales assistant for a car dealership.",
      "You write concise, natural replies that sound like a helpful, professional human.",
      "You are careful about compliance: no guarantees, no misinformation, no pressure.",
      "Prefer short paragraphs (1–2 sentences) and specific next steps.",
      "If customer asked for something specific, address it directly; otherwise move the deal forward politely."
    ].join(" "),
    user: [
      leadBits && `Lead: ${leadBits}`,
      pageBits && `Page: ${pageBits}`,
      "Conversation transcript (newest last):",
      "-----",
      convo || "(no visible conversation text)",
      "-----",
      "Task: Suggest 1–3 candidate replies I can click-to-send next.",
      "Each should be a complete, ready-to-send message.",
      "Return ONLY a strict JSON array of strings (no keys, no commentary)."
    ].filter(Boolean).join("\n")
  };
}

function pickSuggestions(raw) {
  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map(s => (s ?? "").toString().trim())
        .filter(isNonEmptyString);
    }
  } catch (_) {}

  // Fallback: split bullets / numbered lines
  const lines = raw.split(/\r?\n/).map(l => l.replace(/^\s*[-*\d.)]+\s*/, "").trim());
  return lines.filter(isNonEmptyString);
}

function dedupCap(list, max = 3) {
  const set = new Set();
  const out = [];
  for (const s of list) {
    const k = s.replace(/\s+/g, " ").trim();
    if (k && !set.has(k)) {
      set.add(k);
      out.push(k);
      if (out.length >= max) break;
    }
  }
  return out;
}

// --- health check ------------------------------------------------------------
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- main agent endpoint -----------------------------------------------------
app.post("/agent/reply", async (req, res) => {
  try {
    // 1) Auth
    const bearer = req.headers.authorization?.split(" ")[1] || "";
    if (!process.env.AGENT_BEARER || bearer !== process.env.AGENT_BEARER) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2) Normalize input
    const messages = normalizeMessages(req.body?.messages);
    const lead = req.body?.lead || {};
    const page = req.body?.page || {};

    // 3) Build prompt
    const { system, user } = buildPrompt(messages, lead, page);

    // 4) Call OpenAI
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12_000);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: 400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    }).finally(() => clearTimeout(to));

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("OpenAI HTTP", r.status, errText);
      return res.status(502).json({ error: "Upstream model error" });
    }

    const data = await r.json();
    const content =
      data?.choices?.[0]?.message?.content?.toString() ||
      "";

    // 5) Parse → sanitize → cap
    const picked = pickSuggestions(content);
    const suggestions = dedupCap(picked, 3);

    return res.json({ suggestions });
  } catch (err) {
    console.error("agent/reply error:", err?.message || err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- boot --------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`VIN Agent service running on :${port}`);
});
