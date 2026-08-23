const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send({ status: 'Stealth Server Active', timestamp: new Date() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-Memory Backup Store (Ensures 0% failure even if DB is reconnecting)
const roomHistoryMemory = {};
const pendingBookmarks = new Set();

const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDB Online"))
    .catch(err => console.log("DB fallback to memory store:", err.message));
}

io.on('connection', (socket) => {
  // Join Room Channel
  socket.on('join_room', ({ room, role }) => {
    if (!room) return;
    const cleanRoom = room.trim().toLowerCase();

    // Leave any other room except its own socket id
    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(cleanRoom);
    socket.activeRoom = cleanRoom;
    socket.userRole = role;

    // Send existing history instantly
    const history = roomHistoryMemory[cleanRoom] || [];
    socket.emit('load_history', history);
  });

  // Send Message
  socket.on('send_stealth_msg', (data) => {
    if (!data.room || !data.encryptedText) return;
    const cleanRoom = data.room.trim().toLowerCase();

    const payload = {
      _id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      room: cleanRoom,
      senderRole: data.role || 'user',
      encryptedText: data.encryptedText,
      timestamp: new Date(),
      flaggedPending: false
    };

    if (!roomHistoryMemory[cleanRoom]) {
      roomHistoryMemory[cleanRoom] = [];
    }
    roomHistoryMemory[cleanRoom].push(payload);

    // Instant Realtime broadcast to everyone in that room
    io.to(cleanRoom).emit('receive_stealth_msg', payload);
  });

  // Bookmark Toggle
  socket.on('toggle_pending', ({ messageId, status, room }) => {
    if (status) {
      pendingBookmarks.add(messageId);
    } else {
      pendingBookmarks.delete(messageId);
    }

    if (room) {
      const cleanRoom = room.trim().toLowerCase();
      if (roomHistoryMemory[cleanRoom]) {
        const msg = roomHistoryMemory[cleanRoom].find(m => m._id === messageId);
        if (msg) msg.flaggedPending = status;
      }
      io.to(cleanRoom).emit('update_msg_status', { messageId, flaggedPending: status });
    }
  });

  // Assistant Alert
  socket.on('send_assistant_alert', (data) => {
    if (!data.room) return;
    const cleanRoom = data.room.trim().toLowerCase();
    socket.to(cleanRoom).emit('receive_assistant_alert', data);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));