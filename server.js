const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Generate 18 Pairs into 3 Groups
function initializeTournament() {
  const groups = { A: [], B: [], C: [] };
  ['A', 'B', 'C'].forEach(g => {
    for (let i = 1; i <= 6; i++) {
      groups[g].push({ name: `Pair ${g}${i}`, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0 });
    }
  });

  // Generate Round Robin Schedule (15 matches per group = 45 matches total)
  let schedule = [];
  let matchId = 1;
  ['A', 'B', 'C'].forEach(g => {
    const teams = groups[g].map(t => t.name);
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        schedule.push({
          id: matchId++,
          group: g,
          teamA: teams[i],
          teamB: teams[j],
          scoreA: 0,
          scoreB: 0,
          status: 'UPCOMING', // UPCOMING, LIVE, FINISHED
          court: null
        });
      }
    }
  });

  return { groups, schedule };
}

let tournament = initializeTournament();

// Active assignments on the 3 courts
let activeCourts = {
  1: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  2: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  3: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 }
};

io.on('connection', (socket) => {
  // Send current state to newly connected client/host
  socket.emit('initData', { tournament, activeCourts });

  // Assign match to a court
  socket.on('assignMatch', ({ matchId, courtId }) => {
    const match = tournament.schedule.find(m => m.id === matchId);
    if (match && match.status === 'UPCOMING') {
      match.status = 'LIVE';
      match.court = courtId;
      activeCourts[courtId] = { matchId: match.id, teamA: match.teamA, teamB: match.teamB, scoreA: 0, scoreB: 0 };
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  // Live Score Update from Referee Phone
  socket.on('updateScore', ({ courtId, scoreA, scoreB }) => {
    if (activeCourts[courtId] && activeCourts[courtId].matchId) {
      activeCourts[courtId].scoreA = scoreA;
      activeCourts[courtId].scoreB = scoreB;
      
      const match = tournament.schedule.find(m => m.id === activeCourts[courtId].matchId);
      if (match) {
        match.scoreA = scoreA;
        match.scoreB = scoreB;
      }
      io.emit('scoreUpdated', { courtId, scoreA, scoreB });
    }
  });

  // Finish Match & Update Standings
  socket.on('finishMatch', ({ courtId }) => {
    const court = activeCourts[courtId];
    if (!court || !court.matchId) return;

    const match = tournament.schedule.find(m => m.id === court.matchId);
    if (match) {
      match.status = 'FINISHED';
      match.scoreA = court.scoreA;
      match.scoreB = court.scoreB;

      // Update Group Standings
      const groupList = tournament.groups[match.group];
      const tA = groupList.find(t => t.name === match.teamA);
      const tB = groupList.find(t => t.name === match.teamB);

      if (tA && tB) {
        tA.pointsFor += court.scoreA;
        tA.pointsAgainst += court.scoreB;
        tB.pointsFor += court.scoreB;
        tB.pointsAgainst += court.scoreA;

        tA.diff = tA.pointsFor - tA.pointsAgainst;
        tB.diff = tB.pointsFor - tB.pointsAgainst;

        if (court.scoreA > court.scoreB) {
          tA.wins += 1;
          tB.losses += 1;
        } else {
          tB.wins += 1;
          tA.losses += 1;
        }

        // Sort Standings: Wins -> Point Diff
        groupList.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
      }
    }

    // Reset Court
    activeCourts[courtId] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 };
    io.emit('stateUpdated', { tournament, activeCourts });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));