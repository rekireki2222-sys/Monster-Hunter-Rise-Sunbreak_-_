/* =============================================================================
 * fx-gacha.js  ―  ガチャ演出エンジン（タイムライン + モジュール方式）
 * -----------------------------------------------------------------------------
 * ★設計方針（ユーザー要望に対応）
 *   1. 編集しやすさ最優先：各演出は「独立モジュール」。互いに依存しない。
 *   2. 数値は全部外部化：fx-gacha-config.js に集約（このファイルは数値を持たない）。
 *   3. タイムラインを分離：導入/凝縮/静止/ヒビ/破砕/登場 を独立フェーズとして駆動。
 *   4. レア度は色1パラメータ：演出本体は共通。色(--fx-color)等を差し替えるだけ。
 *   5. 後から追加できる：FXGacha.register() で新モジュールを“足すだけ”。既存は不変。
 *   6. パフォーマンス：終了時に rAF / DOM / Canvas / Audio をすべて停止・破棄。
 *   7. 命名規則：DOMは #FX_GachaStage / .fx-* 、モジュールIDは FX_* で統一。
 *
 * ★使い方（app.js から）
 *   FXGacha.play({
 *     rarity: 'rarity-5',        // ← レア度キー（config.rarity のキー）。色の出し分けに使用
 *     sourceCardEl: cardElement, // ← 任意。登場演出で複製するアイテムカード
 *     onComplete: () => { ... }  // ← 演出が完全に終わって破棄された後に呼ばれる
 *   });
 *
 * ★拡張の仕方（雷/炎/氷/龍属性などを後から追加）
 *   別ファイル(例: fx-gacha-plugins.js)で:
 *     FXGacha.register(() => ({
 *       id: 'FX_Lightning', optional: true,   // optional:true は rarity.modules に入った時だけ動く
 *       onPhaseEnter(phase, ctx){ ... }, dispose(){ ... }
 *     }));
 *   → 既存コードを書き換えずに演出が増える。
 * ========================================================================== */

(() => {
  'use strict';

  /* ===========================================================================
   * 0. ユーティリティ（数値補間・イージング・設定の安全読み出し）
   * ========================================================================= */

  /** 0〜1 にクランプ */
  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

  /** 線形補間：a→b を t(0〜1) で混ぜる */
  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * イージング関数群（緩急はここが9割）
   * - easeIn  : 最初ゆっくり→加速（タメ・収束向き）
   * - easeOut : 走り出し速く→減速（ヒビ・浮上向き、「ピシッ」感）
   * - easeInOut: 両端ゆっくり
   * - snap    : ほぼ即時（破砕のスナップ向き）
   */
  const Ease = {
    linear:   (t) => t,
    easeIn:   (t) => t * t,                       // 二次のイーズイン
    easeOut:  (t) => 1 - Math.pow(1 - t, 3),      // 三次のイーズアウト
    easeInOut:(t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    snap:     (t) => (t <= 0 ? 0 : 1),
  };

  /** フェーズごとの既定イージング（config では変えず、ここで演出の“質感”を定義） */
  const PHASE_EASE = {
    intro:    'easeIn',   // 収束は ease-in
    condense: 'easeInOut',
    still:    'easeOut',  // 一瞬の収縮を入れて静止
    crack:    'easeOut',  // ヒビは ease-out
    shatter:  'easeOut',
    reveal:   'easeOut',  // 浮上は ease-out
  };

  /**
   * 設定の安全読み出し。'a.b.c' のドット表記で window.FX_GACHA_CONFIG を辿る。
   * 値が無ければ fallback を返す（config を部分的に消しても落ちないため）。
   */
  const read = (path, fallback) => {
    const root = window.FX_GACHA_CONFIG || {};
    let cur = root;
    for (const key of String(path).split('.')) {
      if (cur == null || typeof cur !== 'object' || !(key in cur)) return fallback;
      cur = cur[key];
    }
    return cur == null ? fallback : cur;
  };

  /** 乱数ヘルパ */
  const rand = (min, max) => min + Math.random() * (max - min);

  /* ===========================================================================
   * 1. モジュール・レジストリ（追加だけで拡張できる仕組み）
   * ---------------------------------------------------------------------------
   *   モジュールは「ファクトリ関数」で登録する。play() のたびに new されて使い捨て。
   *   返すオブジェクトが実装できるライフサイクル（すべて任意）:
   *     id            : 文字列（必須。FX_*）
   *     optional      : true なら「レア度の modules に含まれる時だけ」起動
   *     init(ctx)            : DOM/Canvas を生成（演出開始前）
   *     onPhaseEnter(phase, ctx)            : フェーズ開始の瞬間
   *     onTick(phase, p, gT, dt, ctx)       : 毎フレーム（p=イーズ後進行0〜1）
   *     onPhaseExit(phase, ctx)             : フェーズ終了の瞬間
   *     dispose(ctx)        : 後始末（DOM除去・Canvas解放・Audio停止）← 必ず実装推奨
   * ========================================================================= */

  const moduleFactories = []; // 登録された全モジュールのファクトリ
  const registerModule = (factory) => {
    if (typeof factory === 'function') moduleFactories.push(factory);
  };

  /* ===========================================================================
   * 2. ステージ（演出オーバーレイ）の組み立て / 破棄
   * ---------------------------------------------------------------------------
   *   命名: ルート #FX_GachaStage 、内部レイヤーは .fx-* で統一。
   *   レイヤー重なり（奥→手前）:
   *     fx-camera(粒子→fx-world(球/ヒビ/オーラ)→破片→アイテム) → vignette → flash → 字幕/スキップ
   * ========================================================================= */

  const buildStage = (ctx) => {
    const stage = document.createElement('div');
    stage.id = 'FX_GachaStage';
    stage.className = 'fx-stage';
    stage.style.zIndex = String(read('general.zIndex', 9999));
    stage.setAttribute('role', 'alert');
    stage.setAttribute('aria-label', 'ガチャ演出');

    // インライン SVG：色収差(Chromatic Aberration)用フィルタの定義だけを持つ（描画はしない）
    const svgNS = 'http://www.w3.org/2000/svg';
    const defsSvg = document.createElementNS(svgNS, 'svg');
    defsSvg.setAttribute('class', 'fx-defs');
    defsSvg.setAttribute('width', '0');
    defsSvg.setAttribute('height', '0');
    defsSvg.innerHTML = `
      <defs>
        <filter id="FX_ChromaFilter" x="-20%" y="-20%" width="140%" height="140%">
          <feOffset class="fx-chroma-r" in="SourceGraphic" dx="0" dy="0" result="r"/>
          <feOffset class="fx-chroma-b" in="SourceGraphic" dx="0" dy="0" result="b"/>
          <feBlend in="r" in2="b" mode="screen"/>
        </filter>
      </defs>`;
    stage.appendChild(defsSvg);

    // カメラ層（シェイク/ドリーの transform をここに当てる＝全シーンが一緒に揺れる）
    const camera = document.createElement('div');
    camera.className = 'fx-camera';
    stage.appendChild(camera);

    // ワールド層（色収差・レンズ歪みを当てる対象。Canvas は含めず DOM だけ）
    const world = document.createElement('div');
    world.className = 'fx-world';
    camera.appendChild(world);

    // 周辺減光・閃光・字幕・スキップ
    const vignette = document.createElement('div');
    vignette.className = 'fx-vignette';
    stage.appendChild(vignette);

    const flash = document.createElement('div');
    flash.className = 'fx-flash';
    stage.appendChild(flash);

    if (read('general.showCaption', true)) {
      const caption = document.createElement('p');
      caption.className = 'fx-caption';
      stage.appendChild(caption);
      ctx.caption = caption;
    }

    if (read('general.allowSkip', true)) {
      const hint = read('general.skipHint', '');
      if (hint) {
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'fx-skip';
        skip.textContent = hint;
        stage.appendChild(skip);
        ctx.skipButton = skip;
      }
    }

    document.body.appendChild(stage);

    // サイズ・中心（CSS px）。短時間演出なのでリサイズ追従はしない。
    const rect = stage.getBoundingClientRect();
    ctx.stage = stage;
    ctx.camera = camera;
    ctx.world = world;
    ctx.vignette = vignette;
    ctx.flash = flash;
    ctx.cw = rect.width;
    ctx.ch = rect.height;
    ctx.cx = rect.width / 2;
    ctx.cy = rect.height / 2;
    ctx.dpr = Math.min(window.devicePixelRatio || 1, 2); // Canvas 解像度（重さ対策で最大2倍）
  };

  /** 演出ステージ用の Canvas を1枚作って world と同じカメラ層に重ねる（モジュールが各自所有） */
  const makeCanvas = (ctx, className) => {
    const canvas = document.createElement('canvas');
    canvas.className = `fx-canvas ${className}`;
    canvas.width = Math.round(ctx.cw * ctx.dpr);
    canvas.height = Math.round(ctx.ch * ctx.dpr);
    const g = canvas.getContext('2d');
    g.scale(ctx.dpr, ctx.dpr); // 以降は CSS px 座標で描ける
    return { canvas, g };
  };

  /* ===========================================================================
   * 3. 組み込みモジュール（各 FX は完全に独立。1つ消しても他は動く）
   * ---------------------------------------------------------------------------
   *   ※ 各モジュールはコピペで別ファイルに切り出してもそのまま動く粒度にしてあります。
   * ========================================================================= */

  /* --- FX_ScreenEffect ｜ 画面エフェクト（Vignette/DoF/Exposure/色収差/レンズ歪み） --- */
  registerModule(() => ({
    id: 'FX_ScreenEffect',
    init(ctx) {
      // 初期値（導入の暗くボケた状態）
      ctx.setVar('--fx-vignette', read('screen.vignetteIntro', 0.88));
      ctx.setVar('--fx-blur', read('screen.blurIntroPx', 7) + 'px');
      ctx.setVar('--fx-exposure', read('screen.exposureBase', 0.8));
      ctx.setVar('--fx-lens-scale', 1); // レンズ歪み相当の最終スケール（1=等倍）
      // 色収差フィルタの参照を取得（毎フレーム dx を書き換える）
      this.chromaR = ctx.stage.querySelector('.fx-chroma-r');
      this.chromaB = ctx.stage.querySelector('.fx-chroma-b');
      this.chromaEnabled = read('screen.chroma.enabled', true);
    },
    setChroma(ctx, px) {
      if (!this.chromaEnabled) return;
      // dx を左右に振って R/B をずらす＝色収差。0 のときはフィルタを外して負荷を減らす。
      if (px > 0.05) {
        ctx.world.classList.add('fx-chroma-on');
        if (this.chromaR) this.chromaR.setAttribute('dx', String(-px));
        if (this.chromaB) this.chromaB.setAttribute('dx', String(px));
      } else {
        ctx.world.classList.remove('fx-chroma-on');
      }
    },
    onTick(phase, p, gT, dt, ctx) {
      const base = read('screen.exposureBase', 0.8);
      if (phase === 'intro') {
        // 暗いまま。ボケ強め。
        ctx.setVar('--fx-vignette', read('screen.vignetteIntro', 0.88));
        ctx.setVar('--fx-blur', read('screen.blurIntroPx', 7) + 'px');
        ctx.setVar('--fx-exposure', base);
      } else if (phase === 'condense') {
        // 「張り」を出す：色収差うっすら、レンズ僅かにマイナス、明るさ微増
        this.setChroma(ctx, lerp(0, read('screen.chroma.condensePx', 1.5), p));
        ctx.setVar('--fx-lens-scale', 1 + lerp(0, read('screen.lens.condense', -0.025), p));
        ctx.setVar('--fx-exposure', lerp(base, read('screen.exposureStill', 0.96), p));
        ctx.setVar('--fx-blur', lerp(read('screen.blurIntroPx', 7), 2, p) + 'px');
      } else if (phase === 'still') {
        // 張り詰めた明るさで静止
        ctx.setVar('--fx-exposure', read('screen.exposureStill', 0.96));
      } else if (phase === 'crack') {
        ctx.setVar('--fx-exposure', read('screen.exposureStill', 0.96));
      } else if (phase === 'shatter') {
        // 白飛び寸前まで一気に跳ね上げ→即戻す（p で山なり）。色収差/レンズも瞬間強める。
        const spike = Math.sin(p * Math.PI); // 0→1→0 の山
        ctx.setVar('--fx-exposure', lerp(read('screen.exposureStill', 0.96), read('screen.exposureFlash', 2.6), spike));
        this.setChroma(ctx, lerp(0, read('screen.chroma.shatterPx', 6), spike));
        ctx.setVar('--fx-lens-scale', 1 + lerp(0, read('screen.lens.shatter', -0.06), spike));
      } else if (phase === 'reveal') {
        // 余韻：明るさ・歪みを戻し、主役を立てる軽いボケに。周辺減光も落ち着かせる。
        this.setChroma(ctx, 0);
        ctx.setVar('--fx-lens-scale', 1 + lerp(read('screen.lens.shatter', -0.06), 0, clamp01(p * 2)));
        ctx.setVar('--fx-exposure', lerp(read('screen.exposureFlash', 2.6), 1, clamp01(p * 2)));
        ctx.setVar('--fx-vignette', lerp(read('screen.vignetteIntro', 0.88), read('screen.vignetteReveal', 0.42), p));
        ctx.setVar('--fx-blur', lerp(2, read('screen.blurRevealPx', 3), p) + 'px');
      }
    },
    dispose(ctx) {
      if (ctx.world) ctx.world.classList.remove('fx-chroma-on');
    },
  }));

  /* --- FX_Particles ｜ 微粒子の中心収束（VFX Graph アトラクタ相当・加算ブレンド） --- */
  registerModule(() => ({
    id: 'FX_Particles',
    init(ctx) {
      const { canvas, g } = makeCanvas(ctx, 'fx-particles');
      ctx.camera.insertBefore(canvas, ctx.camera.firstChild); // 最奥
      this.canvas = canvas;
      this.g = g;
      this.color = read('particles.color', null) || ctx.color;
      const count = read('particles.count', 48);
      this.swirl = read('particles.swirl', 0.6);
      this.additive = read('particles.additive', true);
      // 各粒子：初期角度・距離・サイズ。収束は p で中心へ寄せる（intro=ease-in）。
      this.items = Array.from({ length: count }, () => ({
        ang: rand(0, Math.PI * 2),
        dist: rand(read('particles.spawnRadiusMin', 120), read('particles.spawnRadiusMax', 380)),
        size: rand(read('particles.sizeMin', 1.5), read('particles.sizeMax', 4)),
        seed: Math.random(),
      }));
    },
    onTick(phase, p, gT, dt, ctx) {
      const g = this.g;
      g.clearRect(0, 0, ctx.cw, ctx.ch);
      // 導入で収束、凝縮で中心に集まり消える。それ以降は描かない（破棄前提）。
      let conv;       // 収束率 0(外)→1(中心)
      let alpha;      // 全体の不透明度
      if (phase === 'intro') { conv = p; alpha = lerp(0, 0.9, clamp01(p * 1.4)); }
      else if (phase === 'condense') { conv = lerp(1, 1.05, p); alpha = lerp(0.9, 0, p); }
      else { return; }

      g.globalCompositeOperation = this.additive ? 'lighter' : 'source-over';
      for (const it of this.items) {
        const a = it.ang + this.swirl * conv * (1 + it.seed); // 収束に合わせて少し渦を巻く
        const d = it.dist * (1 - conv);
        const x = ctx.cx + Math.cos(a) * d;
        const y = ctx.cy + Math.sin(a) * d;
        g.globalAlpha = alpha * (0.5 + it.seed * 0.5);
        g.fillStyle = this.color;
        g.beginPath();
        g.arc(x, y, it.size, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    },
    dispose() {
      // Canvas 参照を切ってGCに回す
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = null; this.g = null; this.items = null;
    },
  }));

  /* --- FX_EnergyCore ｜ エネルギー球（発光・脈動・収縮）。色はレア度カラー --- */
  registerModule(() => ({
    id: 'FX_EnergyCore',
    init(ctx) {
      const el = document.createElement('div');
      el.className = 'fx-energy-core';
      const size = read('energyCore.baseSizePx', 170);
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.opacity = '0';
      ctx.world.appendChild(el);
      this.el = el;
      this.size = size;
    },
    apply(scale, opacity, emission) {
      this.el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      this.el.style.opacity = String(opacity);
      // 発光強度は CSS 変数経由（Bloom のにじみ量にも反映）
      this.el.style.setProperty('--fx-core-emission', String(emission));
    },
    onTick(phase, p, gT, dt, ctx) {
      const em = read('energyCore.emission', 1) * (ctx.rarityConfig.emission || 1) * (ctx.rarityConfig.glow || 1);
      const intro = read('energyCore.introScale', 0.04);
      const cond = read('energyCore.condenseScale', 1.0);
      const still = read('energyCore.stillContract', 0.82);
      if (phase === 'intro') {
        this.apply(lerp(intro, intro * 1.4, p), lerp(0, 1, clamp01(p * 1.6)), em * 0.7);
      } else if (phase === 'condense') {
        // 凝縮：大きくなりながら脈動（pulse）。輝度も上昇。
        const pulse = 1 + Math.sin(gT / 1000 * read('energyCore.pulseSpeedHz', 3) * Math.PI * 2) * read('energyCore.pulseAmount', 0.06) * p;
        this.apply(lerp(intro * 1.4, cond, p) * pulse, 1, lerp(em * 0.7, em, p));
      } else if (phase === 'still') {
        // 一瞬きゅっと収縮して静止（谷）
        this.apply(lerp(cond, still, p), 1, em);
      } else if (phase === 'crack') {
        // ヒビ中は静止サイズで強く発光（破裂寸前）
        this.apply(still, 1, em * lerp(1, 1.3, p));
      } else if (phase === 'shatter') {
        // 破砕：一瞬膨張して消える
        this.apply(lerp(still, still * 1.6, p), lerp(1, 0, p), em * 1.5);
      } else if (phase === 'reveal') {
        this.apply(still, 0, em); // 既に消えている
      }
    },
    dispose() {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null;
    },
  }));

  /* --- FX_Crack ｜ ヒビ（SVG ストロークの stroke-dashoffset 成長で「描く」） --- */
  registerModule(() => ({
    id: 'FX_Crack',
    init(ctx) {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'fx-crack');
      svg.setAttribute('width', String(ctx.cw));
      svg.setAttribute('height', String(ctx.ch));
      svg.style.opacity = '0';
      ctx.world.appendChild(svg);
      this.svg = svg;
      this.paths = [];

      const main = read('crack.mainCount', 1);
      const branch = read('crack.branchCount', 8);
      const total = main + branch;
      const jitter = read('crack.jitter', 26);
      // 放射状にヒビを生成（中心から外へ、途中で不規則に折れ曲がる折れ線）
      for (let i = 0; i < total; i++) {
        const isMain = i < main;
        const ang = (i / total) * Math.PI * 2 + rand(-0.3, 0.3);
        const len = rand(read('crack.lengthMin', 150), read('crack.lengthMax', 330)) * (isMain ? 1.1 : 1);
        const segs = 5 + Math.floor(Math.random() * 3);
        let d = `M ${ctx.cx} ${ctx.cy}`;
        for (let s = 1; s <= segs; s++) {
          const r = (len / segs) * s;
          const jx = (Math.random() - 0.5) * jitter;
          const jy = (Math.random() - 0.5) * jitter;
          d += ` L ${ctx.cx + Math.cos(ang) * r + jx} ${ctx.cy + Math.sin(ang) * r + jy}`;
        }
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'var(--fx-color)');
        path.setAttribute('stroke-width', String(read('crack.width', 2)));
        path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);
        const totalLen = path.getTotalLength();
        path.style.strokeDasharray = String(totalLen);
        path.style.strokeDashoffset = String(totalLen); // 最初は隠れている
        // 枝は遅れて出る（branchDelay の割合だけ開始を遅らせる）
        this.paths.push({ path, len: totalLen, start: isMain ? 0 : read('crack.branchDelay', 0.18) });
      }
    },
    onPhaseEnter(phase) {
      if (phase === 'crack' && this.svg) this.svg.style.opacity = '1';
    },
    onTick(phase, p, gT, dt, ctx) {
      if (phase === 'crack') {
        // 各ヒビをそれぞれの開始タイミングから ease-out で伸ばす
        for (const it of this.paths) {
          const local = clamp01((p - it.start) / (1 - it.start));
          it.path.style.strokeDashoffset = String(it.len * (1 - Ease.easeOut(local)));
        }
      } else if (phase === 'reveal') {
        // 余韻でヒビは消す
        if (this.svg) this.svg.style.opacity = String(lerp(1, 0, clamp01(p * 2)));
      }
    },
    dispose() {
      if (this.svg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
      this.svg = null; this.paths = null;
    },
  }));

  /* --- FX_Shards ｜ 破片＋スパーク（Canvas）。放射飛散→重力落下→Dissolve --- */
  registerModule(() => ({
    id: 'FX_Shards',
    init(ctx) {
      const { canvas, g } = makeCanvas(ctx, 'fx-shards');
      ctx.camera.appendChild(canvas); // world より手前（破片が飛んでくる）
      this.canvas = canvas; this.g = g;
      this.shards = []; this.sparks = []; this.spawned = false;
      this.color = ctx.color;
    },
    spawn(ctx) {
      this.spawned = true;
      const sc = read('shatter', {});
      for (let i = 0; i < (sc.shardCount || 38); i++) {
        const ang = rand(0, Math.PI * 2);
        const sp = rand(sc.scatterSpeedMin || 6, sc.scatterSpeedMax || 17);
        this.shards.push({
          x: ctx.cx, y: ctx.cy,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          size: rand(sc.shardSizeMin || 6, sc.shardSizeMax || 19),
          rot: rand(0, Math.PI * 2), vr: rand(-1, 1) * (sc.rotationSpeed || 9) * Math.PI / 180,
        });
      }
      for (let i = 0; i < (sc.sparkCount || 26); i++) {
        const ang = rand(0, Math.PI * 2);
        const sp = rand((sc.scatterSpeedMin || 6) * 1.5, (sc.scatterSpeedMax || 17) * 1.6);
        this.sparks.push({ x: ctx.cx, y: ctx.cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1 });
      }
    },
    onPhaseEnter(phase, ctx) {
      if (phase === 'shatter' && !this.spawned) this.spawn(ctx);
    },
    onTick(phase, p, gT, dt, ctx) {
      if (phase !== 'shatter' && phase !== 'reveal') return;
      const g = this.g;
      g.clearRect(0, 0, ctx.cw, ctx.ch);
      const gravity = read('shatter.gravity', 0.36);
      const dissolveStart = read('shatter.dissolveStart', 0.45);
      // Dissolve（消え）の係数：reveal の dissolveStart 以降で 1→0
      const fade = phase === 'reveal' ? 1 - clamp01((p - dissolveStart) / (1 - dissolveStart)) : 1;

      // 破片
      g.fillStyle = this.color;
      for (const s of this.shards) {
        s.x += s.vx * dt; s.y += s.vy * dt; s.vy += gravity * dt; s.rot += s.vr * dt;
        g.save();
        g.translate(s.x, s.y);
        g.rotate(s.rot);
        g.globalAlpha = fade;
        // 三角形のシャード（ガラス片風）
        g.beginPath();
        g.moveTo(0, -s.size * 0.6);
        g.lineTo(s.size * 0.5, s.size * 0.5);
        g.lineTo(-s.size * 0.5, s.size * 0.4);
        g.closePath();
        g.fill();
        g.restore();
      }
      // スパーク（加算で明るく、短命）
      g.globalCompositeOperation = 'lighter';
      for (const sp of this.sparks) {
        sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vy += gravity * 0.4 * dt; sp.life -= 0.04 * dt;
        if (sp.life <= 0) continue;
        g.globalAlpha = Math.max(0, sp.life) * fade;
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(sp.x, sp.y, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    },
    dispose() {
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = null; this.g = null; this.shards = null; this.sparks = null;
    },
  }));

  /* --- FX_Flash ｜ 閃光（破砕の瞬間の白飛び。1フレーム的に立てて即戻す） --- */
  registerModule(() => ({
    id: 'FX_Flash',
    init(ctx) {
      const tint = read('flash.tint', null);
      if (tint) ctx.flash.style.background = `radial-gradient(circle, ${tint}, #fff 60%)`;
      ctx.flash.style.opacity = '0';
    },
    onTick(phase, p, gT, dt, ctx) {
      if (phase === 'shatter') {
        // 0→peak→0 の山。holdMs はピーク付近の鋭さ（config 上は質感調整用）。
        const peak = read('flash.peak', 0.92);
        ctx.flash.style.opacity = String(Math.sin(clamp01(p) * Math.PI) * peak);
      } else if (phase === 'reveal') {
        ctx.flash.style.opacity = String(lerp(read('flash.peak', 0.92), 0, clamp01(p * 3)));
      }
    },
    dispose(ctx) { if (ctx.flash) ctx.flash.style.opacity = '0'; },
  }));

  /* --- FX_Camera ｜ カメラ（ドリーイン + Impulse シェイク/キック） --- */
  registerModule(() => ({
    id: 'FX_Camera',
    init() { this.shake = 0; },
    apply(ctx, scale, dx, dy, rot) {
      ctx.camera.style.transform = `scale(${scale}) translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    },
    onPhaseEnter(phase) {
      if (phase === 'shatter') this.shake = read('camera.shatterKick', 18); // 破砕で強くキック
    },
    onTick(phase, p, gT, dt, ctx) {
      const decay = read('camera.shakeDecay', 0.88);
      let scale = 1, dx = 0, dy = 0, rot = 0;
      if (phase === 'condense') {
        scale = lerp(1, read('camera.dollyInScale', 1.06), p); // 微ドリーイン
      } else if (phase === 'still' || phase === 'crack') {
        scale = read('camera.dollyInScale', 1.06);
        if (phase === 'crack') { // ヒビ中は極小シェイク
          const amp = read('camera.crackShake', 2);
          dx = (Math.random() - 0.5) * amp; dy = (Math.random() - 0.5) * amp;
        }
      } else if (phase === 'shatter' || phase === 'reveal') {
        scale = lerp(read('camera.dollyInScale', 1.06), 1, phase === 'reveal' ? p : 0);
        // キックは毎フレーム減衰させながらランダムに揺らす
        this.shake *= decay;
        dx = (Math.random() - 0.5) * this.shake;
        dy = (Math.random() - 0.5) * this.shake;
        rot = (Math.random() - 0.5) * read('camera.shatterRotate', 1.2) * (this.shake / Math.max(1, read('camera.shatterKick', 18)));
      }
      this.apply(ctx, scale, dx, dy, rot);
    },
    dispose(ctx) { if (ctx.camera) ctx.camera.style.transform = ''; },
  }));

  /* --- FX_Aura ｜ オーラ（最後に収束して静止する後光）。レア度カラー・サイズ --- */
  registerModule(() => ({
    id: 'FX_Aura',
    init(ctx) {
      const el = document.createElement('div');
      el.className = 'fx-aura';
      const size = read('aura.sizePx', 320) * (ctx.rarityConfig.auraScale || 1);
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.setProperty('--fx-aura-spin', read('aura.spinSec', 14) + 's');
      el.style.opacity = '0';
      ctx.world.appendChild(el);
      this.el = el;
    },
    onTick(phase, p, gT, dt, ctx) {
      if (phase !== 'reveal') return;
      // 大きく広がってから収束（scale 1.3→1.0）、不透明度はゆっくり立ち上げて維持
      const op = read('aura.opacity', 0.8) * (ctx.rarityConfig.glow || 1);
      const scale = lerp(1.3, 1.0, Ease.easeOut(p));
      this.el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      this.el.style.opacity = String(lerp(0, op, clamp01(p * 2)));
    },
    dispose() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); this.el = null; },
  }));

  /* --- FX_ItemReveal ｜ アイテム登場（結果カードを複製して浮上・回転・着地） --- */
  registerModule(() => ({
    id: 'FX_ItemReveal',
    init(ctx) {
      const wrap = document.createElement('div');
      wrap.className = 'fx-item-reveal';
      wrap.style.opacity = '0';
      // 結果カードがあれば複製、無ければ汎用のジェムを表示（どちらも色はレア度カラー）
      if (ctx.sourceCardEl) {
        const clone = ctx.sourceCardEl.cloneNode(true);
        clone.classList.add('fx-clone');
        wrap.appendChild(clone);
        // 登場演出中の複製カードにも「虹色の回転枠」を適用（config.resultFrame.onReveal）
        if (read('resultFrame.onReveal', true)) applyResultFrame(clone);
      } else {
        const gem = document.createElement('div');
        gem.className = 'fx-gem';
        wrap.appendChild(gem);
      }
      ctx.camera.appendChild(wrap); // 最前面（破片の手前）
      this.wrap = wrap;
    },
    onTick(phase, p, gT, dt, ctx) {
      if (phase !== 'reveal') return;
      const appearAt = read('item.appearAt', 0.08);
      const local = clamp01((p - appearAt) / (1 - appearAt));
      const rise = lerp(read('item.riseFromPx', 70), 0, Ease.easeOut(local)); // 下→定位置
      const scale = lerp(read('item.settleScaleFrom', 0.7), read('item.settleScaleTo', 1.0), Ease.easeOut(local));
      const rot = lerp(read('item.rotateDeg', 16), 0, Ease.easeOut(local)); // 回転しながら整う
      this.wrap.style.opacity = String(clamp01(local * 1.6));
      this.wrap.style.transform = `translate(-50%, calc(-50% + ${rise}px)) scale(${scale}) rotate(${rot}deg)`;
    },
    dispose() { if (this.wrap && this.wrap.parentNode) this.wrap.parentNode.removeChild(this.wrap); this.wrap = null; },
  }));

  /* --- FX_Audio ｜ 音（SE/BGM）。source 未設定なら無音（音源を入れるだけで鳴る） --- */
  registerModule(() => ({
    id: 'FX_Audio',
    init(ctx) {
      this.live = [];     // 再生中の SE（破棄時に止める）
      this.bgm = null;
      this.muted = read('audio.masterMuted', false);
      this.seVol = read('audio.seVolume', 0.9);
      this.bgmVol = read('audio.bgmVolume', 0.5);
      this.sources = read('audio.sources', {});
      // BGM（任意）
      this.playBgm();
    },
    playOne(name, vol) {
      if (this.muted || typeof Audio === 'undefined') return;
      const src = this.sources[name];
      if (!src) return; // 無音フォールバック
      try {
        const a = new Audio(src);
        a.volume = vol;
        a.play().catch(() => {});
        this.live.push(a);
      } catch (_) { /* 無音 */ }
    },
    playBgm() {
      if (this.muted || typeof Audio === 'undefined') return;
      const src = this.sources.bgm;
      if (!src) return;
      try {
        const a = new Audio(src);
        a.loop = true; a.volume = this.bgmVol;
        a.play().catch(() => {});
        this.bgm = a;
      } catch (_) { /* 無音 */ }
    },
    onPhaseEnter(phase) {
      // フェーズの頭で SE を鳴らす（無音→破砕音のコントラストが体感品質を決める）
      if (phase === 'intro')   this.playOne('drone', this.seVol);
      if (phase === 'condense')this.playOne('charge', this.seVol);
      if (phase === 'crack')   this.playOne('crack', this.seVol);
      if (phase === 'shatter') {
        // レア度専用の破砕SEがあれば優先（config.rarity[].se）
        const seName = (window.FX_GACHA_CONFIG?.rarity?.[this._rarity]?.se) || 'shatter';
        this.playOne(seName, this.seVol);
      }
      if (phase === 'reveal')  this.playOne('shimmer', this.seVol);
      // ※ still はあえて何も鳴らさない（無音の谷）
    },
    onTick() { /* 音は時間駆動しないので何もしない */ },
    init2(ctx) { this._rarity = ctx.rarity; },
    dispose() {
      // 鳴っている音をすべて停止して参照を切る（メモリリーク防止）
      for (const a of (this.live || [])) { try { a.pause(); } catch (_) {} }
      if (this.bgm) { try { this.bgm.pause(); } catch (_) {} }
      this.live = null; this.bgm = null;
    },
  }));

  /* ===========================================================================
   * 4. オーケストレーター（play）：ステージ構築→タイムライン駆動→破棄
   * ========================================================================= */

  let activeRun = null; // 同時多重再生を防ぐ（1度に1演出）

  /**
   * レア度キーから設定を解決。color は必須なので無ければ既定キーへフォールバック。
   */
  const resolveRarity = (rarityKey) => {
    const table = read('rarity', {});
    let key = rarityKey;
    if (!key || !table[key] || !table[key].color) key = read('rarityDefault', 'rarity-3');
    const cfg = table[key] || { color: '#63e6be' };
    return { key, cfg };
  };

  /** reduced-motion 時の簡易演出（一瞬の発光だけ。アクセシビリティ配慮） */
  const playReduced = (opts, ctx) => {
    ctx.setVar('--fx-vignette', 0.4);
    ctx.flash.style.transition = 'opacity .18s ease';
    ctx.flash.style.background = `radial-gradient(circle, ${ctx.color}, #fff 70%)`;
    requestAnimationFrame(() => { ctx.flash.style.opacity = '0.7'; });
    window.setTimeout(() => { ctx.flash.style.opacity = '0'; }, 200);
    window.setTimeout(() => finishRun(ctx, opts), 520);
  };

  /**
   * 演出を再生する公開API。
   * @param {Object} opts
   * @param {string} opts.rarity        レア度キー（config.rarity のキー）
   * @param {Element} [opts.sourceCardEl] 登場演出で複製する結果カード
   * @param {Function} [opts.onComplete]  破棄完了後コールバック（結果表示の解除に使う）
   */
  const play = (opts = {}) => {
    // 既に再生中なら、その演出を即終了してから新規開始（多重防止）
    if (activeRun) { try { finishRun(activeRun, activeRun.opts, true); } catch (_) {} }

    const { key, cfg } = resolveRarity(opts.rarity);

    // 実行コンテキスト（モジュール間で共有する“最低限”の参照）
    const ctx = {
      opts,
      rarity: key,
      rarityConfig: cfg,
      color: cfg.color,
      sourceCardEl: opts.sourceCardEl || null, // 登場演出で複製する結果カード（無ければ汎用ジェム）
      item: opts.item || null,                 // 任意のアイテム情報（拡張モジュール用）
      modules: [],
      // モジュールが CSS 変数を書くためのヘルパ
      setVar: (name, val) => { if (ctx.stage) ctx.stage.style.setProperty(name, String(val)); },
      // 拡張モジュールが「自分は起動対象か」を判定するためのヘルパ
      isModuleEnabled: (id) => Array.isArray(cfg.modules) && cfg.modules.includes(id),
    };
    activeRun = ctx;
    ctx.opts = opts;

    // ステージ構築 ＋ レア度カラー等を CSS 変数へ（演出本体は共通、色だけ差し替え）
    buildStage(ctx);
    ctx.setVar('--fx-color', cfg.color);
    ctx.setVar('--fx-emission', cfg.emission || 1);
    ctx.setVar('--fx-glow', cfg.glow || 1);
    ctx.stage.classList.add('fx-rarity', `fx-${key}`);

    // reduced-motion なら簡易演出で終了
    if (read('general.respectReducedMotion', true)
        && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      playReduced(opts, ctx);
      return ctx;
    }

    // モジュールを実体化（optional は当該レア度の modules に入っている時だけ採用）
    for (const factory of moduleFactories) {
      let mod;
      try { mod = factory(); } catch (e) { continue; }
      if (!mod || !mod.id) continue;
      if (mod.optional && !ctx.isModuleEnabled(mod.id)) continue; // 追加演出のゲート
      ctx.modules.push(mod);
    }
    // 初期化（FX_Audio は rarity を知る必要があるので init2 も呼ぶ）
    for (const mod of ctx.modules) {
      try { mod._rarity = key; if (mod.init) mod.init(ctx); if (mod.init2) mod.init2(ctx); } catch (e) { console.warn('[FXGacha init]', mod.id, e); }
    }

    // タイムライン（各フェーズの長さは config から。ここで“尺”が決まる）
    const T = read('timeline', {});
    const phases = [
      { name: 'intro',    dur: T.introMs    ?? 1500 },
      { name: 'condense', dur: T.condenseMs ?? 1000 },
      { name: 'still',    dur: T.stillMs    ?? 300 },
      { name: 'crack',    dur: T.crackMs    ?? 700 },
      { name: 'shatter',  dur: T.shatterMs  ?? 200 },
      { name: 'reveal',   dur: T.revealMs   ?? 1300 },
    ];
    const captions = { // 字幕（任意）。空にしたい場合は general.showCaption=false
      intro: '次元の奥で、なにかが目を覚ます',
      condense: 'エネルギーが一点に集まる…',
      still: '',
      crack: 'ピシ…ッ',
      shatter: '',
      reveal: '',
    };
    let total = phases.reduce((s, p) => s + p.dur, 0);
    ctx.total = total;
    ctx.phases = phases;

    // スキップ操作（任意）
    if (read('general.allowSkip', true)) {
      const onSkip = () => finishRun(ctx, opts);
      ctx.stage.addEventListener('click', onSkip);
      ctx._onSkip = onSkip;
    }

    // 保険：autoDisposeMs で強制終了（rAFが死んでも必ず片付く）
    ctx._safety = window.setTimeout(() => finishRun(ctx, opts), read('general.autoDisposeMs', 9000));

    // rAF ループ（タイムライン本体）
    let startTs = 0, lastTs = 0, phaseIndex = -1;

    const enterPhase = (idx) => {
      const ph = phases[idx];
      for (const mod of ctx.modules) { try { mod.onPhaseEnter && mod.onPhaseEnter(ph.name, ctx); } catch (e) {} }
      if (ctx.caption) ctx.caption.textContent = captions[ph.name] || '';
    };
    const exitPhase = (idx) => {
      const ph = phases[idx];
      for (const mod of ctx.modules) { try { mod.onPhaseExit && mod.onPhaseExit(ph.name, ctx); } catch (e) {} }
    };

    const loop = (ts) => {
      if (!startTs) { startTs = ts; lastTs = ts; }
      const elapsed = ts - startTs;
      const dt = Math.min(3, (ts - lastTs) / 16.6667); // フレーム正規化(1=60fps相当)。タブ復帰の暴れを抑制
      lastTs = ts;

      // 現在フェーズの特定（経過時間から累積で求める）
      let acc = 0, targetIndex = phases.length - 1, phaseStart = 0;
      for (let i = 0; i < phases.length; i++) {
        if (elapsed < acc + phases[i].dur) { targetIndex = i; phaseStart = acc; break; }
        acc += phases[i].dur;
        phaseStart = acc;
      }

      // フェーズ遷移（飛び越しても順に enter/exit を発火させる＝状態の取りこぼし防止）
      while (phaseIndex < targetIndex) {
        if (phaseIndex >= 0) exitPhase(phaseIndex);
        phaseIndex++;
        enterPhase(phaseIndex);
      }

      // フェーズ内ローカル進行（生）→ フェーズ既定イージング適用
      const ph = phases[targetIndex];
      const rawLocal = clamp01((elapsed - phaseStart) / Math.max(1, ph.dur));
      const eased = Ease[PHASE_EASE[ph.name] || 'linear'](rawLocal);

      // 全モジュールに毎フレーム通知
      for (const mod of ctx.modules) {
        try { mod.onTick && mod.onTick(ph.name, eased, elapsed, dt, ctx); } catch (e) {}
      }

      if (elapsed >= total) { finishRun(ctx, opts); return; }
      ctx._raf = requestAnimationFrame(loop);
    };
    ctx._raf = requestAnimationFrame(loop);

    return ctx;
  };

  /**
   * 演出の終了・破棄（rAF/タイマー/DOM/Canvas/Audio をすべて片付ける）。
   * 二重呼び出し安全。フェードアウトしてから dispose し、最後に onComplete。
   * @param {boolean} [immediate] true なら即時破棄（多重再生の切替時など）
   */
  const finishRun = (ctx, opts, immediate) => {
    if (!ctx || ctx._done) return;
    ctx._done = true;

    // タイマー・rAF 停止
    if (ctx._raf) cancelAnimationFrame(ctx._raf);
    if (ctx._safety) clearTimeout(ctx._safety);
    if (ctx._onSkip && ctx.stage) ctx.stage.removeEventListener('click', ctx._onSkip);

    const teardown = () => {
      // 各モジュールの後始末（1つ失敗しても他を止めない）
      for (const mod of (ctx.modules || [])) {
        try { mod.dispose && mod.dispose(ctx); } catch (e) { console.warn('[FXGacha dispose]', mod.id, e); }
      }
      // ステージ DOM を除去
      if (ctx.stage && ctx.stage.parentNode) ctx.stage.parentNode.removeChild(ctx.stage);
      // 参照を切ってGCに回す
      ctx.modules = null; ctx.stage = ctx.camera = ctx.world = ctx.vignette = ctx.flash = null;
      if (activeRun === ctx) activeRun = null;
      // 結果表示の解除など（呼び出し側のコールバック）
      if (typeof opts?.onComplete === 'function') { try { opts.onComplete(); } catch (e) {} }
    };

    if (immediate) { teardown(); return; }
    // 軽くフェードアウトしてから片付け（結果カードへ自然につなぐ）
    if (ctx.stage) ctx.stage.classList.add('fx-out');
    window.setTimeout(teardown, 200);
  };

  /* ===========================================================================
   * 5. 排出カードの「虹色の回転枠」適用ヘルパ（演出本体とは独立／追加機能）
   * ---------------------------------------------------------------------------
   *   結果カードや登場演出の複製カードに .fx-rainbow-frame を付けるだけ。
   *   見た目は fx-gacha.css、数値は config.resultFrame に集約。
   * ========================================================================= */

  /** カード種別（weapon/armor/deco）を class から判定 */
  const cardKind = (card) =>
    card.classList.contains('gacha-card--weapon') ? 'weapon' :
    card.classList.contains('gacha-card--armor')  ? 'armor'  :
    card.classList.contains('gacha-card--deco')   ? 'deco'   : 'other';

  /** 1枚のカードへ虹枠を適用（config の対象種別/レア度ゲートを尊重） */
  const applyResultFrame = (card, cfg) => {
    if (!card) return;
    cfg = cfg || read('resultFrame', {});
    if (cfg.enabled === false) return;
    // 対象種別ゲート（'all' か配列）
    const applyTo = cfg.applyTo;
    if (Array.isArray(applyTo) && applyTo.length && !applyTo.includes(cardKind(card))) return;
    // 対象レア度ゲート（'all' か配列）
    const rarities = cfg.rarities;
    if (Array.isArray(rarities) && rarities.length && !rarities.some((r) => card.classList.contains(r))) return;

    card.classList.add('fx-rainbow-frame');
    if (cfg.loop === false) card.classList.add('fx-rainbow-frame--once');
    // 数値は CSS 変数で流し込む（config の値そのまま）
    card.style.setProperty('--fx-frame-dur', (cfg.durationSec ?? 2.4) + 's');
    card.style.setProperty('--fx-frame-thickness', (cfg.thicknessPx ?? 3) + 'px');
    card.style.setProperty('--fx-frame-glow', (cfg.glowPx ?? 8) + 'px');
  };

  /** 結果エリア内の全カードへ虹枠を適用（app.js が結果表示時に呼ぶ） */
  const decorateResults = (areaEl) => {
    const cfg = read('resultFrame', {});
    if (!areaEl || cfg.enabled === false) return;
    areaEl.querySelectorAll('.gacha-card').forEach((card) => applyResultFrame(card, cfg));
  };

  /* ===========================================================================
   * 6. 公開API（window.FXGacha）
   * ========================================================================= */
  window.FXGacha = {
    play,                         // 演出再生
    register: registerModule,     // 新モジュール追加（拡張ポイント）
    skip: () => { if (activeRun) finishRun(activeRun, activeRun.opts); }, // 手動スキップ
    decorateResults,              // 結果エリアのカードに虹枠を適用
    applyResultFrame,             // 単体カードに虹枠を適用（任意）
    get config() { return window.FX_GACHA_CONFIG; }, // 設定への参照（デバッグ用）
    _utils: { lerp, clamp01, Ease, read, rand }, // 拡張モジュールから使える小道具
  };
})();
