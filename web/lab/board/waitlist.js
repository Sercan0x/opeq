import { initWaitlist } from "../../lib/waitlist.js";
try { sessionStorage.setItem("opeq:inside", "1"); } catch {}

const enter = initWaitlist();
enter();
