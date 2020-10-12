/*
This is a testing script for Corefarm, by Nuno Chinaglia Poli.
Requires Nodejs.

For more information about Corefarm:
http://github.com/nunocp/corefarm

//==== SCRIPT ====
Requires: Nodejs

This script downloads the home page from 'www.example.com' as a html file and
append a suffix to its name (first given argument to the script call).

*/

const fs = require('fs');
const http = require('http');

// Defines working directory the same as where the executing script are.
//process.chdir(__dirname);
console.log (`Current working directory: ${process.cwd()}`);

// Save html file as name + suffix (first given arg).
// Note: User-defined arguments starts at argv[2].
const filename = `index-${process.argv[2]}.html`;

// Fake delay for testing dependency between jobs.
const delay = 0;

const options = {
	hostname: 'www.example.com',
	method: 'GET',
	//timeout: 10000,
	headers: {
		'Content-Type': 'text/html'
	}
};

console.log (`Requesting ${options.hostname}...`);
const req = http.request (options, (resp)  => {
	let data = '';

	// A chunk of data has been received.
	resp.on('data', (chunk) => {
		data += chunk;
	});

	// The whole response has been received. Save as html file.
	resp.on('end', () => {
		try {
			fs.writeFileSync (filename, data);
		} catch (err) {
			console.error(`ERROR!\n${err.message}`);
			process.exit(1);
		}
		console.log (`Page downloaded successfully as ${filename}`);
		console.log (`Start fake delay of ${delay} ms...`);
		setTimeout(()=>{
			console.log (`Done.`);
		}, delay);

	});

});

req.on ('timeout', () => {
	req.abort();
	console.error(`TIMEOUT!\n${options.hostname}`);
});

req.on("error", (err) => {
	console.error(`ERROR!\n${err.message}`);
});

//req.write ('');
req.end();