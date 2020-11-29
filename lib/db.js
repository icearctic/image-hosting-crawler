const lowdb = require('lowdb');
const LowdbFileAsync = require('lowdb/adapters/FileAsync');
const path = require('path');


const DB_PATH= path.join(__dirname, '../db.json');

exports.initDb = async () => {
	const db = await lowdb(new LowdbFileAsync(DB_PATH));
	await db.defaults({ messageLinks: null, processedLinks: null }).write();
	await db.read();

	let messageLinks = db.get('messageLinks').value();

	if (!messageLinks) {
		messageLinks = await getLinks();
		await db.set('messageLinks', messageLinks).write();
	}

	let processedLinks = db.get('processedLinks').value();

	if (!processedLinks) {
		processedLinks = messageLinks.map(({ link, type }) => ({
			link,
			type,
			state: null
		}));
		await db.set('processedLinks', processedLinks).write();
	}

	return db;
}
