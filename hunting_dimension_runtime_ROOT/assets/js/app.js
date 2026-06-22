(() => {
  'use strict';

  /**
   * 狩猟次元 管理ツール app.js
   *
   * 目的:
   * - 既存の JSON 設計に対応
   * - localStorage にセーブ/ロード
   * - コイン / ガチャ / 進化 / 強化 / イベント / モンスター抽選 / 傀異錬成を実装
   *
   * 対応ファイル:
   * - rules.json
   * - settings.json
   * - gacha.json
   * - weapons.json
   * - armor.json
   * - decorations.json
   * - events.json
   * - monsters.json
   * - inventory.json
   */

  const STORAGE_KEY = 'hunting-dimension-save-v2';

  // fetch 対象の JSON 一覧
  const JSON_PATHS = {
    rules: 'rules.json',
    settings: 'settings.json',
    gacha: 'gacha.json',
    weapons: 'weapons.json',
    armor: 'armor.json',
    decorations: 'decorations.json',
    events: 'events.json',
    monsters: 'monsters.json',
    inventory: 'inventory.json'
  };

  // file:// 直開き時のフォールバック用埋め込みデータ
  // index.html で assets/js/data.js を app.js より先に読み込むことで利用できる。
  const EMBEDDED_JSONS = (window && window.__HD_EMBEDDED_JSONS__ && typeof window.__HD_EMBEDDED_JSONS__ === 'object')
    ? window.__HD_EMBEDDED_JSONS__
    : {};

  // ランタイムで使う状態
  const state = {
    data: {
      rules: [],
      settings: {},
      gacha: {},
      weapons: [],
      armor: [],
      decorations: [],
      events: [],
      monsters: [],
      inventoryTemplate: {}
    },
    inventory: {},
    meta: {
      // 防具の強化レベル管理。inventory.armors は ID 配列のまま維持し、
      // レベルは別管理にして JSON 設計を壊さない。
      armorLevels: {},
      // 任意でメモ的に残すログ
      coinHistory: [],
      gachaHistory: [],
      miscHistory: [],
      // 最後に表示した抽選結果
      latestEvent: null,
      latestMonster: null,
      // 参照用エラー
      loadErrors: []
    }
  };

  /** DOM 取得ショートハンド */
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  /**
   * 文字列が空かを安全に判定
   */
  const isBlank = (value) => value == null || String(value).trim() === '';

  /**
   * 配列でなければ空配列を返す
   */
  const safeArray = (value) => Array.isArray(value) ? value : [];

  /**
   * オブジェクトでなければ空オブジェクトを返す
   */
  const safeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  /**
   * 埋め込み JSON を安全に取得（参照汚染を避けるため clone して返す）
   */
  const getEmbeddedJson = (key) => {
    const payload = EMBEDDED_JSONS?.[key];
    if (payload == null) return null;
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch (error) {
      console.warn(`[埋め込みJSON複製失敗] ${key}:`, error);
      return payload;
    }
  };

  /**
   * JSON 読込失敗も含めてアプリ全体が落ちないようにする安全 fetch
   *
   * 対応方針:
   * - http(s) では通常どおり fetch する
   * - file:// 直開きでは fetch が失敗しやすいため、埋め込み data.js を優先する
   * - fetch 失敗時も、埋め込みデータがあればフォールバックする
   */
  const fetchJsonSafe = async (key, path) => {
    const embedded = getEmbeddedJson(key);
    const isFileProtocol = window.location.protocol === 'file:';

    if (isFileProtocol && embedded) {
      console.info(`[JSON読込] ${key}: file:// のため埋め込みデータを使用`);
      return embedded;
    }

    try {
      if (typeof fetch !== 'function') {
        throw new Error('fetch is not available in this environment');
      }

      const resolvedPath = new URL(path, window.location.href).href;
      const res = await fetch(resolvedPath, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`${resolvedPath} ${res.status}`);
      }
      return await res.json();
    } catch (error) {
      if (embedded) {
        console.warn(`[JSON読込フォールバック] ${key}: fetch に失敗したため埋め込みデータを使用`, error);
        return embedded;
      }

      console.error(`[JSON読込失敗] ${key}:`, error);
      state.meta.loadErrors.push(`${key}: JSON読込失敗`);
      return null;
    }
  };

  /**
   * ログを先頭追加。件数は増えすぎないように制限する。
   */
  const pushLog = (target, message) => {
    const text = `[${new Date().toLocaleString('ja-JP')}] ${message}`;
    state.meta[target].unshift(text);
    state.meta[target] = state.meta[target].slice(0, 100);
  };

  /**
   * インベントリの初期値を deep clone で取得
   */
  const clone = (value) => JSON.parse(JSON.stringify(value));

  /**
   * 初期 inventory.json を元に、必要な欠損キーを補完する
   */
  const normalizeInventory = (rawInventory) => {
    const inventory = safeObject(rawInventory);

    return {
      coins: Number.isFinite(Number(inventory.coins)) ? Number(inventory.coins) : 0,
      weaponTickets: {
        bronze: Number(inventory?.weaponTickets?.bronze ?? 0),
        silver: Number(inventory?.weaponTickets?.silver ?? 0),
        gold: Number(inventory?.weaponTickets?.gold ?? 0)
      },
      armorTickets: {
        bronze: Number(inventory?.armorTickets?.bronze ?? 0),
        silver: Number(inventory?.armorTickets?.silver ?? 0),
        gold: Number(inventory?.armorTickets?.gold ?? 0)
      },
      decorationTickets: Number(inventory.decorationTickets ?? 0),
      eventTickets: Number(inventory.eventTickets ?? 0),
      qurioTickets: Number(inventory.qurioTickets ?? 0),
      weapons: safeArray(inventory.weapons),
      armors: safeArray(inventory.armors),
      decorations: safeArray(inventory.decorations),
      charms: safeArray(inventory.charms),
      monsterHistory: safeArray(inventory.monsterHistory),
      eventHistory: safeArray(inventory.eventHistory)
    };
  };

  /**
   * localStorage 保存データを読み込み
   */
  const loadLocalSave = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      console.error('セーブデータ読込失敗:', error);
      pushLog('miscHistory', 'セーブデータ読込に失敗したため初期状態で開始');
      return null;
    }
  };

  /**
   * localStorage 保存
   */
  const saveLocal = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        inventory: state.inventory,
        meta: state.meta
      }));
      pushLog('miscHistory', 'セーブしました');
      renderAll();
    } catch (error) {
      console.error('セーブ失敗:', error);
      alert('セーブに失敗しました。ブラウザの保存容量を確認してください。');
    }
  };

  /**
   * 初期化
   */
  const resetLocal = () => {
    const ok = window.confirm('セーブデータを初期化します。よろしいですか？');
    if (!ok) return;

    localStorage.removeItem(STORAGE_KEY);
    state.inventory = normalizeInventory(state.data.inventoryTemplate);
    state.meta = {
      armorLevels: {},
      coinHistory: [],
      gachaHistory: [],
      miscHistory: [],
      latestEvent: null,
      latestMonster: null,
      loadErrors: state.meta.loadErrors || []
    };
    pushLog('miscHistory', 'セーブデータを初期化しました');
    renderAll();
  };

  /**
   * JSON データ全体を正規化して state.data に格納
   */
  const normalizeLoadedData = (payloads) => {
    state.data.rules = safeArray(payloads.rules?.rules);
    state.data.settings = safeObject(payloads.settings?.settings);
    state.data.gacha = safeObject(payloads.gacha);
    state.data.weapons = safeArray(payloads.weapons?.weapons).map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? '未設定',
      tree_id: item?.tree_id ?? 'unknown',
      stage: Number(item?.stage ?? 1),
      gacha: Boolean(item?.gacha),
      is_final: Boolean(item?.is_final),
      next_weapon: item?.next_weapon ?? null,
      rarity: item?.rarity ?? null
    }));
    state.data.armor = safeArray(payloads.armor?.armor).map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? '未設定',
      set: item?.set ?? '未設定',
      part: item?.part ?? '未設定',
      rarity: item?.rarity ?? null,
      gacha: item?.gacha !== false
    }));
    state.data.decorations = safeArray(payloads.decorations?.decorations).map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? '未設定',
      skill: item?.skill ?? '未設定',
      slot_size: Number(item?.slot_size ?? 1),
      gacha: item?.gacha !== false
    }));
    state.data.events = safeArray(payloads.events?.events).map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? '未設定',
      description: item?.description ?? '未設定',
      category: item?.category ?? '未設定',
      effect_type: item?.effect_type ?? null,
      effect_value: item?.effect_value ?? null,
      rarity: item?.rarity ?? 'common',
      usable: item?.usable !== false
    }));
    state.data.monsters = safeArray(payloads.monsters?.monsters).map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? '未設定',
      star: Number(item?.star ?? 0),
      dimension: Number(item?.dimension ?? 0)
    }));
    state.data.inventoryTemplate = normalizeInventory(payloads.inventory?.inventory ?? {});
  };

  /**
   * ルール JSON からガイド用にそれっぽく再利用
   */
  const getGuideCardsFromRules = () => {
    return safeArray(state.data.rules).map((rule) => ({
      title: rule?.title ?? '未設定',
      body: rule?.content ?? '未設定'
    }));
  };

  /**
   * 連想配列化ヘルパ
   */
  const indexById = (items) => {
    const map = new Map();
    safeArray(items).forEach((item) => {
      if (item?.id) map.set(item.id, item);
    });
    return map;
  };

  /**
   * 武器 / 防具 / 装飾品 / モンスターの索引
   */
  const getIndexes = () => ({
    weapons: indexById(state.data.weapons),
    armors: indexById(state.data.armor),
    decorations: indexById(state.data.decorations),
    monsters: indexById(state.data.monsters),
    events: indexById(state.data.events)
  });

  /**
   * 重み付き抽選
   * rates = { key: number }
   */
  const weightedPick = (rates = {}) => {
    const entries = Object.entries(safeObject(rates)).filter(([, value]) => Number(value) > 0);
    if (!entries.length) return null;

    const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
    if (total <= 0) return null;

    let roll = Math.random() * total;
    for (const [key, value] of entries) {
      roll -= Number(value);
      if (roll < 0) return key;
    }
    return entries[entries.length - 1][0];
  };

  /**
   * UI のガチャランク表記を JSON のキー表記へ正規化
   */
  const normalizeGachaTier = (value) => {
    const raw = String(value ?? '').trim().toLowerCase();
    const mapping = {
      bronze: 'bronze',
      silver: 'silver',
      gold: 'gold',
      'ブロンズ': 'bronze',
      'シルバー': 'silver',
      'ゴールド': 'gold'
    };
    return mapping[raw] ?? raw;
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const formatMultilineText = (value) => escapeHtml(value).replace(/\n/g, '<br>');

  const clampArmorLevel = (value) => Math.max(0, Math.min(37, Number(value) || 0));

  const applyArmorLevelGain = (armorId, amount = 1) => {
    const current = clampArmorLevel(state.meta.armorLevels[armorId] ?? 0);
    const next = clampArmorLevel(current + Number(amount || 0));
    state.meta.armorLevels[armorId] = next;
    return next;
  };

  const countById = (items) => {
    const map = new Map();
    safeArray(items).forEach((id) => {
      map.set(id, Number(map.get(id) ?? 0) + 1);
    });
    return map;
  };

  const showSelectionModal = ({ title, description = '', items = [], getTitle, getSubtitle }) => new Promise((resolve) => {
    const existing = document.querySelector('.selection-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'selection-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'selection-modal';
    modal.innerHTML = `
      <div class="selection-modal-header">
        <h3>${escapeHtml(title)}</h3>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
      <input type="search" class="selection-modal-search" placeholder="検索">
      <div class="selection-modal-list"></div>
      <div class="selection-modal-actions">
        <button type="button" class="ghost-button">キャンセル</button>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const searchInput = modal.querySelector('.selection-modal-search');
    const list = modal.querySelector('.selection-modal-list');
    const cancelButton = modal.querySelector('.ghost-button');

    const close = (value) => {
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKeyDown);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    cancelButton.addEventListener('click', () => close(null));

    const render = () => {
      const keyword = String(searchInput.value ?? '').trim().toLowerCase();
      const filtered = items.filter((item) => {
        const titleText = String(getTitle(item) ?? '').toLowerCase();
        const subtitleText = String(getSubtitle?.(item) ?? '').toLowerCase();
        return !keyword || `${titleText} ${subtitleText}`.includes(keyword);
      });

      list.innerHTML = filtered.length
        ? filtered.map((item, index) => `
            <button type="button" class="selection-option" data-index="${index}">
              <strong>${escapeHtml(getTitle(item) ?? '')}</strong>
              <small>${escapeHtml(getSubtitle?.(item) ?? '')}</small>
            </button>
          `).join('')
        : '<p class="muted">該当する候補がありません。</p>';

      Array.from(list.querySelectorAll('.selection-option')).forEach((button) => {
        button.addEventListener('click', () => {
          const selected = filtered[Number(button.dataset.index)];
          close(selected ?? null);
        });
      });
    };

    searchInput.addEventListener('input', render);
    render();
    searchInput.focus();
  });

  /**
   * 配列からランダム 1 件取得
   */
  const randomPick = (items) => {
    const array = safeArray(items);
    if (!array.length) return null;
    return array[Math.floor(Math.random() * array.length)];
  };

  /**
   * 配列から重複なしで n 件取得
   */
  const randomPickMany = (items, count) => {
    const array = [...safeArray(items)];
    const result = [];
    const max = Math.min(count, array.length);

    while (result.length < max && array.length) {
      const index = Math.floor(Math.random() * array.length);
      result.push(array.splice(index, 1)[0]);
    }
    return result;
  };

  /**
   * コイン増減
   */
  const addCoins = (amount, note = 'コイン加算') => {
    const value = Number(amount);
    if (!Number.isFinite(value)) return false;
    state.inventory.coins += value;
    pushLog('coinHistory', `${note}: ${value >= 0 ? '+' : ''}${value}コイン`);
    return true;
  };

  const spendCoins = (amount, note = 'コイン消費') => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return false;
    if (state.inventory.coins < value) return false;
    state.inventory.coins -= value;
    pushLog('coinHistory', `${note}: -${value}コイン`);
    return true;
  };

  /**
   * 所持配列への追加
   */
  const addWeaponToInventory = (weaponId) => {
    if (!weaponId) return false;
    state.inventory.weapons.push(weaponId);
    return true;
  };

  const addArmorToInventory = (armorId) => {
    if (!armorId) return false;

    if (state.inventory.armors.includes(armorId)) {
      const level = applyArmorLevelGain(armorId, 10);
      pushLog('miscHistory', `同じ防具を取得したため強化: ${armorId} Lv+10 → Lv+${level}`);
      return true;
    }

    state.inventory.armors.push(armorId);
    state.meta.armorLevels[armorId] = clampArmorLevel(state.meta.armorLevels[armorId] ?? 0);
    return true;
  };

  const addDecorationToInventory = (decoId) => {
    if (!decoId) return false;
    state.inventory.decorations.push(decoId);
    return true;
  };

  /**
   * 武器の所持数カウント
   */
  const countWeaponCopies = (weaponId) => state.inventory.weapons.filter((id) => id === weaponId).length;

  /**
   * 配列から最初の一致を n 個削除
   */
  const removeCopies = (array, target, count) => {
    let remain = count;
    return array.filter((item) => {
      if (item === target && remain > 0) {
        remain -= 1;
        return false;
      }
      return true;
    });
  };

  /**
   * 武器進化
   */
  const evolveWeapon = ({ weaponId, useCoins = false }) => {
    const weaponIndex = getIndexes().weapons;
    const weapon = weaponIndex.get(weaponId);

    if (!weapon) {
      alert('進化対象の武器データが見つかりません。');
      return;
    }
    if (!weapon.next_weapon || weapon.is_final) {
      alert('この武器は最終段階のため進化できません。');
      return;
    }

    const nextWeapon = weaponIndex.get(weapon.next_weapon);
    if (!nextWeapon) {
      alert('進化先データが見つかりません。');
      return;
    }

    if (useCoins) {
      const coinCost = Number(state.data.settings?.upgrade?.weapon?.coin_cost ?? 200);
      if (!state.inventory.weapons.includes(weaponId)) {
        alert('進化元武器を所持していません。');
        return;
      }
      if (!spendCoins(coinCost, `${weapon.name} をコイン進化`)) {
        alert('コインが足りません。');
        return;
      }
      const idx = state.inventory.weapons.indexOf(weaponId);
      if (idx >= 0) state.inventory.weapons.splice(idx, 1, nextWeapon.id);
      pushLog('miscHistory', `武器進化: ${weapon.name} → ${nextWeapon.name}（${coinCost}コイン）`);
      showEvolutionEffect(weapon.name, nextWeapon.name); // 進化演出（表示のみ）
      renderAll();
      return;
    }

    const duplicateRequired = Number(state.data.settings?.upgrade?.weapon?.duplicate_required ?? 2);
    const copies = countWeaponCopies(weaponId);
    if (copies < duplicateRequired) {
      alert(`同名武器が ${duplicateRequired} 本必要です。現在: ${copies} 本`);
      return;
    }

    state.inventory.weapons = removeCopies(state.inventory.weapons, weaponId, duplicateRequired);
    state.inventory.weapons.push(nextWeapon.id);
    pushLog('miscHistory', `武器進化: ${weapon.name} → ${nextWeapon.name}（重複消費）`);
    showEvolutionEffect(weapon.name, nextWeapon.name); // 進化演出（表示のみ）
    renderAll();
  };

  /**
   * 防具コイン強化
   */
  const upgradeArmorByCoins = (armorId) => {
    const armorIndex = getIndexes().armors;
    const armor = armorIndex.get(armorId);
    if (!armor) {
      alert('防具データが見つかりません。');
      return;
    }
    if (!state.inventory.armors.includes(armorId)) {
      alert('対象防具を所持していません。');
      return;
    }

    const currentLevel = clampArmorLevel(state.meta.armorLevels[armorId] ?? 0);
    if (currentLevel >= 37) {
      alert('防具強化レベルは上限の37です。');
      return;
    }

    const cost = Number(state.data.settings?.upgrade?.armor?.coin_cost ?? 20);
    if (!spendCoins(cost, `${armor.name} を防具強化`)) {
      alert('コインが足りません。');
      return;
    }

    const nextLevel = applyArmorLevelGain(armorId, 1);
    pushLog('miscHistory', `防具強化: ${armor.name} Lv+${currentLevel} → Lv+${nextLevel}（${cost}コイン）`);
    renderAll();
  };

  /**
   * 武器ガチャ
   */
  const drawWeaponGacha = (tier, drawCount = 1, paymentMode = 'ticket') => {
    const tierData = state.data.gacha?.weapon?.[tier];
    const weaponPool = state.data.weapons.filter((weapon) => weapon.gacha === true);

    if (!tierData || !weaponPool.length) {
      alert('武器ガチャデータが未設定です。');
      return;
    }

    const results = [];

    // 演出表示用の「入手方法」ラベル（抽選結果には影響しない）
    const tierLabelMap = { bronze: 'ブロンズ', silver: 'シルバー', gold: 'ゴールド' };
    const methodLabel = `${tierLabelMap[tier] ?? tier}武器ガチャ（${paymentMode === 'ticket' ? 'イベント' : 'コイン'}）`;

    for (let i = 0; i < drawCount; i += 1) {
      const ticketKey = tier;
      const ticketCount = Number(state.inventory.weaponTickets?.[ticketKey] ?? 0);
      const cost = Number(tierData.cost ?? 0);

      if (paymentMode === 'ticket') {
        if (ticketCount <= 0) {
          alert(`イベント効果用の ${tier} 武器チケットが不足しています。`);
          break;
        }
        state.inventory.weaponTickets[ticketKey] -= 1;
      } else if (!spendCoins(cost, `武器${tier}ガチャ`)) {
        alert(`コイン不足のため ${i + 1} 回目で停止しました。`);
        break;
      }

      const rarity = weightedPick(tierData.rates);
      const candidates = weaponPool.filter((weapon) => weapon.rarity === rarity);
      const chosen = randomPick(candidates);

      if (!chosen) {
        pushLog('miscHistory', `武器ガチャ失敗: rarity=${rarity} の候補なし`);
        continue;
      }

      // 追加前に初入手かどうかを判定（NEW表示用。インベントリ操作は従来どおり）
      const isNew = !state.inventory.weapons.includes(chosen.id);
      addWeaponToInventory(chosen.id);
      results.push({ ...chosen, __isNew: isNew, __method: methodLabel });
      pushLog('gachaHistory', `武器${tier}ガチャ[${paymentMode === 'ticket' ? 'イベント' : 'コイン'}]: ${chosen.name} (${chosen.rarity ?? '未設定'})`);
    }

    renderWeaponResults(results);
    renderAll();
  };

  /**
   * 防具ガチャ
   */
  const drawArmorGacha = (tier, drawCount = 1, paymentMode = 'ticket') => {
    const tierData = state.data.gacha?.armor?.[tier];
    const armorPool = state.data.armor.filter((armor) => armor.gacha === true);

    if (!tierData || !armorPool.length) {
      alert('防具ガチャデータが未設定です。');
      return;
    }

    const results = [];

    // 演出表示用の「入手方法」ラベル（抽選結果には影響しない）
    const tierLabelMap = { bronze: 'ブロンズ', silver: 'シルバー', gold: 'ゴールド' };
    const methodLabel = `${tierLabelMap[tier] ?? tier}防具ガチャ（${paymentMode === 'ticket' ? 'イベント' : 'コイン'}）`;

    for (let i = 0; i < drawCount; i += 1) {
      const ticketKey = tier;
      const ticketCount = Number(state.inventory.armorTickets?.[ticketKey] ?? 0);
      const cost = Number(tierData.cost ?? 0);

      if (paymentMode === 'ticket') {
        if (ticketCount <= 0) {
          alert(`イベント効果用の ${tier} 防具チケットが不足しています。`);
          break;
        }
        state.inventory.armorTickets[ticketKey] -= 1;
      } else if (!spendCoins(cost, `防具${tier}ガチャ`)) {
        alert(`コイン不足のため ${i + 1} 回目で停止しました。`);
        break;
      }

      const rarity = weightedPick(tierData.rates);
      const candidates = armorPool.filter((armor) => armor.rarity === rarity);
      const chosen = randomPick(candidates);

      if (!chosen) {
        pushLog('miscHistory', `防具ガチャ失敗: rarity=${rarity} の候補なし`);
        continue;
      }

      // 追加前に初入手かどうかを判定（NEW表示用。インベントリ操作は従来どおり）
      const isNew = !state.inventory.armors.includes(chosen.id);
      addArmorToInventory(chosen.id);
      results.push({ ...chosen, __isNew: isNew, __method: methodLabel });
      pushLog('gachaHistory', `防具${tier}ガチャ[${paymentMode === 'ticket' ? 'イベント' : 'コイン'}]: ${chosen.name} [${chosen.part}] (${chosen.rarity ?? '未設定'})`);
    }

    renderArmorResults(results);
    renderAll();
  };

  /**
   * 装飾品ガチャ
   */
  const drawDecorationGacha = (drawCount = 1, paymentMode = 'ticket') => {
    const tierData = safeObject(state.data.gacha?.decoration);
    const candidates = state.data.decorations.filter((item) => item.gacha === true);

    if (!candidates.length) {
      alert('装飾品データが未設定です。');
      return;
    }

    const cost = tierData.cost == null ? 50 : Number(tierData.cost);
    const results = [];

    // 演出表示用の「入手方法」ラベル（抽選結果には影響しない）
    const methodLabel = `装飾品ガチャ（${paymentMode === 'ticket' ? 'イベント' : 'コイン'}）`;

    for (let i = 0; i < drawCount; i += 1) {
      if (paymentMode === 'ticket') {
        if (state.inventory.decorationTickets <= 0) {
          alert('イベント効果用の装飾品チケットが不足しています。');
          break;
        }
        state.inventory.decorationTickets -= 1;
      } else if (cost > 0 && !spendCoins(cost, '装飾品ガチャ')) {
        alert(`コイン不足のため ${i + 1} 回目で停止しました。`);
        break;
      }

      let chosen = null;
      const rates = safeObject(tierData.rates);
      if (Object.keys(rates).length > 0) {
        const pickedKey = weightedPick(rates);
        chosen = candidates.find((item) => item.id === pickedKey || item.name === pickedKey) || null;
      }
      if (!chosen) chosen = randomPick(candidates);
      if (!chosen) continue;

      // 追加前に初入手かどうかを判定（NEW表示用。インベントリ操作は従来どおり）
      const isNew = !state.inventory.decorations.includes(chosen.id);
      addDecorationToInventory(chosen.id);
      results.push({ ...chosen, __isNew: isNew, __method: methodLabel });
      pushLog('gachaHistory', `装飾品ガチャ[${paymentMode === 'ticket' ? 'イベント' : 'コイン'}]: ${chosen.name}`);
    }

    renderDecorationResults(results);
    renderAll();
  };

  /**
   * イベント抽選
   */
  const drawEventChoices = async (choiceCount = 3) => {
    const pool = state.data.events.filter((event) => event.usable !== false);
    if (!pool.length) {
      alert('イベントデータが未設定です。');
      return null;
    }

    const choices = randomPickMany(pool, choiceCount);
    if (!choices.length) {
      alert('イベント候補を作成できませんでした。');
      return null;
    }

    const selected = await showSelectionModal({
      title: 'イベントを選択してください',
      description: '候補から1つ選ぶと即時反映されます。',
      items: choices,
      getTitle: (item) => item.name,
      getSubtitle: (item) => `${item.description} / ${item.rarity}`
    });

    if (!selected) {
      pushLog('miscHistory', 'イベント選択がキャンセルされました');
      return null;
    }

    await applyEvent(selected);
    renderEventResults([selected], '選択イベント');
    return selected;
  };

  /**
   * イベント効果の適用
   */
  const applyEvent = async (event) => {
    if (!event) return;

    const weaponIndex = getIndexes().weapons;

    const addEventHistory = () => {
      state.inventory.eventHistory.push(event.id);
      state.meta.latestEvent = event.name;
      pushLog('miscHistory', `イベント発動: ${event.name}`);
    };

    const normalizeForMatch = (value) => String(value ?? '')
      .replace(/[\s　]/g, '')
      .replace(/【[0-9]+】/g, '')
      .replace(/[ⅡⅢⅣⅤ]/g, '')
      .replace(/[=＝]/g, '=')
      .toLowerCase();

    const inferArmorPartFromPieceName = (value) => {
      const textValue = String(value ?? '');
      if (textValue.includes('ヘルム') || textValue.includes('キャップ') || textValue.includes('フェイク') || textValue.includes('羽飾り')) return 'head';
      if (textValue.includes('メイル') || textValue.includes('レジスト')) return 'chest';
      if (textValue.includes('アーム') || textValue.includes('ガード')) return 'arms';
      if (textValue.includes('コイル') || textValue.includes('フォールド')) return 'waist';
      if (textValue.includes('グリーヴ') || textValue.includes('レギンス')) return 'legs';
      return null;
    };

    const matchArmorCandidates = (nameOrNames) => {
      const wanted = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
      const results = [];

      wanted.forEach((wantedName) => {
        const normalizedWanted = normalizeForMatch(wantedName).replace('一式', '').replace('防具', '');
        const inferredPart = inferArmorPartFromPieceName(wantedName);

        state.data.armor.forEach((armor) => {
          const armorTokens = [armor.name, armor.set, ...(String(armor.set ?? '').split(/[\/／]/))]
            .map(normalizeForMatch)
            .filter(Boolean);

          const matchedByName = armorTokens.some((token) => token && (normalizedWanted.includes(token) || token.includes(normalizedWanted)));
          const matchedByPart = inferredPart ? armor.part === inferredPart : true;
          if (matchedByName && matchedByPart) results.push(armor);
        });
      });

      const unique = [];
      const seen = new Set();
      results.forEach((armor) => {
        if (!seen.has(armor.id)) {
          seen.add(armor.id);
          unique.push(armor);
        }
      });
      return unique;
    };

    const findWeaponByEventName = (name) => {
      const target = normalizeForMatch(name);
      return state.data.weapons.find((item) => {
        const itemName = normalizeForMatch(item.name);
        return itemName === target || itemName.includes(target) || target.includes(itemName);
      }) || null;
    };

    const findDecorationByEventName = (name) => {
      const target = normalizeForMatch(name);
      return state.data.decorations.find((item) => {
        const itemName = normalizeForMatch(item.name);
        return itemName === target || itemName.includes(target) || target.includes(itemName);
      }) || null;
    };

    const chooseWeaponFromOwned = async () => {
      const counts = countById(state.inventory.weapons);
      const available = [...counts.entries()].map(([id, count]) => ({ weapon: weaponIndex.get(id), count }))
        .filter((entry) => entry.weapon);
      if (!available.length) {
        alert('所持武器がありません。');
        return null;
      }
      const selected = await showSelectionModal({
        title: '所持武器を選択',
        description: '段階強化に使う所持武器のみ表示します。',
        items: available,
        getTitle: (item) => item.weapon.name,
        getSubtitle: (item) => `所持数 ×${item.count} / ${item.weapon.rarity ?? '未設定'} / Stage ${item.weapon.stage}`
      });
      return selected?.weapon ?? null;
    };

    const chooseArmorFromOwned = async () => {
      const available = [...new Set(state.inventory.armors)]
        .map((id) => getIndexes().armors.get(id))
        .filter(Boolean);
      if (!available.length) {
        alert('所持防具がありません。');
        return null;
      }
      return await showSelectionModal({
        title: '所持防具を選択',
        description: '段階強化に使う所持防具のみ表示します。',
        items: available,
        getTitle: (item) => item.name,
        getSubtitle: (item) => `${item.part} / Lv+${clampArmorLevel(state.meta.armorLevels[item.id] ?? 0)}`
      });
    };

    const chooseWeaponFromAll = async () => {
      const available = state.data.weapons.filter((w) => w.gacha === true);
      return await showSelectionModal({
        title: '武器を選択',
        description: '好きな武器を1つ獲得できます。',
        items: available,
        getTitle: (item) => item.name,
        getSubtitle: (item) => `${item.rarity ?? '未設定'} / Stage ${item.stage}`
      });
    };

    const chooseArmorFromAll = async () => {
      const available = state.data.armor.filter((a) => a.gacha === true);
      return await showSelectionModal({
        title: '防具を選択',
        description: '好きな防具を1つ獲得できます。',
        items: available,
        getTitle: (item) => item.name,
        getSubtitle: (item) => `${item.part} / ${item.rarity ?? '未設定'}`
      });
    };

    const chooseSpecificArmorByName = async (nameOrNames) => {
      const available = matchArmorCandidates(nameOrNames);
      if (!available.length) return null;
      if (available.length === 1) return available[0];
      return await showSelectionModal({
        title: '防具を選択',
        description: 'イベント報酬候補から受け取る防具を選んでください。',
        items: available,
        getTitle: (item) => item.name,
        getSubtitle: (item) => `${item.part} / ${item.rarity ?? '未設定'}`
      });
    };

    switch (event.effect_type) {
      case 'coin': {
        addCoins(Number(event.effect_value ?? 0), event.name);
        break;
      }
      case 'coin_and_weapon_gacha': {
        addCoins(Number(event.effect_value?.coin ?? 0), event.name);
        state.inventory.weaponTickets.bronze += Number(event.effect_value?.bronze_weapon_gacha ?? 0);
        break;
      }
      case 'coin_and_event': {
        addCoins(Number(event.effect_value?.coin ?? 0), event.name);
        const extra = Number(event.effect_value?.extra_event ?? 0);
        for (let i = 0; i < extra; i += 1) await drawEventChoices(3);
        break;
      }
      case 'free_bronze_weapon_gacha':
        state.inventory.weaponTickets.bronze += Number(event.effect_value ?? 0);
        break;
      case 'free_silver_weapon_gacha':
        state.inventory.weaponTickets.silver += Number(event.effect_value ?? 0);
        break;
      case 'free_gold_weapon_gacha':
        state.inventory.weaponTickets.gold += Number(event.effect_value ?? 0);
        break;
      case 'free_bronze_armor_gacha':
        state.inventory.armorTickets.bronze += Number(event.effect_value ?? 0);
        break;
      case 'free_silver_armor_gacha':
        state.inventory.armorTickets.silver += Number(event.effect_value ?? 0);
        break;
      case 'free_gold_armor_gacha':
        state.inventory.armorTickets.gold += Number(event.effect_value ?? 0);
        break;
      case 'free_decoration_gacha':
        state.inventory.decorationTickets += Number(event.effect_value ?? 0);
        break;
      case 'grant_specific_weapon': {
        const weapon = findWeaponByEventName(event.effect_value);
        if (weapon) addWeaponToInventory(weapon.id);
        else pushLog('miscHistory', `イベント報酬の武器が未登録: ${String(event.effect_value)}`);
        break;
      }
      case 'grant_specific_armor': {
        const armor = await chooseSpecificArmorByName(event.effect_value);
        if (armor) addArmorToInventory(armor.id);
        else pushLog('miscHistory', `イベント報酬の防具が未登録: ${String(event.effect_value)}`);
        break;
      }
      case 'grant_specific_decoration': {
        const deco = findDecorationByEventName(event.effect_value);
        if (deco) addDecorationToInventory(deco.id);
        else pushLog('miscHistory', `イベント報酬の装飾品が未登録: ${String(event.effect_value)}`);
        break;
      }
      case 'grant_specific_decoration_set': {
        const names = Array.isArray(event.effect_value) ? event.effect_value : [];
        names.forEach((name) => {
          const deco = findDecorationByEventName(name);
          if (deco) addDecorationToInventory(deco.id);
          else pushLog('miscHistory', `イベント報酬の装飾品が未登録: ${String(name)}`);
        });
        break;
      }
      case 'grant_armor_set': {
        const targetName = String(event.effect_value ?? '');
        const normalizedTarget = normalizeForMatch(targetName).replace('一式', '').replace('マガラ', '');
        const setArmors = state.data.armor.filter((armor) => {
          const nameTokens = [armor.name, armor.set, ...String(armor.set ?? '').split(/[\/／]/)].map(normalizeForMatch);
          return nameTokens.some((token) => token && (normalizedTarget.includes(token) || token.includes(normalizedTarget)));
        });
        setArmors.forEach((armor) => addArmorToInventory(armor.id));
        break;
      }
      case 'weapon_evolution': {
        const amount = Number(event.effect_value ?? 1);
        for (let i = 0; i < amount; i += 1) {
          const selected = await chooseWeaponFromOwned();
          if (!selected || !selected.next_weapon || selected.is_final) continue;
          const nextWeapon = weaponIndex.get(selected.next_weapon);
          const idx = state.inventory.weapons.indexOf(selected.id);
          if (nextWeapon && idx >= 0) state.inventory.weapons.splice(idx, 1, nextWeapon.id);
        }
        break;
      }
      case 'armor_upgrade': {
        const amount = Number(event.effect_value ?? 1);
        for (let i = 0; i < amount; i += 1) {
          const selected = await chooseArmorFromOwned();
          if (!selected) continue;
          applyArmorLevelGain(selected.id, 1);
        }
        break;
      }
      case 'qurio_ticket': {
        state.inventory.qurioTickets += Number(event.effect_value ?? 0);
        break;
      }
      case 'extra_event': {
        const count = Number(event.effect_value ?? 0);
        for (let i = 0; i < count; i += 1) await drawEventChoices(3);
        break;
      }
      case 'package_reward': {
        const value = safeObject(event.effect_value);
        if (value.coin) addCoins(Number(value.coin), event.name);
        if (value.weapon_evolution) {
          for (let i = 0; i < Number(value.weapon_evolution); i += 1) {
            const selected = await chooseWeaponFromOwned();
            if (!selected || !selected.next_weapon || selected.is_final) continue;
            const nextWeapon = weaponIndex.get(selected.next_weapon);
            const idx = state.inventory.weapons.indexOf(selected.id);
            if (nextWeapon && idx >= 0) state.inventory.weapons.splice(idx, 1, nextWeapon.id);
          }
        }
        if (value.armor_upgrade) {
          for (let i = 0; i < Number(value.armor_upgrade); i += 1) {
            const selected = await chooseArmorFromOwned();
            if (!selected) continue;
            applyArmorLevelGain(selected.id, 1);
          }
        }
        if (value.qurio_ticket) state.inventory.qurioTickets += Number(value.qurio_ticket);
        if (value.gold_weapon_gacha) state.inventory.weaponTickets.gold += Number(value.gold_weapon_gacha);
        if (value.gold_armor_gacha) state.inventory.armorTickets.gold += Number(value.gold_armor_gacha);
        if (value.silver_armor_gacha) state.inventory.armorTickets.silver += Number(value.silver_armor_gacha);
        if (value.bronze_weapon_gacha) state.inventory.weaponTickets.bronze += Number(value.bronze_weapon_gacha);
        if (value.decoration_gacha) state.inventory.decorationTickets += Number(value.decoration_gacha);
        if (value.free_decoration_gacha) state.inventory.decorationTickets += Number(value.free_decoration_gacha);
        break;
      }
      case 'armor_pick_and_event_choice': {
        const armorCount = Number(event.effect_value?.armor_choice ?? 0);
        for (let i = 0; i < armorCount; i += 1) {
          const selected = await chooseArmorFromAll();
          if (selected) addArmorToInventory(selected.id);
        }
        const extraChoices = Number(event.effect_value?.extra_event_choices ?? 3);
        await drawEventChoices(extraChoices);
        break;
      }
      case 'choose_any_weapon': {
        const count = Number(event.effect_value ?? 1);
        for (let i = 0; i < count; i += 1) {
          const selected = await chooseWeaponFromAll();
          if (selected) addWeaponToInventory(selected.id);
        }
        break;
      }
      case 'choose_any_armor': {
        const count = Number(event.effect_value ?? 1);
        for (let i = 0; i < count; i += 1) {
          const selected = await chooseArmorFromAll();
          if (selected) addArmorToInventory(selected.id);
        }
        break;
      }
      case 'unlock_real_charm':
        state.inventory.charms.push('現実のお守り（イベント解放）');
        break;
      case 'unlock_real_qurio_armor':
        state.inventory.charms.push('現実の錬成防具（イベント解放）');
        break;
      default:
        pushLog('miscHistory', `未対応のイベント効果: ${event.effect_type ?? '未設定'}`);
        break;
    }

    addEventHistory();
    renderAll();
  };

  /**
   * モンスター抽選
   */
  const drawMonster = () => {
    const dimension = byId('monsterDimensionFilter')?.value ?? 'all';
    const star = byId('monsterStarFilter')?.value ?? 'all';

    let pool = [...state.data.monsters];
    if (dimension !== 'all') pool = pool.filter((monster) => String(monster.dimension) === String(dimension).replace('第一次元', '1').replace('第二次元', '2').replace('第三次元', '3'));
    if (star !== 'all') pool = pool.filter((monster) => `★${monster.star}` === star);

    const chosen = randomPick(pool);
    if (!chosen) {
      alert('条件に合うモンスターが見つかりません。');
      return;
    }

    state.inventory.monsterHistory.push(chosen.id);
    state.meta.latestMonster = chosen.name;
    pushLog('miscHistory', `モンスター抽選: ${chosen.name} (★${chosen.star})`);

    const area = byId('monsterResultArea');
    if (area) {
      area.innerHTML = `<div class="result-card"><strong>${chosen.name}</strong><p>★${chosen.star} / 第${chosen.dimension}次元</p></div>`;
    }

    renderAll();
  };

  /**
   * 傀異錬成
   */
  const executeQurio = () => {
    const consume = Number(state.data.settings?.qurio?.consume_per_use ?? 1);
    if (state.inventory.qurioTickets < consume) {
      alert('傀異錬成権が不足しています。');
      return;
    }

    state.inventory.qurioTickets -= consume;
    pushLog('miscHistory', `傀異錬成を実行（消費: ${consume}）`);
    alert('傀異錬成を実行しました。');
    renderAll();
  };

  /**
   * 画面出力系ユーティリティ
   */
  const setText = (id, value) => {
    const el = byId(id);
    if (el) el.textContent = value;
  };

  const renderResultList = (containerId, items, formatter) => {
    const el = byId(containerId);
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<p class="muted">結果なし</p>';
      return;
    }
    el.innerHTML = items.map(formatter).join('');
  };

  /**
   * レア度 → ガチャ演出用クラス名（UI演出のみ）
   * 確率・データ・抽選ロジックには一切関与しない。
   * 武器: ★1〜★5 / ★5SP、防具: RARE8〜RARE10。
   */
  const rarityEffectClass = (rarity) => {
    const map = {
      '★1': 'rarity-1',
      '★2': 'rarity-2',
      '★3': 'rarity-3',
      '★4': 'rarity-4',
      '★5': 'rarity-5',
      '★5SP': 'rarity-5sp',
      'RARE8': 'rarity-r8',
      'RARE9': 'rarity-r9',
      'RARE10': 'rarity-r10'
    };
    return map[String(rarity ?? '').trim()] || 'rarity-none';
  };

  /* ===========================================================================
   * ⑨ BGM / SE 対応フック（今は音を鳴らさない無音スタブ）
   * 後から音源を追加するだけで使えるよう、関数だけ用意しておく。
   * いずれもゲームロジックには一切関与しない。
   * ======================================================================== */
  const HDAudio = {
    enabled: false,        // 将来、音源を用意したら true にする
    muted: false,
    bgm: null,
    sources: {
      // 例: gacha_start: 'assets/audio/wirebug.mp3',
      //     reveal: 'assets/audio/reveal.mp3',
      //     super_rare: 'assets/audio/roar.mp3'
    },
    playSound(name) {
      if (!HDAudio.enabled || HDAudio.muted) return;
      const src = HDAudio.sources[name];
      if (!src || typeof Audio === 'undefined') return;
      try {
        const se = new Audio(src);
        se.play().catch(() => {});
      } catch (_) { /* 無音フォールバック */ }
    },
    playBGM(name) {
      if (!HDAudio.enabled || HDAudio.muted) return;
      const src = HDAudio.sources[name];
      if (!src || typeof Audio === 'undefined') return;
      try {
        HDAudio.stopBGM();
        HDAudio.bgm = new Audio(src);
        HDAudio.bgm.loop = true;
        HDAudio.bgm.play().catch(() => {});
      } catch (_) { /* 無音フォールバック */ }
    },
    stopBGM() {
      if (HDAudio.bgm) {
        try { HDAudio.bgm.pause(); } catch (_) { /* noop */ }
        HDAudio.bgm = null;
      }
    }
  };
  // ショートハンド（仕様書の playSound() / playBGM() に対応）
  const playSound = (name) => HDAudio.playSound(name);
  const playBGM = (name) => HDAudio.playBGM(name);

  /* ===========================================================================
   * モンハン風シネマティック演出（すべて表示のみ）
   * 抽選結果のDOMを読むだけで、確率・データ・進化処理には関与しない。
   * ======================================================================== */

  /** ④ QUEST CLEAR 風の大バナーを約1秒表示してフェードアウト */
  const showQuestClear = () => {
    const banner = document.createElement('div');
    banner.className = 'quest-clear';
    banner.setAttribute('aria-hidden', 'true');
    banner.innerHTML = `
      <div class="quest-clear-inner">
        <span class="quest-clear-rule"></span>
        <span class="quest-clear-text">QUEST CLEAR</span>
        <span class="quest-clear-rule"></span>
      </div>
    `;
    document.body.appendChild(banner);
    window.setTimeout(() => banner.remove(), 1300);
  };

  /** ⑤ 超レア演出: 暗転 → 金/虹の閃光（kind: 'gold' | 'rainbow'） */
  const showSuperRareFlash = (kind = 'gold') => {
    const flash = document.createElement('div');
    flash.className = `rare-flash rare-flash--${kind === 'rainbow' ? 'rainbow' : 'gold'}`;
    flash.setAttribute('aria-hidden', 'true');
    document.body.appendChild(flash);
    window.setTimeout(() => flash.remove(), 850);
    playSound(kind === 'rainbow' ? 'super_rare_sp' : 'super_rare');
  };

  /** ⑥ 咆哮演出: 画面を約0.3秒揺らす */
  const triggerScreenShake = () => {
    const shell = document.querySelector('.app-shell') || document.body;
    shell.classList.remove('screen-shake'); // 連続発火に備えてリセット
    // リフローを挟んでアニメーションを再起動
    void shell.offsetWidth;
    shell.classList.add('screen-shake');
    window.setTimeout(() => shell.classList.remove('screen-shake'), 360);
  };

  /**
   * 結果カードのレア度に応じて、超レア閃光・咆哮・QUEST CLEAR を発火する。
   * 描画済みカードのクラスを読むだけ（DOM参照のみ）。
   */
  const playGachaCinematics = (areaId) => {
    const area = byId(areaId);
    if (!area) return;
    const cards = Array.from(area.querySelectorAll('.gacha-card'));
    if (!cards.length) return;

    const hasSP = cards.some((c) => c.classList.contains('rarity-5sp'));
    const hasGoldTier = cards.some((c) => c.classList.contains('rarity-5') || c.classList.contains('rarity-r10'));
    const roar = cards.some((c) => c.classList.contains('rarity-5') || c.classList.contains('rarity-5sp'));

    // ⑤ 超レア（★5 / RARE10 / ★5SP）のみ暗転＋閃光
    if (hasSP) {
      showSuperRareFlash('rainbow');
    } else if (hasGoldTier) {
      showSuperRareFlash('gold');
    }

    // ⑥ 咆哮（★5 / ★5SP）のみ画面を揺らす
    if (roar) {
      window.setTimeout(triggerScreenShake, 120);
    }

    // ④ QUEST CLEAR 風バナー（ガチャ結果が出たら表示）
    showQuestClear();
    playSound('reveal');
  };

  /**
   * ガチャ演出（UIのみ）:
   * - ボタン押下後に「ガチャ中...」を表示
   * - 約1秒後に既存の抽選関数を実行して結果を描画
   * 抽選そのもの（確率・データ）には一切手を加えない。
   */
  /**
   * ガチャ中のオーバーレイ（Step1: 静かな演出）。
   * 中央は黒背景のまま。回転オブジェクト等は一切置かず、
   * 紫・青の小さな粒子がゆっくり漂うだけの「何かが出現しそう」な雰囲気にする。
   * 派手な光・爆発は無し。JSは表示/非表示と粒子生成のみ（ロジックには不関与）。
   */
  const showGachaOverlay = () => {
    if (document.querySelector('.gacha-overlay')) return null;
    const overlay = document.createElement('div');
    overlay.className = 'gacha-overlay gacha-overlay--calm';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-live', 'assertive');
    overlay.setAttribute('aria-label', 'ガチャ中');

    // 紫/青の小さな粒子をランダム配置でゆっくり漂わせる
    let dots = '';
    const COUNT = 16;
    for (let i = 0; i < COUNT; i += 1) {
      const left = Math.round(Math.random() * 100);
      const top = Math.round(28 + Math.random() * 54);
      const size = (3 + Math.random() * 3).toFixed(1);
      const dur = (6 + Math.random() * 7).toFixed(2);
      const delay = (Math.random() * 6).toFixed(2);
      const drift = Math.round(Math.random() * 24 - 12);
      const hue = Math.random() < 0.5 ? 'p' : 'b';
      dots += `<span class="qparticle qparticle--${hue}" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;--drift:${drift}px;animation-duration:${dur}s;animation-delay:-${delay}s"></span>`;
    }

    // Step3: 裂け目の周囲へ「龍属性エネルギー」の青紫粒子を放射（裂け目が開いた後に漏れ出す）
    let energy = '';
    const EN = 12;
    for (let i = 0; i < EN; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 130;
      const ex = Math.round(Math.cos(ang) * dist);
      const ey = Math.round(Math.sin(ang) * dist * 1.4); // 縦方向に広めに漏れ出す
      const size = (2.5 + Math.random() * 2.5).toFixed(1);
      const dur = (1.6 + Math.random() * 1.6).toFixed(2);
      const delay = (1.6 + Math.random() * 1.2).toFixed(2); // 裂け目が開いた後から
      energy += `<i style="--ex:${ex}px;--ey:${ey}px;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s"></i>`;
    }

    // Step2: 静かな粒子＋中央の裂け目。Step3: 裂け目周囲へ龍属性エネルギーを追加（カードはまだ出さない）。
    overlay.innerHTML = `
      <div class="gacha-stage">
        <div class="quiet-field" aria-hidden="true">${dots}</div>
        <div class="rift2" aria-hidden="true">
          <span class="rift2-aura"></span>
          <span class="rift2-aura2"></span>
          <span class="rift2-smoke"></span>
          <span class="rift2-smoke2"></span>
          <span class="rift2-warp"></span>
          <span class="rift2-core"></span>
          <span class="rift2-bolts"><i></i><i></i><i></i><i></i></span>
          <span class="rift2-energy">${energy}</span>
        </div>
        <p class="gacha-overlay-text dim-rift-text">次元の裂け目が開いていく...</p>
      </div>
    `;
    document.body.appendChild(overlay);
    playSound('gacha_summon');
    return overlay;
  };

  const hideGachaOverlay = () => {
    const overlay = document.querySelector('.gacha-overlay');
    if (!overlay) return;
    overlay.classList.add('is-closing'); // フェードアウト
    window.setTimeout(() => overlay.remove(), 220);
  };

  /**
   * ガチャ演出（UIのみ）:
   * - ボタン押下後にモーダル風オーバーレイ「ガチャ中...」を表示
   * - 約1秒後に既存の抽選関数を実行して結果カードを描画
   * 抽選そのもの（確率・データ・進化処理）には一切手を加えない。
   */
  /**
   * 第2章: 結果カードのレアリティ → 裂け目バリアント（色 / 演出時間）。
   * 描画済みカードの rarity クラスを「読むだけ」。優先度の高い順に判定する。
   * レアリティ判定・確率・抽選ロジックには一切関与しない。
   */
  const RIFT_VARIANTS = [
    { rarity: 'rarity-5sp', variant: 'crack-sp', hold: 2600 },
    { rarity: 'rarity-5', variant: 'crack-rank5', hold: 1800 },
    { rarity: 'rarity-r10', variant: 'crack-rank5', hold: 1800 },
    { rarity: 'rarity-4', variant: 'crack-rank4', hold: 1500 },
    { rarity: 'rarity-r9', variant: 'crack-rank4', hold: 1500 },
    { rarity: 'rarity-3', variant: 'crack-rank3', hold: 1400 },
    { rarity: 'rarity-2', variant: 'crack-rank2', hold: 1200 },
    { rarity: 'rarity-r8', variant: 'crack-rank2', hold: 1200 },
    { rarity: 'rarity-1', variant: 'crack-rank1', hold: 1100 }
  ];

  // Step5-1: 出た結果の最高レアリティ → 「裂け目」と召喚光の色トーン（色だけ変更）。
  // 描画済みカードの rarity クラスを読むだけで、確率・判定・結果には不関与。
  const RIFT_TONES = [
    ['rarity-5sp', 'rift-tone-sp'],
    ['rarity-5', 'rift-tone-5'],
    ['rarity-r10', 'rift-tone-5'],
    ['rarity-4', 'rift-tone-4'],
    ['rarity-r9', 'rift-tone-4'],
    ['rarity-3', 'rift-tone-3'],
    ['rarity-2', 'rift-tone-2'],
    ['rarity-r8', 'rift-tone-2'],
    ['rarity-1', 'rift-tone-1']
  ];

  /* ---------------------------------------------------------------------------
   * Step4: 裂け目からの「装備召喚」演出（表示のみ）。
   * 抽選結果のDOMを読んで複製表示するだけで、確率・データ・結果には不関与。
   * ------------------------------------------------------------------------- */

  // 召喚タイミング（裂け目が開ききった後）
  const SUMMON_LIGHT_AT = 2300; // 奥の小さな光が近付いて大きくなる
  const SUMMON_HERO_AT = 3100;  // カードが裂け目から飛び出す
  const GACHA_SUMMON_DELAY = 4100; // ここで結果一覧を表示

  // ① 裂け目の奥から小さな光が近付いて大きくなる
  const spawnSummonLight = () => {
    const stage = document.querySelector('.gacha-overlay .gacha-stage');
    if (!stage || stage.querySelector('.summon-light')) return;
    const light = document.createElement('div');
    light.className = 'summon-light';
    light.setAttribute('aria-hidden', 'true');
    stage.appendChild(light);
    window.setTimeout(() => light.remove(), 1200);
  };

  // ② 結果カード（先頭1枚）を複製し、裂け目から飛び出す演出を見せる（表示のみ）
  const spawnSummonHero = (areaId) => {
    const stage = document.querySelector('.gacha-overlay .gacha-stage');
    const area = byId(areaId);
    if (!stage || !area) return;
    const source = area.querySelector('.gacha-card');
    if (!source) return; // 結果が無ければ召喚カードは出さない

    const wrap = document.createElement('div');
    wrap.className = 'summon-hero';
    wrap.setAttribute('aria-hidden', 'true');
    const clone = source.cloneNode(true); // 複製（元の結果には触れない）
    clone.classList.add('summon-card');
    wrap.appendChild(clone);
    stage.appendChild(wrap);
  };

  /**
   * 描画済みカードから「最も高いレアリティのクラス名」を1つ返す（演出の色出し分け用）。
   * 確率・抽選・データには一切関与しない。優先度の高い順に判定する。
   * キー名は fx-gacha-config.js の rarity テーブルのキーと一致させている。
   */
  const FX_RARITY_PRIORITY = [
    'rarity-5sp', 'rarity-5', 'rarity-r10', 'rarity-4', 'rarity-r9',
    'rarity-3', 'rarity-2', 'rarity-r8', 'rarity-1', 'rarity-none'
  ];
  const detectTopRarityClass = (cards) => {
    for (const cls of FX_RARITY_PRIORITY) {
      if (cards.some((c) => c.classList.contains(cls))) return cls;
    }
    return 'rarity-none';
  };

  const runGachaWithEffect = (areaId, button, drawFn) => {
    // ── 新ガチャ演出（fx-gacha.js）が読み込まれていればそちらを使う ──
    //   既存の抽選ロジック(drawFn)・確率・判定には一切触れない。「演出」だけ差し替える。
    //   未読込なら下の従来演出へフォールバックする（後方互換）。
    if (window.FXGacha && typeof window.FXGacha.play === 'function') {
      if (button && button.dataset.gachaBusy === '1') return; // 多重押下防止
      if (button) { button.dataset.gachaBusy = '1'; button.disabled = true; }

      const area = byId(areaId);
      if (area) area.classList.add('gacha-pending'); // 演出が終わるまで結果カードを隠す

      try {
        drawFn(); // 抽選実行（結果は隠れた状態で描画される）
      } finally {
        // 最高レアリティのクラスを取得（演出の「色」だけに使用。結果・確率には不関与）
        const cards = area ? Array.from(area.querySelectorAll('.gacha-card')) : [];

        // 結果が0件（コイン/チケット不足などで引けなかった）場合は演出せず即解除
        if (!cards.length) {
          if (area) area.classList.remove('gacha-pending');
          if (button) { button.dataset.gachaBusy = '0'; button.disabled = false; }
          return;
        }

        const rarityKey = detectTopRarityClass(cards);
        const sourceCardEl = cards[0] || null; // 登場演出で複製する先頭カード

        window.FXGacha.play({
          rarity: rarityKey,
          sourceCardEl,
          onComplete: () => {
            if (area) {
              area.classList.remove('gacha-pending'); // ここで結果一覧を表示
              // 排出カードの四角枠を虹色で一周（ぐるぐる）光らせる
              if (window.FXGacha.decorateResults) window.FXGacha.decorateResults(area);
              area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            if (button) { button.dataset.gachaBusy = '0'; button.disabled = false; }
          }
        });
      }
      return;
    }

    // ── フォールバック：従来のオーバーレイ演出（fx-gacha.js 未読込時のみ） ──
    if (button && button.dataset.gachaBusy === '1') return; // 多重押下防止
    if (button) {
      button.dataset.gachaBusy = '1';
      button.disabled = true;
    }

    const overlay = showGachaOverlay();
    const area = byId(areaId);
    // 結果カードは演出が終わるまで隠す（演出中は見せない）
    if (area) area.classList.add('gacha-pending');

    // 既存の抽選を実行（ロジック・確率・判定は不変）。結果は隠れた状態で描画される。
    try {
      drawFn();
    } finally {
      // Step5-1: 出た結果の最高レアリティに合わせ、裂け目と召喚光の「色」だけを変える（表示のみ）
      if (overlay && area) {
        const cards = Array.from(area.querySelectorAll('.gacha-card'));
        const tone = RIFT_TONES.find((t) => cards.some((c) => c.classList.contains(t[0])));
        if (tone) overlay.classList.add(tone[1]);
      }

      // 召喚演出（光が近付く → カードが裂け目から飛び出す）。すべて表示のみ。
      window.setTimeout(spawnSummonLight, SUMMON_LIGHT_AT);
      window.setTimeout(() => spawnSummonHero(areaId), SUMMON_HERO_AT);

      window.setTimeout(() => {
        hideGachaOverlay();
        if (area) {
          area.classList.remove('gacha-pending'); // ここで結果一覧が表示
          // 排出カードの四角枠を虹色で一周（ぐるぐる）光らせる（演出エンジン読込時のみ）
          if (window.FXGacha && window.FXGacha.decorateResults) window.FXGacha.decorateResults(area);
          area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        if (button) {
          button.dataset.gachaBusy = '0';
          button.disabled = false;
        }
        // 派手な閃光・咆哮・QUEST CLEAR・レア別裂け目はまだ呼ばない。
      }, GACHA_SUMMON_DELAY);
    }
  };

  /**
   * 進化演出（表示のみ）。
   * 既存の進化ロジック実行後に呼び出して「進化！ A → B」をアニメ表示するだけで、
   * 進化処理そのものには一切関与しない。
   */
  const showEvolutionEffect = (fromName, toName) => {
    const flash = document.createElement('div');
    flash.className = 'evo-flash';
    flash.setAttribute('role', 'status');
    // 光る → 旧武器が砕けて消える → 新武器へ変化 → 「進化！」
    flash.innerHTML = `
      <div class="evo-flash-card">
        <div class="evo-stage" aria-hidden="true">
          <span class="evo-old">${escapeHtml(fromName)}</span>
          <span class="evo-shards">
            <i></i><i></i><i></i><i></i><i></i><i></i>
          </span>
          <span class="evo-new">${escapeHtml(toName)}</span>
        </div>
        <span class="evo-flash-title">進化！</span>
        <span class="evo-flash-names">${escapeHtml(fromName)} → ${escapeHtml(toName)}</span>
      </div>
    `;
    document.body.appendChild(flash);
    window.setTimeout(() => flash.remove(), 2200);
  };

  // NEWリボン / DUPLICATEバッジ（取得状況の表示のみ。所持判定は描画前に算出済み）
  const acquireBadge = (item) => item.__isNew
    ? '<span class="gacha-new-ribbon">NEW</span>'
    : '<span class="gacha-dup-badge">DUPLICATE</span>';

  // ★5SP専用の追加演出レイヤー（虹色オーラ＋光の柱）
  const spExtraFx = (rarity) => rarity === '★5SP'
    ? '<span class="sp-fx" aria-hidden="true"><i class="sp-pillar"></i><i class="sp-aura"></i></span>'
    : '';

  const renderWeaponResults = (items) => {
    renderResultList('weaponResultArea', items, (item) => `
      <div class="result-card gacha-card gacha-card--weapon ${rarityEffectClass(item.rarity)}">
        ${spExtraFx(item.rarity)}
        ${acquireBadge(item)}
        <strong class="gacha-card-name">${escapeHtml(item.name)}</strong>
        <p class="gacha-card-rarity">${escapeHtml(item.rarity ?? '未設定')}</p>
        <p class="gacha-card-method">入手方法: ${escapeHtml(item.__method ?? 'ガチャ')}</p>
        ${item.__evolution ? `<div class="evo-inline">進化！<span>${escapeHtml(item.__evolution.from)} → ${escapeHtml(item.__evolution.to)}</span></div>` : ''}
      </div>
    `);
  };

  const renderArmorResults = (items) => {
    renderResultList('armorResultArea', items, (item) => `
      <div class="result-card gacha-card gacha-card--armor ${rarityEffectClass(item.rarity)}">
        ${acquireBadge(item)}
        <strong class="gacha-card-name">${escapeHtml(item.name)}</strong>
        <p class="gacha-card-rarity">${escapeHtml(item.rarity ?? '未設定')} / ${escapeHtml(item.part ?? '')}</p>
        <p class="gacha-card-method">入手方法: ${escapeHtml(item.__method ?? 'ガチャ')}</p>
      </div>
    `);
  };

  const renderDecorationResults = (items) => {
    renderResultList('decorationResultArea', items, (item) => `
      <div class="result-card gacha-card gacha-card--deco rarity-none">
        ${acquireBadge(item)}
        <strong class="gacha-card-name">${escapeHtml(item.name)}</strong>
        <p class="gacha-card-rarity">${escapeHtml(item.skill ?? '')} / Slot ${escapeHtml(String(item.slot_size ?? ''))}</p>
        <p class="gacha-card-method">入手方法: ${escapeHtml(item.__method ?? 'ガチャ')}</p>
      </div>
    `);
  };

  // ④ イベントは「次元の巻物」として表示（閉→開→タイトル→内容）。表示のみ。
  const renderEventResults = (items, label = 'イベント結果') => {
    renderResultList('eventResultArea', items, (item) => `
      <div class="dim-scroll" role="group">
        <span class="dim-scroll-rod dim-scroll-rod--top" aria-hidden="true"></span>
        <div class="dim-scroll-body">
          <div class="dim-scroll-inner">
            <p class="dim-scroll-label">${escapeHtml(label)}</p>
            <h4 class="dim-scroll-title">${escapeHtml(item.name ?? '')}</h4>
            <p class="dim-scroll-desc">${escapeHtml(item.description ?? '')}</p>
            <p class="dim-scroll-meta">${escapeHtml(item.rarity ?? '')} / ${escapeHtml(item.category ?? '')}</p>
          </div>
        </div>
        <span class="dim-scroll-rod dim-scroll-rod--bottom" aria-hidden="true"></span>
      </div>
    `);
  };

  /**
   * 武器セレクトの再構築
   */
  const renderWeaponSelects = () => {
    const select = byId('weaponUpgradeName');
    if (!select) return;

    const weaponIndex = getIndexes().weapons;
    const uniqueOwned = [...new Set(state.inventory.weapons)]
      .map((id) => weaponIndex.get(id))
      .filter(Boolean);

    select.innerHTML = uniqueOwned.length
      ? uniqueOwned.map((weapon) => `<option value="${weapon.id}">${weapon.name}</option>`).join('')
      : '<option value="">所持武器なし</option>';
  };

  /**
   * 防具セレクトの再構築
   */
  const renderArmorSelects = () => {
    const select = byId('armorUpgradeName');
    if (!select) return;

    const armorIndex = getIndexes().armors;
    const uniqueOwned = [...new Set(state.inventory.armors)]
      .map((id) => armorIndex.get(id))
      .filter(Boolean);

    select.innerHTML = uniqueOwned.length
      ? uniqueOwned.map((armor) => `<option value="${armor.id}">${armor.name} [${armor.part}]</option>`).join('')
      : '<option value="">所持防具なし</option>';
  };


  /**
   * 初回開始時の初期装備配布
   * - settings.start の回数に従ってブロンズ武器2回 / ブロンズ防具5回を自動実行
   * - inventory.json には装備を固定せず、毎回ガチャ結果で開始する
   */
  const applyStartingLoadout = () => {
    const hasAnyInventory = state.inventory.weapons.length || state.inventory.armors.length || state.inventory.decorations.length || state.inventory.charms.length;
    const hasAnyHistory = state.meta.gachaHistory.length || state.meta.miscHistory.length || state.inventory.monsterHistory.length || state.inventory.eventHistory.length;
    if (hasAnyInventory || hasAnyHistory) return;

    const start = safeObject(state.data.settings?.start);
    const weaponCount = Number(start?.weapon_gacha?.bronze ?? 0);
    const armorCount = Number(start?.armor_gacha?.bronze ?? 0);

    state.inventory.weaponTickets.bronze += Math.max(0, weaponCount);
    state.inventory.armorTickets.bronze += Math.max(0, armorCount);

    if (weaponCount > 0) drawWeaponGacha('bronze', weaponCount, 'ticket');
    if (armorCount > 0) drawArmorGacha('bronze', armorCount, 'ticket');

    pushLog('miscHistory', `初期装備を配布: 武器${weaponCount}回 / 防具${armorCount}回`);
  };

  /**
   * ルール一覧 / ガイドの表示
   */
  const renderRulesAndGuide = () => {
    const guideCards = byId('guideCards');
    const rulesCards = byId('rulesCards');
    const cards = getGuideCardsFromRules();

    if (guideCards) {
      guideCards.innerHTML = cards.length
        ? cards.map((card) => `
            <article class="card info-card">
              <h4>${escapeHtml(card.title)}</h4>
              <p>${formatMultilineText(card.body || '未設定')}</p>
            </article>
          `).join('')
        : '<p class="muted">rules.json が未設定です。</p>';
    }

    if (rulesCards) {
      rulesCards.innerHTML = state.data.rules.length
        ? state.data.rules.map((rule) => `
            <article class="card info-card">
              <h4>${escapeHtml(rule.title ?? '未設定')}</h4>
              <p>${formatMultilineText(rule.content ?? '未設定')}</p>
            </article>
          `).join('')
        : '<p class="muted">rules.json が未設定です。</p>';
    }
  };

  /**
   * モンスター一覧テーブル
   */
  const renderMonsterTable = () => {
    const tbody = byId('monsterTableBody');
    if (!tbody) return;

    const dimensionFilter = byId('monsterListDimensionFilter')?.value ?? 'all';
    const starFilter = byId('monsterListStarFilter')?.value ?? 'all';

    let items = [...state.data.monsters];

    if (dimensionFilter !== 'all') {
      const dimMap = { '第一次元': 1, '第二次元': 2, '第三次元': 3 };
      items = items.filter((monster) => monster.dimension === dimMap[dimensionFilter]);
    }

    if (starFilter !== 'all') {
      const starNum = Number(String(starFilter).replace('★', ''));
      items = items.filter((monster) => monster.star === starNum);
    }

    tbody.innerHTML = items.length
      ? items.map((monster) => `
          <tr>
            <td>★${monster.star}</td>
            <td>${monster.name}</td>
            <td>★${monster.star}</td>
            <td>第${monster.dimension}次元</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4">データ未設定</td></tr>';
  };

  /**
   * ステージ攻略の簡易表示
   * monsters.json しか確定情報がないので、次元別一覧として描画する。
   */
  const renderStageTables = () => {
    const container = byId('stageTables');
    if (!container) return;

    const grouped = [1, 2, 3].map((dimension) => ({
      dimension,
      monsters: state.data.monsters.filter((monster) => monster.dimension === dimension)
    }));

    container.innerHTML = grouped.map((group) => `
      <section class="card mb-16">
        <h4>第${group.dimension}次元</h4>
        ${group.monsters.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr><th>★</th><th>モンスター</th><th>次元</th></tr>
              </thead>
              <tbody>
                ${group.monsters.map((monster) => `
                  <tr>
                    <td>★${monster.star}</td>
                    <td>${monster.name}</td>
                    <td>${group.dimension}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted">データ未設定</p>'}
      </section>
    `).join('');
  };

  /**
   * 所持一覧描画
   */
  const renderInventories = () => {
    const { weapons, armors, decorations } = getIndexes();
    const weaponList = byId('weaponInventoryList');
    const armorList = byId('armorInventoryList');
    const decorationList = byId('decorationInventoryList');
    const charmList = byId('charmInventoryList');

    const weaponKeyword = String(byId('weaponInventorySearch')?.value ?? '').trim().toLowerCase();
    const armorKeyword = String(byId('armorInventorySearch')?.value ?? '').trim().toLowerCase();
    const decorationKeyword = String(byId('decorationInventorySearch')?.value ?? '').trim().toLowerCase();
    const charmKeyword = String(byId('charmInventorySearch')?.value ?? '').trim().toLowerCase();

    const weaponCounts = [...countById(state.inventory.weapons).entries()]
      .map(([id, count]) => ({ data: weapons.get(id), count, id }))
      .filter((entry) => entry.data && (!weaponKeyword || `${entry.data.name} ${entry.data.rarity ?? ''}`.toLowerCase().includes(weaponKeyword)));

    if (weaponList) {
      weaponList.innerHTML = weaponCounts.length
        ? weaponCounts.map((entry) => `<li>${escapeHtml(entry.data.name)} / ${escapeHtml(entry.data.rarity ?? '未設定')} / Stage ${entry.data.stage} ×${entry.count}</li>`).join('')
        : '<li>なし</li>';
    }

    const armorItems = [...new Set(state.inventory.armors)]
      .map((id) => ({ data: armors.get(id), id }))
      .filter((entry) => entry.data && (!armorKeyword || `${entry.data.name} ${entry.data.part}`.toLowerCase().includes(armorKeyword)));

    if (armorList) {
      armorList.innerHTML = armorItems.length
        ? armorItems.map((entry) => `<li>${escapeHtml(entry.data.name)} [${escapeHtml(entry.data.part)}] Lv+${clampArmorLevel(state.meta.armorLevels[entry.id] ?? 0)}</li>`).join('')
        : '<li>なし</li>';
    }

    const decorationCounts = [...countById(state.inventory.decorations).entries()]
      .map(([id, count]) => ({ data: decorations.get(id), count, id }))
      .filter((entry) => entry.data && (!decorationKeyword || `${entry.data.name} ${entry.data.skill}`.toLowerCase().includes(decorationKeyword)));

    if (decorationList) {
      decorationList.innerHTML = decorationCounts.length
        ? decorationCounts.map((entry) => `<li>${escapeHtml(entry.data.name)} ×${entry.count}</li>`).join('')
        : '<li>なし</li>';
    }

    const charmItems = safeArray(state.inventory.charms).filter((item) => !charmKeyword || String(item).toLowerCase().includes(charmKeyword));
    if (charmList) {
      charmList.innerHTML = charmItems.length
        ? charmItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
        : '<li>なし</li>';
    }
  };

  /**
   * 履歴描画
   */
  const renderHistory = () => {
    const historyKeyword = String(byId('historySearchInput')?.value ?? '').trim().toLowerCase();
    const mapHistory = (id, items) => {
      const el = byId(id);
      if (!el) return;
      const filtered = historyKeyword
        ? safeArray(items).filter((item) => String(item).toLowerCase().includes(historyKeyword))
        : safeArray(items);
      el.innerHTML = filtered.length ? filtered.map((item) => `<li>${item}</li>`).join('') : '<li>履歴なし</li>';
    };

    mapHistory('coinHistoryList', state.meta.coinHistory);
    mapHistory('gachaHistoryList', state.meta.gachaHistory);
    mapHistory('miscHistoryList', state.meta.miscHistory);
  };

  /**
   * 基本メトリクス描画
   */
  const renderMetrics = () => {
    setText('coinDisplay', String(state.inventory.coins));
    setText('dashboardCoins', String(state.inventory.coins));
    setText('sidebarCoinDisplay', String(state.inventory.coins));
    setText('sidebarDrawDisplay', String(state.meta.gachaHistory.length));
    setText('sidebarEventDisplay', String(state.inventory.eventHistory.length));
    setText('weaponOwnedCount', String(state.inventory.weapons.length));
    setText('armorOwnedCount', String(state.inventory.armors.length));
    setText('decoOwnedCount', String(state.inventory.decorations.length));
    setText('upgradeCountDisplay', String(Object.values(state.meta.armorLevels).reduce((sum, value) => sum + Number(value || 0), 0)));
    setText('latestEventName', state.meta.latestEvent ?? '未抽選');
    setText('latestMonsterName', state.meta.latestMonster ?? '未抽選');
  };

  /**
   * 武器進化シミュレーター結果表示
   */
  const renderWeaponUpgradePreview = () => {
    const result = byId('weaponUpgradeResult');
    if (!result) return;

    const weaponId = byId('weaponUpgradeName')?.value;
    const weapon = getIndexes().weapons.get(weaponId);
    if (!weapon) {
      result.innerHTML = '<p class="muted">所持武器を選択してください。</p>';
      return;
    }

    if (!weapon.next_weapon || weapon.is_final) {
      result.innerHTML = `<p><strong>${escapeHtml(weapon.name)}</strong> は最終段階です。</p>`;
      return;
    }

    const nextWeapon = getIndexes().weapons.get(weapon.next_weapon);
    const duplicateRequired = Number(state.data.settings?.upgrade?.weapon?.duplicate_required ?? 2);
    const coinCost = Number(state.data.settings?.upgrade?.weapon?.coin_cost ?? 200);
    const copies = countWeaponCopies(weapon.id);

    result.innerHTML = `
      <p><strong>${escapeHtml(weapon.name)}</strong> → <strong>${escapeHtml(nextWeapon?.name ?? '未設定')}</strong></p>
      <p>重複必要数: ${duplicateRequired} / 現在所持: ${copies}</p>
      <p>コイン進化コスト: ${coinCost}</p>
    `;
  };

  /**
   * 防具強化シミュレーター結果表示
   */
  const renderArmorUpgradePreview = () => {
    const result = byId('armorUpgradeResult');
    if (!result) return;

    const armorId = byId('armorUpgradeName')?.value;
    const armor = getIndexes().armors.get(armorId);
    if (!armor) {
      result.innerHTML = '<p class="muted">所持防具を選択してください。</p>';
      return;
    }

    const level = clampArmorLevel(state.meta.armorLevels[armorId] ?? 0);
    const cost = Number(state.data.settings?.upgrade?.armor?.coin_cost ?? 20);
    result.innerHTML = `
      <p><strong>${escapeHtml(armor.name)}</strong> [${escapeHtml(armor.part)}]</p>
      <p>現在強化レベル: +${level} / 上限: 37</p>
      <p>次回強化コスト: ${cost}コイン</p>
    `;
  };

  /**
   * エラー表示
   */
  const renderLoadErrors = () => {
    if (!state.meta.loadErrors.length) return;
    console.warn('読込エラー一覧:', state.meta.loadErrors);
  };

  /**
   * すべて再描画
   */
  const renderAll = () => {
    renderMetrics();
    renderRulesAndGuide();
    renderMonsterTable();
    renderStageTables();
    renderWeaponSelects();
    renderArmorSelects();
    renderWeaponUpgradePreview();
    renderArmorUpgradePreview();
    renderInventories();
    renderHistory();
    renderLoadErrors();
  };

  /**
   * ナビゲーション
   */
  const bindNavigation = () => {
    const links = $$('.nav-link');
    const sections = $$('.page-section');
    const sidebar = byId('sidebar');

    const activateSection = (targetId, title = 'ページ') => {
      sections.forEach((section) => section.classList.remove('active'));
      byId(targetId)?.classList.add('active');
      setText('pageTitle', title);
    };

    const activateLink = (clickedButton) => {
      links.forEach((item) => item.classList.remove('active'));
      clickedButton.classList.add('active');
    };

    const navigateTo = (button) => {
      const target = button.dataset.target;
      const jumpId = button.dataset.jump;
      const title = button.dataset.title || button.textContent || 'ページ';

      if (target) {
        activateSection(target, title.trim());
      }
      activateLink(button);

      if (sidebar?.classList.contains('open')) {
        sidebar.classList.remove('open');
      }

      if (jumpId) {
        window.requestAnimationFrame(() => {
          const jumpTarget = byId(jumpId);
          if (jumpTarget) jumpTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };

    links.forEach((button) => {
      button.addEventListener('click', () => navigateTo(button));
    });

    $$('.action-button').forEach((button) => {
      button.addEventListener('click', () => {
        const targetId = button.dataset.jump;
        const target = byId(targetId);
        const ownerSection = target?.closest('.page-section');
        if (ownerSection) {
          const toolsLink = links.find((item) => item.dataset.target === ownerSection.id) || null;
          if (toolsLink) activateLink(toolsLink);
          activateSection(ownerSection.id, ownerSection.id === 'tools' ? '管理ツール' : (ownerSection.querySelector('h3, h2')?.textContent || 'ページ'));
        }
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    const menuButton = byId('menuButton');
    if (menuButton && sidebar) {
      menuButton.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }
  };

  /**
   * PWA 用 service worker 登録
   */
  const registerServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/i.test(window.location.protocol)) return;

    try {
      await navigator.serviceWorker.register('sw.js');
      console.info('service worker を登録しました');
    } catch (error) {
      console.warn('service worker の登録に失敗しました:', error);
    }
  };

  /**
   * サイト内検索
   * - ルール / 武器 / 防具 / 装飾品 / イベント / モンスターの名前を横断検索
   */
  const bindSearch = () => {
    const input = byId('siteSearch');
    const results = byId('searchResults');
    if (!input || !results) return;

    input.addEventListener('input', () => {
      const keyword = input.value.trim().toLowerCase();
      if (!keyword) {
        results.innerHTML = '';
        return;
      }

      const merged = [
        ...state.data.rules.map((item) => ({ type: 'rule', name: item.title, text: item.content ?? '' })),
        ...state.data.weapons.map((item) => ({ type: 'weapon', name: item.name, text: item.rarity ?? '' })),
        ...state.data.armor.map((item) => ({ type: 'armor', name: `${item.name} [${item.part}]`, text: item.rarity ?? '' })),
        ...state.data.decorations.map((item) => ({ type: 'deco', name: item.name, text: item.skill ?? '' })),
        ...state.data.events.map((item) => ({ type: 'event', name: item.name, text: item.description ?? '' })),
        ...state.data.monsters.map((item) => ({ type: 'monster', name: item.name, text: `★${item.star}` }))
      ];

      const hits = merged.filter((item) => `${item.name} ${item.text}`.toLowerCase().includes(keyword)).slice(0, 20);

      results.innerHTML = hits.length
        ? hits.map((hit) => `<div class="search-result-item"><strong>${hit.name}</strong><span>${hit.type}</span></div>`).join('')
        : '<p class="muted">該当なし</p>';
    });
  };

  /**
   * ボタンイベント類を束ねて登録
   */
  const bindActions = () => {
    byId('saveButton')?.addEventListener('click', saveLocal);
    byId('resetButton')?.addEventListener('click', resetLocal);

    byId('addCoinButton')?.addEventListener('click', () => {
      const amount = Number(byId('coinAmountInput')?.value ?? 0);
      const note = byId('coinNoteInput')?.value?.trim() || '手動加算';
      addCoins(amount, note);
      renderAll();
    });

    byId('subtractCoinButton')?.addEventListener('click', () => {
      const amount = Number(byId('coinAmountInput')?.value ?? 0);
      const note = byId('coinNoteInput')?.value?.trim() || '手動減算';
      if (!spendCoins(amount, note)) {
        alert('コインが不足しているか、数値が不正です。');
        return;
      }
      renderAll();
    });

    byId('drawWeaponButton')?.addEventListener('click', (event) => {
      const tier = normalizeGachaTier(byId('weaponGachaTier')?.value ?? 'bronze');
      const mode = byId('weaponGachaMode')?.value ?? 'ticket';
      const count = Number(byId('weaponDrawCount')?.value ?? 1);
      // 「ガチャ中...」→約1秒後に抽選（演出のみ。確率・ロジックは不変）
      runGachaWithEffect('weaponResultArea', event.currentTarget, () => drawWeaponGacha(tier, count, mode));
    });

    byId('drawArmorButton')?.addEventListener('click', (event) => {
      const tier = normalizeGachaTier(byId('armorGachaTier')?.value ?? 'bronze');
      const mode = byId('armorGachaMode')?.value ?? 'ticket';
      const count = Number(byId('armorDrawCount')?.value ?? 1);
      runGachaWithEffect('armorResultArea', event.currentTarget, () => drawArmorGacha(tier, count, mode));
    });

    byId('drawDecorationButton')?.addEventListener('click', (event) => {
      const mode = byId('decorationGachaMode')?.value ?? 'ticket';
      const count = Number(byId('decorationDrawCount')?.value ?? 1);
      runGachaWithEffect('decorationResultArea', event.currentTarget, () => drawDecorationGacha(count, mode));
    });

    byId('drawEventButton')?.addEventListener('click', async () => {
      const count = Number(byId('eventDrawCount')?.value ?? 3);
      await drawEventChoices(count);
    });

    byId('drawMonsterButton')?.addEventListener('click', drawMonster);
    byId('executeQurioButton')?.addEventListener('click', executeQurio);

    byId('addCharmButton')?.addEventListener('click', () => {
      const name = byId('charmNameInput')?.value?.trim() || '';
      const note = byId('charmNoteInput')?.value?.trim() || '';
      if (!name) {
        alert('お守り名を入力してください。');
        return;
      }
      const label = note ? `${name} / ${note}` : name;
      state.inventory.charms.push(label);
      const resultArea = byId('charmResultArea');
      if (resultArea) resultArea.innerHTML = `<div class="result-card"><strong>登録完了</strong><p>${escapeHtml(label)}</p></div>`;
      byId('charmNameInput').value = '';
      byId('charmNoteInput').value = '';
      renderAll();
    });

    byId('calcWeaponUpgradeButton')?.addEventListener('click', renderWeaponUpgradePreview);
    byId('applyWeaponUpgradeButton')?.addEventListener('click', async () => {
      const weaponId = byId('weaponUpgradeName')?.value;
      if (!weaponId) return;
      const selectedMode = await showSelectionModal({
        title: '進化方法を選択',
        description: '重複消費またはコイン進化を選んでください。',
        items: [
          { id: 'duplicate', title: '重複2本で進化', sub: '同じ武器2本を消費して無料で進化' },
          { id: 'coin', title: '200コインで進化', sub: '所持中の武器1本をコインで進化' }
        ],
        getTitle: (item) => item.title,
        getSubtitle: (item) => item.sub
      });
      if (!selectedMode) return;
      evolveWeapon({ weaponId, useCoins: selectedMode.id === 'coin' });
    });

    byId('calcArmorUpgradeButton')?.addEventListener('click', renderArmorUpgradePreview);
    byId('applyArmorUpgradeButton')?.addEventListener('click', () => {
      const armorId = byId('armorUpgradeName')?.value;
      if (!armorId) return;
      upgradeArmorByCoins(armorId);
    });

    byId('monsterListDimensionFilter')?.addEventListener('change', renderMonsterTable);
    byId('monsterListStarFilter')?.addEventListener('change', renderMonsterTable);
    byId('weaponUpgradeName')?.addEventListener('change', renderWeaponUpgradePreview);
    byId('armorUpgradeName')?.addEventListener('change', renderArmorUpgradePreview);

    ['weaponInventorySearch', 'armorInventorySearch', 'decorationInventorySearch', 'charmInventorySearch'].forEach((id) => {
      byId(id)?.addEventListener('input', renderInventories);
    });
    byId('historySearchInput')?.addEventListener('input', renderHistory);
  };

  /**
   * 高難度クエスト報酬の簡易適用
   * 必要であればコンソールから window.HDApp.grantHighDifficultyReward() を呼び出せる。
   */
  const grantHighDifficultyReward = () => {
    const count = Number(state.data.settings?.event?.high_difficulty_reward?.event_ticket ?? 1);
    state.inventory.eventTickets += count;
    pushLog('miscHistory', `高難度報酬: イベント発動権 +${count}`);
    renderAll();
  };

  /**
   * 初期化フロー
   */
  const init = async () => {
    const entries = Object.entries(JSON_PATHS);
    const payloadEntries = await Promise.all(entries.map(async ([key, path]) => [key, await fetchJsonSafe(key, path)]));
    const payloads = Object.fromEntries(payloadEntries);

    normalizeLoadedData(payloads);

    const saved = loadLocalSave();
    state.inventory = saved?.inventory ? normalizeInventory(saved.inventory) : normalizeInventory(state.data.inventoryTemplate);

    if (saved?.meta && typeof saved.meta === 'object') {
      state.meta = {
        armorLevels: safeObject(saved.meta.armorLevels),
        coinHistory: safeArray(saved.meta.coinHistory),
        gachaHistory: safeArray(saved.meta.gachaHistory),
        miscHistory: safeArray(saved.meta.miscHistory),
        latestEvent: saved.meta.latestEvent ?? null,
        latestMonster: saved.meta.latestMonster ?? null,
        loadErrors: state.meta.loadErrors
      };
    }

    bindNavigation();
    bindSearch();
    bindActions();
    if (!saved) applyStartingLoadout();
    renderAll();
    registerServiceWorker();

    // デバッグ / 外部呼び出し用
    window.HDApp = {
      state,
      saveLocal,
      resetLocal,
      drawWeaponGacha,
      drawArmorGacha,
      drawDecorationGacha,
      drawEventChoices,
      drawMonster,
      evolveWeapon,
      upgradeArmorByCoins,
      executeQurio,
      grantHighDifficultyReward
    };
  };

  document.addEventListener('DOMContentLoaded', init);
})();
