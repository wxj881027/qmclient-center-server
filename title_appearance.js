"use strict";

function IsTitleAppearance(Value)
{
	return Value !== null && typeof Value === "object" && !Array.isArray(Value) &&
		["moon", "sun"].includes(Value.style) &&
		Number.isInteger(Value.color) && Value.color >= 0 && Value.color <= 0xffffff &&
		Number.isInteger(Value.opacity) && Value.opacity >= 0 && Value.opacity <= 100;
}

function TitleAppearanceForUser(User)
{
	const Value = User.appearance;
	// 老资料按月亮紫色显示，不改写数据库；客户端没有传入时继续保留已保存的外观。
	return IsTitleAppearance(Value) ? { style: Value.style, color: Value.color, opacity: Value.opacity } :
		{ style: "moon", color: 0x9562ba, opacity: 100 };
}

module.exports = { IsTitleAppearance, TitleAppearanceForUser };
