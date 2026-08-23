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

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/stealth_chat";
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Error:", err));

// Message Schema with 7-Day TTL for non-parent if needed
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
    socket.join(room);
    socket.room = room;
    socket.role = role;

    try {
      const history = await Message.find({ room }).sort({ timestamp: 1 });
      socket.emit('load_history', history);
    } catch (err) {
      console.error(err);
    }
  });

  // Send Encrypted Message
  socket.on('send_stealth_msg', async (data) => {
    try {
      const newMsg = new Message({
        room: data.room,
        senderRole: data.role,
        encryptedText: data.encryptedText,
        timestamp: new Date()
      });
      await newMsg.save();

      io.to(data.room).emit('receive_stealth_msg', {
        _id: newMsg._id,
        room: newMsg.room,
        senderRole: newMsg.senderRole,
        encryptedText: newMsg.encryptedText,
        timestamp: newMsg.timestamp,
        flaggedPending: false
      });
    } catch (err) {
      console.error(err);
    }
  });

  // Toggle Answer Pending Flag (Parent only)
  socket.on('toggle_pending', async ({ messageId, status }) => {
    try {
      const updated = await Message.findByIdAndUpdate(messageId, { flaggedPending: status }, { new: true });
      if (updated) {
        io.to(updated.room).emit('update_msg_status', { messageId, flaggedPending: status });
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Assistant Alert Sync
  socket.on('send_assistant_alert', (data) => {
    socket.to(data.room).emit('receive_assistant_alert', data);
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));