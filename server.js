const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Stealth Chat Socket Engine Live', timestamp: new Date() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const memoryFallback = {};

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://admin:pass@cluster0.mongodb.net/stealth?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB Online"))
  .catch(err => console.log("MongoDB using fallback memory:", err.message));

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
    socket.activeRoom = cleanRoom;

    try {
      const history = await Message.find({ room: cleanRoom }).sort({ timestamp: 1 }).lean();
      socket.emit('load_history', history && history.length ? history : (memoryFallback[cleanRoom] || []));
    } catch {
      socket.emit('load_history', memoryFallback[cleanRoom] || []);
    }
  });

  socket.on('send_stealth_msg', async (data) => {
    if (!data.room || !data.encryptedText) return;
    const cleanRoom = data.room.trim().toLowerCase();

    const payload = {
      _id: 'msg_' + Date.now(),
      room: cleanRoom,
      senderRole: data.role || 'user',
      encryptedText: data.encryptedText,
      timestamp: new Date(),
      flaggedPending: false
    };

    if (!memoryFallback[cleanRoom]) memoryFallback[cleanRoom] = [];
    memoryFallback[cleanRoom].push(payload);

    io.to(cleanRoom).emit('receive_stealth_msg', payload);

    try {
      const newMsg = new Message(payload);
      await newMsg.save();
    } catch (e) {}
  });

  socket.on('toggle_pending', async ({ messageId, status, room }) => {
    if (room) {
      const cleanRoom = room.trim().toLowerCase();
      if (memoryFallback[cleanRoom]) {
        const target = memoryFallback[cleanRoom].find(m => m._id === messageId);
        if (target) target.flaggedPending = status;
      }
      io.to(cleanRoom).emit('update_msg_status', { messageId, flaggedPending: status });
    }
    try {
      await Message.findByIdAndUpdate(messageId, { flaggedPending: status });
    } catch (e) {}
  });

  socket.on('send_assistant_alert', (data) => {
    if (!data.room) return;
    io.to(data.room.trim().toLowerCase()).emit('receive_assistant_alert', data);
  });

  socket.on('bubble_popped', (data) => {
    if (!data.room) return;
    io.to(data.room.trim().toLowerCase()).emit('parent_bubble_pop_notify', data);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));