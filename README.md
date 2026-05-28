# Mindful Coder

Mindful Coder 是一个偏陪伴式、非打断的 VS Code 提醒扩展。

它把喝水提醒、休息提醒、久坐检测、状态栏提示和今日统计面板放在同一个工作流里，目标不是强行打断，而是在不遮挡编辑器的前提下，持续提醒你保持更健康的编码节奏。

## 项目状态

- 当前阶段：可用的早期公开版本
- 运行方式：本地开发调试或自行打包为 VS Code 扩展
- 适合人群：长时间在 VS Code 内连续编码，希望有轻提醒和工作节奏统计的人

## 核心特性

- 喝水提醒：默认每 40 分钟一次，可自定义，支持记录今日喝水次数
- 休息提醒：默认每 50 分钟一次，可提醒站起来、看远处 20 秒、活动肩颈
- 久坐检测：基于 VS Code 内部活动近似判断连续工作时长
- 状态栏 Widget：持续显示喝水倒计时、久坐时长、休息状态
- 今日统计面板：集中展示今日饮水、休息、专注时长、代码增量、文件触达数和下班倒计时
- 下班主动提醒：到下班时间会自动打开今日统计面板并主动提醒
- 忽略逻辑：提醒出现后 3 分钟未处理，或直接关闭，视为忽略本次并重新开始计时

## 设计原则

- 不强制弹窗
- 不遮挡编辑器
- 不使用模态交互打断编码
- 持续提醒优先依赖状态栏，通知只在必要时出现

## 安装与运行

### 本地开发调试

1. 克隆仓库

   ```bash
   git clone https://github.com/Leo-Dai13/mindful-coder-vscode.git
   cd mindful-coder-vscode
   ```

2. 安装依赖

   ```bash
   npm install
   ```

3. 编译扩展

   ```bash
   npm run compile
   ```

4. 在 VS Code 中按 `F5` 启动 Extension Development Host

### 快速开始

1. 启动扩展后，点击状态栏提示区域打开提醒面板
2. 设置喝水提醒、休息提醒和下班时间
3. 正常编码，状态栏会持续显示节奏信息
4. 使用 `Mindful Coder: 查看今日统计` 打开统计面板

## 功能说明

### 状态栏

- 默认聚合显示喝水提醒、久坐计时和休息提醒
- 到点时会高亮显示
- 点击后可打开快捷操作

### 通知提醒

- 喝水提醒默认使用信息提示
- 休息提醒、久坐提醒和下班提醒使用更醒目的 Warning Notification
- 可选系统提示音
- 通知在 3 分钟内未处理则自动视为忽略本次，并重新开始该轮计时
- 提醒采用串行调度，避免同一时间出现多个通知互相抢占

### 今日统计面板

- 展示今日喝水次数、休息次数和最近休息时间
- 展示当前连续工作时长、今日专注时长和工作跨度
- 展示新增/删除行数与字符数、编辑次数与触达文件数
- 展示下班倒计时或加班时长
- 到下班时间会主动打开统计面板

## 配置项

在 VS Code Settings 中搜索 Mindful Coder，或直接修改以下配置：

- `mindfulCoder.statusBar.enabled`
- `mindfulCoder.hydration.enabled`
- `mindfulCoder.hydration.intervalMinutes`
- `mindfulCoder.hydration.notification`
- `mindfulCoder.hydration.sound`
- `mindfulCoder.rest.enabled`
- `mindfulCoder.rest.intervalMinutes`
- `mindfulCoder.rest.notification`
- `mindfulCoder.rest.sound`
- `mindfulCoder.sedentary.enabled`
- `mindfulCoder.sedentary.thresholdMinutes`
- `mindfulCoder.sedentary.idleResetMinutes`
- `mindfulCoder.sedentary.notification`
- `mindfulCoder.sedentary.sound`
- `mindfulCoder.workday.endTime`

所有分钟类配置目前最小值均为 1 分钟，便于快速验证提醒行为。

## 命令

- `Mindful Coder: 打开提醒面板`
- `Mindful Coder: 设置喝水提醒间隔`
- `Mindful Coder: 设置休息提醒间隔`
- `Mindful Coder: 设置下班时间`
- `Mindful Coder: 记录喝水`
- `Mindful Coder: 记录休息`
- `Mindful Coder: 查看今日统计`
- `Mindful Coder: 重置久坐计时`

## 实现边界与限制

### 久坐检测

VS Code 扩展无法直接读取全局键盘或鼠标事件，因此当前实现使用编辑器内部活动近似判断：

- 文档编辑
- 光标或选区变化
- 文本可见区域变化，例如滚动
- 活动编辑器切换
- 可见编辑器变化
- 窗口失焦时暂停并重置连续工作时长

这能较好贴近“持续在 VS Code 内高强度工作”的状态，但不是操作系统级人体工学追踪。

### 工作量统计

统计面板中的代码工作量来自 VS Code 文档变更事件，是本地近似统计，不等同于 Git diff、提交记录或真实产出评估。

### 弹窗能力

VS Code 扩展无法通过公共 API 做到“屏幕正中间、悬浮但不阻塞编辑器”的手机式系统弹窗。当前实现采用更醒目的 Warning Notification，并结合状态栏高亮与统计面板主动打开来降低打断感。

## 开发

### 常用命令

```bash
npm install
npm run compile
```

### 调试

- 在 VS Code 中按 `F5` 启动 Extension Development Host
- 修改后重新编译，或配合 watch 模式迭代开发

## 贡献

欢迎提交 Issue 和 Pull Request。

如果你要提交较大的功能改动，建议先开一个 Issue 讨论目标、交互方式和实现边界，避免和项目当前的“非打断式提醒”方向偏离。

## 路线图

- 更完善的统计视图
- 更细粒度的提醒策略
- 更稳定的扩展打包与发布流程

## 许可证

本项目使用 MIT License。

完整条款见根目录的 LICENSE 文件。
