const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (reduceMotion) document.documentElement.classList.add("reduced");

const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

// Scroll reveals
const reveals = document.querySelectorAll("[data-reveal]");
if (reduceMotion) {
  reveals.forEach((el) => el.classList.add("is-visible"));
} else if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("is-visible"));
}

// Rotatable sphere (pointer drag)
const sphere = document.getElementById("sphere");
const hint = document.getElementById("sphere-hint");
if (sphere && !reduceMotion) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rotY = 0;
  let rotX = 8;
  let velY = 0;
  let velX = 0;
  let raf = 0;

  const apply = () => {
    sphere.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg)`;
  };
  apply();

  const tick = () => {
    if (!dragging) {
      rotY += velY;
      rotX += velX;
      rotX = Math.max(-18, Math.min(18, rotX));
      velY *= 0.94;
      velX *= 0.9;
      apply();
      if (Math.abs(velY) > 0.02 || Math.abs(velX) > 0.01) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    }
  };

  const onDown = (x, y) => {
    dragging = true;
    lastX = x;
    lastY = y;
    velY = 0;
    velX = 0;
    if (raf) cancelAnimationFrame(raf);
    if (hint) hint.style.opacity = "0.35";
  };
  const onMove = (x, y) => {
    if (!dragging) return;
    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x;
    lastY = y;
    rotY += dx * 0.35;
    rotX = Math.max(-18, Math.min(18, rotX - dy * 0.2));
    velY = dx * 0.12;
    velX = -dy * 0.05;
    apply();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (hint) hint.style.opacity = "";
    raf = requestAnimationFrame(tick);
  };

  sphere.addEventListener("pointerdown", (e) => {
    sphere.setPointerCapture(e.pointerId);
    onDown(e.clientX, e.clientY);
  });
  sphere.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY));
  sphere.addEventListener("pointerup", onUp);
  sphere.addEventListener("pointercancel", onUp);

  // Gentle idle turn
  let idle = 0;
  const idleSpin = () => {
    if (!dragging && Math.abs(velY) < 0.02) {
      rotY += 0.08;
      apply();
    }
    idle = requestAnimationFrame(idleSpin);
  };
  idle = requestAnimationFrame(idleSpin);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(idle);
      idle = 0;
    } else if (!idle) {
      idle = requestAnimationFrame(idleSpin);
    }
  });
}

// Header shrink on scroll
const header = document.querySelector(".site-header");
if (header) {
  const onScroll = () => {
    header.style.boxShadow =
      window.scrollY > 12 ? "0 10px 40px rgba(0,0,0,0.35)" : "none";
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}
