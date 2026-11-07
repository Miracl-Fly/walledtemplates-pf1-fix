# Walled Templates · PF1 兼容修复（walledtemplates-pf1-fix）

不改动 `walledtemplates` 本体一个字节，用独立模块修两件事。

依赖：`walledtemplates`（0.9.6）+ `lib-wrapper`。

---

## 修的是什么

### 1. `PIXI.Point.pointFromKey is not a function` 崩溃

`walledtemplates 0.9.6` 把几何补丁从 v11 迁到 v13 时，把 `PIXI.Point.pointFromKey` 改名成了
`PIXI.Point.invertKey`，但有 3 个文件共 4 处调用点没跟着改：

| 文件 | 行 |
| --- | --- |
| `scripts/template_shapes/WalledTemplateCircle.js` | 76, 130, 134 |
| `scripts/template_shapes/WalledTemplateRectangle.js` | 77 |

模板撞到墙、需要做扩散/反射（`_generateSpreadsFromCorner`）时就会抛：

```
Uncaught TypeError: PIXI.Point.pointFromKey is not a function
```

本模块在 `init` 里把缺失的名字补上（幂等，已存在就不动）。实现优先复用
`PIXI.Point.invertKey`，拿不到才用同一套编码自己解：

```
key = (Math.round(x) << 16) ^ Math.round(y)    →    x = key >> 16, y = key - 65536 * x
```

返回值沿用 `PIXI.Point.tmp` 的池化点语义 —— `WalledTemplateRectangle.js:79` 会对它调用
`corner.release()`，所以不能返一个裸的新点。

### 2. 测量板不再是 PF1 的样子

`walledtemplates\scripts\MeasuredTemplate.js:214-247`，为了让自己的候选格子不被系统覆盖干扰，
它把模板类型临时改掉：

```js
const oldTemplateType = this.document.t;
if ( this.wallsBlock ) this.document.t = "polygon";   // ← 第 221 行
```

PF1 的覆盖恰好按类型判断（`pf1.js` 内 `MeasuredTemplatePF._getGridHighlightPositions`）：

```js
if ( !game.settings.get("pf1","measureStyle")
  || ("circle" !== t && ("cone" !== t || canvas.grid.isHexagonal)) )
    return super._getGridHighlightPositions();   // ← 这里被命中，PF1 的算法被跳过
```

于是 PF1 的「按格心到原点的距离/角度」高亮算法（`pf1.measureStyle`）静默失效，
换成核心算法 → 测量板高亮看起来就不是 PF1 的了。

本模块用 `libWrapper` 以 `priority: 100` 包住 `_getGridHighlightPositions`（libWrapper 按
priority 降序排列，数值越大越靠外，所以不受模块加载顺序影响），在这一次调用期间把
`document.t` 冻成真实类型 —— walledtemplates 那句赋值就落空了，PF1 的守卫重新通过。

`shape` 也一起冻住：walledtemplates 在「非 center」自动选目标方式下还会把 `this.shape`
换成外扩一格的矩形，PF1 拿到矩形会算错。

收尾时再加一步：PF1 的圆/锥判断只看格心到原点的距离/角度，**不看墙**，所以被墙切过的模板
会多出模板外的格子。默认模式会再用实际形状（`shape.contains`）裁一次。

---

## 设置

| 设置 | 说明 |
| --- | --- |
| **PF1 算法 + 按墙体形状裁切**（默认） | PF1 的算法，再裁掉模板形状外的格子 |
| **PF1 算法，不裁切** | 完整圆形/锥形，完全按 PF1 原版算 |
| **不干预** | 保持 walledtemplates 现状（等于停用第 2 项修复） |

改设置会立即刷新画布上已有模板的高亮，不用重开场景。

---

## 生效条件（不满足就完全不介入，不会添乱）

- 系统是 `pf1`
- 该模板启用了墙体阻挡（`wallsBlock === true`，也就是 walledtemplates 会去改 `t` 的前提）
- PF1 设置里「Measure Style」（`pf1.measureStyle`）是开着的（默认开）
- 模板类型是 `circle`，或方格上的 `cone`

其他情况一律原样 `wrapped()`。

---

## 调试

控制台里：

```js
game.walledtemplatesPf1Fix.state          // pointAliasReady / wrapperRegistered / wrapperRuns / wrapperSkips
game.walledtemplatesPf1Fix.refreshTemplateHighlights()
game.walledtemplatesPf1Fix.api.decodePointKey(65536 * 1200 + 300)   // {x: 1200, y: 300}
```

日志前缀统一是 `walledtemplates-pf1-fix |`。

---

## 离线测试

逻辑层（`scripts/lib.mjs`）不碰 `game` / `canvas` / `PIXI`，可以直接在 node 里跑：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test 'test\'
```

27 项，覆盖：

- key 编解码与 walledtemplates 的 `staticKey` 互逆（3600 组 + 实际像素坐标）
- `pf1StyleApplies` 与 `pf1.js` 守卫表达式逐格穷举等价（5 类型 × 六角 × measureStyle × wallsBlock）
- `freezeProperty`：自有数据属性 / 原型访问器两种情形，冻结期间写入落空、还原后描述符与 setter 恢复、
  异常路径不污染底层存储
- 格子裁剪的格心与 origin 偏移
- **调用链集成**：用假对象复刻 `walledtemplates 改 t → PF1 守卫 → 我们救回来`，
  含「没装补丁 → 复现 bug」「装上 → 恢复」「抛错时 t 仍被还原」「非 center 方式挡住 shape 替换」
  「连续多次调用幂等」

---

## 提醒

- 装完要**重启 Foundry 实例**（或在设置里重扫模块），新模块才会出现在模块列表里，然后手动启用。
- 本模块不保证 walledtemplates 以后升级还兼容；升级后若它的行号/写法变了，需要复查
  `MeasuredTemplate.js` 里那句 `this.document.t = "polygon"` 是否还在。
