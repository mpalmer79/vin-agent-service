import puppeteer from 'puppeteer';
import pg from 'pg';
import { config } from 'dotenv';

config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function scrapeVINInventory() {
  console.log('🕷️  Starting VIN Solutions inventory scraper...');
  
  const VIN_USERNAME = process.env.VIN_USERNAME;
  const VIN_PASSWORD = process.env.VIN_PASSWORD;
  const VIN_LOGIN_URL = process.env.VIN_LOGIN_URL || 'https://www.vinsolutions.com/';
  
  if (!VIN_USERNAME || !VIN_PASSWORD) {
    throw new Error('VIN_USERNAME and VIN_PASSWORD must be set in environment variables');
  }
  
  let browser;
  
  try {
    // Launch browser
    console.log('🌐 Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Login to VIN Solutions
    console.log('🔐 Logging in to VIN Solutions...');
    await page.goto(VIN_LOGIN_URL, { waitUntil: 'networkidle2' });
    
    // Wait for and fill login form
    await page.waitForSelector('input[name="username"], input[type="email"], input[id*="user"]', { timeout: 10000 });
    
    // Try different possible login field selectors
    const usernameField = await page.$('input[name="username"]') || 
                          await page.$('input[type="email"]') ||
                          await page.$('input[id*="user"]');
    
    const passwordField = await page.$('input[name="password"]') ||
                          await page.$('input[type="password"]');
    
    if (!usernameField || !passwordField) {
      throw new Error('Could not find login fields');
    }
    
    await usernameField.type(VIN_USERNAME);
    await passwordField.type(VIN_PASSWORD);
    
    // Submit form
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.keyboard.press('Enter')
    ]);
    
    console.log('✅ Logged in successfully');
    
    // Navigate to Browse Inventory
    console.log('📋 Navigating to inventory page...');
    
    // Look for Browse Inventory link
    await page.waitForSelector('a[href*="inventory"], a:has-text("Browse Inventory"), a:has-text("Inventory")', { timeout: 10000 });
    
    const inventoryLink = await page.$('a[href*="inventory"]') ||
                          await page.evaluateHandle(() => {
                            const links = Array.from(document.querySelectorAll('a'));
                            return links.find(a => a.textContent.includes('Browse Inventory') || a.textContent.includes('Inventory'));
                          });
    
    if (inventoryLink) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        inventoryLink.click()
      ]);
    }
    
    console.log('📊 Scraping inventory table...');
    
    // Wait for inventory table
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Scrape all vehicle data
    const vehicles = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1); // Skip header
      
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return null;
        
        const stockNumber = cells[1]?.textContent?.trim() || '';
        const yearText = cells[3]?.textContent?.trim() || '';
        const makeText = cells[4]?.textContent?.trim() || '';
        const modelText = cells[5]?.textContent?.trim() || '';
        const trimText = cells[6]?.textContent?.trim() || '';
        const vin = cells[7]?.textContent?.trim() || '';
        
        // Parse year (might be "24" or "2024")
        let year = parseInt(yearText);
        if (year < 100) {
          year = 2000 + year; // Convert "24" to "2024"
        }
        
        return {
          stock_number: stockNumber,
          year: year || null,
          make: makeText,
          model: modelText,
          trim: trimText,
          vin: vin || null,
          status: 'available'
        };
      }).filter(v => v && v.stock_number);
    });
    
    console.log(`✅ Found ${vehicles.length} vehicles`);
    
    // Update database
    console.log('💾 Updating database...');
    
    let insertedCount = 0;
    let updatedCount = 0;
    
    for (const vehicle of vehicles) {
      try {
        const result = await pool.query(`
          INSERT INTO inventory (stock_number, year, make, model, trim, vin, status, last_scraped_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (stock_number) 
          DO UPDATE SET 
            year = EXCLUDED.year,
            make = EXCLUDED.make,
            model = EXCLUDED.model,
            trim = EXCLUDED.trim,
            vin = EXCLUDED.vin,
            status = EXCLUDED.status,
            last_scraped_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [
          vehicle.stock_number,
          vehicle.year,
          vehicle.make,
          vehicle.model,
          vehicle.trim,
          vehicle.vin,
          vehicle.status
        ]);
        
        if (result.rows[0].inserted) {
          insertedCount++;
        } else {
          updatedCount++;
        }
      } catch (err) {
        console.error(`❌ Error upserting vehicle ${vehicle.stock_number}:`, err.message);
      }
    }
    
    console.log(`✅ Database updated: ${insertedCount} inserted, ${updatedCount} updated`);
    
    return {
      success: true,
      vehiclesFound: vehicles.length,
      inserted: insertedCount,
      updated: updatedCount
    };
    
  } catch (error) {
    console.error('❌ Scraper error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeVINInventory()
    .then(result => {
      console.log('✅ Scraper completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Scraper failed:', error);
      process.exit(1);
    });
}

export default scrapeVINInventory;
