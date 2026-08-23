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

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://admin:pass@cluster0.mongodb.net/stealth?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Connection Warning:", err.message));

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  senderRole: { type: String, default: 'user' },
  encryptedText: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  flaggedPending: { type: Boolean, default: false }
});

const Message = mongoose.model('Message', messageSchema);

io.on('connection', (socket) => {
  socket.on('join_room', async ({ room, role }) => {
    if (!room) return;
    const cleanRoom = room.trim().toLowerCase();

    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(cleanRoom);

    try {
      const history = await Message.find({ room: cleanRoom }).sort({ timestamp: 1 });
      socket.emit('load_history', history);
    } catch (e) {
      socket.emit('load_history', []);
    }
  });

  socket.on('send_stealth_msg', async (data) => {
    if (!data.room || !data.encryptedText) return;
    const cleanRoom = data.room.trim().toLowerCase();

    try {
      const newMsg = new Message({
        room: cleanRoom,
        senderRole: data.role || 'user',
        encryptedText: data.encryptedText,
        timestamp: new Date(),
        flaggedPending: false
      });
      const savedMsg = await newMsg.save();

      const payload = {
        _id: savedMsg._id.toString(),
        room: cleanRoom,
        senderRole: savedMsg.senderRole,
        encryptedText: savedMsg.encryptedText,
        timestamp: savedMsg.timestamp,
        flaggedPending: false
      };

      io.to(cleanRoom).emit('receive_stealth_msg', payload);
    } catch (err) {
      console.error("Save msg error:", err.message);
    }
  });

  // Bookmark Pending Persistence
  socket.on('toggle_pending', async ({ messageId, status }) => {
    try {
      const updated = await Message.findByIdAndUpdate(
        messageId, 
        { flaggedPending: status }, 
        { new: true }
      );
      if (updated) {
        io.to(updated.room).emit('update_msg_status', { 
          messageId, 
          flaggedPending: updated.flaggedPending 
        });
      }
    } catch (e) {
      console.error("Pending flag error:", e.message);
    }
  });

  socket.on('send_assistant_alert', (data) => {
    if (!data.room) return;
    const cleanRoom = data.room.trim().toLowerCase();
    socket.to(cleanRoom).emit('receive_assistant_alert', data);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));