"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { WebSocket } = require("ws");
const { CreateRealtimeServer } = require("../realtime");

function MessageWhen(Socket, Matches)
{
	return new Promise((Resolve, Reject) => {
		const Signal = AbortSignal.timeout(2000);
		const Finish = (Error, Message) => {
			Socket.off("message", OnMessage);
			Socket.off("close", OnClose);
			Socket.off("error", OnError);
			Signal.removeEventListener("abort", OnTimeout);
			if(Error) Reject(Error);
			else Resolve(Message);
		};
		const OnMessage = (Raw) => {
			try
			{
				const Message = JSON.parse(Raw);
				if(Message.type === "error") Finish(new Error(Message.data.error));
				else if(Matches(Message)) Finish(null, Message);
			}
			catch(Error) { Finish(Error); }
		};
		const OnClose = () => Finish(new Error("收到预期消息前连接已关闭"));
		const OnError = (Error) => Finish(Error);
		const OnTimeout = () => Finish(new Error("等待实时消息超时"));
		Socket.on("message", OnMessage);
		Socket.once("close", OnClose);
		Socket.once("error", OnError);
		Signal.addEventListener("abort", OnTimeout, { once: true });
	});
}

async function Barrier(Client)
{
	const Pong = MessageWhen(Client.Socket, (Message) => Message.type === "pong");
	Client.Socket.send(JSON.stringify({ type: "ping" }));
	await Pong;
}

const ScopedMessages = (Client, Type) => Client.Messages.filter((Message) =>
	Type ? Message.type === Type : Message.type === "titles" || Message.type === "developers");

async function Fixture(T)
{
	let Now = 100000;
	T.mock.method(Date, "now", () => Now);
	T.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const Rooms = new Map();
	const Reads = { titles: [], developers: [] };
	const Reports = { titles: [], developers: [] };
	function Room(Address = "one:8303")
	{
		if(!Rooms.has(Address))
		{
			const Presence = { server_address: Address, dummy: false, issued_at: 100, expires_at: 115 };
			Rooms.set(Address, {
				titles: [{ ...Presence, player_id: 4, player_name: "赞助者", title: "原头衔", style: "eternity", chat_style: "" }],
				developers: [{ ...Presence, player_id: 3, player_name: "开发者", developer_id: "developer", style_bucket: 2 }]
			});
		}
		return Rooms.get(Address);
	}
	function Snapshot(Type, Address)
	{
		Reads[Type].push(Address);
		return { response: { server_time: Math.floor(Now / 1000), presences: Room(Address)[Type] } };
	}
	const Recognition = new EventEmitter();
	Recognition.Current = () => ({ users: [] });
	Recognition.Report = () => {};
	const Server = http.createServer((_Req, Res) => Res.writeHead(404).end());
	const Connections = new Set();
	Server.on("connection", (Socket) => {
		Connections.add(Socket);
		Socket.once("close", () => Connections.delete(Socket));
	});
	const Hub = CreateRealtimeServer(Server, {
		Recognition,
		DeveloperService: {
			ReportPresence: (Auth, Body) => { Reports.developers.push({ Auth, Body }); return { statusCode: 200 }; },
			GetPresences: (Address) => Snapshot("developers", Address)
		},
		TitleService: {
			Report: (Auth, Body) => { Reports.titles.push({ Auth, Body }); return { statusCode: 200 }; },
			Profile: () => ({ statusCode: 200, response: { title: "原头衔", bound_name: "" } }),
			List: (Address) => Snapshot("titles", Address)
		},
		NewsService: { Current: () => ({ response: { version: 0, markdown: "" } }) },
		SponsorsService: { Current: () => ({ response: { version: 0, markdown: "" } }) },
		Playtime: (Action) => ({ statusCode: 200, response: { action: Action } }),
		NowSec: () => Math.floor(Now / 1000)
	});
	const Clients = [];
	T.after(async () => {
		// 关闭回调也会清理定时器，必须在恢复模拟时钟前等待双方连接完全结束。
		const Closing = [...Connections, ...Clients.map((Client) => Client.Socket).filter((Socket) => Socket.readyState !== WebSocket.CLOSED)]
			.map((Socket) => once(Socket, "close", { signal: AbortSignal.timeout(2000) }));
		for(const Client of Clients) Client.Socket.terminate();
		Hub.Close();
		if(Server.listening)
		{
			const Closed = once(Server, "close", { signal: AbortSignal.timeout(2000) });
			Server.close();
			await Closed;
		}
		await Promise.all(Closing);
	});
	const Listening = once(Server, "listening", { signal: AbortSignal.timeout(2000) });
	Server.listen(0, "127.0.0.1");
	await Listening;
	async function Connect(Address = "one:8303")
	{
		const Id = Clients.length + 10;
		const Socket = new WebSocket(`ws://127.0.0.1:${Server.address().port}/ws`, "qmclient-json");
		const Client = { Socket, Messages: [], Hello: {
			type: "hello", v: 2, machine_hash: "a".repeat(64), client_id: "qm-observer-" + Id,
			player_name: "观察者" + Id, server_address: Address, session_id: "session-" + Id,
			title_token: "b".repeat(64), developer_token: "c".repeat(64),
			players: [{ player_id: Id, player_name: "观察者" + Id, dummy: false }]
		} };
		Clients.push(Client);
		Socket.on("message", (Raw) => Client.Messages.push(JSON.parse(Raw)));
		await once(Socket, "open", { signal: AbortSignal.timeout(2000) });
		const Ready = MessageWhen(Socket, (Message) => Message.type === "time");
		Socket.send(JSON.stringify(Client.Hello));
		await Ready;
		return Client;
	}
	return {
		Connect, Hub, Room, Reads, Reports, Recognition,
		Advance(Milliseconds) { Now += Milliseconds; T.mock.timers.tick(Milliseconds); },
		async Flush(Client) { this.Advance(50); await Barrier(Client); },
		async Presence(Client, Changes = {}) {
			Client.Socket.send(JSON.stringify({ ...Client.Hello, type: "presence", ...Changes }));
			await Barrier(Client);
		}
	};
}

test("首次快照后不重复发送同一批合并通知", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	assert.equal(ScopedMessages(Client, "titles").length, 1);
	assert.equal(ScopedMessages(Client, "developers").length, 1);
});

test("同服多人的重复续报保留认证上报但不触发重复名单广播", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Clients = [await F.Connect(), await F.Connect(), await F.Connect()];
	await F.Flush(Clients[0]);
	for(const Client of Clients) { await Barrier(Client); Client.Messages.length = 0; }
	const BeforeTitles = F.Reports.titles.length;
	const BeforeDevelopers = F.Reports.developers.length;
	for(const Client of Clients)
	{
		await F.Presence(Client);
		await F.Flush(Clients[0]);
	}
	for(const Client of Clients)
	{
		await Barrier(Client);
		assert.deepEqual(ScopedMessages(Client), []);
	}
	assert.equal(F.Reports.titles.length - BeforeTitles, Clients.length);
	assert.equal(F.Reports.developers.length - BeforeDevelopers, Clients.length);
});

test("仅租约时间变化由五秒周期推送新有效期且同服名单只构建一次", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Clients = [await F.Connect(), await F.Connect()];
	await F.Flush(Clients[0]);
	for(const Client of Clients) { await Barrier(Client); Client.Messages.length = 0; }
	F.Advance(3950);
	for(const Type of ["titles", "developers"])
		Object.assign(F.Room()[Type][0], { issued_at: 104, expires_at: 119 });
	await F.Presence(Clients[0]);
	await F.Flush(Clients[0]);
	assert.deepEqual(ScopedMessages(Clients[0]), []);
	F.Reads.titles.length = F.Reads.developers.length = 0;
	F.Advance(950);
	for(const Client of Clients)
	{
		await Barrier(Client);
		for(const Type of ["titles", "developers"])
		{
			const Messages = ScopedMessages(Client, Type);
			assert.equal(Messages.length, 1);
			assert.equal(Messages[0].data.server_time, 105);
			assert.equal(Messages[0].data.presences[0].expires_at, 119);
		}
	}
	assert.deepEqual(F.Reads.titles, ["one:8303"]);
	assert.deepEqual(F.Reads.developers, ["one:8303"]);
});

test("周期推送按房间共享快照且不会混入其他房间的头衔", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	F.Room("one:8303").titles[0].title = "一号房间";
	F.Room("two:8303").titles[0].title = "二号房间";
	const Clients = [await F.Connect(), await F.Connect(), await F.Connect("two:8303")];
	await F.Flush(Clients[0]);
	for(const Client of Clients) { await Barrier(Client); Client.Messages.length = 0; }
	F.Reads.titles.length = F.Reads.developers.length = 0;
	F.Advance(4950);
	for(const Client of Clients)
	{
		await Barrier(Client);
		const Messages = ScopedMessages(Client, "titles");
		assert.equal(Messages.length, 1);
		assert.equal(Messages[0].data.server_address, Client.Hello.server_address);
		assert.equal(Messages[0].data.presences[0].title, Client.Hello.server_address === "one:8303" ? "一号房间" : "二号房间");
	}
	assert.deepEqual(F.Reads.titles, ["one:8303", "two:8303"]);
	assert.deepEqual(F.Reads.developers, ["one:8303", "two:8303"]);
});

for(const [Type, Field, Value] of [
	["titles", "title", "新头衔"],
	["titles", "chat_style", "platinum"],
	["titles", "player_name", "修改后的昵称"],
	["developers", "style_bucket", 6]
])
	test(`${Type} 的 ${Field} 改变后及时推送并合并重复通知`, { timeout: 10000 }, async (T) => {
		const F = await Fixture(T);
		const Client = await F.Connect();
		await F.Flush(Client);
		Client.Messages.length = 0;
		F.Room()[Type][0][Field] = Value;
		F.Hub.NotifyPresences("one:8303");
		F.Hub.NotifyTitles();
		F.Hub.NotifyPresences("one:8303");
		await F.Flush(Client);
		const Messages = ScopedMessages(Client, Type);
		assert.equal(Messages.length, 1);
		assert.equal(Messages[0].data.presences[0][Field], Value);
		assert.equal(ScopedMessages(Client).length, 1);
	});

test("新连接拿到当前名单后其他同服连接仍收到变化", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Observer = await F.Connect();
	await F.Flush(Observer);
	Observer.Messages.length = 0;
	F.Room().titles.push({ ...F.Room().titles[0], player_id: 5, player_name: "新赞助者" });
	const NewClient = await F.Connect();
	await F.Flush(Observer);
	await Barrier(NewClient);
	assert.equal(ScopedMessages(Observer, "titles").length, 1);
	assert.equal(ScopedMessages(Observer, "titles")[0].data.presences.length, 2);
	assert.equal(ScopedMessages(NewClient, "titles").length, 1);
});

test("服务名单移除过期玩家后推送空名单且周期不会恢复旧记录", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	F.Room().titles = [];
	F.Room().developers = [];
	F.Hub.NotifyPresences("one:8303");
	await F.Flush(Client);
	for(const Type of ["titles", "developers"])
		assert.deepEqual(ScopedMessages(Client, Type)[0].data.presences, []);
	Client.Messages.length = 0;
	F.Advance(4900);
	await Barrier(Client);
	for(const Type of ["titles", "developers"])
		assert.deepEqual(ScopedMessages(Client, Type)[0].data.presences, []);
});

test("慢连接恢复后只发送最新名单而不排队旧版本", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	let Blocked = true;
	T.mock.getter(WebSocket.prototype, "bufferedAmount", () => Blocked ? 1 : 0);
	for(const Title of ["中间头衔", "最新头衔"])
	{
		F.Room().titles[0].title = Title;
		F.Hub.NotifyTitles();
		await F.Flush(Client);
	}
	assert.deepEqual(ScopedMessages(Client), []);
	Blocked = false;
	F.Hub.NotifyPresences("one:8303");
	await F.Flush(Client);
	const Messages = ScopedMessages(Client, "titles");
	assert.equal(Messages.length, 1);
	assert.equal(Messages[0].data.presences[0].title, "最新头衔");
});

test("慢连接错过周期续租后可由下一次通知补发新鲜租约", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	let Blocked = true;
	T.mock.getter(WebSocket.prototype, "bufferedAmount", () => Blocked ? 1 : 0);
	for(const Type of ["titles", "developers"])
		Object.assign(F.Room()[Type][0], { issued_at: 104, expires_at: 119 });
	F.Advance(4950);
	await Barrier(Client);
	assert.deepEqual(ScopedMessages(Client), []);
	Blocked = false;
	for(const Type of ["titles", "developers"])
		Object.assign(F.Room()[Type][0], { issued_at: 105, expires_at: 120 });
	F.Hub.NotifyPresences("one:8303");
	await F.Flush(Client);
	for(const Type of ["titles", "developers"])
	{
		const Messages = ScopedMessages(Client, Type);
		assert.equal(Messages.length, 1);
		assert.equal(Messages[0].data.presences[0].expires_at, 120);
	}
});

test("慢连接换服后恢复时不会发送旧房间的待发名单", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	let Blocked = true;
	T.mock.getter(WebSocket.prototype, "bufferedAmount", () => Blocked ? 1 : 0);
	F.Room().titles[0].title = "旧房间待发";
	F.Hub.NotifyTitles();
	await F.Flush(Client);
	await F.Presence(Client, { server_address: "two:8303" });
	await F.Flush(Client);
	F.Room("two:8303").titles[0].title = "新房间最新";
	Blocked = false;
	F.Hub.NotifyPresences("two:8303");
	await F.Flush(Client);
	for(const Message of ScopedMessages(Client))
		assert.equal(Message.data.server_address, "two:8303");
	assert.equal(ScopedMessages(Client, "titles")[0].data.presences[0].title, "新房间最新");
});

test("回到原房间后即使名单内容没变也重新获取快照", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	await F.Presence(Client, { server_address: "", players: [] });
	await F.Flush(Client);
	Client.Messages.length = 0;
	await F.Presence(Client);
	await F.Flush(Client);
	assert.equal(ScopedMessages(Client, "titles").length, 1);
	assert.equal(ScopedMessages(Client, "developers").length, 1);
});

test("重新连接后不沿用旧连接的去重状态", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Socket.terminate();
	const Reconnected = await F.Connect();
	await F.Flush(Reconnected);
	assert.equal(ScopedMessages(Reconnected, "titles").length, 1);
	assert.equal(ScopedMessages(Reconnected, "developers").length, 1);
});

test("显式刷新头衔即使内容没变也返回当前快照", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	Client.Socket.send(JSON.stringify({ type: "subscribe_titles" }));
	await Barrier(Client);
	assert.equal(ScopedMessages(Client, "titles").length, 1);
	assert.equal(ScopedMessages(Client, "developers").length, 1);
});

test("周期推送先发送短租约名单再发送待发全局在线快照", { timeout: 10000 }, async (T) => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Flush(Client);
	Client.Messages.length = 0;
	F.Recognition.emit("users", { users: [{ server_address: "one:8303", player_name: "在线玩家", dummy: false }] });
	F.Advance(4950);
	await Barrier(Client);
	const Types = Client.Messages.map((Message) => Message.type).filter((Type) => ["developers", "titles", "users"].includes(Type));
	assert.deepEqual(Types, ["developers", "titles", "users"]);
});
