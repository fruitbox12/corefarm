/*
Copyright (c) 2020 Nuno Chinaglia Poli. All rights reserved.
Corefarm v0.1.0-alpha - zlib license

=======================================
COREFARM - MANAGER

The manager is the user interface to submit jobs and control the server.

It works by sending http requests, according with Corefarm REST API.

Some TODO:
- GUI web and/or native.
- CLI args relating to server's REST API.
- Functions to manage server queue.
- Needs more documentation.

=======================================
*/

//=============
//  BOOTING
//=============

const fs = require('fs');
const http = require('http');

process.chdir(__dirname);

const app = {
    name: 'Corefarm',
    version: '0.1',

    options: {} // Where 'config' is merged then checked for safety.
};
process.title = `${app.name} Manager`;

const config_file = `manager.json`;

// Default settings.
var config = {
    ip: '0.0.0.0',
    port: 8081,

    retry_time: 10000,
    max_retry: 20,
};

// Read config file, important to know where server are.
try {
    if (!fs.existsSync(config_file)) {
        fs.writeFileSync(config_file, JSON.stringify(config, null, '\t'), 'utf8');
    }
    Object.assign(config, JSON.parse(fs.readFileSync(config_file)));
} catch (err) {
    console.error(err.message);
    //process.exit(1);
}

// Merge user-defined settings. Overriding order (asc): default < config file < cli arguments.
Object.assign(app.options, config);
app.options.retry_time = safe_value(app.options.retry_time, 2000);

//================================
//      MAIN
//================================

var server = {
    ip: app.options.ip,
    port: app.options.port
};
var retries = 0;

var jobs = [];

//const api = new API ();

// Executes manager.
(async () => {
    var error = () => {
        console.error (`ERROR! Command terminated with error(s). Please, check arguments.`);
        process.exit(1);
    }

    // TODO: CLI arguments wrapping server API.
    const cmd = process.argv[2];
    const arg = process.argv[3];

    switch (cmd) {
        case 'post-job':
            if (arg) {
                load_jobs (arg);
                submit_jobs ();
            } else { error(); }
            break;
        case 'restart-server':
            //api.restart_server();
            break;
        default:
            console.error (`ERROR! Unknown command.`);
            process.exit (1);
    }


    // TO FIX: Proper args handling.
    //if (load_jobs(process.argv[2])) {
    //    submit_jobs();
    //}
})();

//================================
//      FUNCTIONS
//================================
function load_jobs(file) {
    var loaded;
    try {
        loaded = JSON.parse(fs.readFileSync(`${file}`, 'utf8'));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    if (Array.isArray(loaded)) {
        jobs = loaded;
    } else {
        jobs.push(loaded);
    }

    if (jobs.length > 0) {
        return true;
    } else {
        console.log('No jobs to submit.');
        return false;
    }
}

function submit_jobs() {
    retries++;
    if (retries > app.options.max_retry) {
        console.log(`Max retries (${app.options.max_retry}) reached.`);
        process.exit(1);
    }

    var request = JSON.stringify({
        request: 'add-jobs',
        data: jobs
    });

    const options = {
        hostname: server.ip,
        port: server.port,
        method: 'POST',
        timeout: 5000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': request.length
        }
    };
    const req = http.request(options, (resp) => {
        let data = '';

        // A chunk of data has been recieved.
        resp.on('data', (chunk) => {
            data += chunk;
        });

        // The whole response has been received. Print out the result.
        resp.on('end', () => {
            var response = {};
            try {
                response = JSON.parse(data);
            } catch (err) {

            }

            if (response.response == 'ok') {
                console.log('Job(s) added!');
                for (job of response.data) {
                    console.log(`JOB '${job.name}', ID '${job.id}', TASKS ${job.task_count}`);
                }
                process.exit(0);
            } else {
                console.log('ERROR! Job not added.');
                process.exit(1);
            }
        });
    });

    req.on('timeout', () => {
        req.abort();
        console.log('ERROR! REQUEST TIMEOUT');
        //setTimeout(submit_jobs, config.connection_check_interval);
    });

    req.on("error", (err) => {
        console.log('ERROR! ' + err.message + `\nRetrying in ${config.connection_check_interval / 1000} seconds...`);
        setTimeout(submit_jobs, config.connection_check_interval);
    });

    req.write(request);
    req.end();
}

/*
// TODO
function new_job() {
    var job = {
        id: undefined, // It'll be defined by the server.
        name: 'Untitled',
        threads_per_task: 0, // Concurrent per client. 0 = auto = cpu cores
        tags: [], // User-defined tags
        deps: [], // Dependencies (user-defined tags)
        tasks: [],
    };

    return job;
}
*/


//========================
//      UTILITIES
//========================

// Return a safe number if given one is beyond min/max range. Essentialy a clipping function.
function safe_value(variable, min, max) {
    if (variable < min && min != undefined) { variable = min; }
    if (variable > max && max != undefined) { variable = max; }
    return variable;
}