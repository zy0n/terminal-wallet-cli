// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");

type AsyncValue<T> = T | (() => T | Promise<T>);
type LiveSelectChoiceList = any[];

type LiveSelectUpdateOptions = {
  render?: boolean;
  preserveFocus?: boolean;
};

type LiveSelectStateSnapshot = {
  header?: AsyncValue<string>;
  hasHeaderOverride: boolean;
  message?: AsyncValue<string>;
  hasMessageOverride: boolean;
  choices?: AsyncValue<LiveSelectChoiceList | undefined>;
  hasChoicesOverride: boolean;
};

type LiveSelectPromptBase = {
  render: () => Promise<void>;
  run: () => Promise<any>;
  toChoices: (choices: LiveSelectChoiceList) => Promise<any[]> | any[];
  stdout: NodeJS.WriteStream & {
    rows?: number;
  };
  options: Record<string, any>;
  choices: any[];
  focused?: {
    name?: string;
    value?: unknown;
  };
  selected?: {
    name?: string;
    value?: unknown;
  };
  state: {
    submitted?: boolean;
  };
  index?: number;
  [key: string]: any;
};

export type LiveSelectPrompt = LiveSelectPromptBase & {
  refresh: (options?: LiveSelectUpdateOptions) => Promise<void>;
  updateHeader: (
    nextHeader?: AsyncValue<string>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  updateMessage: (
    nextMessage: AsyncValue<string>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  updateChoices: (
    nextChoices?: AsyncValue<LiveSelectChoiceList | undefined>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
};

export type LiveSelectController = {
  refresh: (options?: LiveSelectUpdateOptions) => Promise<void>;
  updateHeader: (
    nextHeader?: AsyncValue<string>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  updateMessage: (
    nextMessage: AsyncValue<string>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  updateChoices: (
    nextChoices?: AsyncValue<LiveSelectChoiceList | undefined>,
    options?: LiveSelectUpdateOptions,
  ) => Promise<void>;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
  isAttached: () => boolean;
};

type LiveSelectControllerInternal = LiveSelectController & {
  bindPrompt: (prompt: LiveSelectPrompt) => Promise<void>;
  unbindPrompt: (prompt: LiveSelectPrompt) => void;
  getSnapshot: () => LiveSelectStateSnapshot;
};

export type LiveSelectOptions = {
  header?: AsyncValue<string>;
  message: AsyncValue<string>;
  choices?: AsyncValue<LiveSelectChoiceList | undefined>;
  controller?: LiveSelectController;
  cancelValue?: string;
  cancelMessage?: string;
  includeCancelChoice?: boolean;
  refreshIntervalMs?: number;
  minVisibleChoices?: number;
  onAutoRefreshError?: (error: unknown) => void | Promise<void>;
  [key: string]: any;
};

export const createLiveSelectController = (): LiveSelectController => {
  let prompt: LiveSelectPrompt | undefined;
  let snapshot: LiveSelectStateSnapshot = {
    header: undefined,
    hasHeaderOverride: false,
    message: undefined,
    hasMessageOverride: false,
    choices: undefined,
    hasChoicesOverride: false,
  };

  const controller: LiveSelectControllerInternal = {
    refresh: async (options = {}) => {
      if (prompt) {
        await prompt.refresh(options);
      }
    },
    updateHeader: async (nextHeader, options = {}) => {
      snapshot = {
        ...snapshot,
        header: nextHeader,
        hasHeaderOverride: true,
      };
      if (prompt) {
        await prompt.updateHeader(nextHeader, options);
      }
    },
    updateMessage: async (nextMessage, options = {}) => {
      snapshot = {
        ...snapshot,
        message: nextMessage,
        hasMessageOverride: true,
      };
      if (prompt) {
        await prompt.updateMessage(nextMessage, options);
      }
    },
    updateChoices: async (nextChoices, options = {}) => {
      snapshot = {
        ...snapshot,
        choices: nextChoices,
        hasChoicesOverride: true,
      };
      if (prompt) {
        await prompt.updateChoices(nextChoices, options);
      }
    },
    startAutoRefresh: () => {
      prompt?.startAutoRefresh();
    },
    stopAutoRefresh: () => {
      prompt?.stopAutoRefresh();
    },
    isAttached: () => {
      return !!prompt;
    },
    bindPrompt: async (nextPrompt: LiveSelectPrompt) => {
      prompt = nextPrompt;

      if (snapshot.hasHeaderOverride) {
        await prompt.updateHeader(snapshot.header, { render: false });
      }
      if (snapshot.hasMessageOverride && typeof snapshot.message !== "undefined") {
        await prompt.updateMessage(snapshot.message, { render: false });
      }
      if (snapshot.hasChoicesOverride) {
        await prompt.updateChoices(snapshot.choices, { render: false });
      }
    },
    unbindPrompt: (currentPrompt: LiveSelectPrompt) => {
      if (prompt === currentPrompt) {
        prompt = undefined;
      }
    },
    getSnapshot: () => snapshot,
  };

  return controller;
};

const resolveValue = async (value?: AsyncValue<string>): Promise<string> => {
  if (typeof value === "function") {
    return await value();
  }
  return value ?? "";
};

const resolveChoicesValue = async (
  value?: AsyncValue<LiveSelectChoiceList | undefined>,
): Promise<LiveSelectChoiceList> => {
  const resolvedValue = typeof value === "function"
    ? await value()
    : value;

  if (typeof resolvedValue === "undefined") {
    return [];
  }

  if (!Array.isArray(resolvedValue)) {
    throw new TypeError("Live select choices must resolve to an array.");
  }

  return resolvedValue;
};

const isSelectableChoice = (choice: any): boolean => {
  return !choice?.disabled && choice?.role !== "separator";
};

const getChoiceKey = (choice: any): string | undefined => {
  if (!choice) {
    return undefined;
  }

  if (typeof choice.name === "string" && choice.name.length > 0) {
    return `name:${choice.name}`;
  }

  if (typeof choice.value === "string" && choice.value.length > 0) {
    return `value:${choice.value}`;
  }

  return undefined;
};

const isPromptCancelError = (error: unknown): boolean => {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("cancel")
    || message.includes("aborted")
    || message.includes("go back")
  );
};

const appendCancelChoice = (
  resolvedChoices: LiveSelectChoiceList,
  cancelValue: string,
  cancelMessage: string,
  includeCancelChoice: boolean,
): LiveSelectChoiceList => {
  if (!includeCancelChoice) {
    return resolvedChoices;
  }

  const hasCancelChoice = resolvedChoices.some((choice: any) => {
    if (typeof choice === "string") {
      return choice === cancelValue;
    }
    return choice?.name === cancelValue;
  });

  if (hasCancelChoice) {
    return resolvedChoices;
  }

  return [
    ...resolvedChoices,
    { name: cancelValue, message: cancelMessage.grey },
  ];
};

export const createLiveSelect = (options: LiveSelectOptions): LiveSelectPrompt => {
  const {
    controller: externalController,
    cancelValue = "exit-menu",
    cancelMessage = "Go Back",
    includeCancelChoice = true,
    refreshIntervalMs = 1200,
    minVisibleChoices = 4,
    header: initialHeader,
    message: initialMessage,
    choices: initialChoices,
    onAutoRefreshError,
    ...rest
  } = options;
  const controller = externalController as LiveSelectControllerInternal | undefined;
  const controllerSnapshot = controller?.getSnapshot();
  const {
    header: controllerHeader,
    hasHeaderOverride,
    message: controllerMessage,
    hasMessageOverride,
    choices: controllerChoices,
    hasChoicesOverride,
  } = controllerSnapshot ?? {};
  let header = initialHeader;
  let message = initialMessage;
  let choices = initialChoices;

  if (hasHeaderOverride) {
    header = controllerHeader;
  }
  if (hasMessageOverride && typeof controllerMessage !== "undefined") {
    message = controllerMessage;
  }
  if (hasChoicesOverride) {
    choices = controllerChoices;
  }

  const prompt = new Select({
    ...rest,
    choices: [],
    header: async () => resolveValue(header),
    message: async () => resolveValue(message),
  }) as LiveSelectPromptBase;

  const originalRender = prompt.render.bind(prompt);
  const originalRun = prompt.run.bind(prompt);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPromise: Promise<void> | undefined;
  let refreshPending = false;
  let renderPending = false;
  let preserveFocusPending = true;
  let hasRendered = false;
  let resolvedHeader = "";
  let resolvedMessage = "";

  const hideCursor = () => {
    if (!process.stdout.isTTY) {
      return;
    }

    prompt.stdout.write("\x1b[?25l");
  };

  const showCursor = () => {
    if (!process.stdout.isTTY) {
      return;
    }

    prompt.stdout.write("\x1b[?25h");
  };

  const lineCount = (value: string) => {
    if (!value.length) {
      return 0;
    }
    return value.split(/\r?\n/).length;
  };

  const updateLayout = () => {
    if (!process.stdout.isTTY) {
      return;
    }

    const terminalRows = prompt.stdout.rows ?? process.stdout.rows ?? 24;
    const reservedLines = lineCount(resolvedHeader) + lineCount(resolvedMessage) + 6;
    const visibleChoices = Math.max(minVisibleChoices, terminalRows - reservedLines);
    prompt.options.limit = visibleChoices;
  };

  const resolveFrame = async () => {
    resolvedHeader = await resolveValue(header);
    resolvedMessage = await resolveValue(message);
    prompt.options.header = resolvedHeader;
    prompt.options.message = resolvedMessage;
    updateLayout();
  };

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const startAutoRefresh = () => {
    if (refreshIntervalMs <= 0 || refreshTimer) {
      return;
    }

    refreshTimer = setInterval(() => {
      if (!prompt.state.submitted) {
        void requestRefresh({
          render: true,
        }).catch(async (error: unknown) => {
          if (onAutoRefreshError) {
            await onAutoRefreshError(error);
          }
        });
      }
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  };

  const getFocusedChoiceSnapshot = () => {
    return {
      key: getChoiceKey(prompt.focused) ?? getChoiceKey(prompt.selected),
      previousIndex: prompt.index ?? 0,
    };
  };

  const syncChoiceIndex = (
    nextChoices: any[],
    preserveFocus: boolean,
    snapshot: ReturnType<typeof getFocusedChoiceSnapshot>,
  ) => {
    const firstSelectableIndex = nextChoices.findIndex(isSelectableChoice);
    const boundedIndex = Math.min(snapshot.previousIndex, Math.max(nextChoices.length - 1, 0));
    const focusedIndex = preserveFocus && snapshot.key
      ? nextChoices.findIndex((choice: any) => getChoiceKey(choice) === snapshot.key)
      : -1;

    if (focusedIndex >= 0) {
      prompt.index = focusedIndex;
      return;
    }

    if (firstSelectableIndex >= 0) {
      prompt.index = firstSelectableIndex;
      return;
    }

    prompt.index = boundedIndex;
  };

  const refreshChoices = async (preserveFocus = true) => {
    if (!choices) {
      const nextChoices = await Promise.all(await prompt.toChoices(
        appendCancelChoice([], cancelValue, cancelMessage, includeCancelChoice),
      ));
      nextChoices.forEach((choice: any) => {
        choice.enabled = false;
      });
      prompt.options.choices = nextChoices.map((choice: any) => choice.original || choice);
      prompt.choices = nextChoices;
      prompt.index = 0;
      return;
    }

    const focusedSnapshot = getFocusedChoiceSnapshot();
    const resolvedChoices = appendCancelChoice(
      await resolveChoicesValue(choices),
      cancelValue,
      cancelMessage,
      includeCancelChoice,
    );
    const nextChoices = await Promise.all(await prompt.toChoices(resolvedChoices));
    nextChoices.forEach((choice: any) => {
      choice.enabled = false;
    });

    prompt.options.choices = resolvedChoices;
    prompt.choices = nextChoices;

    syncChoiceIndex(nextChoices, preserveFocus, focusedSnapshot);
  };

  const requestRefresh = async (
    options: LiveSelectUpdateOptions = {},
  ): Promise<void> => {
    refreshPending = true;
    renderPending = renderPending || (options.render ?? false);
    preserveFocusPending = preserveFocusPending && (options.preserveFocus ?? true);

    while (refreshPending) {
      if (refreshPromise) {
        await refreshPromise;
        continue;
      }

      refreshPending = false;
      const shouldRender = renderPending;
      const shouldPreserveFocus = preserveFocusPending;
      renderPending = false;
      preserveFocusPending = true;

      refreshPromise = (async () => {
        await resolveFrame();
        await refreshChoices(shouldPreserveFocus);
        if (shouldRender && hasRendered && !prompt.state.submitted) {
          await originalRender();
        }
      })().finally(() => {
        refreshPromise = undefined;
      });

      await refreshPromise;
    }
  };

  prompt.render = async function render() {
    hasRendered = true;
    await originalRender();
  };

  const livePrompt = prompt as LiveSelectPrompt;

  livePrompt.refresh = async (updateOptions = {}) => {
    await requestRefresh({
      render: updateOptions.render ?? hasRendered,
      preserveFocus: updateOptions.preserveFocus,
    });
  };

  livePrompt.updateHeader = async (nextHeader, updateOptions = {}) => {
    header = nextHeader;
    await requestRefresh({
      render: updateOptions.render ?? hasRendered,
      preserveFocus: updateOptions.preserveFocus,
    });
  };

  livePrompt.updateMessage = async (nextMessage, updateOptions = {}) => {
    message = nextMessage;
    await requestRefresh({
      render: updateOptions.render ?? hasRendered,
      preserveFocus: updateOptions.preserveFocus,
    });
  };

  livePrompt.updateChoices = async (nextChoices, updateOptions = {}) => {
    choices = nextChoices;
    await requestRefresh({
      render: updateOptions.render ?? hasRendered,
      preserveFocus: updateOptions.preserveFocus,
    });
  };

  livePrompt.startAutoRefresh = startAutoRefresh;
  livePrompt.stopAutoRefresh = clearRefreshTimer;

  prompt.run = async function run() {
    if (controller) {
      await controller.bindPrompt(livePrompt);
    }

    await requestRefresh();
    hideCursor();

    startAutoRefresh();

    try {
      return await originalRun();
    } catch (error) {
      if (isPromptCancelError(error)) {
        return cancelValue;
      }
      throw error;
    } finally {
      clearRefreshTimer();
      controller?.unbindPrompt(livePrompt);
      showCursor();
    }
  };

  return livePrompt;
};
