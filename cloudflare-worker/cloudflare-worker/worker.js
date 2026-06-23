/* =============================================================================
 * hd-save-api ― 狩猟次元 クラウドセーブ API（Cloudflare Workers + KV）
 * -----------------------------------------------------------------------------
 * エンドポイント
 *   POST /api/save            … 新規発行。body=セーブJSON → { id, key } を返す
 *   PUT  /api/save/:id        … 既存更新。ヘッダ X-Save-Key 必須（一致時のみ上書き）
 *   GET  /api/save/:id        … 復元。ID のみで読める（key 不要）→ data を返す
 *
 * 設計メモ
 *  - 1ユーザー=1セーブブロブ。KV に "save:<id>" として {key, data, updatedAt} を保存。
 *  - 読み取りは ID を知っていれば誰でも可能 / 書き込みは秘密 key 必須（誤上書き・荒らし対策）。
 *  - ID/key は推測困難なランダム文字列。サイズ上限と簡易レート制限あり。
 *  - 認証なし運用のため「ID を知る人は読める」点は割り切り。必要なら CORS を自分の
 *    オリジンに限定（下の ALLOW_ORIGIN）し、さらに read にも key を要求する等で強化可能。
 * ========================================================================== */

// 調整ポイント ---------------------------------------------------------------
const MAX_BYTES = 256 * 1024;                 // 1セーブの最大サイズ（約256KB）
const TTL_SECONDS = 60 * 60 * 24 * 365 * 2;   // 保存の有効期間（2年。0/未指定で無期限にしたい場合は put から expirationTtl を外す）
const RATE_MAX = 60;                          // 書き込み回数の上限／IP／RATE_WINDOW
const RATE_WINDOW = 60;                       // レート制限の窓（秒）
const ALLOW_ORIGIN = '*';                     // CORS。自分のサイトに限定するなら 'https://....github.io' 等へ
// ---------------------------------------------------------------------------

const cors = () => ({
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Save-Key',
  'Access-Control-Max-Age': '86400',
});

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(), ...extra } });

// 紛らわしい文字（0/O/1/l/I）を除いたランダムID
const randId = (len) => {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (const b of bytes) s += cs[b % cs.length];
  return s;
};

export default {
  async fetch(request, env) {
    // CORS プリフライト
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/save(?:\/([A-Za-z0-9]+))?\/?$/);
    if (!match) return json({ error: 'not found' }, 404);

    const id = match[1] || null;
    const kv = env.SAVES; // wrangler.toml の KV binding 名
    if (!kv) return json({ error: 'KV(SAVES) が未バインドです。wrangler.toml を確認してください' }, 500);

    // ---- 復元（GET）: ID のみで読める ----
    if (request.method === 'GET') {
      if (!id) return json({ error: 'id required' }, 400);
      const rec = await kv.get('save:' + id);
      if (rec === null) return json({ error: 'not found' }, 404);
      let parsed;
      try { parsed = JSON.parse(rec); } catch (_) { parsed = null; }
      const data = parsed && parsed.data !== undefined ? parsed.data : parsed;
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...cors() } });
    }

    // ---- 保存（POST=発行 / PUT=更新）----
    if (request.method === 'POST' || request.method === 'PUT') {
      // 簡易レート制限（IP単位・ベストエフォート）
      const ip = request.headers.get('CF-Connecting-IP') || 'anon';
      const rlKey = 'rl:' + ip;
      const used = parseInt((await kv.get(rlKey)) || '0', 10);
      if (used >= RATE_MAX) return json({ error: 'レート制限中です。しばらく待って再試行してください' }, 429);
      await kv.put(rlKey, String(used + 1), { expirationTtl: RATE_WINDOW });

      const bodyText = await request.text();
      if (bodyText.length > MAX_BYTES) return json({ error: 'データが大きすぎます' }, 413);
      let data;
      try { data = JSON.parse(bodyText); } catch (_) { return json({ error: 'JSON が不正です' }, 400); }

      if (request.method === 'POST') {
        // 新規発行：ID と書込キーを払い出す
        const newId = randId(22);
        const key = randId(28);
        await kv.put('save:' + newId, JSON.stringify({ key, data, updatedAt: Date.now() }), { expirationTtl: TTL_SECONDS });
        return json({ id: newId, key });
      }

      // PUT（既存更新）：キー一致時のみ上書き
      if (!id) return json({ error: 'id required' }, 400);
      const rec = await kv.get('save:' + id);
      if (rec === null) return json({ error: 'not found' }, 404);
      let parsed;
      try { parsed = JSON.parse(rec); } catch (_) { parsed = {}; }
      const provided = request.headers.get('X-Save-Key') || '';
      if (!parsed.key || provided !== parsed.key) return json({ error: '書込キーが一致しません' }, 403);
      await kv.put('save:' + id, JSON.stringify({ key: parsed.key, data, updatedAt: Date.now() }), { expirationTtl: TTL_SECONDS });
      return json({ id, key: parsed.key });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
