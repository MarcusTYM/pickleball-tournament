const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Shared State across Host and Clients
let tournamentData = {
  courts: {
    1: { teamA: "Pair A1", teamB: "Pair A2", scoreA: 0, scoreB: 0 },
    2: { teamA: "Pair B1", teamB: "Pair B2", scoreA: 0, scoreB: 0 },
    3: { teamA: "Pair C1", teamB: "Pair C2", scoreA: 0, scoreB: 0 }
  }
};

io.on('connection', (socket) => {
  // Send current score data when a client/host connects
  socket.emit('initData', tournamentData);

  // Listen for score updates from Court Clients
  socket.on('updateScore', ({ courtId, scoreA, scoreB }) => {
    if (tournamentData.courts[courtId]) {
      tournamentData.courts[courtId].scoreA = scoreA;
      tournamentData.courts[courtId].scoreB = scoreB;
      
      // Broadcast updated scores live to everyone
      io.emit('scoreUpdated', { courtId, scoreA, scoreB });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));