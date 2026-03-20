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

function makeDedupeKey(item) {
  // 精确到分钟，避免同一来源的入口页链接相同而无法新增
  const minute = item.publishedIso.slice(0, 16) // YYYY-MM-DDTHH:MM
  return `${item.source}|${minute}|${item.title}`
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

function parseFirstImageUrl($) {
  const img = $('img').first();
  const src = img.attr('src') || img.attr('data-src');
  if (!src) return null;
  if (src.startsWith('//')) return 'https:' + src;
  return src;
}

function pickTextSnippet(text, maxLen = 200) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}

async function extractLatest(sourceName, url) {
  if (sourceName === "华尔街见闻") return extractWallstreetcn(url)
  if (sourceName === "财联社") return extractCls(url)
  if (sourceName === "36氪") return extract36kr(url)
  if (sourceName === "金十数据") return extractJin10(url)
  if (sourceName === "格隆汇") return extractGelonhui(url)
  throw new Error("Unknown source: " + sourceName)
}

function normalizeUrl(href, base) {
  if (!href) return null
  if (href.startsWith("http")) return href
  if (href.startsWith("//")) return "https:" + href
  if (href.startsWith("/")) return base.replace(/\/$/, "") + href
  return base.replace(/\/$/, "") + "/" + href
}

function pickTextSnippet(text, maxLen = 200) {
  const t = String(text || "").replace(/\s+/g, " ").trim()
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t
}

function parseIsoInChina(t) {
  // 输入："2026-03-20 11:40:12" 或 "03-20 12:21:07" 或 "12:11"
  // 输出：ISO string（尽量精确到分钟/秒）；取不到则用当前时间
  const now = new Date()
  const year = now.getFullYear()

  if (!t) return now.toISOString()

  const s = String(t).trim()

  // 2026-03-20 11:40:12
  if (/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    return new Date(s.replace(" ", "T") + "+08:00").toISOString()
  }

  // 03-20 12:21:07
  if (/^\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    const [md, hm] = s.split(/\s+/)
    return new Date(`${year}-${md}T${hm}+08:00`).toISOString()
  }

  // 12:11（默认当天）
  if (/^\d{2}:\d{2}/.test(s)) {
    const yyyy = String(year)
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const dd = String(now.getDate()).padStart(2, "0")
    const hhmm = s.slice(0, 5)
    return new Date(`${yyyy}-${mm}-${dd}T${hhmm}:00+08:00`).toISOString()
  }

  return now.toISOString()
}

async function extractWallstreetcn(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)

  // 找第一条 juicy 编辑链接里的 ID
  const m = html.match(/livenews\/edit\/(\d{6,})/)
  const id = m ? m[1] : null
  const link = id ? `https://wallstreetcn.com/livenews/${id}` : url

  // 在页面中找该条快讯附近的标题/内容（兜底：取第一个【】标题）
  let title = null
  let summary = null

  const firstBlock = $("a[href*='livenews/edit']").first().closest("body")
  const text = pickTextSnippet(firstBlock.text(), 260)

  const titleMatch = text.match(/【([^】]{4,60})】/)
  title = titleMatch ? titleMatch[1] : "华尔街见闻快讯"
  summary = text.replace(/\s+/g, " ").trim()

  // 时间：页面里一般有类似 "03:57"，取最先出现的 HH:MM
  const timeMatch = html.match(/\b\d{2}:\d{2}\b/)
  const publishedIso = parseIsoInChina(timeMatch ? timeMatch[0] : null)

  return {
    source: "华尔街见闻",
    title,
    summary,
    link,
    imageUrl: null,
    publishedIso
  }
}

async function extractCls(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)

  // 电报页面文本里第一条通常以 "12:11【...】" 开头
  const text = $("body").text() || ""
  const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean)

  // 找第一条形如 12:11【...】
  const first = lines.find(l => /^\d{2}:\d{2}【/.test(l)) || lines[0] || ""

  const time = (first.match(/^(\d{2}:\d{2})/) || [])[1] || null
  const title = (first.match(/^\d{2}:\d{2}【([^】]+)】/) || [])[1] || "财联社电报"
  const summary = pickTextSnippet(first.replace(/^\d{2}:\d{2}/, ""), 240)

  return {
    source: "财联社",
    title,
    summary,
    link: url,
    imageUrl: null,
    publishedIso: parseIsoInChina(time)
  }
}

async function extract36kr(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)

  // 优先找第一条 /newsflashes/数字 的详情链接
  const a = $("a[href*='/newsflashes/']").first()
  const href = a.attr("href")
  const link = normalizeUrl(href, "https://www.36kr.com") || url

  // 标题：取该链接文本；兜底取第一个 # 后标题
  const title = pickTextSnippet(a.text(), 80) || pickTextSnippet($("h1").first().text(), 80) || "36氪快讯"

  // 摘要：取该标题后面附近文本（兜底取 body 文本的前 200 字）
  const nearby = a.parent().text() || a.closest("div").text() || $("body").text() || ""
  const summary = pickTextSnippet(nearby, 240)

  // 时间：页面里常见 "xx分钟前" 或日期；这里兜底用当前时间
  return {
    source: "36氪",
    title,
    summary,
    link,
    imageUrl: null,
    publishedIso: new Date().toISOString()
  }
}

async function extractJin10(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)

  // 金十快讯列表里会出现类似 "11:40:12" 的时间和后面的文本。
  const text = $("body").text() || ""
  const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean)

  const firstTimeLine = lines.find(l => /^\d{2}:\d{2}:\d{2}$/.test(l))
  const idx = firstTimeLine ? lines.indexOf(firstTimeLine) : -1
  const time = firstTimeLine || null

  // 时间行后面的一两行通常是快讯正文
  const candidate = idx >= 0 ? (lines[idx + 1] || lines[idx + 2] || "") : (lines[0] || "")
  const summary = pickTextSnippet(candidate, 240)
  const title = pickTextSnippet(candidate, 80) || "金十快讯"

  return {
    source: "金十数据",
    title,
    summary,
    link: url,
    imageUrl: null,
    publishedIso: parseIsoInChina(time ? `${String(new Date().getFullYear())}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')} ${time}` : null)
  }
}

async function extractGelonhui(url) {
  const html = await fetchHtml(url)
  const $ = cheerio.load(html)

  // 格隆汇 live 页面里第一条快讯通常有“刚刚/xx分钟前”以及正文。
  // 兜底策略：找第一个出现的“格隆汇3月”句子作为正文。
  const bodyText = $("body").text() || ""
  const m = bodyText.match(/格隆汇\d{1,2}月\d{1,2}日[\s\S]{0,200}/)
  const summary = pickTextSnippet(m ? m[0] : bodyText, 240)

  // 标题：取摘要前 40-80 字
  const title = pickTextSnippet(summary, 80) || "格隆汇快讯"

  return {
    source: "格隆汇",
    title,
    summary,
    link: url,
    imageUrl: null,
    publishedIso: new Date().toISOString()
  }
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
  const dedupeKey = makeDedupeKey(item)

  const contentLines = [
    item.summary,
    item.imageUrl ? `图片：${item.imageUrl}` : '',
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
      const dedupeKey = makeDedupeKey(item)

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
