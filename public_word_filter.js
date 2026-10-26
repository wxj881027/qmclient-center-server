"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { TextDecoder } = require("node:util");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_WORDS = 100000;
const CHECK_INTERVAL_MS = 5000;
const RESPONSE_HEADER = "# QmClient public word filter v1\n";
const MAX_SOURCE_BYTES = MAX_BYTES - Buffer.byteLength(RESPONSE_HEADER);

async function ReadBoundedFile(FilePath)
{
	const File = await fs.open(FilePath, "r");
	try
	{
		if((await File.stat()).size > MAX_SOURCE_BYTES)
			throw new Error("word_list_too_large");
		const Bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
		let Length = 0;
		while(Length < Bytes.length)
		{
			const Read = await File.read(Bytes, Length, Bytes.length - Length, null);
			if(Read.bytesRead === 0)
				break;
			Length += Read.bytesRead;
		}
		if(Length > MAX_SOURCE_BYTES)
			throw new Error("word_list_too_large");
		return Bytes.subarray(0, Length);
	}
	finally
	{
		await File.close();
	}
}

function ValidateWordList(Bytes)
{
	if(Bytes.length > MAX_SOURCE_BYTES)
		throw new Error("word_list_too_large");
	const Text = new TextDecoder("utf-8", { fatal: true }).decode(Bytes);
	if(Text.includes("\0"))
		throw new Error("word_contains_nul");
	const Words = new Set();
	for(const RawLine of Text.split("\n"))
	{
		const Line = RawLine.replace(/^[ \t\r]+|[ \t\r]+$/g, "");
		if(Line === "" || Line.startsWith("#"))
			continue;
		let Word = Line;
		if(Line.startsWith('"'))
		{
			Word = "";
			let Position = 1;
			for(; Position < Line.length && Line[Position] !== '"'; Position++)
			{
				if(Line[Position] === "\\" && (Line[Position + 1] === "\\" || Line[Position + 1] === '"'))
					Position++;
				Word += Line[Position];
			}
			const Tail = Line.slice(Position + 1).replace(/^[ \t\r]+|[ \t\r]+$/g, "");
			if(Position === Line.length || (Tail !== "" && Tail !== ","))
				throw new Error("invalid_quoted_word");
		}
		if(/[\x00-\x1f\x7f]/.test(Word))
			throw new Error("word_contains_control_character");
		if(Word !== "")
			Words.add(Word);
		if(Words.size > MAX_WORDS)
			throw new Error("too_many_words");
	}
	// 保留经过验证的正文，客户端使用同样的按行格式，不接受远端正则表达式。
	const Content = RESPONSE_HEADER + Text;
	return Object.freeze({
		Content,
		Count: Words.size,
		ETag: '"' + crypto.createHash("sha256").update(Content).digest("hex") + '"'
	});
}

function CreatePublicWordFilterService(Options)
{
	const ReadFile = Options.ReadFile || ReadBoundedFile;
	const Now = Options.Now || Date.now;
	const OnError = Options.OnError || (() => console.warn("[public-word-filter] Cannot refresh word list; keeping the last valid snapshot"));
	let Snapshot = null;
	let Pending = null;
	let NextCheck = 0;
	let LastError = null;

	async function GetSnapshot()
	{
		if(Pending)
			return Pending;
		if(Now() < NextCheck)
		{
			if(Snapshot)
				return Snapshot;
			throw LastError;
		}
		Pending = Promise.resolve().then(async () => {
			try
			{
				Snapshot = ValidateWordList(await ReadFile(Options.FilePath));
				LastError = null;
			}
			catch
			{
				LastError = new Error("word_list_unavailable");
				OnError();
			}
			finally
			{
				NextCheck = Now() + CHECK_INTERVAL_MS;
				Pending = null;
			}
			if(!Snapshot)
				throw LastError;
			return Snapshot;
		});
		return Pending;
	}
	return { GetSnapshot };
}

function RegisterPublicWordFilterRoutes(App, Service)
{
	const Handle = async (Req, Res) => {
		try
		{
			const Snapshot = await Service.GetSnapshot();
			Res.set("Cache-Control", "public, max-age=300");
			Res.set("ETag", Snapshot.ETag);
			Res.set("X-Content-Type-Options", "nosniff");
			if(Req.headers["if-none-match"] === Snapshot.ETag)
				return Res.status(304).end();
			return Res.status(200).type("text/plain; charset=utf-8").send(Snapshot.Content);
		}
		catch
		{
			return Res.status(503).set("Cache-Control", "no-store").json({ ok: false, error: "word_list_unavailable" });
		}
	};
	// 公开入口只有读取操作；词库文件通过服务器账号维护。
	App.get("/word-filter", Handle);
	App.get("/api/v1/word-filter", Handle);
}

module.exports = { MAX_BYTES, MAX_WORDS, CHECK_INTERVAL_MS, RESPONSE_HEADER, ValidateWordList, CreatePublicWordFilterService, RegisterPublicWordFilterRoutes };
