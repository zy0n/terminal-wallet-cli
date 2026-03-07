// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");

type HeaderValue = string | (() => string | Promise<string>);
type ChoiceValue = any[] | (() => any[] | Promise<any[]>);

type LiveSelectOptions = {
  header?: HeaderValue;
  message: HeaderValue;
  choices?: ChoiceValue;
  refreshIntervalMs?: number;
  [key: string]: any;
};

const resolveValue = async (value?: HeaderValue): Promise<string> => {
  if (typeof value === "function") {
    return await value();
  }
  return value ?? "";
};

export const createLiveSelect = (options: LiveSelectOptions) => {
  const { refreshIntervalMs = 1200, header, message, choices, ...rest } = options;
  const prompt = new Select({
    ...rest,
    choices: [],
    header: async () => resolveValue(header),
    message: async () => resolveValue(message),
  });

  const originalRender = prompt.render.bind(prompt);
  const originalRun = prompt.run.bind(prompt);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPromise: Promise<void> | undefined;

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const refreshChoices = async () => {
    if (!choices) {
      return;
    }

    const focusedName = prompt.focused?.name;
    const resolvedChoices = typeof choices === "function"
      ? await choices()
      : choices;
    const nextChoices = await Promise.all(await prompt.toChoices(resolvedChoices));
    nextChoices.forEach((choice: any) => {
      choice.enabled = false;
    });

    prompt.options.choices = resolvedChoices;
    prompt.choices = nextChoices;

    const focusedIndex = typeof focusedName === "string"
      ? nextChoices.findIndex((choice: any) => choice.name === focusedName)
      : -1;
    const selectableIndex = nextChoices.findIndex((choice: any) => !choice.disabled);
    const boundedIndex = Math.min(prompt.index ?? 0, Math.max(nextChoices.length - 1, 0));

    if (focusedIndex >= 0) {
      prompt.index = focusedIndex;
    } else if (selectableIndex >= 0) {
      prompt.index = selectableIndex;
    } else {
      prompt.index = boundedIndex;
    }
  };

  const refreshPromptState = async (renderAfterRefresh = false) => {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        await refreshChoices();
        if (renderAfterRefresh && !prompt.state.submitted) {
          await originalRender();
        }
      })().finally(() => {
        refreshPromise = undefined;
      });
    }
    await refreshPromise;
  };

  prompt.run = async function run() {
    await refreshPromptState();

    if (refreshIntervalMs > 0) {
      refreshTimer = setInterval(() => {
        if (!prompt.state.submitted) {
          void refreshPromptState(true).catch(() => undefined);
        }
      }, refreshIntervalMs);
      refreshTimer.unref?.();
    }

    try {
      return await originalRun();
    } finally {
      clearRefreshTimer();
    }
  };

  return prompt;
};
