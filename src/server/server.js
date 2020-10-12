/*
Copyright (c) 2020 Nuno Chinaglia Poli. All rights reserved.
Corefarm v0.1.0-alpha - zlib license

=======================================
COREFARM - SERVER

The server automatically handle distribution of jobs' tasks
to available clients.

It works by responding to http requests from clients and managers.

Managers are used as interface to control a server.
Tags can be assigned to jobs, forming inter-jobs dependencies, like starting
a job only after other job with specific tag is completed.
See COREFARM MANAGER for more.

Some TODO:
- Save jobs status periodically; re-assign unfinished jobs ('working' or 'error') at startup.
- Cleaning of log and cache files.
- Needs more documentation.

Job JSON example:
[
	{
		"name": "Download www.example.com",
		"tags": ["download"],
		"dependencies": [],
		"threads_per_task": 1,
		"tasks": [
			{
				"name": "Download as index-1.html",
				"call": "nodejs",
				"args": ["../../example/download.js", "1"]
			},
			{
				"name": "Download as index-2.html",
				"call": "nodejs",
				"args": ["../../example/download.js", "2"]
			}
		]
	},
	{
		"name": "Merge 'index-#.html' files",
		"tags": [],
		"dependencies": ["download"],
		"threads_per_task": 0,
		"tasks": [
			{
				"name": "Merge",
				"call": "nodejs",
				"args": ["../../example/merge.js", "index-1.html", "index-2.html"]
			}
		]
	}
]

=======================================
*/

//=============
//  BOOTING
//=============

const fs = require('fs');
const os = require('os');
const util = require('util');
const http = require('http');

// Defines working directory same as server executable (script).
process.chdir(__dirname);

const app = {
    name: 'Corefarm',
    version: '0.1',

    //start_time: new Date().getTime(),
    //running_time: 0,

    options: {} // Where 'config' and 'args' are merged then checked for safety.
};
process.title = `${app.name} Server @ ${os.hostname()}`;

const args = process_args();

const config_file = 'server.json';

// Default settings. 	"ip": "192.168.0.102",
var config = {
	ip: '0.0.0.0',
	port: 8081,
	database: '', // Where server stores stuff. Defined by the user in config file.

	dashboard_html: 'res/index.html', // TODO: Web GUI.

	//log: true,

	// Milliseconds
	client_ping: 15000, // Interval to check if connected clients are still available.
	save: 5000, // TOD. Interval to save tasks statuses.
	update_screen: 2000,
};

// Read config file, important to define a specific ip:port for server to listen.
try {
    if (!fs.existsSync(config_file)) {
        fs.writeFileSync(config_file, JSON.stringify(config, null, '\t'), 'utf8');
    }
    Object.assign(config, JSON.parse(fs.readFileSync (config_file)));    
} catch (err) {
   console.error (err.message);
   //process.exit(1);
}

if (config.database == '' || config.database == undefined || config.database == null) {
    console.error (`Database path undefined. Please, set it in ${config_file}.`);
    process.exit(1);
}

// Merge user-defined settings. Overriding order (asc): default < config file < cli arguments.
Object.assign(app.options, config);
Object.assign(app.options, args);
app.options.save = safe_value(app.options.save, 2000);

// TODO: Move this var to 'app'.
var dir = get_database_folders (app.options.database);

// TODO: Web GUI.
var dashboard_html;
try { dashboard_html = fs.readFileSync (app.options.dashboard_html); }
catch (err) { dashboard_html = `Error while reading file '${app.options.dashboard_html}'. Please, check configuration and restart server.<br><br>${err}`; }

//================================
//		MAIN
//================================

var server = {
	hostname: os.hostname(),
	ip: '',
	port: '',
	ip_family: '', // IPv4 or IPv6

	//client_online: 15000,
	//client_offline: 30000,
};

var clients = [];
var jobs = [];

var needs_saving = false; // TODO. Used by the saving function.

// Executes server.
(async () => {
	check_dirs ();
	load_jobs (); // Load jobs stored on disk.

	const srv = http.createServer(listener);
	await new Promise ((resolve, reject) => {
		/*
		//TODO
		srv.on('error', (e) => {
		  if (e.code === 'EADDRINUSE') {
		    console.error('Address already in use.');
		    srv.close();
		  }
		});
		*/

		srv.listen (app.options.port, app.options.ip, () => {
			server.ip = srv.address().address;
			server.port = srv.address().port;
			server.family = srv.address().family;

			get_reachable_ips();
			resolve();
		});
	});

	//fs.writeFileSync (app.options.database + '/server_info.json', JSON.stringify(server, null, '\t'), 'utf8');
	
	render();
	if (app.options.update_screen > 0) {
		setInterval (render, app.options.update_screen);
	}

	//setInterval (save, app.options.save);
})();

//================================
//      SERVER - GENERAL
//================================

// Listen for http requests.
async function listener (req, resp) {
	var data = '';	
	var request = {};
	
	var response = '';

	// Download request first.
	await new Promise ((resolve) => {
		req.on('data', (chunk) => {
			data += chunk;
		});
		req.on('end', () => {
			resolve();
		});
	});

	// Responses.
	if (req.method == 'GET') {
		// TODO: web GUI.
		
		try { dashboard_html = fs.readFileSync (app.options.dashboard_html); }
		catch (err) { dashboard_html = `Error while reading file '${app.options.dashboard_html}'. Please, check configuration and restart server.<br><br>${err}`; }
		response = dashboard_html;

		resp.setHeader("Content-Type", "text/html");
		resp.setHeader("charset", "utf-8");
		resp.writeHead(200);
		resp.end(response);
		
	} else {

		// Parse JSON, error 404 otherwise.
		try {
			request = JSON.parse(data);
		} catch (err) {
			resp.writeHead(404);
			resp.end(err);
			return;
		}

		// Respond.
		if (request.request == '') {
			response = '';//JSON.stringify ({response:});
		} else if (request.request == 'client-update') {
			var update = client_update (request.data, req);
			var new_tasks = assign_tasks (update.client.id);
	
			response = JSON.stringify({
				response: 'update',
				data: {
					client: update.client,
					new_tasks: new_tasks,
					tasks_to_remove: update.tasks_to_remove,
				}
			});
		} else if (request.request == 'add-jobs') {
			var added = add_jobs (request.data);
	
			response = JSON.stringify({
				response: 'ok',
				data: added
			});
		} else {
			resp.writeHead(404);
			resp.end('Invalid request.');
			return;
		}
	
		// Send response.
		resp.setHeader("Content-Type", "application/json");
		resp.writeHead(200);
		resp.end(response);
	}
}

// Save jobs and tasks status to disk.
// TODO.
function save () {
	if (needs_saving == true) {
		for (job of jobs) {
			try {
				fs.writeFile (`${dir.jobs}/${job.id}/job.json`, JSON.stringify(job, null, '\t'), 'utf8', ()=>{});
			} catch (err) {
				console.error (err);
				process.exit(1);
			}
		}

		needs_saving = false;
	}
}

//================================
//      SERVER - JOBS
//================================

// Load jobs from disk.
function load_jobs () {
	var d = dir.jobs;
	var items = fs.readdirSync(d);
	
    for (item of items) {
        var fullpath = d + '/' + item;
        if (fs.statSync(fullpath).isDirectory() && fs.existsSync(fullpath + '/job.json')) {
			var job;
			try {
				job = JSON.parse(fs.readFileSync (fullpath + '/job.json'));
			} catch (err) {
				console.log (err.message);
			}

			jobs.push(validate_job(job));
        }
    }
}

// Insert jobs to servers' list.
function add_jobs (received_jobs) {
	var added = [];
	for (received of received_jobs) {
		received = validate_job (received);
		received.id = new_job_id();
		received.status = 'pending';
		received.errors = [];

		for (task of received.tasks) {
			task.status = 'pending';
		}

		for (var i = 0; i < jobs.length; i++) {
			if (jobs[i].id == received.id) {
				jobs[i] = received;
				break;
			}
		}
		var json = JSON.stringify (received, null, '\t');
		var folder = `${dir.jobs}/${received.id}`;
		try {
			fs.mkdirSync(folder);
			fs.writeFile (`${folder}/job.json` , json, 'utf8', ()=>{});
		} catch (err) {

		}

		added.push ({name: received.name, id: received.id, task_count: received.tasks.length});
	}

	return added;
}

// Generate and validate unique ID.
function new_job_id () {
	var retry = true;
	while (retry == true) {
		var id = datetime().replace(/ /g, '-').replace(/:/g,'') + '-' + (new Date()).getMilliseconds();
		var exists = false;
		for (job of jobs) {
			if (job.id == id) {
				exists = true;
				break;
			}
		}
		if (exists == false) {
			jobs.push({id: id});
			return id;
		}
	}
}

// Get a job's index by its ID.
function get_job_index (id) {
	var index = -1;
	for (var i = 0; i < jobs.length; i++) {
		if (jobs[i].id == id) {
			index = i;
			break;
		}
	}
	return index;
}

// Validate and sanitize job properties.
function validate_job (job) {
	job.tags = job.tags || [];
	job.dependencies = job.dependencies || [];
	job.threads_per_task = job.threads_per_task || 0;

	//job.count_pending = job.count_pending || 0;
	//job.count_error = job.count_error || 0;
	//job.count_completed = job.count_completed || 0;

	for (var task of job.tasks) {
		task.args = task.args || [];
		task.status = task.status || 'pending';
		//if (task.status != 'completed' || task.status != 'error') { job.count_pending++; }
	}

	return job;
}

//================================
//      SERVER - TASKS
//================================

// Assign pending tasks to a given client.
function assign_tasks (client_id) {
	var client = clients[get_client_index (client_id)];
	var new_tasks = [];

	var remaining = client.free_threads;
	while (remaining > 0) {
		var t;

		//console.log ('next_pending_task ' + remaining);
		if (remaining == client.max_threads) {
			//console.log ('using max threads');
			t = next_pending_task (0);
		} else {
			//console.log ('limited threads');
			t = next_pending_task (remaining);
		}
		
		if (t) {
			if (t.task_threads == 0) {
				remaining = 0;
			} else {
				remaining -= t.task_threads;
			}

			var job, task;
			job = jobs[t.job_index];
			task = jobs[t.job_index].tasks[t.task_index];

			task.status = 'assigned';
			task.client = client.id;
			new_tasks.push ({
				job: {
					id: job.id,
					name: job.name,
					threads_per_task: job.threads_per_task,
					working_dir: job.working_dir
				},
				task: Object.assign({index: t.task_index}, task),
			});
		} else {
			break;
		}
	}

	if (new_tasks.length > 0) {
		needs_saving = true;
	}

	return new_tasks;
}

// Returns next pending task.
function next_pending_task (free_threads) {
	for (var j = 0; j < jobs.length; j++) {
		var job = jobs[j];
		if (solve_job_dependencies(job) == true) {
			for (var t = 0; t < job.tasks.length; t++) {
				var task = job.tasks[t];
				
				if (task.status == 'pending') {
					if (free_threads == 0 && job.threads_per_task == 0) {
						return {job_index: j, task_index: t, task_threads: job.threads_per_task};
					} else if (job.threads_per_task > 0) {
						return {job_index: j, task_index: t, task_threads: job.threads_per_task};
					}
				}
			}
		}
	}
}

// Check if a job is ready to start according to its dependencies. 
function solve_job_dependencies (job) {
	for (var dep of job.dependencies) {
		for (var jb of jobs) {
			if (jb.tags.includes(dep) && count_tasks(jb, 'completed') != jb.tasks.length) {
				return false;
			}
		}
	}
	return true;
}

// Count tasks of a job with a given status.
function count_tasks (job, status) {
	var count = 0;
	for (task of job.tasks) {
		if (task.status == status) { count++; }
	}
	return count;
}

//================================
//      SERVER - CLIENTS
//================================

// Update client status and assign pending tasks necessary.
function client_update (client, req) {
	var index = get_client_index (client.id);
	if (index < 0) { index = register_client (client, req); }

	var tasks_to_remove = [];
	for (tsk of client.tasks) {
		if (tsk.task.status == 'completed' || tsk.task.status == 'error') { tasks_to_remove.push(tsk); }

		var job_index = get_job_index (tsk.job.id);
		var task = jobs[job_index].tasks[tsk.task.index];

		if (task.status != tsk.task.status) { needs_saving = true; }
		task.status = tsk.task.status;
	}

	clients[index].free_threads = client.free_threads;
	clients[index].last_alive = new Date().getTime();

	return { client: clients[index], tasks_to_remove: tasks_to_remove };
}

// Get client index by ID.
function get_client_index (id) {
	var index = -1;
	for (var i = 0; i < clients.length; i++) {
		if (clients[i].id == id) {
			index = i;
			break;
		}
	}
	return index;
}

// "Connect" a new client with server.
// TODO: Handle multiple clients on same computer.
function register_client (client, req) {
	client.ip = req.connection.remoteAddress;
	client.port = req.connection.remotePort;
	client.id = `${client.hostname}-${client.ip}:${client.port}`;
	clients.push(client);
	var index = clients.length - 1;
	clients[index].last_alive = new Date().getTime();
	return index;
}

/*
// TODO: Periodically check if registered clients are still alive.
function ping_clients () {
	
}
*/

//============================
//      SERVER - MISC
//============================

// TO BE CHANGED.
function get_database_folders (database_root) {
	if (database_root) {
		var dir = {};
		dir.database = database_root;
//		dir.clients = dir.database + '/clients';
//		dir.errors = dir.database + '/errors';
		dir.jobs = dir.database + '/jobs';
		return dir;
	}
}

function check_dirs () {
	var error = false;
	for (d in dir) {
		if (!fs.existsSync(dir[d])) {
			//console.error (`ERROR! Directory doesn't exist, ${dir[d]}`);
			//error = true;
			console.log (`Database's directory not found. Creating ${dir[d]}`);
			fs.mkdirSync(dir[d], {recursive: true});
		}
	}
	//if (error) { process.exit(1); }
}

// "Render" terminal screen every app.options.update_screen
function render () {
	var jobs_pending = 0;
	var jobs_completed = 0;
	var jobs_error = 0;

	var tasks_total = 0;
	var tasks_pending = 0;
	var tasks_completed = 0;
	var tasks_error = 0;

	for (job of jobs) {
		tasks_total += job.tasks.length;
		tasks_pending += count_tasks(job, 'pending') + count_tasks(job, 'assigned') + count_tasks(job, 'working');
		tasks_completed += count_tasks(job, 'completed');
		tasks_error += count_tasks(job, 'error');
	}

	//--- "RENDER" ----
	var render = [];
	console.clear();
	render.push ('');
    render.push (`${app.name.toUpperCase()} SERVER ${app.version}`);
    if (server.ip == '0' || server.ip == '0.0.0.0') {
	    render.push (`${server.hostname} @ [undefined/all]*:${server.port}`);
    } else {
	    render.push (`${server.hostname} @ ${server.ip}:${server.port}`);
    }

    render.push (`${datetime()}\n`);
    
    render.push (`DATABASE: ${app.options.database}`);
    if (server.ip == '0' || server.ip == '0.0.0.0') {
		render.push (`SERVER URL: [undefined/all]*:${server.port}\n`);
		render.push (`*IP address for the server is not configured. Please, set it in ${config_file}\n`); 	
    } else {
		render.push (`WEB: http://${server.ip}:${server.port}\n`);    	
    }


    render.push (`SERVER ERRORS: ${0}\n`);

	render.push (`Clients: ${clients.length}\n`);

	render.push (`Jobs: ${jobs.length}`);// \t( Pending: ${0} \tCompleted: ${0} \tError: ${0} )`);
	render.push (`Tasks: ${tasks_total} \t(Pending:${tasks_pending}  Error:${tasks_error}  Completed:${tasks_completed})\n`);

	render.push ('======== JOBS ========');
    var index = 1;
    for (job of jobs) {
		render.push (`${index}. '${job.name}' (${job.tasks.length}:${count_tasks(job, 'error')}/${count_tasks(job,'completed')}) deps:[${job.dependencies}] tags:[${job.tags}] threads_per_task:${job.threads_per_task}`);
		var task_index = 0;
		for (task of job.tasks) {
			if (task.status == 'error') {
				render.push (`\t${task.status} '${job.name}'[${task_index}] > '${task.name}'`);
			}
			task_index++;
		}

		index++;
	}
	if (jobs.length <= 0) { render.push('(None)');  }

	console.log (render.join('\n    '));
}


//================================
//      UTILITIES
//================================

// Extract arguments from this process call.
// TODO: Use '-' and '--' instead of ':'. GNU style?
// TODO: Better arguments interpreter.
function process_args () {
	var a = {};
	for (var i = 2; i < process.argv.length; i++) {
		var string = process.argv[i];
		var kv = string.split('=');
		a[kv[0]] = kv[1];
	}
	return a;
}

// Return a safe number if given one is beyond min/max range. Essentialy a clipping function.
function safe_value (variable, min, max) {
    if (variable < min && min != undefined) { variable = min; }
    if (variable > max  && max != undefined) { variable = max; }
    return variable;
}

// Return today as string.
function today () {
	var agora = new Date();
	var mes = (agora.getMonth() + 1);
	var dia = agora.getDate();
	if (mes < 10)
		mes = "0" + mes;
	if (dia < 10)
		dia = "0" + dia;
	var hoje = agora.getFullYear() + '-' + mes + '-' + dia;
	return hoje;
}

// Return now as string.
function now () {
	var agora = new Date();
	var hours =  agora.getHours();
	var min = agora.getMinutes();
	var secs = agora.getSeconds();
	if (hours < 10) { hours = '0' + hours; }
	if (min < 10) { min = '0' + min; }
	if (secs < 10) { secs = '0' + secs; }
	return hours + ':' + min + ':' + secs;
}

// Return datetime as string.
function datetime () {
	return today() + ' ' + now();
}

// TODO
// Test which host's ips are reachable by local network.
// It's used if a specific server.ip isn't defined by user - not recommended.
function get_reachable_ips (port) {
	var ips = [];
	const ni = os.networkInterfaces();
	console.log (ni); 
	
	for (var id in ni) {
		var interface = ni[id];
		for (var address of interface) {
			if (address.internal == false) {

			}
		}
	}

	const dns = require ('dns');

	dns.lookup('walle', (err, address, family) => {
	  //console.log('address: %j family: IPv%s', address, family);
	  //process.exit();
	});


}