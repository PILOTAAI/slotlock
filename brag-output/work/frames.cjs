const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('file://' + process.cwd() + '/video.html');
  await p.evaluate(() => document.fonts.ready);
  require('fs').mkdirSync('frames', { recursive: true });
  for (let f = 0; f < 600; f++) {
    await p.evaluate(t => render(t), f / 30);
    await p.screenshot({ path: `frames/f${String(f).padStart(4,'0')}.jpg`, type: 'jpeg', quality: 95 });
  }
  await b.close();
})();
