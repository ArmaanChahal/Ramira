import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();

app.use(
	cors({
		origin: true, // tighten to your deployed frontend domain later
		credentials: true,
	})
);

const server = http.createServer(app);

const io = new Server(server, {
	cors: {
		origin: true,
		methods: ["GET", "POST"],
		credentials: true,
	},
});

const rooms = new Map(); // roomId -> { hostId, members: Set, names: Map }

function getRoom(roomId) {
	if (!rooms.has(roomId)) {
		rooms.set(roomId, { hostId: null, members: new Set(), names: new Map() });
	}
	return rooms.get(roomId);
}

io.on("connection", (socket) => {
	socket.on("ping", () => socket.emit("pong"));

	socket.on("room:join", ({ roomId, name }) => {
		if (!roomId) {
			socket.emit("room:error", { message: "Missing roomId" });
			return;
		}

		const room = getRoom(roomId);

		// Only allow 2 people (you + Ramira)
		if (room.members.size >= 2 && !room.members.has(socket.id)) {
			socket.emit("room:full");
			return;
		}

		const isFirst = room.members.size === 0;
		if (isFirst) {
			room.hostId = socket.id;
		}

		room.members.add(socket.id);
		room.names.set(socket.id, name || "Guest");
		socket.join(roomId);

		const peerId = [...room.members].find((id) => id !== socket.id) || null;
		const peerName = peerId ? room.names.get(peerId) : null;

		socket.emit("room:joined", {
			roomId,
			isHost: socket.id === room.hostId,
			selfId: socket.id,
			peerId,
			peerName,
		});

		if (peerId) {
			io.to(peerId).emit("peer:joined", {
				peerId: socket.id,
				peerName: room.names.get(socket.id),
			});
		}
	});

	socket.on("signal", ({ to, type, data }) => {
		if (!to) return;
		io.to(to).emit("signal", { from: socket.id, type, data });
	});

	socket.on("disconnect", () => {
		for (const [roomId, room] of rooms.entries()) {
			if (room.members.has(socket.id)) {
				room.members.delete(socket.id);
				room.names.delete(socket.id);

				// If host left, promote remaining person (if any)
				if (room.hostId === socket.id) {
					room.hostId = [...room.members][0] || null;
					if (room.hostId) {
						io.to(room.hostId).emit("room:host");
					}
				}

				// Notify remaining peer
				for (const id of room.members) {
					io.to(id).emit("peer:left", { peerId: socket.id });
				}

				// Cleanup empty room
				if (room.members.size === 0) {
					rooms.delete(roomId);
				}

				break;
			}
		}
	});
});

app.get("/", (_, res) => res.send("WatchParty signaling server OK"));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
	console.log(`Signaling server running on http://localhost:${PORT}`);
});
