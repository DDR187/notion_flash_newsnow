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
  { name: "华尔街见闻", url: "https://wallstreetcn.com/live/global" },
];

function makeDedupeKey(item) {
  const minute = item.publishedIso.slice(0, 16);
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
  if (sourceName === "华尔街见闻") return extractWallstreetcn(url);
  if (sourceName === "财联社") return extractCls(url);
  if (sourceName === "36氪") return extract36kr(url);
  if (sourceName === "金十数据") return extractJin10(url);
  if (sourceName === "格隆汇") return extractGelonhui(url);
  throw new Error("Unknown source: " + sourceName);
}

function cleanWscnBlockText(raw) {
  let t = String(raw || "");
  // 去掉 UI 文案
  t = t.replace(/参与评论|收藏|微信|微博|展开/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function extractWallstreetcn(liveUrl) {
  const liveHtml = await fetchHtml(liveUrl);
  const $ = cheerio.load(liveHtml);

  // 1) 定位第一条 edit 链接
  const a = $("a[href*='juicy.wscn.net/livenews/edit/'],a[href*='livenews/edit/']").first();
  const href = a.attr("href") || "";
  const idMatch = href.match(/livenews\/edit\/(\d{6,})/);
  const id = idMatch ? idMatch[1] : null;

  // 2) 取该条快讯块文本（只取这一条，不碰 body 全文）
  const container = a.closest("li, div");
  let blockText = cleanWscnBlockText(container.text() || a.parent().text() || "");
  blockText = pickTextSnippet(blockText, 500);

  // 3) 从块里提取标题+正文
  // 典型结构："04:02 【标题】 正文...（来源）"
  const titleMatch = blockText.match(/【([^】]{4,80})】/);
  let raw = "";
  if (titleMatch) {
    const after = blockText.replace(/^[\s\S]*?】\s*/, "").trim();
    raw = after || titleMatch[1];
  } else {
    // 去掉开头时间（04:02）
    raw = blockText.replace(/^\d{2}:\d{2}\s*/, "").trim();
  }

  // 4) 时间
  const timeMatch = blockText.match(/\b\d{2}:\d{2}\b/) || liveHtml.match(/\b\d{2}:\d{2}\b/);
  const publishedIso = parseIsoInChina(timeMatch ? timeMatch[0] : null);

  const detailUrl = id ? `https://wallstreetcn.com/livenews/${id}` : liveUrl;

  const summary = finalizeItem("华尔街见闻", raw);
  return { source: "华尔街见闻", title: summary, summary, link: detailUrl, imageUrl: null, publishedIso };
}

// 下面 4 个来源保持你当前版本（原样粘贴即可）
// extractCls / extract36kr / extractJin10 / extractGelonhui / notionHasDedupeKey / createNotionRow / main

// 你可以从你当前 index.js 里，把这几个函数整段复制到这里：
// - extractCls
// - extract36kr
// - extractJin10
// - extractGelonhui
// - notionHasDedupeKey
// - createNotionRow
// - main
