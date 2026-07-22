/**
 * cert-renderer — serviço de geração de PDF via Puppeteer (Chrome real)
 * Recebe HTML, devolve PDF. Usado pela Central de Certificados (Apps Script).
 */

const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const PDF_TOKEN = process.env.PDF_TOKEN || '';

app.use(express.json({ limit: '12mb' }));

// Imagens do certificado: /assets/cert-art.png
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

/* ---------- Browser reutilizado entre requisições ---------- */
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

/* ---------- Rotas ---------- */

app.get('/', (_req, res) => {
  res.json({ service: 'cert-renderer', ok: true });
});

app.get('/pdf/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/pdf', async (req, res) => {
  if (PDF_TOKEN && req.get('x-pdf-token') !== PDF_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { html, filename = 'documento.pdf', options = {} } = req.body || {};
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'campo "html" obrigatorio' });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1123, height: 794, deviceScaleFactor: 2 });

    await page.setContent(html, {
      waitUntil: ['load', 'networkidle0'],
      timeout: 45000,
    });

    // Espera webfonts carregarem
    await page.evaluate(() => document.fonts && document.fonts.ready);

    // Espera imagens decodificarem
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((i) =>
          i.complete
            ? Promise.resolve()
            : new Promise((r) => {
                i.onload = i.onerror = r;
              })
        )
      );
    });

    const pdf = await page.pdf({
      format: options.format || 'A4',
      landscape: options.landscape !== false,
      printBackground: true, // CRITICO: sem isso perde cores e gradientes
      preferCSSPageSize: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      timeout: 45000,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': pdf.length,
    });
    return res.end(pdf);
  } catch (err) {
    console.error('[pdf] erro:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`cert-renderer rodando na porta ${PORT}`);
});
