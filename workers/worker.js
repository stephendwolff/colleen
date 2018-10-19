var request = require('request');
var _ = require('lodash');
var mysql = require('mysql');
var fs = require('fs');
var events = require('events');
var nconf = require('nconf');


/*---------------------------------------------------------------------------*/

// Config


// if testing then want to make sure we are using testing db
if (process.env.NODE_ENV === 'test') {
    nconf.overrides({'WNU_DB_URL': process.env.WNU_TEST_DB_URL});
}

// config files take precedence over command-line arguments and environment variables
nconf.file({ file:
    'config/' + process.env.NODE_ENV + '.json'
})
    .argv()
    .env();

// provide sensible defaults in case the above don't
nconf.defaults({
	timeout: 20000,

    projects_list: '../data/projects.json',
    projects_ids: '../data/project_ids.json',
	projects_table_name: 'projects',
	classifications_table_name: 'classifications',
    timeseries_table_name: 'timeseries',
    cls_expire_after_x_days: 40,
    default_project_updated_time:1402704000000,  // 1402704000
    classifications_per_page:5000
});


var WNU_DB_URL = nconf.get('WNU_DB_URL');
var PUSHER_API_KEY = nconf.get('PUSHER_API_KEY');
var PUSHER_CLUSTER = nconf.get('PUSHER_CLUSTER');

/*---------------------------------------------------------------------------*/

// Constants and globals

var MIN_SECS = 60,
    MIN_5_SECS = 300,
    MIN_15_SECS = 900,
    HOUR_SECS = 3600,
    DAY_SECS = 86400,
    WEEK_SECS = 604800,
    MONTH_SECS = 2592000; // month 30 days

var seriesLength = {};
    seriesLength[MIN_SECS] = 60, seriesLength[MIN_5_SECS] = 60, seriesLength[MIN_15_SECS] = 60,
    seriesLength[HOUR_SECS] = 24, seriesLength[DAY_SECS] = 30;

console.log("seriesLength is ", seriesLength);
console.log("timeout is", nconf.get("timeout"));

var gProjectList = [], gProjectQueue = [], gSeriesQueue = [], gProjectListById = [], gProjectIds = [];

gProjectList = require(nconf.get("projects_list"));
console.log('gProjectList is ', gProjectList);
gProjectIds = require(nconf.get("projects_ids"));

console.log('gProjectIds is ', gProjectIds);
for (var i = 0; i < gProjectIds.length; i++) {
    const project = gProjectIds[i];
    gProjectListById["id_"+project['id']] = project;
}
//gProjectListById = gProjectIds.map(entry => entry["ids"].map(x => entry["name"]));

console.log('gProjectListById is ', gProjectListById);
console.log('gProjectListById.keys() is ', gProjectListById.keys());


var gIntervals = [MIN_SECS,MIN_15_SECS,HOUR_SECS,DAY_SECS];
var gTimer = 0;

var gEventEmitter = new events.EventEmitter();

var gClsArchiveTime = DAY_SECS * nconf.get("cls_expire_after_x_days");
var gLatency = 120000;//60000; // query up to N ms behind current time

/*---------------------------------------------------------------------------*/

// // MySQL connection

var connection = null;
var gProjectTable = nconf.get("projects_table_name");
var gClsTable = nconf.get("classifications_table_name");
var gSeriesTable = nconf.get("timeseries_table_name");
var gDefaultProjectUpdatedTime = nconf.get("default_project_updated_time");
var gClassificationsPerPage = nconf.get("classifications_per_page");

console.log('NODE_ENV is',nconf.get('NODE_ENV'));
console.log('projects_list is',nconf.get('projects_list'));
console.log('WNU_DB_URL',WNU_DB_URL);
console.log('gClsArchiveTime',gClsArchiveTime);

function connect(){
    if(connection!=null){
        disconnect();
    }
    connection = mysql.createConnection(WNU_DB_URL+'?timezone=+0000');
    return connection;

}


function disconnect(){
    //console.log('Worker: Checking for open DB connections');
    if (connection != null){
        //console.log('Worker: Closing DB connection');
        connection.end();
        connection = null;
    }
}

// Handle exit

process.on('exit', function () {
    console.log('Worker: Exiting...');
    disconnect();
    console.log('Worker: Exited.');
});

// happens when you press Ctrl+C
process.on('SIGINT', function () {
    console.log( '\nWorker: Gracefully shutting down worker from  SIGINT (Crtl-C)' );
    process.exit();
});

// usually called with kill
process.on('SIGTERM', function () {
    console.log('Worker: Parent SIGTERM detected (kill)');
    // exit cleanly
    process.exit(0);
});






/*---------------------------------------------------------------------------*/

// Scheduling

var gUpdateCount = 0;
var gTimoutObj = null;



var fetchDataTimeout = function(){
    console.log("Fetch Data:", new Date(),"updateCount",gUpdateCount);
    gUpdateCount +=1;
    var timeout = nconf.get("timeout");
    // gTimoutObj = setTimeout(startFetch,timeout);
    gTimoutObj = setTimeout(connectDB,timeout);
};

function startScheduler(){
    /* no longer used */
    // gEventEmitter.on('endFetchData', startUpdateTimeSeries);

    // timeseries calculation is used
    gEventEmitter.on('endUpdateTimeSeries', fetchDataTimeout);
    connectDB();
    fetchDataTimeout();

}

function connectDB(){
    connect();
    connection.connect(function(err) {
        if(err) {
            onError('Worker: error when connecting to db', err);

            throw err;
        }
        else{
            console.log("Database connected");
//            fetchNext();
        }
    });
}

function onError(str,err){
    console.log(str+": " + err);
    if(gTimoutObj){
        clearTimeout(gTimoutObj);
    }
    fetchDataTimeout();
}

process.on('uncaughtException', function(err) {
    //console.log('uncaughtException' + err);
    onError('uncaughtException',err);
});

/*---------------------------------------------------------------------------*/

// Pusher
var Pusher = require('pusher-client');

var socket = new Pusher(PUSHER_API_KEY, { cluster: PUSHER_CLUSTER });
var channel = socket.subscribe('panoptes');
channel.bind('classification',
    function(record) {

        console.log("classification event: " + JSON.stringify(record));

        // {
        //      "classification_id":"122370232",
        //      "project_id":"5074",
        //      "workflow_id":"5062",
        //      "user_id":"1791986",
        //      "subject_ids":["16229013"],
        //      "subject_urls":[{
        //          "image/jpeg":"https://panoptes-uploads.zooniverse.org/production/subject_location/d8f2af5d-a9ce-40f8-917a-be564f33eaf9.jpeg"
        //      }],
        //      "geo":{
        //          "country_name":"Netherlands",
        //          "country_code":"NL",
        //          "city_name":"Lelystad",
        //          "coordinates":[5.475,52.5083],
        //          "latitude":52.5083,
        //          "longitude":5.475
        //      }
        //  }
        var projectId = record['project_id'];
        var projectData = gProjectListById["id_" + projectId];
        var projectName = projectId;
        var projectZoonName = projectId;
        if (projectData !== undefined) {
            projectName = gProjectListById["id_" + projectId]['wnu_name'];
            projectZoonName = gProjectListById["id_" + projectId]['name'];
        }
        // once we have data from a project we want, add to classifications table, and remove old data:
        //if ("id_" + projectId in gProjectListById.keys()) {
            var fields = ['id', 'created_at', 'user_id', 'project', 'country_code', 'region', 'city_name', 'latitude', 'longitude', 'zoon_project', 'zoon_userid'];
            var inserts = [];
            var values = [];
            _.each(fields, function (field, index) {
                var value = 'NULL';
                if (field === 'project') {
                    value = "'" + projectName + "'"; // get project name
                }
                else if (field === 'created_at') {
                    var date = new Date();//record[field]);
                    value = "FROM_UNIXTIME('" + parseInt(date.valueOf() / 1000) + "')";
                    //console.log('record[field]',record[field],'value',value,'date',date);
                }
                else if (field === 'user_id') {
                    value = parseInt(record[field]);
                    if (isNaN(value)) value = 0;
                    //console.log('record[field]',record[field],'value',value,'date',date);
                }
                else if (field === 'id') {
                    value = parseInt(record['classification_id']);
                }
                else if (field === 'region') {
                    value = 'NULL';
                }
                else if (record['geo'][field]) {
                    console.log('region, field = ' + field);
                    if (connection !== undefined && connection !== null) {
                        value = connection.escape(record['geo'][field]);
                    }
                }
                else if (field === 'zoon_project') {
                    value = "'" + projectZoonName + "'"; // get project name
                }
                else if (field === 'zoon_userid') {
                    value = "'" + record['user_id'] + "'"; // get user id
                }
                values.push(value);
            });

            // get event date from system
            var createdDate = new Date();
            maxDataDateMs = createdDate.valueOf();

            var valuesStr = values.join(",");
            inserts.push("(" + valuesStr + ")");

            var insertStr = inserts.join(',');
            console.log(insertStr);

            connection.query("REPLACE INTO " + gClsTable + " (`id`,`created_at`,`user_id`,`project`,`country`,`region`,`city`,`latitude`,`longitude`,`zoon_project`, `zoon_userid`) VALUES" + insertStr,
                function (err, rows) {

                    if (err) {
                        onError('fetchRequest, insert failed', err);
                        throw err;
                    }

                    removeClassifications(projectId, projectName, maxDataDateMs);
                });
        //}
    }
);

// TODO, listen for socket disconnects, and do timed reconnects


/*---------------------------------------------------------------------------*/

// Fetch classification data from zoon API, insert into classification table

/*
function startFetch(){

    gTimer = new Date().valueOf();
//    gProjectQueue = _.clone(gProjectList);

    connect();
    connection.connect(function(err) {
        if(err) {
            onError('Worker: error when connecting to db', err);

            throw err;
        }
        else{
//            fetchNext();
        }
    });
}

function fetchNext(){
    if(gProjectQueue.length>0){
        var projectId = gProjectQueue.shift();
        fetchProjectData(projectId);

    }
    else{
        endFetch();
    }
}

function endFetch(){

    var dt = (new Date().valueOf() - gTimer)/1000;
    //console.log('endFetchData. Time taken (s):',dt);
    gEventEmitter.emit('endFetchData');

}

function fetchProjectData(projectId){

    //console.log("fetchProjectData",projectId);

    //connection.query("SELECT UNIX_TIMESTAMP(created_at) AS time FROM "+gClsTable+" WHERE project='"+projectId+"' ORDER BY time DESC LIMIT 1",function(err, rows) {
    connection.query("SELECT UNIX_TIMESTAMP(updated) as time FROM "+gProjectTable+" WHERE name='"+projectId+"'",function(err, rows) {

        if(err) {
            onError('fetchProjectData, query error',err);
            throw err;

        }

        if(rows[0]==null){
            console.log('fetchProjectData, not in database:',projectId);
            fetchNext();
            return;
        }


        var fromMs, toMs;
        var curMs = (new Date()).valueOf() -gLatency;

        var intervalMs = 15*60*1000; // 15 mins in ms
        var projectUpdated = rows[0].time;
        if(projectUpdated==null){


            fromMs = gDefaultProjectUpdatedTime;
            // 2014/06/14 // 1401580800000; //2014/06/01 // 1398902400000;// 2014/05/01 // 1399939200000; // midnight 13 May 2014//1404543600000;// 2014/07/05 7am // 1399982400000; // 12pm 13 May 2014 //
            // var monthMs = MONTH_SECS * 1000;// a month in ms
            //fromMs = (new Date()).valueOf() - monthMs;
            console.log("projectUpdated is NULL",projectUpdated);
        }
        else{
            fromMs = projectUpdated*1000;
            //console.log("projectUpdated",projectUpdated);

        }
        toMs = fromMs + intervalMs;
        toMs = Math.min(curMs,toMs);



        // request
        // request replaced by socket based binding with Pusher
        // fetchRequest(projectId,fromMs,toMs);

    });

}

function fetchRequest(projectId,fromMs,toMs){

    //console.log('fetchRequest',projectId,"fromMs",fromMs,"toMs",toMs, "from",new Date(fromMs), "to",new Date(toMs),"perPage",gClassificationsPerPage);

    var maxDateMs = toMs, maxDataDateMs = 0;

    var perPage = gClassificationsPerPage; // 5000
    var options = {
        url: 'http://event.zooniverse.org/classifications/'+projectId,
        qs:{'from':fromMs, 'to':toMs,'per_page':perPage,'page':0},
        timeout:20*1000,
        headers: {
            'Accept': 'application/vnd.zooevents.v1+json'
        }
    };

    request(options, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var data = JSON.parse(body);
            //console.log('Classifications, data.length:',data.length);

            if(data.length>0){
                var fields = ['id','created_at','user_id','project','country_code','region','city_name','latitude','longitude'];
                var inserts = [];
                _.each(data,function(record){
                    var values=[];
                    _.each(fields, function(field,index){
                        var value = 'NULL';
                        if(field=='project'){
                            value = "'"+projectId+"'";
                        }
                        else if(field=='created_at'){
                            var date = new Date(record[field]);
                            value = "FROM_UNIXTIME('"+parseInt(date.valueOf()/1000)+"')";
                            //console.log('record[field]',record[field],'value',value,'date',date);
                        }
                        else if(field=='user_id'){
                            value = parseInt(record[field]);
                            if(isNaN(value)) value = 0;
                            //console.log('record[field]',record[field],'value',value,'date',date);
                        }
                        else if(record[field]){
                            value = connection.escape(record[field]);
                        }
                        values.push(value);
                    });
                    // get last date from data
                    var createdDate = new Date(record['created_at']);
                    //console.log('createdMs',createdDate);
                    var createdMs = createdDate.valueOf();
                    if(createdMs>maxDataDateMs){
                        maxDataDateMs = createdMs;
                    }

                    var valuesStr = values.join(",");
                    inserts.push("("+valuesStr+")");

                });

                if(data.length==perPage){
                    maxDateMs = maxDataDateMs;
                    //console.log('maxDataDateMs',maxDataDateMs);
                }

                var insertStr = inserts.join(',');
                //console.log(insertStr);


                connection.query("REPLACE INTO "+gClsTable+" (`id`,`created_at`,`user_id`,`project`,`country`,`region`,`city`,`latitude`,`longitude`) VALUES" +insertStr,
                    function (err, rows) {

                        if (err) {
                            onError('fetchRequest, insert failed',err);
                            throw err;
                        }

                        removeClassifications(projectId, maxDateMs);
                    });
            } else {
                removeClassifications(projectId, maxDateMs);
            }
        }
        else{ // end if (!error && response.statusCode == 200) {
            console.log('fetchProjectData request error',error);//,response.statusCode);

            removeClassifications(projectId, fromMs);
        }

    }); // close request
}

*/


function removeClassifications(project_id, project_name, updateMs){

    console.log('removeClassifications: ', project_id, updateMs, new Date(updateMs));

    var lastClsTime = parseInt(updateMs/1000) - gClsArchiveTime;
    //console.log('removeClassifications from: ',projectId, lastClsTime, new Date(lastClsTime*1000));

    // delete classifications past max interval
    var query = "DELETE FROM " + gClsTable + " WHERE `created_at` < FROM_UNIXTIME('" + lastClsTime + "') AND `id`="+project_id;

    console.log(query);
    connection.query(query, function(err, rows) {

        if(err) {
            onError("removeClassifications error",err);
            throw err;
        }

        setProjectsUpdateTime(project_id, project_name, updateMs)

    });

}

function setProjectsUpdateTime(project_id, project_name, updateMs){


    var project_query = "SELECT `id` FROM `" + gProjectTable + "` WHERE `id` = " + project_id;// + " AND `name`='" + project_name + "'";
    console.log("setProjectsUpdateTime project_query = " + project_query);
    var new_record = false;

    connection.query(project_query,function (err, rows) {
        if (err) {
            onError('setProjectsUpdateTime error',err);
            throw err;
        }

        if (rows.length === 0) {
            new_record = true;
        }
        console.log("new_record = " + new_record);
        var unixTime = parseInt(updateMs/1000);

        var query = "UPDATE `"+gProjectTable+"` SET `updated`= FROM_UNIXTIME('"+unixTime+"') WHERE `id`="+project_id;
        if (new_record) {
            query = "INSERT INTO `"+gProjectTable+"` (`id`, `name`, `display_name`, `updated`) VALUES (" + project_id + ", '" + project_name + "', '" + project_name + "',  FROM_UNIXTIME('" + unixTime + "'))";
        }

        console.log("setProjectsUpdateTime query = " + query);
        connection.query(query,function (err, rows) {
            if (err) {
                onError('setProjectsUpdateTime error',err);
                throw err;
            }
        });
    });
}

function fetchProjectDataTest(){

    //curl -H "Accept: application/vnd.zooevents.v1+json"
    //"http://event.zooniverse.org/classifications/galaxy_zoo?from=1399939200000&to=1400025600000&per_page=200&page=1"

    var from = 1401235200000, to = 1401321600000; // 2014/05/28 00:00 to 2014/05/29 00:00

    var options = {
        //url: 'http://event.zooniverse.org/classifications/galaxy_zoo?from=1399982400000&to=1399983000000&per_page=10&page=0',
        url: 'http://event.zooniverse.org/classifications/galaxy_zoo',
        qs:{'from':from, 'to':to,'per_page':1000,'page':0},
        headers: {
            'Accept': 'application/vnd.zooevents.v1+json'
        }
    };

    request(options, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            console.log("body.length",body.length);

            var data = JSON.parse(body);
            //console.log(data);
            //console.log('data[0]',data[0]);
            console.log('data.length',data.length,'from',new Date(from), 'to',new Date(to));
        }
    });

}


function testMySQLError(){

    setInterval(function(){
        console.log(new Date());
    },1000);
    connect();
    connection.connect(function(err) {
        if(err) {
            console.log('Error',err);
        }
        connection.query("SELECT * FROM invalid",function(err2, rows, fields) {
            if(err2) {
                console.log('Error',err2);
            }
        });

    });

}

function testFetchData(){

    console.log("Start testFetchData");

    var updateCount = 0;

    // projects: ["andromeda","bat_detective","cyclone_center","galaxy_zoo","milky_way","planet_four","sea_floor","serengeti"]

    var testFetchDataLoop = function(){
        console.log("testFetchData:", new Date(),"updateCount",updateCount);
        updateCount +=1;
        setTimeout(startFetch,5*1000);
    };

    gEventEmitter.on('endFetchData', testFetchDataLoop);

    testFetchDataLoop();

}


/*---------------------------------------------------------------------------*/

// Update time-series

function startUpdateTimeSeries(){

    connect();

    gTimer = new Date().valueOf();
    connection.connect(function(err) {
        if(err) {
            onError('Worker: error when connecting to db', err);
            throw err;
        }
        else{

            gSeriesQueue = [];
            _.each(gProjectList,function(project){
                _.each(gIntervals,function(interval){
                    gSeriesQueue.push(
                        {type:'c',interval:interval, project:project},
                        {type:'u',interval:interval, project:project}
                    );

                });
            });
            updateNextTimeSeries();

        }
    });

}

function updateNextTimeSeries(){
    if (gSeriesQueue.length > 0){
        var series = gSeriesQueue.shift();
        updateTimeSeries(series);
    }
    else{
        endUpdateTimeSeries();
    }

}

function endUpdateTimeSeries() {
    disconnect();
    var dt = (new Date().valueOf() - gTimer)/1000;
    //console.log('endUpdateTimeSeries. Time taken (s):',dt);
    gEventEmitter.emit('endUpdateTimeSeries');
}

function updateTimeSeries(series){

    var interval = series.interval; // seconds
    var dataType = series.type;
    var projectId = series.project;
    var from = 0, to = 0;

    // find from and to dates

    var projectUpdatedUnix = 0,seriesMax = 0;

    connection.query("SELECT UNIX_TIMESTAMP(`updated`) AS time FROM `"+gProjectTable+"` WHERE `name`='"+projectId+"'",function (err, rows) {
        if (err) {
            onError('updateTimeSeriesInterval error',err);
            throw err;

        }

        if(rows[0]==null){
            console.log('updateTimeSeries, project not in database:', projectId);
            updateNextTimeSeries();
            return;
        }

        projectUpdatedUnix = rows[0].time;
        to = projectUpdatedUnix;


        // find last timeseries date
        connection.query("SELECT UNIX_TIMESTAMP(`datetime`) AS time FROM "+gSeriesTable+" WHERE project='"+projectId+
            "' AND `type_id`='"+dataType+"'  AND `interval`="+interval+" ORDER BY time DESC LIMIT 1",function(err, rows) {
            if (err) {
                onError('updateTimeSeriesInterval error',err);
                throw err;
            }
            // if series entries in database, set from time to last item plus interval
            if(rows[0]){
                //console.log('seriesMax',rows[0]);
                seriesMax = rows[0].time;
                from = seriesMax+interval;

                var maxPeriod = seriesLength[interval]*interval;
                // if gap in time series greater than series length, set from time for series length
                if(to-from>maxPeriod){
                    console.log('maxPeriod exceeded',projectId,from,to,maxPeriod);
                    from = Math.floor(projectUpdatedUnix/interval)*interval-maxPeriod;
                }

                //console.log('from seriesMax', from);
            }
            // else set from time from project update minus series length
            else{

                from = Math.floor(projectUpdatedUnix/interval)*interval - seriesLength[interval]*interval;
                //console.log('from, no seriesMax',from);

            }

            //console.log(projectId,"updateTimeSeriesIntervals",series.type, series.interval,"from",from,"to",to,"from",new Date(from*1000),"to",new Date(to*1000));

            // if interval is less than update period,  start next project
            if(to-from<interval){
                updateNextTimeSeries();
            }
            else{
                var nIntervals = Math.floor((to-from)/interval);
                to = from+(interval*nIntervals);
                //console.log('updateTimeSeries: from, to, interval',from, to, interval, new Date(from*1000), new Date(to*1000) );

                updateTimeSeriesInterval(series,from,to);

            } // close if(to-from<interval){
        }); // close connection.query("SELECT UNIX_TIMESTAMP(`datetime`) AS time FROM "+gSeriesTable+"
    }); // close connection.query("SELECT UNIX_TIMESTAMP(`updated`)

}

function updateTimeSeriesInterval(series, from, to){

    var interval = series.interval; // seconds
    var dataType = series.type;
    var projectId = series.project;

    var dataQuery = "";
    switch(dataType){
        case "c":
            dataQuery = "COUNT(*) AS count";
            break;
        case "u":
            dataQuery = "COUNT(DISTINCT user_id) as count";
            break;
        default:

            return;
    }

    var query = "SELECT "+dataQuery+",project,FLOOR((UNIX_TIMESTAMP(created_at)-"+from+")/"+interval+") AS time "+
        "FROM "+gClsTable+" WHERE project='"+projectId+"' AND created_at BETWEEN FROM_UNIXTIME("+from+") AND FROM_UNIXTIME("+to+") "+
        "GROUP BY time";

    connection.query(query, function(err, rows, fields) {
        if(err) {
            onError("updateTimeSeriesInterval Error",err);
            throw err;
        }
        _.map(rows,function(item){
            //console.log("time bucket",item.time);
            item.time = parseFloat(item.time)*interval + from;
            //console.log('date',item.date,'count',item.count,"time",item.time);
        });

        var minTimeMs = from*1000;
        var nItems = (to-from)/interval;
        //console.log('Series length',nItems);


        var values = [];
        for(var i=0;i<nItems;i++){

            var unixtime = from+interval*i;
            values.push({"unixtime":unixtime,"value":0});
            //console.log('unixtime',unixtime);
        }


        // add counts to date series
        _.each(rows,function(row){

            var item = _.find(values,{'unixtime':row.time});
            //console.log('unixtime',row.time);
            if(item){
                item.value = row.count;
            }

        });

        var unixNow = parseInt(new Date().valueOf()/1000);
        //console.log('unixNow',unixNow);

        // create mysql inserts
        // INSERT INTO tbl_name (a,b,c) VALUES(1,2,3),(4,5,6),(7,8,9);

        var inserts = [];
        _.each(values,function(item){
            inserts.push("('"+dataType+"','"+projectId+"','"+interval+"',FROM_UNIXTIME('"+ item.unixtime+"'),'"+item.value+"',FROM_UNIXTIME('"+unixNow+"'),"+
                "FROM_UNIXTIME('"+ from+"'),FROM_UNIXTIME('"+to+"')"+")");
        });


        var insertStr = inserts.join(',');
        // console.log(insertStr);

        connection.query("INSERT INTO "+gSeriesTable+" (`type_id`,`project`,`interval`,`datetime`,`count`,`updated`,`from`,`to`) VALUES" +insertStr,
            function (err, rows) {

                if(err){
                    onError('updateTimeSeriesInterval, Insert Error', err);
                    throw err;
                }

                removeTimeSeriesItems(series);

            });

    });
}


function removeTimeSeriesItems(series){

    var interval = series.interval; // seconds
    var dataType = series.type;
    var projectId = series.project;

    // delete excess series data

    // find last item in series
    var lastItemTime = 0;
    var offset = seriesLength[interval] -1;

    connection.query("SELECT UNIX_TIMESTAMP(`datetime`) AS time FROM "+gSeriesTable+" WHERE `project`='"+projectId+"' AND type_id='"+dataType+"' AND `interval`="+interval+" ORDER BY `datetime` DESC LIMIT 1 OFFSET "+offset,function(err, rows, fields) {

        if(err) throw err;
        // if rows to delete
        if(rows[0]){
            lastItemTime = rows[0].time;
            //console.log(projectId, 'lastItemTime: ', lastItemTime,'type',dataType,'interval',interval, new Date(lastItemTime*1000));

            // delete records past series length
            var query = "DELETE FROM "+gSeriesTable+" WHERE `datetime` < FROM_UNIXTIME('"+lastItemTime+"') AND `project` = '"+projectId+"' AND `type_id` = '"+dataType+"' AND `interval` = "+interval;


            connection.query(query, function(err, rows) {

                if(err) {
                    onError("removeTimeSeriesItems error",err);
                    throw err;
                }
                updateNextTimeSeries();

            });

        }
        else{
            updateNextTimeSeries();
        }
    });

}

function updateTimeSeriesFromArchive(){

    console.log("Start testUpdateTimeSeries");
    gProjectTable = "projects";
    gClsTable = "classifications_archive";
    gSeriesTable = "timeseries";
    var seriesInitTable = "timeseries_archive";
    var classificationTime = parseInt(new Date(Date.UTC(2014,6,10,0,0,0))/1000);
    var classificationInterval = 60; // secs
    var timeout = classificationInterval*1000;

    var updateCount = 0, nUpdates = 60;

    // projects: ["andromeda","bat_detective","cyclone_center","galaxy_zoo","milky_way","planet_four","sea_floor","serengeti"]
    // Initial run time: 181.74 secs. 2784 rows.
    // Update minutes only: 35.767 secs

    var updateTimeSeriesLoop = function(){
        console.log("testUpdateTimeSeries:", new Date(), "classificationTime",classificationTime,"updateCount",updateCount);
        var query = "UPDATE `"+gProjectTable+"` SET `updated`=FROM_UNIXTIME('"+classificationTime+"')";

        connect();
        connection.connect(function(err) {
            console.log("UPDATE query",query);
            connection.query(query,function(err, rows) {

                classificationTime += classificationInterval;
                updateCount +=1;

                var dt = (new Date().valueOf() - gTimer);
                timeout = classificationInterval*1000 - dt;
                timeout = Math.max(timeout,0);
                console.log('updateTimeSeriesLoop timeout:',timeout/1000);

                setTimeout(startUpdateTimeSeries,timeout);


            });
        });
    };

    gEventEmitter.on('endUpdateTimeSeries', updateTimeSeriesLoop);

    //updateTimeSeriesLoop();

    // truncate timeseries
    connect();
    connection.connect(function(err) {
        var query = "TRUNCATE "+ gSeriesTable;
        console.log(query);
        connection.query(query,function(err, rows) {

            // copy initial series table

            connection.query("INSERT "+gSeriesTable+" SELECT * FROM "+seriesInitTable,function(err2, rows2) {
                console.log('Copy time-series');
                updateTimeSeriesLoop();
            });
        })
    });


}

function singleTimeSeriesFromArchive(){

    // all projects, Time taken (s): 230.483
    console.log("Start singleTimeSeriesFromArchive");
    gProjectTable = "projects";
    gClsTable = "classifications_archive";
    gSeriesTable = "timeseries";

    var classificationTime = parseInt(new Date(Date.UTC(2014,6,10,18,0,0))/1000);

    connect();
    connection.connect(function (err) {
        // truncate timeseries
        var query = "TRUNCATE " + gSeriesTable;
        console.log(query);
        connection.query(query, function (err, rows) {

            var query = "UPDATE `"+gProjectTable+"` SET `updated`=FROM_UNIXTIME('"+classificationTime+"')";

            console.log("UPDATE query",query);
            connection.query(query,function(err, rows) {

                startUpdateTimeSeries();


            });
        });

    })

}


/*---------------------------------------------------------------------------*/

// Insert zoon API projects into projects table

function getZooonAPIProjects(){

    connect();
    connection.connect(function(err) {
        if(err) {
            console.log('Worker: error when connecting to db:', err);
        }
        else{
            var options = {
                url: 'https://api.zooniverse.org/projects/list'
            };

            request(options, function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    var data = JSON.parse(body);
                    console.log(data);

                    if(data.length>0){
                        var fields = ['id','name','display_name'];
                        var inserts = [];
                        _.each(data,function(record){
                            var values=[];
                            _.each(fields, function(field,index){
                                var value = 'NULL';
                                if(record[field]){
                                    value = "'"+record[field]+"'";
                                }
                                values.push(value);
                            });

                            var valuesStr = values.join(",");
                            inserts.push("("+valuesStr+")");

                        });

                        var insertStr = inserts.join(',');
                        console.log(insertStr);

                        connection.query("INSERT IGNORE INTO "+gProjectTable+" (`id`,`name`,`display_name`) VALUES" +insertStr,
                            function (err, rows) {
                                if (err) {
                                    throw err;
                                }
                                disconnect();

                        });
                    }



                }
            });
        }
    });
}

module.exports.gProjectList = gProjectList;
module.exports.nconf = nconf;
//module.exports.fetchRequest = fetchRequest;

module.exports.startScheduler = startScheduler;
//module.exports.startFetch = startFetch;
module.exports.updateTimeSeriesFromArchive = updateTimeSeriesFromArchive;
module.exports.singleTimeSeriesFromArchive = singleTimeSeriesFromArchive;
module.exports.testMySQLError = testMySQLError;

module.exports.connection = connection;
module.exports.connect = connect;
