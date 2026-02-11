const apiKeyInput = document.getElementById("apiKey");
const taskInput = document.getElementById("task");
const maxStepsInput = document.getElementById("maxSteps");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusEl = document.getElementById("status");
const logsEl = document.getElementById("logs");

init().catch((error) => {
  statusEl.textContent = `Init error: ${error.message}`;
});

async function init() {
  const data = await chrome.storage.local.get(["apiKey", "automationStatus", "automationLogs"]);
  apiKeyInput.value = data.apiKey || "";
  renderStatus(data.automationStatus || {});
  renderLogs(data.automationLogs || []);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.automationStatus) {
      renderStatus(changes.automationStatus.newValue || {});
    }
    if (changes.automationLogs) {
      renderLogs(changes.automationLogs.newValue || []);
    }
  });

  startButton.addEventListener("click", onStart);
  stopButton.addEventListener("click", onStop);
}

async function onStart() {
  const apiKey = apiKeyInput.value.trim();
  const task = taskInput.value.trim();
  const maxSteps = Number(maxStepsInput.value);

  if (!apiKey || !task) {
    alert("API key and task are required.");
    return;
  }

  await chrome.storage.local.set({ apiKey });

  const response = await chrome.runtime.sendMessage({
    type: "START_AUTOMATION",
    payload: { apiKey, task, maxSteps },
  });

  if (!response?.ok) {
    alert(`Failed to start: ${response?.error || "unknown error"}`);
  }
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: "STOP_AUTOMATION" });
}

function renderStatus(status) {
  if (!status || Object.keys(status).length === 0) {
    statusEl.textContent = "Idle";
    return;
  }

  statusEl.textContent = JSON.stringify(status, null, 2);
}

function renderLogs(logs) {
  logsEl.innerHTML = "";
  if (!logs.length) {
    logsEl.textContent = "No logs yet.";
    return;
  }

  const fragment = document.createDocumentFragment();
  logs.slice(-250).forEach((log) => {
    const row = document.createElement("div");
    row.className = `log-${log.level || "info"}`;
    row.textContent = `[${log.ts}] [${String(log.level || "info").toUpperCase()}] step=${log.step || 0} ${log.message}`;
    fragment.appendChild(row);
  });
  logsEl.appendChild(fragment);
  logsEl.scrollTop = logsEl.scrollHeight;
}
