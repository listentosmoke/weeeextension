chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === "GET_PAGE_TEXT") {
    sendResponse({
      ok: true,
      text: extractPageText(),
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    });
    return;
  }

  if (message.type === "RESOLVE_ACTION_TARGET") {
    sendResponse(resolveActionTarget(message.action));
    return;
  }

  if (message.type === "FOCUS_SELECTOR") {
    sendResponse(focusSelector(message.selector));
    return;
  }

  if (message.type === "EXECUTE_ACTION") {
    executeAction(message.action)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

function extractPageText() {
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const chunks = [];
  while (walker.nextNode()) {
    const value = walker.currentNode.nodeValue?.trim();
    if (!value) {
      continue;
    }

    const parent = walker.currentNode.parentElement;
    if (!parent || !isVisible(parent)) {
      continue;
    }

    chunks.push(value);
    if (chunks.length > 3000) {
      break;
    }
  }

  return chunks.join("\n");
}

function isVisible(element) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function resolveActionTarget(action) {
  const target = findTarget(action);
  if (!target) {
    return { ok: false, error: `Target not found. selector=${action?.selector || ""}` };
  }

  target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  const rect = target.getBoundingClientRect();
  const x = typeof action?.x === "number" ? action.x : rect.left + rect.width / 2;
  const y = typeof action?.y === "number" ? action.y : rect.top + rect.height / 2;

  return {
    ok: true,
    x,
    y,
    target: describeElement(target),
  };
}

function focusSelector(selector) {
  if (!selector) {
    return { ok: false, error: "Selector is required." };
  }

  const target = document.querySelector(selector);
  if (!target) {
    return { ok: false, error: `Type target not found: ${selector}` };
  }

  target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  target.focus();

  if (typeof target.select === "function") {
    try {
      target.select();
    } catch {
      // ignore selection errors
    }
  }

  return { ok: true, target: describeElement(target) };
}

async function executeAction(action) {
  if (!action?.type) {
    return { ok: false, error: "Action type missing." };
  }

  switch (action.type) {
    case "click":
      return performPointerAction(action, "click");
    case "doubleClick":
      return performPointerAction(action, "dblclick");
    case "rightClick":
      return performPointerAction(action, "contextmenu");
    case "type":
      return performType(action);
    case "keypress":
      return performKeypress(action);
    case "scroll":
      return performScroll(action);
    case "drag":
      return performDrag(action);
    case "wait":
      return { ok: true, message: `Wait ${action.ms || 0}ms` };
    default:
      return { ok: false, error: `Unsupported action type: ${action.type}` };
  }
}

function findTarget(action) {
  if (action?.selector) {
    const el = document.querySelector(action.selector);
    if (el) {
      return el;
    }
  }

  if (typeof action?.x === "number" && typeof action?.y === "number") {
    return document.elementFromPoint(action.x, action.y);
  }

  return null;
}

function performPointerAction(action, eventType) {
  const resolved = resolveActionTarget(action);
  if (!resolved.ok) {
    return resolved;
  }

  const target = findTarget(action) || document.elementFromPoint(resolved.x, resolved.y);
  if (!target) {
    return { ok: false, error: "Target disappeared before pointer action." };
  }

  ["pointerdown", "mousedown", "mouseup", eventType].forEach((type) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: resolved.x,
      clientY: resolved.y,
      button: eventType === "contextmenu" ? 2 : 0,
      buttons: eventType === "contextmenu" ? 2 : 1,
    });
    target.dispatchEvent(event);
  });

  return {
    ok: true,
    message: `${eventType} on ${describeElement(target)}`,
  };
}

function performType(action) {
  if (!action.selector || typeof action.text !== "string") {
    return { ok: false, error: "Type action requires selector and text." };
  }

  const focusResult = focusSelector(action.selector);
  if (!focusResult.ok) {
    return focusResult;
  }

  const target = document.querySelector(action.selector);
  const prototype = Object.getPrototypeOf(target);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(target, action.text);
  } else {
    target.value = action.text;
  }

  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    ok: true,
    message: `Typed into ${describeElement(target)}`,
  };
}

function performKeypress(action) {
  if (!action.key) {
    return { ok: false, error: "Keypress action requires key." };
  }

  const active = document.activeElement || document.body;
  ["keydown", "keyup"].forEach((type) => {
    active.dispatchEvent(new KeyboardEvent(type, { key: action.key, bubbles: true }));
  });

  return { ok: true, message: `Pressed key ${action.key}` };
}

function performScroll(action) {
  const amount = Number(action.amount) || 400;
  const direction = action.direction === "up" ? -1 : 1;
  window.scrollBy({ top: direction * amount, left: 0, behavior: "auto" });
  return { ok: true, message: `Scrolled ${action.direction || "down"} ${amount}px` };
}

async function performDrag(action) {
  const { x, y, dx, dy } = action;
  if ([x, y, dx, dy].some((n) => typeof n !== "number")) {
    return { ok: false, error: "Drag requires numeric x,y,dx,dy." };
  }

  const startTarget = document.elementFromPoint(x, y);
  if (!startTarget) {
    return { ok: false, error: `No draggable target at ${x},${y}` };
  }

  const endX = x + dx;
  const endY = y + dy;

  startTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const ix = x + (dx * i) / steps;
    const iy = y + (dy * i) / steps;
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: ix, clientY: iy }));
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: endX, clientY: endY }));

  return { ok: true, message: `Dragged from (${x},${y}) to (${endX},${endY})` };
}

function describeElement(el) {
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string"
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
    : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
