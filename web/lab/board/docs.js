try { sessionStorage.setItem("opeq:inside", "1"); } catch {}
const links = [...document.querySelectorAll(".toc a")];
const heads = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
const mark = () => {
  let cur = heads[0];
  for (const h of heads) if (h.getBoundingClientRect().top < 120) cur = h;
  for (const a of links) a.classList.toggle("on", a.getAttribute("href") === "#" + cur.id);
};
addEventListener("scroll", mark, { passive: true });
mark();
