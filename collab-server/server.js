const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { Server: SocketIO } = require("socket.io");
const dotenv = require("dotenv");

const NODE_ENV = process.env.NODE_ENV || "development";
const envFile =
  NODE_ENV === "development" ? ".env.development" : ".env.production";
dotenv.config({ path: envFile });
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || (NODE_ENV === "development" ? 3002 : 80);
const DATA_DIR =
  process.env.COLLAB_DATA_DIR || path.resolve(__dirname, "../collab-data");
const SCENES_DIR = path.join(DATA_DIR, "scenes");
const FILES_DIR = path.join(DATA_DIR, "files");
const MAX_JSON_PAYLOAD = process.env.MAX_JSON_PAYLOAD || "25mb";

const fsp = fs.promises;

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const isValidSegment = (segment) =>
  typeof segment === "string" &&
  segment.length > 0 &&
  segment !== "." &&
  segment !== ".." &&
  !segment.includes(path.sep);

const sanitizeSegments = (rawPath) => {
  if (typeof rawPath !== "string") {
    throw new Error("Invalid path segment");
  }
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (!isValidSegment(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
  return segments;
};

const getSceneFilePath = (roomId) => {
  if (!isValidSegment(roomId)) {
    throw new Error("Invalid room id");
  }
  return path.join(SCENES_DIR, `${roomId}.json`);
};

const getFilePath = (prefix, fileId) => {
  if (!isValidSegment(fileId)) {
    throw new Error("Invalid file id");
  }
  const segments = sanitizeSegments(prefix);
  return path.join(FILES_DIR, ...segments, fileId);
};

const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

app.use((req, res, next) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: MAX_JSON_PAYLOAD }));

app.get("/", async (_req, res) => {
  res.send("Excalidraw collaboration server is up :)\n");
});

app.get("/api/scenes/:roomId", async (req, res) => {
  try {
    const scenePath = getSceneFilePath(req.params.roomId);
    const data = await fsp.readFile(scenePath, "utf8");
    res.type("application/json").send(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "scene_not_found" });
      return;
    }
    console.error("Failed to read scene", error);
    res.status(500).json({ error: "scene_read_failed" });
  }
});

app.post("/api/scenes/:roomId", async (req, res) => {
  const { sceneVersion, ciphertext, iv } = req.body || {};

  if (
    typeof sceneVersion !== "number" ||
    typeof ciphertext !== "string" ||
    typeof iv !== "string"
  ) {
    res.status(400).json({ error: "invalid_scene_payload" });
    return;
  }

  try {
    await ensureDirectory(SCENES_DIR);
    const scenePath = getSceneFilePath(req.params.roomId);
    await fsp.writeFile(
      scenePath,
      JSON.stringify({
        sceneVersion,
        ciphertext,
        iv,
        updatedAt: Date.now(),
      }),
      "utf8",
    );
    res.status(204).end();
  } catch (error) {
    console.error("Failed to store scene", error);
    res.status(500).json({ error: "scene_write_failed" });
  }
});

app.post("/api/files", async (req, res) => {
  const { prefix, files } = req.body || {};

  if (typeof prefix !== "string" || !Array.isArray(files)) {
    res.status(400).json({ error: "invalid_files_payload" });
    return;
  }

  const savedFiles = [];
  const erroredFiles = [];

  try {
    const segments = sanitizeSegments(prefix);
    const targetDir = path.join(FILES_DIR, ...segments);
    await ensureDirectory(targetDir);

    for (const file of files) {
      if (
        !file ||
        typeof file.id !== "string" ||
        typeof file.buffer !== "string"
      ) {
        if (file?.id) {
          erroredFiles.push(file.id);
        }
        continue;
      }

      try {
        const filePath = getFilePath(prefix, file.id);
        const buffer = Buffer.from(file.buffer, "base64");
        await ensureDirectory(path.dirname(filePath));
        await fsp.writeFile(filePath, buffer);
        savedFiles.push(file.id);
      } catch (error) {
        console.error(`Failed to store file ${file.id}`, error);
        erroredFiles.push(file.id);
      }
    }

    res.json({ savedFiles, erroredFiles });
  } catch (error) {
    console.error("Failed to process files payload", error);
    res.status(500).json({ error: "files_write_failed" });
  }
});

app.get("/api/files", async (req, res) => {
  const { prefix, id } = req.query;

  if (typeof prefix !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "invalid_query" });
    return;
  }

  try {
    const filePath = getFilePath(prefix, id);
    const data = await fsp.readFile(filePath);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type("application/octet-stream").send(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "file_not_found" });
      return;
    }
    console.error("Failed to read file", error);
    res.status(500).json({ error: "file_read_failed" });
  }
});

const server = http.createServer(app);

const io = new SocketIO(server, {
  transports: ["websocket", "polling"],
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  },
  allowEIO3: true,
});

io.on("connection", (socket) => {
  socket.emit("init-room");

  socket.on("join-room", async (roomId) => {
    await socket.join(roomId);

    const socketsAfterJoin = await io.in(roomId).fetchSockets();

    if (socketsAfterJoin.length <= 1) {
      socket.emit("first-in-room");
    } else {
      socket.broadcast.to(roomId).emit("new-user", socket.id);
    }

    io.in(roomId).emit(
      "room-user-change",
      socketsAfterJoin.map((client) => client.id),
    );
  });

  socket.on("server-broadcast", (roomId, encryptedData, iv) => {
    socket.broadcast.to(roomId).emit("client-broadcast", encryptedData, iv);
  });

  socket.on("server-volatile-broadcast", (roomId, encryptedData, iv) => {
    socket.volatile.broadcast
      .to(roomId)
      .emit("client-broadcast", encryptedData, iv);
  });

  socket.on("user-follow", async (payload) => {
    const roomId = `follow@${payload.userToFollow.socketId}`;

    if (payload.action === "FOLLOW") {
      await socket.join(roomId);
    } else {
      await socket.leave(roomId);
    }

    const socketsInRoom = await io.in(roomId).fetchSockets();
    const followedBy = socketsInRoom.map((client) => client.id);

    io.to(payload.userToFollow.socketId).emit(
      "user-follow-room-change",
      followedBy,
    );
  });

  socket.on("disconnecting", async () => {
    for (const roomId of Array.from(socket.rooms)) {
      const socketsInRoom = await io.in(roomId).fetchSockets();
      const otherClients = socketsInRoom.filter(
        (client) => client.id !== socket.id,
      );
      const isFollowRoom = roomId.startsWith("follow@");

      if (!isFollowRoom && otherClients.length > 0) {
        socket.broadcast.to(roomId).emit(
          "room-user-change",
          otherClients.map((client) => client.id),
        );
      }

      if (isFollowRoom && otherClients.length === 0) {
        const followedSocketId = roomId.replace("follow@", "");
        io.to(followedSocketId).emit("broadcast-unfollow");
      }
    }
  });

  socket.on("disconnect", () => {
    socket.removeAllListeners();
  });
});

server.listen(PORT, async () => {
  try {
    await Promise.all([ensureDirectory(SCENES_DIR), ensureDirectory(FILES_DIR)]);
  } catch (error) {
    console.error("Failed to initialize storage directories", error);
  }
  // eslint-disable-next-line no-console -- useful when running the server
  console.log(`Collaboration server listening on port ${PORT}`);
});
