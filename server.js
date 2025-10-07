import express from "express";
import helmet from "helmet";
import cors from "cors";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health check endpoint (Render uses this to confirm it’s live)
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Main agent reply endpoint
app.post("/agent/reply", async (req, res) => {
  try {
    const bearer = req.headers.authorization?.split(" ")[1];
    if (bearer !== process.env.AGENT_BEARER) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { messages = [], lead = {}, page = {} } = req.body;

    // Example: send to OpenAI API (replace model with your preferred one)
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a professional car dealership sales assistant. Respond politely and helpfully." },
          ...messages.map(m => ({
            role: m.sender === "customer" ? "user" : "assistant",
            content: m.text
          })),
          { role: "user", content: `Based on this chat history, suggest 3 short, professional next replies the rep could send.` }
        ]
      })
    });

    const data = await response.json();
    const suggestions = data.choices?.[0]?.message?.content
      ?.split(/\n+/)
      ?.filter(line => line.trim())
      ?.slice(0, 3);

    res.json({ suggestions: suggestions || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Agent running on port ${port}`));
