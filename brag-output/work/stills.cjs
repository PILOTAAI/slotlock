const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('file://' + process.cwd() + '/video.html');
  await p.evaluate(() => document.fonts.ready);
  for (const t of process.argv.slice(2).map(Number)) {
    await p.evaluate(t => render(t), t);
    await p.screenshot({ path: `still-${t}.png` });
  }
  await b.close();
})();
