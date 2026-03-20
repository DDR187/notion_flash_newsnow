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

{ name: "华尔街见闻", url: "https://wallstreetcn.com/live" }

];

function makeDedupeKey(source, link) {

return `${source}|${link}`;

}

async function fetchHtml(url) {

const res = await fetch(url, {

headers: {

"user-agent":

"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",

"accept-language": "zh-CN,zh;q=0.9,en;q=0.8"

}

});

if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);

return await res.text();

}

/

- 解析策略（基础版）：
- 
    - 先把页面纯文本里“最靠前的一条快讯”用简单规则截出来
- 
    - 标题：取第一行或带【】的行
- 
    - 摘要：取后续一小段
- 
    - 时间：如果抓不到就用当前时间（仍然可用，只是发布时间不够精确）
- 
    - 图片：如果页面里能找到 img src 就取第一个
- 
- 后续如果你希望更准确（每家站都精确到那条快讯的时间和链接），我们再把每个站的解析单独写死规则。

*/

function parseFirstImageUrl($) {

const img = $("img").first();

const src = img.attr("src") || img.attr("data-src");

if (!src) return null;

if (src.startsWith("//")) return "https:" + src;

return src;

}

function nowIso() {

return new Date().toISOString();

}

function toNotionDate(iso) {

// Notion API expects ISO8601

return iso;

}

function pickTextSnippet(text, maxLen = 180) {

const t = text.replace(/s+/g, " ").trim();

return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;

}

async function extractLatest(sourceName, url) {

const html = await fetchHtml(url);

const $ = cheerio.load(html);

const imgUrl = parseFirstImageUrl($);

// 粗略文本（用于兜底）

const pageText = $("body").text() || "";

const cleaned = pageText.replace(/r/g, "").replace(/[ t]+/g, " ").trim();

// 尝试抓时间（很粗的匹配）

// 支持：2026-03-20 12:11、03-20 12:21:07、2026年03月20日 11:44:04 等

let timeMatch =

cleaned.match(/b20d{2}[-/]d{2}[-/]d{2}s+d{2}:d{2}(:d{2})?b/) ||

cleaned.match(/bd{2}-d{2}s+d{2}:d{2}(:d{2})?b/) ||

cleaned.match(/b20d{2}年d{2}月d{2}日s+d{2}:d{2}:d{2}b/);

// 这里如果是 “03-20 12:21:07”，我们补上年份（用当前年份）

let publishedIso = null;

if (timeMatch) {

const s = timeMatch[0];

const year = new Date().getFullYear();

if (/^d{2}-d{2}s+/.test(s)) {

const [md, hm] = s.split(/s+/);

publishedIso = new Date(`${year}-${md}T${hm}+08:00`).toISOString();

} else if (/^d{4}-d{2}-d{2}s+/.test(s)) {

publishedIso = new Date(s.replace(" ", "T") + "+08:00").toISOString();

} else if (/^d{4}年/.test(s)) {

// 2026年03月20日 11:44:04

const m = s.match(/(d{4})年(d{2})月(d{2})日s+(d{2}:d{2}:d{2})/);

if (m) publishedIso = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}+08:00`).toISOString();

}

}

if (!publishedIso) publishedIso = nowIso();

// 标题/摘要兜底：取前几句

const lines = cleaned.split("n").map(s => s.trim()).filter(Boolean);

const title = (lines.find(l => l.length >= 6 && l.length <= 80) || `${sourceName} 最新快讯`).slice(0, 80);

const summary = pickTextSnippet(cleaned, 200);

// 原文链接：基础版先用入口页链接（后续可升级成具体快讯的详情链接）

const link = url;

return {

source: sourceName,

title,

summary,

link,

imageUrl: imgUrl,

publishedIso

};

}

async function notionHasDedupeKey(dedupeKey) {

const resp = await notion.databases.query({

database_id: databaseId,

filter: {

property: "去重键",

rich_text: { equals: dedupeKey }

},

page_size: 1

});

return resp.results.length > 0;

}

async function createNotionRow(item) {

const dedupeKey = makeDedupeKey(item.source, [item.link](http://item.link));

const contentLines = [

item.summary,

"",

item.imageUrl ? `图片：${item.imageUrl}` : "",

`原文：${item.link}`

].filter(Boolean);

await notion.pages.create({

parent: { database_id: databaseId },

properties: {

标题: { title: [{ text: { content: item.title } }] },

来源: { select: { name: item.source } },

原文链接: { url: [item.link](http://item.link) },

内容摘要: { rich_text: [{ text: { content: item.summary } }] },

图片链接: { url: item.imageUrl || null },

去重键: { rich_text: [{ text: { content: dedupeKey } }] },

发布时间: { date: { start: toNotionDate(item.publishedIso) } }

},

children: [contentLines.map](http://contentLines.map)(t => ({

object: "block",

type: "paragraph",

paragraph: { rich_text: [{ type: "text", text: { content: t } }] }

}))

});

}

async function main() {

console.log("Run at", new Date().toISOString());

for (const s of SOURCES) {

try {

const item = await extractLatest([s.name](http://s.name), s.url);

const dedupeKey = makeDedupeKey(item.source, [item.link](http://item.link));

const exists = await notionHasDedupeKey(dedupeKey);

if (exists) {

console.log(`[SKIP] ${item.source} exists: ${dedupeKey}`);

continue;

}

await createNotionRow(item);

console.log(`[ADD] ${item.source}: ${item.title}`);

} catch (e) {

console.error(`[ERR] ${s.name}`, e.message);

}

}

}

main();
