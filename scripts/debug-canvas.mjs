import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', (msg) => console.log(`[console:${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
console.log('canvas box:', box);

// Move over the canvas (ghost should appear), then click to place.
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/shot-hover.png' });

await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/shot-placed.png' });

// Inspect canvas pixels: count non-white pixels to see if anything rendered.
const stats = await page.evaluate(() => {
	const c = document.querySelector('canvas');
	const ctx = c.getContext('2d');
	const { data } = ctx.getImageData(0, 0, c.width, c.height);
	let nonWhite = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] !== 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) nonWhite++;
	}
	return {
		attrSize: { w: c.width, h: c.height },
		cssSize: { w: c.clientWidth, h: c.clientHeight },
		nonWhite
	};
});
console.log('canvas stats:', stats);

await browser.close();
