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
  if (/^(\/\/|window\.|function\s|gtag\(|dataLayer\b|_hmt\b)/i.test(t)) return true;
  if (t === "快讯" || t === "账号设置" || t.length < 6) return true;
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
  return `${base}（${source}）`;
}

function clean36kr(raw) {
  let t = String(raw || "");
  // 去掉“xx分钟前”及其后紧跟的分享 UI
  t = t.replace(/\d+\s*分钟前/g, " ");
  t = t.replace(/分享至/g, " ");
  t = t.replace(/打开微信“扫一扫”[\s\S]*?分享按钮/g, " ");
  t = t.replace(/打开微信/g, " ").replace(/扫一扫/g, " ");
  t = t.replace(/点击屏幕右上角分享按钮/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function cleanGelonghui(raw) {
  let t = String(raw || "");
  // 以“阅读///下一页/查看更多/分钟”这类为分隔截断
  t = t.split("阅读")[0];
  t = t.split("下一页")[0];
  t = t.split("查看更多")[0];
  t = t.split("")[0];
  // 如果仍包含第二条“格隆汇X月X日｜”，只保留第一条
  const m2 = t.slice(10).match(/格隆汇\d{1,2}月\d{1,2}日｜/);
  if (m2 && m2.index != null) t = t.slice(0, m2.index + 10);
  return t.replace(/\s+/g, " ").trim();
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
    const a0 = $("a[href*='livenews/edit']").first();
    text = a0.closest("li, div").text() || $("body").text() || "";
  }

  const cleaned = pickTextSnippet(text, 260);
  const timeMatch = html.match(/\b\d{2}:\d{2}\b/);
  const publishedIso = parseIsoInChina(timeMatch ? timeMatch[0] : null);

  let raw = cleaned;
  const titleMatch = cleaned.match(/【([^】]{4,60})】/);
  if (titleMatch) {
    raw = cleaned.replace(/^[\s\S]*?】\s*/, "").trim();
    if (!raw) raw = titleMatch[1];
  }

  const summary = finalizeItem("华尔街见闻", raw);
  return { source: "华尔街见闻", title: summary, summary, link, imageUrl: null, publishedIso };
}

async function extractCls(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const text = $("body").text() || "";
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);

  // V3：更严格——必须是“HH:MM【标题】正文...”这一行
  const first = lines.find((l) => /^\d{2}:\d{2}【.+?】/.test(l)) || "";
  const time = (first.match(/^(\d{2}:\d{2})/) || [])[1] || null;

  let raw = first || "";
  if (!raw) {
    // 兜底：在全文里找第一次出现的电报格式
    const m = text.match(/\b\d{2}:\d{2}【[^】]+】[\s\S]{0,240}/);
    raw = m ? m[0] : "";
  }

  // 截断到“阅”前
  raw = raw.split("阅")[0];

  raw = raw
    .replace(/^\d{2}:\d{2}/, "")
    .replace(/^【[^】]+】/, "")
    .trim();

  const summary = finalizeItem("财联社", raw || "财联社电报");
  return { source: "财联社", title: summary, summary, link: url, imageUrl: null, publishedIso: parseIsoInChina(time) };
}

async function extract36kr(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // 必须是 /newsflashes/数字ID
  const m = html.match(/href=\"(\/newsflashes\/\d+)\"/);
  const link = m ? `https://www.36kr.com${m[1]}` : url;

  let raw = "";
  if (m) {
    const a = $(`a[href*="${m[1]}"]`).first();
    const container = a.closest("div");
    raw = container.text() || a.parent().text() || "";
  }
  if (!raw) raw = $("body").text() || "";

  raw = clean36kr(raw);
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

  // V3：候选行必须“含中文 + 不是页面功能文案 + 长度合理”
  let candidate = "";
  const start = Math.max(idx, 0);
  const end = Math.min(lines.length, idx >= 0 ? idx + 120 : 120);
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (isNoise(line)) continue;
    if (!/[\u4e00-\u9fa5]/.test(line)) continue;
    if (/(查看更多|扫码|订阅|登录|APP|下载|设置|桌面通知|声音提示|字体大小|内容筛选|恢复默认)/.test(line)) continue;
    if (line.length < 10 || line.length > 220) continue;
    // 排除明显“栏目标题”
    if (/^(重要事件|市场快讯|VIP快讯|分类|推荐阅读)$/.test(line)) continue;
    candidate = line;
    break;
  }

  // V3：兜底——如果还是没找到，尝试从 html 里抓第一条“HH:MM:SS 后面紧跟一句中文”的片段
  if (!candidate) {
    const m2 = html.match(/\b\d{2}:\d{2}:\d{2}\b[\s\S]{0,40}?[\u4e00-\u9fa5][\s\S]{0,120}/);
    if (m2) candidate = m2[0].replace(/^\d{2}:\d{2}:\d{2}/, "").trim();
  }

  const summary = finalizeItem("金十数据", candidate || "（未抓到有效快讯正文）");

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

  // V3：先抓到第一条“格隆汇X月X日｜...”开头，并允许更长，再用 clean 截断
  const m = bodyText.match(/格隆汇\d{1,2}月\d{1,2}日｜[\s\S]{0,900}/);
  let raw = m ? m[0] : bodyText;
  raw = cleanGelonghui(raw);

  const summary = finalizeItem("格隆汇", raw || "格隆汇快讯");
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
