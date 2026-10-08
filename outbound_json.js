"use strict";

// 完整读取期间也受调用方的超时和取消约束，避免大响应耗尽内存。
async function FetchJson(Url, Options = {}, MaxBytes = 64 * 1024)
{
	const Response = await fetch(Url, { ...Options, redirect: "error" });
	const Chunks = [];
	let Size = 0;
	if(Response.body)
	{
		for await(const Chunk of Response.body)
		{
			Size += Chunk.length;
			if(Size > MaxBytes) throw new Error("response_too_large");
			Chunks.push(Buffer.from(Chunk));
		}
	}
	let Body = null;
	try { Body = JSON.parse(Buffer.concat(Chunks).toString("utf8")); } catch {}
	return { Status: Response.status, Headers: Response.headers, Body };
}

module.exports = { FetchJson };
