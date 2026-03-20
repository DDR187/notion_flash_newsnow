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

function parseFirstImageUrl($) {
  const img = $("img").first();
  const src = img.attr("src") || img.attr("data-src");
  if (!src) return null;
  if (src.startsWith("//")) return "https:" + src;
  return src;
}

function pickTextSnippet(text, maxLen = 200) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

async function extractLatest(sourceName, url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const imgUrl = parseFirstImageUrl($);

  const pageText = $("body").text() || "";
  const cleaned = pageText.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();

  const firstLine = cleaned
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)[0];

  const title = (firstLine || `${sourceName} 最新快讯`).slice(0, 80);
  const summary = pickTextSnippet(cleaned, 200);

  // 基础版：先用入口页作为原文链接（跑通后再升级到每条快讯详情链接）
  const link = url;

  return {
    source: sourceName,
    title,
    summary,
    link,
    imageUrl: imgUrl,
    publishedIso: new Date().toISOString()
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
  const dedupeKey = makeDedupeKey(item.source, item.link);

  const contentLines = [
    item.summary,
    item.imageUrl ? `图片：${item.imageUrl}` : "",
    `原文：${item.link}`
  ].filter(Boolean);

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      标题: { title: [{ text: { content: item.title } }] },
      来源: { select: { name: item.source } },
      原文链接: { url: item.link },
      内容摘要: { rich_text: [{ text: { content: item.summary } }] },
      图片链接: { url: item.imageUrl || null },
      去重键: { rich_text: [{ text: { content: dedupeKey } }] },
      发布时间: { date: { start: item.publishedIso } }
    },
    children: contentLines.map(t => ({
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
      const item = await extractLatest(s.name, s.url);
      const dedupeKey = makeDedupeKey(item.source, item.link);

      if (await notionHasDedupeKey(dedupeKey)) {
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
