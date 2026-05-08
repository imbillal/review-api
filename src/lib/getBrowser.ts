import puppeteerCore, {type Browser} from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const initialArgs = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--disable-dev-shm-usage',
	'--disable-accelerated-2d-canvas',
	'--disable-gpu',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--disable-features=TranslateUI',
	'--disable-web-security',
	'--disable-features=VizDisplayCompositor',
];

export async function getBrowser(
	args: string[] = initialArgs,
): Promise<Browser> {
	const isDev =
		process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
	if (isDev) {
		// `puppeteer` is a devDependency — bundles a local Chromium for
		// development only. Production uses puppeteer-core + @sparticuz/chromium
		// so the function bundle stays under Vercel's 250 MB limit and the
		// binary actually runs in Lambda's Linux environment.
		const {default: puppeteer} = await import('puppeteer');
		return (await puppeteer.launch({
			headless: true,
			args,
			timeout: 30000,
		})) as unknown as Browser;
	}
	// In serverless prod (Vercel), use @sparticuz/chromium's args — they include
	// flags required for the read-only Lambda filesystem and small /tmp.
	return await puppeteerCore.launch({
		args: chromium.args,
		executablePath: await chromium.executablePath(),
		timeout: 30000,
		headless: true,
	});
}
