process.env.DEBUG = [process.env.DEBUG, 'pw:api'].filter(Boolean).join();

const assert = require('assert');
const delay = require('delay');
const fs = require('fs');
const fsp = require('fs').promises;
const got = require('got');
const isJpg = require('is-jpg');
const path = require('path');
const playwright = require('playwright');
const PQueue = require('p-queue').default;
const winston = require('winston');

const { initDb } = require('./db');
const { normalizeUrl } = require('./links');


const FULL_PATH = path.join(__dirname, '../image-full');
const THUMB_PATH = path.join(__dirname, '../image-thumb');

const CONCURRENCY = 5;
const RETRIES = 10;
const RETRY_DELAY = 500;
const REQUEST_TIMEOUT = 60000;

const STATE_FORBIDDEN = 'forbidden';
const STATE_NOT_FOUND = 'not found';
const STATE_EMPTY = 'empty';
const STATE_COMPLETED = 'completed';


const logger = winston.createLogger({
	format: winston.format.combine(
		winston.format.errors({ stack: true }),
		winston.format.timestamp(),
    	winston.format.prettyPrint()
	),
	transports: [
		new winston.transports.Console({ level: 'verbose' }),
		new winston.transports.File({ filename: 'crawl.log' })
	]
});

const queue = new PQueue({
	concurrency: CONCURRENCY,
	autoStart: false
});

(async () => {
	let browser;

	try {
		// db
		const db = await initDb();
		const processedLinks = db.get('processedLinks').value();

		// browser
		browser = await playwright.chromium.launch();
		const browserContext = await browser.newContext({
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.75 Safari/537.36'
		});

		browserContext.setDefaultTimeout(REQUEST_TIMEOUT);
		await browserContext.route(/^(?!https?:\/\/[^\/]*photoshare.ru\/)/, route => route.abort('blockedbyclient'));

		for (const linkObj of processedLinks) {
			if (!linkObj.state) {
				queue.add(createTask({ db, browserContext, linkObj }));
			}
		}

		await queue.start().onIdle();
		logger.verbose('Completed');
	} finally {
		await browser.close();
	}
})().catch(console.error);

function getRetryDelay() {
	return RETRY_DELAY + RETRY_DELAY * Math.random();
}

function createTask({ db, browserContext, linkObj }) {
	const { link, type, parent } = linkObj;
	let { state } = linkObj;
	const url = normalizeUrl(link);
	const isImageType = type === 'full' || type === 'thumb';


	async function getReplacementImage(link, retry = 0) {
		const type = 'photo';
		const url = normalizeUrl(link);
		let page;
		
		try {
			page = await browserContext.newPage();

			const response = await page.goto(url);

			if (!response.ok()) {
				throw new ResponseError(response.status());
			}

			// const fullImageLink = await page.$eval('a[itemprop="contentURL"]', node => node.href);
			const thumbImageLink = await page.$eval('img[itemprop="thumbnail"]', node => node.src);

			try {
				await page.close();
			} catch {}

			return thumbImageLink;
		} catch (err) {
			try {
				await page.close();
			} catch {}			

			if (retry < RETRIES) {
				logger.verbose('Retrying link: ' + link);
				await delay(getRetryDelay());
				await getReplacementImage(link, retry + 1);
			} else {
				logger.warn('Replacement image query failed: ' + link);
			}
		}
	}


	async function simpleTask() {
		logger.verbose('Image: ' + url);

		const imageName = path.parse(new URL(url).pathname).base;
		assert(imageName, 'Image filename');
		const imagePath = path.join(type === 'full' ? FULL_PATH : THUMB_PATH, imageName);


		if (fs.existsSync(imagePath)) {
			logger.info('Image exists, skipping: ' + url);

			if (!state) {
				state = STATE_COMPLETED;

				await db.get('processedLinks')
				.find({ link })
				.assign({ state })
				.write();
			}

			return;
		}

		try {
			let response = await got(url, {
				responseType: 'buffer',
				headers: {
					'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.75 Safari/537.36'
				},
				retry: {
					limit: RETRIES,
					// calculateDelay: getRetryDelay,
					maxRetryAfter: RETRY_DELAY * 2
				},
				timeout: REQUEST_TIMEOUT,
				throwHttpErrors: false
			});


			if (response.statusCode === 403) {
				state = STATE_FORBIDDEN;
				throw new StatusError(state);
			} else if (response.statusCode === 404) {
				state = STATE_NOT_FOUND;

				if (parent) {
					const thumbImageLink = await getReplacementImage(parent);

					if (!thumbImageLink)
						throw new StatusError(state);

					const recoveredUrl = normalizeUrl(thumbImageLink).replace(/(http:\/\/photoshare\.ru\/data\/\d+\/\d+\/)(\d+)(\/[a-z0-9-]+\.jpe?g)/, '$15$3');

					response = await got(recoveredUrl, {
						responseType: 'buffer',
						headers: {
							'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.75 Safari/537.36'
						},
						retry: {
							limit: RETRIES,
							// calculateDelay: getRetryDelay,
							maxRetryAfter: RETRY_DELAY * 2
						},
						timeout: REQUEST_TIMEOUT,
						throwHttpErrors: true
					});

					await db.get('processedLinks')
					.find({ link })
					.assign({ recoveredLink: recoveredUrl })
					.write();			
				} else {
					throw new StatusError(state);
				}
			} else if (response.statusCode !== 200) {
				throw new ResponseError(response.statusCode);
			}

			if (!isJpg(response.body)) {
				throw new ImageError();
			}

			await fsp.writeFile(imagePath, response.body);
			logger.verbose('Image saved: ' + url);

			state = STATE_COMPLETED;

			await db.get('processedLinks')
			.find({ link })
			.assign({ state })
			.write();			
		} catch (err) {
			if (err instanceof ResponseError) {
				logger.warn('Task failed: ' + link);
			} if (err instanceof StatusError) {
				logger.warn('Link unavailable: ' + link);

				await db.get('processedLinks')
				.find({ link })
				.assign({ state })
				.write();
			} else {
				logger.error('Task error: ' + link, { err });
			}
		}
	}

	async function browserTask(retry = 0) {
		logger.verbose('Page: ' + url);

		let page;
		
		try {
			page = await browserContext.newPage();

			const response = await page.goto(url, {
				...(isImageType && { referer: 'http://photoshare.ru' })
			});

			if (response.status() === 403 || response.request().url().startsWith('http://photoshare.ru/login/')) {
				state = STATE_FORBIDDEN;
				throw new StatusError(state);
			} else if (response.status() === 404 || response.request().url() === 'http://photoshare.ru/404.php') {
				state = STATE_NOT_FOUND;
				throw new StatusError(state);
			} else if (!response.ok()) {
				throw new ResponseError(response.status());
			}

			if (type === 'album') {
				if (await page.$('img[src="/images/mpp.gif"]')) {
					await page.evaluate(() => change_mpp(100));
					await page.reload();
				}

				if (await page.$('img[src="/images/mpp.gif"]'))
					throw new Error('Album is too big');

				const photoLinks = await page.$$eval('td > div.photo > a', nodes => nodes.map(node => node.href));

				if (photoLinks.length) {
					await db.get('processedLinks')
					.push(
						...photoLinks
						.filter(link => !db.get('processedLinks').find({ link }).value())
						.map(link => ({
							link,
							type: 'photo',
							state: null,
							parent: link
						})
					))
					.write();
				} else {
					state = STATE_EMPTY;
					logger.warn('Album: no photos');
				}
			} else if (type === 'photo') {
				const fullImageLink = await page.$eval('a[itemprop="contentURL"]', node => node.href);
				// const thumbImageLink = await page.$eval('img[itemprop="thumbnail"]', node => node.src);

				if (!db.get('processedLinks').find({ link: fullImageLink }).value()) {					
					await db.get('processedLinks')
					.push({
						link: fullImageLink,
						type: 'full',
						state: null,
						parent: link
					})
					.write();
				}
			} else {
				throw new Error('Unknown type: ' + link);
			}

			state = STATE_COMPLETED;

			await db.get('processedLinks')
			.find({ link })
			.assign({ state })
			.write();

			try {
				await page.close();
			} catch {}			
		} catch (err) {
			try {
				await page.close();
			} catch {}			

			if (err instanceof playwright.errors.TimeoutError || err instanceof ResponseError) {
				if (retry < RETRIES) {
					logger.verbose('Retrying link: ' + link);
					await delay(getRetryDelay());
					await browserTask(retry + 1);
				} else {
					logger.warn('Task failed: ' + link);
				}
			} if (err instanceof StatusError) {
				logger.warn('Link unavailable: ' + link);

				await db.get('processedLinks')
				.find({ link })
				.assign({ state })
				.write();
			} else {
				logger.error('Task error: ' + link, { err });
			}
		}
	}

	return isImageType ? simpleTask : browserTask;
}

class ResponseError extends Error {
	get name() {
		return 'ResponseError';
	}
}

class StatusError extends Error  {
	get name() {
		return 'StatusError';
	}
}

class ImageError extends Error  {
	get name() {
		return 'ImageError';
	}
}
