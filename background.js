const PANEL_URL = chrome.runtime.getURL("popup.html");
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 620;

function buildPanelUrl(targetTabId) {
  return `popup.html?targetTabId=${encodeURIComponent(targetTabId)}`;
}

async function findPanelTab() {
  const tabs = await chrome.tabs.query({ url: PANEL_URL });
  return tabs.length ? tabs[0] : null;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const panelUrl = buildPanelUrl(tab.id);
  const existingTab = await findPanelTab();
  if (existingTab?.windowId) {
    await chrome.tabs.update(existingTab.id, { url: panelUrl });
    await chrome.windows.update(existingTab.windowId, { focused: true });
    await chrome.tabs.update(existingTab.id, { active: true });
    return;
  }

  await chrome.windows.create({
    url: panelUrl,
    type: "popup",
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    focused: true
  });
});
