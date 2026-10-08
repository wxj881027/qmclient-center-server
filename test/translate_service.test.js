"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CreateTranslateService, ProvidersFromEnvironment } = require("../translate_service");
const Providers = [{ name: "deepl", credentials: [{ key: "fixture:fx" }] }, { name: "mymemory" }];
const Input = { text: "我来帮你", source: "auto", target: "ja" };
const MyMemory = { Status: 200, Body: { responseStatus: 200, responseData: { translatedText: "手伝います" } } };

test("主服务限额耗尽只回退一次，自动来源使用汉字规则", async () => {
	const Calls = [];
	const Service = CreateTranslateService({ Providers, Request: async (Url, Options) => {
		Calls.push({ Url, Options });
		return Calls.length === 1 ? { Status: 456 } : MyMemory;
	} });
	assert.equal((await Service.Translate(Input)).text, "手伝います");
	assert.equal(Calls.length, 2);
	assert.equal(Calls[0].Options.headers.Authorization, "DeepL-Auth-Key fixture:fx");
	assert.equal(new URL(Calls[1].Url).searchParams.get("langpair"), "zh-CN|ja");
	assert.equal(JSON.parse(Calls[0].Options.body).source_lang, undefined);
	await Service.Translate(Input);
	assert.equal(Calls.length, 3);
	assert.match(Calls[2].Url, /mymemory/);
});

test("明确内容拒绝丢弃服务正文并停止回退", async () => {
	let Calls = 0;
	const Service = CreateTranslateService({ Providers, Request: async () => { ++Calls; return { Status: 403, Body: { code: "content_policy_violation", message: "private explanation" } }; } });
	assert.deepEqual(await Service.Translate(Input), { ok: false, error: "content_refused" });
	assert.equal(Calls, 1);
});

test("取消主请求后不启动后备服务", async () => {
	const Controller = new AbortController();
	let Calls = 0;
	const Service = CreateTranslateService({ Providers, Request: async () => { ++Calls; Controller.abort(); throw new Error("aborted"); } });
	assert.deepEqual(await Service.Translate(Input, { Signal: Controller.signal }), { ok: false, error: "cancelled" });
	assert.equal(Calls, 1);
});

test("服务和凭据的并发预算阻止重复请求，释放后恢复", async () => {
	let Resolve;
	const Service = CreateTranslateService({ Providers: [Providers[0]], Request: () => new Promise((Done) => { Resolve = Done; }) });
	const First = Service.Translate(Input);
	assert.deepEqual(await Service.Translate(Input), { ok: false, error: "service_unavailable" });
	Resolve({ Status: 200, Body: { translations: [{ text: "手伝います", detected_source_language: "ZH" }] } });
	assert.equal((await First).ok, true);
	const Next = Service.Translate(Input);
	Resolve({ Status: 200, Body: { translations: [{ text: "手伝います" }] } });
	assert.equal((await Next).ok, true);
});

test("服务顺序固定且实际计费字符会更新服务和凭据预算", async () => {
	const Calls = [];
	const Service = CreateTranslateService({ Providers: [{ name: "mymemory" }, { name: "deepl", character_limit: 4, credentials: [{ key: "fixture:fx", character_limit: 4 }] }],
		Request: async (Url) => { Calls.push(Url); return Url.includes("deepl") ? { Status: 200, Body: { translations: [{ text: "translated", billed_characters: 0 }] } } : MyMemory; } });
	assert.equal((await Service.Translate(Input)).ok, true);
	assert.equal((await Service.Translate(Input)).ok, true);
	assert.equal(Calls.length, 2);
	assert.ok(Calls.every((Url) => Url.includes("deepl")));
});

test("异常预算在启动时拒绝，错误信息不包含配置凭据", () => {
	assert.throws(() => CreateTranslateService({ Providers: [{ name: "deepl", concurrency: Infinity, credentials: [{ key: "private-key" }] }] }),
		(Error) => Error.message === "Invalid translation budget: concurrency");
});

test("无效环境 JSON 的启动错误不回显维护者配置", () => {
	assert.throws(() => ProvidersFromEnvironment({ TRANSLATE_PROVIDERS_JSON: '{"key":"private-key"' }),
		(Error) => Error.message === "Invalid TRANSLATE_PROVIDERS_JSON" && !Error.message.includes("private-key"));
});

test("维护者字符额度跨请求生效，窗口到期后恢复", async () => {
	let Time = 1000;
	let Calls = 0;
	const Service = CreateTranslateService({ Providers: [{ name: "mymemory", character_limit: 4, quota_window_ms: 1000 }], Now: () => Time,
		Request: async () => { ++Calls; return MyMemory; } });
	assert.equal((await Service.Translate(Input)).ok, true);
	assert.equal((await Service.Translate(Input)).ok, false);
	assert.equal(Calls, 1);
	Time += 1000;
	assert.equal((await Service.Translate(Input)).ok, true);
});

test("服务错误正文不返回客户端，重复服务配置也只请求一次", async () => {
	let Calls = 0;
	const Service = CreateTranslateService({ Providers: [Providers[0], Providers[0]], Request: async () => { ++Calls; return { Status: 500, Body: { message: "private error" } }; } });
	assert.deepEqual(await Service.Translate(Input), { ok: false, error: "service_unavailable" });
	assert.equal(Calls, 1);
});

test("MyMemory 的已知配额警告不会作为译文返回", async () => {
	const Service = CreateTranslateService({ Providers: [{ name: "mymemory" }], Request: async () => ({ Status: 200, Body: {
		responseStatus: 200, responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY" }
	} }) });
	assert.deepEqual(await Service.Translate(Input), { ok: false, error: "quota_exceeded" });
});
