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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set a reasonable default timeout
    page.setDefaultTimeout(60000);
    
    // Login to VIN Solutions
    console.log('🔐 Logging in to VIN Solutions...');
    console.log('🔗 URL:', VIN_LOGIN_URL);
    
    await page.goto(VIN_LOGIN_URL, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    // Wait for and fill login form
    console.log('⏳ Waiting for login form...');
    await page.waitForSelector('input[name="username"], input[type="email"], input[id*="user"], input[name="loginId"]', { 
      timeout: 20000 
    });
    
    // Try different possible login field selectors
    const usernameField = await page.$('input[name="username"]') || 
                          await page.$('input[type="email"]') ||
                          await page.$('input[name="loginId"]') ||
                          await page.$('input[id*="user"]') ||
                          await page.$('input[placeholder*="mail"]') ||
                          await page.$('input[placeholder*="sername"]');
    
    const passwordField = await page.$('input[name="password"]') ||
                          await page.$('input[type="password"]') ||
                          await page.$('input[placeholder*="assword"]');
    
    if (!usernameField || !passwordField) {
      console.error('❌ Could not find login fields on page');
      throw new Error('Could not find login fields on page');
    }
    
    console.log('✍️  Entering credentials...');
    await usernameField.type(VIN_USERNAME, { delay: 50 });
    await passwordField.type(VIN_PASSWORD, { delay: 50 });
    
    console.log('🔑 Submitting login form...');
    
    // Submit form - try multiple methods
    try {
      await Promise.all([
        page.waitForNavigation({ 
          waitUntil: 'networkidle2',
          timeout: 60000 
        }),
        page.keyboard.press('Enter')
      ]);
    } catch (navError) {
      console.log('⚠️  Navigation via Enter failed, trying submit button...');
      const submitButton = await page.$('button[type="submit"]') || 
                           await page.$('input[type="submit"]') ||
                           await page.$('button:has-text("Login")') ||
                           await page.$('button:has-text("Sign In")');
      
      if (submitButton) {
        await Promise.all([
          page.waitForNavigation({ 
            waitUntil: 'networkidle2',
            timeout: 60000 
          }),
          submitButton.click()
        ]);
      } else {
        throw new Error('Could not submit login form');
      }
    }
    
    console.log('✅ Logged in successfully');
    
    // Wait a bit for dashboard to fully load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Navigate to dashboard first to establish session
    console.log('📋 Navigating to dashboard...');
    await page.goto('https://vinsolutions.app.coxautoinc.com/vinconnect/pane-both/vinconnect-dealer-dashboard', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    console.log('✅ On dashboard, changing to inventory view...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Change the hash fragment instead of full navigation (maintains session)
    await page.evaluate(() => {
      window.location.hash = '#/CarDashboard/ploader.aspx?TargetControl=Inventory/autosp.ascx&SelectedTab=t_Inventory';
    });
    
    console.log('✅ Changed to inventory hash');
    
    // Wait for initial page load
    console.log('⏳ Waiting for page to initialize...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Scroll down to trigger any lazy loading
    console.log('📜 Scrolling page to trigger content loading...');
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Scroll back up
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('📊 Looking for iframe with inventory table...');
    
    // ============================================
    // OPTION 3: DYNAMIC IFRAME WAITING
    // Keep checking every 2 seconds for up to 30 seconds
    // ============================================
    
    let inventoryFrame = null;
    const maxAttempts = 15; // 15 attempts * 2 seconds = 30 seconds
    let attempt = 0;
    
    while (!inventoryFrame && attempt < maxAttempts) {
      attempt++;
      console.log(`🔄 Attempt ${attempt}/${maxAttempts}: Searching for inventory iframe...`);
      
      // Wait for any iframe to exist
      try {
        await page.waitForSelector('iframe', { timeout: 5000 });
      } catch (err) {
        console.log(`  ⏳ No iframes found yet, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      // Get all frames
      const frames = page.frames();
      console.log(`  🔍 Found ${frames.length} frame(s) on page`);
      
      // Check each frame for the inventory table
      for (const frame of frames) {
        const frameUrl = frame.url();
        
        // Skip signin/auth frames - we want the app frame
        if (frameUrl.includes('signin.coxautoinc.com')) {
          console.log(`  ⏭️  Skipping signin frame`);
          continue;
        }
        
        console.log(`  🔎 Checking frame: ${frameUrl.substring(0, 80)}...`);
        
        try {
          // Check if this frame contains a table
          const hasTable = await frame.$('table');
          
          if (hasTable) {
            // Count cells to verify it's the inventory table
            const cellCount = await frame.evaluate(() => {
              const cells = document.querySelectorAll('table td');
              return cells.length;
            });
            
            console.log(`     📊 Found table with ${cellCount} cells`);
            
            // Inventory table should have many cells (>50 for just a few vehicles)
            if (cellCount > 50) {
              console.log(`  ✅ Found inventory table in frame!`);
              inventoryFrame = frame;
              break;
            } else {
              console.log(`     ⚠️  Table too small, likely not inventory table`);
            }
          } else {
            console.log(`     ℹ️  No table found in this frame`);
          }
        } catch (err) {
          // Frame might not be accessible or still loading
          console.log(`     ⚠️  Could not access frame: ${err.message}`);
        }
      }
      
      // If we found the frame, exit the loop
      if (inventoryFrame) {
        break;
      }
      
      // Wait 2 seconds before next attempt
      console.log(`  ⏳ Inventory iframe not found, waiting 2 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Check if we found the frame
    if (!inventoryFrame) {
      console.error('❌ Could not find inventory iframe after 30 seconds');
      console.error('💡 The page may need more time to load, or the structure has changed');
      throw new Error('Could not find iframe containing inventory table after 30 seconds');
    }
    
    console.log('🎉 Successfully located inventory iframe!');
    console.log('🔍 Extracting vehicle data from iframe...');
    
    // Scrape all vehicle data from the iframe (not the main page!)
    const vehicles = await inventoryFrame.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1); // Skip header
      
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 8) return null;
        
        // CORRECT column mapping based on your screenshot:
        // Col 1: Photos
        // Col 2: Stock # (M37385)
        // Col 3: Desk icon
        // Col 4: Autotrader icon  
        // Col 5: CARFAX VB Yr Make (24 Chevrolet)
        // Col 6: Model (Silverado MD)
        // Col 7: Trim (Work Truck)
        // Col 8: VIN (HTKJPVM4RH178232)
        
        const stockNumber = cells[1]?.textContent?.trim() || '';  // Column 2
        const carfaxText = cells[4]?.textContent?.trim() || '';   // Column 5: "24 Chevrolet"
        const modelText = cells[5]?.textContent?.trim() || '';    // Column 6
        const trimText = cells[6]?.textContent?.trim() || '';     // Column 7
        const vin = cells[7]?.textContent?.trim() || '';          // Column 8
        
        // Parse year and make from "24 Chevrolet" or "2024 Chevrolet" format
        let year = null;
        let make = '';
        
        if (carfaxText) {
          const parts = carfaxText.split(/\s+/);
          if (parts.length >= 2) {
            const yearStr = parts[0];
            make = parts.slice(1).join(' ');
            
            // Parse year (might be "24" or "2024")
            year = parseInt(yearStr);
            if (year && !isNaN(year)) {
              if (year < 100) {
                year = 2000 + year; // Convert "24" to "2024"
              }
            } else {
              year = null;
            }
          }
        }
        
        return {
          stock_number: stockNumber,
          year: year,
          make: make,
          model: modelText,
          trim: trimText,
          vin: vin || null,
          status: 'available'
        };
      }).filter(v => v && v.stock_number);
    });
    
    console.log(`✅ Found ${vehicles.length} vehicles`);
    
    if (vehicles.length === 0) {
      console.warn('⚠️  WARNING: No vehicles found in table!');
      console.warn('⚠️  Table structure may have changed or page did not load correctly');
      return {
        success: false,
        error: 'No vehicles found in table',
        vehiclesFound: 0,
        inserted: 0,
        updated: 0,
        errors: 0
      };
    }
    
    // Log first few vehicles for debugging
    console.log('📋 Sample vehicles (first 3):');
    vehicles.slice(0, 3).forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.year} ${v.make} ${v.model} ${v.trim} (Stock: ${v.stock_number})`);
    });
    
    // Update database
    console.log('💾 Updating database...');
    
    let insertedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    
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
            updated_at = NOW(),
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
        errorCount++;
      }
    }
    
    console.log(`✅ Database updated successfully!`);
    console.log(`   📊 Summary: ${insertedCount} new, ${updatedCount} updated, ${errorCount} errors`);
    
    return {
      success: true,
      vehiclesFound: vehicles.length,
      inserted: insertedCount,
      updated: updatedCount,
      errors: errorCount
    };
    
  } catch (error) {
    console.error('❌ Scraper error:', error.message);
    console.error('📍 Stack trace:', error.stack);
    throw error;
  } finally {
    if (browser) {
      console.log('🔒 Closing browser...');
      await browser.close();
      console.log('✅ Browser closed');
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeVINInventory()
    .then(result => {
      console.log('🎉 Scraper completed successfully!');
      console.log('📊 Final results:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Scraper failed!');
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

export default scrapeVINInventory;
