import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Video, VideoOff, Mic, MicOff, Monitor, MonitorOff, Users, Copy, Check, Sparkles, Play } from "lucide-react";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:3001";

function makeRoomId() {
	const chars = "abcdefghijklmnopqrstuvwxyz";
	let id = "";
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) id += chars[Math.floor(Math.random() * chars.length)];
		if (i < 2) id += "-";
	}
	return id;
}

export default function WatchParty() {
	const [roomId, setRoomId] = useState("");
	const [name, setName] = useState("Armaan"); // change if you want
	const [joined, setJoined] = useState(false);

	const [localStream, setLocalStream] = useState(null);
	const [screenStream, setScreenStream] = useState(null);

	const [remoteCamStream, setRemoteCamStream] = useState(null);
	const [remoteScreenStream, setRemoteScreenStream] = useState(null);
	const [remoteAudioStream, setRemoteAudioStream] = useState(null);

	const [isVideoOn, setIsVideoOn] = useState(true);
	const [isAudioOn, setIsAudioOn] = useState(true);
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [movieVolume, setMovieVolume] = useState(1);
	const [voiceVolume, setVoiceVolume] = useState(1);

	const [copied, setCopied] = useState(false);
	const [participants, setParticipants] = useState([{ id: "local", name: "You", isLocal: true }]);

	const socketRef = useRef(null);
	const pcRef = useRef(null);
	const isHostRef = useRef(false);
	const peerIdRef = useRef(null);

	// Track source mapping so we can route screen vs camera on the receiver
	const streamSourceRef = useRef(new Map()); // streamId -> "screen" | "camera"
	const pendingByStreamIdRef = useRef(new Map()); // streamId -> Set<MediaStreamTrack>

	const localVideoRef = useRef(null);
	const remoteVideoRef = useRef(null);
	const mainVideoRef = useRef(null);
	const remoteAudioRef = useRef(null);

	const localStreamRef = useRef(null);
	const screenStreamRef = useRef(null);
	
	useEffect(() => {
		localStreamRef.current = localStream;
	}, [localStream]);
	
	useEffect(() => {
		screenStreamRef.current = screenStream;
	}, [screenStream]);


	const popOutRamira = async () => {
		if (!remoteVideoRef.current) return;
	
		try {
			// Toggle PiP
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
			} else {
				await remoteVideoRef.current.requestPictureInPicture();
			}
		} catch (e) {
			console.error(e);
		}
	};

	
	useEffect(() => {
		if (remoteAudioRef.current) remoteAudioRef.current.volume = voiceVolume;
	}, [voiceVolume, remoteAudioStream]);

	useEffect(() => {
		if (mainVideoRef.current) mainVideoRef.current.volume = movieVolume;
	}, [movieVolume, isScreenSharing, screenStream, remoteScreenStream]);

	const startCamera = async () => {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: { width: 1280, height: 720, facingMode: "user" },
			audio: true,
		});
		setLocalStream(stream);
		localStreamRef.current = stream;
		if (localVideoRef.current) localVideoRef.current.srcObject = stream;
		return stream;
	};

	const ensurePC = () => {
		if (pcRef.current) return pcRef.current;

		const pc = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		});

		pc.onicecandidate = (e) => {
			if (!e.candidate || !peerIdRef.current) return;
			socketRef.current?.emit("signal", {
				to: peerIdRef.current,
				type: "ice",
				data: e.candidate,
			});
		};

		pc.ontrack = (e) => {
			const track = e.track;
			const stream = e.streams?.[0];
			const streamId = stream?.id;
		
			const source = streamId ? streamSourceRef.current.get(streamId) : null;
			// If we don't know if this STREAM is screen or camera yet, hold tracks briefly
			if (!source && streamId) {
				const set = pendingByStreamIdRef.current.get(streamId) || new Set();
				set.add(track);
				pendingByStreamIdRef.current.set(streamId, set);
				return;
			}
		
			const finalSource = source || "camera";
			attachTrackToProperStream(track, finalSource);
		
			track.onended = () => {
				if (finalSource === "screen") {
					setRemoteScreenStream(null);
				}
			};
		};


		pcRef.current = pc;
		return pc;
	};

	const addLocalTracks = (pc, stream, source) => {
		for (const track of stream.getTracks()) {
			// prevent duplicates (your code was adding the same cam tracks more than once)
			const already = pc.getSenders().some((s) => s.track && s.track.id === track.id);
			if (already) continue;
	
			pc.addTrack(track, stream);
		}
	
		// Tell peer what this STREAM represents (screen/camera)
		if (peerIdRef.current) {
			socketRef.current?.emit("signal", {
				to: peerIdRef.current,
				type: "streamSource",
				data: { streamId: stream.id, source },
			});
		}
	};


	const renegotiate = async () => {
		// Only host creates offers (avoids "offer glare")
		if (!isHostRef.current || !peerIdRef.current) {
			// ask host to renegotiate
			if (peerIdRef.current) {
				socketRef.current?.emit("signal", {
					to: peerIdRef.current,
					type: "renegotiate",
					data: {},
				});
			}
			return;
		}

		const pc = ensurePC();
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);

		socketRef.current?.emit("signal", {
			to: peerIdRef.current,
			type: "offer",
			data: pc.localDescription,
		});
	};

	const attachTrackToProperStream = (track, source) => {
		if (source === "screen") {
			setRemoteScreenStream((prev) => {
				const s = prev || new MediaStream();
				s.addTrack(track);
				return new MediaStream(s.getTracks());
			});
			return;
		}

		if (track.kind === "video") {
			setRemoteCamStream((prev) => {
				const s = prev || new MediaStream();
				s.addTrack(track);
				return new MediaStream(s.getTracks());
			});
		} else if (track.kind === "audio") {
			setRemoteAudioStream((prev) => {
				const s = prev || new MediaStream();
				s.addTrack(track);
				return new MediaStream(s.getTracks());
			});
		}
	};

		const sendExistingStreamSources = (peerId) => {
		const socket = socketRef.current;
		if (!socket || !peerId) return;
	
		if (localStreamRef.current) {
			socket.emit("signal", {
				to: peerId,
				type: "streamSource",
				data: { streamId: localStreamRef.current.id, source: "camera" },
			});
		}
	
		if (screenStreamRef.current) {
			socket.emit("signal", {
				to: peerId,
				type: "streamSource",
				data: { streamId: screenStreamRef.current.id, source: "screen" },
			});
		}
	};



	const connectSocket = () => {
		if (socketRef.current) return;

		const socket = io(SIGNALING_URL, { transports: ["websocket"] });
		socketRef.current = socket;

		socket.on("room:joined", async ({ isHost, peerId, peerName }) => {
			isHostRef.current = isHost;
			peerIdRef.current = peerId;

			setJoined(true);

			// names panel
			setParticipants([
				{ id: "local", name: "You", isLocal: true },
				...(peerId ? [{ id: "peer", name: peerName || "Ramira", isLocal: false }] : []),
			]);

			const cam = localStreamRef.current || (await startCamera());
			const pc = ensurePC();

			// add camera/mic tracks as "camera"
			addLocalTracks(pc, cam, "camera");

			// If someone already in room, host starts the call
			if (peerId && isHostRef.current) {
				await renegotiate();
			}
		});

		socket.on("peer:joined", async ({ peerId, peerName }) => {
			peerIdRef.current = peerId;

		    sendExistingStreamSources(peerId);

			setParticipants([
				{ id: "local", name: "You", isLocal: true },
				{ id: "peer", name: peerName || "Ramira", isLocal: false },
			]);

			// If we are host, create the offer now
			if (isHostRef.current) {
				await renegotiate();
			}
		});

		socket.on("room:host", async () => {
			// You became host (other person left)
			isHostRef.current = true;
		});

		socket.on("peer:left", () => {
			peerIdRef.current = null;
			setParticipants([{ id: "local", name: "You", isLocal: true }]);
			setRemoteCamStream(null);
			setRemoteScreenStream(null);
			setRemoteAudioStream(null);
		});

		socket.on("room:full", () => {
			alert("This room already has 2 people. Make a new code.");
		});

		socket.on("signal", async ({ from, type, data }) => {
			peerIdRef.current = from;
			const pc = ensurePC();

			if (type === "streamSource") {
				// data: { streamId, source: "screen" | "camera" }
				if (data?.streamId && data?.source) {
					streamSourceRef.current.set(data.streamId, data.source);

					const pending = pendingByStreamIdRef.current.get(data.streamId);
					if (pending) {
						for (const t of pending) {
							attachTrackToProperStream(t, data.source);
						}
						pendingByStreamIdRef.current.delete(data.streamId);
					}
				}
				return;
			}

			if (type === "renegotiate") {
				if (isHostRef.current) {
					await renegotiate();
				}
				return;
			}

			if (type === "offer") {
				await pc.setRemoteDescription(data);

				// Ensure we have local camera before answering
				const cam = localStreamRef.current || (await startCamera());
				addLocalTracks(pc, cam, "camera");

				const answer = await pc.createAnswer();
				await pc.setLocalDescription(answer);

				socketRef.current?.emit("signal", {
					to: from,
					type: "answer",
					data: pc.localDescription,
				});
				return;
			}

			if (type === "answer") {
				await pc.setRemoteDescription(data);
				return;
			}

			if (type === "ice") {
				try {
					await pc.addIceCandidate(data);
				} catch {
					// ignore
				}
			}
		});
	};

	const createRoom = async () => {
		connectSocket();
		const id = makeRoomId();
		setRoomId(id);

		socketRef.current?.emit("room:join", { roomId: id, name });
	};

	const joinRoom = async () => {
		if (!roomId.trim()) return;
		connectSocket();

		socketRef.current?.emit("room:join", { roomId: roomId.trim(), name });
	};

	const copyRoomId = () => {
		navigator.clipboard.writeText(roomId);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const startScreenShare = async () => {
		try {
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: { cursor: "always" },
				audio: true, // works best when you share a Chrome tab and enable “Share tab audio”
			});

			setScreenStream(stream);
			screenStreamRef.current = stream;
			setIsScreenSharing(true);

			const pc = ensurePC();
			addLocalTracks(pc, stream, "screen");

			// re-offer so peer starts receiving screen tracks
			await renegotiate();

			stream.getVideoTracks()[0].onended = async () => {
				await stopScreenShare();
			};
		} catch (e) {
			console.error(e);
		}
	};

	const stopScreenShare = async () => {
		const stream = screenStreamRef.current;
		if (!stream) return;

		const pc = pcRef.current;
		if (pc) {
			for (const sender of pc.getSenders()) {
				if (sender.track && stream.getTracks().some((t) => t.id === sender.track.id)) {
					pc.removeTrack(sender);
				}
			}
		}

		stream.getTracks().forEach((t) => t.stop());
		screenStreamRef.current = null;

		setScreenStream(null);
		setIsScreenSharing(false);

		await renegotiate();
	};


	const toggleVideo = () => {
		if (!localStream) return;
		for (const t of localStream.getVideoTracks()) t.enabled = !t.enabled;
		setIsVideoOn((v) => !v);
	};

	const toggleAudio = () => {
		if (!localStream) return;
		for (const t of localStream.getAudioTracks()) t.enabled = !t.enabled;
		setIsAudioOn((v) => !v);
	};

	const leaveRoom = () => {
		try {
			pcRef.current?.close();
		} catch {}
		pcRef.current = null;

		socketRef.current?.disconnect();
		socketRef.current = null;

		localStream?.getTracks().forEach((t) => t.stop());
		screenStream?.getTracks().forEach((t) => t.stop());

		setLocalStream(null);
		setScreenStream(null);
		setRemoteCamStream(null);
		setRemoteScreenStream(null);
		setRemoteAudioStream(null);

		setIsScreenSharing(false);
		setJoined(false);
		setParticipants([{ id: "local", name: "You", isLocal: true }]);
	};

	// Attach streams to elements
	useEffect(() => {
		if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
	}, [localStream]);

	useEffect(() => {
		if (remoteVideoRef.current && remoteCamStream) remoteVideoRef.current.srcObject = remoteCamStream;
	}, [remoteCamStream]);

	useEffect(() => {
		// main shows local screen if you're sharing, otherwise remote screen
		const mainStream = isScreenSharing ? screenStream : remoteScreenStream;
		if (mainVideoRef.current) mainVideoRef.current.srcObject = mainStream || null;
	}, [isScreenSharing, screenStream, remoteScreenStream]);

	useEffect(() => {
		if (remoteAudioRef.current && remoteAudioStream) remoteAudioRef.current.srcObject = remoteAudioStream;
	}, [remoteAudioStream]);

	useEffect(() => {
		if (!joined) return;

		const socket = socketRef.current;
		if (!socket) return;

		const id = setInterval(() => {
			if (socket.connected) socket.emit("ping");
		}, 25000);

		return () => clearInterval(id);
	}, [joined]);

	useEffect(() => {
		return () => leaveRoom();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (!joined) {
		return (
			<div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
				<div className="absolute inset-0 overflow-hidden">
					<div className="absolute -top-40 -right-40 w-80 h-80 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-pulse" />
					<div className="absolute -bottom-40 -left-40 w-80 h-80 bg-pink-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-pulse" style={{ animationDelay: "1s" }} />
					<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-blue-500 rounded-full mix-blend-multiply filter blur-3xl opacity-10 animate-pulse" style={{ animationDelay: "2s" }} />
				</div>

				<div className="relative z-10 w-full max-w-md">
					<div className="text-center mb-8">
						<div className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 backdrop-blur-sm rounded-full mb-6">
							<Sparkles className="w-4 h-4 text-purple-300" />
							<span className="text-purple-200 text-sm font-medium">Watch Together (you + Ramira)</span>
						</div>
						<h1 className="text-5xl font-bold text-white mb-3 tracking-tight">
							Watch<span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">Party</span>
						</h1>
						<p className="text-slate-400 text-lg">Screen share + voice + camera, real-time</p>
					</div>

					<div className="bg-white/5 backdrop-blur-xl rounded-3xl p-8 border border-white/10 shadow-2xl">
						<div className="space-y-3 mb-4">
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Your name"
								className="w-full py-4 px-5 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 focus:bg-white/10 transition-all"
							/>
						</div>

						<button
							onClick={createRoom}
							className="w-full py-4 px-6 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold rounded-2xl mb-4 hover:from-purple-600 hover:to-pink-600 transition-all duration-300 shadow-lg shadow-purple-500/25 flex items-center justify-center gap-3"
						>
							<Play className="w-5 h-5" />
							Hey Ramira
						</button>

						<div className="flex items-center gap-4 my-6">
							<div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
							<span className="text-slate-500 text-sm">or join existing</span>
							<div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
						</div>

						<div className="space-y-3">
							<input
								type="text"
								value={roomId}
								onChange={(e) => setRoomId(e.target.value)}
								placeholder="Enter room code (e.g., abc-def-ghi)"
								className="w-full py-4 px-5 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 focus:bg-white/10 transition-all"
							/>
							<button
								onClick={joinRoom}
								disabled={!roomId.trim()}
								className="w-full py-4 px-6 bg-white/10 text-white font-semibold rounded-2xl hover:bg-white/20 transition-all duration-300 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3"
							>
								<Users className="w-5 h-5" />
								Join Room
							</button>
						</div>
					</div>

					<p className="text-center text-slate-500 text-sm mt-6">Best on Chrome. (Some streaming sites block screen capture.)</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-slate-950 flex flex-col">
			<audio ref={remoteAudioRef} autoPlay />

			<header className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-slate-900/50 backdrop-blur-sm">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-bold text-white">
						Watch<span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">Party</span>
					</h1>
					<div className="h-6 w-px bg-white/10" />
					<button onClick={copyRoomId} className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg hover:bg-white/10 transition-colors">
						<span className="text-slate-400 text-sm font-mono">{roomId}</span>
						{copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-slate-500" />}
					</button>
					<button
						onClick={popOutRamira}
						disabled={!remoteCamStream}
						className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
					>
						<span className="text-slate-400 text-sm">PiP</span>
					</button>
				</div>
				<div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg">
					<Users className="w-4 h-4 text-purple-400" />
					<span className="text-white text-sm">{participants.length} watching</span>
				</div>
			</header>

			<main className="flex-1 flex p-4 gap-4">
				<div className="flex-1 relative rounded-2xl overflow-hidden bg-gradient-to-br from-slate-900 to-slate-800 border border-white/5">
					{(isScreenSharing && screenStream) || remoteScreenStream ? (
						<video ref={mainVideoRef} autoPlay playsInline className="w-full h-full object-contain" />
					) : (
						<div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
							<div className="w-20 h-20 rounded-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center mb-6">
								<Monitor className="w-10 h-10 text-purple-400" />
							</div>
							<h2 className="text-2xl font-semibold text-white mb-2">No screen shared yet</h2>
							<p className="text-slate-400 max-w-md mb-6">Click “Share Screen” to share your movie/tab with Ramira.</p>
							<button
								onClick={startScreenShare}
								className="px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-medium rounded-xl hover:from-purple-600 hover:to-pink-600 transition-all shadow-lg shadow-purple-500/25"
							>
								Share Your Screen
							</button>
						</div>
					)}
				</div>

				<div className="w-64 flex flex-col gap-3">
					{/* Local */}
					<div className="relative aspect-video rounded-xl overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
						<video
							ref={localVideoRef}
							autoPlay
							playsInline
							muted
							className={`w-full h-full object-cover ${!isVideoOn ? "hidden" : ""}`}
							style={{ transform: "scaleX(-1)" }}
						/>
						{!isVideoOn && (
							<div className="absolute inset-0 flex items-center justify-center">
								<div className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
									<span className="text-white text-xl font-semibold">Y</span>
								</div>
							</div>
						)}
						<div className="absolute bottom-2 left-2">
							<span className="px-2 py-1 bg-black/50 backdrop-blur-sm rounded-lg text-white text-xs font-medium">You</span>
						</div>
					</div>

					{/* Remote */}
					<div className="relative aspect-video rounded-xl overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
						{remoteCamStream ? (
							<video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
						) : (
							<div className="w-full h-full bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center">
								<span className="text-white font-semibold">Waiting for Ramira…</span>
							</div>
						)}
						<div className="absolute bottom-2 left-2">
							<span className="px-2 py-1 bg-black/50 backdrop-blur-sm rounded-lg text-white text-xs font-medium">Ramira</span>
						</div>
					</div>

					<div className="aspect-video rounded-xl border-2 border-dashed border-white/10 flex items-center justify-center">
						<p className="text-slate-600 text-sm text-center px-4">Send the room code to Ramira</p>
					</div>
				</div>
			</main>

			<footer className="px-6 py-4 border-t border-white/5 bg-slate-900/50 backdrop-blur-sm">
				<div className="flex items-center justify-center gap-3">
					
					<button
						onClick={toggleAudio}
						className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300 ${
							isAudioOn ? "bg-white/10 text-white hover:bg-white/20" : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
						}`}
					>
						{isAudioOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
					</button>

					<button
						onClick={toggleVideo}
						className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300 ${
							isVideoOn ? "bg-white/10 text-white hover:bg-white/20" : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
						}`}
					>
						{isVideoOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
					</button>

					<button
						onClick={isScreenSharing ? stopScreenShare : startScreenShare}
						className={`px-6 h-14 rounded-2xl flex items-center gap-2 transition-all duration-300 font-medium ${
							isScreenSharing ? "bg-purple-500 text-white hover:bg-purple-600" : "bg-white/10 text-white hover:bg-white/20"
						}`}
					>
						{isScreenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
						{isScreenSharing ? "Stop Sharing" : "Share Screen"}
					</button>

					<div className="w-px h-10 bg-white/10 mx-2" />
					<div className="px-4 h-14 rounded-2xl bg-white/5 flex items-center gap-4">
						<div className="flex items-center gap-2">
							<span className="text-slate-300 text-xs">Movie</span>
							<input
								type="range"
								min="0"
								max="1"
								step="0.01"
								value={movieVolume}
								onChange={(e) => setMovieVolume(Number(e.target.value))}
								className="w-24"
							/>
						</div>
						<div className="w-px h-8 bg-white/10" />
						<div className="flex items-center gap-2">
							<span className="text-slate-300 text-xs">Voice</span>
							<input
								type="range"
								min="0"
								max="1"
								step="0.01"
								value={voiceVolume}
								onChange={(e) => setVoiceVolume(Number(e.target.value))}
								className="w-24"
							/>
						</div>
					</div>

					<button
						onClick={leaveRoom}
						className="px-6 h-14 rounded-2xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all duration-300 font-medium"
					>
						Leave Room
					</button>
				</div>
			</footer>
		</div>
	);
}
