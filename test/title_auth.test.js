"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CreateTitleService, IssueTitleCode, ValidateTitle } = require("../title_auth");

function Fixture(t)
{
	const Directory = fs.mkdtempSync(path.join(os.tmpdir(), "qm-title-"));
	t.after(() => fs.rmSync(Directory, { recursive: true, force: true }));
	let Now = 1000;
	const Options = { Directory, NowSec: () => Now };
	const Service = CreateTitleService(Options);
	const Code = IssueTitleCode(Directory, "赞助者测试");
	const Token = "a".repeat(64);
	const Auth = `Bearer ${Token}`;
	const Body = { code: Code, token: Token };
	const Presence = { server_address: "test:8303", session_id: "one", players: [{ player_id: 3, player_name: "Twen", dummy: false }] };
	return { Directory, Options, Service, Code, Token, Auth, Body, Presence, Advance: () => { Now += 16; } };
}

test("领取一次并持久化；丢失响应可由同一凭证重试，其他凭证不能重领", (t) => {
	const f = Fixture(t);
	assert.equal(f.Service.Redeem(f.Body).statusCode, 200);
	const Restarted = CreateTitleService(f.Options);
	assert.equal(Restarted.Redeem(f.Body).statusCode, 200);
	assert.equal(Restarted.Redeem({ ...f.Body, token: "b".repeat(64) }).statusCode, 409);
	assert.equal(Restarted.Profile(f.Auth).statusCode, 200);
	assert.equal(Restarted.Profile("Bearer wrong").statusCode, 401);
	assert.ok(!fs.readFileSync(path.join(f.Directory, "titles.json"), "utf8").includes(f.Token));
});

test("昵称绑定依赖凭证且区分大小写，可以解除绑定，自定义文字立即生效", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	assert.equal(f.Service.Update(f.Auth, { title: "六个中文头衔", bound_name: "twen" }).statusCode, 200);
	// 绑定名与唯一一只昵称大小写不符：整条会话都不放行
	assert.equal(f.Service.Report(f.Auth, f.Presence, "1.1.1.1").response.accepted, 0);
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "" }).statusCode, 200);
	f.Service.Report(f.Auth, f.Presence, "1.1.1.1");
	assert.equal(f.Service.List("test:8303").response.presences[0].title, "小猫");
	f.Service.Update(f.Auth, { title: "新头衔", bound_name: "" });
	assert.equal(f.Service.List("test:8303").response.presences[0].title, "新头衔");
	f.Service.Update(f.Auth, { title: "新头衔", bound_name: "other" });
	assert.equal(f.Service.List("test:8303").response.presences.length, 0);
});

test("最多四个活跃IP，同IP多个会话不多占名额，过期释放", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	for(let i = 1; i <= 4; i++)
		assert.equal(f.Service.Report(f.Auth, { ...f.Presence, session_id: String(i) }, `1.1.1.${i}`).statusCode, 200);
	assert.equal(f.Service.Report(f.Auth, { ...f.Presence, session_id: "same-ip" }, "1.1.1.1").statusCode, 200);
	assert.equal(f.Service.Report(f.Auth, { ...f.Presence, session_id: "5" }, "1.1.1.5").statusCode, 409);
	assert.equal(f.Service.Report(f.Auth, { ...f.Presence, session_id: "1" }, "1.1.1.5").statusCode, 409);
	f.Advance();
	assert.equal(f.Service.Report(f.Auth, f.Presence, "1.1.1.5").statusCode, 200);
});

test("昵称绑定按主角色放行整条会话，分身昵称不同也一起显示头衔", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	f.Service.Update(f.Auth, { title: "赞助者", bound_name: "Q1menG" });
	assert.equal(f.Service.Report(f.Auth, {
		...f.Presence,
		players: [
			{ player_id: 3, player_name: "Q1menG", dummy: false },
			{ player_id: 9, player_name: "Q1menG'", dummy: true },
		],
	}, "1.1.1.1").response.accepted, 2);
	assert.deepEqual(f.Service.List("test:8303").response.presences.map((Presence) => [Presence.player_id, Presence.player_name, Presence.title]), [
		[3, "Q1menG", "赞助者"],
		[9, "Q1menG'", "赞助者"],
	]);

	// 绑定名与两只都不符时，整条会话都不放行
	f.Service.Update(f.Auth, { title: "赞助者", bound_name: "other" });
	assert.equal(f.Service.List("test:8303").response.presences.length, 0);
});

test("客户端提供的IP无效，旧会话玩家列表被替换，公开数据不泄露凭证或IP", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	f.Service.Report(f.Auth, { ...f.Presence, ip: "forged" }, "1.1.1.1");
	f.Service.Report(f.Auth, { ...f.Presence, players: [{ player_id: 4, player_name: "new", dummy: true }] }, "1.1.1.1");
	const Result = f.Service.List("test:8303").response;
	assert.equal(Result.presences.length, 1);
	assert.equal(Result.presences[0].player_id, 4);
	assert.ok(!JSON.stringify(Result).includes("1.1.1.1"));
	assert.ok(!JSON.stringify(Result).includes(f.Token));
});

test("文字额度为12，ASCII占1，其余字符占2，拒绝控制字符与伪造括号", () => {
	for(const Title of ["赞助者", "一二三四五六", "abcdefghijkl", "一二三abcdef"])
		assert.equal(ValidateTitle(Title), true);
	for(const Title of ["", "一二三四五六七", "abcdefghijklm", "a\nb", "[开发者]", "a\u202eb", "a\u200bb", "a\u0000b"])
		assert.equal(ValidateTitle(Title), false);
});

test("风格分配：未自选时同会话固定、换服或新会话变化，自选优先", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	assert.equal(f.Service.Profile(f.Auth).response.style, "");

	f.Service.Report(f.Auth, f.Presence, "1.1.1.1");
	const Style = f.Service.List("test:8303").response.presences[0].style;
	assert.ok(typeof Style === "string" && Style.length > 0);

	// 同一会话重复上报必须得到同一风格（确定性派生，中心服重启也不变）
	f.Service.Report(f.Auth, f.Presence, "1.1.1.1");
	assert.equal(f.Service.List("test:8303").response.presences[0].style, Style);

	// 换服务器重新派生
	f.Service.Report(f.Auth, { ...f.Presence, server_address: "test:8304" }, "1.1.1.1");
	assert.ok(f.Service.List("test:8304").response.presences[0].style.length > 0);

	// 自选优先于派生
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "", style: "eternity" }).statusCode, 200);
	f.Service.Report(f.Auth, f.Presence, "1.1.1.1");
	assert.equal(f.Service.List("test:8303").response.presences[0].style, "eternity");
});

test("风格校验：非法 id 被拒绝，老客户端缺省该字段时保留原值", (t) => {
	const f = Fixture(t);
	f.Service.Redeem(f.Body);
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "", style: "not_a_style" }).statusCode, 400);
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "", style: "eternity" }).statusCode, 200);
	assert.equal(f.Service.Profile(f.Auth).response.style, "eternity");

	// 不带 style 的请求（老客户端）不能清空已选风格
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "" }).statusCode, 200);
	assert.equal(f.Service.Profile(f.Auth).response.style, "eternity");

	// 显式传空串则清空，回到每局派生
	assert.equal(f.Service.Update(f.Auth, { title: "小猫", bound_name: "", style: "" }).statusCode, 200);
	assert.equal(f.Service.Profile(f.Auth).response.style, "");
});
