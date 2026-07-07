import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5176/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const dataUrl = await page.evaluate(() => {
	const c = document.createElement('canvas');
	c.width = 240; c.height = 240;
	const g = c.getContext('2d');
	const grad = g.createLinearGradient(0, 0, 240, 240);
	grad.addColorStop(0, '#ff0055'); grad.addColorStop(0.5, '#22cc88'); grad.addColorStop(1, '#3355ff');
	g.fillStyle = grad; g.fillRect(0, 0, 240, 240);
	g.fillStyle = '#ffffff'; g.fillRect(100, 100, 40, 40);
	return c.toDataURL('image/png');
});
const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
await page.locator('input[type=file]').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer });
await page.waitForTimeout(200);
await page.locator('.size-chip', { hasText: 'S' }).first().click();
await page.waitForTimeout(100);

const canvas = page.locator('canvas');
const stats = async (label) => {
	const s = await page.evaluate(() => {
		const c = document.querySelector('canvas');
		const ctx = c.getContext('2d', { willReadFrequently: true });
		const { data } = ctx.getImageData(0, 0, c.width, c.height);
		let nonWhite = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3] !== 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) nonWhite++;
		}
		return { pct: +(100 * nonWhite / (c.width * c.height)).toFixed(1) };
	});
	console.log(label, JSON.stringify(s));
};

await page.locator('.thumb').first().click(); // deselect
await page.waitForTimeout(100);
let box = await canvas.boundingBox();
const A = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.45 };
const B = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.7 };
await page.mouse.click(A.x, A.y); await page.waitForTimeout(120);
await page.mouse.move(B.x, B.y); await page.mouse.click(B.x, B.y); await page.waitForTimeout(150);
await stats('2 rocks:');

// Enable "fill every shape" background.
await page.locator('.thumb-bg').first().click();
await page.waitForTimeout(250);
await stats('bg fill ON (2 rocks):');
await page.screenshot({ path: 'scripts/b1-bg-on.png' });

// Click on a rock while bg is on.
await page.mouse.click(A.x, A.y); await page.waitForTimeout(200);
await stats('after click on rock (bg on):');
await page.screenshot({ path: 'scripts/b2-click-bg.png' });

// Real drag on the background image.
await page.mouse.move(A.x, A.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(A.x + i * 6, A.y + i * 4); await page.waitForTimeout(20); }
await page.mouse.up();
await page.waitForTimeout(200);
await stats('after drag bg image:');
await page.screenshot({ path: 'scripts/b3-drag-bg.png' });

// Wheel zoom in a LOT on bg.
for (let i = 0; i < 15; i++) { await page.mouse.move(A.x, A.y); await page.mouse.wheel(0, -120); await page.waitForTimeout(25); }
await page.waitForTimeout(200);
await stats('after big wheel zoom-in bg:');
await page.screenshot({ path: 'scripts/b4-wheel-bg.png' });

// Place NEW shapes while bg on.
const pts = [ {x:0.5,y:0.25}, {x:0.3,y:0.75}, {x:0.7,y:0.4} ];
for (const p of pts) {
	const P = { x: box.x + box.width * p.x, y: box.y + box.height * p.y };
	await page.mouse.move(P.x, P.y); await page.waitForTimeout(60);
	await page.mouse.click(P.x, P.y); await page.waitForTimeout(150);
}
await stats('after placing 3 new shapes (bg on):');
await page.screenshot({ path: 'scripts/b5-newshapes-bg.png' });

// Toggle bg off then on again.
await page.locator('.thumb-bg').first().click(); await page.waitForTimeout(200);
await stats('bg OFF:');
await page.locator('.thumb-bg').first().click(); await page.waitForTimeout(200);
await stats('bg ON again:');
await page.screenshot({ path: 'scripts/b6-bg-toggle.png' });

// Single-rock bg test: clear, place 1 rock, enable bg.
await page.locator('.clear').click(); await page.waitForTimeout(200);
box = await canvas.boundingBox();
const S = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
// bg is still on from before but no rocks; place one rock.
await page.mouse.move(S.x, S.y); await page.waitForTimeout(60);
await page.mouse.click(S.x, S.y); await page.waitForTimeout(200);
await stats('single rock with bg on:');
await page.screenshot({ path: 'scripts/b7-single-rock-bg.png' });

await browser.close();
console.log('done');
