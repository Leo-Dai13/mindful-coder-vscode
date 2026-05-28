import * as vscode from 'vscode';
import { exec } from 'child_process';

const MINUTE_MS = 60 * 1000;
const SNOOZE_MS = 10 * MINUTE_MS;
const TICK_INTERVAL_MS = 15 * 1000;
const NOTIFICATION_IGNORE_MS = 3 * MINUTE_MS;
const notificationTimedOut = '__notification_timed_out__' as const;
const HYDRATION_STATE_KEY = 'mindfulCoder.hydrationState';
const REST_STATE_KEY = 'mindfulCoder.restState';
const WORK_STATS_STATE_KEY = 'mindfulCoder.workStatsState';

interface TimedReminderConfig {
  enabled: boolean;
  intervalMinutes: number;
  notification: boolean;
  sound: boolean;
}

interface SedentaryConfig {
  enabled: boolean;
  thresholdMinutes: number;
  idleResetMinutes: number;
  notification: boolean;
  sound: boolean;
}

interface AppConfig {
  statusBar: {
    enabled: boolean;
  };
  hydration: TimedReminderConfig;
  rest: TimedReminderConfig;
  sedentary: SedentaryConfig;
  workday: {
    endTime: string;
  };
}

interface HydrationState {
  dateKey: string;
  todayCount: number;
  lastDrinkAt: number;
  snoozeUntil?: number;
  lastNotifiedAt?: number;
}

interface RestState {
  lastBreakAt: number;
  snoozeUntil?: number;
  lastNotifiedAt?: number;
}

interface ActivitySnapshot {
  active: boolean;
  continuousActiveMs: number;
  sessionStartAt?: number;
  lastActivityAt?: number;
}

interface WorkStatsState {
  dateKey: string;
  workdayStartAt?: number;
  activeMsAccumulated: number;
  lastAccumulatedAt?: number;
  lastActivityAt?: number;
  lastBreakAt?: number;
  lastOffWorkNotifiedAt?: number;
  breakCount: number;
  editCount: number;
  filesTouched: string[];
  charsAdded: number;
  charsRemoved: number;
  linesAdded: number;
  linesRemoved: number;
}

interface DashboardModel {
  titleDate: string;
  workloadSummary: string;
  workdayStart: string;
  hydrationCount: string;
  breakCount: string;
  lastBreak: string;
  focusTime: string;
  focusRatio: string;
  currentStreak: string;
  workSpan: string;
  offWorkLabel: string;
  offWorkDetail: string;
  progressPercent: number;
  isOverdue: boolean;
  linesSummary: string;
  charsSummary: string;
  netLines: string;
  editCount: string;
  filesTouched: string;
}

interface StatsPanelOptions {
  viewColumn?: vscode.ViewColumn;
  preserveFocus?: boolean;
}

type ReminderKind = 'hydration' | 'rest' | 'sedentary' | 'offWork';

interface ReminderPanelModel {
  title: string;
  headline: string;
  message: string;
  severity: 'info' | 'warning';
  actions: string[];
}

class ActivityTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private focused = vscode.window.state.focused;
  private lastActivityAt?: number;
  private sessionStartAt?: number;

  constructor(
    private config: AppConfig,
    private readonly onDidChange: () => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
          this.recordActivity();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.recordActivity();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.recordActivity();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (editors.length > 0) {
          this.recordActivity();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        this.recordActivity();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        this.handleWindowState(state);
      }),
    );

    if (this.focused && vscode.window.activeTextEditor) {
      this.recordActivity();
    }
  }

  public updateConfig(config: AppConfig): void {
    this.config = config;
    this.cleanupIdle();
    this.onDidChange();
  }

  public resetSession(now = Date.now()): void {
    if (!this.focused) {
      this.lastActivityAt = undefined;
      this.sessionStartAt = undefined;
      this.onDidChange();
      return;
    }

    this.lastActivityAt = now;
    this.sessionStartAt = now;
    this.onDidChange();
  }

  public getSnapshot(now = Date.now()): ActivitySnapshot {
    this.cleanupIdle(now);

    if (!this.focused || !this.lastActivityAt || !this.sessionStartAt) {
      return {
        active: false,
        continuousActiveMs: 0,
      };
    }

    return {
      active: true,
      continuousActiveMs: now - this.sessionStartAt,
      sessionStartAt: this.sessionStartAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private recordActivity(): void {
    if (!this.focused) {
      return;
    }

    const now = Date.now();
    const idleResetMs = this.getIdleResetMs();

    if (!this.lastActivityAt || !this.sessionStartAt || now - this.lastActivityAt > idleResetMs) {
      this.sessionStartAt = now;
    }

    this.lastActivityAt = now;
    this.onDidChange();
  }

  private handleWindowState(state: vscode.WindowState): void {
    this.focused = state.focused;

    if (!state.focused) {
      this.lastActivityAt = undefined;
      this.sessionStartAt = undefined;
    }

    this.onDidChange();
  }

  private cleanupIdle(now = Date.now()): void {
    if (!this.focused || !this.lastActivityAt) {
      return;
    }

    if (now - this.lastActivityAt > this.getIdleResetMs()) {
      this.lastActivityAt = undefined;
      this.sessionStartAt = undefined;
    }
  }

  private getIdleResetMs(): number {
    return Math.max(1, this.config.sedentary.idleResetMinutes) * MINUTE_MS;
  }
}

class MindfulController implements vscode.Disposable {
  private config = readConfig();
  private hydrationState: HydrationState;
  private restState: RestState;
  private workStatsState: WorkStatsState;
  private readonly statusBar = vscode.window.createStatusBarItem('mindfulCoder.status', vscode.StatusBarAlignment.Right, 100);
  private readonly activityTracker: ActivityTracker;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tickHandle: ReturnType<typeof setInterval>;
  private sedentaryLastSessionStart?: number;
  private sedentarySnoozeUntil?: number;
  private sedentaryLastNotifiedAt?: number;
  private statsPanel?: vscode.WebviewPanel;
  private readonly reminderPanels = new Map<ReminderKind, vscode.WebviewPanel>();
  private pendingReminderCheckHandle?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const now = Date.now();
    this.hydrationState = normalizeHydrationState(context.globalState.get<HydrationState>(HYDRATION_STATE_KEY), now);
    this.restState = normalizeRestState(context.globalState.get<RestState>(REST_STATE_KEY), now);
    this.workStatsState = normalizeWorkStatsState(context.globalState.get<WorkStatsState>(WORK_STATS_STATE_KEY), now);
    this.activityTracker = new ActivityTracker(this.config, () => {
      this.scheduleReminderCheck();
    });

    this.statusBar.name = 'Mindful Coder';
    this.statusBar.command = 'mindfulCoder.openControls';
    this.statusBar.show();

    this.registerCommands();

    this.disposables.push(
      this.statusBar,
      this.activityTracker,
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
          this.captureDocumentStats(event);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mindfulCoder')) {
          void this.reloadConfiguration();
        }
      }),
    );

    this.tickHandle = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);

    this.disposables.push(new vscode.Disposable(() => {
      clearInterval(this.tickHandle);
    }));

    this.disposables.push(new vscode.Disposable(() => {
      if (this.pendingReminderCheckHandle) {
        clearTimeout(this.pendingReminderCheckHandle);
        this.pendingReminderCheckHandle = undefined;
      }
    }));

    this.disposables.push(new vscode.Disposable(() => {
      for (const panel of this.reminderPanels.values()) {
        panel.dispose();
      }
      this.reminderPanels.clear();
    }));

    void this.tick();
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('mindfulCoder.openControls', async () => {
        await this.openControls();
      }),
      vscode.commands.registerCommand('mindfulCoder.setHydrationInterval', async () => {
        await this.promptForInterval('hydration');
      }),
      vscode.commands.registerCommand('mindfulCoder.setRestInterval', async () => {
        await this.promptForInterval('rest');
      }),
      vscode.commands.registerCommand('mindfulCoder.setWorkdayEndTime', async () => {
        await this.promptForWorkdayEndTime();
      }),
      vscode.commands.registerCommand('mindfulCoder.markHydrated', async () => {
        await this.markHydrated('manual');
      }),
      vscode.commands.registerCommand('mindfulCoder.takeBreakNow', async () => {
        await this.markBreakTaken('manual');
      }),
      vscode.commands.registerCommand('mindfulCoder.showStats', async () => {
        await this.showStats();
      }),
      vscode.commands.registerCommand('mindfulCoder.resetSedentaryTimer', async () => {
        await this.resetSedentaryTimer();
      }),
    );
  }

  private async reloadConfiguration(): Promise<void> {
    this.config = readConfig();
    this.activityTracker.updateConfig(this.config);
    this.hydrationState = normalizeHydrationState(this.hydrationState);
    this.restState = normalizeRestState(this.restState);
    this.workStatsState = normalizeWorkStatsState(this.workStatsState);
    await this.persistStates();
    const now = Date.now();
    const snapshot = this.refreshUi(now);
    await this.maybeNotify(now, snapshot);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const snapshot = this.refreshUi(now);
    await this.saveWorkStatsState();
    await this.maybeNotify(now, snapshot);
  }

  private refreshUi(now = Date.now()): ActivitySnapshot {
    this.resetDailyIfNeeded(now);
    const snapshot = this.syncSedentarySession(this.activityTracker.getSnapshot(now));
    this.syncWorkStats(now, snapshot);
    this.updateStatusBar(now, snapshot);
    this.updateStatsPanel(now, snapshot);
    return snapshot;
  }

  private scheduleReminderCheck(): void {
    if (this.pendingReminderCheckHandle) {
      return;
    }

    this.pendingReminderCheckHandle = setTimeout(() => {
      this.pendingReminderCheckHandle = undefined;
      const now = Date.now();
      const snapshot = this.refreshUi(now);
      void this.maybeNotify(now, snapshot);
    }, 0);
  }

  private resetDailyIfNeeded(now = Date.now()): void {
    const currentDateKey = getLocalDateKey(new Date(now));
    if (this.hydrationState.dateKey === currentDateKey) {
      return;
    }

    this.hydrationState = {
      ...this.hydrationState,
      dateKey: currentDateKey,
      todayCount: 0,
    };
    this.workStatsState = createEmptyWorkStatsState(currentDateKey);
    void this.saveHydrationState();
    void this.saveWorkStatsState();
  }

  private syncSedentarySession(snapshot: ActivitySnapshot): ActivitySnapshot {
    if (snapshot.sessionStartAt !== this.sedentaryLastSessionStart) {
      this.sedentaryLastSessionStart = snapshot.sessionStartAt;
      this.sedentarySnoozeUntil = undefined;
      this.sedentaryLastNotifiedAt = undefined;
    }

    return snapshot;
  }

  private updateStatusBar(now = Date.now(), snapshot = this.syncSedentarySession(this.activityTracker.getSnapshot(now))): void {
    if (!this.config.statusBar.enabled) {
      this.statusBar.hide();
      return;
    }

    this.statusBar.show();

    const segments = [
      this.buildHydrationSegment(now),
      this.buildRestSegment(now),
    ].filter((segment) => segment.length > 0);

    this.statusBar.text = segments.join(' | ');
    this.statusBar.tooltip = this.buildTooltip(now, snapshot);

    const isWarning = this.isHydrationDue(now) || this.isRestDue(now);
    this.statusBar.backgroundColor = isWarning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusBar.color = isWarning ? new vscode.ThemeColor('statusBarItem.warningForeground') : undefined;
  }

  private buildTooltip(now: number, snapshot: ActivitySnapshot): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**Mindful Coder**\n\n');
    tooltip.appendMarkdown(`饮水：今日 **${this.hydrationState.todayCount}** 次，${this.describeHydration(now)}\n\n`);
    tooltip.appendMarkdown(`休息：${this.describeRest(now)}\n\n`);
    tooltip.appendMarkdown(`工作：今日专注 **${formatDurationLong(this.workStatsState.activeMsAccumulated)}**，编辑 **${this.workStatsState.editCount}** 次\n\n`);
    tooltip.appendMarkdown('点击状态栏可打开快捷操作。');
    return tooltip;
  }

  private buildHydrationSegment(now: number): string {
    if (!this.config.hydration.enabled) {
      return '💧 已关';
    }

    const remainingMs = this.getHydrationDueAt() - now;
    if (remainingMs <= 0) {
      return '💧 该喝水了';
    }

    return `💧 ${formatCountdown(remainingMs)}`;
  }

  private buildRestSegment(now: number): string {
    if (!this.config.rest.enabled) {
      return '👀 已关';
    }

    const remainingMs = this.getRestDueAt() - now;
    if (remainingMs <= 0) {
      return '👀 该休息了';
    }

    return `👀 ${formatCountdown(remainingMs)}`;
  }

  private describeHydration(now: number): string {
    if (!this.config.hydration.enabled) {
      return '已关闭';
    }

    const remainingMs = this.getHydrationDueAt() - now;
    if (remainingMs <= 0) {
      return '当前已到提醒时间';
    }

    return `${formatCountdown(remainingMs)} 后提醒，下次到点 ${formatClock(this.getHydrationDueAt())}`;
  }

  private describeRest(now: number): string {
    if (!this.config.rest.enabled) {
      return '已关闭';
    }

    const remainingMs = this.getRestDueAt() - now;
    if (remainingMs <= 0) {
      return '当前已到提醒时间';
    }

    return `${formatCountdown(remainingMs)} 后提醒，下次到点 ${formatClock(this.getRestDueAt())}`;
  }

  private async maybeNotify(now: number, snapshot: ActivitySnapshot): Promise<void> {
    const notifications: Promise<void>[] = [];

    if (this.shouldNotifyOffWorkSummary(now)) {
      notifications.push(this.notifyOffWorkSummary(now));
    }

    if (this.shouldNotifySedentary(now, snapshot)) {
      notifications.push(this.notifySedentary(now, snapshot));
    }

    if (this.shouldNotifyRest(now)) {
      notifications.push(this.notifyRest(now));
    }

    if (this.shouldNotifyHydration(now)) {
      notifications.push(this.notifyHydration(now));
    }

    if (notifications.length > 0) {
      await Promise.all(notifications);
    }
  }

  private shouldNotifyHydration(now: number): boolean {
    if (!this.config.hydration.enabled || !this.config.hydration.notification) {
      return false;
    }

    if (this.reminderPanels.has('hydration')) {
      return false;
    }

    const dueAt = this.getHydrationDueAt();
    return now >= dueAt && (this.hydrationState.lastNotifiedAt ?? 0) < dueAt;
  }

  private shouldNotifyRest(now: number): boolean {
    if (!this.config.rest.enabled || !this.config.rest.notification) {
      return false;
    }

    if (this.reminderPanels.has('rest')) {
      return false;
    }

    const dueAt = this.getRestDueAt();
    return now >= dueAt && (this.restState.lastNotifiedAt ?? 0) < dueAt;
  }

  private shouldNotifySedentary(now: number, snapshot: ActivitySnapshot): boolean {
    if (!this.config.sedentary.enabled || !this.config.sedentary.notification) {
      return false;
    }

    if (this.reminderPanels.has('sedentary')) {
      return false;
    }

    const dueAt = this.getSedentaryDueAt(snapshot);
    return dueAt !== undefined && now >= dueAt && (this.sedentaryLastNotifiedAt ?? 0) < dueAt;
  }

  private shouldNotifyOffWorkSummary(now: number): boolean {
    if (!this.hasWorkdayStats()) {
      return false;
    }

    if (this.reminderPanels.has('offWork')) {
      return false;
    }

    const dueAt = getWorkdayEndTimestamp(now, this.config.workday.endTime);
    if (dueAt === undefined) {
      return false;
    }

    return now >= dueAt && (this.workStatsState.lastOffWorkNotifiedAt ?? 0) < dueAt;
  }

  private async notifyHydration(now: number): Promise<void> {
    this.hydrationState.lastNotifiedAt = now;
    await this.saveHydrationState();
    await this.showNotification(
      'hydration',
      '喝水提醒',
      'info',
      this.config.hydration.sound,
      '喝口水，顺便活动一下肩颈。',
      ['已喝水', '稍后10分钟', '查看统计'],
      async (selection) => {
        if (selection === '已喝水') {
          await this.markHydrated('notification');
          return;
        }

        if (selection === '稍后10分钟') {
          await this.snoozeHydration();
          return;
        }

        if (selection === '查看统计') {
          await this.showStats();
        }
      },
      async (ignoredAt) => {
        await this.ignoreHydrationReminder(ignoredAt);
      },
    );
  }

  private async notifyRest(now: number): Promise<void> {
    this.restState.lastNotifiedAt = now;
    await this.saveRestState();
    await this.showNotification(
      'rest',
      '休息提醒',
      'warning',
      this.config.rest.sound,
      '该休息一下了：站起来、看远处20秒、活动肩颈。',
      ['已休息', '稍后10分钟', '查看统计'],
      async (selection) => {
        if (selection === '已休息') {
          await this.markBreakTaken('notification');
          return;
        }

        if (selection === '稍后10分钟') {
          await this.snoozeRest();
          return;
        }

        if (selection === '查看统计') {
          await this.showStats();
        }
      },
      async (ignoredAt) => {
        await this.ignoreRestReminder(ignoredAt);
      },
    );
  }

  private async notifySedentary(now: number, snapshot: ActivitySnapshot): Promise<void> {
    this.sedentaryLastNotifiedAt = now;
    await this.showNotification(
      'sedentary',
      '久坐提醒',
      'warning',
      this.config.sedentary.sound,
      `你已经连续工作 ${formatDurationCompact(snapshot.continuousActiveMs)} 了，建议起身动一动。`,
      ['已活动', '稍后10分钟'],
      async (selection) => {
        if (selection === '已活动') {
          await this.resetSedentaryTimer();
          return;
        }

        if (selection === '稍后10分钟') {
          this.sedentarySnoozeUntil = now + SNOOZE_MS;
          this.updateStatusBar();
          this.flashStatus('久坐提醒已稍后10分钟');
        }
      },
      async (ignoredAt) => {
        await this.ignoreSedentaryReminder(ignoredAt);
      },
    );
  }

  private async notifyOffWorkSummary(now: number): Promise<void> {
    this.workStatsState.lastOffWorkNotifiedAt = now;
    await this.saveWorkStatsState();
    await this.openStatsPanel({
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
    });
    await this.showNotification(
      'offWork',
      '下班提醒',
      'warning',
      false,
      '到下班时间了，已为你打开今日统计。',
      ['查看统计'],
      async (selection) => {
        if (selection === '查看统计') {
          await this.openStatsPanel({
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
          });
        }
      },
      async () => {
        this.updateStatusBar();
      },
    );
  }

  private async showNotification(
    kind: ReminderKind,
    title: string,
    severity: 'info' | 'warning',
    playSoundEnabled: boolean,
    message: string,
    items: string[],
    onSelection: (selection: string | undefined) => Promise<void>,
    onIgnored: (ignoredAt: number) => Promise<void>,
  ): Promise<void> {
    if (this.reminderPanels.has(kind)) {
      return;
    }

    this.flashStatus(message);

    if (playSoundEnabled) {
      playNotificationSound();
    }

    try {
      const selection = await this.showReminderPanel(kind, {
        title,
        headline: severity === 'warning' ? '需要你看一眼' : '轻提醒',
        message,
        severity,
        actions: items,
      });

      if (selection === notificationTimedOut || selection === undefined) {
        await onIgnored(Date.now());
        return;
      }

      await onSelection(selection);
    } finally {
      this.updateStatusBar();
    }
  }

  private async showReminderPanel(kind: ReminderKind, model: ReminderPanelModel): Promise<string | undefined | typeof notificationTimedOut> {
    if (this.reminderPanels.has(kind)) {
      return undefined;
    }

    const viewColumn = this.reminderPanels.size === 0
      ? vscode.ViewColumn.Active
      : vscode.ViewColumn.Beside;

    const panel = vscode.window.createWebviewPanel(
      `mindfulCoder.reminder.${kind}`,
      `Mindful Coder ${model.title}`,
      { viewColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      },
    );

    this.reminderPanels.set(kind, panel);
    panel.webview.html = this.getReminderWebviewHtml(panel.webview, model);

    return await new Promise<string | undefined | typeof notificationTimedOut>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const finalize = (result: string | undefined | typeof notificationTimedOut): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        if (this.reminderPanels.get(kind) === panel) {
          this.reminderPanels.delete(kind);
        }

        resolve(result);
      };

      timeoutHandle = setTimeout(() => {
        finalize(notificationTimedOut);
        panel.dispose();
      }, NOTIFICATION_IGNORE_MS);

      panel.onDidDispose(() => {
        if (!settled) {
          finalize(undefined);
          return;
        }

        if (this.reminderPanels.get(kind) === panel) {
          this.reminderPanels.delete(kind);
        }
      }, undefined, this.disposables);

      panel.webview.onDidReceiveMessage((message: { action?: string }) => {
        if (!message.action) {
          return;
        }

        if (message.action === '查看统计') {
          void this.openStatsPanel({
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false,
          });
          return;
        }

        finalize(message.action);
        panel.dispose();
      }, undefined, this.disposables);
    });
  }

  private async ignoreHydrationReminder(ignoredAt: number): Promise<void> {
    this.hydrationState = {
      ...this.hydrationState,
      snoozeUntil: ignoredAt + this.config.hydration.intervalMinutes * MINUTE_MS,
    };
    await this.saveHydrationState();
    this.flashStatus('已忽略本次喝水提醒，重新开始计时');
    this.updateStatusBar();
  }

  private async ignoreRestReminder(ignoredAt: number): Promise<void> {
    this.restState = {
      ...this.restState,
      snoozeUntil: ignoredAt + this.config.rest.intervalMinutes * MINUTE_MS,
    };
    await this.saveRestState();
    this.flashStatus('已忽略本次休息提醒，重新开始计时');
    this.updateStatusBar();
  }

  private async ignoreSedentaryReminder(ignoredAt: number): Promise<void> {
    this.sedentarySnoozeUntil = undefined;
    this.sedentaryLastNotifiedAt = undefined;
    this.activityTracker.resetSession(ignoredAt);
    this.flashStatus('已忽略本次久坐提醒，重新开始计时');
    this.updateStatusBar();
  }

  private async openControls(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(cup) 记录已喝水',
          description: `今日第 ${this.hydrationState.todayCount + 1} 次`,
          action: 'hydrated',
        },
        {
          label: '$(eye) 记录已休息',
          description: '重置休息提醒和久坐计时',
          action: 'rest',
        },
        {
          label: '$(watch) 喝水提醒稍后10分钟',
          description: '延后本轮喝水提醒',
          action: 'snoozeHydration',
        },
        {
          label: '$(settings-gear) 设置喝水提醒间隔',
          description: `当前 ${this.config.hydration.intervalMinutes} 分钟`,
          action: 'setHydrationInterval',
        },
        {
          label: '$(clock) 休息提醒稍后10分钟',
          description: '延后本轮休息提醒',
          action: 'snoozeRest',
        },
        {
          label: '$(settings-gear) 设置休息提醒间隔',
          description: `当前 ${this.config.rest.intervalMinutes} 分钟`,
          action: 'setRestInterval',
        },
        {
          label: '$(calendar) 设置下班时间',
          description: `当前 ${this.config.workday.endTime}`,
          action: 'setWorkdayEndTime',
        },
        {
          label: '$(debug-restart) 重置久坐计时',
          description: '开始新的连续工作段',
          action: 'resetSedentary',
        },
        {
          label: '$(graph) 查看今日统计',
          description: '打开可视化统计面板',
          action: 'stats',
        },
      ],
      {
        placeHolder: 'Mindful Coder 快捷操作',
      },
    );

    switch (choice?.action) {
      case 'hydrated':
        await this.markHydrated('manual');
        break;
      case 'rest':
        await this.markBreakTaken('manual');
        break;
      case 'snoozeHydration':
        await this.snoozeHydration();
        break;
      case 'setHydrationInterval':
        await this.promptForInterval('hydration');
        break;
      case 'snoozeRest':
        await this.snoozeRest();
        break;
      case 'setRestInterval':
        await this.promptForInterval('rest');
        break;
      case 'setWorkdayEndTime':
        await this.promptForWorkdayEndTime();
        break;
      case 'resetSedentary':
        await this.resetSedentaryTimer();
        break;
      case 'stats':
        await this.showStats();
        break;
      default:
        break;
    }
  }

  private async markHydrated(source: 'manual' | 'notification'): Promise<void> {
    this.resetDailyIfNeeded();

    const now = Date.now();
    this.hydrationState = {
      ...this.hydrationState,
      dateKey: getLocalDateKey(new Date(now)),
      todayCount: this.hydrationState.todayCount + 1,
      lastDrinkAt: now,
      snoozeUntil: undefined,
      lastNotifiedAt: undefined,
    };

    await this.saveHydrationState();
    this.updateStatusBar();
    this.updateStatsPanel();
    this.flashStatus(`已记录喝水，今日 ${this.hydrationState.todayCount} 次`);
  }

  private async markBreakTaken(source: 'manual' | 'notification'): Promise<void> {
    const now = Date.now();
    this.restState = {
      lastBreakAt: now,
      snoozeUntil: undefined,
      lastNotifiedAt: undefined,
    };

    await this.saveRestState();
    this.workStatsState.breakCount += 1;
    this.workStatsState.lastBreakAt = now;
    await this.saveWorkStatsState();
    this.sedentarySnoozeUntil = undefined;
    this.sedentaryLastNotifiedAt = undefined;
    this.activityTracker.resetSession(now);
    this.updateStatusBar();
    this.updateStatsPanel();
    this.flashStatus('已记录休息，重新开始计时');
  }

  private async snoozeHydration(): Promise<void> {
    this.hydrationState = {
      ...this.hydrationState,
      snoozeUntil: Date.now() + SNOOZE_MS,
    };
    await this.saveHydrationState();
    this.updateStatusBar();
    this.flashStatus('喝水提醒已稍后10分钟');
  }

  private async snoozeRest(): Promise<void> {
    this.restState = {
      ...this.restState,
      snoozeUntil: Date.now() + SNOOZE_MS,
    };
    await this.saveRestState();
    this.updateStatusBar();
    this.flashStatus('休息提醒已稍后10分钟');
  }

  private async resetSedentaryTimer(): Promise<void> {
    this.sedentarySnoozeUntil = undefined;
    this.sedentaryLastNotifiedAt = undefined;
    this.activityTracker.resetSession();
    this.updateStatusBar();
    this.flashStatus('久坐计时已重置');
  }

  private async promptForInterval(kind: 'hydration' | 'rest'): Promise<void> {
    const currentMinutes = kind === 'hydration'
      ? this.config.hydration.intervalMinutes
      : this.config.rest.intervalMinutes;
    const label = kind === 'hydration' ? '喝水' : '休息';
    const minimum = 1;
    const value = await vscode.window.showInputBox({
      prompt: `设置${label}提醒间隔（分钟）`,
      placeHolder: `请输入大于等于 ${minimum} 的整数`,
      value: String(currentMinutes),
      validateInput: (input) => {
        const minutes = Number(input.trim());
        if (!Number.isInteger(minutes)) {
          return '请输入整数分钟';
        }

        if (minutes < minimum) {
          return `${label}提醒不能小于 ${minimum} 分钟`;
        }

        return undefined;
      },
    });

    if (!value) {
      return;
    }

    const minutes = Number(value.trim());
    const config = vscode.workspace.getConfiguration('mindfulCoder');
    const key = kind === 'hydration' ? 'hydration.intervalMinutes' : 'rest.intervalMinutes';
    await config.update(key, minutes, vscode.ConfigurationTarget.Global);

    if (kind === 'hydration') {
      this.hydrationState = {
        ...this.hydrationState,
        snoozeUntil: undefined,
        lastNotifiedAt: undefined,
      };
      await this.saveHydrationState();
    } else {
      this.restState = {
        ...this.restState,
        snoozeUntil: undefined,
        lastNotifiedAt: undefined,
      };
      await this.saveRestState();
    }

    this.config = readConfig();
    this.flashStatus(`${label}提醒已设置为 ${minutes} 分钟`);
    this.updateStatusBar();
  }

  private async showStats(): Promise<void> {
    await this.openStatsPanel();
  }

  private async promptForWorkdayEndTime(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: '设置下班时间（HH:mm）',
      placeHolder: '例如 18:30',
      value: this.config.workday.endTime,
      validateInput: (input) => {
        if (!isValidTimeString(input.trim())) {
          return '请输入 HH:mm 格式，例如 18:30';
        }

        return undefined;
      },
    });

    if (!value) {
      return;
    }

    await vscode.workspace.getConfiguration('mindfulCoder').update(
      'workday.endTime',
      value.trim(),
      vscode.ConfigurationTarget.Global,
    );
    this.flashStatus(`下班时间已设置为 ${value.trim()}`);
  }

  private getHydrationDueAt(): number {
    const baseDueAt = this.hydrationState.lastDrinkAt + this.config.hydration.intervalMinutes * MINUTE_MS;
    return Math.max(baseDueAt, this.hydrationState.snoozeUntil ?? 0);
  }

  private getRestDueAt(): number {
    const baseDueAt = this.restState.lastBreakAt + this.config.rest.intervalMinutes * MINUTE_MS;
    return Math.max(baseDueAt, this.restState.snoozeUntil ?? 0);
  }

  private getSedentaryThresholdMs(): number {
    return this.config.sedentary.thresholdMinutes * MINUTE_MS;
  }

  private getSedentaryDueAt(snapshot: ActivitySnapshot): number | undefined {
    if (!snapshot.active || snapshot.sessionStartAt === undefined) {
      return undefined;
    }

    const baseDueAt = snapshot.sessionStartAt + this.getSedentaryThresholdMs();
    return Math.max(baseDueAt, this.sedentarySnoozeUntil ?? 0);
  }

  private isHydrationDue(now: number): boolean {
    return this.config.hydration.enabled && now >= this.getHydrationDueAt();
  }

  private isRestDue(now: number): boolean {
    return this.config.rest.enabled && now >= this.getRestDueAt();
  }

  private async saveHydrationState(): Promise<void> {
    await this.context.globalState.update(HYDRATION_STATE_KEY, this.hydrationState);
  }

  private async saveRestState(): Promise<void> {
    await this.context.globalState.update(REST_STATE_KEY, this.restState);
  }

  private async saveWorkStatsState(): Promise<void> {
    await this.context.globalState.update(WORK_STATS_STATE_KEY, this.workStatsState);
  }

  private async persistStates(): Promise<void> {
    await Promise.all([this.saveHydrationState(), this.saveRestState(), this.saveWorkStatsState()]);
  }

  private flashStatus(message: string): void {
    vscode.window.setStatusBarMessage(`Mindful Coder: ${message}`, 4000);
  }

  private captureDocumentStats(event: vscode.TextDocumentChangeEvent): void {
    const now = Date.now();
    this.resetDailyIfNeeded(now);
    const snapshot = this.syncSedentarySession(this.activityTracker.getSnapshot(now));
    this.syncWorkStats(now, snapshot);

    if (!this.workStatsState.workdayStartAt) {
      this.workStatsState.workdayStartAt = snapshot.sessionStartAt ?? now;
    }

    for (const change of event.contentChanges) {
      this.workStatsState.editCount += 1;
      this.workStatsState.charsAdded += change.text.length;
      this.workStatsState.charsRemoved += change.rangeLength;
      this.workStatsState.linesAdded += countLineBreaks(change.text);
      this.workStatsState.linesRemoved += Math.max(0, change.range.end.line - change.range.start.line);
    }

    const documentKey = event.document.isUntitled
      ? event.document.uri.toString()
      : (event.document.uri.fsPath || event.document.uri.toString());
    if (!this.workStatsState.filesTouched.includes(documentKey)) {
      this.workStatsState.filesTouched.push(documentKey);
    }

    this.workStatsState.lastActivityAt = now;
    void this.saveWorkStatsState();
    this.updateStatsPanel(now, snapshot);
  }

  private syncWorkStats(now: number, snapshot: ActivitySnapshot): void {
    if (snapshot.active && snapshot.sessionStartAt !== undefined) {
      if (!this.workStatsState.workdayStartAt) {
        this.workStatsState.workdayStartAt = snapshot.sessionStartAt;
      }

      const anchor = Math.max(snapshot.sessionStartAt, this.workStatsState.lastAccumulatedAt ?? snapshot.sessionStartAt);
      if (now > anchor) {
        this.workStatsState.activeMsAccumulated += now - anchor;
      }

      this.workStatsState.lastAccumulatedAt = now;
      this.workStatsState.lastActivityAt = snapshot.lastActivityAt ?? now;
      return;
    }

    this.workStatsState.lastAccumulatedAt = undefined;
  }

  private async openStatsPanel(options: StatsPanelOptions = {}): Promise<void> {
    const now = Date.now();
    const snapshot = this.syncSedentarySession(this.activityTracker.getSnapshot(now));
    this.syncWorkStats(now, snapshot);
    const viewColumn = options.viewColumn ?? vscode.ViewColumn.Beside;
    const preserveFocus = options.preserveFocus ?? false;

    if (this.statsPanel) {
      this.statsPanel.reveal(viewColumn, preserveFocus);
      this.updateStatsPanel(now, snapshot);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mindfulCoder.dailyStats',
      'Mindful Coder 今日统计',
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.statsPanel = panel;
    panel.webview.html = this.getStatsWebviewHtml(panel.webview);

    panel.onDidDispose(() => {
      if (this.statsPanel === panel) {
        this.statsPanel = undefined;
      }
    }, undefined, this.disposables);

    panel.webview.onDidReceiveMessage((message: { command?: string }) => {
      if (message.command === 'refreshStats') {
        this.updateStatsPanel();
      }
    }, undefined, this.disposables);

    this.updateStatsPanel(now, snapshot);
  }

  private hasWorkdayStats(): boolean {
    return this.workStatsState.workdayStartAt !== undefined || this.workStatsState.editCount > 0;
  }

  private updateStatsPanel(
    now = Date.now(),
    snapshot = this.syncSedentarySession(this.activityTracker.getSnapshot(now)),
  ): void {
    if (!this.statsPanel) {
      return;
    }

    this.statsPanel.webview.postMessage({
      type: 'stats',
      payload: this.buildDashboardModel(now, snapshot),
    });
  }

  private buildDashboardModel(now: number, snapshot: ActivitySnapshot): DashboardModel {
    const focusMs = this.workStatsState.activeMsAccumulated;
    const workdayStartAt = this.workStatsState.workdayStartAt;
    const workSpanMs = workdayStartAt ? Math.max(0, now - workdayStartAt) : 0;
    const focusRatio = workSpanMs > 0 ? `${Math.round((focusMs / workSpanMs) * 100)}%` : '0%';
    const offWorkDetails = getWorkdayEndDetails(now, this.config.workday.endTime, workdayStartAt);
    const netLines = this.workStatsState.linesAdded - this.workStatsState.linesRemoved;

    return {
      titleDate: formatFullDate(now),
      workloadSummary: workdayStartAt
        ? `从 ${formatClock(workdayStartAt)} 开始，已专注 ${formatDurationLong(focusMs)}，编辑 ${this.workStatsState.editCount} 次。`
        : '今天还没有足够的工作数据，开始写代码后这里会自动更新。',
      workdayStart: workdayStartAt ? formatClock(workdayStartAt) : '尚未开始',
      hydrationCount: String(this.hydrationState.todayCount),
      breakCount: String(this.workStatsState.breakCount),
      lastBreak: formatRelativeTimestamp(this.workStatsState.lastBreakAt, now, '今天还没休息'),
      focusTime: formatDurationLong(focusMs),
      focusRatio,
      currentStreak: snapshot.active ? formatDurationLong(snapshot.continuousActiveMs) : '当前未连续工作',
      workSpan: workdayStartAt ? formatDurationLong(workSpanMs) : '尚未开始',
      offWorkLabel: this.config.workday.endTime,
      offWorkDetail: offWorkDetails.detail,
      progressPercent: offWorkDetails.progressPercent,
      isOverdue: offWorkDetails.isOverdue,
      linesSummary: `+${this.workStatsState.linesAdded} / -${this.workStatsState.linesRemoved} 行`,
      charsSummary: `+${this.workStatsState.charsAdded} / -${this.workStatsState.charsRemoved} 字符`,
      netLines: `${netLines >= 0 ? '+' : ''}${netLines} 行`,
      editCount: `${this.workStatsState.editCount} 次编辑`,
      filesTouched: `${this.workStatsState.filesTouched.length} 个文件`,
    };
  }

  private getStatsWebviewHtml(webview: vscode.Webview): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mindful Coder 今日统计</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: linear-gradient(160deg, color-mix(in srgb, var(--vscode-editor-background) 88%, #113b4a 12%), color-mix(in srgb, var(--vscode-editor-background) 92%, #6f4e37 8%));
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 78%, transparent);
      --panel-strong: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, #18343f 10%);
      --border: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      --accent: #61c0bf;
      --accent-warm: #f2a65a;
      --accent-danger: #dd6b55;
      --text: var(--vscode-editor-foreground);
      --muted: color-mix(in srgb, var(--vscode-descriptionForeground) 88%, var(--vscode-editor-foreground) 12%);
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
      --radius: 22px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif;
      color: var(--text);
      background: var(--bg);
    }

    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px;
    }

    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) + 6px);
      background: linear-gradient(135deg, color-mix(in srgb, var(--panel-strong) 84%, #0f2d38 16%), color-mix(in srgb, var(--panel) 90%, #2f221b 10%));
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 10px;
    }

    h1, h2, p {
      margin: 0;
    }

    h1 {
      font-size: clamp(28px, 4vw, 42px);
      font-weight: 700;
      margin-bottom: 10px;
    }

    .hero p {
      max-width: 720px;
      color: var(--muted);
      line-height: 1.6;
    }

    .hero-actions,
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .band {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 18px;
    }

    .pill,
    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .pill {
      padding: 18px 20px;
    }

    .pill span,
    .metric-label,
    .mini-label,
    .footnote {
      color: var(--muted);
    }

    .pill strong {
      display: block;
      margin-top: 8px;
      font-size: 22px;
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 18px;
      margin-top: 18px;
    }

    .card {
      padding: 22px;
    }

    .card-wide {
      grid-column: 1 / -1;
    }

    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 18px;
    }

    .section-head h2 {
      font-size: 20px;
      font-weight: 700;
    }

    .status-dot {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--text);
      font-size: 13px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .metric {
      padding: 16px;
      border-radius: 18px;
      background: color-mix(in srgb, var(--panel-strong) 86%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
    }

    .metric strong {
      display: block;
      margin-top: 10px;
      font-size: clamp(20px, 3vw, 28px);
      font-weight: 700;
    }

    .metric .sub {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      line-height: 1.5;
    }

    .progress-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 14px;
    }

    .track {
      width: 100%;
      height: 14px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--panel-strong) 80%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    }

    .fill {
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-warm));
      transition: width 220ms ease;
    }

    .fill.overdue {
      background: linear-gradient(90deg, var(--accent-danger), #f08b6e);
    }

    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 18px;
    }

    .mini {
      padding: 16px;
      border-radius: 18px;
      background: color-mix(in srgb, var(--panel-strong) 84%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
    }

    .mini strong {
      display: block;
      margin-top: 8px;
      font-size: 24px;
    }

    button {
      appearance: none;
      border: 0;
      border-radius: 14px;
      padding: 11px 16px;
      font: inherit;
      cursor: pointer;
      color: #0f1b22;
      background: linear-gradient(135deg, var(--accent), #9be7d8);
      transition: transform 140ms ease, opacity 140ms ease, box-shadow 140ms ease;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
    }

    button.ghost {
      color: var(--text);
      background: color-mix(in srgb, var(--panel-strong) 86%, transparent);
      border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
      box-shadow: none;
    }

    button:hover {
      transform: translateY(-1px);
      opacity: 0.98;
    }

    button:active {
      transform: translateY(0);
    }

    .actions {
      align-content: start;
    }

    .actions button {
      width: 100%;
      justify-content: center;
    }

    .footnote {
      margin-top: 16px;
      line-height: 1.6;
      font-size: 12px;
    }

    @media (max-width: 860px) {
      .hero,
      .section-head,
      .progress-head {
        flex-direction: column;
        align-items: stretch;
      }

      .band,
      .grid,
      .metrics,
      .split {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div>
        <div class="eyebrow">Today's Pulse</div>
        <h1>今日统计面板</h1>
        <p id="workloadSummary">等待工作数据...</p>
      </div>
      <div class="hero-actions">
        <button class="ghost" data-command="refreshStats">刷新</button>
      </div>
    </section>

    <section class="band">
      <div class="pill">
        <span>今天</span>
        <strong id="titleDate">--</strong>
      </div>
      <div class="pill">
        <span>下班时间</span>
        <strong id="offWorkLabel">18:30</strong>
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <div class="section-head">
          <h2>身体节奏</h2>
          <span class="status-dot">陪伴式提醒，不打断编码</span>
        </div>
        <div class="metrics">
          <div class="metric">
            <span class="metric-label">今日喝水</span>
            <strong id="hydrationCount">0</strong>
            <span class="sub">次</span>
          </div>
          <div class="metric">
            <span class="metric-label">今日休息</span>
            <strong id="breakCount">0</strong>
            <span class="sub">次</span>
          </div>
          <div class="metric">
            <span class="metric-label">最近休息</span>
            <strong id="lastBreak">今天还没休息</strong>
            <span class="sub">记录后自动更新</span>
          </div>
          <div class="metric">
            <span class="metric-label">当前连续工作</span>
            <strong id="currentStreak">当前未连续工作</strong>
            <span class="sub">超过阈值会提醒你活动一下</span>
          </div>
        </div>
      </article>

      <article class="card">
        <div class="section-head">
          <h2>专注与产出</h2>
          <span class="status-dot" id="focusRatio">0%</span>
        </div>
        <div class="metrics">
          <div class="metric">
            <span class="metric-label">今日专注</span>
            <strong id="focusTime">0 分钟</strong>
            <span class="sub">只统计 VS Code 内连续活跃时段</span>
          </div>
          <div class="metric">
            <span class="metric-label">班次跨度</span>
            <strong id="workSpan">尚未开始</strong>
            <span class="sub">从第一次活跃到现在</span>
          </div>
          <div class="metric">
            <span class="metric-label">工作开始</span>
            <strong id="workdayStart">尚未开始</strong>
            <span class="sub">记录你的今日工作起点</span>
          </div>
          <div class="metric">
            <span class="metric-label">净代码行</span>
            <strong id="netLines">+0 行</strong>
            <span class="sub">基于文档变更的近似统计</span>
          </div>
        </div>
      </article>

      <article class="card card-wide">
        <div class="progress-head">
          <h2>下班进度</h2>
          <span class="mini-label" id="offWorkDetail">等待工作数据...</span>
        </div>
        <div class="track">
          <div id="offWorkProgress" class="fill"></div>
        </div>
        <div class="split">
          <div class="mini">
            <span class="mini-label">代码增量</span>
            <strong id="linesSummary">+0 / -0 行</strong>
            <span class="sub" id="charsSummary">+0 / -0 字符</span>
          </div>
          <div class="mini">
            <span class="mini-label">触达范围</span>
            <strong id="editCount">0 次编辑</strong>
            <span class="sub" id="filesTouched">0 个文件</span>
          </div>
        </div>
      </article>

    </section>

    <p class="footnote">代码工作量为基于 VS Code 文档变更的近似统计，会记录新增/删除字符、行数、编辑次数与触达文件数。它不是 Git 提交统计，也不是系统级键鼠监控。</p>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    const progress = byId('offWorkProgress');

    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ command: button.dataset.command });
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'stats') {
        return;
      }

      const data = message.payload;
      byId('titleDate').textContent = data.titleDate;
      byId('workloadSummary').textContent = data.workloadSummary;
      byId('offWorkLabel').textContent = data.offWorkLabel;
      byId('hydrationCount').textContent = data.hydrationCount;
      byId('breakCount').textContent = data.breakCount;
      byId('lastBreak').textContent = data.lastBreak;
      byId('currentStreak').textContent = data.currentStreak;
      byId('focusTime').textContent = data.focusTime;
      byId('focusRatio').textContent = '专注率 ' + data.focusRatio;
      byId('workSpan').textContent = data.workSpan;
      byId('workdayStart').textContent = data.workdayStart;
      byId('netLines').textContent = data.netLines;
      byId('offWorkDetail').textContent = data.offWorkDetail;
      byId('linesSummary').textContent = data.linesSummary;
      byId('charsSummary').textContent = data.charsSummary;
      byId('editCount').textContent = data.editCount;
      byId('filesTouched').textContent = data.filesTouched;
      progress.style.width = data.progressPercent + '%';
      progress.classList.toggle('overdue', Boolean(data.isOverdue));
    });
  </script>
</body>
</html>`;
  }

  private getReminderWebviewHtml(webview: vscode.Webview, model: ReminderPanelModel): string {
    const nonce = createNonce();
    const actionButtons = model.actions.map((action, index) => {
      const className = index === 0 ? 'primary' : 'ghost';
      return `<button class="${className}" data-action="${escapeHtml(action)}">${escapeHtml(action)}</button>`;
    }).join('');
    const icon = model.title.includes('喝水') ? '💧' : model.title.includes('休息') ? '👀' : model.title.includes('久坐') ? '🪑' : '⏰';
    const accent = model.severity === 'warning' ? '#f2a65a' : '#61c0bf';
    const accentDeep = model.severity === 'warning' ? '#8d4a1f' : '#0f4f56';
    const toneLabel = model.severity === 'warning' ? '高优先级提醒' : '轻提醒';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mindful Coder ${escapeHtml(model.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --page: var(--vscode-editor-background);
      --surface: rgba(255, 255, 255, 0.98);
      --surface-soft: rgba(246, 247, 251, 0.98);
      --border: rgba(15, 23, 42, 0.06);
      --accent: ${accent};
      --accent-soft: color-mix(in srgb, ${accent} 12%, white 88%);
      --text: #1c1c1e;
      --muted: #6e6e73;
      --hairline: rgba(60, 60, 67, 0.14);
      --shadow: 0 22px 44px rgba(15, 23, 42, 0.10), 0 6px 18px rgba(15, 23, 42, 0.05);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif;
      color: var(--text);
      background: var(--page);
    }

    .sheet {
      width: min(620px, calc(100vw - 56px));
      min-height: 384px;
      border-radius: 28px;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, var(--surface) 0%, var(--surface-soft) 100%);
      box-shadow: var(--shadow);
      padding: 20px 22px 22px;
      backdrop-filter: blur(20px);
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .sheet::before {
      content: '';
      position: absolute;
      top: 9px;
      left: 50%;
      transform: translateX(-50%);
      width: 38px;
      height: 4px;
      border-radius: 999px;
      background: rgba(60, 60, 67, 0.22);
    }

    .hero {
      display: block;
      position: relative;
      z-index: 1;
      margin-top: 18px;
    }

    h1, p { margin: 0; }

    .title-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .icon-badge {
      width: 54px;
      height: 54px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border-radius: 16px;
      font-size: 26px;
      background: linear-gradient(180deg, var(--accent-soft), color-mix(in srgb, var(--accent) 12%, white 88%));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92), 0 8px 18px color-mix(in srgb, var(--accent) 10%, transparent);
    }

    h1 {
      font-size: clamp(24px, 4.2vw, 32px);
      font-weight: 700;
      letter-spacing: -0.035em;
    }

    .message {
      font-size: 14px;
      line-height: 1.6;
      color: var(--muted);
      margin-bottom: 0;
      max-width: 420px;
    }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: auto;
      padding-top: 28px;
      position: relative;
      z-index: 1;
    }

    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 12px 16px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: transform 140ms ease, opacity 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
    }

    button.primary {
      color: white;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, white 12%), var(--accent));
      box-shadow: 0 10px 22px color-mix(in srgb, var(--accent) 18%, transparent);
    }

    button.ghost {
      color: #1f2937;
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid var(--hairline);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92);
    }

    button:hover {
      transform: translateY(-1px);
    }

    button:focus-visible {
      outline: none;
      border-color: color-mix(in srgb, var(--accent) 28%, white 72%);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, white 88%);
    }

    @media (max-width: 640px) {
      .sheet {
        width: min(100%, calc(100vw - 28px));
        min-height: auto;
        padding: 16px 16px 18px;
      }

      .title-row {
        align-items: flex-start;
      }

      .message {
        max-width: none;
      }

      .actions {
        flex-direction: column;
        padding-top: 22px;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <section class="hero">
      <div class="title-row">
        <div class="icon-badge">${icon}</div>
        <div>
          <h1>${escapeHtml(model.title)}</h1>
        </div>
      </div>
      <p class="message">${escapeHtml(model.message)}</p>
    </section>
    <div class="actions">${actionButtons}</div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ action: button.dataset.action });
      });
    });
  </script>
</body>
</html>`;
  }
}

function readConfig(): AppConfig {
  const config = vscode.workspace.getConfiguration('mindfulCoder');

  return {
    statusBar: {
      enabled: config.get<boolean>('statusBar.enabled', true),
    },
    hydration: {
      enabled: config.get<boolean>('hydration.enabled', true),
      intervalMinutes: Math.max(1, config.get<number>('hydration.intervalMinutes', 40)),
      notification: config.get<boolean>('hydration.notification', true),
      sound: config.get<boolean>('hydration.sound', false),
    },
    rest: {
      enabled: config.get<boolean>('rest.enabled', true),
      intervalMinutes: Math.max(1, config.get<number>('rest.intervalMinutes', 50)),
      notification: config.get<boolean>('rest.notification', true),
      sound: config.get<boolean>('rest.sound', false),
    },
    sedentary: {
      enabled: config.get<boolean>('sedentary.enabled', true),
      thresholdMinutes: Math.max(1, config.get<number>('sedentary.thresholdMinutes', 120)),
      idleResetMinutes: Math.max(1, config.get<number>('sedentary.idleResetMinutes', 5)),
      notification: config.get<boolean>('sedentary.notification', true),
      sound: config.get<boolean>('sedentary.sound', false),
    },
    workday: {
      endTime: config.get<string>('workday.endTime', '18:30'),
    },
  };
}

function normalizeHydrationState(state: HydrationState | undefined, now = Date.now()): HydrationState {
  const dateKey = getLocalDateKey(new Date(now));

  if (!state) {
    return {
      dateKey,
      todayCount: 0,
      lastDrinkAt: now,
    };
  }

  return {
    dateKey,
    todayCount: state.dateKey === dateKey ? state.todayCount : 0,
    lastDrinkAt: typeof state.lastDrinkAt === 'number' ? state.lastDrinkAt : now,
    snoozeUntil: typeof state.snoozeUntil === 'number' ? state.snoozeUntil : undefined,
    lastNotifiedAt: typeof state.lastNotifiedAt === 'number' ? state.lastNotifiedAt : undefined,
  };
}

function normalizeRestState(state: RestState | undefined, now = Date.now()): RestState {
  if (!state) {
    return {
      lastBreakAt: now,
    };
  }

  return {
    lastBreakAt: typeof state.lastBreakAt === 'number' ? state.lastBreakAt : now,
    snoozeUntil: typeof state.snoozeUntil === 'number' ? state.snoozeUntil : undefined,
    lastNotifiedAt: typeof state.lastNotifiedAt === 'number' ? state.lastNotifiedAt : undefined,
  };
}

function normalizeWorkStatsState(state: WorkStatsState | undefined, now = Date.now()): WorkStatsState {
  const dateKey = getLocalDateKey(new Date(now));

  if (!state || state.dateKey !== dateKey) {
    return createEmptyWorkStatsState(dateKey);
  }

  return {
    dateKey,
    workdayStartAt: typeof state.workdayStartAt === 'number' ? state.workdayStartAt : undefined,
    activeMsAccumulated: typeof state.activeMsAccumulated === 'number' ? state.activeMsAccumulated : 0,
    lastAccumulatedAt: typeof state.lastAccumulatedAt === 'number' ? state.lastAccumulatedAt : undefined,
    lastActivityAt: typeof state.lastActivityAt === 'number' ? state.lastActivityAt : undefined,
    lastBreakAt: typeof state.lastBreakAt === 'number' ? state.lastBreakAt : undefined,
    lastOffWorkNotifiedAt: typeof state.lastOffWorkNotifiedAt === 'number' ? state.lastOffWorkNotifiedAt : undefined,
    breakCount: typeof state.breakCount === 'number' ? state.breakCount : 0,
    editCount: typeof state.editCount === 'number' ? state.editCount : 0,
    filesTouched: Array.isArray(state.filesTouched) ? state.filesTouched.filter((entry): entry is string => typeof entry === 'string') : [],
    charsAdded: typeof state.charsAdded === 'number' ? state.charsAdded : 0,
    charsRemoved: typeof state.charsRemoved === 'number' ? state.charsRemoved : 0,
    linesAdded: typeof state.linesAdded === 'number' ? state.linesAdded : 0,
    linesRemoved: typeof state.linesRemoved === 'number' ? state.linesRemoved : 0,
  };
}

function createEmptyWorkStatsState(dateKey: string): WorkStatsState {
  return {
    dateKey,
    activeMsAccumulated: 0,
    breakCount: 0,
    editCount: 0,
    filesTouched: [],
    charsAdded: 0,
    charsRemoved: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCountdown(ms: number): string {
  return formatDurationCompact(Math.max(MINUTE_MS, ms));
}

function formatDurationCompact(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}min`;
  }

  if (minutes <= 0) {
    return `${hours}h`;
  }

  return `${hours}h${minutes}m`;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatFullDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDurationLong(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${Math.max(1, minutes)} 分钟`;
  }

  if (minutes <= 0) {
    return `${hours} 小时`;
  }

  return `${hours} 小时 ${minutes} 分钟`;
}

function formatRelativeTimestamp(timestamp: number | undefined, now: number, fallback: string): string {
  if (timestamp === undefined) {
    return fallback;
  }

  return `${formatClock(timestamp)} · ${formatDurationCompact(Math.max(0, now - timestamp))}前`;
}

function countLineBreaks(text: string): number {
  const matches = text.match(/\n/g);
  return matches ? matches.length : 0;
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function getWorkdayEndDetails(
  now: number,
  endTime: string,
  workdayStartAt?: number,
): { detail: string; progressPercent: number; isOverdue: boolean } {
  if (!isValidTimeString(endTime)) {
    return {
      detail: '请先设置有效的下班时间',
      progressPercent: 0,
      isOverdue: false,
    };
  }

  const [hours, minutes] = endTime.split(':').map((value) => Number(value));
  const targetDate = new Date(now);
  targetDate.setHours(hours, minutes, 0, 0);
  const targetAt = targetDate.getTime();
  const remainingMs = targetAt - now;
  const isOverdue = remainingMs <= 0;

  let progressPercent = 0;
  if (workdayStartAt !== undefined && targetAt > workdayStartAt) {
    const elapsed = Math.min(Math.max(0, now - workdayStartAt), targetAt - workdayStartAt);
    progressPercent = Math.round((elapsed / (targetAt - workdayStartAt)) * 100);
  } else if (isOverdue) {
    progressPercent = 100;
  }

  return {
    detail: isOverdue
      ? `已过下班时间 ${formatDurationLong(Math.abs(remainingMs))}`
      : `距离下班还有 ${formatDurationLong(remainingMs)}`,
    progressPercent,
    isOverdue,
  };
}

function getWorkdayEndTimestamp(now: number, endTime: string): number | undefined {
  if (!isValidTimeString(endTime)) {
    return undefined;
  }

  const [hours, minutes] = endTime.split(':').map((value) => Number(value));
  const targetDate = new Date(now);
  targetDate.setHours(hours, minutes, 0, 0);
  return targetDate.getTime();
}

function createNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function playNotificationSound(): void {
  let command: string;

  switch (process.platform) {
    case 'win32':
      command = 'powershell -NoProfile -Command "[console]::Beep(880,160)"';
      break;
    case 'darwin':
      command = 'afplay /System/Library/Sounds/Glass.aiff';
      break;
    default:
      command = 'printf "\\a"';
      break;
  }

  exec(command, () => {
    // Ignore sound playback failures to keep reminder flow non-blocking.
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new MindfulController(context));
}

export function deactivate(): void {
  // Intentionally empty.
}