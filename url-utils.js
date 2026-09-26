// Shared URL canonicalization for matching the active tab with saved items.
(function () {
  function normalize(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.host.toLowerCase().replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      const keep = [...parsed.searchParams.entries()]
        .filter(([key]) => !/^(utm_|fbclid|gclid|mc_|ref|spm|igshid)/i.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
      const search = keep.length
        ? "?" + keep.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")
        : "";
      return `${parsed.protocol}//${host}${path}${search}`;
    } catch {
      return String(url || "").trim().toLowerCase();
    }
  }

  globalThis.LaterOnUrl = { normalize };
})();
