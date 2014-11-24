/**
 * Created by Laur on 23.11.2014.
 */

var cfEnv = require("cfenv");
var pkg   = require("../package.json");
var cfCore = cfEnv.getAppEnv({name: pkg.name});
var restify = require('restify');
var server = restify.createServer();
var io = require('socket.io').listen(server.server);

server.use(restify.acceptParser(server.acceptable));
server.use(restify.queryParser());
server.use(restify.gzipResponse());

//serve static files
server.get(/.*/, restify.serveStatic({
    directory: './Client',
    default: 'index.html'
}));

var player = function(params){
    if (!params)
        params={};
    this.shields = params.shields || 1000;
    this.turnsSurvived = params.turnsSurvived || 0;
    this.lostShips = params.lostShips || 0;
    this.destroyedShips = params.destroyedShips || 0;
    this.damageReceived = params.damageReceived || 0;
    this.damageDone = params.damageDone || 0;
    this.fame = params.fame || 0;
    this.isActive = params.isActive || false;

    this.turnData = params.turnData;
};

var turnDataSample = {
    d_small:2,
    d_big:1,
    a_laser:2,
    a_missile:1
};

//****************GAME LOGIC*****************//
//players by name
var players = {};
var activePlayers = 0;
var globalTurn =0;
var ticksTillStart = 90;
var submittedTurnDataCount =0;
var chanceToMiss = 0.1;
var laserDmg = [50,150];
var missileDmg = [100,300];
var smallDef = 0.5;
var bigDef = 0.2;
var restoreChance = 0.15;
var restoreAmount = 50;


function GameLoop(){
    //wait for most players to submit
    if (submittedTurnDataCount/activePlayers > 0.7){
        io.sockets.emit('counter',ticksTillStart);
        ticksTillStart --;
    }

    if (activePlayers > 1 && submittedTurnDataCount == activePlayers || ticksTillStart <= 0){
        var playersInThisRound = {};
        for (var i in players){
            if (players[i].turnData)
                playersInThisRound[i] = players[i];
            else if (players[i].isActive){
                players[i].isActive = false;
                activePlayers--;
            }
        }
        DoTurnCounts(playersInThisRound);
        ticksTillStart = 90;
    }
}

function DoTurnCounts(activePl){
    for (var name in activePl){
        var me = activePl[name];
        CheckTurnSummary(me);
        var target = GetTarget(me,activePl);
        CheckTurnSummary(target);

        //damage calculation
        var lcell = me.turnData.a_laser;
        var mcell = me.turnData.a_missile;
        var ldmg = Math.random() < chanceToMiss ? 0 :laserDmg[0] + Math.round(Math.random()*(laserDmg[1]-laserDmg[0]));
        var mdmg = Math.random() < chanceToMiss ? 0 :missileDmg[0] + Math.round(Math.random()*(missileDmg[1]-missileDmg[0]));
        var rcvd=0;
        if (target.turnData.d_small == lcell)
            rcvd+= Math.round(ldmg*smallDef);
        if (target.turnData.d_big == lcell)
            rcvd+= Math.round(ldmg*bigDef);

        if (target.turnData.d_small == mcell)
            rcvd+= Math.round(mdmg*smallDef);
        if (target.turnData.d_big == mcell)
            rcvd+= Math.round(mdmg*bigDef);

        target.turnSummary.blocked += (mdmg+ldmg - rcvd);
        target.turnSummary.dodged+=ldmg < 0.1 ? 1:0 + mdmg < 0.1 ? 1:0;
        //last chance
        if (target.shields + target.turnSummary.recharged + restoreAmount > rcvd)
            target.turnSummary.recharged +=Math.random() < restoreChance ? restoreAmount:0;
        else if (target.shields > 0 && target.shields + target.turnSummary.recharged < rcvd)
            me.turnSummary.destroyedTarget = true;
        target.received+=rcvd;

        //restore shield
        me.recharged += Math.random() < restoreChance ? restoreAmount:0;
        //inflicted
        me.turnSummary.inflicted = target.turnSummary.received;
    }

    UpdateStatsAndClear(activePl);
    globalTurn++;
}

function CheckTurnSummary(pl){
    if (!pl.turnSummary)
        pl.turnSummary = {
            recharged:0,
            received:0,
            inflicted:0,
            blocked:0,
            dodged:0,
            destroyedTarget: false
        };
}

function UpdateStatsAndClear(activePl){
    for (var name in activePl) {
        var me = activePl[name];

        me.shields+= me.turnSummary.recharged - me.turnSummary.received;
        me.damageDone += me.turnSummary.inflicted;
        me.damageReceived += me.turnSummary.received;
        if (me.turnSummary.destroyedTarget)
            me.destroyedShips++;

        if (me.shields <= 0 ) {
            me.lostShips++;
            me.isActive = false;
        }
        else me.turnsSurvived++;

        delete me.turnData;
        io.to(name).emit('turnSummary',me);
        delete me.turnSummary;
    }
}

function GetTarget(me,all){
    var count = all.length;
    var targetName = null;
    do{
        var ti = Math.floor((Math.random() * count));
        targetName = Object.keys(all)[ti];
        if (all[targetName] == me || (count > 2 && me.lastTargetName == targetName))
            targetName = null;
    } while (targetName==null);
    me.lastTargetName = targetName;
    return all[targetName]
}

setInterval(GameLoop, 1000);


//****************GAME LOGIC END*****************//

//sockets stuff
io.sockets.on('connection', function (socket) {
    socket.emit('stats', {total:activePlayers,ready: submittedTurnDataCount});
    //console.log("id "+ socket.id +' joined');

    socket.on('turnData', function(data){

        if (!socket.room) { // new player join
            if (!players[data.name])
                players[data.name] = new player();

            if (players[data.name].isActive == false)
                io.sockets.emit('stats', {name: data.name, total: ++activePlayers,ready: submittedTurnDataCount});
            socket.join(data.name);
            socket.room=data.name;
        }

        players[data.name].isActive = true;
        players[socket.room].turnData = data.turnData;
        socket.broadcast.to(socket.room).emit('turnData', data.turnData);
        if (!players[data.name].turnData)
            io.sockets.emit('stats', {total:activePlayers,ready: ++submittedTurnDataCount});
    });

    socket.on('getPlayerByName', function (data){
        socket.emit('getPlayerByName', players[data.name] || new player());
    });

    socket.on('disconnect', function () {
        socket.leaveAll();
        if (socket.room && countInRoom(socket.room)==0) {
            players[socket.room].isActive =false;
            socket.broadcast.emit('stats', {total:--activePlayers,ready: submittedTurnDataCount});
        }
        //console.log("id "+ socket.id +' left');
    });

});

function countInRoom(roomId) {
    return Object.keys(io.adapter.rooms[roomId]).length;
}

server.listen(cfCore.port || 8080, function() {
    console.log('listening: %s', server.url);
});