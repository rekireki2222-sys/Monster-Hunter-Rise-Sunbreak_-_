/* =============================================================================
 * fx-gacha-plugins.js  ―  追加演出モジュール（拡張サンプル集）
 * -----------------------------------------------------------------------------
 * ★これは「演出を後から足すだけで増やせる」ことを示す見本ファイルです。
 *   既存の fx-gacha.js / fx-gacha-config.js を一切書き換えずに、
 *   FXGacha.register(...) で新しい演出を“追加するだけ”で組み込めます。
 *
 * ★使い方（雷・炎・氷・龍属性などを足したい時）
 *   1) ここ（または新規ファイル）に FXGacha.register(() => ({...})) を書く。
 *   2) optional:true にして、起動したいレア度の config.rarity[key].modules に
 *      モジュールID（例 'FX_Lightning'）を足す。→ そのレア度の時だけ発動する。
 *   3) index.html で fx-gacha.js の後に読み込む（このファイルは既に読み込み済み）。
 *
 * ★モジュールのライフサイクル（すべて任意。詳しくは fx-gacha.js のコメント参照）
 *   id / optional / init(ctx) / onPhaseEnter / onTick / onPhaseExit / dispose(ctx)
 *   小道具： FXGacha._utils.{ lerp, clamp01, Ease, read, rand }
 * ========================================================================== */

(() => {
  'use strict';
  if (!window.FXGacha) return; // エンジン未読込なら何もしない（安全側）

  const { lerp, clamp01, rand } = window.FXGacha._utils;

  /* ===========================================================================
   * FX_Rainbow ｜ 最高レア(★5SP)用の虹オーラ＋光柱
   *   config.rarity['rarity-5sp'].modules = ['FX_Rainbow'] の時だけ起動。
   *   レア色に依存せず“虹”で特別感を出す追加レイヤー。
   * ========================================================================= */
  window.FXGacha.register(() => ({
    id: 'FX_Rainbow',
    optional: true, // ← rarity.modules に含まれる時だけ動く

    init(ctx) {
      // 虹リング（CSSアニメで回転）
      const ring = document.createElement('div');
      ring.className = 'fx-rainbow-ring';
      ring.style.opacity = '0';
      ctx.world.appendChild(ring);
      this.ring = ring;

      // 光の柱（縦に伸びる加算の光）
      const pillar = document.createElement('div');
      pillar.className = 'fx-rainbow-pillar';
      pillar.style.opacity = '0';
      ctx.world.appendChild(pillar);
      this.pillar = pillar;
    },

    onTick(phase, p, gT, dt, ctx) {
      // 破砕〜余韻で虹を立ち上げる
      if (phase === 'shatter') {
        if (this.pillar) this.pillar.style.opacity = String(p * 0.8);
      } else if (phase === 'reveal') {
        if (this.ring) {
          this.ring.style.opacity = String(clamp01(p * 1.5) * 0.9);
          this.ring.style.transform = `translate(-50%, -50%) scale(${lerp(1.4, 1.0, p)})`;
        }
        if (this.pillar) this.pillar.style.opacity = String(lerp(0.8, 0.5, p));
      }
    },

    dispose() {
      // 追加した要素を必ず除去（リーク防止）
      if (this.ring && this.ring.parentNode) this.ring.parentNode.removeChild(this.ring);
      if (this.pillar && this.pillar.parentNode) this.pillar.parentNode.removeChild(this.pillar);
      this.ring = this.pillar = null;
    },
  }));

  /* ===========================================================================
   * FX_Lightning ｜【テンプレ】雷属性の追加演出（コメントアウトの雛形）
   *   下を有効化し、config.rarity[任意キー].modules に 'FX_Lightning' を足せば発動。
   *   炎(FX_Fire)・氷(FX_Ice)・龍(FX_Dragon)も同じ形でコピーして増やせます。
   * ---------------------------------------------------------------------------
   * window.FXGacha.register(() => ({
   *   id: 'FX_Lightning',
   *   optional: true,
   *   init(ctx) {
   *     // 例：稲妻用の Canvas / SVG をここで生成し ctx.world か ctx.camera に追加
   *   },
   *   onPhaseEnter(phase, ctx) {
   *     if (phase === 'shatter') {
   *       // 例：破砕の瞬間に稲妻を1本走らせる
   *     }
   *   },
   *   onTick(phase, p, gT, dt, ctx) {
   *     // 例：crack 中に放電のチラつきを描く
   *   },
   *   dispose(ctx) {
   *     // 例：生成した要素を removeChild して参照を null に（必須）
   *   },
   * }));
   * ========================================================================= */
})();
