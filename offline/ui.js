(function () {
  const d = document.getElementById("details");
  const btn = document.getElementById("btn");
  const p = new URLSearchParams(window.location.search);
  const code = p.get("code");
  const desc = p.get("desc");
  const vurl = p.get("url");
  const target = p.get("target") || "https://pm.webleaders.nl/";

  d.textContent = [
    code != null && code !== "" && "Foutcode: " + code,
    desc != null && desc !== "" && "Omschrijving: " + desc,
    vurl != null && vurl !== "" && "URL: " + vurl,
  ]
    .filter(Boolean)
    .join("\n") || "(Geen technische details.)";

  function isAllowedHttps(t) {
    try {
      return new URL(t).protocol === "https:";
    } catch {
      return false;
    }
  }

  btn.addEventListener("click", () => {
    if (!isAllowedHttps(target)) {
      return;
    }
    btn.disabled = true;
    window.location.href = target;
  });
})();
