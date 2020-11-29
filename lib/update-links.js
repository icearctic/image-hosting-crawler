const { updateLinks } = require('./links');


(async () => {
	await updateLinks();
})().catch(console.error);
