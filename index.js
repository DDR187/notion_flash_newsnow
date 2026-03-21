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
  // V6：改用 global 入口
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

function cleanWscn(raw) {
  let t = String(raw || "");
  t = t.replace(/参与评论|收藏|微信|微博|展开|相关文章：/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function extractWallstreetcn(liveUrl) {
  const liveHtml = await fetchHtml(liveUrl);

  // 先找 edit id
  let id = null;
  const m1 = liveHtml.match(/livenews\/edit\/(\d{6,})/);
  if (m1) id = m1[1];

  // 再兜底：找详情 id
  if (!id) {
    const m2 = liveHtml.match(/wallstreetcn\.com\/livenews\/(\d{6,})/);
    if (m2) id = m2[1];
  }

  const detailUrl = id ? `https://wallstreetcn.com/livenews/${id}` : null;
  const link = detailUrl || liveUrl;

  // V6：优先用详情页正文
  let raw = "";
  if (detailUrl) {
    const detailHtml = await fetchHtml(detailUrl);
    const $d = cheerio.load(detailHtml);
    const detailText = cleanWscn($d("body").text() || "");
    raw = pickTextSnippet(detailText, 260);
  }

  // 如果详情页也取不到，再从 live 页抽
  if (!raw || raw.length < 10) {
    const $ = cheerio.load(liveHtml);
    const a0 = $("a[href*='livenews/edit']").first();
    raw = pickTextSnippet(cleanWscn(a0.closest("li, div").text() || a0.parent().text() || $("body").text() || ""), 260);
  }

  // 时间：从 live 页里取第一个 HH:MM（够用），或用当前时间兜底
  const timeMatch = liveHtml.match(/\b\d{2}:\d{2}\b/);
  const publishedIso = parseIsoInChina(timeMatch ? timeMatch[0] : null);

  const summary = finalizeItem("华尔街见闻", raw);
  return { source: "华尔街见闻", title: summary, summary, link, imageUrl: null, publishedIso };
}

async function extractCls(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const text = $("body").text() || "";
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

  const first = lines.find((l) => /^\d{2}:\d{2}【.+?】/.test(l)) || "";
  const time = (first.match(/^(\d{2}:\d{2})/) || [])[1] || null;

  let raw = first || "";
  if (!raw) {
    const m = text.match(/\b\d{2}:\d{2}【[^】]+】[\s\S]{0,240}/);
    raw = m ? m[0] : "";
  }

  raw = raw.split("阅")[0];
  raw = raw.replace(/^\d{2}:\d{2}/, "").replace(/^【[^】]+】/, "").trim();

  const summary = finalizeItem("财联社", raw || "");
  return { source: "财联社", title: summary, summary, link: url, imageUrl: null, publishedIso: parseIsoInChina(time) };
}

async function extract36kr(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const m = html.match(/href=\"(\/newsflashes\/\d+)\"/);
  const link = m ? `https://www.36kr.com${m[1]}` : url;

  let raw = "";
  if (m) {
    const a = $(`a[href*="${m[1]}"],a[href="${m[1]}"]`).first();
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
  const end = Math.min(lines.length, idx >= 0 ? idx + 140 : 140);
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (isNoise(line)) continue;
    if (!/[\u4e00-\u9fa5]/.test(line)) continue;
    if (/(查看更多|扫码|订阅|登录|APP|下载|设置|桌面通知|声音提示|字体大小|内容筛选|恢复默认)/.test(line)) continue;
    if (line.length < 10 || line.length > 220) continue;
    candidate = line;
    break;
  }

  if (!candidate) {
    const m2 = html.match(/\b\d{2}:\d{2}:\d{2}\b[\s\S]{0,40}?[\u4e00-\u9fa5][\s\S]{0,120}/);
    if (m2) candidate = m2[0].replace(/^\d{2}:\d{2}:\d{2}/, "").trim();
  }

  const summary = finalizeItem("金十数据", candidate);

  const yyyy = String(new Date().getFullYear());
  const mm = String(new Date().getMonth() + 1).padStart(2, "0");
  const dd = String(new Date().getDate()).padStart(2, "0");
  const publishedIso = parseIsoInChina(time ? `${yyyy}-${mm}-${dd} ${time}` : null);

  return { source: "金十数据", title: summary, summary, link: url, imageUrl: null, publishedIso };
}

async function extractGelonhui(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const bodyText = $("body").text() || "";

  const m = bodyText.match(/格隆汇\d{1,2}月\d{1,2}日｜[\s\S]{0,900}/);
  let raw = m ? m[0] : bodyText;

  raw = raw
    .split("阅读")[0]
    .split("下一页")[0]
    .split("查看更多")[0]
    .split("")[0]
    .replace(/\s+/g, " ")
    .trim();

  const m2 = raw.slice(10).match(/格隆汇\d{1,2}月\d{1,2}日｜/);
  if (m2 && m2.index != null) raw = raw.slice(0, m2.index + 10);

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
