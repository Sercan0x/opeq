const KEY = "opeq:session";
const SEEN = "opeq:seen";
const IDLE = 10 * 60 * 1000;

async function sweep() {
  const s = chrome.storage.session;
  const v = await s.get([KEY, SEEN]);
  if (!v[KEY]) { await chrome.alarms.clear("opeq-idle"); return; }
  if (!(Date.now() - v[SEEN] <= IDLE)) { await s.remove([KEY, SEEN]); await chrome.alarms.clear("opeq-idle"); }
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "opeq-idle") sweep(); });
chrome.runtime.onStartup.addListener(sweep);
chrome.runtime.onInstalled.addListener(() => chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(sweep));
