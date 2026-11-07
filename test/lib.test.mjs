import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEY_SCALE,
  decodePointKey,
  pf1StyleApplies,
  freezeProperty,
  filterCellPositions,
} from "../scripts/lib.mjs";

/* ------------------------------------------------------------------ */
/* key 编解码                                                          */
/* ------------------------------------------------------------------ */

// walledtemplates 自己的编码：staticKey(pt) = (Math.round(x) << 16) ^ Math.round(y)
const encode = (x, y) => (Math.round(x) << 16) ^ Math.round(y);

test("decodePointKey: 与 walledtemplates 的 staticKey 互为逆运算", () => {
  let checked = 0;
  for (let x = 0; x < 60; x++) {
    for (let y = 0; y < 60; y++) {
      const got = decodePointKey(encode(x, y));
      assert.deepEqual(got, { x, y }, `(${x},${y}) 解错`);
      checked++;
    }
  }
  assert.equal(checked, 3600);
});

test("decodePointKey: 实际像素坐标（画布格子坐标）", () => {
  const cases = [
    [100, 100],
    [1100, 2450],
    [0, 0],
    [6553, 80],
    [3721, 8192],
  ];
  for (const [x, y] of cases) {
    assert.deepEqual(decodePointKey(encode(x, y)), { x, y });
  }
});

test("KEY_SCALE 是 65536（左移 16 位）", () => {
  assert.equal(KEY_SCALE, 65536);
});

/* ------------------------------------------------------------------ */
/* PF1 覆盖是否生效                                                     */
/* ------------------------------------------------------------------ */

const base = {
  systemId: "pf1",
  templateType: "circle",
  wallsBlock: true,
  isHexagonal: false,
  measureStyle: true,
};

test("pf1StyleApplies: 只有 pf1 + 墙体阻挡 + 方格测量样式 + 圆/锥 才为真", () => {
  assert.equal(pf1StyleApplies(base), true);
  assert.equal(pf1StyleApplies({ ...base, templateType: "cone" }), true);
});

test("pf1StyleApplies: 任一条件不满足都为假", () => {
  assert.equal(pf1StyleApplies({ ...base, systemId: "dnd5e" }), false);
  assert.equal(pf1StyleApplies({ ...base, wallsBlock: false }), false);
  assert.equal(pf1StyleApplies({ ...base, wallsBlock: undefined }), false);
  assert.equal(pf1StyleApplies({ ...base, measureStyle: false }), false);
  assert.equal(pf1StyleApplies({ ...base, templateType: "rect" }), false);
  assert.equal(pf1StyleApplies({ ...base, templateType: "cone", isHexagonal: true }), false);
  assert.equal(pf1StyleApplies({ ...base, templateType: "polygon" }), false);
  assert.equal(pf1StyleApplies({}), false);
  assert.equal(pf1StyleApplies(), false);
});

test("pf1StyleApplies: 与 pf1.js 的守卫表达式等价", () => {
  // pf1 守卫：!measureStyle || (t !== "circle" && (t !== "cone" || isHexagonal)) → 走 super
  const types = ["circle", "cone", "rect", "ray", "polygon"];
  for (const templateType of types) {
    for (const isHexagonal of [false, true]) {
      for (const measureStyle of [false, true]) {
        for (const wallsBlock of [false, true]) {
          const fallbackToCore =
            !measureStyle || (templateType !== "circle" && (templateType !== "cone" || isHexagonal));
          const expected = wallsBlock === true && !fallbackToCore;
          assert.equal(
            pf1StyleApplies({ systemId: "pf1", templateType, wallsBlock, isHexagonal, measureStyle }),
            expected,
            `${templateType}/${isHexagonal}/${measureStyle}/${wallsBlock}`,
          );
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* freezeProperty                                                      */
/* ------------------------------------------------------------------ */

test("freezeProperty: 冻结自有数据属性，写入落空，还原后恢复原描述符", () => {
  const obj = { t: "circle" };
  const release = freezeProperty(obj, "t", "circle");

  assert.equal(obj.t, "circle");
  obj.t = "polygon";
  assert.equal(obj.t, "circle", "冻结期间写入必须无效");

  release();
  assert.equal(obj.t, "circle");
  assert.deepEqual(Object.getOwnPropertyDescriptor(obj, "t"), {
    value: "circle",
    writable: true,
    enumerable: true,
    configurable: true,
  });

  obj.t = "rect";
  assert.equal(obj.t, "rect", "还原后必须能正常写入");
});

test("freezeProperty: 冻结原型访问器，底层存储不被污染，还原后 setter 恢复", () => {
  class Doc {
    constructor() {
      this._source = { t: "circle" };
    }
    get t() {
      return this._source.t;
    }
    set t(v) {
      this._source.t = v;
    }
  }

  const doc = new Doc();
  const release = freezeProperty(doc, "t", doc.t);

  doc.t = "polygon";
  assert.equal(doc.t, "circle");
  assert.equal(doc._source.t, "circle", "冻结期间不能写进底层存储");

  release();
  assert.equal(doc.t, "circle");
  assert.equal(Object.hasOwn(doc, "t"), false, "还原后不应残留自有属性");

  doc.t = "ray";
  assert.equal(doc.t, "ray", "原型 setter 应恢复工作");
  assert.equal(doc._source.t, "ray");
});

test("freezeProperty: 重复调用还原函数是安全的", () => {
  const obj = { t: "circle" };
  const release = freezeProperty(obj, "t", "circle");
  release();
  release();
  assert.equal(obj.t, "circle");
});

test("freezeProperty: 非法入参直接返回空操作", () => {
  assert.equal(typeof freezeProperty(null, "t", 1), "function");
  assert.equal(typeof freezeProperty(undefined, "t", 1), "function");
  assert.equal(typeof freezeProperty({}, "", 1), "function");
  freezeProperty(null, "t", 1)();
});

/* ------------------------------------------------------------------ */
/* 格子裁剪                                                            */
/* ------------------------------------------------------------------ */

test("filterCellPositions: 没有 contains 时原样返回", () => {
  const positions = [{ x: 0, y: 0 }];
  assert.equal(filterCellPositions(positions, {}), positions);
  assert.equal(filterCellPositions(positions), positions);
  assert.equal(filterCellPositions(null, {}), null);
});

test("filterCellPositions: 按格心 + 模板 origin 偏移判断", () => {
  // 模板原点在 (100,100)，形状是局部坐标下半径 50 的圆，格子 100x100
  const contains = (x, y) => Math.hypot(x, y) <= 50;
  const geom = { contains, offsetX: 100, offsetY: 100, halfX: 50, halfY: 50 };

  // 格心 (150,150) → 局部 (50,50)，距原点 70.7 > 50 → 砍掉
  assert.deepEqual(filterCellPositions([{ x: 100, y: 100 }], geom), []);
  // 格心 (100,100) → 局部 (0,0) → 保留
  assert.deepEqual(filterCellPositions([{ x: 50, y: 50 }], geom), [{ x: 50, y: 50 }]);
  // 混合
  const kept = filterCellPositions(
    [
      { x: 50, y: 50 },
      { x: 100, y: 100 },
      { x: 0, y: 0 },
    ],
    geom,
  );
  assert.deepEqual(kept, [{ x: 50, y: 50 }]);
});

test("filterCellPositions: 空数组 / 脏元素不炸", () => {
  assert.deepEqual(filterCellPositions([], { contains: () => true }), []);
  assert.deepEqual(filterCellPositions([null, { x: 0, y: 0 }], { contains: () => true }), [
    { x: 0, y: 0 },
  ]);
});
