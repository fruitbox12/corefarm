/*
This is a testing script for Corefarm, by Nuno Chinaglia Poli.
Requires Nodejs.

For more information about Corefarm:
http://github.com/nunocp/corefarm

//==== SCRIPT ====
Requires: Nodejs
Intended to use with example script 'download.js'.

This script reads and merges two or more files into 'index-merged.html'.

*/

const fs = require('fs');

// Defines working directory the same as where the executing script are.
//process.chdir(__dirname);
console.log (`Current working directory: ${process.cwd()}`);

const output_filename = 'index-merged.html';

for (var i = 2; i < process.argv.length; i++) {
	var filename = process.argv[i];

	try {
		console.log (`Reading and merging file '${filename}'...`);
		var data = fs.readFileSync (filename);
		fs.appendFileSync (output_filename, data);
	} catch (err) {
		console.error (err.message);
		process.exit(1);
	}
}

console.log (`Result: ${output_filename}`);