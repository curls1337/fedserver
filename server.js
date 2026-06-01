require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;

  if (!userId || !password) {
    return res.status(400).json({ success: false, message: 'User ID and password are required' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto('https://www.fedex.com/secure-login/en-gb/#/credentials', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Dismiss cookie banner if present
    try {
      const cookieBtn = page.locator('button:has-text("ACCEPT ALL COOKIES")');
      if (await cookieBtn.isVisible({ timeout: 3000 })) {
        await cookieBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {
      // Cookie banner might not appear
    }

    // Fill User ID
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.fill('#username', userId);

    // Fill Password
    await page.fill('input[type="password"]', password);

    // Click Log in button
    await page.click('#login_button');

    // Wait for navigation or response
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    const pageTitle = await page.title();

    // Check if login was successful
    const isLoggedIn = !currentUrl.includes('/credentials') && !currentUrl.includes('secure-login');

    // Take screenshot for verification
    const screenshot = await page.screenshot({ encoding: 'base64' });

    await browser.close();

    if (isLoggedIn) {
      return res.json({
        success: true,
        message: 'Login successful',
        redirectedTo: currentUrl,
        pageTitle,
        screenshot: `data:image/png;base64,${screenshot}`
      });
    }

    // Check for error messages
    let errorMessage = 'Login failed';
    try {
      const errorEl = await page.textContent('[class*="error"], [class*="alert"], .notification--error');
      if (errorEl) errorMessage = errorEl.trim();
    } catch {
      // No error element found
    }

    return res.json({
      success: false,
      message: errorMessage,
      currentUrl,
      pageTitle,
      screenshot: `data:image/png;base64,${screenshot}`
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      message: `Automation error: ${err.message}`
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`FedServer running on port ${PORT}`);
});
