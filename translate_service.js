"use strict";

const { FetchJson } = require("./outbound_json");
const LANGUAGES = new Set(["zh", "zh-TW", "en", "ja", "ko", "ru", "de", "fr", "es", "pt"]);
const Failure = (Error) => ({ ok: false, error: Error });

function CreateTranslateService({ Providers = [], Request = FetchJson, Now = Date.now } = {})
{
	function Budget(Config)
	{
		const NumberOption = (Name, Default, Minimum) => {
			const Value = Config[Name] === undefined ? Default : Number(Config[Name]);
			if(!Number.isSafeInteger(Value) || Value < Minimum) throw new Error(`Invalid translation budget: ${Name}`);
			return Value;
		};
		return { Active: 0, Used: 0, ResetAt: 0, CooldownUntil: 0, Disabled: false,
			Concurrency: NumberOption("concurrency", 1, 1),
			Limit: NumberOption("character_limit", 0, 0),
			WindowMs: NumberOption("quota_window_ms", 86400000, 1000),
			CooldownMs: NumberOption("cooldown_ms", 60000, 1000) };
	}
	if(!Array.isArray(Providers) || Providers.some((Provider) => !Provider || typeof Provider !== "object" ||
		(Provider.credentials !== undefined && (!Array.isArray(Provider.credentials) || Provider.credentials.some((Credential) => !Credential || typeof Credential !== "object")))))
		throw new Error("Invalid translation provider configuration");
	// 固定两个服务的顺序；重复定义不能创建绕过同一服务预算的新实例。
	const Services = ["deepl", "mymemory"].map((Name) => Providers.find((Provider) => Provider.name === Name)).filter(Boolean).map((Provider) => ({
		...Provider, Budget: Budget(Provider), Credentials: (Provider.credentials || (Provider.name === "mymemory" ? [{}] : [])).map((Credential) => ({ ...Credential, Budget: Budget({ ...Provider, ...Credential }) }))
	}));
	function Available(State, Cost)
	{
		const Time = Now();
		if(Time >= State.ResetAt) { State.Used = 0; State.ResetAt = Time + State.WindowMs; }
		return !State.Disabled && Time >= State.CooldownUntil && State.Active < State.Concurrency && (!State.Limit || State.Used + Cost <= State.Limit);
	}
	async function Call(Service, Credential, Input, Signal)
	{
		if(Service.name === "deepl")
		{
			const Body = { text: [Input.text], target_lang: Input.target === "zh-TW" ? "ZH-HANT" : Input.target === "en" ? "EN-US" : Input.target === "pt" ? "PT-PT" : Input.target.toUpperCase(), show_billed_characters: true };
			if(Input.source !== "auto") Body.source_lang = Input.source.split("-")[0].toUpperCase();
			const Host = Credential.key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
			const Result = await Request(Host + "/v2/translate", { method: "POST", signal: Signal,
				headers: { Authorization: "DeepL-Auth-Key " + Credential.key, "Content-Type": "application/json" }, body: JSON.stringify(Body) });
			if(Result.Body?.refusal || ["content_policy_violation", "content_filter"].includes(Result.Body?.code)) return Failure("content_refused");
			if(Result.Status === 401 || Result.Status === 403) return Failure("authentication");
			if(Result.Status === 429) return Failure("rate_limit");
			if(Result.Status === 456) return Failure("quota_exceeded");
			const Translation = Result.Body?.translations?.[0];
			if(Result.Status !== 200 || typeof Translation?.text !== "string" || !Translation.text.trim()) return Failure("service_unavailable");
			return { ok: true, text: Translation.text, language: String(Translation.detected_source_language || Input.source).toLowerCase(),
				BilledCharacters: Number.isSafeInteger(Translation.billed_characters) && Translation.billed_characters >= 0 ? Translation.billed_characters : Array.from(Input.text).length };
		}
		const Url = new URL("https://api.mymemory.translated.net/get");
		Url.searchParams.set("q", Input.text);
		// MyMemory 不支持自动检测，沿用客户端按文字系统选择来源的规则。
		const Source = Input.source !== "auto" ? Input.source : /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(Input.text) ? "ja" :
			/\p{Script=Hangul}/u.test(Input.text) ? "ko" : /\p{Script=Cyrillic}/u.test(Input.text) ? "ru" : /\p{Script=Han}/u.test(Input.text) ? "zh" : "en";
		const Encode = (Code) => Code === "zh" ? "zh-CN" : Code;
		Url.searchParams.set("langpair", `${Encode(Source)}|${Encode(Input.target)}`);
		if(Credential.key) Url.searchParams.set("key", Credential.key);
		if(Credential.email) Url.searchParams.set("de", Credential.email);
		const Result = await Request(Url.toString(), { signal: Signal });
		const Body = Result.Body;
		if(Body?.refusal || Body?.error === "content_refused") return Failure("content_refused");
		if(Result.Status === 429 || Body?.responseStatus === 429) return Failure("rate_limit");
		if(Body?.quotaFinished === true) return Failure("quota_exceeded");
		const Text = Body?.responseData?.translatedText;
		if(typeof Text === "string" && /^MYMEMORY WARNING/i.test(Text)) return Failure(/USED ALL AVAILABLE/i.test(Text) ? "quota_exceeded" : "service_unavailable");
		if(typeof Text === "string" && /^You are about to translate the /i.test(Text) && /on how to translate it/i.test(Text) && /kturtle\/translator\.php/i.test(Text) && !/You are about to translate|kturtle\/translator\.php/i.test(Input.text)) return Failure("service_notice");
		if(Result.Status === 401 || Result.Status === 403) return Failure("authentication");
		if(Result.Status !== 200 || Number(Body?.responseStatus) !== 200 || typeof Body?.responseData?.translatedText !== "string" || !Body.responseData.translatedText.trim()) return Failure("service_unavailable");
		return { ok: true, text: Body.responseData.translatedText, language: Source };
	}
	return {
		async Translate(Input, { Signal } = {})
		{
			if(!Input || typeof Input.text !== "string" || !Input.text.trim() || Buffer.byteLength(Input.text) > 4096 ||
				!LANGUAGES.has(Input.target) || (Input.source !== "auto" && !LANGUAGES.has(Input.source))) return Failure("invalid_request");
			const Cost = Array.from(Input.text).length;
			const Deadline = Now() + 10000;
			let Attempts = 0;
			let Last = Failure("service_unavailable");
			const Tried = new Set();
			for(const Service of Services)
			{
				if(Signal?.aborted) return Failure("cancelled");
				if(Attempts >= 2 || Now() >= Deadline) break;
				if(Tried.has(Service.name) || !Available(Service.Budget, Cost)) continue;
				if(Service.name === "mymemory" && Buffer.byteLength(Input.text) > 500) continue;
				const Credential = Service.Credentials.find((Entry) => (Service.name !== "deepl" || (typeof Entry.key === "string" && Entry.key)) && Available(Entry.Budget, Cost));
				if(!Credential) continue;
				Tried.add(Service.name);
				++Attempts;
				const Controller = new AbortController();
				const Abort = () => Controller.abort();
				Signal?.addEventListener("abort", Abort, { once: true });
				const Timeout = setTimeout(Abort, Math.min(5000, Math.max(1, Deadline - Now())));
				const Budgets = [Service.Budget, Credential.Budget];
				const Windows = Budgets.map((State) => State.ResetAt);
				// 先预留额度，防止并发请求越过维护者设置的额度上限。
				for(const State of Budgets) { ++State.Active; State.Used += Cost; }
				try { Last = await Call(Service, Credential, Input, Controller.signal); }
				catch { Last = Failure("network_error"); }
				finally
				{
					clearTimeout(Timeout);
					Signal?.removeEventListener("abort", Abort);
					for(const State of Budgets) --State.Active;
				}
				if(Last.ok && Number.isSafeInteger(Last.BilledCharacters))
					Budgets.forEach((State, Index) => { if(State.ResetAt === Windows[Index]) State.Used = Math.max(0, State.Used + Last.BilledCharacters - Cost); });
				if(Signal?.aborted) return Failure("cancelled");
				if(Last.ok) return { ok: true, text: Last.text, language: Last.language };
				if(Last.error === "content_refused") return Last;
				if(Last.error === "authentication") Credential.Budget.Disabled = true;
				else if(Last.error === "quota_exceeded") Credential.Budget.CooldownUntil = Credential.Budget.ResetAt;
				else for(const State of Budgets) State.CooldownUntil = Now() + State.CooldownMs;
			}
			return Last;
		}
	};
}

function RegisterTranslateRoutes(App, Service, CheckRateLimit = () => true)
{
	App.post("/api/v1/translate", async (Req, Res) => {
		Res.set("Cache-Control", "no-store");
		if(!CheckRateLimit(Req)) return Res.status(429).json(Failure("rate_limit"));
		const Controller = new AbortController();
		const Abort = () => { if(!Res.writableEnded) Controller.abort(); };
		Res.on("close", Abort);
		try
		{
			const Result = await Service.Translate(Req.body, { Signal: Controller.signal });
			if(!Controller.signal.aborted) Res.status(Result.ok ? 200 : Result.error === "invalid_request" ? 400 : 503).json(Result);
		}
		catch { if(!Controller.signal.aborted) Res.status(503).json(Failure("service_unavailable")); }
		finally { Res.removeListener("close", Abort); }
	});
}

function ProvidersFromEnvironment(Env)
{
	if(Env.TRANSLATE_PROVIDERS_JSON)
	{
		let Providers;
		// JSON 原始异常可能包含配置片段，启动错误不能输出维护者凭据。
		try { Providers = JSON.parse(Env.TRANSLATE_PROVIDERS_JSON); }
		catch { throw new Error("Invalid TRANSLATE_PROVIDERS_JSON"); }
		if(!Array.isArray(Providers)) throw new Error("TRANSLATE_PROVIDERS_JSON must be an array");
		return Providers;
	}
	return [
		{ name: "deepl", credentials: Env.DEEPL_API_KEY ? [{ key: Env.DEEPL_API_KEY }] : [] },
		{ name: "mymemory", credentials: [{ email: Env.MYMEMORY_EMAIL || "" }] }
	];
}

module.exports = { CreateTranslateService, RegisterTranslateRoutes, ProvidersFromEnvironment };
