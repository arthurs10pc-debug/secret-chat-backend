const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/stealth_chat";
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Error:", err));

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  senderRole: { type: String, enum: ['parent', 'user'], default: 'user' },
  encryptedText: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  flaggedPending: { type: Boolean, default: false }
});

const Message = mongoose.model('Message', messageSchema);

io.on('connection', (socket) => {
  // Join Room
  socket.on('join_room', async ({ room, role }) => {
    if (!room) return;
    const cleanRoom = room.trim().toLowerCase();
    
    // Leave previous rooms
    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(cleanRoom);
    socket.activeRoom = cleanRoom;
    socket.role = role;

    try {
      const history = await Message.find({ room: cleanRoom }).sort({ timestamp: 1 });
      socket.emit('load_history', history);
    } catch (err) {
      console.error("Load history error:", err);
    }
  });

  // Send Encrypted Message
  socket.on('send_stealth_msg', async (data) => {
    if (!data.room || !data.encryptedText) return;
    const cleanRoom = data.room.trim().toLowerCase();

    try {
      const newMsg = new Message({
        room: cleanRoom,
        senderRole: data.role || 'user',
        encryptedText: data.encryptedText,
        timestamp: new Date()
      });
      await newMsg.save();

      const payload = {
        _id: newMsg._id,
        room: cleanRoom,
        senderRole: newMsg.senderRole,
        encryptedText: newMsg.encryptedText,
        timestamp: newMsg.timestamp,
        flaggedPending: false
      };

      // Broadcast to all sockets in that room
      io.to(cleanRoom).emit('receive_stealth_msg', payload);
    } catch (err) {
      console.error("Send message error:", err);
    }
  });

  // Toggle Answer Pending Flag
  socket.on('toggle_pending', async ({ messageId, status }) => {
    try {
      const updated = await Message.findByIdAndUpdate(messageId, { flaggedPending: status }, { new: true });
      if (updated) {
        io.to(updated.room).emit('update_msg_status', { messageId, flaggedPending: status });
      }
    } catch (err) {
      console.error("Pending flag error:", err);
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));