import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from 'dotenv';
import OpenAI from 'openai';
import { appendFile } from 'fs/promises';
import pg from 'pg';

config(); // Load .env file

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '512kb' }));

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize PostgreSQL
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const validToken = process.env.INTERNAL_TOKEN;
  
  if (!validToken || token === validToken) {
    return next();
  }
  
  return res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================
function buildSystemPrompt({ dealership }) {
  return `You are an AI assistant for ${dealership.name}, a Chevrolet dealership helping BDC representatives craft professional, engaging email replies.

YOUR ROLE:
Generate ONE natural-sounding email reply that the BDC rep can send to the customer.

CRITICAL RULES FOR EVERY REPLY:
1. **Acknowledge specific customer concerns** - Reference what they actually said (payment constraints, timing concerns, specific questions)
2. **Reference conversation timing** - If they mentioned an appointment, service visit, or deadline, work that into the reply naturally
3. **Suggest a concrete next step** - Always end with a clear, low-pressure action (schedule call, get trade value, review numbers during appointment)
4. **Match their tone** - If formal, be professional. If casual, be friendly but still professional
5. **Keep it concise** - 2-4 sentences maximum. BDC reps are busy, customers don't read long emails
6. **NEVER invent numbers** - No prices, payments, trade values, or financial specifics unless already provided in the conversation
7. **Be consultative, not pushy** - Use phrases like "Would you be open to...", "Let me check if...", "No pressure at all..."

STRUCTURE (follow this pattern):
- Sentence 1: Acknowledge their specific concern or question
- Sentence 2: Bridge to a benefit or possibility
- Sentence 3-4: Suggest next step with clear call-to-action

TONE GUIDELINES:
✅ Warm, helpful, conversational
✅ Professional but approachable
✅ Use "I" and "you" (personal connection)
✅ Low-pressure, consultative approach
❌ No corporate jargon or buzzwords
❌ No pushy sales language
❌ No generic template phrases

EXAMPLE (for lease buyout inquiry):
"Hi Nicole! I completely understand wanting to avoid any early termination fees. Let me pull some numbers on your current vehicle's market value - if we can structure a new lease that keeps you in the same trim level at or below your current payment, would you be open to reviewing the details during your service visit tomorrow? No pressure at all, just want to see if the numbers work in your favor!"

RESPONSE FORMAT:
Return a JSON object with this structure:
{
  "reply": "Your single suggested response here"
}`;
}

function buildUserPrompt({ messages, lead, page }) {
  const conversationText = messages
    .map(m => {
      const role = m.sender === 'customer' ? 'Customer' : 'Rep';
      return `${role}: ${m.text}`;
    })
    .join('\n');

  const context = [];
  
  if (lead?.name) context.push(`Customer name: ${lead.name}`);
  if (lead?.vehicleYear || lead?.vehicleMake || lead?.vehicleModel) {
    context.push(`Vehicle interest: ${[lead.vehicleYear, lead.vehicleMake, lead.vehicleModel].filter(Boolean).join(' ')}`);
  }
  if (page?.channel) context.push(`Channel: ${page.channel}`);

  return `CONVERSATION CONTEXT:
${context.length > 0 ? context.join('\n') + '\n\n' : ''}CONVERSATION HISTORY:
${conversationText}

Generate ONE natural, engaging reply for the sales rep to send.`;
}

// ============================================================================
// HELPER: Extract reply from AI response
// ============================================================================
function extractReply(parsed) {
  // Try different possible response formats
  if (typeof parsed?.reply === 'string' && parsed.reply.trim()) {
    return parsed.reply.trim();
  }
  
  if (typeof parsed?.suggestion === 'string' && parsed.suggestion.trim()) {
    return parsed.suggestion.trim();
  }
  
  if (Array.isArray(parsed?.suggestions) && parsed.suggestions[0]) {
    return typeof parsed.suggestions[0] === 'string' 
      ? parsed.suggestions[0].trim() 
      : parsed.suggestions[0]?.text?.trim() || '';
  }
  
  return null;
}

// ============================================================================
// MAIN ENDPOINT
// ============================================================================
app.post('/agent/reply', requireAuth, async (req, res) => {
  try {
    const { messages = [], lead = {}, page = {}, client = {} } = req.body || {};

    console.log('[agent] ========== NEW REQUEST ==========');
    console.log('[agent] Messages:', messages.length);
    console.log('[agent] Has lead data:', !!lead?.name);
    console.log('[agent] Channel:', page?.channel || 'unknown');
    
    // Validation
    if (!messages || messages.length === 0) {
      console.warn('[agent] ❌ No messages provided');
      return res.status(400).json({ 
        suggestions: [],
        error: 'No conversation context provided'
      });
    }

    // Check if OpenAI key is configured
    if (!process.env.OPENAI_API_KEY) {
      console.error('[agent] ❌ OPENAI_API_KEY not set!');
      return res.status(500).json({
        suggestions: [],
        error: 'OpenAI API key not configured'
      });
    }

    console.log('[agent] Building prompts...');
    const system = buildSystemPrompt({ dealership: { name: 'Quirk Chevrolet NH' } });
    const user = buildUserPrompt({ messages, lead, page });

    console.log('[agent] 🤖 Calling OpenAI API...');
    console.log('[agent] Model: gpt-4o');
    
    const startTime = Date.now();
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const duration = Date.now() - startTime;
    console.log('[agent] ✅ OpenAI responded in', duration, 'ms');

    const raw = completion.choices?.[0]?.message?.content || '{}';
    console.log('[agent] Raw response:', raw);
    
    let reply = null;
    
    try {
      const parsed = JSON.parse(raw);
      reply = extractReply(parsed);
      console.log('[agent] ✅ Extracted reply:', reply?.substring(0, 100));
    } catch (parseErr) {
      console.error('[agent] ❌ JSON parse failed:', parseErr.message);
    }

    if (!reply) {
      console.error('[agent] ❌ Could not extract reply from AI response');
      return res.status(500).json({ 
        suggestions: [],
        error: 'AI generated no valid reply',
        debug: { rawResponse: raw.substring(0, 200) }
      });
    }

    // Return as array with single reply (for backward compatibility)
    const suggestions = [reply];

    console.log('[agent] ✅ Returning AI-generated reply');
    console.log('[agent] ========================================\n');
    
    res.json({ 
      suggestions, 
      aiGenerated: true
    });

  } catch (err) {
    console.error('[agent] ❌ FATAL ERROR:', err.message);
    console.error('[agent] Stack:', err.stack);
    
    // Check for specific OpenAI errors
    if (err.message?.includes('API key')) {
      return res.status(500).json({
        suggestions: [],
        error: 'Invalid OpenAI API key'
      });
    }
    
    if (err.message?.includes('quota') || err.message?.includes('insufficient_quota')) {
      return res.status(500).json({
        suggestions: [],
        error: 'OpenAI quota exceeded - check your billing'
      });
    }

    if (err.message?.includes('rate_limit')) {
      return res.status(429).json({
        suggestions: [],
        error: 'Rate limited by OpenAI - try again in a moment'
      });
    }
    
    res.status(500).json({ 
      suggestions: [],
      error: err.message || 'Unknown error calling OpenAI'
    });
  }
});

// ============================================================================
// INVENTORY SEARCH ENDPOINT
// ============================================================================
app.get('/api/inventory/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ 
        success: false, 
        error: 'Query too short',
        vehicles: []
      });
    }
    
    console.log('[Inventory API] Searching for:', q);
    
    const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    
    // Build dynamic search query
    const conditions = terms.map((term, idx) => {
      return `(
        LOWER(make) LIKE $${idx + 1} OR
        LOWER(model) LIKE $${idx + 1} OR
        LOWER(trim) LIKE $${idx + 1} OR
        CAST(year AS TEXT) LIKE $${idx + 1}
      )`;
    });
    
    const params = terms.map(t => `%${t}%`);
    
    const query = `
      SELECT 
        stock_number,
        year,
        make,
        model,
        trim,
        vin,
        body_style,
        exterior_color,
        mileage,
        status
      FROM inventory
      WHERE status = 'available'
      AND (${conditions.join(' AND ')})
      ORDER BY year DESC, make, model
      LIMIT 10
    `;
    
    const result = await pool.query(query, params);
    
    console.log('[Inventory API] Found', result.rows.length, 'matches');
    
    res.json({
      success: true,
      query: q,
      count: result.rows.length,
      vehicles: result.rows
    });
    
  } catch (error) {
    console.error('[Inventory API] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Search failed',
      vehicles: []
    });
  }
});

// ============================================================================
// INVENTORY STATS ENDPOINT
// ============================================================================
app.get('/api/inventory/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_vehicles,
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'sold') as sold,
        MAX(last_scraped_at) as last_updated
      FROM inventory
    `);
    
    res.json({ success: true, stats: stats.rows[0] });
  } catch (error) {
    console.error('[Inventory Stats] Error:', error);
    res.status(500).json({ success: false, error: 'Stats failed' });
  }
});

// ============================================================================
// TRIGGER INVENTORY SCRAPER
// ============================================================================
app.post('/api/inventory/sync', async (req, res) => {
  try {
    console.log('[Inventory Sync] Starting scraper...');
    
    // Check for VIN credentials
    if (!process.env.VIN_USERNAME || !process.env.VIN_PASSWORD) {
      return res.status(500).json({
        success: false,
        error: 'VIN_USERNAME and VIN_PASSWORD environment variables not set'
      });
    }
    
    // Dynamic import to avoid loading puppeteer unless needed
    const scrapeVINInventory = (await import('./scraper/index.js')).default;
    
    const result = await scrapeVINInventory();
    
    console.log('[Inventory Sync] Completed:', result);
    
    res.json({
      success: true,
      message: 'Inventory synced successfully',
      ...result
    });
    
  } catch (error) {
    console.error('[Inventory Sync] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// TEST: Add sample vehicles (for testing only!)
// ============================================================================
app.get('/api/inventory/test-data', async (req, res) => {
  try {
    const sampleVehicles = [
      { stock: 'M37385', year: 2024, make: 'Chevrolet', model: 'Silverado 1500', trim: 'Work Truck' },
      { stock: 'M37410', year: 2024, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT' },
      { stock: 'M37537', year: 2025, make: 'Chevrolet', model: 'Blazer', trim: 'RS' },
      { stock: 'M37564', year: 2024, make: 'Chevrolet', model: 'Equinox', trim: 'LT' },
      { stock: 'M38347', year: 2025, make: 'Chevrolet', model: 'Corvette', trim: 'Stingray' }
    ];
    
    for (const v of sampleVehicles) {
      await pool.query(`
        INSERT INTO inventory (stock_number, year, make, model, trim, status)
        VALUES ($1, $2, $3, $4, $5, 'available')
        ON CONFLICT (stock_number) DO NOTHING
      `, [v.stock, v.year, v.make, v.model, v.trim]);
    }
    
    res.json({ success: true, message: 'Test data inserted!', count: sampleVehicles.length });
  } catch (error) {
    console.error('[Test Data] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// SETUP: Create database table (run once)
// ============================================================================
app.get('/api/setup/create-table', async (req, res) => {
  try {
    console.log('[Setup] Creating inventory table...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        stock_number VARCHAR(50) UNIQUE NOT NULL,
        vin VARCHAR(17),
        year INTEGER,
        make VARCHAR(100),
        model VARCHAR(100),
        trim VARCHAR(100),
        body_style VARCHAR(100),
        engine VARCHAR(255),
        transmission VARCHAR(255),
        exterior_color VARCHAR(100),
        interior_color VARCHAR(100),
        mileage INTEGER,
        status VARCHAR(50) DEFAULT 'available',
        location VARCHAR(255),
        price_msrp DECIMAL(10,2),
        price_internet DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('[Setup] Creating indexes...');
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_number ON inventory(stock_number)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_year_make_model ON inventory(year, make, model)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_status ON inventory(status)`);
    
    console.log('[Setup] ✅ Table and indexes created successfully!');
    
    res.json({ 
      success: true, 
      message: 'Database table created successfully!' 
    });
    
  } catch (error) {
    console.error('[Setup] ❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// START SERVER
// ============================================================================
app.listen(PORT, () => {
  console.log(`🚀 VIN Agent service running on :${PORT}`);
});
