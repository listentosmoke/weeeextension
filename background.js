const MODEL_CANDIDATES = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
];
const DEFAULT_MAX_STEPS = 120;
const MAX_ACTIONS_PER_STEP = 8;
const LOG_LIMIT = 1000;

const runState = {
  running: false,
  stopRequested: false,
  tabId: null,
  startedAt: null,
  step: 0,
  task: "",
  useDebugMode: true,
  debuggerAttached: false,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "START_AUTOMATION") {
    startAutomation(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_AUTOMATION") {
    runState.stopRequested = true;
    void log("warn", "Stop requested by user.");
    sendResponse({ ok: true });
  }
});

async function startAutomation(payload) {
  if (runState.running) {
    throw new Error("Automation is already running.");
  }

  const { apiKey, task, maxSteps, useDebugMode = true } = payload ?? {};
  if (!apiKey?.trim()) {
    throw new Error("Gemini API key is required.");
  }
  if (!task?.trim()) {
    throw new Error("Task is required.");
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new Error("Could not determine active tab.");
  }

  runState.running = true;
  runState.stopRequested = false;
  runState.tabId = tab.id;
  runState.startedAt = Date.now();
  runState.step = 0;
  runState.task = task.trim();
  runState.useDebugMode = Boolean(useDebugMode);

  await chrome.storage.local.set({
    automationStatus: {
      running: true,
      step: 0,
      task: runState.task,
      startedAt: runState.startedAt,
      tabId: runState.tabId,
      debugMode: runState.useDebugMode,
    },
    automationLogs: [],
  });

  await log("info", `Starting task: ${runState.task}`);

  if (runState.useDebugMode) {
    try {
      await ensureDebuggerAttached(runState.tabId);
      await setStatus({ debugMode: true, debugAttached: true });
      await log("success", "Chrome debugger attached (Input domain enabled).");
    } catch (error) {
      runState.useDebugMode = false;
      await setStatus({ debugMode: false, debugAttached: false });
      await log("warn", `Failed to attach debugger, falling back to content-script mode: ${error.message}`);
    }
  } else {
    await setStatus({ debugMode: false, debugAttached: false });
  }

  const boundedSteps = Math.max(1, Math.min(Number(maxSteps) || DEFAULT_MAX_STEPS, 500));
  let done = false;

  try {
    for (let step = 1; step <= boundedSteps; step += 1) {
      if (runState.stopRequested) {
        await log("warn", `Stopped at step ${step} by user request.`);
        break;
      }

      runState.step = step;
      await setStatus({ step });
      await log("info", `Step ${step}: collecting page state.`);

      const pageState = await collectPageState(runState.tabId);
      const modelOutput = await requestNextActions({
        apiKey,
        task: runState.task,
        step,
        pageState,
        maxSteps: boundedSteps,
      });

      if (modelOutput.done) {
        done = true;
        await log("success", `Model marked task done: ${modelOutput.reason || "No reason provided."}`);
        break;
      }

      if (!Array.isArray(modelOutput.actions) || modelOutput.actions.length === 0) {
        await log("warn", "Model returned no actions; stopping.");
        break;
      }

      const actions = modelOutput.actions.slice(0, MAX_ACTIONS_PER_STEP);
      await log("info", `Executing ${actions.length} action(s).`);

      for (const [index, action] of actions.entries()) {
        if (runState.stopRequested) {
          await log("warn", "Stop requested before executing remaining actions.");
          break;
        }

        const result = await executeAction(runState.tabId, action);
        const label = `${step}.${index + 1} ${action.type}`;
        if (result.ok) {
          await log("success", `${label}: ${result.message}`);
        } else {
          await log("error", `${label}: ${result.error}`);
        }

        if (action.type === "wait" && typeof action.ms === "number") {
          await sleep(Math.min(Math.max(action.ms, 0), 30000));
        }
      }
    }

    const elapsedMs = Date.now() - runState.startedAt;
    await setStatus({
      running: false,
      finishedAt: Date.now(),
      elapsedMs,
      done,
      stopRequested: runState.stopRequested,
      error: null,
      debugAttached: runState.debuggerAttached,
    });

    if (!runState.stopRequested) {
      await log("info", `Run complete in ${(elapsedMs / 1000).toFixed(1)}s.`);
    }
  } catch (error) {
    const elapsedMs = Date.now() - runState.startedAt;
    await setStatus({
      running: false,
      finishedAt: Date.now(),
      elapsedMs,
      done: false,
      stopRequested: runState.stopRequested,
      error: error.message,
      debugAttached: runState.debuggerAttached,
    });
    await log("error", `Automation failed: ${error.message}`);
    throw error;
  } finally {
    await detachDebuggerIfNeeded(runState.tabId);
    runState.running = false;
    runState.stopRequested = false;
    runState.debuggerAttached = false;
  }
}

async function collectPageState(tabId) {
  const [screenshot, pageTextResult] = await Promise.all([
    chrome.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 75 }),
    sendToContent(tabId, { type: "GET_PAGE_TEXT" }),
  ]);

  const pageText = pageTextResult?.ok ? pageTextResult.text : "";
  const url = pageTextResult?.ok ? pageTextResult.url : "";
  const title = pageTextResult?.ok ? pageTextResult.title : "";

  return {
    screenshotBase64: screenshot.replace(/^data:image\/[a-zA-Z]+;base64,/, ""),
    pageText: sanitizeText(pageText, 22000),
    url,
    title,
    viewport: pageTextResult?.viewport,
  };
}

async function requestNextActions({ apiKey, task, step, maxSteps, pageState }) {
  const schema = {
    type: "object",
    properties: {
      done: { type: "boolean" },
      reason: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            key: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            dx: { type: "number" },
            dy: { type: "number" },
            ms: { type: "number" },
            amount: { type: "number" },
            direction: { type: "string" }
          },
          required: ["type"]
        }
      }
    },
    required: ["done", "actions"]
  };

  const systemInstruction = `You are a Chrome web automation planner. Return ONLY JSON that matches the response schema. You can issue click-only focused actions and auxiliary actions for scroll/drag/type/wait when needed.\n\nAllowed actions:\n- click: {type:'click', selector?:string, x?:number, y?:number}\n- doubleClick: {type:'doubleClick', selector?:string, x?:number, y?:number}\n- rightClick: {type:'rightClick', selector?:string, x?:number, y?:number}\n- type: {type:'type', selector:string, text:string}\n- keypress: {type:'keypress', key:string}\n- scroll: {type:'scroll', amount:number, direction:'up'|'down'}\n- drag: {type:'drag', x:number, y:number, dx:number, dy:number}\n- wait: {type:'wait', ms:number}\n- done: represented by done:true and empty actions\n\nRules:\n1) Prefer robust CSS selectors using stable attributes, aria-labels, name, id, data-* and visible text fallbacks.\n2) Keep each step short: max 8 actions.\n3) Avoid destructive actions unless task explicitly asks.\n4) If task is complete, set done=true and explain in reason.`;

  const userPrompt = {
    task,
    step,
    maxSteps,
    context: {
      url: pageState.url,
      title: pageState.title,
      viewport: pageState.viewport,
      executionMode: runState.useDebugMode ? "debugger-input" : "content-script-events",
    },
    instructions: "Plan the next actions based on the screenshot and extracted text. Continue incrementally until task completion.",
    pageText: pageState.pageText,
  };

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: JSON.stringify(userPrompt) },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: pageState.screenshotBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  };

  const data = await requestWithModelFallback(apiKey, body);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini response missing text JSON payload.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 300)}`);
  }

  return {
    done: Boolean(parsed.done),
    reason: parsed.reason || "",
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
  };
}

async function requestWithModelFallback(apiKey, body) {
  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      await setStatus({ model });
      return response.json();
    }

    const rawError = await response.text();
    if (response.status === 404 || rawError.includes("is not found for API version")) {
      await log("warn", `Model ${model} unavailable for generateContent; trying next model.`);
      lastError = `Model ${model} not available: ${rawError.slice(0, 240)}`;
      continue;
    }

    throw new Error(`Gemini request failed on ${model} (${response.status}): ${rawError.slice(0, 300)}`);
  }

  throw new Error(
    `Gemini request failed for all fallback models (${MODEL_CANDIDATES.join(", ")}). Last error: ${lastError || "none"}`
  );
}

async function executeAction(tabId, action) {
  if (runState.useDebugMode) {
    const debugResult = await executeActionWithDebugger(tabId, action);
    if (debugResult.ok || !debugResult.fallback) {
      return debugResult;
    }
    await log("warn", `Debugger fallback for ${action.type}: ${debugResult.error}`);
  }

  const result = await sendToContent(tabId, { type: "EXECUTE_ACTION", action });
  if (!result) {
    return { ok: false, error: "No response from content script." };
  }
  return result;
}

async function executeActionWithDebugger(tabId, action) {
  try {
    await ensureDebuggerAttached(tabId);

    switch (action?.type) {
      case "click":
      case "doubleClick":
      case "rightClick":
        return await performDebugPointer(tabId, action);
      case "scroll":
        return await performDebugScroll(tabId, action);
      case "keypress":
        return await performDebugKeypress(tabId, action);
      case "type":
        return await performDebugType(tabId, action);
      case "drag":
        return await performDebugDrag(tabId, action);
      case "wait":
        return { ok: true, message: `Wait ${action.ms || 0}ms` };
      default:
        return { ok: false, fallback: false, error: `Unsupported action type: ${action?.type}` };
    }
  } catch (error) {
    return { ok: false, fallback: true, error: error.message };
  }
}

async function ensureDebuggerAttached(tabId) {
  if (runState.debuggerAttached) {
    return;
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  await chrome.debugger.sendCommand(target, "Page.enable");
  await chrome.debugger.sendCommand(target, "Input.setIgnoreInputEvents", { ignore: false });
  runState.debuggerAttached = true;
}

async function detachDebuggerIfNeeded(tabId) {
  if (!runState.debuggerAttached || !tabId) {
    return;
  }

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignored
  }
}

async function performDebugPointer(tabId, action) {
  const resolved = await sendToContent(tabId, { type: "RESOLVE_ACTION_TARGET", action });
  if (!resolved?.ok) {
    return { ok: false, fallback: true, error: resolved?.error || "Could not resolve action target." };
  }

  const x = resolved.x;
  const y = resolved.y;
  const button = action.type === "rightClick" ? "right" : "left";
  const clickCount = action.type === "doubleClick" ? 2 : 1;

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    clickCount: 0,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: button === "right" ? 2 : 1,
    clickCount,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount,
  });

  return { ok: true, message: `debug ${action.type} at (${Math.round(x)},${Math.round(y)})` };
}

async function performDebugScroll(tabId, action) {
  const amount = Number(action.amount) || 400;
  const direction = action.direction === "up" ? -1 : 1;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 30,
    y: 30,
    deltaX: 0,
    deltaY: direction * amount,
  });
  return { ok: true, message: `debug scrolled ${action.direction || "down"} ${amount}px` };
}

async function performDebugKeypress(tabId, action) {
  if (!action.key) {
    return { ok: false, fallback: false, error: "Keypress action requires key." };
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: action.key,
    text: action.key.length === 1 ? action.key : undefined,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: action.key,
  });
  return { ok: true, message: `debug keypress ${action.key}` };
}

async function performDebugType(tabId, action) {
  if (!action.selector || typeof action.text !== "string") {
    return { ok: false, fallback: false, error: "Type action requires selector and text." };
  }

  const focusResult = await sendToContent(tabId, { type: "FOCUS_SELECTOR", selector: action.selector });
  if (!focusResult?.ok) {
    return { ok: false, fallback: true, error: focusResult?.error || "Could not focus input target." };
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: action.text });
  return { ok: true, message: `debug typed into ${focusResult.target || action.selector}` };
}

async function performDebugDrag(tabId, action) {
  const { x, y, dx, dy } = action;
  if ([x, y, dx, dy].some((n) => typeof n !== "number")) {
    return { ok: false, fallback: false, error: "Drag requires numeric x,y,dx,dy." };
  }

  const endX = x + dx;
  const endY = y + dy;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    const ix = x + ((endX - x) * i) / steps;
    const iy = y + ((endY - y) * i) / steps;
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: ix,
      y: iy,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });

  return { ok: true, message: `debug dragged from (${x},${y}) to (${endX},${endY})` };
}

async function sendToContent(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function sanitizeText(text, maxLen) {
  if (!text) {
    return "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

async function setStatus(patch) {
  const { automationStatus = {} } = await chrome.storage.local.get("automationStatus");
  const hasRunning = Object.prototype.hasOwnProperty.call(patch, "running");
  const hasStep = Object.prototype.hasOwnProperty.call(patch, "step");
  const hasTask = Object.prototype.hasOwnProperty.call(patch, "task");
  const hasTabId = Object.prototype.hasOwnProperty.call(patch, "tabId");

  await chrome.storage.local.set({
    automationStatus: {
      ...automationStatus,
      ...patch,
      running: hasRunning ? patch.running : runState.running,
      step: hasStep ? patch.step : runState.step,
      task: hasTask ? patch.task : runState.task,
      tabId: hasTabId ? patch.tabId : runState.tabId,
    },
  });
}

async function log(level, message) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    step: runState.step,
  };

  const { automationLogs = [] } = await chrome.storage.local.get("automationLogs");
  automationLogs.push(entry);
  const trimmed = automationLogs.slice(-LOG_LIMIT);
  await chrome.storage.local.set({ automationLogs: trimmed });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
