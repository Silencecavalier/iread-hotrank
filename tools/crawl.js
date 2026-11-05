/* 番茄七榜抓取（数据源 daosearch.io）
 * 用法：node tools/crawl.js [输出目录，默认仓库根]
 * 依赖：curl（Linux/macOS 自带；Windows 10+ 自带）。不用 node 的 https，
 *      因为 daosearch 的 Cloudflare 会按 TLS 指纹挑战 node 客户端，curl 能直接过。
 */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const OUT = process.argv[2] || path.resolve(__dirname, '..');
const BOARDS = [
  { id: 'reading', name: '阅读榜', type: 'reading' },
  { id: 'recommend', name: '推荐榜', type: 'recommend' },
  { id: 'peak', name: '巅峰榜', type: 'peak' },
  { id: 'darkhorse', name: '黑马榜', type: 'darkhorse' },
  { id: 'newbook', name: '新书榜', type: 'newbook' },
  { id: 'following', name: '追更榜', type: 'following' },
  { id: 'completed', name: '完本榜', type: 'completed' }
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function dec(s) {
  return String(s || '').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function strip(s) { return dec(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function words(s) {
  const m = /([\d.]+)\s*(万|亿)?\s*字/.exec(String(s || ''));
  if (!m) return 0;
  const n = Number(m[1]);
  if (!isFinite(n)) return 0;
  if (m[2] === '亿') return Math.round(n * 100000000);
  if (m[2] === '万') return Math.round(n * 10000);
  return Math.round(n);
}
function parse(html) {
  const out = [];
  const blocks = String(html).split('<li class="row-with-save">').slice(1);
  for (const b of blocks) {
    const href = /href="(\/fanqie\/book\/(\d+)\/[^"]*)"/.exec(b);
    if (!href || !href[2]) continue;
    const cover = (/<img src="([^"]+)"/.exec(b) || [])[1] || '';
    const title = strip((/<strong>([\s\S]*?)<\/strong>/.exec(b) || [])[1] || '');
    const author = strip((/<span class="chart-byline"[^>]*>([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const genre = strip((/<span class="meta-chip meta-genre">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const wordChip = strip((/<span class="meta-chip"><svg[\s\S]*?<\/svg>([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const status = strip((/<span class="status-dot"><\/span>([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const desc = strip((/<span class="row-desc">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
    const stats = [...b.matchAll(/<span class="chart-stat-val">([\s\S]*?)<\/span><span class="chart-stat-lbl">([\s\S]*?)<\/span>/g)]
      .map(m => ({ v: strip(m[1]), l: strip(m[2]) }));
    const stat = lbl => { const f = stats.find(x => x.l === lbl); return f ? f.v : ''; };
    if (!title) continue;
    out.push({
      bookId: href[2], title, author, genre, words: words(wordChip), status, intro: desc,
      cover, reading: stat('在读'), score: stat('评分'), shelf: stat('加书架'),
      bookUrl: 'https://fanqienovel.com/page/' + href[2]
    });
  }
  return out;
}
function curl(url) {
  const r = cp.spawnSync('curl', [
    '-sS', '-m', '30', '--compressed',
    '-H', 'User-Agent: ' + UA,
    '-H', 'Accept-Language: zh-CN,zh;q=0.9',
    '-w', '\n__STATUS__%{http_code}', url
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error('curl: ' + r.error.message);
  const out = r.stdout || '';
  const m = /\n__STATUS__(\d+)$/.exec(out);
  return { status: m ? Number(m[1]) : 0, body: m ? out.slice(0, out.length - m[0].length) : out };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageUrl = (type, page) => `https://daosearch.io/fanqie/rankings?channel=0&lang=zh&page=${page}&rank_type=${type}`;

(async () => {
  const t0 = Date.now();
  let ok = 0;
  for (const b of BOARDS) {
    let items = [];
    for (let page = 1; page <= 2; page++) {
      let r;
      try { r = curl(pageUrl(b.type, page)); } catch (e) { console.log(b.id, 'page' + page, e.message); break; }
      if (r.status !== 200) { console.log(b.id, 'page' + page, 'HTTP', r.status); break; }
      const got = parse(r.body);
      if (!got.length) break;
      const seen = new Set(items.map(x => x.bookId));
      for (const it of got) if (!seen.has(it.bookId)) items.push(it);
      if (items.length >= 30) break;
      await sleep(800);
    }
    if (!items.length) { console.log(b.id, 'FAIL'); continue; }
    const payload = {
      channel: { id: b.id, name: b.name, url: 'https://daosearch.io/fanqie/rankings?channel=0&lang=zh&rank_type=' + b.type },
      items, failed: 0, generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(OUT, 'hot-' + b.id + '.json'), JSON.stringify(payload));
    ok++;
    console.log(b.name, items.length + '本', '首位:', items[0].title.slice(0, 20));
  }
  console.log('OK', ok, '/', BOARDS.length, '耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!ok) process.exit(1);
})();
