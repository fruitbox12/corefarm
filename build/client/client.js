/*
Copyright (c) 2020 Nuno Chinaglia Poli. All rights reserved.
Corefarm v0.1.0-alpha - zlib license

=======================================
COREFARM - CLIENT

The client receives tasks from the server and executes them.

It works by periodically sending a http request to server with
its current status, which server's response may contain new tasks
assigned for client to run.

A task is a call to a (separate) process in the client computer. Examples:
"python custom_script.py"
"chrome --remote-debugging-port=9222 https://www.example.com"

Client executes a call and monitors its i/o stream output, logging it to disk.

Some TODO:
- Return log to server for remote reading.
- Cleaning of log and cache files.
- Rewrite of jobs/tasks structure. Use a common module to handle jobs/tasks list.
- Needs more documentation.

=======================================
*/

//=============
//  BOOTING
//=============

//const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const http = require('http');
const child_process = require('child_process');

// Defines working directory the same as where the executing script are.
process.chdir(__dirname);

const app = {
    name: 'Corefarm',
    version: '0.1',

    //start_time: new Date().getTime(),
    //running_time: 0,

    options: {} // Where 'config' and 'args' are merged then checked for safety.
};
process.title = `${app.name} Client @ ${os.hostname()}`;

const args = process_args();

const config_file = 'client.json';

// Default settings.
var config = {
    ip: '0.0.0.0',
    port: 8081,

    // Directory structure used by client.
    dirs: {
        temp: 'temp', // Path where logs and other cache files can be written.
    },

    log: true,

    // Milliseconds
    find_server: 5000,
    update_server: 2000,
    //ping_server: 10000,

    max_threads: 0, // 0 = auto = number of cpu cores.
    refresh_screen: 1000,
};

// Read config file, important to know where server are.
try {
    console.log (`Reading configuration file '${config_file}'...`);
    if (!fs.existsSync(config_file)) {
        fs.writeFileSync(config_file, JSON.stringify(config, null, '\t'), 'utf8');
    }
    Object.assign(config, JSON.parse(fs.readFileSync (config_file)));   
} catch (err) {
    console.error (err.message);
    //process.exit(1);
}


// Merge user-defined settings. Overriding order (asc): default < config file < cli arguments.
Object.assign(app.options, config);
Object.assign(app.options, args);

// Set how many threads client can run concurrently.
// By default, num. threads = num. cpu cores.
app.options.max_threads = safe_value(app.options.max_threads, 0);
var cores = os.cpus().length;
if (app.options.max_threads == 0 && cores > 0) { app.options.max_threads = cores; }

//================================
//		MAIN
//================================

// Var client is sent to server every app.options.update_server
var client = {
    hostname: os.hostname(),
    ip: '',
    port: '',
    mac: '',

    max_threads: app.options.max_threads,
    free_threads: app.options.max_threads,

    id: '', // Assigned by the server

    tasks: [], /* {
        TO REVIEW:
        job: {
            id: '',
            name: '',
            threads_per_task: 1,
        }.
        task: {
            index: '',
            name: ''
        },
        status: 'working', // completed, error
    }
    */
};

// TODO: Should be merged with app.options ?
var server = {
    hostname: '',
    ip: app.options.ip,
    port: app.options.port,
};

var connection = {
    status: 'Not connected.',
};
var connect_timeout;

var request_timeout;
var request_retries = 0;
var max_request_retries = 5;

var update_server_timeout;

// Executes client.
(async () => {
    init_dirs(app.options.dirs); // Initialize 

    update_server();
    setInterval (()=>{
        if (update_server_timeout == undefined) {
            update_server();
        }
    }, app.options.update_server);

    render();
    if (app.options.refresh_screen > 0) {
		setInterval (render, app.options.refresh_screen);
    }
    
})();

//================================
//      CLIENT FUNCTIONS
//================================

// Remove given tasks* from client's queue.
// *They are defined by the server. Usually only tasks with status 'completed' or 'error'.
// TODO: Delete respective log files.
function clean_tasks (tasks_to_remove) {
    var keep_tasks = [];
    for (var i = 0; i < client.tasks.length; i++) {
        var task = client.tasks[i];
        var found = false;
        for (var tsk of tasks_to_remove) {
            /*
            TODO: Delete log files.
            Throws EBUSY error sometimes. Probably should use async method
            to keep trying if the case.
            
            if (task.task.status == 'completed') {
                var filepath = `${app.options.dirs.temp}/${tsk.job.id}/log_${tsk.job.id}-${tsk.task.index}.txt`;              
                setTimeout(()=>{
                    if (fs.existsSync(filepath)) { fs.unlinkSync(filepath); }
                }, 1000);
            }
            */         
            if (tsk.job.id == task.job.id && tsk.task.index == task.task.index) { found = true; break; }
        }
        if (found != true) { keep_tasks.push(client.tasks[i]); }
    }

    client.tasks = keep_tasks;
}

// Start pending or freshly received tasks.
function start_pending () {
    for (tsk of client.tasks) {
        if (tsk.task.status == 'pending' || tsk.task.status == 'assigned') {
            if (tsk.job.threads_per_task == 0 && client.free_threads == client.max_threads) {
                run_task (tsk);
            } else if (tsk.job.threads_per_task > 0) {
                run_task (tsk);
            }
        }
    }
}

// TODO: Commentaries.
function run_task (tsk) {
    var call = tsk.task.call;
    var args = tsk.task.args;
    var cwd = tsk.job.working_dir;
    if (cwd == undefined || cwd == '') { cwd = `${app.options.dirs.temp}/${tsk.job.id}`; }

    tsk.log = [];
    tsk.errors = 0;

    // Run 
    var proc;
    try {
        if (!fs.existsSync(`${app.options.dirs.temp}/${tsk.job.id}`)) {
            fs.mkdirSync(`${app.options.dirs.temp}/${tsk.job.id}`);
        }
        tsk.start_time = new Date().getTime();
        proc = child_process.spawn (call, args, {cwd: cwd, shell: true});
    } catch (err) {
        //console.error (err.message); process.exit(1);
        log_task (tsk, `[CLIENT] ERROR ${err.message}`);
        return;
    }

    tsk.task.status = 'working';

    var usage = tsk.job.threads_per_task;
    if (usage == 0) { usage = client.max_threads; }

    client.free_threads -= usage;
    if (client.free_threads < 0) { client.free_threads = 0; }

    log_task (tsk, `[CLIENT] TASK STARTED Job: ${tsk.job.name} Task: ${tsk.task.name}`);

    proc.stdout.on('data', function (data) {
        log_task (tsk, `${data}`);
    });

    proc.stderr.on('data', function (data) {
        log_task (tsk, `${data}`);
        tsk.errors++;
    });

    var post_task_done;
    var post_task = (code) => {
        if (post_task_done == undefined) {
            post_task_done = true;
            
            log_task (tsk, `[CLIENT] TASK ENDED WITH CODE ${code}. Duration: ${(new Date().getTime() - tsk.start_time)/1000} seconds`);

            if (code == 0) {
                tsk.task.status = 'completed';
            } else {
                tsk.task.status = 'error';
            }

            client.free_threads += usage;
            if (client.free_threads > client.max_threads) { client.free_threads = client.max_threads; }
        }
    };

    proc.on('exit', post_task);
    proc.on('close', post_task);
}

// TODO: Use a buffer and separate thread to write to disk. Maybe open a file stream?
function log_task (tsk, string) {
    var filepath = `${app.options.dirs.temp}/${tsk.job.id}/log_${tsk.job.id}-${tsk.task.index}.txt`;
    if (!string.endsWith('\n')) { string += '\n'; }
    string = `${datetime()}:${new Date().getMilliseconds()} ${string}`;

    try {
        fs.appendFile(filepath, string, 'utf8', ()=>{});
    } catch (err) {
        console.error (err);
        //process.exit(1);
    }
}

// Sends current status to server and receives tasks to run and remove from queue.
function update_server () {
    if (update_server_timeout != undefined) { clearTimeout(update_server_timeout); }

    send_request ({
        request: 'client-update',
        data: client
    })
    .then((data) => {
        var response = JSON.parse(data);

        if (response.response == 'update') {
            connection.status = `${response.data.new_tasks.length} new tasks received.`;

            client.id = response.data.client.id;
            client.ip = response.data.client.ip;
            client.port = response.data.client.port;
            client.ip_family = response.data.client.ip_family;

            clean_tasks(response.data.tasks_to_remove);
            client.tasks = client.tasks.concat (response.data.new_tasks);

            start_pending();
        } else {
            console.error ('-------- Invalid response received ------');
            console.error (data);
            //process.exit(1);
        }

        update_server_timeout = setTimeout (update_server, app.options.update_server);
    })
    .catch((err) => {
        connection.status = 'ERROR! Update not sent! ' + err;
        if (connect_timeout != undefined) { clearTimeout(connect_timeout); }
        //connect_timeout = setTimeout(connect, app.options.find_server);
        update_server_timeout = setTimeout (update_server, app.options.update_server);
    });
}

// Send object as JSON request to server.
function send_request (request_obj) {
    /*
    if (request_timeout != undefined) {clearTimeout(request_timeout);}    
    request_retries++;

    if (request_retries >= max_request_retries) {   
        request_retries = 0;
        //connect();
    }
    */

    request = JSON.stringify(request_obj);
    const options = {
        hostname: server.ip,
        port: server.port,
        method: 'POST', // TO CHANGE: define REST API.
        // timeout: 5000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': request.length,
            'Cache-Control': 'no-store',
        }
    };
    
    return new Promise((resolve, reject) => {
        const req = http.request (options, (resp)  => {
            let data = '';
          
            // A chunk of data has been received.
            resp.on('data', (chunk) => {
              data += chunk;
            });
          
            // The whole response has been received. Print out the result.
            resp.on('end', () => {
                connection.status = `OK! Last request returned successfully.`;
                resolve(data);
            });
          
        });
    
        req.on ('timeout', () => {
            req.abort();
        });
        
        req.on("error", (err) => {
            reject(err);
            connection.status = `ERROR! ${err.message} \n\tRetrying request ${request_retries}...`;
        });
    
        req.write (request);
        req.end();
    });
}
 
// "Render" terminal screen every app.options.update_screen
function render () {
    //app.running_time = new Date().getTime() - app.start_time;
    
    current_count = 0;
    for (tsk of client.tasks) {
        if (tsk.task.status != 'completed' && tsk.task.status != 'error') { current_count++; }
    }

    //--- "RENDER" ----
    var render = [];
    console.clear();
    render.push ('');
    render.push (`${app.name.toUpperCase()} CLIENT ${app.version}`);
    render.push (`${client.hostname} @ ${client.ip} (${client.free_threads}/${client.max_threads} threads)`);
    //render.push (`\tRunning time: ${app.running_time}\n`);
    render.push (`${datetime()}\n`);

    //render.push (`DATABASE: ${app.options.database}`);
    render.push (`SERVER: ${server.hostname} http://${server.ip}:${server.port}\n`);
    
    render.push (`LAST REQUEST: ${connection.status}\n`);

    render.push (`Tasks (${current_count}/${client.tasks.length}):\n`);
    var index = 1;
    for (tsk of client.tasks) {
        render.push (`${index}. ${tsk.task.status} ${tsk.job.name} [${tsk.task.index}] > ${tsk.task.name}` );

        /*      
        index++;
        if (tsk.task.status != 'completed') {
            console.log (`\t\t${index}. ${tsk.task.status} ${tsk.job.name} [${tsk.task.index}] > ${tsk.task.name}` );
            index++;
        }
        */ 
    }

    //console.clear();
    //console.log (util.inspect (client, {compact: 6, showHidden: false, depth: null, colors: true}));
    //console.log (util.inspect (TASKS, {compact: 6, showHidden: false, depth: null, colors: true}));

    console.log (render.join('\n    '));
}

function init_dirs (dir) {
	for (d in dir) {
		if (!fs.existsSync(dir[d])) {
            try {
                fs.mkdirSync(dir[d], {recursive: true});
            } catch (err) {
                console.error (err);
                process.exit(1);
            }
		}
	}
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

// TODO: Handle EBUSY error.
function delete_file (filepath) {
    if (fs.existsSync(filepath)) {
        try {
            fs.unlinkSync(filepath);
        } catch (err) {
            if (err.code == 'EBUSY') {

            }
        }
    }
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