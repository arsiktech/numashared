/* Numa Shared home: the page is the shared table.
 * Pure function of scroll position, so it runs forwards and backwards and
 * survives anchor jumps. Without this file the page is a plain readable page. */
(function () {
  "use strict";
  var root = document.documentElement;
  // A phone shorter than this can't fit the table above the text: it gets the plain page.
  if (window.innerWidth <= 900 && window.innerHeight < 760) return;
  root.classList.add("live");

  var clamp = function (x, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a === undefined ? 0 : a, x)); };
  var seg = function (x, a, b) { return clamp((x - a) / (b - a)); };
  var sm = function (t) { return t * t * (3 - 2 * t); };
  var tri = function (x, a, m, b) { return x <= m ? sm(seg(x, a, m)) : 1 - sm(seg(x, m, b)); };
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  // The ledger. Integer cents. Names and amounts are made up.
  // Each expense is split equally between the two budget groups.
  var EXPENSES = [
    { id: "dinner", paidBy: "them", cents: 9600 },
    { id: "internet", paidBy: "them", cents: 7200 }
  ];
  var REPAYMENT = { from: "us", cents: 0 };
  function shareOfUs(e) { return Math.floor(e.cents / 2); }
  EXPENSES.forEach(function (e) { REPAYMENT.cents += shareOfUs(e); });
  // Positive means You + Sam owe Alex + Jo.
  function owedByUs(fractions, repaidFraction) {
    var owed = 0;
    EXPENSES.forEach(function (e, i) {
      owed += (e.paidBy === "them" ? 1 : -1) * shareOfUs(e) * fractions[i];
    });
    return owed - REPAYMENT.cents * repaidFraction;
  }

  var mqRM = window.matchMedia("(prefers-reduced-motion: reduce)");
  var mqNarrow = window.matchMedia("(max-width: 900px)");
  function syncRM() { root.classList.toggle("rm", mqRM.matches); }
  syncRM();
  if (mqRM.addEventListener) mqRM.addEventListener("change", syncRM);

  var stage, acts = {}, amt, dir, verify, slips = {};
  var last = "";
  var queued = false;

  function init() {
    stage = document.querySelector("[data-stage]");
    if (!stage) return;
    amt = stage.querySelector("[data-amt]");
    dir = stage.querySelector(".dir");
    verify = stage;
    ["hello", "add", "why", "repay", "history", "request"].forEach(function (id) {
      acts[id] = document.getElementById(id);
    });
    Array.prototype.forEach.call(stage.querySelectorAll("[data-slip]"), function (el) { slips[el.getAttribute("data-slip")] = el; });
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    document.addEventListener("focusin", onFocus);
    root.classList.add("sc-ready");
    frame();
  }

  function request() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; frame(); });
  }

  function metrics(el, vh) {
    var r = el.getBoundingClientRect();
    return { top: r.top, h: r.height, bottom: r.bottom, a: clamp((vh * 0.6 - r.top) / (r.height - vh * 0.2)) };
  }

  function copyTop(vh) {
    // Sticky top of the copy block, mirrored from the CSS.
    return mqNarrow.matches ? vh * 0.61 : vh * 0.22;
  }

  function frame() {
    var vh = window.innerHeight;
    var m = {};
    var order = ["hello", "add", "why", "repay", "history", "request"];
    order.forEach(function (id) { m[id] = metrics(acts[id], vh); });
    var T = copyTop(vh);

    // Copy blocks: fade in as they arrive at their sticky spot, out as the act ends.
    order.forEach(function (id, i) {
      var a = m[id];
      var inn = id === "hello" ? 1 : seg(a.top, T + vh * 0.2, T);
      var out = id === "request" ? 1 : seg(a.bottom, T + vh * 0.2, T + vh * 0.4);
      acts[id].style.setProperty("--o", r2(inn * out));
      acts[id].style.setProperty("--a", r2(a.a));
    });

    var Ah = m.hello.a, Aadd = m.add.a, Awhy = m.why.a, Arep = m.repay.a, Ahist = m.history.a, Areq = m.request.a;

    // Orb: leans toward the visitor, then is pressed twice.
    var lean = sm(seg(Ah, 0.45, 1)) * (1 - sm(seg(Aadd, 0.6, 0.72)));
    var press = Math.max(tri(Aadd, 0.26, 0.29, 0.33), tri(Aadd, 0.5, 0.53, 0.57));

    // Slips fly onto the table.
    var f1 = sm(seg(Aadd, 0.29, 0.43));
    var f2 = sm(seg(Aadd, 0.53, 0.67));
    var f3 = sm(seg(Arep, 0.12, 0.28));
    var share = sm(seg(Awhy, 0.1, 0.35));

    // Repayment, then all square.
    var rep = sm(seg(Arep, 0.3, 0.58));
    var square = sm(seg(Arep, 0.56, 0.7));
    var ledger = sm(seg(Ahist, 0.15, 0.55));
    var together = sm(seg(Ahist, 0.35, 1));

    // Real captures of the app.
    var phone, shot = sm(seg(Aadd, 0.7, 0.8));
    if (mqNarrow.matches) {
      phone = clamp(sm(seg(Aadd, 0.04, 0.18)) * (1 - sm(seg(Aadd, 0.2, 0.27))) + sm(seg(Aadd, 0.72, 0.84)) * (1 - sm(seg(Awhy, 0.4, 0.7))));
    } else {
      phone = sm(seg(Aadd, 0.04, 0.2)) * (1 - sm(seg(Awhy, 0.55, 0.85)));
    }

    var owed = owedByUs([f1, f2], rep);
    var shown = Math.round(Math.max(0, owed) / 100);
    var text = String(shown);
    if (amt.textContent !== text) amt.textContent = text;
    var dtext = f1 > 0.01 ? "You + Sam owe Alex + Jo" : "Nothing owed";
    if (dir.textContent !== dtext) dir.textContent = dtext;

    var s = stage.style;
    s.setProperty("--lean", r2(lean));
    s.setProperty("--press", r2(press));
    if (slips.dinner) slips.dinner.style.setProperty("--f", r2(f1));
    if (slips.internet) slips.internet.style.setProperty("--f", r2(f2));
    if (slips.repay) slips.repay.style.setProperty("--f", r2(f3));
    s.setProperty("--share", r2(share));
    s.setProperty("--square", r2(square));
    s.setProperty("--ledger", r2(ledger));
    s.setProperty("--together", r2(together));
    s.setProperty("--phone", r2(phone));
    s.setProperty("--shot", r2(shot));
    root.classList.toggle("settled", square > 0.85);

    var copyState = order.map(function (id) { return acts[id].style.getPropertyValue("--o"); }).join(",");
    var rowState = [Awhy, Arep].map(function (x) { return Math.round(x * 12); }).join(",");
    var state = [copyState, rowState, text, r2(lean), r2(press), r2(f1), r2(f2), r2(f3), r2(share), r2(square), r2(ledger), r2(together), r2(phone), r2(shot)].join("|");
    if (state !== last) { last = state; verify.setAttribute("data-sc-verify-state", state); }
    // Resolved holds: the number rests at 84 while the copy catches up, and the clear table at the close.
    var hold = (Aadd > 0.74 && Aadd < 1 && phone > 0.9) || Areq > 0.5;
    if (hold) verify.setAttribute("data-sc-verify-hold", "true"); else verify.removeAttribute("data-sc-verify-hold");
  }

  // A focused control inside faded copy: park the page where that copy is open.
  function onFocus(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var copy = t.closest(".copy");
    if (!copy) return;
    var act = copy.closest(".act");
    if (!act) return;
    var o = parseFloat(act.style.getPropertyValue("--o"));
    if (isNaN(o) || o >= 0.85) return;
    var vh = window.innerHeight;
    var y = act.getBoundingClientRect().top + window.scrollY - copyTop(vh);
    window.scrollTo({ top: Math.max(0, y + 2), behavior: "instant" });
    request();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
