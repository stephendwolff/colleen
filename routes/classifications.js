
// mysql package:
//https://www.npmjs.org/package/node-mysql
//https://github.com/felixge/node-mysql

var _ = require('lodash');
var mysql      = require('mysql');
var parseDbUrl = require('parse-database-url');
var nconf = require('nconf');


/*---------------------------------------------------------------------------*/

// Config


// if testing then want to make sure we are using testing db
if (process.env.NODE_ENV == 'test') {
    nconf.overrides({'WNU_DB_URL': process.env.WNU_TEST_DB_URL});
}

// config files take precedence over command-line arguments and environment variables 

nconf.file({ file:
    'config/' + process.env.NODE_ENV + '.json'
})
    .argv()
    .env();

var WNU_DB_URL = nconf.get('WNU_DB_URL');

var dbConfig = parseDbUrl(WNU_DB_URL);

// need to parse dbname out of connection string
var WNU_DB_NAME = dbConfig['database'];


/*---------------------------------------------------------------------------*/

// Cosntants and globals

var MIN_SECS = 60,
    //MIN_5_SECS = 300,
    MIN_15_SECS = 900,
    HOUR_SECS = 3600,
    DAY_SECS = 86400;
    //WEEK_SECS = 604800,
    //MONTH_SECS = 2592000; // month 30 days

var connection;

var gTimeseriesData = [];
var gTimeseriesUpdateTime = 0;
var gTimeseriesUpdateInterval = 60000;
var gMaxUpdateInterval = 60*60*6; // maximum update interval 6hr. Notify if no update within time (seconds).

/*---------------------------------------------------------------------------*/

// Database connection

/*
function handleDisconnect() {
    connection = mysql.createConnection(WNU_DB_URL); // Recreate the connection, since
    // the old one cannot be reused.

    connection.connect(function(err) {              // The server is either down
        if(err) {                                     // or restarting (takes a while sometimes).
            console.log('error when connecting to db:', err);
            setTimeout(handleDisconnect, 2000); // We introduce a delay before attempting to reconnect,
        }                                     // to avoid a hot loop, and to allow our node script to
    });                                     // process asynchronous requests in the meantime.
    // If you're also serving http, display a 503 error.
    connection.on('error', function(err) {
        console.log('db error', err);
        if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
            handleDisconnect();                         // lost due to either server restart, or a
        } else {                                      // connnection idle timeout (the wait_timeout
            throw err;                                  // server variable configures this)
        }
    });
}

handleDisconnect();
*/


var gPool  = mysql.createPool({
    host     : dbConfig['host'],
    user     : dbConfig['user'],
    password : dbConfig['password'],
    database : dbConfig['database'],
    connectionLimit : 13
});


/*---------------------------------------------------------------------------*/

// Cleanup

exports.cleanUp = function() {
    // Using pool rather than single connection
    /*
    console.log('Checking for open DB connections');
    if (connection != null) {
        console.log('Closing DB connection');
        connection.end();
    }
    */
};


/*---------------------------------------------------------------------------*/

// Timeseries routes

exports.getTimeSeries = function(req, res) {

    var curMs = (new Date()).valueOf();
    if (gTimeseriesUpdateTime+gTimeseriesUpdateInterval<curMs) {
        gPool.getConnection(function(error, con) {
            if(error) throw error;
            con.query("SELECT `type_id` as type,`interval` as i,`project` as p,UNIX_TIMESTAMP(`datetime`) as t,`count` as c FROM `timeseries`",function(err, rows, fields) {
                con.release();
                if(err) throw err;

                var intervalValues = [MIN_SECS,MIN_15_SECS,HOUR_SECS,DAY_SECS];
                gTimeseriesData = {intervals:intervalValues,data:rows};
                gTimeseriesUpdateTime = curMs;
                console.log('getTimeSeries from DB pool');
                res.send(gTimeseriesData);
            });
        });
    } else {
        console.log('getTimeSeries from cache');
        res.send(gTimeseriesData);
    }
};

exports.getTimeSeriesBetweenDates = function(req, res) {
    // console.log('getTimeSeriesBetweenDates');

    // localhost:5000/timeseries/from/1364684400/to/1364774400

    var from = parseInt(req.params.from); // unix timestamp
    var to = parseInt(req.params.to); // unix timestamp

    if(isNaN(to) || isNaN(from)){
        res.send([]);
        return;
    }

    gPool.getConnection(function(error, con) {
        if(error) throw error;

        var query = "SELECT `type_id` as type,`interval` as i,`project` as p,UNIX_TIMESTAMP(`datetime`) as t,`count` as c FROM `timeseries` "
            + "WHERE `datetime` BETWEEN FROM_UNIXTIME('"+from+"') AND FROM_UNIXTIME('"+to+"')";
        //console.log(query);
        con.query(query,function(err, rows) {

            con.release();
            if(err) throw err;
            res.send({from:from, to:to, data:rows});

        });
    });

};

exports.getTimeSeriesIntervals = function(req, res) {
    //console.log('getTimeSeriesIntervals');
    var intervalsStr = req.params.intervals; // secs
    var intervals = intervalsStr.split(',');
    var intervalValues = [];

    _.each(intervals,function(interval,index){
        if(!isNaN(interval)){
            intervalValues.push(parseInt(interval));
        }
    });
    var whereStr = " WHERE `interval` IN(" + intervalValues.join(",") + ")";
    //console.log(whereStr);

    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT `type_id` as type,`interval` as i,`project` as p,UNIX_TIMESTAMP(`datetime`) as t, `count` as c FROM `timeseries`" + whereStr,function(err, rows, fields) {

            con.release();
            if(err) throw err;
            res.send({intervals:intervalValues, data:rows});

        });
    });
};




/*---------------------------------------------------------------------------*/

// Classification routes

exports.getClassificationCount = function(req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query('SELECT COUNT(*) AS count FROM ??',['classifications'], function(err, rows, fields) {
            con.release();
            if(err) throw err;
            console.log('Classification count: ', rows[0].count);
            res.send(rows);
        });
    });
};

exports.getClassificationCountLatest = function(req, res) {

    var seconds = parseInt(req.params.seconds);

    if(isNaN(seconds)){
        res.send([]);
        return;
    }

    var maxTimeUnix = 0;
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT UNIX_TIMESTAMP(created_at) AS time FROM classifications ORDER BY created_at DESC LIMIT 1",function(err, rows, fields) {

            if(err) throw err;
            maxTimeUnix = rows[0].time;
            console.log('maxTimeUnix: ', maxTimeUnix);

            var unixTime = maxTimeUnix-seconds;
            console.log('unixTime: ', unixTime);

            con.query("SELECT count(*) AS count,project,country "+
                "FROM classifications WHERE created_at > FROM_UNIXTIME("+unixTime+")"+
                "GROUP BY project,country", function(err, rows, fields) {

                con.release();
                if(err) throw err;
                res.send(rows);

            });
        });
    });
};

exports.getLastClassifications = function(req, res) {
    var count = parseInt(req.params.count);
    var offset = parseInt(req.params.offset);

    if(isNaN(count) || isNaN(offset)){
        res.send([]);
        return;
    }
    console.log('Retrieving last ' + count + ' classifications, offset: ' + offset);

    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT * FROM ?? LIMIT "+offset+","+count,['classifications'], function(err, rows, fields) {

            con.release();
            if(err) throw err;
            res.send(rows);
        });
    });
};

exports.getClassificationInterval = function(req, res) {

    // https://localhost:5000/classifications/from/1346457600/to/1348876800/interval/604800 // week interval
    // https://localhost:5000/classifications/from/1348790400/to/1348876800/interval/3600 // hour interval

    var from = parseInt(req.params.from); // unixTime
    var to = parseInt(req.params.to); // unixTime
    var interval = parseInt(req.params.interval); // seconds


    if(isNaN(from) || isNaN(to) || isNaN(interval)){
        res.send([]);
        return;
    }
    console.log('from: ' + from + ' to: ' + to, ' interval:' + interval);

    //https://stackoverflow.com/questions/2579803/group-mysql-data-into-arbitrarily-sized-time-buckets

    var classificationsTable = 'classifications';
    //var classificationsTable = 'classifications_archive';

    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT count(*) AS count,project,FLOOR((UNIX_TIMESTAMP(created_at)-"+from+")/"+interval+") AS time "+
            "FROM "+classificationsTable+" WHERE created_at BETWEEN FROM_UNIXTIME("+from+") AND FROM_UNIXTIME("+to+")"+
            "GROUP BY time,project", function(err, rows, fields) {

            con.release();
            if(err) throw err;
            _.map(rows,function(item){
                //console.log("divided time",item.time);
                item.time = parseFloat(item.time)*interval + from;
                item.date = new Date(item.time*1000).toISOString();
                //console.log('date',item.date,'count',item.count,"time",item.time);
            });

            var minTimeMs = from*1000;
            var nBars = (to-from)/interval;
            console.log('nBars',nBars);
            var projects = {};

            var projectsObj = _.countBy(rows,'project');

            _.each(projectsObj,function(val,project){

                var values = [];
                for(var i=0;i<nBars;i++){
                    var time = new Date(minTimeMs+interval*1000*i);
                    //time = new Date( Date.UTC(time.getFullYear(), time.getMonth(),time.getDate(),time.getHours(),time.getMinutes(), time.getSeconds()));

                    var timeStr = time.toISOString();
                    values.push({"label":timeStr,"value":0});
                    //console.log('timeStr',timeStr);
                }

                projects[project] = {
                    key: project,
                    values: values
                };
            });

            _.each(rows,function(row){

                var series = projects[row.project];
                var item = _.find(series.values,{'label':row.date});
                if(item){
                    item.value = row.count;
                }
                //console.log('row.date',row.date);

            });

            var output = [];

            _.each(projects,function(val,project){
                output.push(projects[project]);
            });
            res.send(output);

        });
    });
};



/*---------------------------------------------------------------------------*/

// Analytics routes


exports.updateAnalytics = function(req, res) {

    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("TRUNCATE `analytics`",function(err) {

            if(err) {
                con.release();
                throw err;
            }

            var intervals = [1,12,24,24*7,24*30]; // hours
            //var intervals = [1]; // hours
            var types = ['c','u']; // classifications, users
            var list = [];

            for(var t=0;t<types.length;t++){
                for(var i=0;i<intervals.length;i++){
                    list.push({type:types[t],interval:intervals[i]});
                    console.log(types[t],intervals[i]);
                }
            }

            updateAnalyticsIntervals(res,list,con);
        });
    });
};


function updateAnalyticsIntervals(res,analyticsArray,con){
    var analytics = analyticsArray.shift();
    var interval = analytics.interval; // hours
    var dataType = analytics.type;
    var seconds = interval*60*60;

    console.log('updateAnalyticsIntervals',analytics.type, analytics.interval);


    var maxTimeUnix = 0;
    // type, project, interval, country, count
    con.query("SELECT UNIX_TIMESTAMP(created_at) AS time FROM classifications ORDER BY created_at DESC LIMIT 1",function(err, rows, fields) {

        if(err) throw err;
        maxTimeUnix = rows[0].time;
        console.log('maxTimeUnix: ', maxTimeUnix);

        var unixTime = maxTimeUnix-seconds;
        console.log('unixTime: ', unixTime);

        var dataQuery = "";

        switch(dataType){
            case "c":
                dataQuery = "COUNT(*) AS count";
                break;
            case "u":
                dataQuery = "COUNT(DISTINCT user_id) as count";
                break;
        }
        var updateTime = (new Date()).valueOf()/1000;

        con.query("INSERT INTO analytics (`type_id`,`project`,`interval`,`country`,`count`,`updated`)"+
            "SELECT '"+dataType+"',project,'"+interval+"',country,"+dataQuery+",FROM_UNIXTIME("+updateTime+")"+
            "FROM classifications WHERE created_at > FROM_UNIXTIME("+unixTime+")"+
            "GROUP BY project,country", function(err, rows, fields) {

            if(err) {
                con.release();
                throw err;
            }
            if(analyticsArray.length>0){
                updateAnalyticsIntervals(res,analyticsArray,con);
            }
            else{
                con.release();
                res.send(rows);
            }

        });
    });
}


exports.getAnalytics = function(req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT `type_id`,`interval`,`project`,`country`,`count` FROM `analytics`",function(err, rows, fields) {
            con.release();
            if(err) throw err;
            res.send(rows);
        });
    });
};

exports.getAnalyticsAggregateCountries = function(req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("SELECT `project`,`type_id`,`interval`,SUM(`count`) as count FROM `analytics` GROUP BY `project`,`interval`,`type_id`",function(err, rows, fields) {
            if(err) throw err;
            con.release();
            res.send(rows);
        });
    });
};

function testUserAnalytics(res){
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query("INSERT INTO analytics (`type_id`,`project`,`interval`,`country`,`count`) "+
            "SELECT '1',project,'d',country,COUNT(DISTINCT user_id) as count "+
            "FROM classifications "+
            "GROUP BY project,country", function(err, rows, fields) {

            con.release();
            if(err) throw err;

            res.send(rows);
        });
    });
}

/*---------------------------------------------------------------------------*/

// Timeseries generation routes

exports.updateTimeSeries = function(req, res) {

    // localhost:5000/updateTimeSeries/from/1348790400/to/1348876800/interval/3600 // sept 2012
    // localhost:5000/updateTimeSeries/from/1362096000/to/1364688000/interval/3600
    // 1362096000 01/03/2013
    // 1364688000 31/03/2013

    var from = parseInt(req.params.from); // unix timestamp
    var to = parseInt(req.params.to); // unix timestamp
    var interval = parseInt(req.params.interval); // secs

    if(isNaN(to) || isNaN(from) || isNaN(interval)){
        res.send([]);
        return;
    }

    var bars={};
    bars[MIN_SECS] = 60, bars[MIN_5_SECS] = 60, bars[MIN_15_SECS] = 60, bars[HOUR_SECS] = 24, bars[DAY_SECS] = 30;

    from = Math.max(from,to-interval*bars[interval.toString()]);
    var series = [
        {type:'c',interval:interval,from:from,to:to},
        {type:'u',interval:interval,from:from,to:to}
    ];

    console.log('updateTimeSeries',interval,from,to,bars[interval.toString()]);

    gPool.getConnection(function(error, con) {
        if(error) throw error;
        updateTimeSeriesIntervals(res,series,con);
    });

    /* test
     var from = 1348790400; //'2012-09-28'
     var to = 1348876800; //'2012-09-29'


     updateTimeSeriesIntervals(res,[{type:'c',interval:3600,from:from,to:to}]);
     */
};

function updateTimeSeriesIntervals(res,analyticsArray,con){
    var analytics = analyticsArray.shift();
    var interval = analytics.interval; // seconds
    var dataType = analytics.type;
    var from = analytics.from; // unix timestamp
    var to = analytics.to; // unix timestamp

    console.log('updateTimeSeriesIntervals',analytics.type, analytics.interval);

    var dataQuery = "";
    switch(dataType){
        case "c":
            dataQuery = "COUNT(*) AS count";
            break;
        case "u":
            dataQuery = "COUNT(DISTINCT user_id) as count";
            break;
        default:
            res.send([]);
            return;
    }


    con.query("SELECT "+dataQuery+",project,FLOOR((UNIX_TIMESTAMP(created_at)-"+from+")/"+interval+") AS time "+
        "FROM classifications WHERE created_at BETWEEN FROM_UNIXTIME("+from+") AND FROM_UNIXTIME("+to+")"+
        "GROUP BY time,project", function(err, rows, fields) {
        if(err) throw err;
        _.map(rows,function(item){
            //console.log("time bucket",item.time);
            item.time = parseFloat(item.time)*interval + from;
            //console.log('date',item.date,'count',item.count,"time",item.time);
        });

        var minTimeMs = from*1000;
        var nBars = (to-from)/interval;
        console.log('nBars',nBars);
        var projects = {};

        var projectsObj = _.countBy(rows,'project');

        // create date series
        _.each(projectsObj,function(val,project){

            var values = [];
            for(var i=0;i<nBars;i++){

                var unixtime = from+interval*i;
                values.push({"unixtime":unixtime,"value":0});
                //console.log('unixtime',unixtime);
            }

            projects[project] = {
                key: project,
                values: values
            };
        });

        // add counts to date series
        _.each(rows,function(row){

            var series = projects[row.project];
            var item = _.find(series.values,{'unixtime':row.time});
            //console.log('unixtime',row.time);
            if(item){
                item.value = row.count;
            }
            //console.log('row.date',row.date);
        });

        var unixNow = parseInt(new Date().valueOf()/1000);
        console.log('unixNow',unixNow);

        // create mysql inserts
        // INSERT INTO tbl_name (a,b,c) VALUES(1,2,3),(4,5,6),(7,8,9);

        var inserts = [];
        _.each(projects,function(project){
            _.each(project.values,function(item){
                inserts.push("('"+dataType+"','"+project.key+"','"+interval+"',FROM_UNIXTIME('"+ item.unixtime+"'),'"+item.value+"',FROM_UNIXTIME('"+unixNow+"'))");
            });
        });

        var insertStr = inserts.join(',');
        //console.log(insertStr);

        con.query("INSERT INTO timeseries (`type_id`,`project`,`interval`,`datetime`,`count`,`updated`) VALUES" +insertStr,
            function (err, rows, fields) {

            if (err) throw err;

            // delete previous data

            var maxTime = 0;
            // find last update time
            con.query("SELECT UNIX_TIMESTAMP(updated) AS time FROM timeseries ORDER BY updated DESC LIMIT 1",function(err, rows, fields) {

                if(err) throw err;
                maxTime = rows[0].time;
                console.log('maxTime: ', maxTime,'type',dataType,'interval',interval);

                // delete interval records before last update
                var query = "DELETE FROM timeseries WHERE `updated` != FROM_UNIXTIME('"+maxTime+"') AND `type_id` = '"+dataType+"' AND `interval` = "+interval;

                console.log(query);
                con.query(query, function(err, rows, fields) {

                        if(err) throw err;
                        if (analyticsArray.length > 0) {
                            updateTimeSeriesIntervals(res, analyticsArray,con);
                        }
                        else{
                            con.release();
                            res.send(rows);
                        }
                });
            });
        });
    });
}

/*---------------------------------------------------------------------------*/

// Database stats


exports.getDBstats = function(req, res) {
    var output = [];
    gPool.getConnection(function(error, con) {
        if(error) throw error;
        con.query('SELECT project, COUNT(*) AS totalclassifications, MIN(created_at) as first, MAX(created_at) as last FROM ?? group by project order by last desc',['classifications'], function(err, rows, fields) {
            if(err) throw err;
            console.log('Classification count: ', rows[0].totalclassifications, ' first: ', rows[0].first, ' last: ', rows[0].last);
            output.push(rows);
            con.query("SELECT (data_length+index_length)/1048576 tablesize_mb from information_schema.tables where table_schema=? and table_name='classifications'", [WNU_DB_NAME], function(error, rows, fields){
                if(err) throw err;
                console.log('DB size (mb) on disk: ', rows[0].tablesize_mb);
                con.release();
                output.push(rows[0]);
                res.send(output);
            });
        });
    });
};


/*---------------------------------------------------------------------------*/

// Optimize table


exports.optimize = function (req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;

        con.query('OPTIMIZE TABLE classifications', function (err, rows) {
            con.release();
            if (err) {
                res.send({status: 0});
            } else {
                res.send({status: 1});
            }
        });
    });
};

/*---------------------------------------------------------------------------*/

// Monitoring


exports.ping = function (req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;

        con.query('SELECT 1', function (err, rows) {
            con.release();
            if (err) {
                res.send({status: 0});
            } else {
                res.send({status: 1});
            }
        });
    });
    //console.log('ping');
};


exports.isUpdating = function (req, res) {
    gPool.getConnection(function(error, con) {
        if(error) throw error;

        con.query('SELECT UNIX_TIMESTAMP(updated) as time FROM projects ORDER BY updated DESC LIMIT 1', function (err, rows) {
            con.release();
            if(err) throw err;

            var lastUpdate = rows[0]['time'];
            //console.log(lastUpdate);
            //console.log(rows[0]);
            var curUnixTime = parseInt((new Date()).valueOf()/1000);
            var dt = curUnixTime-lastUpdate;
            //console.log("isUpdating dt",dt,"seconds");
            if(dt>gMaxUpdateInterval){
                res.send({status: 0});
            }
            else{
                res.send({status: 1});
            }
        });
    });

};

module.exports.nconf = nconf;
