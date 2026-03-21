import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!process.env.NOTION_TOKEN || !databaseId) {
	console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
	process.exit(1);
}

const SOURCES = [
	{ name: "金十数据", url: "https://flash.jin10.com" },
	{ name: "格隆汇", url: "https://m.gelonghui.com/live" },
	{ name: "36氪", url: "https://www.36kr.com/newsflashes" },
	{ name: "财联社", url: "https://m.cls.cn/telegraph" },
	{ name: "华尔街见闻", url: "https://wallstreetcn.com/live" },
];

function makeDedupeKey(item) {
	// 精确到分钟，避免入口页链接相同导致永远不新增
	const minute = item.publishedIso.slice(0, 16); // YYYY-MM-DDTHH:MM
	return `${item.source}|${minute}|${item.summary}`;
}

async function fetchHtml(url) {
	const res = await fetch(url, {
		headers: {
			"user-agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		},
	});
	if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
	return await res.text();
}

function normalizeUrl(href, base) {
	if (!href) return null;
	if (href.startsWith("http")) return href;
	if (href.startsWith("//")) return "https:" + href;
	if (href.startsWith("/")) return base.replace(/\/$/, "") + href;
	return base.replace(/\/$/, "") + "/" + href;
}

function pickTextSnippet(text, maxLen = 200) {
	const t = String(text || "").replace(/\s+/g, " ").trim();
	return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

function isNoise(s) {
	const t = String(s || "").trim();
	if (!t) return true;

	// 常见脚本/埋点/配置
	if (/^(\/\/|window\.|function\s|gtag\(|dataLayer\b|_hmt\b)/i.test(t)) return true;

	// 36氪页面入口常见误抓
	if (t === "快讯" || t === "账号设置" || t.length < 4) return true;

	// 导航/频道堆叠
	if (t.length > 300 && /(登录|搜索|账号设置|城市合作|企业服务|关于36氪)/.test(t)) return true;

	return false;
}

function parseIsoInChina(t) {
	// 输入："2026-03-20 11:40:12" 或 "03-20 12:21:07" 或 "12:11"
	// 输出：ISO string（尽量精确到分钟/秒）；取不到则用当前时间
	const now = new Date();
	const year = now.getFullYear();

	if (!t) return now.toISOString();

	const s = String(t).trim();

	// 2026-03-20 11:40:12
	if (/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
		return new Date(s.replace(" ", "T") + "+08:00").toISOString();
	}

	// 03-20 12:21:07
	if (/^\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
		const [md, hm] = s.split(/\s+/);
		return new Date(`${year}-${md}T${hm}+08:00`).toISOString();
	}

	// 12:11（默认当天）
	if (/^\d{2}:\d{2}/.test(s)) {
		const yyyy = String(year);
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		const hhmm = s.slice(0, 5);
		return new Date(`${yyyy}-${mm}-${dd}T${hhmm}:00+08:00`).toISOString();
	}

	return now.toISOString();
}

function finalizeItem(source, raw) {
	const base = pickTextSnippet(raw, 200);
	const summary = `${base}（${source}）`;
	return summary;
}

async function extractLatest(sourceName, url) {
	if (sourceName === "华尔街见闻") return extractWallstreetcn(url);
	if (sourceName === "财联社") return extractCls(url);
	if (sourceName === "36氪") return extract36kr(url);
	if (sourceName === "金十数据") return extractJin10(url);
	if (sourceName === "格隆汇") return extractGelonhui(url);
	throw new Error("Unknown source: " + sourceName);
}

async function extractWallstreetcn(url) {
	const html = await fetchHtml(url);
	const $ = cheerio.load(html);

	// 第一条 juicy 编辑链接里的 ID
	const m = html.match(/livenews\/edit\/(\d{6,})/);
	const id = m ? m[1] : null;
	const link = id ? `https://wallstreetcn.com/livenews/${id}` : url;

	let text = "";
	if (id) {
		const a = $(`a[href*="livenews/edit/${id}"]`).first();
		const container = a.closest("li, div");
		text = container.text() || a.parent().text() || "";
	}
	if (!text) {
		// 兜底：找第一个【】标题附近文本
		const a0 = $("a[href*='livenews/edit']").first();
		text = a0.closest("li, div").text() || $("body").text() || "";
	}

	const cleaned = pickTextSnippet(text, 260);

	// 时间：页面里一般有类似 "03:57"，取最先出现的 HH:MM
	const timeMatch = html.match(/\b\d{2}:\d{2}\b/);
	const publishedIso = parseIsoInChina(timeMatch ? timeMatch[0] : null);

	// 摘要：优先取【】后的内容；没有就用 cleaned
	let raw = cleaned;
	const titleMatch = cleaned.match(/【([^】]{4,60})】/);
	if (titleMatch) {
		raw = cleaned.replace(/^[\s\S]*?】\s*/, "").trim();
		if (!raw) raw = titleMatch[1];
	}

	const summary = finalizeItem("华尔街见闻", raw);

	return {
		source: "华尔街见闻",
		title: summary,
		summary,
		link,
		imageUrl: null,
		publishedIso,
	};
}

async function extractCls(url) {
	const html = await fetchHtml(url);
	const $ = cheerio.load(html);

	const text = $("body").text() || "";
	const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

	// 找第一条形如 12:11【...】
	const first = lines.find((l) => /^\d{2}:\d{2}【/.test(l)) || "";
	const time = (first.match(/^(\d{2}:\d{2})/) || [])[1] || null;

	let raw = first;
	if (!raw) raw = lines[0] || "";

	// 去掉开头时间与【标题】
	raw = raw
		.replace(/^\d{2}:\d{2}/, "")
		.replace(/^【[^】]+】/, "")
		.trim();

	const summary = finalizeItem("财联社", raw || "财联社电报");

	return {
		source: "财联社",
		title: summary,
		summary,
		link: url,
		imageUrl: null,
		publishedIso: parseIsoInChina(time),
	};
}

async function extract36kr(url) {
	const html = await fetchHtml(url);
	const $ = cheerio.load(html);

	// 只接受 /newsflashes/数字ID
	const m = html.match(/href=\"(\/newsflashes\/\d+)\"/);
	const link = m ? `https://www.36kr.com${m[1]}` : url;

	let raw = "";
	if (m) {
		const a = $(`a[href*="${m[1]}"]`).first();
		const container = a.closest("div");
		raw = container.text() || a.parent().text() || "";
	}
	if (!raw) raw = $("body").text() || "";

	// 尽量去掉大量导航，取前 200 字
	const summary = finalizeItem("36氪", raw);

	return {
		source: "36氪",
		title: summary,
		summary,
		link,
		imageUrl: null,
		publishedIso: new Date().toISOString(),
	};
}

async function extractJin10(url) {
	const html = await fetchHtml(url);
	const $ = cheerio.load(html);

	const text = $("body").text() || "";
	const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

	const firstTimeLine = lines.find((l) => /^\d{2}:\d{2}:\d{2}$/.test(l));
	const idx = firstTimeLine ? lines.indexOf(firstTimeLine) : -1;
	const time = firstTimeLine || null;

	let candidate = "";
	const start = Math.max(idx, 0);
	const end = Math.min(lines.length, (idx >= 0 ? idx + 15 : 15));
	for (let i = start; i < end; i++) {
		const line = lines[i];
		if (isNoise(line)) continue;
		if (!/[\u4e00-\u9fa5]/.test(line)) continue;
		candidate = line;
		break;
	}

	const summary = finalizeItem("金十数据", candidate || "金十快讯");

	const yyyy = String(new Date().getFullYear());
	const mm = String(new Date().getMonth() + 1).padStart(2, "0");
	const dd = String(new Date().getDate()).padStart(2, "0");
	const publishedIso = parseIsoInChina(time ? `${yyyy}-${mm}-${dd} ${time}` : null);

	return {
		source: "金十数据",
		title: summary,
		summary,
		link: url,
		imageUrl: null,
		publishedIso,
	};
}

async function extractGelonhui(url) {
	const html = await fetchHtml(url);
	const $ = cheerio.load(html);

	// 兜底策略：找第一个出现的“格隆汇X月X日｜...”
	const bodyText = $("body").text() || "";
	const m = bodyText.match(/格隆汇\d{1,2}月\d{1,2}日[\s\S]{0,220}/);
	const raw = m ? m[0] : bodyText;

	const summary = finalizeItem("格隆汇", raw);

	return {
		source: "格隆汇",
		title: summary,
		summary,
		link: url,
		imageUrl: null,
		publishedIso: new Date().toISOString(),
	};
}

async function notionHasDedupeKey(dedupeKey) {
	const resp = await notion.databases.query({
		database_id: databaseId,
		filter: {
			property: "去重键",
			rich_text: { equals: dedupeKey },
		},
		page_size: 1,
	});
	return resp.results.length > 0;
}

async function createNotionRow(item) {
	const dedupeKey = makeDedupeKey(item);

	const contentLines = [item.summary, item.imageUrl ? `图片：${item.imageUrl}` : "", `原文：${item.link}`].filter(Boolean);

	await notion.pages.create({
		parent: { database_id: databaseId },
		properties: {
			标题: { title: [{ text: { content: item.summary } }] },
			来源: { select: { name: item.source } },
			原文链接: { url: item.link },
			内容摘要: { rich_text: [{ text: { content: item.summary } }] },
			图片链接: { url: item.imageUrl || null },
			去重键: { rich_text: [{ text: { content: dedupeKey } }] },
			发布时间: { date: { start: item.publishedIso } },
		},
		children: contentLines.map((t) => ({
			object: "block",
			type: "paragraph",
			paragraph: { rich_text: [{ type: "text", text: { content: t } }] },
		})),
	});
}

async function main() {
	console.log("Run at", new Date().toISOString());

	for (const s of SOURCES) {
		try {
			const item = await extractLatest(s.name, s.url);

			// 写入前丢弃噪音
			if (isNoise(item.summary) || isNoise(item.title)) {
				console.log(`[SKIP] noise ${item.source}`);
				continue;
			}

			const dedupeKey = makeDedupeKey(item);

			if (await notionHasDedupeKey(dedupeKey)) {
				console.log(`[SKIP] ${item.source} exists: ${dedupeKey}`);
				continue;
			}

			await createNotionRow(item);
			console.log(`[ADD] ${item.source}: ${item.summary}`);
		} catch (e) {
			console.error(`[ERR] ${s.name}`, e.message);
		}
	}
}

main();
