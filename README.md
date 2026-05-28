# Mindful Coder

一个偏陪伴式、非打断的 VS Code 提醒扩展：

- 喝水提醒：默认每 40 分钟一次，可自定义，统计今日喝水次数
- 休息提醒：默认每 50 分钟一次，提醒站起来、看远处 20 秒、活动肩颈
- 久坐检测：基于 VS Code 内部活动近似判断连续工作时长
- 状态栏 Widget：持续显示喝水倒计时、久坐时长、休息状态
- 可视化今日统计面板：集中展示今日饮水、休息、专注时长、代码增量、文件触达数和下班倒计时

## 设计原则

- 不强制弹窗
- 不遮挡编辑器
- 不打断编码
- 通知只在需要时出现一次，持续提醒主要依赖状态栏

## 当前实现

- 底部状态栏显示：`💧 32min | 🪑 久坐1h20m | 👀 该休息了`
- 点击状态栏可打开快捷操作
- 可直接在快捷操作中修改喝水与休息提醒间隔
- 可打开可视化统计面板查看今日工作量，并设置下班时间
- 到点后可选：
   - 更醒目的 VS Code Warning Notification
  - 状态栏高亮提醒
  - 系统提示音（可选，尽力而为）
- 饮水次数和最近饮水/休息时间会保存在 `globalState`

## 配置项

在 VS Code Settings 中搜索 `Mindful Coder`：

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

## 命令

- `Mindful Coder: 打开提醒面板`
- `Mindful Coder: 设置喝水提醒间隔`
- `Mindful Coder: 设置休息提醒间隔`
- `Mindful Coder: 设置下班时间`
- `Mindful Coder: 记录喝水`
- `Mindful Coder: 记录休息`
- `Mindful Coder: 查看今日统计`
- `Mindful Coder: 重置久坐计时`

## 今日统计面板

- 展示今日喝水次数、休息次数、最近休息时间、当前连续工作时长
- 展示今日专注时长、工作跨度、编辑次数、触达文件数
- 展示新增/删除行数与字符数，作为当天代码工作量的近似参考
- 支持设置下班时间，显示下班倒计时或加班时长
- 到下班时间会主动打开今日统计面板，并给出更醒目的提醒

## 开发

1. 安装依赖

   ```bash
   npm install
   ```

2. 编译

   ```bash
   npm run compile
   ```

3. 按 `F5` 启动 Extension Development Host 调试扩展

## 久坐检测说明

VS Code 扩展无法直接读取全局键盘/鼠标事件，因此这里采用的是编辑器内部活动近似：

- 文档编辑
- 光标/选区变化
- 文本可见区域变化（例如滚动）
- 活动编辑器切换
- 可见编辑器变化
- 窗口失焦时暂停并重置连续工作时长

状态栏中的“未活跃”表示当前窗口未聚焦，或超过配置的空闲阈值没有检测到编辑器内活动；它不是摄像头或系统级键鼠层面的真实“离席检测”。

这能较好贴近“持续在 VS Code 内高强度工作”的状态，但不是操作系统级人体工学追踪。

统计面板中的“代码工作量”来自 VS Code 文档变更事件，是本地近似统计，不等同于 Git diff、提交记录或真实产出评估。

VS Code 扩展无法通过公共 API 做到“屏幕正中间、悬浮但不阻塞编辑器”的手机式系统弹窗。当前实现采用更醒目的 Warning Notification，并可主动打开统计面板，避免使用模态交互打断编码。