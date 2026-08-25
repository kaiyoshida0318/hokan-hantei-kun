/**
 * ネクストエンジン同期（サーバー側＝GitHub Actions で実行）
 *
 * data.json の商品コードについて ne-sync-worker から
 * free_stock / stock_constant を取得し、data.json を更新する。
 *
 * - NE_READ_API_TOKEN はここ（Actions のシークレット）でだけ使う。
 *   ブラウザに渡さない。data.json にも書かない。
 * - 取得できなかった商品の値は 0 に置き換えず、前回値を残して stale=true にする。
 * - ツール独自データ（基礎区分・収納上限・現在の主保管/予備保管・対応状況・備考）は触らない。
 */

import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = process.env.DATA_PATH || 'data.json';
const URL_ = process.env.NE_SYNC_URL;
const TOKEN = process.env.NE_READ_API_TOKEN;
const CHUNK = 1000;          // 1リクエストあたり最大1000商品
const RETRY = 3;

function fail(msg){ console.error('ERROR: ' + msg); process.exit(1); }
if(!URL_)  fail('NE_SYNC_URL が設定されていません（リポジトリの Variables または Secrets に登録してください）。');
if(!TOKEN) fail('NE_READ_API_TOKEN が設定されていません（リポジトリの Secrets に登録してください）。');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchChunk(codes, attempt = 1){
  let res;
  try{
    res = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ne-read-token': TOKEN },
      body: JSON.stringify({ product_codes: codes }),
      signal: AbortSignal.timeout(60000)
    });
  }catch(e){
    if(attempt < RETRY){ await sleep(2000 * attempt); return fetchChunk(codes, attempt + 1); }
    throw new Error('接続に失敗しました: ' + (e.message || e));
  }
  if(res.status === 401 || res.status === 403) throw new Error('NE_READ_API_TOKEN が受け付けられませんでした（' + res.status + '）。');
  if(!res.ok){
    if(res.status >= 500 && attempt < RETRY){ await sleep(2000 * attempt); return fetchChunk(codes, attempt + 1); }
    throw new Error('APIがエラーを返しました（' + res.status + '）。');
  }
  const json = await res.json();
  if(json.ok === false) throw new Error('APIが ok:false を返しました。' + (json.message || ''));
  if(!Array.isArray(json.items)) throw new Error('レスポンスに items がありません。');
  return json;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

const raw = await readFile(DATA_PATH, 'utf8');
const data = JSON.parse(raw);
if(!Array.isArray(data.items)) fail('data.json に items がありません。');

const codes = [...new Set(data.items.map(it => String(it.code || '').trim()).filter(Boolean))];
if(!codes.length){
  console.log('商品が登録されていないため、同期をスキップしました。');
  process.exit(0);
}

const byCode = new Map();
const missingStock = [], missingGoods = [];
let syncedAt = null, requested = 0, complete = 0;

for(let i = 0; i < codes.length; i += CHUNK){
  const part = codes.slice(i, i + CHUNK);
  console.log(`取得中 ${i + 1}〜${i + part.length} / ${codes.length}`);
  const json = await fetchChunk(part);
  requested += json.requestedCount ?? part.length;
  complete  += json.completeCount  ?? 0;
  syncedAt = json.syncedAt || syncedAt;
  (json.missingStockProductCodes || []).forEach(c => missingStock.push(c));
  (json.missingGoodsProductCodes || []).forEach(c => missingGoods.push(c));
  json.items.forEach(it => { if(it && it.product_code) byCode.set(String(it.product_code), it); });
}

const stamp = syncedAt || new Date().toISOString();
let updated = 0, kept = 0, never = 0;

data.items = data.items.map(it => {
  const hit = byCode.get(String(it.code));
  const free  = hit ? num(hit.free_stock) : null;
  const teisu = hit ? num(hit.stock_constant) : null;
  const ok = !!(hit && hit.found !== false && free !== null && teisu !== null);

  if(ok){
    updated++;
    return Object.assign({}, it, {
      apiFree: free, apiTeisu: teisu,
      lastFetch: stamp, stale: false, matchError: false,
      neStockFound: hit.stock_found !== false, neGoodsFound: hit.goods_found !== false
    });
  }
  // 取得できなかった場合：0で埋めず、前回値を残す
  const hadValue = it.apiFree !== null && it.apiFree !== undefined
                && it.apiTeisu !== null && it.apiTeisu !== undefined;
  if(hadValue) kept++; else never++;
  return Object.assign({}, it, {
    stale: true,
    // 前回値がある場合は「前回取得値」として判定を続ける。
    // 一度も取得できていない場合だけ照合エラー（＝要確認）にする。
    matchError: !hadValue && (!hit || hit.found === false),
    neStockFound: hit ? hit.stock_found !== false : false,
    neGoodsFound: hit ? hit.goods_found !== false : false
  });
});

const failed = data.items.length - updated;
data.ne = {
  status: failed === 0 ? '同期成功' : (updated === 0 ? '同期失敗' : '一部商品取得エラー'),
  syncedAt: stamp,
  requested, complete,
  updated, keptPrevious: kept, neverFetched: never,
  missingStockProductCodes: [...new Set(missingStock)].slice(0, 200),
  missingGoodsProductCodes: [...new Set(missingGoods)].slice(0, 200),
  message: failed === 0 ? '' : `${failed}件の商品でNEの在庫情報を取得できませんでした。`
};
data.updatedAt = new Date().toISOString();

await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(`完了：更新 ${updated}件 / 前回値を保持 ${kept}件 / 未取得 ${never}件`);
if(missingStock.length) console.log('在庫マスタに無い商品コード: ' + [...new Set(missingStock)].slice(0, 50).join(', '));
if(missingGoods.length) console.log('商品マスタに無い商品コード: ' + [...new Set(missingGoods)].slice(0, 50).join(', '));
