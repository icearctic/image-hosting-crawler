require('core-js/features/string/replace-all');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const split2 = require('split2');

const { initDb } = require('./db');


// http://photoshare.ru/photo12345678.html
const PHOTO_PAGE_REGEXP = /(?:https?:\/\/|)(?:www\.|)photoshare\.ru\/photo\d+\.html/g;
// http://photoshare.ru/album123456.html
const ALBUM_PAGE_REGEXP = /(?:https?:\/\/|)(?:www\.|)photoshare\.ru\/album\d+\.html/g;
// http://photoshare.ru/office/image.php?id=12345678
const PHOTO_PAGE_LEGACY_REGEXP = /(?:https?:\/\/|)(?:www\.|)photoshare\.ru\/office\/image\.php\?id=\d+/g;
// http://photoshare.ru/office/album.php?id=123456
const ALBUM_PAGE_LEGACY_REGEXP = /(?:https?:\/\/|)(?:www\.|)photoshare\.ru\/office\/album\.php\?id=\d+/g;
// http://109.r.photoshare.ru/01234/00a73657fd9518597f0a2552f0ad6959d7b86786.jpg
const IMAGE_FULL_REGEXP = /https?:\/\/\d+\.r\.photoshare\.ru\/\d+\/[a-z0-9]+\.jpe?g/g;
// http://photoshare.ru/data/12/34567/8/4f45l6-tms.jpg
const IMAGE_THUMB_REGEXP = /(?:https?:\/\/|)(?:www\.|)photoshare\.ru\/data\/\d+\/\d+\/\d+\/[a-z0-9-]+\.jpe?g(?:\?\d*|)/g

const FIXED_URL_PREFIX = process.env.FIXED_URL_PREFIX;
const FIXED_URL_BROKEN = `${FIXED_URL_PREFIX}/unavailable.jpg`;

const getLinks = async () => {
	const dbDumpPath = path.resolve(process.env.DB_DUMP_PATH);
	const dbDumpStream = fs.createReadStream(dbDumpPath, { encoding: 'utf8'}).pipe(split2());

	let links = [];

	for await (const line of dbDumpStream) {
		let matches;

		if (matches = line.match(ALBUM_PAGE_REGEXP)) {
			links.push(...matches.map(link => ({
				link,
				type: 'album'
			})));
		}

		if (matches = line.match(ALBUM_PAGE_LEGACY_REGEXP)) {
			links.push(...matches.map(link => ({
				link,
				type: 'album'
			})));
		}

		if (matches = line.match(PHOTO_PAGE_REGEXP)) {
			links.push(...matches.map(link => ({
				link,
				type: 'photo'
			})));
		}

		if (matches = line.match(PHOTO_PAGE_LEGACY_REGEXP)) {
			links.push(...matches.map(link => ({
				link,
				type: 'photo'
			})));
		}

		if (matches = (line.match(IMAGE_FULL_REGEXP))) {
			links.push(...matches.map(link => ({
				link,
				type: 'full'
			})));
		}

		if (matches = (line.match(IMAGE_THUMB_REGEXP))) {
			links.push(...matches.map(link => ({
				link,
				type: 'thumb'
			})));
		}
	}

	console.log('Total links:', links.length);

	// remove dupes
	links = [...new Map(links.map(linkObj => [linkObj.link, linkObj])).values()];
	console.log('Total links deduped:', links.length);

	return links;
};

const updateLinks = async () => {
	const dbDumpPath = path.resolve(process.env.DB_DUMP_PATH);
	const dbDumpStream = fs.createReadStream(dbDumpPath, { encoding: 'utf8'}).pipe(split2());

	const dbFixedPath = path.resolve(process.env.DB_DUMP_FIXED_PATH);
	const dbUnfixedPath = path.resolve(process.env.DB_DUMP_FIXED_PATH);
	const dbFixedHandle = await fsp.open(dbFixedPath, 'w');
	const dbUnfixedHandle = await fsp.open(dbUnfixedPath, 'w');

	const db = await initDb();
	const processedLinksCollection = db.get('processedLinks');

	let totalLinesCount = 0;
	let modifiedLinesCount = 0;

	for await (const originalLine of dbDumpStream) {
		let line = originalLine;
		let matches;

		// albums
		matches = [...(line.match(ALBUM_PAGE_REGEXP) || []), ...(line.match(ALBUM_PAGE_LEGACY_REGEXP) || [])];
		for (const albumLink of matches) {
			const albumLinkObj = processedLinksCollection.find({ link: albumLink, type: 'album' }).value();

			if (!albumLinkObj) {
				console.warn('Missing album link:', albumLink);
			} else if (albumLinkObj.state === 'completed') {
				const imageLinks = db.get('processedLinks')
				.filter(({ type, parent, state }) => type === 'photo' && state === 'completed' && parent === albumLink)
				.flatMap(({ link: photoLink }) => (
					db.get('processedLinks')
					.filter(({ type, parent, state }) => type === 'full' && state === 'completed' && parent === photoLink)
					.map('link')
					.value()
				))
				.value();

				if (albumLink === 'http://photoshare.ru/office/album.php?id=379419') {
					line = line.replaceAll(
						'[url=http://photoshare.ru/office/album.php?id=379419]фото[/url]',
						imageLinks.map(link => `[url=${fixFullImageLink(link)}]фото[/url]`).join(' ')
					);
				} else if (albumLink === 'http://photoshare.ru/office/album.php?id=419447') {
					line = line.replaceAll(
						'http://photoshare.ru/office/album.php?id=419447',
						imageLinks.map((link, i) => `[url=${fixFullImageLink(link)}]${i + 1}[/url]`).join(' ')
					);
				} else {
					line = line.replaceAll(
						albumLink,
						imageLinks.map(link => fixFullImageLink(link)).join(' ')
					);
				}
			} else if (albumLinkObj.state === 'not found' || albumLinkObj.state === 'forbidden') {
				line = line.replaceAll(
					albumLink,
					FIXED_URL_BROKEN
				);
			} else {
				console.warn('Unprocessed album link:', albumLink);
			}
		}

		// photos
		matches = [...(line.match(PHOTO_PAGE_REGEXP) || []), ...(line.match(PHOTO_PAGE_LEGACY_REGEXP) || [])];
		for (const photoLink of matches) {
			const photoLinkObj = processedLinksCollection.find({ link: photoLink, type: 'photo' }).value();

			if (!photoLinkObj) {
				console.warn('Missing photo link:', photoLink);
			} else if (photoLinkObj.state === 'completed') {
				const imageLinks = db.get('processedLinks')
				.filter(({ type, parent, state }) => type === 'full' && state === 'completed' && parent === photoLink)
				.map('link')
				.value();

				line = line.replaceAll(
					photoLink,
					imageLinks.map(link => fixFullImageLink(link)).join(' ')
				);
			} else if (photoLinkObj.state === 'not found' || photoLinkObj.state === 'forbidden') {
				line = line.replaceAll(
					photoLink,
					FIXED_URL_BROKEN
				);
			} else {
				console.warn('Unprocessed photo link:', photoLink);
			}
		}

		// full images
		matches = line.match(IMAGE_FULL_REGEXP) || [];
		for (const imageLink of matches) {
			const imageLinkObj = processedLinksCollection.find({ link: imageLink, type: 'full' }).value();

			if (!imageLinkObj) {
				console.warn('Missing full image link:', imageLink);
			} else if (imageLinkObj.state === 'completed') {
				line = line.replaceAll(
					imageLink,
					fixFullImageLink(imageLink)
				);
			} else if (imageLinkObj.state === 'not found' || imageLinkObj.state === 'forbidden') {
				line = line.replaceAll(
					imageLink,
					FIXED_URL_BROKEN
				);
			} else {
				console.warn('Unprocessed full image link:', imageLink);
			}
		}

		// thumb images
		matches = line.match(IMAGE_THUMB_REGEXP) || [];
		for (const imageLink of matches) {
			const imageLinkObj = processedLinksCollection.find({ link: imageLink, type: 'thumb' }).value();

			if (!imageLinkObj) {
				console.warn('Missing full image link:', imageLink);
			} else if (imageLinkObj.state === 'completed') {
				line = line.replaceAll(
					imageLink,
					fixThumbImageLink(imageLink)
				);
			} else if (imageLinkObj.state === 'not found' || imageLinkObj.state === 'forbidden') {
				line = line.replaceAll(
					imageLink,
					FIXED_URL_BROKEN
				);
			} else {
				console.warn('Unprocessed full image link:', imageLink);
			}
		}

		totalLinesCount++;

		if (line !== originalLine) {
			modifiedLinesCount++;
			await dbFixedHandle.write(line + os.EOL, { encoding: 'utf8' });
			await dbUnfixedHandle.write(originalLine + os.EOL, { encoding: 'utf8' });
		}
	}

	console.log('Total lines:', totalLinesCount);
	console.log('Modified lines:', modifiedLinesCount);
};

const normalizeUrl = (url) => {
	return url
	.replace(/^(?:https?:\/\/|)(?:www\.|)photoshare\.ru\//i, 'http://photoshare.ru/')
	.replace(/^http:\/\/photoshare\.ru\/office\/album\.php\?id=(\d+)$/i, 'http://photoshare.ru/album$1.html')
	.replace(/^http:\/\/photoshare\.ru\/office\/image\.php\?id=(\d+)$/i, 'http://photoshare.ru/photo$1.html')
	.replace(/^(http:\/\/photoshare\.ru\/data\/\d+\/\d+\/\d+\/[a-z0-9-]+\.jpe?g)(?:\?\d*|)$/i, '$1');
};

const fixFullImageLink = (link) => {
	const url = normalizeUrl(link);
	const imageName = path.parse(new URL(url).pathname).base;

	return `${FIXED_URL_PREFIX}/full/${imageName}`;
};

const fixThumbImageLink = (link) => {
	const url = normalizeUrl(link);
	const imageName = path.parse(new URL(url).pathname).base;

	return `${FIXED_URL_PREFIX}/${imageName}`;
};

module.exports = {
	getLinks,
	updateLinks,
	normalizeUrl
};
