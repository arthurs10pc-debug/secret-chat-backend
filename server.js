require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Cross-Origin Resource Sharing setup
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// MongoDB Connection (Fallback to in-memory store if DB string not provided)
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://het:het123@cluster0.mongodb.net/stealth_chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB successfully."))
  .catch((err) => console.log("MongoDB connection failed or skipped. Running memory fallback:", err.message));

// Message Schema
const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  senderRole: { type: String, required: true }, // 'user' (A) or 'parent' (H)
  encryptedText: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  flaggedPending: { type: Boolean, default: false },
  isSeen: { type: Boolean, default: false }
});

const Message = mongoose.model('Message', messageSchema);

// In-Memory Fallback History (If Mongo is unreachable)
const memoryMessages = [];

// Base Health Check Route
app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat Socket Server" });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. Join Room & Load History
  socket.on('join_room', async ({ room, role }) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined room "${room}" as role "${role}"`);

    try {
      let history = [];
      if (mongoose.connection.readyState === 1) {
        history = await Message.find({ room }).sort({ timestamp: 1 }).limit(100).lean();
      } else {
        history = memoryMessages.filter(m => m.room === room);
      }
      socket.emit('load_history', history);
    } catch (error) {
      console.error("Error loading chat history:", error);
    }
  });

  // 2. Send Encrypted Message Relay
  socket.on('send_stealth_msg', async (data) => {
    const { room, role, encryptedText } = data;
    const newMsgData = {
      _id: new mongoose.Types.ObjectId().toString(),
      room,
      senderRole: role,
      encryptedText,
      timestamp: new Date(),
      flaggedPending: false,
      isSeen: false
    };

    try {
      if (mongoose.connection.readyState === 1) {
        const savedMsg = await Message.create(newMsgData);
        newMsgData._id = savedMsg._id.toString();
      } else {
        memoryMessages.push(newMsgData);
      }
    } catch (err) {
      console.error("Error saving message:", err);
    }

    // Broadcast to everyone in the room (Sender gets sent status '.', Receiver gets message)
    io.to(room).emit('receive_stealth_msg', newMsgData);
  });

  // 3. Mark Messages Seen (Synchronizes '.' to '..')
  socket.on('mark_seen', async ({ room, viewerRole }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.updateMany(
          { room, senderRole: { $ne: viewerRole }, isSeen: false },
          { $set: { isSeen: true } }
        );
      } else {
        memoryMessages.forEach(m => {
          if (m.room === room && m.senderRole !== viewerRole) {
            m.isSeen = true;
          }
        });
      }

      // Broadcast receipt to all users in the room
      io.to(room).emit('messages_marked_seen', { viewerRole });
    } catch (err) {
      console.error("Error processing seen status:", err);
    }
  });

  // 4. Toggle Answer Pending Flag
  socket.on('toggle_pending', async ({ messageId, status, room }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { flaggedPending: status });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.flaggedPending = status;
      }
      io.to(room).emit('update_msg_status', { messageId, flaggedPending: status });
    } catch (err) {
      console.error("Error toggling pending flag:", err);
    }
  });

  // 5. Glass Bubble Broadcast & Pop Notifications
  socket.on('send_assistant_alert', ({ room, text }) => {
    io.to(room).emit('receive_assistant_alert', { text, timestamp: Date.now() });
  });

  socket.on('bubble_popped', ({ room }) => {
    socket.to(room).emit('parent_bubble_pop_notify');
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);
});