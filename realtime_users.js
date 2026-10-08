"use strict";

const { deflateSync } = require("node:zlib");

const USERS_SYNC_CAPABILITY = "users-sync-zlib-v1";
const USERS_LEASE_SECONDS = 20;
const MAX_SYNC_BYTES = 2 * 1024 * 1024;
const DEFAULT_USERS_BYTES_PER_SECOND = 384 * 1024;

// 预算只约束大名单；短租约头衔和心跳由调用方直接发送。
class UsersSendBudget
{
	constructor(BytesPerSecond = DEFAULT_USERS_BYTES_PER_SECOND, Now = Date.now())
	{
		this.Rate = BytesPerSecond;
		this.Capacity = Math.max(1024, BytesPerSecond / 20);
		this.Tokens = this.Capacity;
		this.LastTime = Now;
	}
	Consume(Bytes, Now)
	{
		const Elapsed = Math.max(0, Now - this.LastTime);
		this.LastTime = Math.max(this.LastTime, Now);
		this.Tokens = Math.min(this.Capacity, this.Tokens + Elapsed * this.Rate / 1000);
		// 单帧大于突发预算时允许借用一次，随后偿还，不能让大帧永远无法发送。
		if(this.Tokens < Math.min(Bytes, this.Capacity)) return false;
		this.Tokens -= Bytes;
		return true;
	}
}

function LegacyUsersFrame(Data, Address)
{
	const Users = Data.users.map(User => {
		const Result = { server_address: User.server_address, player_name: User.player_name };
		// 旧客户端缺省 dummy 为 false；上报身份和时间字段不参与名单消费。
		if(User.dummy !== undefined && User.dummy !== false) Result.dummy = User.dummy;
		if(User.server_address === Address)
		{
			Result.client_type = User.client_type ?? User.type;
			if(User.qid) Result.qid = User.qid;
			// 旧客户端缺省支持语音，只有显式关闭时需要携带此字段。
			if(User.voice_supported !== undefined && User.voice_supported !== true) Result.voice_supported = User.voice_supported;
		}
		return Result;
	});
	return JSON.stringify({ type: "users", v: 2, data: { users: Users, server_address: Address, lease_seconds: USERS_LEASE_SECONDS } });
}

function UsersSnapshot(Data, Address)
{
	const Servers = new Map();
	const Players = new Map();
	for(const User of Data.users)
	{
		if(typeof User.server_address !== "string" || typeof User.player_name !== "string" || !User.player_name) continue;
		let Count = Servers.get(User.server_address);
		if(!Count) { Count = [User.server_address, 0, 0]; Servers.set(User.server_address, Count); }
		++Count[User.dummy ? 2 : 1];
		if(!Address || User.server_address !== Address) continue;
		const Id = JSON.stringify([User.client_id || "", User.player_id ?? -1, User.dummy === true]);
		const Type = String(User.client_type || User.type || "qm").toLowerCase();
		Players.set(Id, [Id, User.player_name, Type === "arg" || Type === "arghena" ? "arg" : "qm",
			typeof User.qid === "string" ? User.qid : "", User.voice_supported !== false]);
	}
	return { Address, Servers, Players };
}

function Difference(Current, Previous)
{
	const Changed = [];
	const Removed = [];
	for(const [Key, Value] of Current)
		if(!Previous.has(Key) || JSON.stringify(Previous.get(Key)) !== JSON.stringify(Value)) Changed.push(Value);
	for(const Key of Previous.keys())
		if(!Current.has(Key)) Removed.push(Key);
	return { Changed, Removed };
}

function EncodeUsersFrame(Data)
{
	const Json = Buffer.from(JSON.stringify({ type: "users_sync", v: 2, data: Data }));
	if(Json.length > MAX_SYNC_BYTES) throw new Error("users_sync_too_large");
	const Header = Buffer.alloc(8);
	Header.write("QMU1", 0, "ascii");
	Header.writeUInt32BE(Json.length, 4);
	return Buffer.concat([Header, deflateSync(Json, { level: 1 })]);
}

function PrepareUsersSync(Data, Address, Previous, ForceFull = false)
{
	const Snapshot = UsersSnapshot(Data, Address);
	const Full = ForceFull || !Previous || Previous.Snapshot.Address !== Address;
	const Servers = Difference(Snapshot.Servers, Full ? new Map() : Previous.Snapshot.Servers);
	const Players = Difference(Snapshot.Players, Full ? new Map() : Previous.Snapshot.Players);
	const Changed = Full || Servers.Changed.length || Servers.Removed.length || Players.Changed.length || Players.Removed.length;
	const Base = Previous?.Revision || 0;
	const Revision = Base + (Changed ? 1 : 0);
	const Payload = {
		server_address: Address, base_revision: Full ? 0 : Base, revision: Revision, full: Full,
		servers: Servers.Changed, players: Players.Changed,
		removed_servers: Servers.Removed, removed_players: Players.Removed,
		lease_seconds: USERS_LEASE_SECONDS
	};
	return { Frame: EncodeUsersFrame(Payload), State: { Snapshot, Revision }, Payload };
}

module.exports = { USERS_SYNC_CAPABILITY, USERS_LEASE_SECONDS, MAX_SYNC_BYTES,
	UsersSendBudget, LegacyUsersFrame, UsersSnapshot, PrepareUsersSync, EncodeUsersFrame };
