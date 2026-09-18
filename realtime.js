"use strict";

const net = require("node:net");
const { WebSocket, WebSocketServer } = require("ws");

const IsToken = (Value) => typeof Value === "string" && /^[a-f0-9]{64}$/i.test(Value);
const IsText = (Value, Max) => typeof Value === "string" && Buffer.byteLength(Value) <= Max && !/[\u0000-\u001f\u007f]/.test(Value);
const IsLoopback = (Ip) => Ip === "::1" || Ip === "127.0.0.1" || Ip === "::ffff:127.0.0.1";
const USERS_INTERVAL_MS = 5000;
const USERS_LEASE_SECONDS = 20;

function NormalizePresence(Body)
{
	if(!Body || !IsText(Body.server_address, 128) || !IsText(Body.session_id, 128) || !Array.isArray(Body.players) || Body.players.length > 2) return null;
	const Players = [];
	const Ids = new Set();
	for(const Player of Body.players)
	{
		if(!Player || !Number.isInteger(Player.player_id) || Player.player_id < 0 || Player.player_id >= 128 || Ids.has(Player.player_id) || !IsText(Player.player_name, 63) || !Player.player_name || typeof Player.dummy !== "boolean") return null;
		Ids.add(Player.player_id);
		Players.push({ player_id: Player.player_id, player_name: Player.player_name, dummy: Player.dummy,
			foot_particles_enabled: Player.foot_particles_enabled === true, remote_particles_enabled: Player.remote_particles_enabled === true, voice_supported: Player.voice_supported === true });
	}
	if(Players.length && (!Body.server_address || !Body.session_id)) return null;
	return { server_address: Body.server_address, session_id: Body.session_id, players: Players };
}

function CreateRealtimeServer(Server, { Recognition, DeveloperService, TitleService, NewsService, Playtime, NowSec = () => Math.floor(Date.now() / 1000) })
{
	const Wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false,
		handleProtocols: (Protocols) => Protocols.has("qmclient-json") ? "qmclient-json" : false });
	const Sessions = new Map();
	const DirtyServers = new Set();
	let FlushPending = null;
	let Closed = false;

	function Send(Socket, Type, Data)
	{
		if(Socket.readyState !== WebSocket.OPEN) return;
		if(Socket.bufferedAmount > 16 * 1024 * 1024) { Socket.terminate(); return; }
		Socket.send(JSON.stringify({ type: Type, v: 2, data: Data }));
	}
	function Error(Socket, Code) { Send(Socket, "error", { error: Code }); }
	function FlushUsers(Socket, Session)
	{
		const Pending = Session.PendingUsers;
		if(!Pending) return;
		const Now = Date.now();
		// 只续发仍然新鲜的待发快照，不能用定时器给旧名单续租。
		if(Now - Pending.ReceivedAt >= USERS_LEASE_SECONDS * 1000) { Session.PendingUsers = null; return; }
		if(Socket.readyState !== WebSocket.OPEN || Socket.bufferedAmount > 0 ||
			(Session.LastUsersSentAt !== null && Now - Session.LastUsersSentAt < USERS_INTERVAL_MS)) return;
		const Users = Pending.Data.users.map(({ last_ip, ...User }) => {
			// 外服只需要分布统计字段；同服保留完整识别信息，避免全量附加数据挤占称号推送。
			if(User.server_address === Session.Presence.server_address) return User;
			return { server_address: User.server_address, player_name: User.player_name, dummy: User.dummy };
		});
		Send(Socket, "users", { users: Users, server_address: Session.Presence.server_address, lease_seconds: USERS_LEASE_SECONDS });
		Session.PendingUsers = null;
		Session.LastUsersSentAt = Now;
	}
	function Users(Socket, Data, Immediate = false)
	{
		const Session = Sessions.get(Socket);
		if(!Session) return;
		if(Immediate) { Session.PendingUsers = null; Session.LastUsersSentAt = null; }
		if(!Data) return;
		// 每个连接只保留最新名单；已有发送积压时不再堆积全量快照。
		Session.PendingUsers = { Data, ReceivedAt: Date.now() };
		FlushUsers(Socket, Session);
	}
	function Scoped(Socket, Session)
	{
		const Address = Session.Presence.server_address;
		if(!Address) return;
		const Developers = DeveloperService.GetPresences(Address);
		const Titles = TitleService.List(Address);
		if(Developers.response) Send(Socket, "developers", { ...Developers.response, server_address: Address });
		if(Titles.response) Send(Socket, "titles", { ...Titles.response, server_address: Address });
	}
	function Flush()
	{
		FlushPending = null;
		if(Closed) return;
		for(const [Socket, Session] of Sessions)
			if(DirtyServers.has(Session.Presence.server_address)) Scoped(Socket, Session);
		DirtyServers.clear();
	}
	function NotifyServer(Address)
	{
		if(Address) DirtyServers.add(Address);
		if(!FlushPending) FlushPending = setTimeout(Flush, 50);
	}
	function Report(Socket, Session, Body, Initial = false)
	{
		const Presence = NormalizePresence(Body);
		if(!Presence) return Error(Socket, "invalid_presence");
		const PreviousAddress = Session.Presence?.server_address;
		Session.Presence = Presence;
		// 只允许更新凭据与玩家状态；设备和时长身份固定在首次握手。
		if(Body.title_token !== undefined) Session.TitleToken = IsToken(Body.title_token) ? Body.title_token : "";
		if(Body.developer_token !== undefined) Session.DeveloperToken = IsToken(Body.developer_token) ? Body.developer_token : "";
		if(Presence.players.length)
		{
			Recognition.Report({ ...Presence, machine_hash: Session.MachineHash, client_type: "qm", timestamp: NowSec() }, Session.Ip);
			if(Session.DeveloperToken) DeveloperService.ReportPresence("Bearer " + Session.DeveloperToken, Presence);
			if(Session.TitleToken)
			{
				const Result = TitleService.Report("Bearer " + Session.TitleToken, Presence, Session.Ip);
				if(Result.statusCode !== 200) Send(Socket, "title_status", { status: Result.statusCode, ...Result.response });
			}
		}
		NotifyServer(PreviousAddress);
		NotifyServer(Presence.server_address);
		if(!Initial && PreviousAddress !== Presence.server_address) Users(Socket, Recognition.Current(), true);
	}
	function Time(Socket, Session)
	{
		Send(Socket, "time", { ts: NowSec() });
		const Result = Playtime("query", { client_id: Session.ClientId, player_name: Session.PlayerName });
		if(Result.statusCode === 200) Send(Socket, "playtime", { ...Result.response, ts: NowSec() });
	}
	function Profile(Socket, Session)
	{
		if(!Session.TitleToken) return;
		const Result = TitleService.Profile("Bearer " + Session.TitleToken);
		Send(Socket, "title_profile", { status: Result.statusCode, ...Result.response });
	}
	function Upgrade(Req, Socket, Head)
	{
		if(Req.url === "/ws/editor") return;
		if(Req.url?.split("?", 1)[0] !== "/ws") { Socket.destroy(); return; }
		const Protocols = String(Req.headers["sec-websocket-protocol"] || "").split(",").map((Value) => Value.trim());
		if(!Protocols.includes("qmclient-json")) { Socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
		Wss.handleUpgrade(Req, Socket, Head, (Ws) => Wss.emit("connection", Ws, Req));
	}
	Server.on("upgrade", Upgrade);
	Wss.on("connection", (Socket, Req) => {
		let LastSeen = Date.now();
		let WindowStart = LastSeen;
		let Count = 0;
		const Remote = Req.socket.remoteAddress;
		const Forwarded = Req.headers["x-real-ip"];
		const Ip = IsLoopback(Remote) && typeof Forwarded === "string" && net.isIP(Forwarded) ? Forwarded : Remote;
		Socket.on("error", () => {});
		Socket.on("pong", () => { LastSeen = Date.now(); });
		Socket.on("message", (Raw, Binary) => {
			LastSeen = Date.now();
			if(LastSeen - WindowStart >= 60000) { WindowStart = LastSeen; Count = 0; }
			if(++Count > 120) { Socket.close(1008, "rate_limited"); return; }
			if(Binary) return Error(Socket, "text_required");
			try
			{
				const Body = JSON.parse(Raw);
				if(!Body || typeof Body !== "object" || Array.isArray(Body)) return Error(Socket, "invalid_message");
				let Session = Sessions.get(Socket);
				if(Body.type === "hello")
				{
					if(Session) return Error(Socket, "already_initialized");
					if(Body.v !== 2 || !IsToken(Body.machine_hash) || typeof Body.client_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(Body.client_id) || !IsText(Body.player_name, 64) || !NormalizePresence(Body)) return Error(Socket, "invalid_hello");
					Session = { MachineHash: Body.machine_hash, ClientId: Body.client_id, PlayerName: Body.player_name,
						Ip, Presence: { server_address: "", session_id: "", players: [] }, TitleToken: "", DeveloperToken: "",
						PendingUsers: null, LastUsersSentAt: null };
					Sessions.set(Socket, Session);
					if(Number.isSafeInteger(Body.recovery_stop_at) && Body.recovery_stop_at > 0)
					{
						const Recovery = Playtime("stop", { client_id: Session.ClientId, player_name: Session.PlayerName, stop_at: Body.recovery_stop_at });
						if(Recovery.statusCode !== 200) { Sessions.delete(Socket); return Error(Socket, "playtime_unavailable"); }
					}
					const Started = Playtime("start", { client_id: Session.ClientId, player_name: Session.PlayerName });
					if(Started.statusCode !== 200) { Sessions.delete(Socket); return Error(Socket, "playtime_unavailable"); }
					Send(Socket, "playtime", { ...Started.response, ts: NowSec(), recovery_processed: true });
					Report(Socket, Session, Body, true);
					Profile(Socket, Session);
					Scoped(Socket, Session);
					Users(Socket, Recognition.Current(), true);
					Send(Socket, "broadcast", NewsService.Current().response);
					Send(Socket, "time", { ts: NowSec() });
					return;
				}
				if(!Session) return Error(Socket, "hello_required");
				switch(Body.type)
				{
				case "presence": Report(Socket, Session, Body); break;
				case "subscribe_titles":
					if(Body.title_token !== undefined) Session.TitleToken = IsToken(Body.title_token) ? Body.title_token : "";
					Profile(Socket, Session); Scoped(Socket, Session); break;
				case "news": Send(Socket, "broadcast", NewsService.Current().response); break;
				case "ping": Send(Socket, "pong", { ts: NowSec() }); break;
				case "pong": break;
				case "stop": {
					const Result = Playtime("stop", { client_id: Session.ClientId, player_name: Session.PlayerName, stop_at: Body.stop_at });
					if(Result.statusCode === 200) Send(Socket, "playtime", { ...Result.response, ts: NowSec() });
					break;
				}
				default: Error(Socket, "unknown_event");
				}
			}
			catch { Error(Socket, "service_unavailable"); }
		});
		const Heartbeat = setInterval(() => {
			if(Date.now() - LastSeen > 45000 || (!Sessions.has(Socket) && Date.now() - WindowStart > 15000)) { Socket.terminate(); return; }
			Socket.ping();
		}, 10000);
		Heartbeat.unref();
		Socket.on("close", () => {
			clearInterval(Heartbeat);
			const Session = Sessions.get(Socket);
			Sessions.delete(Socket);
			if(Session) NotifyServer(Session.Presence.server_address);
		});
	});
	const OnUsers = (Data) => { for(const Socket of Sessions.keys()) Users(Socket, Data); };
	const OnVoiceConnected = () => {
		for(const Session of Sessions.values())
			if(Session.Presence.players.length) Recognition.Report({ ...Session.Presence, machine_hash: Session.MachineHash, client_type: "qm" }, Session.Ip);
	};
	const OnVoiceDisconnected = () => {
		for(const Session of Sessions.values()) Session.PendingUsers = null;
	};
	Recognition.on("users", OnUsers);
	Recognition.on("connected", OnVoiceConnected);
	Recognition.on("disconnected", OnVoiceDisconnected);
	const LeaseTimer = setInterval(() => {
		for(const [Socket, Session] of Sessions)
		{
			try { FlushUsers(Socket, Session); Scoped(Socket, Session); Time(Socket, Session); }
			catch { Error(Socket, "service_unavailable"); }
		}
	}, 5000);
	LeaseTimer.unref();
	return {
		NotifyPresences(Address) { NotifyServer(Address); },
		NotifyTitles() { for(const Session of Sessions.values()) NotifyServer(Session.Presence.server_address); },
		NotifyNews() { for(const Socket of Sessions.keys()) Send(Socket, "broadcast", NewsService.Current().response); },
		Close()
		{
			Closed = true;
			clearInterval(LeaseTimer);
			clearTimeout(FlushPending);
			Recognition.off("users", OnUsers);
			Recognition.off("connected", OnVoiceConnected);
			Recognition.off("disconnected", OnVoiceDisconnected);
			Server.off("upgrade", Upgrade);
			for(const Socket of Wss.clients) Socket.terminate();
			Wss.close();
		}
	};
}

module.exports = { CreateRealtimeServer, NormalizePresence };
