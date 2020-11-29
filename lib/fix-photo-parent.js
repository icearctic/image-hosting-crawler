const fsp = require('fs').promises;
const path = require('path');

const { initDb } = require('./db');


(async () => {
	const db = await initDb();
	const links = db.get('processedLinks').value();
	const albums = db.get('processedLinks').filter({ type: 'album', state: 'completed' }).value();
	for (const albumObj of albums) {
		const albumId = albumObj.link.match(/\d{3,}/);
		const albumHtml = await fsp.readFile(path.join(__dirname, `../albums/album${albumId}.html`), { encoding: 'utf8' });
		const photoIds = [...albumHtml.matchAll(/id="photo_(\d+)"/g)].map(([, id]) => id);
		const photos = db.get('processedLinks').filter(linkObj => linkObj.type === 'photo' && photoIds.some(id => new RegExp(`(?<!\d)${id}(?!\d)`).test(linkObj.link))).value();
		for (const photoObj of photos) {
			photoObj.parent = albumObj.link;
		}
		console.log('Album:', albumObj.link);
		console.log('Photos:', photos.length);
		console.log();
	}
	await db.set('processedLinks', links).write();
})().catch(console.error);
