import { IdbStore } from "../lib/vaultstore.js";
const s = new IdbStore();
const out = document.getElementById("out");
const mode = location.search.includes("write") ? "write" : "read";
try {
  if (mode === "write") await s.put({ id: "TEST123", program: "x", created: Date.now(), blob: "y" });
  const all = await s.all();
  out.textContent = `${mode}: ${all.length} records ${JSON.stringify(all.map((r) => r.id))}`;
} catch (e) { out.textContent = "ERROR " + e; }
