const { v4: uuidv4 } = require("uuid");
const httpServer = require("http").createServer();
const Redis = require("ioredis");

const objectHash = require("object-hash");

const events = require("./events");

const redisClient = new Redis(process.env.REDIS_HOST);
const io = require("socket.io")(httpServer, {
  path: "/socket.io",
  cors: {
    origin: [process.env.FRONTEND_HOSTNAME],
  },
  adapter: require("socket.io-redis")({
    pubClient: redisClient,
    subClient: redisClient.duplicate(),
  }),
});

const { setupWorker } = require("@socket.io/sticky");
const crypto = require("crypto");
const randomId = () => crypto.randomBytes(8).toString("hex");

const { RedisSessionStore } = require("./redis/sessionStore");
const sessionStore = new RedisSessionStore(redisClient);

const { RedisMessageStore } = require("./redis/messagesStore");
const messageStore = new RedisMessageStore(redisClient);

setInterval(async () => {
  const sessions = await sessionStore.findAllSessions();
  const rooms = await io.of("/").adapter.allRooms();
}, 3000);

io.use(async (socket, next) => {
  console.log(new Date().toISOString());

  console.log("middleware -!-!- socket.handshake.auth", socket.handshake.auth);

  const sessionID = socket.handshake.auth.sessionID;
  const guestInfo = socket.handshake.auth.guestInfo;

  if (sessionID) {
    const session = await sessionStore.findSession(sessionID, objectHash);

    console.log("FOUND", session);

    if (session) {
      // rooms that guest has joined
      socket.data.rooms = session.rooms;
      socket.data.sessionID = session.sessionID;
      socket.data.socketID = socket.id;
      socket.data.guestInfo = session.guestInfo;
      return next();
    }
  }

  if (!sessionID) {
    return next(new Error("invalid sessionID"));
  }

  socket.data.sessionID = sessionID;
  socket.data.socketID = socket.id;
  socket.data.guestInfo = guestInfo;
  // roomID's will be reproducibled and will be the object hash of
  // all the members sorted in alphabetical order
  socket.data.rooms = [
    {
      name: guestInfo.name || "default",
      roomID: sessionID,
      members: [guestInfo.email],
    },
  ];
  next();
});

io.on("connection", async (socket) => {
  console.log(new Date().toISOString());

  console.log("CONNECTION");
  console.log("CONNECTION");
  console.log("CONNECTION");

  console.log("connection - socket.data", socket.data);

  const sessionID = socket.data.sessionID;
  const socketID = socket.data.socketID;
  const guestInfo = socket.data.guestInfo;
  const roomsGuestHasJoined = socket.data.rooms;

  sessionStore.saveSession(sessionID, {
    roomsGuestHasJoined,
    sessionID,
    socketID,
    guestInfo,
    connected: true,
  });

  // emit session details
  socket.emit("session", {
    sessionID,
    socketID,
    guestInfo,
  });

  // join the default room for this guest
  socket.join(sessionID);

  // fetch rooms info in Redis -> short/medium term state
  const rooms = [];

  const allRooms = await sessionStore.findAllRoomsThatGuestHasJoined(sessionID);
  const messagesPerRoom = await messageStore.findMessagesForRooms(allRooms);

  console.log("-> messagesPerRoom", messagesPerRoom);
  console.log("-> allRooms", allRooms);

  allRooms.forEach((room) => {
    // console.log("looping over sessions", session);

    rooms.push({
      roomID: room.roomID,
      name: room.name,
      members: room.members,
      messages: messagesPerRoom[room.roomID] || [],
    });
  });

  console.log("rooms", rooms);
  socket.emit("rooms", rooms);

  const sockets = await io.of("/").adapter.sockets(new Set());
  console.log("*** sockets *** ->", sockets); // a Set containing all the connected socket ids

  const guestDataForSockets = await sessionStore.findGuestDataForSockets(
    sockets,
    sessionID
  );

  socket.emit("online members", guestDataForSockets);

  // notify existing users
  socket.broadcast.emit("session connected", {
    guestInfo,
    sessionID,
    socketID,
    connected: true,
  });

  events.privateMessage(socket, sessionID, guestInfo, messageStore);
  events.disconnect(io, socket, sessionID, sessionStore);
  events.joinRoom(socket, sessionStore, objectHash, sessionID, io);
  events.deleteRoom(socket, sessionStore, objectHash, sessionID, io);
});

setupWorker(io);
