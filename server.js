/**
 * cert-renderer — geração de PDF via Puppeteer (Chrome real)
 * v2 — tolerante a recursos externos lentos + logs de diagnóstico
 */

const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const PDF_TOKEN = process.env.PDF_TOKEN || '';

app.use(express.json({ limit: '12mb' }));
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });
  return _browser;
}

app.get('/', (_req, res) => res.json({ service: 'cert-renderer', ok: true }));
app.get('/pdf/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/** Rota de teste: abre no navegador e vê um PDF de exemplo. */
app.get('/pdf/teste', async (_req, res) => {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap" rel="stylesheet">
    <style>
      @page { size: A4 landscape; margin: 0; }
      body { margin:0; font-family:'Fraunces',Georgia,serif; -webkit-print-color-adjust:exact; }
      .p { width:297mm; height:210mm; background:linear-gradient(135deg,#FAF3E6,#F0DFC0);
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8mm; }
      h1 { color:#12213F; font-size:40pt; margin:0; }
      img { width:90mm; }
    </style></head><body>
    <div class="p"><h1>Teste OK</h1><img src="/assets/cert-art.png" alt=""></div>
    </body></html>`;
  try {
    const pdf = await renderPdf(html, { landscape: true });
    res.set({ 'Content-Type': 'application/pdf' });
    res.end(pdf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

async function renderPdf(html, options = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  const problemas = [];
  page.on('requestfailed', (r) => problemas.push(r.url() + ' -> ' + (r.failure() && r.failure().errorText)));
  page.on('pageerror', (e) => problemas.push('JS: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problemas.push('console: ' + m.text()); });

  try {
    await page.setViewport({ width: 1123, height: 794, deviceScaleFactor: 2 });

    // domcontentloaded em vez de networkidle0: nao trava se uma fonte demorar
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Espera fontes, mas com teto de 8s
    await Promise.race([
      page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())),
      new Promise((r) => setTimeout(r, 8000)),
    ]);

    // Espera imagens, mas com teto de 10s
    await Promise.race([
      page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(
          imgs.map((i) =>
            i.complete
              ? Promise.resolve()
              : new Promise((r) => { i.onload = i.onerror = r; })
          )
        );
      }),
      new Promise((r) => setTimeout(r, 10000)),
    ]);

    // Diagnostico: o body tem conteudo mesmo?
    const info = await page.evaluate(() => ({
      altura: document.body ? document.body.scrollHeight : 0,
      texto: document.body ? document.body.innerText.trim().length : 0,
      imgs: Array.from(document.images).map((i) => ({
        src: i.src.split('/').pop(),
        w: i.naturalWidth,
      })),
    }));
    console.log('[pdf] body:', JSON.stringify(info));
    if (problemas.length) console.log('[pdf] problemas:', problemas.slice(0, 8));

    const pdf = await page.pdf({
      format: options.format || 'A4',
      landscape: options.landscape !== false,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      timeout: 45000,
    });

    console.log('[pdf] gerado:', pdf.length, 'bytes');
    return pdf;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

app.post('/pdf', async (req, res) => {
  if (PDF_TOKEN && req.get('x-pdf-token') !== PDF_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { html, filename = 'documento.pdf', options = {} } = req.body || {};
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'campo "html" obrigatorio' });
  }

  console.log('[pdf] recebido HTML de', html.length, 'caracteres');

  try {
    const pdf = await renderPdf(html, options);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': pdf.length,
    });
    return res.end(pdf);
  } catch (err) {
    console.error('[pdf] erro:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
});

app.listen(PORT, () => console.log(`cert-renderer rodando na porta ${PORT}`));
