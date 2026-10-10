# Twelve Hour Timer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 使用用户选定的 12 张背景图，按指定顺序和文案将计时器扩展到 12 小时、36 阶段，完成本地检查后交付，不推送。

**Architecture:** 延续 index.html 单文件结构，原有 24 个资源保持原路径，新增资源追加图片文件并按指定位置插入 resources。以 resources.length 和 CYCLE_MS 推导时长上限，所有时间驱动的阶段索引在结束点停在最后阶段，刷新恢复与开发者模式使用同一时长上限。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Service Worker、Node 内置测试、Pillow 图片转码、Playwright 本地浏览器检查。

---

### Task 1: 选图检查与网页资源

**Files:** Create `images/25.webp` through `images/36.webp`; create `docs/background-sources.md`.

1. 核对 12 个“选择”文件唯一性、解码、方向和尺寸，查看缩略总览。
2. 按原比例缩至最长边 2560px，质量 88，生成 WebP；不放大，不修改原图。
3. 对照下载清单的 SHA256 匹配来源，记录作者、许可和原图哈希；无法匹配的注明用户提供。
4. 再次解码所有生成资源，核对比例与大小。

### Task 2: 时长与时间轴

**Files:** Modify `index.html`, `tests/regression.test.cjs`.

1. 先添加 36 阶段顺序、12 句文案、720 分钟边界、超过 8 小时的恢复以及结束阶段测试；执行 `node --test tests/regression.test.cjs` 确認新测试失败。
2. 插入资源并更新版本至 1.6.0；令 `MAX_DURATION_MINUTES = resources.length * CYCLE_MS / 60000`。
3. 小时滚轮生成至 12；开发者模式使用 MAX_DURATION_MINUTES，滑块上限为总时长秒数。
4. 加入 `getCycleIndex(elapsed)`，按总时长减一毫秒限制时间推导索引，用于自动计时、恢复及开发者时间轴；最后一个阶段不预取下一阶段。
5. 执行全部回归测试，确认导入、撤销与开始日期统计仍通过。

### Task 3: 文档、缓存与交付

**Files:** Modify `sw.js`, `README.md`, `.gitignore`; create source attribution document.

1. 缓存版本升级到 v3，设置中的资源数量与容量说明更新，忽略本地待选原图。
2. 更新当前功能说明和完整 36 阶段表，添加 v1.6.0 日志，保留旧版本日志。
3. 启动本地服务，用浏览器检查全部 36 阶段图片和新文案、12 小时结束点、720 分钟选择、超 8 小时恢复与移动尺寸等比显示。
4. 检查差异、原图哈希及无推送；将已验证内容同步到 D 盘项目，保留原始素材和本地记录，打开本地预览供用户检查。
