import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!process.env.NOTION_TOKEN || !databaseId) {
  console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

const WINDOW_MINUTES = 10;
const SCAN_LIMIT = 20;

const SOURCES = [
  { name: "格隆汇", url: "https://m.gelonghui.com/live" },
  { name: "36氪", url: "https://www.36kr.com/newsflashes" },
  { name: "财联社", url: "https://m.cls.cn/telegraph" },
];

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

function pickTextSnippet(text, maxLen = 200) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

function isNoise(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/^（[^）]+）$/.test(t)) return true;
  if (/^(\/\/|window\.|function\s|gtag\(|dataLayer\b|_hmt\b)/i.test(t)) return true;
  if (t === "快讯" || t === "账号设置" || t.length < 4) return true;
  if (t.length > 300 && /(登录|搜索|账号设置|城市合作|企业服务|关于36氪)/.test(t)) return true;
  return false;
}

function parseIsoInChina(t) {
  const now = new Date();
  const year = now.getFullYear();
  if (!t) return now.toISOString();
  const s = String(t).trim();

  if (/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) return new Date(s.replace(" ", "T") + "+08:00").toISOString();
  if (/^\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    const [md, hm] = s.split(/\s+/);
    return new Date(`${year}-${md}T${hm}+08:00`).toISOString();
  }
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const yyyy = String(year);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hhmmss = s.length === 5 ? `${s}:00` : s;
    return new Date(`${yyyy}-${mm}-${dd}T${hhmmss}+08:00`).toISOString();
  }
  return now.toISOString();
}

function finalizeItem(source, raw) {
  const base = pickTextSnippet(raw, 200);
  if (!base) return "";
  return `${base}（${source}）`;
}

function withinWindow(publishedIso) {
  const t = new Date(publishedIso).getTime();
  const now = Date.now();
  return now - t <= WINDOW_MINUTES * 60 * 1000;
}

function makeDedupeKey(item) {
  // 36氪：link 唯一
  if (item.source === "36氪") return `${item.source}|${item.link}`;

  // 财联社：同一个列表页 link 不唯一，使用 time+title
  if (item.source === "财联社") {
    const t = (item._timeHHMM || "").trim();
    const title = (item._title || item.summary || "").slice(0, 80);
    return `${item.source}|${t}|${title}`;
  }

  // 格隆汇：同一个列表页 link 不唯一，用摘要前 80 字
  if (item.source === "格隆汇") {
    const sig = (item.summary || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${item.source}|${sig}`;
  }

  // 兜底
  return `${item.source}|${item.link || ""}|${(item.summary || "").slice(0, 80)}`;
}

async function notionHasDedupeKey(dedupeKey) {
  const resp = await notion.databases.query({
    database_id: databaseId,
    filter: { property: "去重键", rich_text: { equals: dedupeKey } },
    page_size: 1,
  });
  return resp.results.length > 0;
}

async function createNotionRow(item) {
  const dedupeKey = makeDedupeKey(item);
  const contentLines = [item.summary, item.link ? `原文：${item.link}` : ""].filter(Boolean);

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      标题: { title: [{ text: { content: item.summary } }] },
      来源: { select: { name: item.source } },
      原文链接: { url: item.link || null },
      内容摘要: { rich_text: [{ text: { content: item.summary } }] },
      图片链接: { url: null },
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

async function extractItems(sourceName, url) {
  if (sourceName === "财联社") return extractClsItems(url);
  if (sourceName === "36氪") return extract36krItems(url);
  if (sourceName === "格隆汇") return extractGelonhuiItems(url);
  throw new Error("Unknown source: " + sourceName);
}

async function extractClsItems(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const text = $("body").text() || "";

  const re = /(\b\d{2}:\d{2}\b)【([^】]{2,80})】([\s\S]{0,260}?)(?=\b\d{2}:\d{2}\b【|$)/g;
  const items = [];
  let m;
  while ((m = re.exec(text)) && items.length < SCAN_LIMIT) {
    const time = m[1];
    const title = m[2];
    const body = String(m[3] || "").split("阅")[0].trim();
    const raw = body || title;

    const summary = finalizeItem("财联社", raw);
    if (!summary || isNoise(summary)) continue;

    items.push({
      source: "财联社",
      summary,
      link: url,
      imageUrl: null,
      publishedIso: parseIsoInChina(time),
      _timeHHMM: time,
      _title: title,
    });
  }

  return items;
}

async function extract36krItems(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const hrefs = [];
  const seen = new Set();
  $("a[href^='/newsflashes/']").each((_, el) => {
    const h = $(el).attr("href");
    if (!h) return;
    if (!/^\/newsflashes\/\d+/.test(h)) return;
    if (seen.has(h)) return;
    seen.add(h);
    hrefs.push(h);
  });

  const picked = hrefs.slice(0, SCAN_LIMIT);
  const items = [];

  for (const path of picked) {
    const link = `{{https://www.36kr.com${path}}}`;
    const a = $(`a[href='${path}'],a[href*='${path}']`).first();
    const container = a.closest("div");
    let raw = container.text() || a.parent().text() || "";
    if (!raw) raw = $("body").text() || "";

    raw = raw
      .replace(/\d+\s*分钟前/g, " ")
      .replace(/分享至/g, " ")
      .replace(/打开微信“扫一扫”[\s\S]*?分享按钮/g, " ")
      .replace(/打开微信/g, " ")
      .replace(/扫一扫/g, " ")
      .replace(/点击屏幕右上角分享按钮/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const summary = finalizeItem("36氪", raw);
    if (!summary || isNoise(summary)) continue;

    items.push({
      source: "36氪",
      summary,
      link,
      imageUrl: null,
      publishedIso: new Date().toISOString(),
    });
  }

  return items;
}

async function extractGelonhuiItems(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const bodyText = $("body").text() || "";

  const parts = bodyText.split(/(?=格隆汇\d{1,2}月\d{1,2}日｜)/).filter(Boolean);
  const picked = parts.slice(0, SCAN_LIMIT);
  const items = [];

  for (const p of picked) {
    let raw = p;
    raw = raw.split("阅读")[0].split("下一页")[0].split("查看更多")[0].split("")[0];
    raw = raw.replace(/\s+/g, " ").trim();

    const summary = finalizeItem("格隆汇", raw);
    if (!summary || isNoise(summary)) continue;

    items.push({
      source: "格隆汇",
      summary,
      link: url,
      imageUrl: null,
      publishedIso: new Date().toISOString(),
    });
  }

  return items;
}

async function main() {
  console.log("Run at", new Date().toISOString());

  for (const s of SOURCES) {
    try {
      const items = await extractItems(s.name, s.url);

      // 只有财联社有靠谱时间：用 10 分钟窗口过滤
      const candidates =
        s.name === "财联社" ? items.filter((it) => withinWindow(it.publishedIso)) : items;

      let added = 0;
      for (const item of candidates) {
        const dedupeKey = makeDedupeKey(item);
        if (await notionHasDedupeKey(dedupeKey)) continue;

        await createNotionRow(item);
        added += 1;
        console.log(`[ADD] ${item.source}: ${item.summary}`);
      }

      if (added === 0) console.log(`[SKIP] ${s.name} no new items`);
    } catch (e) {
      console.error(`[ERR] ${s.name}`, e.message);
    }
  }
}

main();
