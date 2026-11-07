/**
 * walledtemplates-pf1-fix —— 纯逻辑层（不碰 game / canvas / PIXI，可在 node 里直接测）
 */

export const MODULE_ID = "walledtemplates-pf1-fix";
export const WT_ID = "walledtemplates";

/** walledtemplates 的 key 编码常量：x 左移 16 位，低 16 位放 y */
export const KEY_SCALE = 65536;

/**
 * 由整数 key 反解出坐标。
 * 与 walledtemplates/scripts/geometry/PIXI/Point.js 的 staticKey / invertKey 同一套编码：
 *   key = (Math.round(x) << 16) ^ Math.round(y)
 * @param {number} key
 * @returns {{x: number, y: number}}
 */
export function decodePointKey(key) {
  const x = key >> 16;
  return { x, y: key - (KEY_SCALE * x) };
}

/**
 * PF1 的 measureStyle 覆盖是否会生效。
 *
 * 对应 pf1.js 里 MeasuredTemplatePF._getGridHighlightPositions 的守卫：
 *   if ( !measureStyle || ("circle" !== t && ("cone" !== t || grid.isHexagonal)) ) return super...
 *
 * @param {object} state
 * @param {string} state.systemId        游戏系统 id
 * @param {string} state.templateType    模板类型（document.t）
 * @param {boolean} state.wallsBlock     该模板是否启用墙体阻挡（walledtemplates 的 getter）
 * @param {boolean} state.isHexagonal    是否六角格
 * @param {boolean} state.measureStyle   pf1 的「方格测量样式」设置
 * @returns {boolean}
 */
export function pf1StyleApplies({ systemId, templateType, wallsBlock, isHexagonal, measureStyle } = {}) {
  if (systemId !== "pf1") return false;
  // walledtemplates 只在 wallsBlock 为真时才会把 document.t 改成 "polygon"
  if (wallsBlock !== true) return false;
  if (measureStyle !== true) return false;
  if (templateType === "circle") return true;
  if (templateType === "cone") return !isHexagonal;
  return false;
}

/**
 * 把目标对象上的某个属性临时冻成一个固定值：读得到、写不进。
 * 用于在 walledtemplates 改 document.t / this.shape 的那段调用里，让它们改不动。
 *
 * @param {object} obj
 * @param {string} key
 * @param {*} value
 * @returns {() => void} 还原函数（可重复调用）
 */
export function freezeProperty(obj, key, value) {
  const noop = () => {};
  if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return noop;
  if (!key) return noop;

  const hadOwn = Object.prototype.hasOwnProperty.call(obj, key);
  const saved = hadOwn ? Object.getOwnPropertyDescriptor(obj, key) : undefined;

  try {
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: saved?.enumerable ?? true,
      get: () => value,
      set: () => {},
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | 冻结 ${key} 失败，跳过`, err);
    return noop;
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (saved) {
        Object.defineProperty(obj, key, saved);
        return;
      }
      delete obj[key];
      // 原来是原型上的访问器：删掉自有属性后应能读回原值；读不回就补写一次
      if (obj[key] !== value) obj[key] = value;
    } catch (err) {
      console.error(`${MODULE_ID} | 还原 ${key} 失败`, err);
    }
  };
}

/**
 * 把「格子左上角坐标」数组裁剪到给定形状内（用格子中心点判断）。
 * 依赖注入 contains / 偏移量，便于离线测试。
 *
 * @param {Array<{x:number,y:number}>} positions  格子左上角坐标（世界坐标）
 * @param {object} [geom]
 * @param {(x:number,y:number)=>boolean} [geom.contains]  形状在「模板局部坐标」下的包含判断
 * @param {number} [geom.offsetX]  模板 origin 的世界 x
 * @param {number} [geom.offsetY]  模板 origin 的世界 y
 * @param {number} [geom.halfX]    格子宽 / 2
 * @param {number} [geom.halfY]    格子高 / 2
 * @returns {Array<{x:number,y:number}>}
 */
export function filterCellPositions(positions, geom = {}) {
  if (!Array.isArray(positions)) return positions;
  const { contains, offsetX = 0, offsetY = 0, halfX = 0, halfY = 0 } = geom ?? {};
  if (typeof contains !== "function") return positions;
  return positions.filter((p) => {
    if (!p) return false;
    return contains(p.x + halfX - offsetX, p.y + halfY - offsetY);
  });
}

/**
 * 造一个 libWrapper 用的 WRAPPER：包住 MeasuredTemplate#_getGridHighlightPositions。
 *
 * 环境依赖全部注入，这样在 node 里就能把
 * 「walledtemplates 改 t → PF1 覆盖被跳过 → 我们把它救回来」整条链路真跑一遍。
 *
 * @param {object} deps
 * @param {() => string} [deps.getMode]              "pf1" | "pf1-full" | "off"
 * @param {() => string} [deps.getSystemId]
 * @param {() => boolean} [deps.isHexagonal]
 * @param {() => boolean} [deps.getMeasureStyle]
 * @param {() => boolean} [deps.isCenterAutotarget]
 * @param {() => {sizeX:number,sizeY:number}} [deps.getGridCellSize]
 * @param {(template:object, mode:string) => void} [deps.onRun]
 * @param {() => void} [deps.onSkip]
 * @returns {(wrapped: Function, ...args: any[]) => any}
 */
export function createPf1HighlightWrapper(deps = {}) {
  const {
    getMode = () => "pf1",
    getSystemId = () => undefined,
    isHexagonal = () => false,
    getMeasureStyle = () => false,
    isCenterAutotarget = () => true,
    getGridCellSize = () => ({ sizeX: 0, sizeY: 0 }),
    onRun,
    onSkip,
  } = deps;

  return function pf1GridHighlightWrapper(wrapped, ...args) {
    const mode = getMode();
    if (mode === "off") return wrapped(...args);

    const doc = this?.document;
    if (!doc) return wrapped(...args);

    const wantsPf1 = pf1StyleApplies({
      systemId: getSystemId(),
      templateType: doc.t,
      wallsBlock: this.wallsBlock === true,
      isHexagonal: isHexagonal() === true,
      measureStyle: getMeasureStyle() === true,
    });

    if (!wantsPf1) {
      onSkip?.();
      return wrapped(...args);
    }

    onRun?.(this, mode);

    // walledtemplates: if ( this.wallsBlock ) this.document.t = "polygon";
    const releaseType = freezeProperty(doc, "t", doc.t);
    // 非 center 方式下它还会把 this.shape 换成「外扩一格的矩形」，一并冻住
    const releaseShape =
      isCenterAutotarget() === true ? null : freezeProperty(this, "shape", this.shape);

    let positions;
    try {
      positions = wrapped(...args);
    } finally {
      releaseShape?.();
      releaseType();
    }

    if (mode === "pf1-full") return positions;

    // PF1 的圆/锥判断只看格心到原点的距离/角度，不看墙；
    // 被墙切过之后形状比整圆小，所以再按实际形状裁一次。
    const shape = this.shape;
    if (typeof shape?.contains !== "function") return positions;

    const { sizeX = 0, sizeY = 0 } = getGridCellSize() ?? {};
    return filterCellPositions(positions, {
      contains: (x, y) => shape.contains(x, y),
      offsetX: this.x ?? 0,
      offsetY: this.y ?? 0,
      halfX: sizeX / 2,
      halfY: sizeY / 2,
    });
  };
}
