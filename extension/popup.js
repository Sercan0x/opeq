const $ = (id) => document.getElementById(id);

function panel(open) {
  $("p-panel").classList.toggle("hidden", !open);
  $("p-wallets").setAttribute("aria-expanded", String(open));
}

$("p-wallets").addEventListener("click", () => panel($("p-panel").classList.contains("hidden")));
$("p-expand").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("app.html");
  const open = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (open.length) {
    await chrome.tabs.update(open[0].tabId, { active: true });
    await chrome.windows.update(open[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
  window.close();
});
for (const b of document.querySelectorAll("[data-proxy]")) b.addEventListener("click", () => $(b.dataset.proxy).click());
document.addEventListener("opeq:view", () => panel(false));
