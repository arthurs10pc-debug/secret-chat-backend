require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// CORS setup
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

// Base64 images transfer ke liye large payload limit
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e7, // 50MB socket transfer buffer
  transports: ['websocket', 'polling']
});

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://het:het123@cluster0.mongodb.net/stealth_chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB successfully."))
  .catch((err) => console.log("MongoDB connection fallback to memory:", err.message));

// Message Schema
const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  senderRole: { type: String, required: true }, // 'user' (A) or 'parent' (H)
  encryptedText: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  flaggedPending: { type: Boolean, default: false },
  isSeen: { type: Boolean, default: false },
  isMedia: { type: Boolean, default: false },
  mediaOpened: { type: Boolean, default: false },
  reaction: { type: String, default: null },
  replyRefId: { type: String, default: null }
});

const Message = mongoose.model('Message', messageSchema);

// In-Memory Fallback Store
const memoryMessages = [];

// Base Route
app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat Socket Engine v2" });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. Join Room & Load Full History
  socket.on('join_room', async ({ room, role }) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined room "${room}" as role "${role}"`);

    try {
      let history = [];
      if (mongoose.connection.readyState === 1) {
        history = await Message.find({ room }).sort({ timestamp: 1 }).lean();
      } else {
        history = memoryMessages.filter(m => m.room === room);
      }
      socket.emit('load_history', history);
    } catch (error) {
      console.error("Error loading chat history:", error);
    }
  });

  // 2. Send Message Relay (Text & Media)
  socket.on('send_stealth_msg', async (data) => {
    const { room, role, encryptedText, isMedia, replyRefId } = data;
    const newMsgData = {
      _id: new mongoose.Types.ObjectId().toString(),
      room,
      senderRole: role,
      encryptedText,
      timestamp: new Date(),
      flaggedPending: false,
      isSeen: false,
      isMedia: Boolean(isMedia),
      mediaOpened: false,
      reaction: null,
      replyRefId: replyRefId || null
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

      io.to(room).emit('messages_marked_seen', { viewerRole });
    } catch (err) {
      console.error("Error processing seen status:", err);
    }
  });

  // 4. Mark Media Opened (Switches Locked EyeOff to Active Eye)
  socket.on('mark_media_opened', async ({ room, messageId }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { mediaOpened: true });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.mediaOpened = true;
      }
      io.to(room).emit('media_marked_opened', { messageId });
    } catch (err) {
      console.error("Error updating media opened state:", err);
    }
  });

  // 5. Destroy View-Once Media from Stream
  socket.on('destroy_view_once', async ({ room, messageId }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndDelete(messageId);
      } else {
        const idx = memoryMessages.findIndex(m => m._id === messageId);
        if (idx !== -1) memoryMessages.splice(idx, 1);
      }
    } catch (err) {
      console.error("Error deleting view-once asset:", err);
    }

    io.to(room).emit('message_destroyed_on_view', { messageId });
  });

  // 6. Reaction Synchronization
  socket.on('add_reaction', async ({ room, messageId, reaction }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { reaction });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.reaction = reaction;
      }
      io.to(room).emit('update_message_reaction', { messageId, reaction });
    } catch (err) {
      console.error("Error updating reaction:", err);
    }
  });

  // 7. Answer Pending Flag Toggle
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

  // 8. Glass Bubble Broadcast & Pop Notification
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