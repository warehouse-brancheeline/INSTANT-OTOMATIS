const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { print } = require('pdf-to-printer');

/**
 * Jubelio's /reports/... endpoints don't return a raw PDF - they return an HTML
 * page hosting a Telerik report viewer that builds the document client-side via
 * a sequence of API calls (create client -> instance -> document -> poll -> pages).
 * The simplest reliable way to get real, printable PDFs is to render that page in
 * a real (headless) browser and export it, rather than reimplementing Telerik's
 * undocumented REST protocol.
 *
 * The viewer's own page (`.trv-pages-area`) wraps each report page in toolbar/
 * chrome and a dark surrounding canvas - capturing the whole viewport prints that
 * chrome too. Each actual page's content lives in its own `.sheet.pageN` element,
 * so each one is isolated (everything else hidden) and captured separately, sized
 * to its own natural dimensions - one PDF file per report page, matching how a
 * thermal label printer expects one label per print job anyway.
 */
async function renderReportUrlToPdfs(url, filenameHint) {
  const browser = await puppeteer.launch({ headless: 'new' });
  const filePaths = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The Telerik viewer polls its own report-generation job in the background;
    // "networkidle" is not a reliable signal since polling gaps can exceed it
    // while the report is still rendering. Wait for its own on-page status text
    // instead ("Done. Total N pages loaded.") - that's what actually means ready.
    await page.waitForFunction(
      () => /Done\.\s*Total\s+\d+\s+pages?\s+loaded/i.test(document.body.innerText || ''),
      { timeout: 45000, polling: 500 }
    );

    // The "Done" status text can land a beat before the .sheet element is
    // actually attached to the DOM; poll briefly rather than failing immediately.
    let pageCount = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      pageCount = await page.evaluate(
        () => document.querySelectorAll('.sheet[class*="page"]').length
      );
      if (pageCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (pageCount === 0) {
      throw new Error('report rendered but no page content (.sheet) was found');
    }

    for (let i = 0; i < pageCount; i++) {
      const rect = await page.evaluate((index) => {
        document.querySelectorAll('.__isolate-style').forEach((s) => s.remove());
        const style = document.createElement('style');
        style.className = '__isolate-style';
        style.textContent = `
          body * { visibility: hidden !important; }
          .__print-target, .__print-target * { visibility: visible !important; }
          html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
        `;
        document.head.appendChild(style);

        document
          .querySelectorAll('.__print-target')
          .forEach((el) => el.classList.remove('__print-target'));

        const target = document.querySelectorAll('.sheet[class*="page"]')[index];
        target.classList.add('__print-target');
        target.style.position = 'fixed';
        target.style.top = '0';
        target.style.left = '0';
        target.style.margin = '0';
        target.style.boxShadow = 'none';
        target.style.border = 'none';

        const r = target.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }, i);

      const filePath = path.join(
        os.tmpdir(),
        `label-${filenameHint || Date.now()}-p${i + 1}-${Date.now()}.pdf`
      );
      await page.pdf({
        path: filePath,
        printBackground: true,
        width: `${(rect.width / 96).toFixed(2)}in`,
        height: `${(rect.height / 96).toFixed(2)}in`,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      filePaths.push(filePath);
    }
  } finally {
    await browser.close();
  }
  return filePaths;
}

/**
 * Prints a PDF file silently to the Windows default printer (no dialog).
 */
async function printPdf(filePath) {
  await print(filePath);
}

/**
 * Renders every page of the Jubelio report URL to its own clean PDF and prints
 * each one silently in order, cleaning up temp files after.
 */
async function printLabelFromUrl(url, filenameHint) {
  const filePaths = await renderReportUrlToPdfs(url, filenameHint);
  try {
    for (const filePath of filePaths) {
      await printPdf(filePath);
    }
  } finally {
    for (const filePath of filePaths) {
      fs.unlink(filePath, () => {});
    }
  }
}

module.exports = { renderReportUrlToPdfs, printPdf, printLabelFromUrl };
