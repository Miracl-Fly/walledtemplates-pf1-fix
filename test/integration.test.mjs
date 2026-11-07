import { test } from "node:test";
import assert from "node:assert/strict";

import { createPf1HighlightWrapper } from "../scripts/lib.mjs";

/* ------------------------------------------------------------------ */
/* 用假对象复刻真实调用链：                                          */
/*   我们的 WRAPPER（最外层） → walledtemplates 的 WRAPPER → PF1 覆盖  */
/* ------------------------------------------------------------------ */

/**
 * 复刻 pf1.js 里 MeasuredTemplatePF._getGridHighlightPositions 的关键部分：
 * 守卫 + 返回自己的格子。这里不重算几何，只标记「PF1 分支跑了没有」。
 */
class FakeTemplatePF {
  constructor({ t = "circle", wallsBlock = true, x = 0, y = 0, cells, shape } = {}) {
    this.document = { t };
    this.wallsBlock = wallsBlock;
    this.measureStyle = true;
    this.isHexagonal = false;
    this.x = x;
    this.y = y;
    this.cells = cells ?? [{ x: 0, y: 0 }];
    this.shape = shape ?? { contains: () => true };
    this.seenShape = undefined;
  }

  _getGridHighlightPositions() {
    const t = this.document.t;
    this.seenShape = this.shape;
    // pf1 守卫：类型不是 circle/cone（六角格上的 cone）就回落核心
    if (!this.measureStyle || (t !== "circle" && (t !== "cone" || this.isHexagonal))) {
      return ["core-cell"];
    }
    return this.cells.slice();
  }
}

/** 复刻 walledtemplates/scripts/MeasuredTemplate.js:214-270 的关键几行 */
function walledtemplatesWrapper(wrapped) {
  let positions;
  const oldTemplateType = this.document.t;
  if (this.wallsBlock) this.document.t = "polygon";

  if (this.autotargetCenter === false) {
    // 非 center 方式：把 shape 换成外扩一格的矩形再取候选
    const oldShape = this.shape;
    this.shape = { contains: () => false, fake: "padded-rect" };
    positions = wrapped();
    this.shape = oldShape;
  } else {
    positions = wrapped();
  }

  this.document.t = oldTemplateType;
  return positions;
}

function runChain(template, { withFix = true, mode = "pf1", center = true } = {}) {
  template.autotargetCenter = center;
  const inner = () => template._getGridHighlightPositions();
  const walled = () => walledtemplatesWrapper.call(template, inner);
  if (!withFix) return walled();

  const ours = createPf1HighlightWrapper({
    getMode: () => mode,
    getSystemId: () => "pf1",
    isHexagonal: () => template.isHexagonal,
    getMeasureStyle: () => template.measureStyle,
    isCenterAutotarget: () => center,
    getGridCellSize: () => ({ sizeX: 100, sizeY: 100 }),
  });
  return ours.call(template, walled);
}

/* ------------------------------------------------------------------ */
/* 复现 + 修复                                                         */
/* ------------------------------------------------------------------ */

test("没装补丁：walledtemplates 把 t 改成 polygon，PF1 样式丢失（复现 bug）", () => {
  const tpl = new FakeTemplatePF({ t: "circle", cells: [{ x: 10, y: 10 }] });
  assert.deepEqual(runChain(tpl, { withFix: false }), ["core-cell"]);
});

test("装上补丁：circle 模板重新走 PF1 的 measureStyle 分支", () => {
  const tpl = new FakeTemplatePF({ t: "circle", cells: [{ x: 10, y: 10 }] });
  assert.deepEqual(runChain(tpl), [{ x: 10, y: 10 }]);
});

test("装上补丁：cone 模板（方格）同样恢复", () => {
  const tpl = new FakeTemplatePF({ t: "cone", cells: [{ x: 10, y: 10 }] });
  assert.deepEqual(runChain(tpl), [{ x: 10, y: 10 }]);
});

test("装上补丁：cone 模板在六角格上不介入（PF1 自己也会回落核心）", () => {
  const tpl = new FakeTemplatePF({ t: "cone" });
  tpl.isHexagonal = true;
  assert.deepEqual(runChain(tpl), ["core-cell"]);
});

test("装上补丁：rect 模板不介入", () => {
  const tpl = new FakeTemplatePF({ t: "rect" });
  assert.deepEqual(runChain(tpl), ["core-cell"]);
  assert.equal(tpl.document.t, "rect");
});

test("装上补丁：wallsBlock 为 false 时不介入（本来就没被改 t，PF1 原生就对）", () => {
  const cells = [{ x: 10, y: 10 }];
  const tpl = new FakeTemplatePF({ t: "circle", wallsBlock: false, cells });
  assert.deepEqual(runChain(tpl), cells, "PF1 原生分支照常工作");
  assert.equal(tpl.document.t, "circle");
  assert.equal(Object.hasOwn(tpl.document, "t"), true);
});

/* ------------------------------------------------------------------ */
/* 调用后不留痕迹                                                      */
/* ------------------------------------------------------------------ */

test("补丁跑完：document.t 归还为真实类型，且不留自有属性", () => {
  const tpl = new FakeTemplatePF({ t: "circle" });
  assert.equal(Object.hasOwn(tpl.document, "t"), true, "测试对象本身是自有属性");
  runChain(tpl);
  assert.equal(tpl.document.t, "circle");
  const desc = Object.getOwnPropertyDescriptor(tpl.document, "t");
  assert.deepEqual(desc, { value: "circle", writable: true, enumerable: true, configurable: true });
});

test("补丁跑完：shape 归还为真实形状", () => {
  const realShape = { contains: () => true, name: "real" };
  const tpl = new FakeTemplatePF({ t: "circle", shape: realShape });
  runChain(tpl);
  assert.equal(tpl.shape, realShape);
});

test("PF1 方法抛错时，document.t 也会被还原（finally 生效）", () => {
  const tpl = new FakeTemplatePF({ t: "circle" });
  tpl._getGridHighlightPositions = () => {
    throw new Error("boom");
  };
  assert.throws(() => runChain(tpl), /boom/);
  assert.equal(tpl.document.t, "circle");
  assert.equal(Object.hasOwn(tpl.document, "t"), true);
});

/* ------------------------------------------------------------------ */
/* 非 center 的自动选目标方式                                          */
/* ------------------------------------------------------------------ */

test("非 center 方式：walledtemplates 换 shape 的动作被挡下，PF1 看到的是真形状", () => {
  const realShape = { contains: () => true, name: "real" };
  const tpl = new FakeTemplatePF({ t: "circle", shape: realShape });
  runChain(tpl, { center: false });
  assert.equal(tpl.seenShape, realShape, "PF1 必须拿到真实形状，而不是外扩矩形");
  assert.equal(tpl.shape, realShape);
});

/* ------------------------------------------------------------------ */
/* 三种模式                                                            */
/* ------------------------------------------------------------------ */

test("模式 off：完全不介入，保持 walledtemplates 现状", () => {
  const tpl = new FakeTemplatePF({ t: "circle" });
  assert.deepEqual(runChain(tpl, { mode: "off" }), ["core-cell"]);
});

test("模式 pf1：按实际形状裁掉模板外的格子", () => {
  // 形状只包含模板局部原点：格心落在 (100,100) 世界坐标那一格才算数
  const shape = { contains: (x, y) => x === 0 && y === 0 };
  const cells = [
    { x: 50, y: 50 }, // 格心 (100,100) → 局部 (0,0) → 保留
    { x: 100, y: 100 }, // 格心 (150,150) → 局部 (50,50) → 砍掉
  ];
  const tpl = new FakeTemplatePF({ t: "circle", x: 100, y: 100, cells, shape });
  assert.deepEqual(runChain(tpl), [{ x: 50, y: 50 }]);
});

test("模式 pf1-full：保留 PF1 的完整圆形/锥形，不按墙体裁切", () => {
  const shape = { contains: (x, y) => x === 0 && y === 0 };
  const cells = [{ x: 50, y: 50 }, { x: 100, y: 100 }];
  const tpl = new FakeTemplatePF({ t: "circle", x: 100, y: 100, cells, shape });
  assert.deepEqual(runChain(tpl, { mode: "pf1-full" }), cells);
});

/* ------------------------------------------------------------------ */
/* 多次调用互不影响                                                    */
/* ------------------------------------------------------------------ */

test("连续多次调用结果稳定（幂等，不累积副作用）", () => {
  const tpl = new FakeTemplatePF({ t: "circle", cells: [{ x: 10, y: 10 }] });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(runChain(tpl), [{ x: 10, y: 10 }], `第 ${i + 1} 次`);
    assert.equal(tpl.document.t, "circle");
  }
});
