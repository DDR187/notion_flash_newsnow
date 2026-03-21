import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!process.env.NOTION_TOKEN || !databaseId) {
  console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

// 三个来源：格隆汇 / 36氪 / 财联社
const SOURCES = [
  { name: "格隆汇", url: "https://m.gelonghui.com/live" },
  { name: "36氪", url: "https://www.36kr.com/newsflashes" },
  { name: "财联社", url: "https://m.cls.cn/telegraph" },
];

function makeDedupeKey(item) {
  const minute = item.publishedIso.slice(0, 16);
  return `${item.source}|${minute}|${item.summary}`;
}

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

async function extractLatest(sourceName, url) {
  if (sourceName === "财联社") return extractCls(url);
  if (sourceName === "36氪") return extract36kr(url);
  if (sourceName === "格隆汇") return extractGelonhui(url);
  throw new Error("Unknown source: " + sourceName);
}

async function extractCls(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const text = $("body").text() || "";
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

  // 方案1：标准电报行
  let first = lines.find((l) => /^\d{2}:\d{2}【.+?】/.test(l)) || "";

  // 方案2：从整页抓 HH:MM【】附近
  if (!first) {
    const m = text.match(/\b\d{2}:\d{2}【[^】]+】[\s\S]{0,320}/);
    first = m ? m[0] : "";
  }

  // 方案3：页面结构变化时，抓第一个 HH:MM 后面一段中文
  if (!first) {
    const m2 = text.match(/\b\d{2}:\d{2}\b[\s\S]{0,260}/);
    first = m2 ? m2[0] : "";
  }

  const time = (first.match(/\b(\d{2}:\d{2})\b/) || [])[1] || null;

  let raw = first || "";
  raw = raw.split("阅")[0];
  raw = raw.replace(/^\d{2}:\d{2}/, "").replace(/^【[^】]+】/, "").trim();
  raw = raw.replace(/\s+/g, " ").trim();

  // 仍然没正文：写入失败原因（避免 silent skip）
  if (!raw || isNoise(raw) || !/[\u4e00-\u9fa5]/.test(raw)) {
    raw = "财联社正文抓取失败：页面结构可能变更或返回空壳。";
  }

  const summary = finalizeItem("财联社", raw);
  return { source: "财联社", title: summary, summary, link: url, imageUrl: null, publishedIso: parseIsoInChina(time) };
}

async function extract36kr(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const m = html.match(/href=\"(\/newsflashes\/\d+)\"/);
  const path = m ? m[1] : null;
  const link = path ? `https://www.36kr.com${path}` : url;

  let raw = "";
  if (path) {
    const a = $(`a[href*="${path}"],a[href="${path}"]`).first();
    const container = a.closest("div");
    raw = container.text() || a.parent().text() || "";
  }
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
  return { source: "36氪", title: summary, summary, link, imageUrl: null, publishedIso: new Date().toISOString() };
}

async function extractGelonhui(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const bodyText = $("body").text() || "";

  const m = bodyText.match(/格隆汇\d{1,2}月\d{1,2}日｜[\s\S]{0,900}/);
  let raw = m ? m[0] : bodyText;

  raw = raw.split("阅读")[0].split("下一页")[0].split("查看更多")[0].split("")[0];
  const m2 = raw.slice(10).match(/格隆汇\d{1,2}月\d{1,2}日｜/);
  if (m2 && m2.index != null) raw = raw.slice(0, m2.index + 10);

  raw = raw.replace(/\s+/g, " ").trim();
  const summary = finalizeItem("格隆汇", raw);
  return { source: "格隆汇", title: summary, summary, link: url, imageUrl: null, publishedIso: new Date().toISOString() };
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
  const contentLines = [item.summary, `原文：${item.link}`].filter(Boolean);

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      标题: { title: [{ text: { content: item.summary } }] },
      来源: { select: { name: item.source } },
      原文链接: { url: item.link },
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

async function main() {
  console.log("Run at", new Date().toISOString());

  for (const s of SOURCES) {
    try {
      const item = await extractLatest(s.name, s.url);

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
