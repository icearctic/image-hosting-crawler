const { initDb } = require('./db');


const [filter] = process.argv.slice(2);

(async () => {
	// db
	const db = await initDb();
	const links = db.get('processedLinks').value();

	console.log('Incomplete links:', links.filter(({ type, state }) => !state).length);
	console.log('Completed links:', links.filter(({ type, state }) => state === 'completed').length);
	console.log('Failed links:', links.filter(({ type, state }) => state && state !== 'completed').length);
	console.log();
	console.log('Completed albums:', links.filter(({ type, state }) => type === 'album' && state === 'completed').length);
	console.log('Failed albums:', links.filter(({ type, state }) => type === 'album' && state && state !== 'completed').length);
	console.log();
	console.log('Completed photos:', links.filter(({ type, state }) => type === 'photo' && state === 'completed').length);
	console.log('Failed photos:', links.filter(({ type, state }) => type === 'photo' && state && state !== 'completed').length);
	console.log();
	console.log('Completed images:', links.filter(({ type, state }) => (type === 'full' || type === 'thumb') && state === 'completed').length);
	console.log('Failed images:', links.filter(({ type, state }) => (type === 'full' || type === 'thumb') && state && state !== 'completed').length);
	console.log('Failed full images:', links.filter(({ type, state }) => type === 'full' && state && state !== 'completed').length);
	console.log('Failed thumb images:', links.filter(({ type, state }) => type === 'thumb' && state && state !== 'completed').length);
	// console.log(links.filter(({ type, state }) => type === 'thumb' && state && state !== 'completed').map(({ link }) => link));

	console.log();
//	console.log('Recoverable:', links.filter(({ type, state }) => (type === 'full' || type === 'thumb') && state === 'completed').length);
})().catch(console.error);
