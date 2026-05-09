import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('brakkegrond') && !u.match(/\.(?:css|svg|woff2?|png|jpe?g|gif)$/) &&
    (u.includes('/api/') || u.includes('graphql') || u.includes('.json'))) {
    apis.push(`${req.method()} ${u}`);
  }
});
await page.goto('https://brakkegrond.nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
for (let i = 0; i < 5; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.waitForTimeout(800);
}
const data = (await page.evaluate(`(() => {
  const links = Array.from(document.querySelectorAll('a[href*="/agenda/"]')).map(a => a.href);
  return Array.from(new Set(links)).slice(0, 30);
})()`)) as string[];
console.log(`agenda-links na render: ${data.length}`);
for (const l of data.slice(0, 12)) console.log(' ', l);
console.log('\napi calls:', apis.length);
for (const a of apis) console.log(' ', a);
await browser.close();
process.exit(0);
