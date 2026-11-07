/* globals canvas, CONFIG, game, Hooks, libWrapper, PIXI */

/**
 * Walled Templates · PF1 兼容修复
 *
 * 目标（全部在独立模块里完成，不改 walledtemplates 的任何文件）：
 *
 * 1) 崩溃修复：walledtemplates 0.9.6 的扩散/反射代码仍在调用 PIXI.Point.pointFromKey，
 *    但它在 v13 移植时把该函数改名成了 PIXI.Point.invertKey，于是
 *      Uncaught TypeError: PIXI.Point.pointFromKey is not a function
 *    这里把缺失的名字补上（池化点语义与 invertKey 一致）。
 *
 * 2) 测量板样式修复：walledtemplates 为了让自己的候选格子不受系统覆盖影响，
 *    会把 document.t 临时改成 "polygon"（scripts/MeasuredTemplate.js:221）。
 *    PF1 的 MeasuredTemplatePF._getGridHighlightPositions 恰好按类型判断，
 *    类型一变成 polygon，PF1 的 measureStyle 分支就被跳过，回落到核心算法，
 *    于是测量板的高亮不再是 PF1 的样子。
 *    这里在这一次调用期间把 document.t 冻住，让 PF1 的覆盖重新跑起来。
 */

import {
  MODULE_ID,
  WT_ID,
  decodePointKey,
  freezeProperty,
  pf1StyleApplies,
  filterCellPositions,
  createPf1HighlightWrapper,
} from "./lib.mjs";

const GRID_HIGHLIGHT_METHOD = "_getGridHighlightPositions";
const SETTING_HIGHLIGHT_MODE = "highlightMode";

const state = {
  pointAliasReady: false,
  pointAliasAttempts: 0,
  wrapperRegistered: false,
  wrapperSkips: 0,
  wrapperRuns: 0,
  lastError: null,
};

/* ------------------------------------------------------------------ */
/* 1. PIXI.Point.pointFromKey 别名                                     */
/* ------------------------------------------------------------------ */

/**
 * walledtemplates 的调用点期望拿到一个「池化点」：WalledTemplateRectangle 里会直接
 * 对返回值调用 corner.release()。所以这里优先复用 PIXI.Point.invertKey / Point.tmp，
 * 拿不到才退回自建点。
 * @param {number} key
 * @returns {PIXI.Point}
 */
function pointFromKeyImpl(key) {
  const Point = globalThis.PIXI?.Point;
  if (!Point) throw new Error(`${MODULE_ID}: PIXI.Point 不可用`);

  if (typeof Point.invertKey === "function") return Point.invertKey(key);

  const { x, y } = decodePointKey(key);
  const out = typeof Point.tmp === "object" && Point.tmp ? Point.tmp : new Point(0, 0);
  out.x = x;
  out.y = y;
  return out;
}

/**
 * 幂等地补上 PIXI.Point.pointFromKey。
 * @returns {boolean} 是否已经就位
 */
function installPointFromKey() {
  if (state.pointAliasReady) return true;
  state.pointAliasAttempts++;

  const Point = globalThis.PIXI?.Point;
  if (!Point) return false;

  if (typeof Point.pointFromKey === "function") {
    state.pointAliasReady = true;
    return true;
  }

  try {
    Object.defineProperty(Point, "pointFromKey", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function pointFromKey(key) {
        return pointFromKeyImpl(key);
      },
    });
    state.pointAliasReady = true;
    console.log(`${MODULE_ID} | 已补上 PIXI.Point.pointFromKey（walledtemplates 缺失的别名）`);
    return true;
  } catch (err) {
    state.lastError = err;
    console.error(`${MODULE_ID} | 无法定义 PIXI.Point.pointFromKey`, err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 2. PF1 测量板样式                                                   */
/* ------------------------------------------------------------------ */

/**
 * 读设置，读不到就给默认值（避免在非 PF1 系统里抛错）。
 * @param {string} scope
 * @param {string} key
 * @param {*} fallback
 */
function getSetting(scope, key, fallback) {
  try {
    return game.settings.get(scope, key);
  } catch {
    return fallback;
  }
}

/** 当前模式：pf1（PF1 算法 + 按墙体形状裁切）/ pf1-full（PF1 算法不裁切）/ off */
function highlightMode() {
  const mode = getSetting(MODULE_ID, SETTING_HIGHLIGHT_MODE, "pf1");
  return ["pf1", "pf1-full", "off"].includes(mode) ? mode : "pf1";
}

/** walledtemplates 的自动选目标方式，默认 center（Settings 里默认值就是 "center"） */
function isCenterAutotarget() {
  const S = game.modules.get(WT_ID)?.api?.Settings;
  const center = S?.KEYS?.AUTOTARGET?.METHODS?.CENTER ?? "center";
  try {
    return (S?.autotargetMethod?.("circle") ?? center) === center;
  } catch {
    return true;
  }
}

/** 实际的 WRAPPER 主体（逻辑在 lib.mjs 里，注入了运行环境） */
const pf1GridHighlightWrapper = createPf1HighlightWrapper({
  getMode: () => highlightMode(),
  getSystemId: () => game.system?.id,
  isHexagonal: () => canvas.grid?.isHexagonal === true,
  getMeasureStyle: () => getSetting("pf1", "measureStyle", false) === true,
  isCenterAutotarget,
  getGridCellSize: () => {
    const grid = canvas.grid;
    return { sizeX: grid?.sizeX ?? grid?.size ?? 0, sizeY: grid?.sizeY ?? grid?.size ?? 0 };
  },
  onRun: () => {
    state.wrapperRuns++;
  },
  onSkip: () => {
    state.wrapperSkips++;
  },
});

/**
 * 用 libWrapper 的 priority 保证自己是最外层：libWrapper 按 priority 降序排，
 * 数值越大越靠外（lib-wrapper.js 里 sort 的比较是 t.priority - e.priority）。
 * 这样不管模块加载顺序如何，我们都能在 walledtemplates 之前拿到真实的 document.t，
 * 并让它的改写落空。
 */
function registerWrapper() {
  if (state.wrapperRegistered) return true;

  if (!globalThis.libWrapper?.register) {
    console.warn(`${MODULE_ID} | 没找到 lib-wrapper，测量板样式修复不生效`);
    return false;
  }

  const objClass = CONFIG.MeasuredTemplate?.objectClass;
  if (typeof objClass?.prototype?.[GRID_HIGHLIGHT_METHOD] !== "function") {
    console.warn(`${MODULE_ID} | ${objClass?.name ?? "?"} 没有 ${GRID_HIGHLIGHT_METHOD}，跳过样式修复`);
    return false;
  }

  const target = `CONFIG.MeasuredTemplate.objectClass.prototype.${GRID_HIGHLIGHT_METHOD}`;
  try {
    libWrapper.register(MODULE_ID, target, pf1GridHighlightWrapper, "WRAPPER", { priority: 100 });
    state.wrapperRegistered = true;
    console.log(`${MODULE_ID} | 已挂上 ${objClass.name}#${GRID_HIGHLIGHT_METHOD} 的兼容补丁`);
    return true;
  } catch (err) {
    state.lastError = err;
    console.error(`${MODULE_ID} | 注册 libWrapper 失败`, err);
    return false;
  }
}

/** 让画布上已有的模板重画高亮 */
function refreshTemplateHighlights() {
  const placeables = canvas?.templates?.placeables ?? [];
  for (const t of placeables) {
    try {
      canvas.interface?.grid?.clearHighlightLayer?.(t.highlightId);
      t.renderFlags?.set?.({ refreshGrid: true });
    } catch (err) {
      console.error(`${MODULE_ID} | 刷新模板高亮失败`, err);
    }
  }
  return placeables.length;
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_HIGHLIGHT_MODE, {
    name: `${MODULE_ID}.settings.highlightMode.Name`,
    hint: `${MODULE_ID}.settings.highlightMode.Hint`,
    scope: "world",
    config: true,
    type: String,
    choices: {
      pf1: `${MODULE_ID}.settings.highlightMode.Choices.pf1`,
      "pf1-full": `${MODULE_ID}.settings.highlightMode.Choices.pf1-full`,
      off: `${MODULE_ID}.settings.highlightMode.Choices.off`,
    },
    default: "pf1",
    onChange: () => refreshTemplateHighlights(),
  });

  installPointFromKey();
  registerWrapper();
});

// walledtemplates 在自己 init 的最后会 callAll 这个 hook，正好是它把几何补丁打完的时刻
Hooks.on("walledtemplatesReady", () => {
  installPointFromKey();
  if (!state.wrapperRegistered) registerWrapper();
});

Hooks.once("setup", () => {
  installPointFromKey();
});

Hooks.once("ready", () => {
  installPointFromKey();
  if (state.pointAliasReady) {
    console.log(
      `${MODULE_ID} | pointFromKey 就位；测量板样式补丁 ${state.wrapperRegistered ? "已启用" : "未启用"}`,
    );
  } else {
    console.error(`${MODULE_ID} | pointFromKey 仍未就位，walledtemplates 扩散模板可能崩溃`);
  }

  game.walledtemplatesPf1Fix = {
    state,
    installPointFromKey,
    refreshTemplateHighlights,
    api: { decodePointKey, pf1StyleApplies, filterCellPositions, freezeProperty },
  };
});

Hooks.on("canvasReady", () => {
  installPointFromKey();
});
