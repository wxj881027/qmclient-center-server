"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { inflateSync } = require("node:zlib");
const { UsersSendBudget, LegacyUsersFrame, PrepareUsersSync, EncodeUsersFrame, MAX_SYNC_BYTES } = require("../realtime_users");

const User = (Id, Address = "one:8303", Extra = {}) => ({ client_id: "client-" + Id, player_id: Id,
	server_address: Address, player_name: "玩家" + Id, dummy: false, qid: "qid-" + Id, client_type: "qm", voice_supported: true, ...Extra });

function Decode(Frame)
{
	assert.equal(Frame.subarray(0, 4).toString(), "QMU1");
	const Raw = inflateSync(Frame.subarray(8));
	assert.equal(Raw.length, Frame.readUInt32BE(4));
	const Message = JSON.parse(Raw);
	assert.equal(Message.type, "users_sync");
	assert.equal(Message.v, 2);
	return Message.data;
}

test("压缩快照保留本服身份和全服人数但不携带外服昵称与私有字段", () => {
	const Local = User(1, "one:8303", { client_type: "arg", voice_supported: false, last_ip: "192.0.2.1" });
	const Remote = User(2, "two:8303", { player_name: "外服私有昵称", dummy: true, last_ip: "192.0.2.2" });
	const Source = { users: [Local, Remote] };
	const Original = JSON.stringify(Source);
	const Prepared = PrepareUsersSync(Source, "one:8303", null);
	const Body = Decode(Prepared.Frame);
	assert.equal(Body.full, true);
	assert.equal(Body.base_revision, 0);
	assert.equal(Body.revision, 1);
	assert.deepEqual(Body.servers, [["one:8303", 1, 0], ["two:8303", 0, 1]]);
	assert.equal(Body.players.length, 1);
	assert.deepEqual(Body.players[0].slice(1), [Local.player_name, "arg", Local.qid, false]);
	assert.ok(!JSON.stringify(Body).includes(Remote.player_name));
	assert.ok(!JSON.stringify(Body).includes("192.0.2."));
	assert.equal(JSON.stringify(Source), Original);
});

test("菜单态只包含服务器统计且保留主号与分身计数", () => {
	const Body = Decode(PrepareUsersSync({ users: [User(1), User(2, "one:8303", { dummy: true })] }, "", null).Frame);
	assert.deepEqual(Body.players, []);
	assert.deepEqual(Body.servers, [["one:8303", 1, 1]]);
});

test("仅心跳时间改变时发送同版本续租不重发玩家与统计", () => {
	const First = PrepareUsersSync({ users: [User(1, "one:8303", { last_seen: 100 })] }, "one:8303", null);
	const Next = PrepareUsersSync({ users: [User(1, "one:8303", { last_seen: 105 })] }, "one:8303", First.State);
	const Body = Decode(Next.Frame);
	assert.equal(Body.full, false);
	assert.equal(Body.base_revision, 1);
	assert.equal(Body.revision, 1);
	assert.equal(Body.lease_seconds, 20);
	for(const Key of ["players", "servers", "removed_players", "removed_servers"]) assert.deepEqual(Body[Key], []);
});

test("源数组顺序改变不会制造内容变更", () => {
	const Rows = [User(1), User(2), User(3, "two:8303")];
	const First = PrepareUsersSync({ users: Rows }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: Rows.toReversed() }, "one:8303", First.State).Frame);
	assert.equal(Body.revision, First.State.Revision);
	assert.deepEqual(Body.players, []);
	assert.deepEqual(Body.servers, []);
});

test("增量只发送加入玩家及改变的服务器统计", () => {
	const First = PrepareUsersSync({ users: [User(1), User(2, "two:8303")] }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: [User(1), User(2, "two:8303"), User(3)] }, "one:8303", First.State).Frame);
	assert.equal(Body.base_revision, 1);
	assert.equal(Body.revision, 2);
	assert.equal(Body.players.length, 1);
	assert.equal(Body.players[0][1], "玩家3");
	assert.deepEqual(Body.servers, [["one:8303", 2, 0]]);
});

test("最后一个玩家离开时删除该玩家和对应服务器统计", () => {
	const First = PrepareUsersSync({ users: [User(1), User(2, "two:8303")] }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: [User(2, "two:8303")] }, "one:8303", First.State).Frame);
	assert.deepEqual(Body.removed_servers, ["one:8303"]);
	assert.deepEqual(Body.removed_players, [First.Payload.players[0][0]]);
	assert.deepEqual(Body.players, []);
});

test("更名和身份信息变化更新本服玩家但不重复统计", () => {
	const First = PrepareUsersSync({ users: [User(1)] }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: [User(1, "one:8303", { player_name: "新名字", client_type: "arg", qid: "new-qid", voice_supported: false })] }, "one:8303", First.State).Frame);
	assert.deepEqual(Body.servers, []);
	assert.deepEqual(Body.players[0].slice(1), ["新名字", "arg", "new-qid", false]);
});

test("外服更名不改变接收方的统计与版本", () => {
	const First = PrepareUsersSync({ users: [User(1, "two:8303")] }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: [User(1, "two:8303", { player_name: "改名" })] }, "one:8303", First.State).Frame);
	assert.equal(Body.revision, 1);
	assert.deepEqual(Body.servers, []);
});

test("同服同名或相同玩家编号的不同身份保持独立", () => {
	const Body = Decode(PrepareUsersSync({ users: [User(1), User(1, "one:8303", { client_id: "another-client" })] }, "one:8303", null).Frame);
	assert.equal(Body.players.length, 2);
	assert.notEqual(Body.players[0][0], Body.players[1][0]);
	assert.deepEqual(Body.servers, [["one:8303", 2, 0]]);
});

test("换服完整快照只包含新房间玩家", () => {
	const Data = { users: [User(1), User(2, "two:8303")] };
	const First = PrepareUsersSync(Data, "one:8303", null);
	const Body = Decode(PrepareUsersSync(Data, "two:8303", First.State).Frame);
	assert.equal(Body.full, true);
	assert.equal(Body.base_revision, 0);
	assert.equal(Body.server_address, "two:8303");
	assert.equal(Body.players.length, 1);
	assert.equal(Body.players[0][1], "玩家2");
});

test("强制恢复请求在内容未变时仍发送新版本完整快照", () => {
	const Data = { users: [User(1)] };
	const First = PrepareUsersSync(Data, "one:8303", null);
	const Body = Decode(PrepareUsersSync(Data, "one:8303", First.State, true).Frame);
	assert.equal(Body.full, true);
	assert.equal(Body.revision, 2);
	assert.equal(Body.players.length, 1);
});

test("准备尚未发送的增量不修改已发送基线", () => {
	const First = PrepareUsersSync({ users: [User(1)] }, "one:8303", null);
	PrepareUsersSync({ users: [User(1), User(2)] }, "one:8303", First.State);
	const Body = Decode(PrepareUsersSync({ users: [User(1), User(3)] }, "one:8303", First.State).Frame);
	assert.equal(Body.base_revision, 1);
	assert.deepEqual(Body.players.map(Row => Row[1]), ["玩家3"]);
	assert.equal(First.State.Revision, 1);
});

test("空快照明确清除此前的玩家与所有服务器", () => {
	const First = PrepareUsersSync({ users: [User(1)] }, "one:8303", null);
	const Body = Decode(PrepareUsersSync({ users: [] }, "one:8303", First.State).Frame);
	assert.equal(Body.removed_players.length, 1);
	assert.deepEqual(Body.removed_servers, ["one:8303"]);
});

test("编码器拒绝超过解压上限的内容", () => {
	assert.throws(() => EncodeUsersFrame({ extra: "x".repeat(MAX_SYNC_BYTES) }), /too_large/);
});

test("旧格式仅发送消费字段并保留缺省值语义", () => {
	const Data = { users: [User(1, "one:8303", { last_ip: "192.0.2.1", last_seen: 100 }), User(2, "two:8303")] };
	const Before = JSON.stringify(Data);
	const Body = JSON.parse(LegacyUsersFrame(Data, "one:8303"));
	assert.equal(Body.type, "users");
	assert.deepEqual(Body.data.users[0], { server_address: "one:8303", player_name: "玩家1", client_type: "qm", qid: "qid-1" });
	assert.deepEqual(Body.data.users[1], { server_address: "two:8303", player_name: "玩家2" });
	assert.equal(JSON.stringify(Data), Before);
});

test("旧格式显式保留分身和关闭语音的本服身份", () => {
	const Body = JSON.parse(LegacyUsersFrame({ users: [User(1, "one:8303", { dummy: true, client_type: "arg", voice_supported: false })] }, "one:8303"));
	assert.deepEqual(Body.data.users[0], { server_address: "one:8303", player_name: "玩家1", dummy: true, client_type: "arg", qid: "qid-1", voice_supported: false });
});

test("发送预算限制同一时刻的突发并随时间恢复", () => {
	const Budget = new UsersSendBudget(20000, 1000);
	assert.equal(Budget.Consume(700, 1000), true);
	assert.equal(Budget.Consume(700, 1000), false);
	assert.equal(Budget.Consume(700, 1020), true);
});

test("大于单次突发额度的帧能够发送且后续偿还预算", () => {
	const Budget = new UsersSendBudget(20000, 1000);
	assert.equal(Budget.Consume(3000, 1000), true);
	assert.equal(Budget.Consume(500, 1050), false);
	assert.equal(Budget.Consume(500, 1125), true);
});

test("时钟回退不会重复补充发送额度", () => {
	const Budget = new UsersSendBudget(20000, 1000);
	assert.equal(Budget.Consume(1000, 1000), true);
	assert.equal(Budget.Consume(500, 900), false);
	assert.equal(Budget.Consume(500, 1000), false);
	assert.equal(Budget.Consume(500, 1025), true);
});
