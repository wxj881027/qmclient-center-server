"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TTL = 15;
const Hash = (Value) => crypto.createHash("sha256").update(Value).digest("hex");
const Result = (statusCode, response) => ({ statusCode, response });
const Fail = (Code, Error) => Result(Code, { ok: false, error: Error });
const IsToken = (Value) => typeof Value === "string" && /^[a-f0-9]{64}$/.test(Value);
const IsText = (Value, Limit) => typeof Value === "string" && Value.length > 0 && Buffer.byteLength(Value, "utf8") <= Limit && !/[\p{C}\p{Zl}\p{Zp}]/u.test(Value);

function ValidateTitle(Value)
{
	if(!IsText(Value, 48) || Value !== Value.trim() || /[\[\]]/.test(Value))
		return false;
	return Array.from(Value).reduce((Count, Char) => Count + (Char.codePointAt(0) < 128 ? 1 : 2), 0) <= 12;
}

// 可用的头衔动态风格 id。必须与客户端 src/game/client/components/qmclient/qm_title_style.cpp
// 的风格表保持一致：客户端遇到未知 id 会回退到默认表现，所以这里多出或缺少不会崩，
// 但会让被抽到的风格在客户端不生效。
const STYLE_IDS = [
	"turquoise", "pure_green", "cosmic_purple", "burnished_auric", "hot_pink", "calamity_red",
	"exotic_rainbow", "exotic_rainbow_expert", "dark_orange", "angelic_alliance", "contagion",
	"crystyl_crusher", "demonshade", "draconic_destruction", "earth", "endogenesis", "eternity",
	"flamsteed_ring", "illustrious_knives", "profaned_soul_crystal", "red_sun", "scarlet_devil",
	"shattered_community", "ozzathoth", "soma_prime", "staff_of_blushie", "svantechnical",
	"sylvestaff", "temporal_umbrella", "triactis_hammer", "donator_item",
];

const IsStyle = (Value) => typeof Value === "string" && (Value === "" || STYLE_IDS.includes(Value));

// 昵称绑定以「会话」为单位判定：一条上报里的本体或分身任一只叫这个名字，整条会话
// （本体 + 分身）都放行。否则分身换了昵称时会连同本体一起被过滤掉，表现为只有本体有头衔。
const IsBoundSession = (Players, BoundName) => !BoundName || Players.some((Player) => Player.player_name === BoundName);

// 与 developer_auth.js 的 DeterministicStyleBucket 同构：由身份、服务器与会话确定性派生。
// 这样同一局内结果固定、换服务器或开新会话才变化，且中心服重启不会让已分配的样式突变
// （会话表是进程内存，纯随机会在重启后重抽）。
function DeterministicStyleId(TokenHash, ServerAddress, SessionId)
{
	const RejectionLimit = Math.floor(0xFFFFFFFF / STYLE_IDS.length) * STYLE_IDS.length;
	for(let Counter = 0;; ++Counter)
	{
		const Digest = crypto.createHash("sha256")
			.update(TokenHash, "utf8")
			.update("\0", "utf8")
			.update(ServerAddress, "utf8")
			.update("\0", "utf8")
			.update(SessionId, "utf8")
			.update("\0", "utf8")
			.update(String(Counter), "utf8")
			.digest();
		for(let Offset = 0; Offset < Digest.length; Offset += 4)
		{
			const Value = Digest.readUInt32BE(Offset);
			if(Value < RejectionLimit)
				return STYLE_IDS[Value % STYLE_IDS.length];
		}
	}
}

function IssueTitleCode(Directory, Label)
{
	fs.mkdirSync(path.join(Directory, "codes"), { recursive: true, mode: 0o700 });
	const Code = crypto.randomBytes(24).toString("hex");
	fs.writeFileSync(path.join(Directory, "codes", Hash(Code) + ".json"), JSON.stringify({ label: Label }), { flag: "wx", mode: 0o600 });
	return Code;
}

function CreateTitleService({ Directory, NowSec = () => Math.floor(Date.now() / 1000) })
{
	fs.mkdirSync(Directory, { recursive: true, mode: 0o700 });
	const File = path.join(Directory, "titles.json");
	let Data = fs.existsSync(File) ? JSON.parse(fs.readFileSync(File, "utf8")) : { users: {}, redeemed: {} };
	if(!Data.users || !Data.redeemed)
		throw new Error("invalid title database");
	const Sessions = new Map();
	function Save(Next)
	{
		// 先落盘再发布内存状态，失败时不会消耗认证码。
		const Temporary = File + ".tmp";
		const Fd = fs.openSync(Temporary, "w", 0o600);
		try
		{
			fs.writeFileSync(Fd, JSON.stringify(Next));
			fs.fsyncSync(Fd);
		}
		finally
		{
			fs.closeSync(Fd);
		}
		fs.renameSync(Temporary, File);
		Data = Next;
	}
	function Authenticate(Auth)
	{
		const Match = typeof Auth === "string" && /^Bearer ([a-f0-9]{64})$/.exec(Auth);
		const Key = Match && Hash(Match[1]);
		return Key && Data.users[Key] && !Data.users[Key].revoked ? Key : null;
	}
	function ProfileFor(Key)
	{
		const User = Data.users[Key];
		// style 为空表示未自选，由服务端在每局开始时随机分配。
		return Result(200, { ok: true, title: User.title, style: User.style || "", bound_name: User.bound_name });
	}
	function Cleanup()
	{
		for(const [Key, Session] of Sessions)
			if(Session.expires_at <= NowSec())
				Sessions.delete(Key);
	}
	return {
		Redeem(Body)
		{
			if(!Body || typeof Body.code !== "string" || !/^[a-f0-9]{48}$/.test(Body.code) || !IsToken(Body.token))
				return Fail(400, "invalid_code");
			const CodeHash = Hash(Body.code);
			const TokenHash = Hash(Body.token);
			if(Data.redeemed[CodeHash])
				return Data.redeemed[CodeHash] === TokenHash && !Data.users[TokenHash].revoked ? ProfileFor(TokenHash) : Fail(409, "code_used");
			const CodeFile = path.join(Directory, "codes", CodeHash + ".json");
			if(!fs.existsSync(CodeFile))
				return Fail(400, "invalid_code");
			if(Data.users[TokenHash])
				return Fail(409, "already_registered");
			const Code = JSON.parse(fs.readFileSync(CodeFile, "utf8"));
			const Next = JSON.parse(JSON.stringify(Data));
			Next.users[TokenHash] = { label: Code.label, title: "赞助者", style: "", bound_name: "", revoked: false };
			Next.redeemed[CodeHash] = TokenHash;
			Save(Next);
			return ProfileFor(TokenHash);
		},
		Profile(Auth)
		{
			const Key = Authenticate(Auth);
			return Key ? ProfileFor(Key) : Fail(401, "invalid_credential");
		},
		Update(Auth, Body)
		{
			const Key = Authenticate(Auth);
			if(!Key)
				return Fail(401, "invalid_credential");
			if(!Body || !ValidateTitle(Body.title))
				return Fail(400, "invalid_title");
			if(Body.bound_name !== "" && !IsText(Body.bound_name, 63))
				return Fail(400, "invalid_name");
			// 老客户端不带 style，此时保留已有值而不是清空。
			if(Body.style !== undefined && !IsStyle(Body.style))
				return Fail(400, "invalid_style");
			const Next = JSON.parse(JSON.stringify(Data));
			Next.users[Key].title = Body.title;
			Next.users[Key].bound_name = Body.bound_name;
			Next.users[Key].style = Body.style !== undefined ? Body.style : (Data.users[Key].style || "");
			Save(Next);
			return ProfileFor(Key);
		},
		Report(Auth, Body, Ip)
		{
			const Key = Authenticate(Auth);
			if(!Key)
				return Fail(401, "invalid_credential");
			if(!Body || !IsText(Body.server_address, 128) || !IsText(Body.session_id, 128) ||
				!Array.isArray(Body.players) || Body.players.length > 2 || Body.players.length === 0 || typeof Ip !== "string" || !Ip)
				return Fail(400, "invalid_presence");
			const Ids = new Set();
			for(const Player of Body.players)
			{
				if(!Player || !Number.isInteger(Player.player_id) || Player.player_id < 0 || Player.player_id >= 128 ||
					!IsText(Player.player_name, 63) || typeof Player.dummy !== "boolean" || Ids.has(Player.player_id))
					return Fail(400, "invalid_presence");
				Ids.add(Player.player_id);
			}
			Cleanup();
			const ActiveIps = new Set(Array.from(Sessions.values()).filter((Session) => Session.key === Key).map((Session) => Session.ip));
			if(!ActiveIps.has(Ip) && ActiveIps.size >= 4)
				return Fail(409, "ip_limit");
			const Now = NowSec();
			const Players = Body.players.map((Player) => ({ player_id: Player.player_id, player_name: Player.player_name, dummy: Player.dummy }));
			// 风格分配：自选优先；未自选时由身份、服务器与会话确定性派生，
			// 因此同一局内所有人看到的同一玩家效果一致，换服或开新会话才变化。
			let Style = Data.users[Key].style || "";
			if(!Style)
				Style = DeterministicStyleId(Key, Body.server_address, Body.session_id);
			Sessions.set(Key + ":" + Body.session_id, { key: Key, ip: Ip, server_address: Body.server_address, players: Players, style: Style, issued_at: Now, expires_at: Now + TTL });
			return Result(200, { ok: true, accepted: IsBoundSession(Players, Data.users[Key].bound_name) ? Players.length : 0 });
		},
		List(Server)
		{
			if(!IsText(Server, 128))
				return Fail(400, "invalid_server_address");
			Cleanup();
			const Presences = new Map();
			for(const Session of Sessions.values())
			{
				const User = Data.users[Session.key];
				if(User.revoked || Session.server_address !== Server)
					continue;
				if(!IsBoundSession(Session.players, User.bound_name))
					continue;
				for(const Player of Session.players)
				{
					Presences.set(Player.player_id + ":" + Player.player_name, { ...Player, title: User.title, style: Session.style || "", server_address: Server, issued_at: Session.issued_at, expires_at: Session.expires_at });
				}
			}
			return Result(200, { server_time: NowSec(), presences: Array.from(Presences.values()) });
		}
	};
}

function RegisterTitleRoutes(App, Service, { CheckRateLimit, ClientIp, OnChanged })
{
	for(const [Method, Route, Handle] of [
		["post", "redeem", (Req) => Service.Redeem(Req.body)],
		["get", "profile", (Req) => Service.Profile(Req.get("authorization"))],
		["post", "profile", (Req) => Service.Update(Req.get("authorization"), Req.body)],
		["post", "presence", (Req) => Service.Report(Req.get("authorization"), Req.body, ClientIp(Req))],
		["get", "presences", (Req) => Service.List(Req.query.server_address)]
	])
	{
		App[Method]("/api/v1/titles/" + Route, (Req, Res) => {
			Res.set("Cache-Control", "no-store");
			if(!CheckRateLimit(ClientIp(Req)))
				return Res.status(429).json({ ok: false, error: "rate_limited" });
			try
			{
				const Reply = Handle(Req);
				Res.status(Reply.statusCode).json(Reply.response);
				if(Method === "post" && Reply.statusCode === 200 && OnChanged) OnChanged();
			}
			catch
			{
				Res.status(503).json({ ok: false, error: "storage_unavailable" });
			}
		});
	}
}

module.exports = { CreateTitleService, IssueTitleCode, RegisterTitleRoutes, ValidateTitle };
