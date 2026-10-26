"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MAX_BYTES,
	MAX_WORDS,
	CHECK_INTERVAL_MS,
	RESPONSE_HEADER,
	ValidateWordList,
	CreatePublicWordFilterService,
	RegisterPublicWordFilterRoutes
} = require("../public_word_filter");

function ServiceOptions(ReadFile, Now = () => 10000)
{
	return { FilePath: "isolated-words.txt", ReadFile, Now, OnError() {} };
}

function Response()
{
	return {
		Headers: {},
		Code: 0,
		Body: null,
		set(Name, Value) { this.Headers[Name] = Value; return this; },
		status(Code) { this.Code = Code; return this; },
		type(Value) { this.ContentType = Value; return this; },
		send(Body) { this.Body = Body; return this; },
		json(Body) { this.Body = Body; return this; },
		end() { return this; }
	};
}

function Routes(Service)
{
	const Registered = new Map();
	RegisterPublicWordFilterRoutes({ get(Path, Handler) { Registered.set(Path, Handler); } }, Service);
	return Registered;
}

test("accepts UTF-8, BOM, quoted commas, backslashes, comments and duplicate words", () => {
	const Snapshot = ValidateWordList(Buffer.from('\ufeff# comment\r\n测试词\r\n"a,b",\n"spam\\d+",\n测试词\n'));
	assert.equal(Snapshot.Count, 3);
	assert.ok(Snapshot.Content.startsWith(RESPONSE_HEADER));
	assert.ok(Snapshot.Content.includes('"spam\\d+"'));
});

test("rejects malformed quotes, invalid UTF-8 and control characters", () => {
	for(const Bytes of [Buffer.from('new\n"unclosed'), Buffer.from([0xff]), Buffer.from("a\tb"), Buffer.from("# hidden\0\n")])
		assert.throws(() => ValidateWordList(Bytes));
});

test("rejects word lists larger than the response or unique-word limits", () => {
	assert.throws(() => ValidateWordList(Buffer.alloc(MAX_BYTES, 97)));
	const Content = Array.from({ length: MAX_WORDS + 1 }, (_, Index) => String(Index)).join("\n");
	assert.throws(() => ValidateWordList(Buffer.from(Content)));
});

test("keeps the last valid snapshot when a later edit is invalid", async () => {
	let Now = 10000;
	let Content = Buffer.from("old");
	const Service = CreatePublicWordFilterService(ServiceOptions(async () => Content, () => Now));
	const Previous = await Service.GetSnapshot();
	Content = Buffer.from('new\n"unclosed');
	Now += CHECK_INTERVAL_MS;
	assert.equal(await Service.GetSnapshot(), Previous);
	Content = Buffer.from("recovered");
	Now += CHECK_INTERVAL_MS;
	const Current = await Service.GetSnapshot();
	assert.equal(Current.Content, RESPONSE_HEADER + "recovered");
	assert.notEqual(Current.ETag, Previous.ETag);
});

test("publishes an intentionally empty file after a nonempty snapshot", async () => {
	let Now = 10000;
	let Content = Buffer.from("old");
	const Service = CreatePublicWordFilterService(ServiceOptions(async () => Content, () => Now));
	await Service.GetSnapshot();
	Content = Buffer.alloc(0);
	Now += CHECK_INTERVAL_MS;
	const Current = await Service.GetSnapshot();
	assert.equal(Current.Count, 0);
	assert.equal(Current.Content, RESPONSE_HEADER);
});

test("coalesces concurrent reads without opening multiple copies of the word file", async () => {
	let Reads = 0;
	let Resolve;
	const Read = new Promise(Result => { Resolve = Result; });
	const Service = CreatePublicWordFilterService(ServiceOptions(() => { Reads++; return Read; }));
	const First = Service.GetSnapshot();
	const Second = Service.GetSnapshot();
	await Promise.resolve();
	assert.equal(Reads, 1);
	Resolve(Buffer.from("shared"));
	const Results = await Promise.all([First, Second]);
	assert.equal(Results[0], Results[1]);
});

test("recovers from a synchronous read failure after the retry interval", async () => {
	let Now = 10000;
	let Failing = true;
	const Service = CreatePublicWordFilterService(ServiceOptions(() => {
		if(Failing) throw new Error("storage unavailable");
		return Buffer.from("recovered");
	}, () => Now));
	await assert.rejects(Service.GetSnapshot());
	Failing = false;
	await assert.rejects(Service.GetSnapshot());
	Now += CHECK_INTERVAL_MS;
	assert.equal((await Service.GetSnapshot()).Count, 1);
});

test("registers read-only routes and returns UTF-8 text with a stable ETag", async () => {
	const Service = CreatePublicWordFilterService(ServiceOptions(async () => Buffer.from("测试词")));
	const Registered = Routes(Service);
	assert.deepEqual([...Registered.keys()], ["/word-filter", "/api/v1/word-filter"]);
	const Res = Response();
	await Registered.get("/api/v1/word-filter")({ headers: {} }, Res);
	assert.equal(Res.Code, 200);
	assert.equal(Res.Body, RESPONSE_HEADER + "测试词");
	assert.equal(Res.ContentType, "text/plain; charset=utf-8");
	assert.equal(Res.Headers["Cache-Control"], "public, max-age=300");
	const Cached = Response();
	await Registered.get("/word-filter")({ headers: { "if-none-match": Res.Headers.ETag } }, Cached);
	assert.equal(Cached.Code, 304);
	assert.equal(Cached.Body, null);
});

test("returns an uncacheable 503 instead of an empty list when the first read fails", async () => {
	const Service = CreatePublicWordFilterService(ServiceOptions(async () => { throw new Error("missing"); }));
	const Res = Response();
	await Routes(Service).get("/word-filter")({ headers: {} }, Res);
	assert.equal(Res.Code, 503);
	assert.equal(Res.Headers["Cache-Control"], "no-store");
	assert.deepEqual(Res.Body, { ok: false, error: "word_list_unavailable" });
});
